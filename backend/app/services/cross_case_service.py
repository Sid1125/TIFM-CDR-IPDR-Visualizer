"""Cross-case subject/suspect linking.

Suspects reoffend. Every other query in ARGUS is single-case scoped, so a subject's history in
*other* cases is invisible. These helpers look an identity up across all OTHER cases:

  * subject_cross_case(db, case_id, subject)   -> per-subject detail (profile-modal panel)
  * case_cross_case_overview(db, case_id)      -> this case's subjects seen elsewhere (dashboard)

Match rule (decided with the user): a phone subject is linked by its NUMBER and by shared
device identifiers IMEI (handset) / IMSI (SIM) — so SIM-swaps and burner handsets are caught.
IP subjects are linked by source/destination IP but flagged LOW confidence, because ISPs reassign
IPs over time (the same address in two cases may be two people).

This is an identity/intelligence lookup, NOT analytic attribution — the strict CDR/IPDR analytic
separation elsewhere is untouched. A phone subject may legitimately match IPDR rows in another
case via its IMEI/IMSI/MSISDN (same handset did data sessions there); those surface as typed
device hits, never merged into the phone's analytics.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Iterable

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.models.case import Case
from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord

# Priority used to pick a single "headline" match type per case for the UI chip.
_TYPE_PRIORITY = {"number": 0, "imei": 1, "imsi": 2, "ip": 3}


def _chunks(seq: Iterable, n: int = 900):
    """Yield IN-clause-sized chunks (keeps us under SQLite's 999 bound-variable limit; Postgres
    is unbothered either way)."""
    seq = list(seq)
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def _value_case_pairs(db: Session, value_col, model, values, exclude_case: str):
    """Map each present identifier value -> set of OTHER case_ids it appears in (for `value_col`
    on `model`). Only rows whose value is in `values` are scanned, so this rides the per-column
    index. Returns {value: {case_id, ...}}."""
    out: dict = defaultdict(set)
    values = [v for v in values if v]
    if not values:
        return out
    for chunk in _chunks(values):
        rows = (
            db.query(value_col, model.case_id)
            .filter(model.case_id.isnot(None), model.case_id != exclude_case, value_col.in_(chunk))
            .distinct()
            .all()
        )
        for val, cid in rows:
            if val is not None and cid is not None:
                out[val].add(cid)
    return out


def _merge_pairs(*dicts):
    m: dict = defaultdict(set)
    for d in dicts:
        for k, v in d.items():
            m[k] |= v
    return m


def _case_names(db: Session, case_ids) -> dict:
    ids = []
    for c in case_ids:
        try:
            ids.append(int(c))
        except (TypeError, ValueError):
            continue
    if not ids:
        return {}
    rows = db.query(Case.id, Case.name).filter(Case.id.in_(ids)).all()
    return {str(i): n for i, n in rows}


def _iso(dt):
    return dt.isoformat() if dt is not None else None


# ---------------------------------------------------------------------------
# Per-subject detail
# ---------------------------------------------------------------------------
def subject_cross_case(db: Session, case_id: str, subject: str) -> dict:
    """Find every OTHER case the given subject (or its handset/SIM) appears in."""
    subject = (subject or "").strip()
    if not case_id or not subject:
        return {"subject": subject, "kind": None, "matches": []}

    is_phone = (
        db.query(CDRRecord.id)
        .filter(
            CDRRecord.case_id == case_id,
            or_(
                CDRRecord.a_party_number == subject,
                CDRRecord.b_party_number == subject,
                CDRRecord.msisdn == subject,
            ),
        )
        .first()
        is not None
    )
    if is_phone:
        return _phone_cross_case(db, case_id, subject)

    is_ip = (
        db.query(IPDRRecord.id)
        .filter(
            IPDRRecord.case_id == case_id,
            or_(IPDRRecord.source_ip == subject, IPDRRecord.destination_ip == subject),
        )
        .first()
        is not None
    )
    if is_ip:
        return _ip_cross_case(db, case_id, subject)

    return {"subject": subject, "kind": None, "matches": []}


def _phone_cross_case(db: Session, case_id: str, subject: str) -> dict:
    # Gather the subject's identifiers WITHIN the current case (number + handsets + SIMs).
    numbers = {subject}
    imeis: set = set()
    imsis: set = set()
    for msisdn, imei, imsi in (
        db.query(CDRRecord.msisdn, CDRRecord.imei, CDRRecord.imsi)
        .filter(CDRRecord.case_id == case_id, or_(CDRRecord.a_party_number == subject, CDRRecord.msisdn == subject))
        .distinct()
        .all()
    ):
        if msisdn:
            numbers.add(msisdn)
        if imei:
            imeis.add(imei)
        if imsi:
            imsis.add(imsi)
    # device ids that show up on the subject's IPDR rows too
    for imei, imsi in (
        db.query(IPDRRecord.imei, IPDRRecord.imsi)
        .filter(IPDRRecord.case_id == case_id, IPDRRecord.msisdn == subject)
        .distinct()
        .all()
    ):
        if imei:
            imeis.add(imei)
        if imsi:
            imsis.add(imsi)

    cases: dict = {}

    def touch(cid):
        return cases.setdefault(cid, {"types": set(), "roles": set(), "values": set()})

    def add(pairs, mtype, role):
        for val, cids in pairs.items():
            for cid in cids:
                c = touch(cid)
                c["types"].add(mtype)
                c["roles"].add(role)
                c["values"].add(val)

    add(_value_case_pairs(db, CDRRecord.a_party_number, CDRRecord, numbers, case_id), "number", "subject")
    add(_value_case_pairs(db, CDRRecord.msisdn, CDRRecord, numbers, case_id), "number", "subject")
    add(_value_case_pairs(db, IPDRRecord.msisdn, IPDRRecord, numbers, case_id), "number", "subject")
    add(_value_case_pairs(db, CDRRecord.b_party_number, CDRRecord, numbers, case_id), "number", "counterpart")
    if imeis:
        add(_value_case_pairs(db, CDRRecord.imei, CDRRecord, imeis, case_id), "imei", "subject")
        add(_value_case_pairs(db, IPDRRecord.imei, IPDRRecord, imeis, case_id), "imei", "subject")
    if imsis:
        add(_value_case_pairs(db, CDRRecord.imsi, CDRRecord, imsis, case_id), "imsi", "subject")
        add(_value_case_pairs(db, IPDRRecord.imsi, IPDRRecord, imsis, case_id), "imsi", "subject")

    # accurate per-case counts + date range (combined OR; identifier sets are small for one subject)
    cdr_parts = [CDRRecord.a_party_number.in_(numbers), CDRRecord.b_party_number.in_(numbers), CDRRecord.msisdn.in_(numbers)]
    ipdr_parts = [IPDRRecord.msisdn.in_(numbers)]
    if imeis:
        cdr_parts.append(CDRRecord.imei.in_(imeis))
        ipdr_parts.append(IPDRRecord.imei.in_(imeis))
    if imsis:
        cdr_parts.append(CDRRecord.imsi.in_(imsis))
        ipdr_parts.append(IPDRRecord.imsi.in_(imsis))
    cdr_crit = or_(*cdr_parts)
    ipdr_crit = or_(*ipdr_parts)

    names = _case_names(db, cases.keys())
    matches = []
    for cid, c in cases.items():
        cnt, fseen, lseen = _count_range(db, cid, cdr_crit, ipdr_crit)
        types = sorted(c["types"], key=lambda t: _TYPE_PRIORITY.get(t, 9))
        role = "subject" if "subject" in c["roles"] else "counterpart"
        matches.append({
            "case_id": cid,
            "case_name": names.get(cid, f"Case {cid}"),
            "match_type": types[0] if types else "number",
            "match_types": types,
            "matched_values": sorted(c["values"])[:8],
            "confidence": "high",  # number/imei/imsi are all high-confidence identifiers
            "role": role,
            "record_count": cnt,
            "first_seen": _iso(fseen),
            "last_seen": _iso(lseen),
        })
    matches.sort(key=lambda m: ((m["record_count"] or 0), m["last_seen"] or ""), reverse=True)
    return {"subject": subject, "kind": "phone", "matches": matches}


def _ip_cross_case(db: Session, case_id: str, subject: str) -> dict:
    cases: dict = {}

    def touch(cid):
        return cases.setdefault(cid, {"roles": set(), "values": set()})

    def add(pairs, role):
        for val, cids in pairs.items():
            for cid in cids:
                c = touch(cid)
                c["roles"].add(role)
                c["values"].add(val)

    add(_value_case_pairs(db, IPDRRecord.source_ip, IPDRRecord, {subject}, case_id), "subject")
    add(_value_case_pairs(db, IPDRRecord.destination_ip, IPDRRecord, {subject}, case_id), "counterpart")

    ipdr_crit = or_(IPDRRecord.source_ip == subject, IPDRRecord.destination_ip == subject)
    names = _case_names(db, cases.keys())
    matches = []
    for cid, c in cases.items():
        cnt, fseen, lseen = _count_range(db, cid, None, ipdr_crit)
        role = "subject" if "subject" in c["roles"] else "counterpart"
        matches.append({
            "case_id": cid,
            "case_name": names.get(cid, f"Case {cid}"),
            "match_type": "ip",
            "match_types": ["ip"],
            "matched_values": sorted(c["values"])[:8],
            "confidence": "low",  # dynamic IPs are reassigned over time — verify the timeframe
            "role": role,
            "record_count": cnt,
            "first_seen": _iso(fseen),
            "last_seen": _iso(lseen),
        })
    matches.sort(key=lambda m: (m["record_count"] or 0), reverse=True)
    return {"subject": subject, "kind": "ip", "matches": matches}


def _count_range(db: Session, cid: str, cdr_crit, ipdr_crit):
    """Total matching records and (first, last) timestamp for one case, combining CDR+IPDR."""
    cnt = 0
    firsts = []
    lasts = []
    if cdr_crit is not None:
        n, mn, mx = (
            db.query(func.count(CDRRecord.id), func.min(CDRRecord.start_time), func.max(CDRRecord.start_time))
            .filter(CDRRecord.case_id == cid, cdr_crit)
            .one()
        )
        cnt += n or 0
        if mn:
            firsts.append(mn)
        if mx:
            lasts.append(mx)
    if ipdr_crit is not None:
        n, mn, mx = (
            db.query(func.count(IPDRRecord.id), func.min(IPDRRecord.start_time), func.max(IPDRRecord.start_time))
            .filter(IPDRRecord.case_id == cid, ipdr_crit)
            .one()
        )
        cnt += n or 0
        if mn:
            firsts.append(mn)
        if mx:
            lasts.append(mx)
    return cnt, (min(firsts) if firsts else None), (max(lasts) if lasts else None)


# ---------------------------------------------------------------------------
# Case-level overview (dashboard panel)
# ---------------------------------------------------------------------------
def case_cross_case_overview(db: Session, case_id: str, limit: int = 100) -> dict:
    """List this case's subjects that also appear in other cases, so the LEA sees prior history
    the moment the case is opened. Bounded to `limit` rows."""
    if not case_id:
        return {"hits": [], "total": 0}

    hits = []

    # --- phones: current case owner numbers + the handsets/SIMs behind each ---
    subj_imeis: dict = defaultdict(set)
    subj_imsis: dict = defaultdict(set)
    cur_numbers: set = set()
    for num, imei, imsi in (
        db.query(CDRRecord.a_party_number, CDRRecord.imei, CDRRecord.imsi)
        .filter(CDRRecord.case_id == case_id, CDRRecord.a_party_number.isnot(None))
        .distinct()
        .all()
    ):
        cur_numbers.add(num)
        if imei:
            subj_imeis[num].add(imei)
        if imsi:
            subj_imsis[num].add(imsi)

    all_imeis = set().union(*subj_imeis.values()) if subj_imeis else set()
    all_imsis = set().union(*subj_imsis.values()) if subj_imsis else set()

    num_other = _merge_pairs(
        _value_case_pairs(db, CDRRecord.a_party_number, CDRRecord, cur_numbers, case_id),
        _value_case_pairs(db, CDRRecord.b_party_number, CDRRecord, cur_numbers, case_id),
        _value_case_pairs(db, CDRRecord.msisdn, CDRRecord, cur_numbers, case_id),
        _value_case_pairs(db, IPDRRecord.msisdn, IPDRRecord, cur_numbers, case_id),
    )
    imei_other = _merge_pairs(
        _value_case_pairs(db, CDRRecord.imei, CDRRecord, all_imeis, case_id),
        _value_case_pairs(db, IPDRRecord.imei, IPDRRecord, all_imeis, case_id),
    )
    imsi_other = _merge_pairs(
        _value_case_pairs(db, CDRRecord.imsi, CDRRecord, all_imsis, case_id),
        _value_case_pairs(db, IPDRRecord.imsi, IPDRRecord, all_imsis, case_id),
    )

    for num in cur_numbers:
        cids = set(num_other.get(num, ()))
        dev = False
        for ie in subj_imeis.get(num, ()):
            if ie in imei_other:
                cids |= imei_other[ie]
                dev = True
        for iz in subj_imsis.get(num, ()):
            if iz in imsi_other:
                cids |= imsi_other[iz]
                dev = True
        if not cids:
            continue
        top = "number" if num in num_other else ("imei" if dev and any(i in imei_other for i in subj_imeis.get(num, ())) else "imsi")
        hits.append({
            "subject": num,
            "kind": "phone",
            "other_case_count": len(cids),
            "top_match_type": top,
            "confidence": "high",
        })

    # --- IPs: current case source IPs ---
    cur_ips = {
        ip for (ip,) in db.query(IPDRRecord.source_ip)
        .filter(IPDRRecord.case_id == case_id, IPDRRecord.source_ip.isnot(None))
        .distinct().all()
    }
    ip_other = _merge_pairs(
        _value_case_pairs(db, IPDRRecord.source_ip, IPDRRecord, cur_ips, case_id),
        _value_case_pairs(db, IPDRRecord.destination_ip, IPDRRecord, cur_ips, case_id),
    )
    for ip in cur_ips:
        cids = ip_other.get(ip)
        if not cids:
            continue
        hits.append({
            "subject": ip,
            "kind": "ip",
            "other_case_count": len(cids),
            "top_match_type": "ip",
            "confidence": "low",
        })

    total = len(hits)
    hits.sort(key=lambda h: (h["other_case_count"], h["confidence"] == "high", h["subject"]), reverse=True)
    return {"hits": hits[:limit], "total": total}
