from __future__ import annotations

from fastapi import APIRouter
from fastapi import Depends
from fastapi import Query
from fastapi.responses import PlainTextResponse
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.watchlist import WatchlistEntry
from app.services.inference_service import apply_watchlist
from app.services.inference_service import report_markdown
from app.services.inference_service import run_all_db
from app.services.inference_service import subject_timeline_db

router = APIRouter()


def _watchlist(db, case_id):
    q = db.query(WatchlistEntry)
    if case_id:
        q = q.filter(WatchlistEntry.case_id == case_id)
    entries = q.all()
    phones = [e.value for e in entries if e.kind == "phone"]
    ips = [e.value for e in entries if e.kind == "ip"]
    return phones, ips


@router.get("/report")
def inference_report(db: Session = Depends(get_db), limit: int = Query(default=5000, ge=1, le=50000),
                     case_id: str = Query(default="")):
    """Full spatiotemporal inference report: movement, impossible-travel, co-presence,
    network structure, temporal/behavioral shifts, IPDR volume/beaconing, geospatial roles,
    risk scores, entity resolution — plus any investigator watchlist hits. Scoped to the
    given case when provided."""
    report = run_all_db(db, limit=limit, case_id=case_id or None)
    phones, ips = _watchlist(db, case_id or None)
    apply_watchlist(report, phones, ips)
    return report


@router.get("/report.md", response_class=PlainTextResponse)
def inference_report_md(db: Session = Depends(get_db), limit: int = Query(default=5000, ge=1, le=50000),
                        case_id: str = Query(default="")):
    """The same report rendered as a downloadable Markdown case summary."""
    report = run_all_db(db, limit=limit, case_id=case_id or None)
    phones, ips = _watchlist(db, case_id or None)
    apply_watchlist(report, phones, ips)
    case_name = None
    if case_id:
        from app.models.case import Case
        case = db.get(Case, int(case_id)) if str(case_id).isdigit() else None
        case_name = case.name if case else case_id
    return report_markdown(report, case_name=case_name)


@router.get("/subject/{subject}")
def subject_timeline(subject: str, db: Session = Depends(get_db),
                     limit: int = Query(default=5000, ge=1, le=50000),
                     case_id: str = Query(default="")):
    """Movement-annotated unified timeline (calls + SMS + data sessions) for one
    subject, keyed by msisdn (or imsi), with anchors and any impossible-travel legs."""
    return subject_timeline_db(db, subject, limit=limit, case_id=case_id or None)
