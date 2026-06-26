from __future__ import annotations

from fastapi import APIRouter
from fastapi import Depends
from fastapi import Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.services.cross_case_service import case_cross_case_graph
from app.services.cross_case_service import case_cross_case_overview
from app.services.cross_case_service import case_cross_case_report
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


@router.get("/report")
def case_report(
    db: Session = Depends(get_db),
    case_id: str = Query(...),
    limit: int = Query(default=200, ge=1, le=1000),
):
    """Full cross-case dossier for the dedicated Cross-Case tab: every recurring subject with its
    per-case match detail, a per-linked-case rollup, and headline summary."""
    return case_cross_case_report(db, case_id=case_id, limit=limit)


@router.get("/graph")
def case_graph(
    db: Session = Depends(get_db),
    case_id: str = Query(...),
    limit: int = Query(default=200, ge=1, le=1000),
):
    """Node/edge graph of recurring subjects bridging cases — case nodes plus subject nodes, with
    an edge from each subject to every case it appears in (match type + confidence per edge).
    Powers the Cross-Case tab's Graph view."""
    return case_cross_case_graph(db, case_id=case_id, limit=limit)
