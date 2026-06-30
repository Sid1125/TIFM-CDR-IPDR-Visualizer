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
import time
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

# Bump whenever the SHAPE of any materialised analytic changes (new chart field, different
# report structure, etc.). A cached row with an older schema_version is ignored as a miss and
# recomputed on demand — so a code deploy can never serve analytics in a stale format.
SCHEMA_VERSION = 1

# Internal cache entry (not served to the UI) holding the per-table max row id at the last
# materialisation — the watermark an append diffs against to find only the new rows.
_META_KEY = "_agg_meta"


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


def invalidate(db: Session, case_id: str | None) -> None:
    """Public: drop cached analytics for one case AND the global ("") aggregate,
    since changing one case's records also invalidates the all-cases view.
    Caller is responsible for committing."""
    cid = case_id or ""
    db.query(AnalyticsCache).filter(
        AnalyticsCache.case_id.in_({cid, ""})
    ).delete(synchronize_session=False)


def invalidate_all(db: Session) -> None:
    """Public: drop every cached analytics row (used when all records are wiped).
    Caller is responsible for committing."""
    db.query(AnalyticsCache).delete(synchronize_session=False)


def _upsert(db: Session, case_id: str, key: str, data: dict | list,
           record_count: int | None = None, build_ms: int | None = None) -> None:
    existing = (
        db.query(AnalyticsCache)
        .filter(AnalyticsCache.case_id == case_id, AnalyticsCache.key == key)
        .one_or_none()
    )
    payload = _jdump(data)
    if existing:
        existing.data = payload
        existing.computed_at = datetime.utcnow()
        existing.schema_version = SCHEMA_VERSION
        if record_count is not None:
            existing.record_count = record_count
        if build_ms is not None:
            existing.build_ms = build_ms
    else:
        db.add(AnalyticsCache(case_id=case_id, key=key, data=payload,
                              schema_version=SCHEMA_VERSION,
                              record_count=record_count, build_ms=build_ms))


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


def _case_record_count(db: Session, case_id: str | None) -> int:
    """Total CDR + IPDR rows in scope — telemetry stored alongside the dashboard cache."""
    cq = db.query(func.count(CDRRecord.id))
    iq = db.query(func.count(IPDRRecord.id))
    if case_id:
        cq = cq.filter(CDRRecord.case_id == case_id)
        iq = iq.filter(IPDRRecord.case_id == case_id)
    return int((cq.scalar() or 0) + (iq.scalar() or 0))


def _max_id(db: Session, model, case_id: str | None) -> int:
    q = db.query(func.max(model.id))
    if case_id:
        q = q.filter(model.case_id == case_id)
    return int(q.scalar() or 0)


def _touched_subjects(db: Session, model, subj_col, case_id: str | None, since_id: int) -> set[str]:
    """Distinct subjects appearing in rows added after the watermark (id > since_id)."""
    q = db.query(subj_col).filter(model.id > since_id, subj_col.isnot(None))
    if case_id:
        q = q.filter(model.case_id == case_id)
    return {str(r[0]) for r in q.distinct().all() if r[0]}


def _sync_reports(db: Session, cid: str, prefix: str, capped_subjects: list[str],
                  touched: set[str], build_fn) -> None:
    """Bring the per-subject report cache for one prefix in line with an append, recomputing
    only what changed — the touched-subject win. Reports for untouched subjects still inside the
    cap are left intact; subjects pushed out of the cap are dropped; subjects newly inside the
    cap (or touched) are (re)built. This yields the same set of rows a full recompute would."""
    capped_set = set(capped_subjects)
    existing = {
        row[0][len(prefix):]
        for row in db.query(AnalyticsCache.key).filter(AnalyticsCache.case_id == cid).all()
        if row[0].startswith(prefix)
    }
    for sub in existing - capped_set:  # fell out of the top-N cap
        db.query(AnalyticsCache).filter(
            AnalyticsCache.case_id == cid, AnalyticsCache.key == prefix + sub
        ).delete(synchronize_session=False)
    for sub in capped_subjects:
        if sub in touched or sub not in existing:  # changed, or newly inside the cap
            _upsert(db, cid, prefix + sub, build_fn(sub))


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
    started = time.monotonic()

    try:
        _invalidate(db, cid)

        # 2. Subject lists (computed early so we can report record_count telemetry)
        cdr_subs = _cdr_subjects(db, case_id)
        ipdr_subs = _ipdr_subjects(db, case_id)
        rec_count = _case_record_count(db, case_id)
        build_ms = int((time.monotonic() - started) * 1000)

        # 1. Dashboard chart data (carries the case-level telemetry read by get_status)
        _upsert(db, cid, "dashboard", get_chart_data(db, case_id),
                record_count=rec_count, build_ms=build_ms)

        _upsert(db, cid, "subjects", {"cdr": cdr_subs, "ipdr": ipdr_subs})

        # 3. AI overview
        _upsert(db, cid, "ai_overview", _compute_ai_overview(db, case_id))

        # 4. Per-subject CDR reports (capped)
        for sub in cdr_subs[:_SUBJECT_CAP]:
            _upsert(db, cid, f"cdr_report:{sub}", get_cdr_reports(db, case_id, sub))

        # 5. Per-subject IPDR reports (capped, strictly separate)
        for sub in ipdr_subs[:_SUBJECT_CAP]:
            _upsert(db, cid, f"ipdr_report:{sub}", get_ipdr_reports(db, case_id, sub))

        # 6. Watermark — the max row id per table at this point, so a later append can find
        #    exactly the new rows and update incrementally (incremental_update).
        _upsert(db, cid, _META_KEY, {
            "cdr_max_id": _max_id(db, CDRRecord, case_id),
            "ipdr_max_id": _max_id(db, IPDRRecord, case_id),
        })

        db.commit()
        log.info("analytics: done case=%r  cdr=%d ipdr=%d rows=%d in %dms",
                 cid, len(cdr_subs), len(ipdr_subs), rec_count, int((time.monotonic() - started) * 1000))

    except Exception:
        log.exception("analytics: materialisation failed for case=%r", cid)
        db.rollback()


