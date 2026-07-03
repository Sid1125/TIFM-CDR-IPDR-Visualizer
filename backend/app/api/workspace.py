"""Investigation workspace — relationship (edge) labels, hypotheses, and the evidence board.

The investigation-workspace layer on top of the analytics:
  * relationship labels — label the link BETWEEN two subjects (global by pair)
  * hypotheses — a structured 'theory of the case' (case-scoped, with a status)
  * evidence items — the findings board with its review lifecycle
    (system -> confirmed / rejected, with investigator notes)

All exposed as small CRUD routers; every mutation is written to the chain of custody.
"""
from __future__ import annotations

import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.auth import User
from app.models.evidence_item import EvidenceItem
from app.models.hypothesis import Hypothesis
from app.models.relationship_label import RelationshipLabel
from app.services.audit_service import log_action
from app.services.auth_service import get_current_user

relationships_router = APIRouter()
hypotheses_router = APIRouter()
evidence_router = APIRouter()

_STATUSES = {"open", "supported", "refuted"}
_EV_STATUSES = {"system", "confirmed", "rejected"}


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


# ── evidence board (findings + review lifecycle) ────────────────────────────────

def _ev_dict(e: EvidenceItem) -> dict:
    return {"id": e.id, "case_id": e.case_id, "sig": e.sig, "kind": e.kind, "label": e.label,
            "detail": e.detail, "subject": e.subject,
            "ts": e.ts.isoformat() if e.ts else None,
            "image": e.image, "status": e.status, "note": e.note,
            "created_by": e.created_by,
            "created_at": e.created_at.isoformat() if e.created_at else None,
            "reviewed_by": e.reviewed_by,
            "reviewed_at": e.reviewed_at.isoformat() if e.reviewed_at else None}


class EvidenceWrite(BaseModel):
    case_id: str | None = None
    sig: str
    kind: str = "note"
    label: str = ""
    detail: str | None = None
    subject: str | None = None
    ts: datetime | None = None
    image: str | None = None


class EvidenceReview(BaseModel):
    status: str | None = None   # confirmed | rejected | system (undo a review)
    note: str | None = None


@evidence_router.get("/")
def list_evidence(db: Session = Depends(get_db), _user: User = Depends(get_current_user),
                  case_id: str = Query(default=""), status: str = Query(default="")):
    q = db.query(EvidenceItem)
    if case_id:
        q = q.filter(EvidenceItem.case_id == case_id)
    if status and status in _EV_STATUSES:
        q = q.filter(EvidenceItem.status == status)
    return [_ev_dict(e) for e in q.order_by(EvidenceItem.id.desc()).all()]


@evidence_router.post("/")
def pin_evidence(payload: EvidenceWrite, request: Request,
                 db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Pin a finding onto the board. Upserts by (case_id, sig) so re-pinning the same
    finding refreshes its content instead of duplicating — but never clobbers an existing
    review (status/note survive a re-pin)."""
    sig = (payload.sig or "").strip()
    if not sig:
        raise HTTPException(status_code=400, detail="sig is required")
    row = db.query(EvidenceItem).filter(
        EvidenceItem.case_id == (payload.case_id or None), EvidenceItem.sig == sig).one_or_none()
    if row is None:
        row = EvidenceItem(case_id=payload.case_id or None, sig=sig, kind=payload.kind or "note",
                           label=payload.label or "", detail=payload.detail, subject=payload.subject,
                           ts=payload.ts, image=payload.image, created_by=user.username)
        db.add(row)
        action = "evidence_pin"
    else:
        row.kind = payload.kind or row.kind
        row.label = payload.label or row.label
        row.detail = payload.detail if payload.detail is not None else row.detail
        row.subject = payload.subject if payload.subject is not None else row.subject
        row.ts = payload.ts or row.ts
        row.image = payload.image or row.image
        action = "evidence_repin"
    db.commit(); db.refresh(row)
    log_action(db, user, request, action, case_id=payload.case_id, target=row.label,
               detail={"sig": sig, "kind": row.kind})
    return _ev_dict(row)


@evidence_router.put("/{eid}")
def review_evidence(eid: int, payload: EvidenceReview, request: Request,
                    db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """The review lifecycle: confirm / reject (or move back to system), and/or attach a
    note. Who reviewed and when is recorded on the row AND in the chain of custody —
    the decision is part of the record."""
    e = db.get(EvidenceItem, eid)
    if e is None:
        raise HTTPException(status_code=404, detail="evidence item not found")
    changed = {}
    if payload.status is not None:
        if payload.status not in _EV_STATUSES:
            raise HTTPException(status_code=400, detail=f"status must be one of {sorted(_EV_STATUSES)}")
        e.status = payload.status
        changed["status"] = payload.status
    if payload.note is not None:
        e.note = payload.note.strip() or None
        changed["note"] = bool(e.note)
    if changed:
        e.reviewed_by = user.username
        e.reviewed_at = datetime.utcnow()
    db.commit(); db.refresh(e)
    log_action(db, user, request, "evidence_review", case_id=e.case_id, target=e.label,
               detail={"sig": e.sig, **changed})
    return _ev_dict(e)


@evidence_router.delete("/{eid}")
def delete_evidence(eid: int, request: Request,
                    db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    e = db.get(EvidenceItem, eid)
    if e is not None:
        label, cid, sig = e.label, e.case_id, e.sig
        db.delete(e); db.commit()
        log_action(db, user, request, "evidence_unpin", case_id=cid, target=label, detail={"sig": sig})
    return {"success": True}
