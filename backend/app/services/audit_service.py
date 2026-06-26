from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Optional

from fastapi import Request
from sqlalchemy.orm import Session

from app.models.audit_log import AuditLog


def _client_ip(request: Optional[Request]) -> Optional[str]:
    if request is None:
        return None
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    client = request.client
    return client.host if client else None


def log_action(
    db: Session,
    user: Any = None,
    request: Optional[Request] = None,
    action: str = "",
    *,
    username: Optional[str] = None,
    role: Optional[str] = None,
    case_id: Optional[str] = None,
    case_name: Optional[str] = None,
    target: Optional[str] = None,
    detail: Optional[dict] = None,
) -> None:
    """Write one chain-of-custody row. Defensive by design: an audit-write failure must NEVER
    break the primary action, so everything is wrapped and rolled back in isolation. `user` is a
    User model (username/role read off it); pass `username`/`role` directly for the login path
    where there is no authenticated user yet (or the login failed)."""
    try:
        uname = username if username is not None else getattr(user, "username", None)
        urole = role if role is not None else getattr(user, "role", None)
        row = AuditLog(
            username=uname,
            role=urole,
            ip_address=_client_ip(request),
            action=action,
            case_id=str(case_id) if case_id else None,
            case_name=case_name,
            target=target,
            detail=json.dumps(detail) if detail else None,
        )
        db.add(row)
        db.commit()
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass


def list_audit(
    db: Session,
    *,
    username: Optional[str] = None,
    action: Optional[str] = None,
    case_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    limit: int = 200,
) -> list[dict]:
    """Most-recent-first audit rows for the Admin viewer, with optional filters. Dates are
    ISO strings (date or datetime); they bound `ts` inclusively on the from side."""
    q = db.query(AuditLog)
    if username:
        q = q.filter(AuditLog.username == username.strip().lower())
    if action:
        q = q.filter(AuditLog.action == action)
    if case_id:
        q = q.filter(AuditLog.case_id == str(case_id))
    if date_from:
        try:
            q = q.filter(AuditLog.ts >= datetime.fromisoformat(date_from))
        except ValueError:
            pass
    if date_to:
        try:
            q = q.filter(AuditLog.ts <= datetime.fromisoformat(date_to))
        except ValueError:
            pass
    rows = q.order_by(AuditLog.id.desc()).limit(limit).all()
    return [
        {
            "id": r.id,
            "ts": r.ts.isoformat() if r.ts else None,
            "username": r.username,
            "role": r.role,
            "ip_address": r.ip_address,
            "action": r.action,
            "case_id": r.case_id,
            "case_name": r.case_name,
            "target": r.target,
            "detail": json.loads(r.detail) if r.detail else {},
        }
        for r in rows
    ]
