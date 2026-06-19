from __future__ import annotations

from fastapi import APIRouter
from fastapi import Depends
from fastapi import Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.services.investigation_service import build_unified_timeline
from app.services.service_attribution_service import summarize_services
from app.services.tower_service import find_colocation_candidates
from app.services.tower_service import list_tower_activity
from app.models.ipdr import IPDRRecord

router = APIRouter()


@router.get("/timeline")
def unified_timeline(db: Session = Depends(get_db), limit: int = Query(default=200, ge=1, le=1000)):
    return build_unified_timeline(db, limit=limit)


@router.get("/services")
def service_summary(db: Session = Depends(get_db), limit: int = Query(default=200, ge=1, le=5000)):
    records = db.query(IPDRRecord).order_by(IPDRRecord.start_time.desc()).limit(limit).all()
    return summarize_services(records)


@router.get("/towers")
def tower_activity(db: Session = Depends(get_db)):
    return list_tower_activity(db)


@router.get("/colocation")
def colocation_candidates(db: Session = Depends(get_db), limit: int = Query(default=50, ge=1, le=200)):
    return find_colocation_candidates(db, limit=limit)

