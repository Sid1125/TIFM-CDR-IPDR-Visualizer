from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.watchlist import WatchlistEntry

router = APIRouter()

_IPV4 = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")


def _detect_kind(value: str) -> str:
    """Best-effort kind from the value shape: IPv4 -> ip, 15-digit -> imei, else phone.
    The caller can override by passing an explicit kind (e.g. 'cell')."""
    v = value.strip()
    if _IPV4.match(v):
        return "ip"
    digits = re.sub(r"\D", "", v)
    if len(digits) == 15 and digits == v:
        return "imei"
    return "phone"


def _serialize(e: WatchlistEntry) -> dict:
    return {"id": e.id, "value": e.value, "kind": e.kind, "note": e.note,
            "case_id": e.case_id, "group_name": e.group_name or "Default"}


@router.get("")
def list_watchlist(case_id: str = Query(default=""), group: str = Query(default=""),
                   db: Session = Depends(get_db)):
    q = db.query(WatchlistEntry)
    if case_id:
        q = q.filter(WatchlistEntry.case_id == case_id)
    if group:
        q = q.filter((WatchlistEntry.group_name == group)
                     | ((WatchlistEntry.group_name.is_(None)) & (group == "Default")))
    return [_serialize(e) for e in q.order_by(WatchlistEntry.id.desc()).all()]


@router.get("/groups")
def list_groups(db: Session = Depends(get_db)):
    """Named groups with member counts (NULL group_name folded into 'Default')."""
    counts: dict[str, int] = {}
    for e in db.query(WatchlistEntry).all():
        g = e.group_name or "Default"
        counts[g] = counts.get(g, 0) + 1
    return [{"group_name": g, "count": c} for g, c in sorted(counts.items())]


@router.get("/values")
def list_values(db: Session = Depends(get_db)):
    """All suspect identifiers (any group/case) for client-side highlighting."""
    return [{"value": e.value, "kind": e.kind, "group_name": e.group_name or "Default"}
            for e in db.query(WatchlistEntry).all()]


@router.post("")
def add_watchlist(payload: dict, db: Session = Depends(get_db)):
    value = (payload.get("value") or "").strip()
    if not value:
        raise HTTPException(status_code=400, detail="value is required")
    kind = payload.get("kind") or _detect_kind(value)
    group = (payload.get("group_name") or "Default").strip() or "Default"
    # Dedupe within a group (same value shouldn't appear twice in one group).
    existing = db.query(WatchlistEntry).filter(
        WatchlistEntry.value == value, WatchlistEntry.group_name == group).first()
    if existing:
        return _serialize(existing)
    entry = WatchlistEntry(case_id=(payload.get("case_id") or None), value=value, kind=kind,
                           group_name=group, note=(payload.get("note") or None))
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return _serialize(entry)


@router.delete("/{entry_id}")
def delete_watchlist(entry_id: int, db: Session = Depends(get_db)):
    entry = db.get(WatchlistEntry, entry_id)
    if entry:
        db.delete(entry)
        db.commit()
    return {"ok": True}
