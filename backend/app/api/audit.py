from __future__ import annotations

from fastapi import APIRouter
from fastapi import Depends
from fastapi import Query
from fastapi import Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.auth import User
from app.services.auth_service import get_current_admin
from app.services.auth_service import get_current_user
from app.services.audit_service import list_audit
from app.services.audit_service import log_action

router = APIRouter()


@router.get("/log")
def audit_log(
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
    username: str = Query(default=""),
    action: str = Query(default=""),
    case_id: str = Query(default=""),
    date_from: str = Query(default=""),
    date_to: str = Query(default=""),
    limit: int = Query(default=200, ge=1, le=2000),
):
    """Chain-of-custody log (admin only), most recent first, with optional filters by user,
    action, case, and date range."""
    return list_audit(
        db,
        username=username or None,
        action=action or None,
        case_id=case_id or None,
        date_from=date_from or None,
        date_to=date_to or None,
        limit=limit,
    )


class ViewBeacon(BaseModel):
    action: str            # 'view_case' | 'view_subject'
    case_id: str | None = None
    case_name: str | None = None
    target: str | None = None


@router.post("/view")
def audit_view(
    payload: ViewBeacon,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Lightweight access beacon fired by the UI when an investigator opens a case or views a
    subject — so reads are on the chain of custody, not just mutations. Only the two view
    actions are accepted here."""
    action = payload.action if payload.action in ("view_case", "view_subject") else "view"
    log_action(
        db, user, request, action,
        case_id=payload.case_id, case_name=payload.case_name, target=payload.target,
    )
    return {"ok": True}