def incremental_update(db: Session, case_id: str | None) -> None:
    """Update a case's analytics after an *append*, recomputing only what the new rows touch.

    Case-wide aggregates (dashboard, subjects, ai_overview) are recomputed — they reflect every
    row and have no correct partial form here — but the per-subject report cache, which grows
    with the case's breadth, is synced touched-only via `_sync_reports`. Falls back to a full
    `materialize_case` when there is no prior watermark (nothing to diff against). The result is
    byte-identical to a full recompute (guarded by a parity test)."""
    cid = case_id or ""
    meta = get_cached(db, case_id, _META_KEY)
    if not meta or "cdr_max_id" not in meta:
        materialize_case(db, case_id)  # no baseline → full build
        return

    cdr_wm = int(meta.get("cdr_max_id", 0))
    ipdr_wm = int(meta.get("ipdr_max_id", 0))
    new_cdr_max = _max_id(db, CDRRecord, case_id)
    new_ipdr_max = _max_id(db, IPDRRecord, case_id)
    if new_cdr_max <= cdr_wm and new_ipdr_max <= ipdr_wm:
        return  # no new rows since the last build

    started = time.monotonic()
    touched_cdr = _touched_subjects(db, CDRRecord, CDRRecord.a_party_number, case_id, cdr_wm)
    touched_ipdr = _touched_subjects(db, IPDRRecord, IPDRRecord.source_ip, case_id, ipdr_wm)
    log.info("analytics: incremental case=%r touched cdr=%d ipdr=%d",
             cid, len(touched_cdr), len(touched_ipdr))

    try:
        cdr_subs = _cdr_subjects(db, case_id)
        ipdr_subs = _ipdr_subjects(db, case_id)
        rec_count = _case_record_count(db, case_id)
        build_ms = int((time.monotonic() - started) * 1000)

        _upsert(db, cid, "dashboard", get_chart_data(db, case_id),
                record_count=rec_count, build_ms=build_ms)
        _upsert(db, cid, "subjects", {"cdr": cdr_subs, "ipdr": ipdr_subs})
        _upsert(db, cid, "ai_overview", _compute_ai_overview(db, case_id))

        _sync_reports(db, cid, "cdr_report:", cdr_subs[:_SUBJECT_CAP], touched_cdr,
                      lambda s: get_cdr_reports(db, case_id, s))
        _sync_reports(db, cid, "ipdr_report:", ipdr_subs[:_SUBJECT_CAP], touched_ipdr,
                      lambda s: get_ipdr_reports(db, case_id, s))

        _upsert(db, cid, _META_KEY, {"cdr_max_id": new_cdr_max, "ipdr_max_id": new_ipdr_max})
        db.commit()
        log.info("analytics: incremental done case=%r rows=%d in %dms",
                 cid, rec_count, int((time.monotonic() - started) * 1000))
    except Exception:
        log.exception("analytics: incremental update failed for case=%r — full rebuild", cid)
        db.rollback()
        materialize_case(db, case_id)  # safety net: never leave the cache half-updated


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
    # Stale-format guard: a row written by an older analytics shape is ignored, forcing a
    # recompute. (Older rows pre-versioning have schema_version 0.)
    if (row.schema_version or 0) != SCHEMA_VERSION:
        return None
    try:
        return json.loads(row.data)
    except Exception:
        return None


def get_status(db: Session, case_id: str | None) -> dict:
    """Return whether analytics have been materialised for this case, when, and how big."""
    cid = case_id or ""
    row = (
        db.query(AnalyticsCache.computed_at, AnalyticsCache.schema_version,
                 AnalyticsCache.record_count, AnalyticsCache.build_ms)
        .filter(AnalyticsCache.case_id == cid, AnalyticsCache.key == "dashboard")
        .one_or_none()
    )
    if row is None or (row[1] or 0) != SCHEMA_VERSION:
        return {"ready": False, "computed_at": None}
    return {"ready": True, "computed_at": _ts(row[0]),
            "schema_version": row[1], "record_count": row[2], "build_ms": row[3]}
