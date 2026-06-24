from __future__ import annotations

from fastapi import APIRouter
from fastapi import Depends
from fastapi import Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.services.investigation_service import build_unified_timeline
from app.services.investigation_service import find_meetings
from app.services.service_attribution_service import summarize_services
from app.services.tower_service import find_colocation_candidates
from app.services.tower_service import list_tower_activity
from app.models.ipdr import IPDRRecord

router = APIRouter()


@router.get("/meetings")
def meetings(
    db: Session = Depends(get_db),
    case_id: str = Query(default=""),
    subject: str = Query(default=""),
    window_min: int = Query(default=60, ge=1, le=240),
    limit: int = Query(default=500, ge=1, le=2000),
):
    """Exact server-side co-location detection (two phones at one tower within a window).
    Replaces the client-side O(n^2) meeting scan; scales to large cases."""
    return find_meetings(db, case_id=case_id or None, subject=subject or None,
                         window_min=window_min, limit=limit)


@router.get("/timeline")
def unified_timeline(db: Session = Depends(get_db), limit: int = Query(default=200, ge=1, le=1000),
                     case_id: str = Query(default="")):
    return build_unified_timeline(db, limit=limit, case_id=case_id or None)


@router.get("/services")
def service_summary(db: Session = Depends(get_db), limit: int = Query(default=200, ge=1, le=5000),
                    case_id: str = Query(default="")):
    q = db.query(IPDRRecord)
    if case_id:
        q = q.filter(IPDRRecord.case_id == case_id)
    records = q.order_by(IPDRRecord.start_time.desc()).limit(limit).all()
    return summarize_services(records)


@router.get("/towers")
def tower_activity(db: Session = Depends(get_db), case_id: str = Query(default="")):
    return list_tower_activity(db, case_id=case_id or None)


@router.get("/colocation")
def colocation_candidates(db: Session = Depends(get_db), limit: int = Query(default=50, ge=1, le=200),
                          case_id: str = Query(default="")):
    return find_colocation_candidates(db, limit=limit, case_id=case_id or None)

