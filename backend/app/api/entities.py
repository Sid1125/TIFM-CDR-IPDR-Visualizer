"""Entity intelligence graph API: identifiers -> persistent, reviewable entities.

GET  /entities/                paginated entity list (auto-syncs when records/decisions changed)
GET  /entities/search          find entities by any identifier value
GET  /entities/cross-case      entity-level cross-case intelligence
GET  /entities/{uid}           one entity in full (payload + relationships + suggestions)
GET  /entities/{uid}/graph     depth-1 ego graph (nodes/edges, capped; expand = call for neighbour)
POST /entities/{uid}/review    investigator verdicts: confirm/reject a merge, entity status, notes

Resolution is deterministic (entity_service) and persisted (entity_graph_service); investigator
merge decisions are durable and outrank the heuristics on every rebuild. Every mutation lands
in the chain of custody."""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.auth import User
from app.models.entity import Entity, EntityMergeDecision, EntityRelationship
from app.services.audit_service import log_action
from app.services.auth_service import get_current_user
from app.services.entity_graph_service import (ego_graph, entity_cross_case, entity_payload,
                                               search_entities, sync_entities)

router = APIRouter()


def _scope(case_id: str) -> str:
    return case_id or ""


def _suggestion_rows(db: Session, scope: str, uid: str | None = None, limit: int = 50):
    q = (db.query(EntityRelationship)
         .filter(EntityRelationship.case_scope == scope,
                 EntityRelationship.relationship_type == "SUGGESTED_MERGE",
                 EntityRelationship.status == "system"))
    if uid:
        q = q.filter(or_(EntityRelationship.source_uid == uid,
                         EntityRelationship.target_uid == uid))
    rows = q.order_by(EntityRelationship.evidence_count.desc()).limit(limit).all()
    uids = {r.source_uid for r in rows} | {r.target_uid for r in rows}
    labels = {e.entity_uid: e.label for e in
              db.query(Entity).filter(Entity.case_scope == scope,
                                      Entity.entity_uid.in_(uids)).all()} if uids else {}
    return [{"id": r.id, "a_entity": r.source_uid, "b_entity": r.target_uid,
             "a_label": labels.get(r.source_uid, r.source_uid),
             "b_label": labels.get(r.target_uid, r.target_uid),
             "pair_key": r.pair_key, "records": r.evidence_count,
             "confidence": r.confidence, "reason": r.explanation} for r in rows]


@router.get("/")
def list_entities(db: Session = Depends(get_db), case_id: str = Query(default=""),
                  page: int = Query(default=1, ge=1),
                  page_size: int = Query(default=1000, ge=1, le=2000),
                  entity_type: str = Query(default=""), flag: str = Query(default=""),
                  reviewed: str = Query(default=""), refresh: int = Query(default=0)):
    scope = _scope(case_id)
    sync = sync_entities(db, case_id=case_id or None, force=bool(refresh))
    q = db.query(Entity).filter(Entity.case_scope == scope)
    if entity_type:
        q = q.filter(Entity.classification == entity_type)
    if reviewed:
        q = q.filter(Entity.reviewed_status == reviewed)
    if flag:
        q = q.filter(Entity.flags.contains(f'"{flag}"'))
    total = q.count()
    rows = (q.order_by(Entity.record_count.desc())
            .offset((page - 1) * page_size).limit(page_size).all())
    entities = [entity_payload(r) for r in rows]
    edges = [{"a": r.source_uid, "b": r.target_uid, "calls": r.evidence_count}
             for r in db.query(EntityRelationship)
             .filter(EntityRelationship.case_scope == scope,
                     EntityRelationship.relationship_type == "CONTACTED")
             .order_by(EntityRelationship.evidence_count.desc()).limit(2000).all()]
    return {"entities": entities, "edges": edges,
            "suggestions": _suggestion_rows(db, scope),
            "meta": {"hub_fanout_threshold": sync.get("hub_fanout_threshold"),
                     "entity_count": total, "total": total, "page": page,
                     "page_size": page_size, "synced": sync.get("synced", False),
                     "cluster_count": db.query(func.count(Entity.id))
                     .filter(Entity.case_scope == scope,
                             Entity.classification == "identity_cluster").scalar() or 0}}


@router.get("/search")
def entity_search(db: Session = Depends(get_db), q: str = Query(default=""),
                  case_id: str = Query(default=""), limit: int = Query(default=25, ge=1, le=100)):
    sync_entities(db, case_id=case_id or None)
    return {"results": search_entities(db, _scope(case_id), q, limit=limit)}


@router.get("/cross-case")
def entities_cross_case(db: Session = Depends(get_db),
                        limit: int = Query(default=100, ge=1, le=500)):
    """Entity-level cross-case intelligence: 'this ENTITY appears in another case', backed by
    the per-case identifier breakdown (same device with different numbers still one hit)."""
    return entity_cross_case(db, limit=limit)


