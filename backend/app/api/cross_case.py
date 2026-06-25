from __future__ import annotations

from fastapi import APIRouter
from fastapi import Depends
from fastapi import Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.services.cross_case_service import case_cross_case_overview
from app.services.cross_case_service import subject_cross_case

router = APIRouter()


@router.get("/subject")
def subject_links(
    db: Session = Depends(get_db),
    case_id: str = Query(...),
    subject: str = Query(...),
):
    """Every OTHER case the subject (or its handset/SIM, or its IP) appears in. Phone matches by
    number + IMEI/IMSI are high-confidence; IP matches are flagged low-confidence."""
    return subject_cross_case(db, case_id=case_id, subject=subject)


@router.get("/overview")
def case_overview(
    db: Session = Depends(get_db),
    case_id: str = Query(...),
    limit: int = Query(default=100, ge=1, le=500),
):
    """This case's subjects that also appear in other cases — the dashboard 'Cross-case hits'
    panel so prior history is visible the moment the case is opened."""
    return case_cross_case_overview(db, case_id=case_id, limit=limit)
