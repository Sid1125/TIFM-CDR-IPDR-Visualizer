from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import Request
from sqlalchemy.orm import Session

from app.models.audit_log import AuditLog

_SEP = "\x1f"  # unit separator — unlikely to appear in field values, so fields can't collide


def _ts_epoch(ts: Optional[datetime]) -> int:
    """Absolute UTC epoch seconds — stable across SQLite (naive, stored as UTC) and Postgres
    (tz-aware), so a row hashed on write verifies identically on read regardless of column tz."""
    if ts is None:
        return 0
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return int(ts.timestamp())


def _entry_hash(ts, username, role, ip, action, case_id, case_name, target, detail, prev_hash) -> str:
    parts = [str(_ts_epoch(ts)), username or "", role or "", ip or "", action or "",
             case_id or "", case_name or "", target or "", detail or "", prev_hash or ""]
    return hashlib.sha256(_SEP.join(parts).encode("utf-8")).hexdigest()


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
        ip = _client_ip(request)
        cid = str(case_id) if case_id else None
        detail_json = json.dumps(detail, sort_keys=True) if detail else None
        ts = datetime.now(timezone.utc)
        # Chain to the previous row: prev_hash is the last entry's hash (genesis = "").
        last = (db.query(AuditLog.entry_hash)
                  .filter(AuditLog.entry_hash.isnot(None))
                  .order_by(AuditLog.id.desc()).first())
        prev_hash = last[0] if last and last[0] else ""
        entry_hash = _entry_hash(ts, uname, urole, ip, action, cid, case_name, target,
                                 detail_json, prev_hash)
        row = AuditLog(
            ts=ts,
            username=uname,
            role=urole,
            ip_address=ip,
            action=action,
            case_id=cid,
            case_name=case_name,
            target=target,
            detail=detail_json,
            prev_hash=prev_hash,
            entry_hash=entry_hash,
        )
        db.add(row)
        db.commit()
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass


def verify_audit_chain(db: Session) -> dict:
    """Recompute the hash chain over every chained row (oldest→newest). Detects any altered field
    (entry_hash won't match) or an inserted/removed row (prev_hash won't match the prior entry).
    Returns {ok, count, broken_at?, reason?}. Legacy rows with no entry_hash are ignored."""
    rows = (db.query(AuditLog)
              .filter(AuditLog.entry_hash.isnot(None))
              .order_by(AuditLog.id.asc()).all())
    prev = ""
    for r in rows:
        if (r.prev_hash or "") != prev:
            return {"ok": False, "broken_at": r.id, "count": len(rows),
                    "reason": "prev_hash mismatch — a row was inserted or removed"}
        recomputed = _entry_hash(r.ts, r.username, r.role, r.ip_address, r.action,
                                 r.case_id, r.case_name, r.target, r.detail, r.prev_hash)
        if (r.entry_hash or "") != recomputed:
            return {"ok": False, "broken_at": r.id, "count": len(rows),
                    "reason": "content altered — entry_hash does not match"}
        prev = r.entry_hash or ""
    return {"ok": True, "count": len(rows)}


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
