from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.watchlist import WatchlistEntry

router = APIRouter()

_IPV4 = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")


def _detect_kind(value: str) -> str:
    """An IPv4 literal is an IPDR (IP) subject; anything else is treated as a CDR phone."""
    return "ip" if _IPV4.match(value) else "phone"


@router.get("")
def list_watchlist(case_id: str = Query(default=""), db: Session = Depends(get_db)):
    q = db.query(WatchlistEntry)
    if case_id:
        q = q.filter(WatchlistEntry.case_id == case_id)
    return [{"id": e.id, "value": e.value, "kind": e.kind, "note": e.note, "case_id": e.case_id}
            for e in q.order_by(WatchlistEntry.id.desc()).all()]


@router.post("")
def add_watchlist(payload: dict, db: Session = Depends(get_db)):
    value = (payload.get("value") or "").strip()
    if not value:
        raise HTTPException(status_code=400, detail="value is required")
    kind = payload.get("kind") or _detect_kind(value)
    entry = WatchlistEntry(case_id=(payload.get("case_id") or None), value=value,
                           kind=kind, note=(payload.get("note") or None))
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return {"id": entry.id, "value": entry.value, "kind": entry.kind}


@router.delete("/{entry_id}")
def delete_watchlist(entry_id: int, db: Session = Depends(get_db)):
    entry = db.get(WatchlistEntry, entry_id)
    if entry:
        db.delete(entry)
        db.commit()
    return {"ok": True}