@router.get("/{entity_uid}")
def entity_detail(entity_uid: str, db: Session = Depends(get_db),
                  case_id: str = Query(default="")):
    scope = _scope(case_id)
    sync_entities(db, case_id=case_id or None)
    row = (db.query(Entity)
           .filter(Entity.case_scope == scope, Entity.entity_uid == entity_uid).first())
    if row is None:
        raise HTTPException(status_code=404, detail="entity not found")
    e = entity_payload(row)
    rels = (db.query(EntityRelationship)
            .filter(EntityRelationship.case_scope == scope,
                    EntityRelationship.relationship_type.in_(
                        ["CONTACTED", "CO_LOCATED", "POSSIBLE_ASSOCIATION"]),
                    or_(EntityRelationship.source_uid == entity_uid,
                        EntityRelationship.target_uid == entity_uid))
            .order_by(EntityRelationship.evidence_count.desc()).limit(50).all())
    edges = [{"a": r.source_uid, "b": r.target_uid, "calls": r.evidence_count}
             for r in rels if r.relationship_type == "CONTACTED"]
    associations = [{"a": r.source_uid, "b": r.target_uid, "type": r.relationship_type,
                     "confidence": r.confidence, "evidence_count": r.evidence_count,
                     "explanation": r.explanation}
                    for r in rels if r.relationship_type != "CONTACTED"]
    return {**e, "edges": edges, "associations": associations,
            "suggestions": _suggestion_rows(db, scope, uid=entity_uid, limit=10)}


@router.get("/{entity_uid}/graph")
def entity_graph(entity_uid: str, db: Session = Depends(get_db),
                 case_id: str = Query(default=""),
                 limit: int = Query(default=80, ge=20, le=300)):
    sync_entities(db, case_id=case_id or None)
    g = ego_graph(db, _scope(case_id), entity_uid, limit=limit)
    if g is None:
        raise HTTPException(status_code=404, detail="entity not found")
    return g


class EntityReview(BaseModel):
    action: str                 # confirm_merge | reject_merge | confirm | reject | unreview | note
    pair_key: str | None = None  # required for confirm_merge / reject_merge
    note: str | None = None


@router.post("/{entity_uid}/review")
def review_entity(entity_uid: str, body: EntityReview, request: Request,
                  db: Session = Depends(get_db), user: User = Depends(get_current_user),
                  case_id: str = Query(default="")):
    """Investigator verdicts. Merge verdicts (confirm_merge / reject_merge on a pair_key) are
    durable EntityMergeDecision rows the resolver consumes on every rebuild — a rejected pair
    is never merged again, a confirmed one survives the hub guard. Entity verdicts
    (confirm / reject / unreview / note) set the review status on the entity itself. All of
    it lands in the chain of custody."""
    scope = _scope(case_id)
    action = (body.action or "").strip()
    if action in ("confirm_merge", "reject_merge"):
        if not body.pair_key:
            raise HTTPException(status_code=422, detail="pair_key required for merge verdicts")
        decision = "confirmed" if action == "confirm_merge" else "rejected"
        row = (db.query(EntityMergeDecision)
               .filter(EntityMergeDecision.case_scope == scope,
                       EntityMergeDecision.pair_key == body.pair_key).first())
        if row is None:
            row = EntityMergeDecision(case_scope=scope, pair_key=body.pair_key)
            db.add(row)
        row.decision = decision
        row.note = body.note
        row.decided_by = getattr(user, "username", None)
        # Mark the working suggestion row so it leaves the queue immediately.
        db.query(EntityRelationship).filter(
            EntityRelationship.case_scope == scope,
            EntityRelationship.relationship_type == "SUGGESTED_MERGE",
            EntityRelationship.pair_key == body.pair_key,
        ).update({"status": decision}, synchronize_session=False)
        db.commit()
        log_action(db, user, request, "entity.merge_" + decision, case_id=case_id or None,
                   target=entity_uid, detail={"pair_key": body.pair_key, "note": body.note})
        # Force the rebuild: a flipped verdict (rejected -> confirmed) keeps the decision
        # COUNT unchanged, so the cheap freshness check alone would wrongly skip it.
        sync = sync_entities(db, case_id=case_id or None, force=True)
        return {"ok": True, "decision": decision, "pair_key": body.pair_key,
                "resynced": sync.get("synced", False)}

    row = (db.query(Entity)
           .filter(Entity.case_scope == scope, Entity.entity_uid == entity_uid).first())
    if row is None:
        raise HTTPException(status_code=404, detail="entity not found")
    if action in ("confirm", "reject", "unreview"):
        row.reviewed_status = {"confirm": "confirmed", "reject": "rejected",
                               "unreview": "unreviewed"}[action]
        row.reviewed_by = getattr(user, "username", None) if action != "unreview" else None
        row.reviewed_at = func.now() if action != "unreview" else None
        if body.note is not None:
            row.review_note = body.note or None
    elif action == "note":
        row.review_note = (body.note or "").strip() or None
    else:
        raise HTTPException(status_code=422, detail="unknown action")
    db.commit()
    log_action(db, user, request, "entity.review_" + action, case_id=case_id or None,
               target=entity_uid, detail={"note": body.note})
    return {"ok": True, "reviewed_status": row.reviewed_status, "note": row.review_note}
