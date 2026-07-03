"""Entity-resolution API: identifiers -> people.

GET /entities/            resolved entities + inter-entity communication edges
GET /entities/{entity_id} one entity in full (adds top attributed services from its IPDR traffic)

Everything is derived from the loaded records at request time (no stored entity table to
drift); ids are stable hashes of the member-identifier set, so they survive rebuilds as
long as the resolution itself doesn't change.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.ipdr import IPDRRecord
from app.services.entity_service import resolve_entities
from app.services.service_attribution_service import attribute_service

router = APIRouter()


@router.get("/")
def list_entities(db: Session = Depends(get_db), case_id: str = Query(default="")):
    return resolve_entities(db, case_id=case_id or None)


@router.get("/{entity_id}")
def entity_detail(entity_id: str, db: Session = Depends(get_db),
                  case_id: str = Query(default=""), service_limit: int = Query(default=500, ge=1, le=5000)):
    result = resolve_entities(db, case_id=case_id or None)
    entity = next((e for e in result["entities"] if e["id"] == entity_id), None)
    if entity is None:
        raise HTTPException(status_code=404, detail="entity not found")
    # Top apps/services actually used by this entity, from its own IPDR traffic.
    services = []
    if entity["phones"]:
        q = db.query(IPDRRecord).filter(IPDRRecord.msisdn.in_(entity["phones"]))
        if case_id:
            q = q.filter(IPDRRecord.case_id == case_id)
        counts = {}
        for record in q.order_by(IPDRRecord.start_time.desc()).limit(service_limit).all():
            attribution = attribute_service(record)
            name = attribution["service"]
            row = counts.setdefault(name, {"service": name, "family": attribution.get("family"),
                                           "category": attribution.get("category"), "records": 0,
                                           "confidence": attribution.get("confidence", 0)})
            row["records"] += 1
            row["confidence"] = max(row["confidence"], attribution.get("confidence", 0))
        services = sorted(counts.values(), key=lambda s: -s["records"])[:12]
    # This entity's communication edges only.
    edges = [e for e in result["edges"] if e["a"] == entity_id or e["b"] == entity_id]
    return {**entity, "services": services, "edges": edges}
