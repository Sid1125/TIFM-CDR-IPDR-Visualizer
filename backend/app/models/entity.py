"""Persistent entity-intelligence layer: identifiers resolved into durable entities.

The resolution ENGINE (entity_service.build_entities) stays pure and in-memory; this layer
materialises its output so the graph survives restarts, carries investigator review decisions,
and can be queried at scale (pagination / search / ego-graphs) without re-resolving on every
request. Three rules govern the design:

  1. Identifiers are never deleted or rewritten by a merge — the original CDR/IPDR rows are
     the ground truth and the entity tables are a derived, rebuildable view over them.
  2. Investigator decisions are the ONLY state that must survive a rebuild, so they live in
     their own tables keyed by stable values (identifier pair-key / entity_uid), not by the
     rebuilt rows' autoincrement ids.
  3. Every persisted link carries its evidence (count, window, explanation) — a relationship
     that cannot answer "why does ARGUS believe this?" is not stored.
"""
from sqlalchemy import (Column, DateTime, Float, Index, Integer, String, Text,
                        UniqueConstraint, func)

from app.core.database import Base


class Entity(Base):
    """One resolved entity for one resolution scope (a case, or '' = the whole database).

    `entity_uid` is the engine's stable content hash of the member-identifier set, so the
    same cluster keeps the same uid across rebuilds; review state is carried over by uid.
    `entity_type` is the coarse intelligence class (UNKNOWN_PERSON / DEVICE / SERVICE /
    LOCATION); `classification` keeps the engine's finer, honesty-preserving key
    (individual / linked_identity / identity_cluster / identifier). `payload` is the full
    serialized entity dict from the engine — lossless for the UI, while the typed columns
    stay queryable."""

    __tablename__ = "entities"
    __table_args__ = (UniqueConstraint("case_scope", "entity_uid", name="uq_entity_scope_uid"),)

    id = Column(Integer, primary_key=True, index=True)
    entity_uid = Column(String, index=True, nullable=False)
    case_scope = Column(String, index=True, nullable=False, default="")
    entity_type = Column(String, nullable=False, default="UNKNOWN_PERSON")
    classification = Column(String, nullable=False, default="identifier")
    label = Column(String, nullable=False, default="")
    confidence = Column(Integer, nullable=False, default=0)   # 0-100, deterministic formula
    record_count = Column(Integer, nullable=False, default=0)
    first_seen = Column(DateTime, nullable=True)
    last_seen = Column(DateTime, nullable=True)
    flags = Column(Text, nullable=True)          # JSON list of lifecycle flags
    payload = Column(Text, nullable=True)        # full engine dict (JSON)
    reviewed_status = Column(String, nullable=False, default="unreviewed")  # unreviewed|confirmed|rejected
    review_note = Column(Text, nullable=True)
    reviewed_by = Column(String, nullable=True)
    reviewed_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class EntityIdentifier(Base):
    """One identifier observed inside one entity. Keyed by (case_scope, entity_uid) rather
    than the Entity row id so a rebuild (delete + reinsert) never dangles. `(identifier_type,
    value)` is indexed for /entities/search."""

    __tablename__ = "entity_identifiers"
    __table_args__ = (Index("ix_entident_type_value", "identifier_type", "value"),
                      Index("ix_entident_scope_uid", "case_scope", "entity_uid"))

    id = Column(Integer, primary_key=True, index=True)
    case_scope = Column(String, nullable=False, default="")
    entity_uid = Column(String, nullable=False)
    identifier_type = Column(String, nullable=False)   # MSISDN|IMSI|IMEI|IP|APP|TOWER
    value = Column(String, nullable=False)
    first_seen = Column(DateTime, nullable=True)
    last_seen = Column(DateTime, nullable=True)
    confidence = Column(Integer, nullable=False, default=0)
    record_count = Column(Integer, nullable=False, default=0)
    meta = Column(Text, nullable=True)                 # JSON: ip kind, tower city, service family…


class EntityRelationship(Base):
    """A typed, evidence-backed edge from an entity to another entity or a virtual node.

    `target_uid` is either another entity_uid or a namespaced virtual endpoint:
    ext:<msisdn> (unresolved counterpart number), case:<id>, svc:<service>, tower:<id>.
    relationship_type: CONTACTED | USES_SERVICE | APPEARS_IN_CASE | CO_LOCATED |
    SUGGESTED_MERGE | POSSIBLE_ASSOCIATION. Suggested merges/associations start
    status='system' and become 'confirmed'/'rejected' via the review endpoint (the durable
    record of that decision is EntityMergeDecision; the row status is the working copy)."""

    __tablename__ = "entity_relationships"
    __table_args__ = (Index("ix_entrel_scope_source", "case_scope", "source_uid"),
                      Index("ix_entrel_scope_target", "case_scope", "target_uid"))

    id = Column(Integer, primary_key=True, index=True)
    case_scope = Column(String, nullable=False, default="")
    source_uid = Column(String, nullable=False)
    target_uid = Column(String, nullable=False)
    relationship_type = Column(String, nullable=False)
    strength = Column(Float, nullable=False, default=0.0)     # 0..1 normalised
    evidence_count = Column(Integer, nullable=False, default=0)
    confidence = Column(String, nullable=True)                # HIGH|MEDIUM|LOW where tiered
    explanation = Column(Text, nullable=True)                 # deterministic "why" prose
    status = Column(String, nullable=False, default="system") # system|confirmed|rejected
    pair_key = Column(String, nullable=True)                  # identifier pair behind a suggested merge


class EntityMergeDecision(Base):
    """An investigator's durable verdict on one identifier pair. This is the table that makes
    'rejected stays rejected' true: the engine consumes these on every rebuild — a rejected
    pair is never unioned again, a confirmed pair is unioned even through the hub guard.
    pair_key = 'type:value|type:value' with the two sides sorted."""

    __tablename__ = "entity_merge_decisions"
    __table_args__ = (UniqueConstraint("case_scope", "pair_key", name="uq_entdec_scope_pair"),)

    id = Column(Integer, primary_key=True, index=True)
    case_scope = Column(String, index=True, nullable=False, default="")
    pair_key = Column(String, nullable=False)
    decision = Column(String, nullable=False)                 # confirmed|rejected
    note = Column(Text, nullable=True)
    decided_by = Column(String, nullable=True)
    decided_at = Column(DateTime(timezone=True), server_default=func.now())


class EntitySyncState(Base):
    """Freshness marker per resolution scope: the record/decision counts the last sync saw.
    A list/graph request compares cheap COUNTs against this and only re-resolves when the
    underlying data or the decision set actually changed."""

    __tablename__ = "entity_sync_state"
    __table_args__ = (UniqueConstraint("case_scope", name="uq_entsync_scope"),)

    id = Column(Integer, primary_key=True, index=True)
    case_scope = Column(String, nullable=False, default="")
    cdr_count = Column(Integer, nullable=False, default=0)
    ipdr_count = Column(Integer, nullable=False, default=0)
    decision_count = Column(Integer, nullable=False, default=0)
    entity_count = Column(Integer, nullable=False, default=0)
    hub_fanout_threshold = Column(Integer, nullable=True)
    synced_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
