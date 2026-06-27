from datetime import datetime

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.subject_tag import SubjectTag
from app.models.auth import User
from app.services.auth_service import get_current_user
from app.services.audit_service import log_action

router = APIRouter()


class SubjectTagWrite(BaseModel):
    subject: str
    tag: str = ""


def _serialize(row: SubjectTag) -> dict:
    return {
        "subject": row.subject,
        "tag": row.tag,
        "updated_by": row.updated_by,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


@router.get("/")
def list_subject_tags(
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """The whole (small) tag map — the client caches it as {subject: tag} and applies it everywhere
    that subject is rendered. Global by identifier: no case filtering."""
    rows = db.query(SubjectTag).all()
    return [_serialize(r) for r in rows]


@router.put("/")
def upsert_subject_tag(
    payload: SubjectTagWrite,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Set/replace the intel tag for a subject. A blank tag deletes the row (clears the tag).
    Every edit is recorded on the chain-of-custody."""
    subject = (payload.subject or "").strip()
    tag = (payload.tag or "").strip()
    if not subject:
        return {"success": False, "subject": subject, "tag": ""}

    row = db.query(SubjectTag).filter(SubjectTag.subject == subject).one_or_none()
    if not tag:
        if row is not None:
            db.delete(row)
            db.commit()
        log_action(db, user, request, "tag_subject", target=subject, detail={"tag": ""})
        return {"success": True, "subject": subject, "tag": ""}

    if row is None:
        row = SubjectTag(subject=subject, tag=tag, updated_by=user.username,
                         updated_at=datetime.utcnow())
        db.add(row)
    else:
        row.tag = tag
        row.updated_by = user.username
        row.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(row)
    log_action(db, user, request, "tag_subject", target=subject, detail={"tag": tag})
    return {"success": True, **_serialize(row)}
