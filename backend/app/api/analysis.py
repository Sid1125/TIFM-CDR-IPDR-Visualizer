from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.services.analysis_service import (
    get_subjects,
    get_chart_data,
    get_cdr_reports,
    get_group_compare,
)

router = APIRouter()


@router.get("/subjects")
def subjects(db: Session = Depends(get_db), case_id: str = Query(default="")):
    """Distinct a_party_numbers for this case — feeds the subject pickers."""
    return get_subjects(db, case_id=case_id or None)


@router.get("/chart-data")
def chart_data(db: Session = Depends(get_db), case_id: str = Query(default="")):
    """All chart datasets pre-aggregated in SQL. One call drives ~20 chart functions."""
    return get_chart_data(db, case_id=case_id or None)


@router.get("/cdr-reports")
def cdr_reports(
    db: Session = Depends(get_db),
    case_id: str = Query(default=""),
    sub: str = Query(default=""),
):
    """11-section CDR analysis report for one subject."""
    if not sub:
        return {"error": "sub parameter required"}
    return get_cdr_reports(db, case_id=case_id or None, sub=sub)


@router.get("/group-compare")
def group_compare(
    db: Session = Depends(get_db),
    case_id: str = Query(default=""),
    subjects: str = Query(default=""),
):
    """Common contacts/towers/IMEIs across selected subjects + call matrix."""
    subs = [s.strip() for s in subjects.split(",") if s.strip()]
    if len(subs) < 2:
        return {"error": "At least 2 subjects required"}
    return get_group_compare(db, case_id=case_id or None, subjects=subs)
