"""Server-side analytics: every heavy computation that previously ran over
allRows in the browser is now a SQL aggregation or bounded Python loop.

get_subjects      → distinct a_party numbers for subject pickers
get_chart_data    → all 20 chart datasets pre-computed
get_cdr_reports   → 11-section analysis report pack for one subject
get_group_compare → common contacts/towers/cells/IMEIs across N subjects
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta

from sqlalchemy import func, extract, cast, Integer, case, or_
from sqlalchemy.orm import Session

from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord
from app.models.tower import Tower
from app.services.reference_service import lookup_number, lookup_imei


# ── helpers ───────────────────────────────────────────────────────────────────

def _d(v) -> str:
    if v is None:
        return ""
    return v.strftime("%Y-%m-%d") if hasattr(v, "strftime") else str(v)


def _ts(v) -> str | None:
    if v is None:
        return None
    return v.isoformat() if hasattr(v, "isoformat") else str(v)


def _hm(v) -> str:
    return v.strftime("%H:%M") if v and hasattr(v, "strftime") else ""


def _dur_str(secs) -> str:
    if secs is None:
        return ""
    s = int(secs)
    h, m, s = s // 3600, (s % 3600) // 60, s % 60
    if h:
        return f"{h}h {m}m {s}s"
    if m:
        return f"{m}m {s}s"
    return f"{s}s"


def _is_isd_num(num: str | None) -> bool:
    if not num:
        return False
    n = str(num).strip()
    if n.startswith("+") or n.startswith("00"):
        return True
    d = "".join(c for c in n if c.isdigit())
    return len(d) < 10


def _week(d: str) -> str:
    dt = datetime.strptime(d, "%Y-%m-%d")
    return (dt - timedelta(days=dt.weekday())).strftime("%Y-%m-%d")


# ── subjects ──────────────────────────────────────────────────────────────────

def get_subjects(db: Session, case_id: str | None) -> list[str]:
    """Distinct a_party_numbers — the 'owned' subjects for analysis pickers."""
    q = db.query(CDRRecord.a_party_number).filter(CDRRecord.a_party_number.isnot(None))
    if case_id:
        q = q.filter(CDRRecord.case_id == case_id)
    return sorted({str(r[0]) for r in q.distinct().all() if r[0]})


# ── chart data ────────────────────────────────────────────────────────────────

def get_chart_data(db: Session, case_id: str | None) -> dict:
    """All chart datasets pre-aggregated via SQL. One response drives ~20 chart functions."""

    def _cq(*cols):
        q = db.query(*cols)
        return q.filter(CDRRecord.case_id == case_id) if case_id else q

    def _iq(*cols):
        q = db.query(*cols)
        return q.filter(IPDRRecord.case_id == case_id) if case_id else q

    # ── daily counts ──────────────────────────────────────────────────────────
    cdr_daily = {_d(r[0]): r[1] for r in
                 _cq(func.date(CDRRecord.start_time), func.count(CDRRecord.id))
                 .filter(CDRRecord.start_time.isnot(None))
                 .group_by(func.date(CDRRecord.start_time)).all() if r[0]}
    ipdr_daily = {_d(r[0]): r[1] for r in
                  _iq(func.date(IPDRRecord.start_time), func.count(IPDRRecord.id))
                  .filter(IPDRRecord.start_time.isnot(None))
                  .group_by(func.date(IPDRRecord.start_time)).all() if r[0]}
    all_days = sorted(set(cdr_daily) | set(ipdr_daily))

    if len(all_days) > 120:
        unit = "week"
        buckets = sorted({_week(d) for d in all_days})
        cdr_b: defaultdict = defaultdict(int)
        ipdr_b: defaultdict = defaultdict(int)
        for d in all_days:
            w = _week(d)
            cdr_b[w] += cdr_daily.get(d, 0)
            ipdr_b[w] += ipdr_daily.get(d, 0)
        cdr_counts = [cdr_b[b] for b in buckets]
        ipdr_counts = [ipdr_b[b] for b in buckets]
    else:
        unit = "day"
        buckets = all_days
        cdr_counts = [cdr_daily.get(d, 0) for d in buckets]
        ipdr_counts = [ipdr_daily.get(d, 0) for d in buckets]

    # ── hourly + DOW + pattern_heat: CDR + IPDR combined ─────────────────────
    hourly = [0] * 24
    dow = [0] * 7  # JS getDay order: Sun=0, Mon=1, ..., Sat=6
    pattern_heat = [[0] * 24 for _ in range(7)]  # rows: Mon=0 (py weekday)

    def _apply_time_row(d_val, h_val, n):
        if not d_val or h_val is None:
            return
        h = int(h_val)
        if not (0 <= h < 24):
            return
        hourly[h] += n
        try:
            py_dow = datetime.strptime(_d(d_val), "%Y-%m-%d").weekday()
        except ValueError:
            return
        dow[(py_dow + 1) % 7] += n
        pattern_heat[py_dow][h] += n

    for d_val, h_val, n in (
        _cq(
            func.date(CDRRecord.start_time),
            cast(extract("hour", CDRRecord.start_time), Integer),
            func.count(CDRRecord.id),
        )
        .filter(CDRRecord.start_time.isnot(None))
        .group_by(func.date(CDRRecord.start_time), cast(extract("hour", CDRRecord.start_time), Integer))
        .all()
    ):
        _apply_time_row(d_val, h_val, n)

    for d_val, h_val, n in (
        _iq(
            func.date(IPDRRecord.start_time),
            cast(extract("hour", IPDRRecord.start_time), Integer),
            func.count(IPDRRecord.id),
        )
        .filter(IPDRRecord.start_time.isnot(None))
        .group_by(func.date(IPDRRecord.start_time), cast(extract("hour", IPDRRecord.start_time), Integer))
        .all()
    ):
        _apply_time_row(d_val, h_val, n)

    # ── top contacts: CDR parties + IPDR destination IPs ─────────────────────
    contact_cnt: defaultdict = defaultdict(int)
    for row in _cq(CDRRecord.a_party_number, func.count(CDRRecord.id)).filter(CDRRecord.a_party_number.isnot(None)).group_by(CDRRecord.a_party_number).all():
        contact_cnt[str(row[0])] += row[1]
    for row in _cq(CDRRecord.b_party_number, func.count(CDRRecord.id)).filter(CDRRecord.b_party_number.isnot(None)).group_by(CDRRecord.b_party_number).all():
        contact_cnt[str(row[0])] += row[1]
    # For IPDR-heavy cases add destination IPs as contacts when CDR contacts are sparse
    if sum(contact_cnt.values()) == 0:
        for row in _iq(IPDRRecord.destination_ip, func.count(IPDRRecord.id)).filter(IPDRRecord.destination_ip.isnot(None)).group_by(IPDRRecord.destination_ip).all():
            contact_cnt[str(row[0])] += row[1]
    top_contacts = [{"c": c, "n": n} for c, n in sorted(contact_cnt.items(), key=lambda x: x[1], reverse=True)[:10]]

    # ── active subjects: CDR a_party + IPDR msisdn ────────────────────────────
    subj_cnt: defaultdict = defaultdict(int)
    for row in _cq(CDRRecord.a_party_number, func.count(CDRRecord.id)).filter(CDRRecord.a_party_number.isnot(None)).group_by(CDRRecord.a_party_number).all():
        subj_cnt[str(row[0])] += row[1]
    for row in _iq(IPDRRecord.msisdn, func.count(IPDRRecord.id)).filter(IPDRRecord.msisdn.isnot(None)).group_by(IPDRRecord.msisdn).all():
        subj_cnt[str(row[0])] += row[1]
    active_subjects = [{"sub": k, "n": v} for k, v in sorted(subj_cnt.items(), key=lambda x: x[1], reverse=True)[:10]]

    # ── top towers: CDR + IPDR combined ───────────────────────────────────────
    tower_cnt: defaultdict = defaultdict(int)
    for row in _cq(CDRRecord.tower_id, func.count(CDRRecord.id)).filter(CDRRecord.tower_id.isnot(None)).group_by(CDRRecord.tower_id).all():
        tower_cnt[str(row[0])] += row[1]
    for row in _iq(IPDRRecord.tower_id, func.count(IPDRRecord.id)).filter(IPDRRecord.tower_id.isnot(None)).group_by(IPDRRecord.tower_id).all():
        tower_cnt[str(row[0])] += row[1]
    top_towers = [{"tower_id": k, "n": v} for k, v in sorted(tower_cnt.items(), key=lambda x: x[1], reverse=True)[:10]]

    # ── call types (CDR) + protocol fallback for IPDR-only cases ─────────────
    call_types = {str(r[0]): r[1] for r in _cq(CDRRecord.call_type, func.count(CDRRecord.id)).filter(CDRRecord.call_type.isnot(None)).group_by(CDRRecord.call_type).all()}
    if not call_types:
        # IPDR-only case: use protocol distribution as service type
        call_types = {str(r[0]).upper(): r[1] for r in _iq(IPDRRecord.protocol, func.count(IPDRRecord.id)).filter(IPDRRecord.protocol.isnot(None)).group_by(IPDRRecord.protocol).all()}
    directions = {str(r[0]): r[1] for r in _cq(CDRRecord.direction, func.count(CDRRecord.id)).filter(CDRRecord.direction.isnot(None)).group_by(CDRRecord.direction).all()}

    # ── duration distribution (7 bins: <10s, 10-30s, 30-60s, 1-5m, 5-15m, 15-60m, >60m) ──
    dur_expr = case(
        (CDRRecord.duration_seconds < 10, 0),
        (CDRRecord.duration_seconds < 30, 1),
        (CDRRecord.duration_seconds < 60, 2),
        (CDRRecord.duration_seconds < 300, 3),
        (CDRRecord.duration_seconds < 900, 4),
        (CDRRecord.duration_seconds < 3600, 5),
        else_=6,
    )
    dur_dist = [0] * 7
    for row in (_cq(dur_expr.label("b"), func.count(CDRRecord.id).label("n"))
                .filter(CDRRecord.duration_seconds.isnot(None))
                .group_by(dur_expr).all()):
        if row[0] is not None:
            dur_dist[int(row[0])] = row[1]

    # ── IPDR: protocols, top ports, top destinations by volume ────────────────
    protocols = {str(r[0]).upper(): r[1] for r in _iq(IPDRRecord.protocol, func.count(IPDRRecord.id)).filter(IPDRRecord.protocol.isnot(None)).group_by(IPDRRecord.protocol).all()}
    top_ports = [{"port": r[0], "n": r[1]} for r in
                 _iq(IPDRRecord.destination_port, func.count(IPDRRecord.id))
                 .filter(IPDRRecord.destination_port.isnot(None))
                 .group_by(IPDRRecord.destination_port)
                 .order_by(func.count(IPDRRecord.id).desc())
                 .limit(10).all()]
    vol_col = (func.coalesce(func.sum(IPDRRecord.bytes_uploaded), 0) +
               func.coalesce(func.sum(IPDRRecord.bytes_downloaded), 0))
    top_vol = [{"c": str(r[0]), "bytes": int(r[1] or 0)} for r in
               _iq(IPDRRecord.destination_ip, vol_col.label("b"))
               .filter(IPDRRecord.destination_ip.isnot(None))
               .group_by(IPDRRecord.destination_ip)
               .order_by(vol_col.desc())
               .limit(10).all()]

    # ── geo state: CDR → towers JOIN, fallback to IPDR → towers ─────────────
    geo_q = (db.query(Tower.state, func.count(CDRRecord.id).label("n"))
             .join(CDRRecord, CDRRecord.tower_id == Tower.tower_id)
             .filter(Tower.state.isnot(None)))
    if case_id:
        geo_q = geo_q.filter(CDRRecord.case_id == case_id)
    geo_state = [{"state": str(r[0]), "n": r[1]} for r in
                 geo_q.group_by(Tower.state).order_by(func.count(CDRRecord.id).desc()).limit(12).all()]
    if not geo_state:  # IPDR-only case: try IPDR tower records
        geo_q2 = (db.query(Tower.state, func.count(IPDRRecord.id).label("n"))
                  .join(IPDRRecord, IPDRRecord.tower_id == Tower.tower_id)
                  .filter(Tower.state.isnot(None)))
        if case_id:
            geo_q2 = geo_q2.filter(IPDRRecord.case_id == case_id)
        geo_state = [{"state": str(r[0]), "n": r[1]} for r in
                     geo_q2.group_by(Tower.state).order_by(func.count(IPDRRecord.id).desc()).limit(12).all()]

    # ── tower diversity per day (COUNT DISTINCT tower_id per date) ────────────
    td_raw = (_cq(func.date(CDRRecord.start_time), func.count(func.distinct(CDRRecord.tower_id)))
              .filter(CDRRecord.start_time.isnot(None), CDRRecord.tower_id.isnot(None))
              .group_by(func.date(CDRRecord.start_time)).all())
    td_by_day = {_d(r[0]): r[1] for r in td_raw if r[0]}
    if unit == "week":
        td_b: defaultdict = defaultdict(int)
        for d, v in td_by_day.items():
            td_b[_week(d)] = max(td_b[_week(d)], v)
        td_counts = [td_b.get(b, 0) for b in buckets]
    else:
        td_counts = [td_by_day.get(d, 0) for d in buckets]

    # ── new / returning contacts per bucket ───────────────────────────────────
    min_dates = {str(r[0]): _d(r[1]) for r in
                 _cq(CDRRecord.b_party_number, func.min(func.date(CDRRecord.start_time)))
                 .filter(CDRRecord.b_party_number.isnot(None), CDRRecord.start_time.isnot(None))
                 .group_by(CDRRecord.b_party_number).all() if r[0]}
    nr_fresh: defaultdict = defaultdict(int)
    nr_repeat: defaultdict = defaultdict(int)
    for num, d_val, n in (_cq(CDRRecord.b_party_number, func.date(CDRRecord.start_time), func.count(CDRRecord.id))
                          .filter(CDRRecord.b_party_number.isnot(None), CDRRecord.start_time.isnot(None))
                          .group_by(CDRRecord.b_party_number, func.date(CDRRecord.start_time)).all()):
        d_str = _d(d_val)
        if not d_str:
            continue
        bk = _week(d_str) if unit == "week" else d_str
        if min_dates.get(str(num)) == d_str:
            nr_fresh[bk] += n
        else:
            nr_repeat[bk] += n

    # ── contact direction (MO/MT per top 8 contacts) ─────────────────────────
    cd_map: defaultdict = defaultdict(lambda: {"mo": 0, "mt": 0})
    for num, dirn, n in (_cq(CDRRecord.b_party_number, CDRRecord.direction, func.count(CDRRecord.id))
                         .filter(CDRRecord.b_party_number.isnot(None), CDRRecord.direction.isnot(None))
                         .group_by(CDRRecord.b_party_number, CDRRecord.direction).all()):
        k = str(num)
        if str(dirn) == "MO":
            cd_map[k]["mo"] += n
        elif str(dirn) == "MT":
            cd_map[k]["mt"] += n
    contact_dir = [{"c": c, **v} for c, v in
                   sorted(cd_map.items(), key=lambda x: x[1]["mo"] + x[1]["mt"], reverse=True)[:8]]

    # ── avg call duration per top 10 contacts ─────────────────────────────────
    contact_avg_dur = [{"c": str(r[0]), "avg": round(float(r[1]), 1)} for r in
                       _cq(CDRRecord.b_party_number, func.avg(CDRRecord.duration_seconds), func.count(CDRRecord.id))
                       .filter(CDRRecord.b_party_number.isnot(None), CDRRecord.duration_seconds.isnot(None))
                       .group_by(CDRRecord.b_party_number)
                       .order_by(func.avg(CDRRecord.duration_seconds).desc())
                       .limit(10).all() if r[0]]

    # ── service timeline: last 14 active days × top 6 service types ──────────
    svc_days: defaultdict = defaultdict(lambda: defaultdict(int))
    for d_val, svc, n in (_cq(func.date(CDRRecord.start_time), CDRRecord.call_type, func.count(CDRRecord.id))
                          .filter(CDRRecord.start_time.isnot(None), CDRRecord.call_type.isnot(None))
                          .group_by(func.date(CDRRecord.start_time), CDRRecord.call_type).all()):
        svc_days[_d(d_val)][str(svc)] += n
    # IPDR protocol as service for mixed/IPDR-only cases
    for d_val, proto, n in (_iq(func.date(IPDRRecord.start_time), IPDRRecord.protocol, func.count(IPDRRecord.id))
                            .filter(IPDRRecord.start_time.isnot(None), IPDRRecord.protocol.isnot(None))
                            .group_by(func.date(IPDRRecord.start_time), IPDRRecord.protocol).all()):
        svc_days[_d(d_val)][str(proto).upper()] += n
    last14 = sorted(svc_days)[-14:]
    svc_totals: defaultdict = defaultdict(int)
    for d in last14:
        for svc, n in svc_days[d].items():
            svc_totals[svc] += n
    top_svcs = sorted(svc_totals, key=lambda x: svc_totals[x], reverse=True)[:6]

    return {
        "daily": {"buckets": buckets, "unit": unit, "cdr": cdr_counts, "ipdr": ipdr_counts},
        "hourly": hourly,
        "dow": dow,
        "pattern_heat": pattern_heat,
        "top_contacts": top_contacts,
        "active_subjects": active_subjects,
        "top_towers": top_towers,
        "call_types": call_types,
        "directions": directions,
        "dur_dist": dur_dist,
        "protocols": protocols,
        "top_ports": top_ports,
        "top_vol": top_vol,
        "geo_state": geo_state,
        "tower_diversity": {"buckets": buckets, "counts": td_counts},
        "new_returning": {
            "buckets": buckets,
            "fresh": [nr_fresh.get(b, 0) for b in buckets],
            "repeat": [nr_repeat.get(b, 0) for b in buckets],
        },
        "contact_dir": contact_dir,
        "contact_avg_dur": contact_avg_dur,
        "service_timeline": {
            "buckets": last14,
            "services": top_svcs,
            "series": [[svc_days[d].get(s, 0) for d in last14] for s in top_svcs],
        },
    }


# ── CDR / IPDR reports (provider-based) ──────────────────────────────────────
#
# Implementation lives in report_providers.py (CDRProvider, IPDRProvider).
# These functions are thin public wrappers kept for backward-compat with every
# call-site that imports from analysis_service.
#
# Adding a new data source: implement DataProvider in report_providers.py and
# expose a wrapper here.  No changes needed in the API layer or tests.

def get_cdr_reports(db: Session, case_id: str | None, sub: str) -> dict:
    """CDR analysis report for one subject — delegates to CDRProvider."""
    from app.services.report_providers import CDRProvider
    return CDRProvider(db, case_id, sub).build_report()


def get_ipdr_reports(db: Session, case_id: str | None, sub: str) -> dict:
    """IPDR analysis report for one subject — delegates to IPDRProvider."""
    from app.services.report_providers import IPDRProvider
    return IPDRProvider(db, case_id, sub).build_report()


# ── group compare (engine-based) ──────────────────────────────────────────────

def get_group_compare(db: Session, case_id: str | None, subjects: list[str]) -> dict:
    """Multi-subject comparison via CompareEngine[CDRCompareAdapter, IPDRCompareAdapter]."""
    from app.services.compare_engine import CDRCompareAdapter, CompareEngine, IPDRCompareAdapter
    engine = CompareEngine(
        adapters=[CDRCompareAdapter(db, case_id), IPDRCompareAdapter(db, case_id)],
        subjects=subjects,
    )
    return engine.compare()


# ── LEGACY STUBS (kept so existing tests/imports don't break) ────────────────
# The old monolithic implementations below have been replaced by the provider
# classes above.  Delete this section once all callers have been verified.

def _LEGACY_get_cdr_reports(db: Session, case_id: str | None, sub: str) -> dict:  # type: ignore[return]
    q = db.query(CDRRecord).filter(
        or_(CDRRecord.a_party_number == sub, CDRRecord.b_party_number == sub)
    )
    if case_id:
        q = q.filter(CDRRecord.case_id == case_id)
    inv_raw = q.order_by(CDRRecord.start_time).all()

    if not inv_raw:
        empty: dict = {"headers": [], "rows": [], "note": ""}
        return {
            "total_records": 0, "subject": sub, "sub_circle": None,
            "reports": {k: dict(empty) for k in [
                "day_first_last", "single_call_days", "weekday_weekend", "longest_calls",
                "day_night", "isd_calls", "other_state", "off_periods",
                "imei_summary", "imsi_summary", "bank_sms",
            ]},
        }

    def _other(r: CDRRecord) -> str:
        return (r.b_party_number or "") if r.a_party_number == sub else (r.a_party_number or "")

    def _is_sms(r: CDRRecord) -> bool:
        ct = (r.call_type or "").lower()
        return "sms" in ct or "text" in ct

    # ── group by day ──────────────────────────────────────────────────────────
    by_day: defaultdict = defaultdict(list)
    for r in inv_raw:
        if r.start_time:
            by_day[r.start_time.strftime("%Y-%m-%d")].append(r)
    days = sorted(by_day)

    owned = [r for r in inv_raw if r.a_party_number == sub and r.start_time]

    # day_first_last
    dayfl = []
    for d in days:
        rs = sorted(by_day[d], key=lambda r: r.start_time)
        f, l = rs[0], rs[-1]
        dayfl.append([d, _hm(f.start_time) + " → " + (_other(f) or "?"),
                      _hm(l.start_time) + " → " + (_other(l) or "?"), len(rs)])

    # single_call_days
    single = []
    for d in days:
        if len(by_day[d]) == 1:
            r = by_day[d][0]
            single.append([d, _hm(r.start_time), _other(r) or "?", "SMS" if _is_sms(r) else "Call"])

    # weekday_weekend (JS getDay order: Sun=0, Mon=1, ..., Sat=6)
    dow_js = [0] * 7
    for r in inv_raw:
        if r.start_time:
            dow_js[(r.start_time.weekday() + 1) % 7] += 1
    dnames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    wk = [[dnames[i], dow_js[i]] for i in range(7)]
    wk.append(["— Weekday total", sum(dow_js[1:6])])
    wk.append(["— Weekend total", dow_js[0] + dow_js[6]])

    # longest_calls
    calls = sorted(
        (r for r in inv_raw if not _is_sms(r) and r.duration_seconds is not None and r.start_time),
        key=lambda r: r.duration_seconds, reverse=True
    )[:30]
    longest = [[_ts(r.start_time), _other(r) or "?", _dur_str(r.duration_seconds), r.tower_id or ""] for r in calls]

    # day_night
    d_cnt = n_cnt = 0
    d_tow: defaultdict = defaultdict(int)
    n_tow: defaultdict = defaultdict(int)
    for r in inv_raw:
        if r.start_time:
            (d_cnt := d_cnt + 1) if 6 <= r.start_time.hour < 18 else (n_cnt := n_cnt + 1)  # type: ignore[assignment]
    d_cnt = n_cnt = 0
    for r in inv_raw:
        if r.start_time:
            if 6 <= r.start_time.hour < 18:
                d_cnt += 1
            else:
                n_cnt += 1
    for r in owned:
        if r.start_time and r.tower_id:
            if 6 <= r.start_time.hour < 18:
                d_tow[r.tower_id] += 1
            else:
                n_tow[r.tower_id] += 1

    def _top_tow(m: dict) -> str:
        if not m:
            return "—"
        top = max(m.items(), key=lambda x: x[1])
        return f"{top[0]} ({top[1]})"

    dn = [["Day (06:00–18:00)", d_cnt, _top_tow(dict(d_tow))],
          ["Night (18:00–06:00)", n_cnt, _top_tow(dict(n_tow))]]

    # isd_calls
    isd = []
    for r in inv_raw:
        oth = _other(r)
        if oth and _is_isd_num(oth) and r.start_time:
            ref = lookup_number(oth)
            isd.append([_ts(r.start_time), oth, ref.get("country") or "Unknown", "SMS" if _is_sms(r) else "Call"])

    # other_state
    sub_ref = lookup_number(sub)
    sub_circle = sub_ref.get("circle")
    ostate = []
    for r in inv_raw:
        oth = _other(r)
        if oth and r.start_time:
            ref = lookup_number(oth)
            oc = ref.get("circle")
            if oc and oc != sub_circle:
                ostate.append([_ts(r.start_time), oth, oc])

    # off_periods (gap >= 3 days)
    with_ts = [r for r in inv_raw if r.start_time]
    off = []
    for i in range(1, len(with_ts)):
        gap = (with_ts[i].start_time - with_ts[i - 1].start_time).total_seconds() / 86400
        if gap >= 3:
            off.append([_ts(with_ts[i - 1].start_time), _ts(with_ts[i].start_time), f"{gap:.1f} days"])

    # imei_summary
    imei_map: defaultdict = defaultdict(lambda: {"first": None, "last": None, "c": 0})
    for r in owned:
        if r.imei:
            m = imei_map[r.imei]
            m["c"] += 1
            if r.start_time:
                if m["first"] is None or r.start_time < m["first"]:
                    m["first"] = r.start_time
                if m["last"] is None or r.start_time > m["last"]:
                    m["last"] = r.start_time
    imei_rows = []
    for k, m in imei_map.items():
        ref = lookup_imei(k)
        mm = ((ref.get("make") or "") + " " + (ref.get("model") or "")).strip() or "—"
        imei_rows.append([k, mm, _ts(m["first"]), _ts(m["last"]), m["c"]])

    # imsi_summary
    imsi_cnt: defaultdict = defaultdict(int)
    for r in owned:
        if r.imsi:
            imsi_cnt[r.imsi] += 1
    imsi_rows = [[k, v] for k, v in sorted(imsi_cnt.items(), key=lambda x: x[1], reverse=True)]

    # bank_sms (alphanumeric sender IDs)
    bank = []
    for r in inv_raw:
        oth = _other(r) or ""
        if _is_sms(r) and r.start_time and any(c.isalpha() for c in oth):
            bank.append([_ts(r.start_time), oth, "SMS"])

    return {
        "total_records": len(inv_raw),
        "subject": sub,
        "sub_circle": sub_circle,
        "reports": {
            "day_first_last": {"headers": ["Date", "First call", "Last call", "Records"], "rows": dayfl},
            "single_call_days": {"headers": ["Date", "Time", "Contact", "Type"], "rows": single},
            "weekday_weekend": {"headers": ["Day", "Records"], "rows": wk},
            "longest_calls": {"headers": ["Time", "Contact", "Duration", "Tower"], "rows": longest},
            "day_night": {"headers": ["Bucket", "Records", "Dominant tower"], "rows": dn},
            "isd_calls": {"headers": ["Time", "Number", "Country", "Type"], "rows": isd},
            "other_state": {
                "headers": ["Time", "Number", "Circle"], "rows": ostate,
                "note": f"Subject circle: {sub_circle}" if sub_circle else "Subject circle unknown",
            },
            "off_periods": {"headers": ["Last seen", "Reappeared", "Gap"], "rows": off},
            "imei_summary": {"headers": ["IMEI", "Make / Model", "First", "Last", "Records"], "rows": imei_rows},
            "imsi_summary": {"headers": ["IMSI", "Records"], "rows": imsi_rows},
            "bank_sms": {"headers": ["Time", "Sender", "Type"], "rows": bank},
        },
    }


def _LEGACY_get_ipdr_reports(db: Session, case_id: str | None, sub: str) -> dict:  # noqa: N802
    """Legacy monolith — superseded by IPDRProvider.build_report()."""
    def _iq(*cols):
        q = db.query(*cols).filter(
            or_(IPDRRecord.source_ip == sub, IPDRRecord.msisdn == sub)
        )
        return q.filter(IPDRRecord.case_id == case_id) if case_id else q

    total = _iq(func.count(IPDRRecord.id)).scalar() or 0
    if not total:
        empty: dict = {"headers": [], "rows": []}
        return {
            "total_records": 0, "subject": sub,
            "reports": {k: dict(empty) for k in [
                "daily_volume", "protocol_breakdown", "top_destinations",
                "hourly_pattern", "data_throughput", "off_periods",
                "port_usage", "tower_footprint", "apn_breakdown", "rat_breakdown",
            ]},
        }

    # daily_volume: sessions + bytes per day
    dv_rows = []
    for row in (
        _iq(
            func.date(IPDRRecord.start_time).label("d"),
            func.count(IPDRRecord.id).label("n"),
            func.sum(IPDRRecord.bytes_uploaded).label("up"),
            func.sum(IPDRRecord.bytes_downloaded).label("dn"),
        )
        .filter(IPDRRecord.start_time.isnot(None))
        .group_by(func.date(IPDRRecord.start_time))
        .order_by(func.date(IPDRRecord.start_time))
        .all()
    ):
        up = int(row.up or 0)
        dn = int(row.dn or 0)
        dv_rows.append([_d(row.d), row.n, f"{up/1024/1024:.2f} MB", f"{dn/1024/1024:.2f} MB", f"{(up+dn)/1024/1024:.2f} MB"])

    # protocol_breakdown
    proto_rows = [
        [str(r[0]), r[1], f"{r[1]/total*100:.1f}%"]
        for r in _iq(IPDRRecord.protocol, func.count(IPDRRecord.id))
        .filter(IPDRRecord.protocol.isnot(None))
        .group_by(IPDRRecord.protocol)
        .order_by(func.count(IPDRRecord.id).desc())
        .all()
    ]

    # top_destinations: destination IPs (source sessions only — avoids polluting with transit)
    dest_q = db.query(IPDRRecord.destination_ip, func.count(IPDRRecord.id).label("n"))
    if case_id:
        dest_q = dest_q.filter(IPDRRecord.case_id == case_id)
    dest_q = dest_q.filter(IPDRRecord.source_ip == sub, IPDRRecord.destination_ip.isnot(None))
    top_dest = [
        [str(r[0]), r[1]]
        for r in dest_q.group_by(IPDRRecord.destination_ip).order_by(func.count(IPDRRecord.id).desc()).limit(30).all()
    ]

    # hourly_pattern
    hourly = [0] * 24
    for row in (
        _iq(extract("hour", IPDRRecord.start_time).label("h"), func.count(IPDRRecord.id).label("n"))
        .filter(IPDRRecord.start_time.isnot(None))
        .group_by(extract("hour", IPDRRecord.start_time))
        .all()
    ):
        h = int(row.h or 0)
        if 0 <= h < 24:
            hourly[h] = row.n
    hourly_rows = [[f"{h:02d}:00", hourly[h]] for h in range(24) if hourly[h]]

    # data_throughput: by day
    tput_rows = [[r[0], f"{int(r[1] or 0)/1024/1024:.2f} MB up", f"{int(r[2] or 0)/1024/1024:.2f} MB dn"]
        for r in _iq(func.date(IPDRRecord.start_time), func.sum(IPDRRecord.bytes_uploaded), func.sum(IPDRRecord.bytes_downloaded))
        .filter(IPDRRecord.start_time.isnot(None))
        .group_by(func.date(IPDRRecord.start_time))
        .order_by(func.date(IPDRRecord.start_time))
        .all()
    ]

    # off_periods: days with no sessions (gaps ≥ 3 days)
    all_dates = sorted({_d(r[0]) for r in _iq(func.date(IPDRRecord.start_time)).filter(IPDRRecord.start_time.isnot(None)).distinct().all() if r[0]})
    off_rows = []
    for i in range(1, len(all_dates)):
        try:
            gap = (datetime.strptime(all_dates[i], "%Y-%m-%d") - datetime.strptime(all_dates[i-1], "%Y-%m-%d")).days
            if gap >= 3:
                off_rows.append([all_dates[i-1], all_dates[i], gap])
        except ValueError:
            pass

    # port_usage
    port_rows = [
        [str(r[0]), str(r[1] or ""), r[2]]
        for r in _iq(IPDRRecord.destination_port, IPDRRecord.protocol, func.count(IPDRRecord.id))
        .filter(IPDRRecord.destination_port.isnot(None))
        .group_by(IPDRRecord.destination_port, IPDRRecord.protocol)
        .order_by(func.count(IPDRRecord.id).desc())
        .limit(30)
        .all()
    ]

    # tower_footprint
    tower_rows = [
        [str(r[0]), r[1]]
        for r in _iq(IPDRRecord.tower_id, func.count(IPDRRecord.id))
        .filter(IPDRRecord.tower_id.isnot(None))
        .group_by(IPDRRecord.tower_id)
        .order_by(func.count(IPDRRecord.id).desc())
        .limit(20)
        .all()
    ]

    # apn_breakdown
    apn_rows = [
        [str(r[0]), r[1], f"{r[1]/total*100:.1f}%"]
        for r in _iq(IPDRRecord.apn, func.count(IPDRRecord.id))
        .filter(IPDRRecord.apn.isnot(None))
        .group_by(IPDRRecord.apn)
        .order_by(func.count(IPDRRecord.id).desc())
        .all()
    ]

    # rat_breakdown (Radio Access Technology: 4G, 5G, WiFi…)
    rat_rows = [
        [str(r[0]), r[1], f"{r[1]/total*100:.1f}%"]
        for r in _iq(IPDRRecord.rat, func.count(IPDRRecord.id))
        .filter(IPDRRecord.rat.isnot(None))
        .group_by(IPDRRecord.rat)
        .order_by(func.count(IPDRRecord.id).desc())
        .all()
    ]

    return {
        "total_records": total,
        "subject": sub,
        "reports": {
            "daily_volume": {"headers": ["Date", "Sessions", "Upload", "Download", "Total"], "rows": dv_rows},
            "protocol_breakdown": {"headers": ["Protocol", "Sessions", "% of total"], "rows": proto_rows},
            "top_destinations": {"headers": ["Destination IP", "Sessions"], "rows": top_dest},
            "hourly_pattern": {"headers": ["Hour", "Sessions"], "rows": hourly_rows},
            "data_throughput": {"headers": ["Date", "Upload", "Download"], "rows": tput_rows},
            "off_periods": {"headers": ["Last active", "Resumed", "Gap (days)"], "rows": off_rows},
            "port_usage": {"headers": ["Dest port", "Protocol", "Sessions"], "rows": port_rows},
            "tower_footprint": {"headers": ["Tower", "Sessions"], "rows": tower_rows},
            "apn_breakdown": {"headers": ["APN", "Sessions", "% of total"], "rows": apn_rows},
            "rat_breakdown": {"headers": ["RAT", "Sessions", "% of total"], "rows": rat_rows},
        },
    }


# ── group compare ─────────────────────────────────────────────────────────────

def _LEGACY_get_group_compare(db: Session, case_id: str | None, subjects: list[str]) -> dict:  # noqa: N802
    """Legacy monolith — superseded by CompareEngine."""
    contacts: dict[str, set] = {}
    towers: dict[str, set] = {}
    cells: dict[str, set] = {}
    latlng: dict[str, set] = {}
    imeis: dict[str, set] = {}

    for sub in subjects:
        def _inv(*cols):
            q = db.query(*cols).filter(or_(CDRRecord.a_party_number == sub, CDRRecord.b_party_number == sub))
            return q.filter(CDRRecord.case_id == case_id) if case_id else q

        def _own(*cols):
            q = db.query(*cols).filter(CDRRecord.a_party_number == sub)
            return q.filter(CDRRecord.case_id == case_id) if case_id else q

        c_set: set = set()
        for row in _inv(CDRRecord.a_party_number, CDRRecord.b_party_number).all():
            a, b = row
            if a and str(a) != sub:
                c_set.add(str(a))
            if b and str(b) != sub:
                c_set.add(str(b))
        contacts[sub] = c_set
        towers[sub] = {str(r[0]) for r in _own(CDRRecord.tower_id).filter(CDRRecord.tower_id.isnot(None)).distinct().all()}
        cells[sub] = {str(r[0]) for r in _own(CDRRecord.cell_id).filter(CDRRecord.cell_id.isnot(None)).distinct().all()}
        latlng[sub] = {
            f"{round(float(r[0]), 3)},{round(float(r[1]), 3)}"
            for r in _own(CDRRecord.latitude, CDRRecord.longitude)
            .filter(CDRRecord.latitude.isnot(None), CDRRecord.longitude.isnot(None)).distinct().all()
        }
        imeis[sub] = {str(r[0]) for r in _own(CDRRecord.imei).filter(CDRRecord.imei.isnot(None)).distinct().all()}

    def _inter(d: dict[str, set]) -> list:
        acc = None
        for s in subjects:
            acc = set(d[s]) if acc is None else acc & d[s]
        return sorted(acc or [])

    common_contacts = [c for c in _inter(contacts) if c not in subjects]

    # who-called-whom matrix
    matrix = []
    for a in subjects:
        for b in subjects:
            if a == b:
                continue
            q = db.query(func.count(CDRRecord.id)).filter(
                CDRRecord.a_party_number == a, CDRRecord.b_party_number == b
            )
            if case_id:
                q = q.filter(CDRRecord.case_id == case_id)
            k = q.scalar() or 0
            if k:
                matrix.append([a, b, k])

    contacts_rows = []
    for c in common_contacts:
        ref = lookup_number(c)
        contacts_rows.append([c, ref.get("operator") or "—", ref.get("circle") or "—"])

    imei_rows = []
    for imei in _inter(imeis):
        ref = lookup_imei(imei)
        mm = ((ref.get("make") or "") + " " + (ref.get("model") or "")).strip() or "—"
        imei_rows.append([imei, mm])

    # ── IPDR sections — kept strictly separate (IP subjects, never folded into CDR) ──
    ipdr_towers: dict[str, set] = {}
    ipdr_protocols: dict[str, set] = {}
    ipdr_dest_ips: dict[str, set] = {}
    for sub in subjects:
        def _iq(*cols):
            q = db.query(*cols).filter(
                or_(IPDRRecord.source_ip == sub, IPDRRecord.msisdn == sub)
            )
            return q.filter(IPDRRecord.case_id == case_id) if case_id else q

        ipdr_towers[sub] = {str(r[0]) for r in _iq(IPDRRecord.tower_id).filter(IPDRRecord.tower_id.isnot(None)).distinct().all()}
        ipdr_protocols[sub] = {str(r[0]) for r in _iq(IPDRRecord.protocol).filter(IPDRRecord.protocol.isnot(None)).distinct().all()}
        ipdr_dest_ips[sub] = {str(r[0]) for r in db.query(IPDRRecord.destination_ip)
            .filter(IPDRRecord.source_ip == sub, IPDRRecord.destination_ip.isnot(None))
            .filter(*([] if not case_id else [IPDRRecord.case_id == case_id]))
            .distinct().limit(500).all()}

    return {
        "contacts": {"headers": ["Common contact", "Operator", "Circle"], "rows": contacts_rows},
        "towers": {"headers": ["Common tower"], "rows": [[t] for t in _inter(towers)]},
        "cells": {"headers": ["Common cell ID"], "rows": [[c] for c in _inter(cells)]},
        "latlng": {"headers": ["Common location (lat,lng ~110m)"], "rows": [[l] for l in _inter(latlng)]},
        "imeis": {"headers": ["Common IMEI", "Make / Model"], "rows": imei_rows},
        "matrix": {"headers": ["Caller", "Called", "Direct calls"], "rows": matrix},
        "ipdr_towers": {"headers": ["Common IPDR tower"], "rows": [[t] for t in _inter(ipdr_towers)]},
        "ipdr_protocols": {"headers": ["Common protocol"], "rows": [[p] for p in _inter(ipdr_protocols)]},
        "ipdr_dest_ips": {"headers": ["Common destination IP"], "rows": [[ip] for ip in sorted(_inter(ipdr_dest_ips))[:200]]},
    }
