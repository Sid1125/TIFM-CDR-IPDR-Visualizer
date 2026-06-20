from __future__ import annotations

from fastapi import APIRouter
from fastapi import Depends
from fastapi import Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.services.inference_service import run_all_db
from app.services.inference_service import subject_timeline_db

router = APIRouter()


@router.get("/report")
def inference_report(db: Session = Depends(get_db), limit: int = Query(default=5000, ge=1, le=50000),
                     case_id: str = Query(default="")):
    """Full spatiotemporal inference report: movement, impossible-travel, co-presence,
    behavioral flags, periodic contacts and device/identity anomalies. Scoped to the
    given case when provided (matching the rest of the app)."""
    return run_all_db(db, limit=limit, case_id=case_id or None)


@router.get("/subject/{subject}")
def subject_timeline(subject: str, db: Session = Depends(get_db),
                     limit: int = Query(default=5000, ge=1, le=50000),
                     case_id: str = Query(default="")):
    """Movement-annotated unified timeline (calls + SMS + data sessions) for one
    subject, keyed by msisdn (or imsi), with anchors and any impossible-travel legs."""
    return subject_timeline_db(db, subject, limit=limit, case_id=case_id or None)
