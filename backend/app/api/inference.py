from __future__ import annotations

import json

from fastapi import APIRouter
from fastapi import Depends
from fastapi import Query
from fastapi.responses import PlainTextResponse
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.export_log import ExportLog
from app.models.watchlist import WatchlistEntry
from app.services.auth_service import get_current_user
from app.services.inference_service import apply_watchlist
from app.services.inference_service import export_manifest
from app.services.inference_service import make_export_ref
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


def _case_name(db, case_id):
    if not case_id:
        return None
    from app.models.case import Case
    case = db.get(Case, int(case_id)) if str(case_id).isdigit() else None
    return case.name if case else case_id


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


@router.get("/report.md")
def inference_report_md(db: Session = Depends(get_db), limit: int = Query(default=5000, ge=1, le=50000),
                        case_id: str = Query(default=""),
                        source: str = Query(default="analysis"),
                        user=Depends(get_current_user)):
    """The full report as a downloadable Markdown case report. Every call is assigned an
    official reference id, leads with a Document-control block + contents manifest, and is
    written to the export audit log. `source` distinguishes the Inferences-tab analysis
    export ('analysis') from the navbar evidence export ('evidence'). The reference id is
    also returned in the `X-Export-Ref` response header."""
    if source not in ("analysis", "evidence"):
        source = "analysis"
    report = run_all_db(db, limit=limit, case_id=case_id or None)
    phones, ips = _watchlist(db, case_id or None)
    apply_watchlist(report, phones, ips)
    case_name = _case_name(db, case_id)
    ref = make_export_ref(source)
    exported_by = getattr(user, "username", None)
    md = report_markdown(report, case_name=case_name, ref_id=ref, source=source, exported_by=exported_by)
    try:
        db.add(ExportLog(ref_id=ref, source=source, case_id=case_id or None, case_name=case_name,
                         exported_by=exported_by, details=json.dumps(export_manifest(report))))
        db.commit()
    except Exception:
        db.rollback()
    return PlainTextResponse(content=md, headers={"X-Export-Ref": ref})


@router.get("/exports")
def list_exports(db: Session = Depends(get_db), case_id: str = Query(default=""),
                 limit: int = Query(default=20, ge=1, le=100)):
    """Audit trail of generated exports (most recent first) — reference id, source, who,
    when, and the contents manifest."""
    q = db.query(ExportLog)
    if case_id:
        q = q.filter(ExportLog.case_id == case_id)
    rows = q.order_by(ExportLog.id.desc()).limit(limit).all()
    return [{"ref_id": r.ref_id, "source": r.source, "case_name": r.case_name,
             "exported_by": r.exported_by,
             "created_at": r.created_at.isoformat() if r.created_at else None,
             "details": json.loads(r.details) if r.details else {}} for r in rows]


@router.get("/subject/{subject}")
def subject_timeline(subject: str, db: Session = Depends(get_db),
                     limit: int = Query(default=5000, ge=1, le=50000),
                     case_id: str = Query(default="")):
    """Movement-annotated unified timeline (calls + SMS + data sessions) for one
    subject, keyed by msisdn (or imsi), with anchors and any impossible-travel legs."""
    return subject_timeline_db(db, subject, limit=limit, case_id=case_id or None)
