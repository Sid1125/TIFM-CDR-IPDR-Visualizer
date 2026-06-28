"""Read-through analytics API — serves pre-materialised results when warm,
falls back to on-demand computation (then caches) when cold."""
from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends, Query
from sqlalchemy.orm import Session

from app.core.database import SessionLocal, get_db
from app.services.analytics_materialize_service import (
    get_cached,
    get_status,
    materialize_case,
)
from app.services.analysis_service import (
    get_chart_data,
    get_cdr_reports,
    get_ipdr_reports,
)
from app.services.analytics_materialize_service import (
    _compute_ai_overview,
    _cdr_subjects,
    _ipdr_subjects,
    _upsert,
)

router = APIRouter()


def _db_factory():
    """Return a fresh Session for use in background tasks (which run after the
    request session is closed)."""
    return SessionLocal()


@router.get("/status")
def analytics_status(
    db: Session = Depends(get_db),
    case_id: str = Query(default=""),
):
    """Whether pre-computed analytics are available for this case."""
    return get_status(db, case_id or None)


@router.get("/dashboard")
def analytics_dashboard(
    db: Session = Depends(get_db),
    case_id: str = Query(default=""),
):
    """Return materialised chart data.  On cache miss, computes + caches then returns."""
    cid = case_id or None
    cached = get_cached(db, cid, "dashboard")
    if cached is not None:
        return cached
    data = get_chart_data(db, cid)
    _upsert(db, cid or "", "dashboard", data)
    db.commit()
    return data


@router.get("/subjects")
def analytics_subjects(
    db: Session = Depends(get_db),
    case_id: str = Query(default=""),
):
    """Return {cdr:[...], ipdr:[...]} subject lists from cache or compute on miss."""
    cid = case_id or None
    cached = get_cached(db, cid, "subjects")
    if cached is not None:
        return cached
    data = {"cdr": _cdr_subjects(db, cid), "ipdr": _ipdr_subjects(db, cid)}
    _upsert(db, cid or "", "subjects", data)
    db.commit()
    return data


@router.get("/ai-overview")
def analytics_ai_overview(
    db: Session = Depends(get_db),
    case_id: str = Query(default=""),
):
    """AI overview: pair_counts, sub_days, svc_counts, meetings.
    On miss, runs the SQL aggregation + caches."""
    cid = case_id or None
    cached = get_cached(db, cid, "ai_overview")
    if cached is not None:
        return cached
    data = _compute_ai_overview(db, cid)
    _upsert(db, cid or "", "ai_overview", data)
    db.commit()
    return data


@router.get("/reports")
def analytics_reports(
    db: Session = Depends(get_db),
    case_id: str = Query(default=""),
    sub: str = Query(default=""),
):
    """Cached CDR or IPDR report for one subject.  Tries CDR first; if empty
    falls back to IPDR.  On miss, computes + caches."""
    if not sub:
        return {"error": "sub parameter required"}
    cid = case_id or None
    key_cdr = f"cdr_report:{sub}"
    key_ipdr = f"ipdr_report:{sub}"

    # Try CDR cache
    cached = get_cached(db, cid, key_cdr)
    if cached is not None:
        if cached.get("total_records", 0):
            return cached
        # cached but empty → try IPDR
    else:
        # Cache miss: compute CDR
        cached = get_cdr_reports(db, cid, sub)
        _upsert(db, cid or "", key_cdr, cached)
        db.commit()
        if cached.get("total_records", 0):
            return cached

    # CDR empty → try IPDR
    cached_ipdr = get_cached(db, cid, key_ipdr)
    if cached_ipdr is not None:
        return cached_ipdr
    data_ipdr = get_ipdr_reports(db, cid, sub)
    _upsert(db, cid or "", key_ipdr, data_ipdr)
    db.commit()
    return data_ipdr


@router.post("/recompute")
def analytics_recompute(
    background_tasks: BackgroundTasks,
    case_id: str = Query(default=""),
):
    """Manually trigger re-materialisation for a case (e.g. after delete/edit)."""
    cid = case_id or None
    db = _db_factory()
    background_tasks.add_task(_run_materialize, db, cid)
    return {"status": "queued", "case_id": cid}


def _run_materialize(db: Session, case_id: str | None) -> None:
    try:
        materialize_case(db, case_id)
    finally:
        db.close()
