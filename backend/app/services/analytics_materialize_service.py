"""Materialized analytics engine.

Flow
----
  upload CDR/IPDR
    → BackgroundTasks.add_task(materialize_case, db_factory, case_id)
    → _invalidate()           ← wipe stale cache for this case
    → _compute_dashboard()    ← SQL aggregations for all 20 charts
    → _compute_subjects()     ← distinct CDR a-party + IPDR source-IPs
    → _compute_ai_overview()  ← pair-counts, sub-days, svc-counts, co-presence
    → _compute_reports()      ← per-subject CDR/IPDR report packs (capped at 100)
    → commit

All subsequent reads hit analytics_cache (O(1) key lookup) instead of
re-aggregating raw records on every request.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime

from sqlalchemy import Integer, and_, cast, extract, func
from sqlalchemy.orm import Session, aliased

from app.models.analytics import AnalyticsCache
from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord
from app.services.analysis_service import (
    get_chart_data,
    get_cdr_reports,
    get_ipdr_reports,
)

log = logging.getLogger(__name__)

_SUBJECT_CAP = 100  # max subjects per case materialised as individual reports


# ── internal helpers ──────────────────────────────────────────────────────────

def _ts(v) -> str | None:
    if v is None:
        return None
    return v.isoformat() if hasattr(v, "isoformat") else str(v)


def _jdump(obj) -> str:
    return json.dumps(obj, default=str)


def _invalidate(db: Session, case_id: str) -> None:
    db.query(AnalyticsCache).filter(AnalyticsCache.case_id == case_id).delete(
        synchronize_session=False
    )


def _upsert(db: Session, case_id: str, key: str, data: dict | list) -> None:
    existing = (
        db.query(AnalyticsCache)
        .filter(AnalyticsCache.case_id == case_id, AnalyticsCache.key == key)
        .one_or_none()
    )
    payload = _jdump(data)
    if existing:
        existing.data = payload
        existing.computed_at = datetime.utcnow()
    else:
        db.add(AnalyticsCache(case_id=case_id, key=key, data=payload))


# ── subject discovery ─────────────────────────────────────────────────────────

def _cdr_subjects(db: Session, case_id: str | None) -> list[str]:
    q = db.query(CDRRecord.a_party_number).filter(CDRRecord.a_party_number.isnot(None))
    if case_id:
        q = q.filter(CDRRecord.case_id == case_id)
    return sorted({str(r[0]) for r in q.distinct().all() if r[0]})


def _ipdr_subjects(db: Session, case_id: str | None) -> list[str]:
    q = db.query(IPDRRecord.source_ip).filter(IPDRRecord.source_ip.isnot(None))
    if case_id:
        q = q.filter(IPDRRecord.case_id == case_id)
    return sorted({str(r[0]) for r in q.distinct().all() if r[0]})


# ── AI overview (SQL-native) ──────────────────────────────────────────────────

def _compute_ai_overview(db: Session, case_id: str | None) -> dict:
    """Compute what the browser's getAiCache() used to do — entirely in SQL.

    pair_counts : {\"A|B\": n} — CDR contact pairs (both directions)
    sub_days    : {sub: {\"YYYY-MM-DD\": n}} — CDR + IPDR activity per day
    svc_counts  : {sub: {CALL:n, SMS:n, DATA:n}} — CDR call-type buckets
    meetings    : [{a, b, ts, tower, lat, lon}] — CDR co-presence (same tower/hour)
    """

    def _cq(*cols):
        q = db.query(*cols)
        return q.filter(CDRRecord.case_id == case_id) if case_id else q

    def _iq(*cols):
        q = db.query(*cols)
        return q.filter(IPDRRecord.case_id == case_id) if case_id else q

    # pair_counts — bidirectional CDR contacts
    pair_counts: dict[str, int] = {}
    for a, b, n in (
        _cq(CDRRecord.a_party_number, CDRRecord.b_party_number, func.count(CDRRecord.id))
        .filter(CDRRecord.a_party_number.isnot(None), CDRRecord.b_party_number.isnot(None))
        .group_by(CDRRecord.a_party_number, CDRRecord.b_party_number)
        .all()
    ):
        pair_counts[f"{a}|{b}"] = n

    # sub_days — CDR activity per a-party per day
    sub_days: dict[str, dict[str, int]] = {}
    for sub, d, n in (
        _cq(CDRRecord.a_party_number, func.date(CDRRecord.start_time), func.count(CDRRecord.id))
        .filter(CDRRecord.a_party_number.isnot(None), CDRRecord.start_time.isnot(None))
        .group_by(CDRRecord.a_party_number, func.date(CDRRecord.start_time))
        .all()
    ):
        if sub not in sub_days:
            sub_days[str(sub)] = {}
        sub_days[str(sub)][str(d)] = n

    # IPDR source-IP activity per day (kept strictly separate — never mixed into CDR sub_days)
    ipdr_sub_days: dict[str, dict[str, int]] = {}
    for sub, d, n in (
        _iq(IPDRRecord.source_ip, func.date(IPDRRecord.start_time), func.count(IPDRRecord.id))
        .filter(IPDRRecord.source_ip.isnot(None), IPDRRecord.start_time.isnot(None))
        .group_by(IPDRRecord.source_ip, func.date(IPDRRecord.start_time))
        .all()
    ):
        if sub not in ipdr_sub_days:
            ipdr_sub_days[str(sub)] = {}
        ipdr_sub_days[str(sub)][str(d)] = n

    # svc_counts — CDR call-type breakdown per a-party
    svc_counts: dict[str, dict[str, int]] = {}
    for sub, ct, n in (
        _cq(CDRRecord.a_party_number, CDRRecord.call_type, func.count(CDRRecord.id))
        .filter(CDRRecord.a_party_number.isnot(None))
        .group_by(CDRRecord.a_party_number, CDRRecord.call_type)
        .all()
    ):
        s = str(sub)
        if s not in svc_counts:
            svc_counts[s] = {"CALL": 0, "SMS": 0, "DATA": 0}
        ct_u = (ct or "").upper()
        if "CALL" in ct_u or "VOICE" in ct_u:
            svc_counts[s]["CALL"] += n
        elif "SMS" in ct_u or "TEXT" in ct_u or "MMS" in ct_u:
            svc_counts[s]["SMS"] += n
        else:
            svc_counts[s]["DATA"] += n

    # meetings — CDR co-presence: same tower, same hour, different a-parties
    CdrA = aliased(CDRRecord)
    CdrB = aliased(CDRRecord)
    mq = (
        db.query(
            CdrA.a_party_number.label("sa"),
            CdrB.a_party_number.label("sb"),
            CdrA.start_time.label("ts"),
            CdrA.tower_id.label("tower"),
            CdrA.latitude.label("lat"),
            CdrA.longitude.label("lon"),
        )
        .join(
            CdrB,
            and_(
                CdrA.tower_id == CdrB.tower_id,
                CdrA.tower_id.isnot(None),
                CdrA.a_party_number.isnot(None),
                CdrB.a_party_number.isnot(None),
                CdrA.a_party_number != CdrB.a_party_number,
                CdrA.a_party_number < CdrB.a_party_number,
                func.date(CdrA.start_time) == func.date(CdrB.start_time),
                cast(extract("hour", CdrA.start_time), Integer)
                == cast(extract("hour", CdrB.start_time), Integer),
            ),
        )
    )
    if case_id:
        mq = mq.filter(CdrA.case_id == case_id, CdrB.case_id == case_id)

    meetings = [
        {
            "a": r.sa, "b": r.sb,
            "ts": _ts(r.ts), "tower": r.tower,
            "lat": r.lat, "lon": r.lon,
        }
        for r in mq.limit(5000).all()
    ]

    return {
        "pair_counts": pair_counts,
        "sub_days": sub_days,
        "ipdr_sub_days": ipdr_sub_days,
        "svc_counts": svc_counts,
        "meetings": meetings,
    }


# ── main entry point ──────────────────────────────────────────────────────────

def materialize_case(db: Session, case_id: str | None) -> None:
    """Compute and persist all analytics for one case.  Called from BackgroundTasks
    immediately after a CDR or IPDR upload completes."""
    cid = case_id or ""
    log.info("analytics: materialising case=%r", cid)

    try:
        _invalidate(db, cid)

        # 1. Dashboard chart data
        _upsert(db, cid, "dashboard", get_chart_data(db, case_id))

        # 2. Subject lists
        cdr_subs = _cdr_subjects(db, case_id)
        ipdr_subs = _ipdr_subjects(db, case_id)
        _upsert(db, cid, "subjects", {"cdr": cdr_subs, "ipdr": ipdr_subs})

        # 3. AI overview
        _upsert(db, cid, "ai_overview", _compute_ai_overview(db, case_id))

        # 4. Per-subject CDR reports (capped)
        for sub in cdr_subs[:_SUBJECT_CAP]:
            _upsert(db, cid, f"cdr_report:{sub}", get_cdr_reports(db, case_id, sub))

        # 5. Per-subject IPDR reports (capped, strictly separate)
        for sub in ipdr_subs[:_SUBJECT_CAP]:
            _upsert(db, cid, f"ipdr_report:{sub}", get_ipdr_reports(db, case_id, sub))

        db.commit()
        log.info("analytics: done case=%r  cdr=%d ipdr=%d", cid, len(cdr_subs), len(ipdr_subs))

    except Exception:
        log.exception("analytics: materialisation failed for case=%r", cid)
        db.rollback()


# ── cache readers ─────────────────────────────────────────────────────────────

def get_cached(db: Session, case_id: str | None, key: str) -> dict | list | None:
    cid = case_id or ""
    row = (
        db.query(AnalyticsCache)
        .filter(AnalyticsCache.case_id == cid, AnalyticsCache.key == key)
        .one_or_none()
    )
    if row is None:
        return None
    try:
        return json.loads(row.data)
    except Exception:
        return None


def get_status(db: Session, case_id: str | None) -> dict:
    """Return whether analytics have been materialised for this case and when."""
    cid = case_id or ""
    row = (
        db.query(AnalyticsCache.computed_at)
        .filter(AnalyticsCache.case_id == cid, AnalyticsCache.key == "dashboard")
        .one_or_none()
    )
    if row is None:
        return {"ready": False, "computed_at": None}
    return {"ready": True, "computed_at": _ts(row[0])}
