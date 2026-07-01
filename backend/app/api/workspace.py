"""Investigation workspace — relationship (edge) labels + hypotheses.

Fills the two genuine gaps in ARGUS's investigation-workspace layer (evidence pins, subject intel
tags, annotations and the audit trail already exist):
  * relationship labels — label the link BETWEEN two subjects (global by pair)
  * hypotheses — a structured 'theory of the case' (case-scoped, with a status)

Both are exposed as small CRUD routers and every mutation is written to the chain of custody.
"""
from __future__ import annotations

import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.auth import User
from app.models.hypothesis import Hypothesis
from app.models.relationship_label import RelationshipLabel
from app.services.audit_service import log_action
from app.services.auth_service import get_current_user

relationships_router = APIRouter()
hypotheses_router = APIRouter()

_STATUSES = {"open", "supported", "refuted"}


# ── relationship labels ─────────────────────────────────────────────────────────

def _norm_pair(a: str, b: str) -> tuple[str, str]:
    a, b = (a or "").strip(), (b or "").strip()
    return (a, b) if a <= b else (b, a)


def _rel_dict(r: RelationshipLabel) -> dict:
    return {"subject_a": r.subject_a, "subject_b": r.subject_b, "label": r.label, "note": r.note,
            "updated_by": r.updated_by, "updated_at": r.updated_at.isoformat() if r.updated_at else None}


class RelationshipWrite(BaseModel):
    subject_a: str
    subject_b: str
    label: str = ""
    note: str | None = None


@relationships_router.get("/")
def list_relationships(db: Session = Depends(get_db), _user: User = Depends(get_current_user),
                       subject: str = Query(default="")):
    """All relationship labels, or just those touching `subject`. Global by pair (no case filter)."""
    q = db.query(RelationshipLabel)
    if subject:
        s = subject.strip()
        q = q.filter((RelationshipLabel.subject_a == s) | (RelationshipLabel.subject_b == s))
    return [_rel_dict(r) for r in q.order_by(RelationshipLabel.id.desc()).all()]


@relationships_router.put("/")
def upsert_relationship(payload: RelationshipWrite, request: Request,
                        db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Set/replace the label for a subject pair; a blank label deletes it. Order-independent."""
    a, b = _norm_pair(payload.subject_a, payload.subject_b)
    if not a or not b or a == b:
        raise HTTPException(status_code=400, detail="two distinct subjects are required")
    label = (payload.label or "").strip()
    row = db.query(RelationshipLabel).filter(
        RelationshipLabel.subject_a == a, RelationshipLabel.subject_b == b).one_or_none()
    if not label:
        if row is not None:
            db.delete(row); db.commit()
        log_action(db, user, request, "relationship_label", target=f"{a}|{b}", detail={"label": ""})
        return {"success": True, "subject_a": a, "subject_b": b, "label": ""}
    if row is None:
        row = RelationshipLabel(subject_a=a, subject_b=b, label=label, note=payload.note,
                                updated_by=user.username, updated_at=datetime.utcnow())
        db.add(row)
    else:
        row.label = label; row.note = payload.note
        row.updated_by = user.username; row.updated_at = datetime.utcnow()
    db.commit(); db.refresh(row)
    log_action(db, user, request, "relationship_label", target=f"{a}|{b}", detail={"label": label})
    return {"success": True, **_rel_dict(row)}


# ── hypotheses ──────────────────────────────────────────────────────────────────

def _hyp_dict(h: Hypothesis) -> dict:
    try:
        subs = json.loads(h.subjects) if h.subjects else []
    except Exception:
        subs = []
    return {"id": h.id, "case_id": h.case_id, "title": h.title, "body": h.body, "status": h.status,
            "subjects": subs, "created_by": h.created_by,
            "created_at": h.created_at.isoformat() if h.created_at else None,
            "updated_at": h.updated_at.isoformat() if h.updated_at else None}


class HypothesisWrite(BaseModel):
    case_id: str | None = None
    title: str
    body: str | None = None
    status: str = "open"
    subjects: list[str] | None = None


class HypothesisUpdate(BaseModel):
    title: str | None = None
    body: str | None = None
    status: str | None = None
    subjects: list[str] | None = None


@hypotheses_router.get("/")
def list_hypotheses(db: Session = Depends(get_db), _user: User = Depends(get_current_user),
                    case_id: str = Query(default="")):
    q = db.query(Hypothesis)
    if case_id:
        q = q.filter(Hypothesis.case_id == case_id)
    return [_hyp_dict(h) for h in q.order_by(Hypothesis.updated_at.desc(), Hypothesis.id.desc()).all()]


@hypotheses_router.post("/")
def create_hypothesis(payload: HypothesisWrite, request: Request,
                      db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    title = (payload.title or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="title is required")
    status = payload.status if payload.status in _STATUSES else "open"
    h = Hypothesis(case_id=payload.case_id or None, title=title, body=payload.body, status=status,
                   subjects=json.dumps(payload.subjects or []), created_by=user.username)
    db.add(h); db.commit(); db.refresh(h)
    log_action(db, user, request, "hypothesis_create", case_id=payload.case_id, target=title)
    return _hyp_dict(h)


@hypotheses_router.put("/{hid}")
def update_hypothesis(hid: int, payload: HypothesisUpdate, request: Request,
                      db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    h = db.get(Hypothesis, hid)
    if h is None:
        raise HTTPException(status_code=404, detail="hypothesis not found")
    if payload.title is not None:
        h.title = payload.title.strip() or h.title
    if payload.body is not None:
        h.body = payload.body
    if payload.status is not None and payload.status in _STATUSES:
        h.status = payload.status
    if payload.subjects is not None:
        h.subjects = json.dumps(payload.subjects)
    h.updated_at = datetime.utcnow()
    db.commit(); db.refresh(h)
    log_action(db, user, request, "hypothesis_update", case_id=h.case_id, target=h.title,
               detail={"status": h.status})
    return _hyp_dict(h)


@hypotheses_router.delete("/{hid}")
def delete_hypothesis(hid: int, request: Request,
                      db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    h = db.get(Hypothesis, hid)
    if h is not None:
        title, cid = h.title, h.case_id
        db.delete(h); db.commit()
        log_action(db, user, request, "hypothesis_delete", case_id=cid, target=title)
    return {"success": True}
