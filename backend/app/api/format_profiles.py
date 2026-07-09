"""CRUD for ingest format profiles — the DB of known operator/ISP CSV header formats. The upload
preview matches against these automatically; this router lets the UI save a confirmed mapping as
a new format and lets an admin page list/rename/delete stored formats."""
from __future__ import annotations

import json

from fastapi import APIRouter
from fastapi import Depends
from fastapi import HTTPException
from fastapi import Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.auth import User
from app.models.format_profile import IngestFormatProfile
from app.services.audit_service import log_action
from app.services.auth_service import get_current_user
from app.services.format_profile_service import save_profile
from app.services.ingest_service import CANONICAL

router = APIRouter()


def _serialize(p: IngestFormatProfile) -> dict:
    try:
        headers = json.loads(p.headers_json)
    except Exception:
        headers = []
    try:
        mapping = json.loads(p.mapping_json)
    except Exception:
        mapping = {}
    return {
        "id": p.id, "kind": p.kind, "name": p.name, "signature": p.signature,
        "headers": headers, "mapping": mapping,
        "times_used": p.times_used, "last_used": p.last_used.isoformat() if p.last_used else None,
        "created_by": p.created_by, "created_at": p.created_at.isoformat() if p.created_at else None,
    }


@router.get("/")
def list_profiles(kind: str = "", db: Session = Depends(get_db)):
    q = db.query(IngestFormatProfile)
    if kind:
        q = q.filter(IngestFormatProfile.kind == kind.lower())
    profiles = q.order_by(IngestFormatProfile.times_used.desc(), IngestFormatProfile.name).all()
    return {"profiles": [_serialize(p) for p in profiles]}


class SaveProfileBody(BaseModel):
    kind: str
    name: str
    headers: list[str]
    mapping: dict[str, str]


@router.post("/")
def create_or_update_profile(
    body: SaveProfileBody,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    kind = body.kind.lower()
    if kind not in CANONICAL:
        raise HTTPException(status_code=400, detail=f"kind must be one of {sorted(CANONICAL)}")
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="name is required")
    if not body.headers:
        raise HTTPException(status_code=400, detail="headers are required")
    mapping = {c: h for c, h in body.mapping.items() if c in CANONICAL[kind] and h in body.headers}
    if not mapping:
        raise HTTPException(status_code=400, detail="mapping has no valid canonical->header entries")
    prof = save_profile(db, kind, body.name.strip(), body.headers, mapping,
                        created_by=getattr(user, "username", None))
    log_action(db, user, request, "format_profile_save", target=f"{kind}:{prof.name}",
               detail={"columns_mapped": len(mapping)})
    return _serialize(prof)


@router.delete("/{profile_id}")
def delete_profile(
    profile_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    prof = db.query(IngestFormatProfile).filter(IngestFormatProfile.id == profile_id).first()
    if prof is None:
        raise HTTPException(status_code=404, detail="format profile not found")
    name, kind = prof.name, prof.kind
    db.delete(prof)
    db.commit()
    log_action(db, user, request, "format_profile_delete", target=f"{kind}:{name}")
    return {"deleted": profile_id}
