"""Entity intelligence graph — the persistent layer over the in-memory resolution engine.

`entity_service.build_entities` stays a pure function (records in, entities out). This module
materialises its output into the entity tables so the graph:

  * survives restarts and is queryable at scale (pagination / search / ego-graphs) without
    re-resolving on every request — a sync only runs when the record or decision counts for
    the scope actually changed;
  * carries investigator judgement: merge decisions (EntityMergeDecision) are fed BACK into
    the engine on every rebuild, so a rejected merge stays rejected and a confirmed merge
    survives the hub guard, forever, by design rather than by luck;
  * answers "why" everywhere: every persisted relationship carries its evidence count and a
    deterministic explanation. Nothing in here consults a model — AI may summarise this
    graph elsewhere, but it never decides who is who.

Scale rules: the browser never receives the whole graph. Lists are paginated, ego-graphs are
depth-1 and node-capped (expansion = another ego-graph call for the neighbour), search hits
the (identifier_type, value) index.
"""
from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.models.case import Case
from app.models.cdr import CDRRecord
from app.models.entity import (Entity, EntityIdentifier, EntityMergeDecision,
                               EntityRelationship, EntitySyncState)
from app.models.ipdr import IPDRRecord
from app.models.tower import Tower
from app.services.entity_service import build_entities
from app.services.service_attribution_service import attribute_service

# Rows of IPDR scanned (newest first) to attribute per-entity services during one sync.
_SVC_SCAN_CAP = 25000
# Persisted CO_LOCATED / POSSIBLE_ASSOCIATION edge budget per sync (quadratic guard).
_COLOC_CAP = 500
# Ignore towers shared by more than this many entities — a busy city tower co-locates
# everyone and proves nothing.
_COLOC_TOWER_MAX_ENTITIES = 20

_TIER_RANK = {"HIGH": 3, "MEDIUM": 2, "LOW": 1}
_TIER_BASE = {"HIGH": 90, "MEDIUM": 72, "LOW": 55}

# Engine classification -> coarse intelligence class. An identity_cluster (device farm /
# SIM-box / shared handset) is a DEVICE-centred entity, never presumed to be a person.
_ENTITY_TYPE = {
    "individual": "UNKNOWN_PERSON",
    "linked_identity": "UNKNOWN_PERSON",
    "identifier": "UNKNOWN_PERSON",
    "identity_cluster": "DEVICE",
}


def entity_confidence(entity: dict) -> int:
    """Deterministic 0-100 confidence that this cluster's identifiers belong together.

    The WEAKEST binding link defines cluster integrity (a chain is its weakest link): base
    from that tier, a small bonus for sheer witnessing volume, a penalty when an identifier
    is reused widely inside the cluster (shared handset ≠ one person). A single-identifier
    entity asserts no merge at all, so it is trivially certain."""
    links = entity.get("links") or []
    if not links:
        return 100
    weakest = min(links, key=lambda l: _TIER_RANK.get(l["confidence"], 0))
    base = _TIER_BASE.get(weakest["confidence"], 55)
    bonus = min(8, sum(l["records"] for l in links) // 25)
    if "device_reuse" in (entity.get("flags") or []):
        base -= 10
    if any(l.get("reviewed") for l in links):
        bonus += 3  # a human confirmed at least one binding
    return max(5, min(99, base + bonus))


def _parse_dt(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s)
    except (TypeError, ValueError):
        return None


def load_decisions(db: Session, scope: str):
    """(rejected_pair_keys, forced_pair_keys) for a scope. Case-scoped resolution also
    honours GLOBAL ('' scope) decisions — an investigator's verdict on an identifier pair
    holds wherever that pair appears."""
    rows = (db.query(EntityMergeDecision)
            .filter(EntityMergeDecision.case_scope.in_([scope, ""] if scope else [""]))
            .all())
    rejected = {r.pair_key for r in rows if r.decision == "rejected"}
    forced = {r.pair_key for r in rows if r.decision == "confirmed"}
    # A pair both rejected and confirmed across scopes: the scoped decision wins; among
    # equals, rejection wins (conservative — never merge on ambiguity).
    forced -= rejected
    return rejected, forced


def _counts(db: Session, case_id):
    cdr_q = db.query(func.count(CDRRecord.id))
    ipdr_q = db.query(func.count(IPDRRecord.id))
    if case_id:
        cdr_q = cdr_q.filter(CDRRecord.case_id == case_id)
        ipdr_q = ipdr_q.filter(IPDRRecord.case_id == case_id)
    return cdr_q.scalar() or 0, ipdr_q.scalar() or 0


def _entity_services(db: Session, case_id, phone_to_entity):
    """Top attributed apps/services per entity from its own IPDR traffic, one bounded scan."""
    q = db.query(IPDRRecord).filter(IPDRRecord.msisdn.isnot(None))
    if case_id:
        q = q.filter(IPDRRecord.case_id == case_id)
    per_entity: dict = defaultdict(dict)
    for rec in q.order_by(IPDRRecord.start_time.desc()).limit(_SVC_SCAN_CAP).all():
        eid = phone_to_entity.get(rec.msisdn)
        if not eid:
            continue
        att = attribute_service(rec)
        name = att["service"]
        row = per_entity[eid].setdefault(name, {
            "service": name, "family": att.get("family"),
            "category": att.get("category"), "records": 0, "confidence": 0})
        row["records"] += 1
        row["confidence"] = max(row["confidence"], att.get("confidence", 0))
    return {eid: sorted(svcs.values(), key=lambda s: -s["records"])[:12]
            for eid, svcs in per_entity.items()}


def sync_entities(db: Session, case_id=None, force: bool = False) -> dict:
    """Bring the persistent entity layer for one scope in line with the records + decisions.

    Cheap freshness check first (record/decision COUNTs vs the last sync's marker); a real
    rebuild deletes and reinserts the derived rows while carrying review state over by
    entity_uid. Original CDR/IPDR rows are never touched — this layer is a rebuildable view."""
    scope = case_id or ""
    cdr_n, ipdr_n = _counts(db, case_id)
    rejected, forced = load_decisions(db, scope)
    dec_n = len(rejected) + len(forced)

    st = db.query(EntitySyncState).filter(EntitySyncState.case_scope == scope).first()
    if (st is not None and not force
            and st.cdr_count == cdr_n and st.ipdr_count == ipdr_n and st.decision_count == dec_n):
        return {"synced": False, "entity_count": st.entity_count,
                "hub_fanout_threshold": st.hub_fanout_threshold}

    cdr_q = db.query(CDRRecord)
    ipdr_q = db.query(IPDRRecord)
    if case_id:
        cdr_q = cdr_q.filter(CDRRecord.case_id == case_id)
        ipdr_q = ipdr_q.filter(IPDRRecord.case_id == case_id)
    result = build_entities(cdr_q.all(), ipdr_q.all(),
                            rejected_pairs=rejected, forced_pairs=forced)

    # Resolve tower ids -> places for every referenced tower (one query).
    tower_ids = {t["tower_id"] for e in result["entities"] for t in e["towers"]}
    tower_meta = {}
    if tower_ids:
        tower_meta = {t.tower_id: t for t in
                      db.query(Tower).filter(Tower.tower_id.in_(tower_ids)).all()}
        for e in result["entities"]:
            for t in e["towers"]:
                m = tower_meta.get(t["tower_id"])
                if m:
                    t["city"] = m.city
                    t["state"] = m.state

    phone_to_entity = {p: e["id"] for e in result["entities"] for p in e["phones"]}
    services_by_entity = _entity_services(db, case_id, phone_to_entity)

    # Review state to carry across the rebuild, keyed by the stable uid.
    old_review = {r.entity_uid: r for r in
                  db.query(Entity).filter(Entity.case_scope == scope,
                                          or_(Entity.reviewed_status != "unreviewed",
                                              Entity.review_note.isnot(None))).all()}
    carry = {uid: {"reviewed_status": r.reviewed_status, "review_note": r.review_note,
                   "reviewed_by": r.reviewed_by, "reviewed_at": r.reviewed_at}
             for uid, r in old_review.items()}

    db.query(Entity).filter(Entity.case_scope == scope).delete(synchronize_session=False)
    db.query(EntityIdentifier).filter(EntityIdentifier.case_scope == scope).delete(synchronize_session=False)
    db.query(EntityRelationship).filter(EntityRelationship.case_scope == scope).delete(synchronize_session=False)

    contacted_pairs = set()
    for e in result["entities"]:
        e["services"] = services_by_entity.get(e["id"], [])
        conf = entity_confidence(e)
        e["confidence"] = conf
        rv = carry.get(e["id"], {})
        e["reviewed_status"] = rv.get("reviewed_status", "unreviewed")
        e["review_note"] = rv.get("review_note")
        db.add(Entity(
            entity_uid=e["id"], case_scope=scope,
            entity_type=_ENTITY_TYPE.get(e["entity_type"], "UNKNOWN_PERSON"),
            classification=e["entity_type"], label=e["label"], confidence=conf,
            record_count=e["record_count"],
            first_seen=_parse_dt(e["first_seen"]), last_seen=_parse_dt(e["last_seen"]),
            flags=json.dumps(e["flags"]), payload=json.dumps(e),
            reviewed_status=rv.get("reviewed_status", "unreviewed"),
            review_note=rv.get("review_note"), reviewed_by=rv.get("reviewed_by"),
            reviewed_at=rv.get("reviewed_at"),
        ))
        link_conf = {}
        for l in e["links"]:
            for side in (l["a"], l["b"]):
                link_conf[side] = max(link_conf.get(side, 0), _TIER_RANK.get(l["confidence"], 0))
        tier_pct = {3: 95, 2: 75, 1: 55}

        def _ident(id_type, value, key=None, record_count=0, meta=None):
            db.add(EntityIdentifier(
                case_scope=scope, entity_uid=e["id"], identifier_type=id_type, value=value,
                first_seen=_parse_dt(e["first_seen"]), last_seen=_parse_dt(e["last_seen"]),
                confidence=tier_pct.get(link_conf.get(key, 0), 100 if key is None else 60),
                record_count=record_count, meta=json.dumps(meta) if meta else None))

        for p in e["phones"]:
            _ident("MSISDN", p, key=f"phone:{p}")
        for v in e["imsis"]:
            _ident("IMSI", v, key=f"imsi:{v}")
        for v in e["imeis"]:
            _ident("IMEI", v, key=f"imei:{v}")
        for ip in e["ips"]:
            _ident("IP", ip["ip"], record_count=ip["records"], meta={"kind": ip["kind"]})
        for s in e["services"]:
            _ident("APP", s["service"], record_count=s["records"],
                   meta={"family": s.get("family"), "category": s.get("category")})
        for t in e["towers"]:
            _ident("TOWER", t["tower_id"], record_count=t["records"],
                   meta={"city": t.get("city"), "state": t.get("state")})

        for c in e["cases"]:
            db.add(EntityRelationship(
                case_scope=scope, source_uid=e["id"], target_uid=f"case:{c}",
                relationship_type="APPEARS_IN_CASE", strength=1.0,
                evidence_count=e["record_count"],
                explanation=f"Member identifiers of this entity were observed in case {c}."))
        for s in e["services"]:
            db.add(EntityRelationship(
                case_scope=scope, source_uid=e["id"], target_uid=f"svc:{s['service']}",
                relationship_type="USES_SERVICE", strength=(s["confidence"] or 0) / 100.0,
                evidence_count=s["records"],
                explanation=(f"{s['records']:,} IPDR session(s) from this entity's numbers were "
                             f"attributed to {s['service']} (attribution confidence {s['confidence']}%).")))

    for edge in result["edges"]:
        contacted_pairs.add(tuple(sorted((edge["a"], edge["b"]))))
        db.add(EntityRelationship(
            case_scope=scope, source_uid=edge["a"], target_uid=edge["b"],
            relationship_type="CONTACTED", strength=min(1.0, edge["calls"] / 50.0),
            evidence_count=edge["calls"],
            explanation=f"{edge['calls']:,} call/SMS record(s) between numbers of the two sides."))

    # Co-location: entities repeatedly seen on the same towers. NEVER a merge — location is
    # circumstantial. With communication on top it upgrades to a possible association.
    tower_entities = defaultdict(list)
    for e in result["entities"]:
        for t in e["towers"]:
            tower_entities[t["tower_id"]].append((e["id"], t["records"]))
    coloc = defaultdict(list)  # (uidA, uidB) -> [tower_id, ...]
    for tid, ents in tower_entities.items():
        if len(ents) < 2 or len(ents) > _COLOC_TOWER_MAX_ENTITIES:
            continue
        ents = sorted(ents, key=lambda x: -x[1])
        for i in range(len(ents)):
            for j in range(i + 1, len(ents)):
                coloc[tuple(sorted((ents[i][0], ents[j][0])))].append(tid)
    coloc_rows = sorted(((pair, tids) for pair, tids in coloc.items() if len(tids) >= 2),
                        key=lambda x: -len(x[1]))[:_COLOC_CAP]
    for (ua, ub), tids in coloc_rows:
        associated = (ua, ub) in contacted_pairs
        rel = "POSSIBLE_ASSOCIATION" if associated else "CO_LOCATED"
        place = ", ".join(tids[:4]) + ("…" if len(tids) > 4 else "")
        explanation = (f"Both entities were observed on {len(tids)} of the same towers ({place})."
                       + (" They also communicated directly — a possible association, not proof of identity."
                          if associated else
                          " Shared location alone is circumstantial and is never used to merge entities."))
        db.add(EntityRelationship(
            case_scope=scope, source_uid=ua, target_uid=ub, relationship_type=rel,
            strength=min(1.0, len(tids) / 10.0), evidence_count=len(tids),
            confidence="MEDIUM" if associated else "LOW", explanation=explanation))

    for s in result["suggestions"]:
        db.add(EntityRelationship(
            case_scope=scope, source_uid=s["a_entity"], target_uid=s["b_entity"],
            relationship_type="SUGGESTED_MERGE", strength=min(1.0, s["records"] / 50.0),
            evidence_count=s["records"], confidence=s["confidence"],
            explanation=s["reason"], pair_key=s["pair_key"]))

    if st is None:
        st = EntitySyncState(case_scope=scope)
        db.add(st)
    st.cdr_count = cdr_n
    st.ipdr_count = ipdr_n
    st.decision_count = dec_n
    st.entity_count = len(result["entities"])
    st.hub_fanout_threshold = result["meta"]["hub_fanout_threshold"]
    db.commit()
    return {"synced": True, "entity_count": len(result["entities"]),
            "hub_fanout_threshold": result["meta"]["hub_fanout_threshold"]}


def entity_payload(row: Entity) -> dict:
    e = json.loads(row.payload or "{}")
    e["confidence"] = row.confidence
    e["reviewed_status"] = row.reviewed_status
    e["review_note"] = row.review_note
    e["reviewed_by"] = row.reviewed_by
    e["entity_type_class"] = row.entity_type
    return e


def search_entities(db: Session, scope: str, q: str, limit: int = 25):
    """Find entities by ANY identifier value (or label). Rides the (type, value) index for
    the exact-prefix case; falls back to contains."""
    q = (q or "").strip()
    if not q:
        return []
    like = f"%{q}%"
    ident_rows = (db.query(EntityIdentifier)
                  .filter(EntityIdentifier.case_scope == scope,
                          EntityIdentifier.value.ilike(like))
                  .limit(limit * 8).all())
    matched = defaultdict(list)
    for r in ident_rows:
        matched[r.entity_uid].append({"type": r.identifier_type, "value": r.value})
    uids = list(matched)[:limit * 2]
    rows = []
    if uids:
        rows = (db.query(Entity)
                .filter(Entity.case_scope == scope, Entity.entity_uid.in_(uids))
                .order_by(Entity.record_count.desc()).limit(limit).all())
    out = []
    for row in rows:
        e = entity_payload(row)
        out.append({"id": row.entity_uid, "label": row.label,
                    "entity_type": row.classification,
                    "entity_type_label": e.get("entity_type_label"),
                    "confidence": row.confidence, "record_count": row.record_count,
                    "reviewed_status": row.reviewed_status,
                    "matched": matched[row.entity_uid][:6]})
    return out


# ---------------------------------------------------------------------------
# Ego graph — depth-1, node-capped; expansion is another call for the neighbour
# ---------------------------------------------------------------------------
_IDENT_EDGE = {"MSISDN": "USES_NUMBER", "IMSI": "OWNS_SIM", "IMEI": "USES_DEVICE",
               "IP": "OBSERVED_IP", "APP": "USES_SERVICE", "TOWER": "SEEN_AT"}
_IDENT_CAPS = {"MSISDN": 12, "IMSI": 12, "IMEI": 12, "IP": 6, "APP": 8, "TOWER": 6}


def ego_graph(db: Session, scope: str, uid: str, limit: int = 80):
    """The investigation graph around ONE entity: identifiers, services, locations, cases,
    and related entities — every edge typed and explained. Node-capped; `truncated` per
    group tells the UI there is more behind a lazy expansion."""
    row = (db.query(Entity)
           .filter(Entity.case_scope == scope, Entity.entity_uid == uid).first())
    if row is None:
        return None
    e = entity_payload(row)
    nodes = [{"id": uid, "type": "entity", "label": row.label,
              "classification": row.classification,
              "entity_type_label": e.get("entity_type_label"),
              "confidence": row.confidence, "reviewed_status": row.reviewed_status,
              "record_count": row.record_count, "flags": e.get("flags", []), "center": True}]
    edges = []
    truncated = {}
    budget = max(20, min(300, limit)) - 1

    link_by_side = {}
    for l in e.get("links", []):
        for side in (l["a"], l["b"]):
            cur = link_by_side.get(side)
            if cur is None or _TIER_RANK.get(l["confidence"], 0) > _TIER_RANK.get(cur["confidence"], 0):
                link_by_side[side] = l

    def _add(node_id, node_type, label, edge_type, *, meta=None, confidence=None,
             explanation=None, evidence=None):
        nonlocal budget
        if budget <= 0:
            return False
        nodes.append({"id": node_id, "type": node_type, "label": label, **(meta or {})})
        edges.append({"source": uid, "target": node_id, "type": edge_type,
                      "confidence": confidence, "explanation": explanation,
                      "evidence_count": evidence})
        budget -= 1
        return True

    groups = [("MSISDN", [(p, {}) for p in e.get("phones", [])], "phone"),
              ("IMSI", [(v, {}) for v in e.get("imsis", [])], "sim"),
              ("IMEI", [(v, {}) for v in e.get("imeis", [])], "device"),
              ("IP", [(i["ip"], {"kind": i.get("kind"), "records": i.get("records")})
                      for i in e.get("ips", [])], "ip"),
              ("APP", [(s["service"], {"records": s.get("records"),
                                       "svc_confidence": s.get("confidence")})
                       for s in e.get("services", [])], "service"),
              ("TOWER", [(t["tower_id"], {"city": t.get("city"), "state": t.get("state"),
                                          "records": t.get("records")})
                         for t in e.get("towers", [])], "tower")]
    _SIDE_PREFIX = {"MSISDN": "phone", "IMSI": "imsi", "IMEI": "imei"}
    for id_type, values, node_type in groups:
        cap = _IDENT_CAPS[id_type]
        for value, meta in values[:cap]:
            conf = expl = None
            side = _SIDE_PREFIX.get(id_type)
            if side:
                l = link_by_side.get(f"{side}:{value}")
                if l:
                    conf, expl = l["confidence"], l["explanation"]
            _add(f"{node_type}:{value}", node_type, value, _IDENT_EDGE[id_type],
                 meta=meta, confidence=conf, explanation=expl,
                 evidence=meta.get("records"))
        if len(values) > cap:
            truncated[node_type] = len(values) - cap

    for c in e.get("cases", [])[:8]:
        _add(f"case:{c}", "case", str(c), "APPEARS_IN_CASE",
             explanation=f"Member identifiers of this entity were observed in case {c}.")

    # Related entities: communication, co-location, suggested merges — from the persisted
    # relationship rows so review status rides along.
    rels = (db.query(EntityRelationship)
            .filter(EntityRelationship.case_scope == scope,
                    EntityRelationship.relationship_type.in_(
                        ["CONTACTED", "CO_LOCATED", "POSSIBLE_ASSOCIATION", "SUGGESTED_MERGE"]),
                    or_(EntityRelationship.source_uid == uid,
                        EntityRelationship.target_uid == uid))
            .order_by(EntityRelationship.evidence_count.desc()).limit(24).all())
    other_uids = {(r.target_uid if r.source_uid == uid else r.source_uid) for r in rels
                  if not (r.target_uid if r.source_uid == uid else r.source_uid).startswith(("case:", "svc:"))}
    labels = {r.entity_uid: (r.label, r.classification, r.confidence) for r in
              db.query(Entity).filter(Entity.case_scope == scope,
                                      Entity.entity_uid.in_([u for u in other_uids
                                                             if u.startswith("ent_")])).all()}
    seen = set()
    rel_count = 0
    for r in rels:
        if rel_count >= 12 or budget <= 0:
            truncated["related"] = len(rels) - rel_count
            break
        other = r.target_uid if r.source_uid == uid else r.source_uid
        if other in seen or other.startswith(("case:", "svc:")):
            continue
        seen.add(other)
        if other.startswith("ext_"):
            node_type, label, meta = "external", other[4:], {}
        else:
            lab = labels.get(other)
            node_type = "entity"
            label = lab[0] if lab else other
            meta = {"classification": lab[1], "confidence": lab[2]} if lab else {}
        if budget > 0:
            nodes.append({"id": other, "type": node_type, "label": label, **meta})
            edges.append({"source": uid, "target": other, "type": r.relationship_type,
                          "confidence": r.confidence, "explanation": r.explanation,
                          "evidence_count": r.evidence_count, "status": r.status,
                          "pair_key": r.pair_key})
            budget -= 1
            rel_count += 1

    return {"center": uid, "nodes": nodes, "edges": edges, "truncated": truncated,
            "node_count": len(nodes)}


# ---------------------------------------------------------------------------
# Cross-case entity intelligence
# ---------------------------------------------------------------------------
def _case_names(db: Session, case_ids) -> dict:
    """case_id (string, as stored on records) -> display name. Case.id is an integer PK but
    case_id columns are stored as strings, so cast both ways rather than assuming format."""
    ids = []
    for c in case_ids:
        try:
            ids.append(int(c))
        except (TypeError, ValueError):
            continue
    if not ids:
        return {}
    rows = db.query(Case.id, Case.name).filter(Case.id.in_(ids)).all()
    return {str(i): name for i, name in rows}


def entity_cross_case(db: Session, limit: int = 100):
    """Entities (global resolution scope) that span more than one case — 'this ENTITY appears
    in another case', with the per-case identifier breakdown that justifies it. This is the
    entity-level upgrade over per-identifier cross-case matching: two different numbers in two
    cases still surface as ONE hit when the same device/SIM binds them."""
    sync_entities(db, case_id=None)
    rows = (db.query(Entity)
            .filter(Entity.case_scope == "")
            .order_by(Entity.record_count.desc()).all())
    all_cases: set = set()
    for row in rows:
        all_cases |= set(json.loads(row.payload or "{}").get("cases") or [])
    case_names = _case_names(db, all_cases)
    hits = []
    for row in rows:
        e = entity_payload(row)
        cases = e.get("cases") or []
        if len(cases) < 2:
            continue
        # Per-case presence of each member identifier — which identifiers put the entity there.
        member_values = ([("MSISDN", p) for p in e.get("phones", [])]
                         + [("IMSI", v) for v in e.get("imsis", [])]
                         + [("IMEI", v) for v in e.get("imeis", [])])
        per_case = {c: [] for c in cases}
        values = [v for _, v in member_values]
        if values:
            for model, cols in ((CDRRecord, (CDRRecord.msisdn, CDRRecord.a_party_number,
                                             CDRRecord.imsi, CDRRecord.imei)),
                                (IPDRRecord, (IPDRRecord.msisdn, IPDRRecord.imsi, IPDRRecord.imei))):
                for col in cols:
                    for val, cid in (db.query(col, model.case_id)
                                     .filter(col.in_(values), model.case_id.isnot(None))
                                     .distinct().all()):
                        if cid in per_case and val is not None:
                            t = next((t for t, v in member_values if v == val), None)
                            entry = {"type": t, "value": val}
                            if entry not in per_case[cid]:
                                per_case[cid].append(entry)
        finding = _cross_case_finding(e, per_case)
        hits.append({"id": row.entity_uid, "label": row.label,
                     "entity_type": row.classification,
                     "entity_type_label": e.get("entity_type_label"),
                     "confidence": row.confidence,
                     "reviewed_status": row.reviewed_status,
                     "record_count": row.record_count,
                     "flags": e.get("flags", []), "cases": cases,
                     "case_names": {c: case_names.get(c, f"Case {c}") for c in cases},
                     "per_case": per_case, "finding": finding})
        if len(hits) >= limit:
            break
    return {"hits": hits, "total": len(hits)}


def _cross_case_finding(e: dict, per_case: dict) -> str:
    """Deterministic one-line finding for a cross-case entity hit — states what physically
    links the cases, never who is guilty of what."""
    cases = list(per_case)
    shared_imeis = [v for v in e.get("imeis", [])
                    if sum(1 for c in cases if any(x["value"] == v for x in per_case[c])) > 1]
    shared_imsis = [v for v in e.get("imsis", [])
                    if sum(1 for c in cases if any(x["value"] == v for x in per_case[c])) > 1]
    shared_phones = [v for v in e.get("phones", [])
                     if sum(1 for c in cases if any(x["value"] == v for x in per_case[c])) > 1]
    n = len(cases)
    if shared_imeis:
        return (f"The same handset (IMEI {shared_imeis[0]}) appears in {n} cases — likely the "
                "same physical device/operator, even where the numbers differ.")
    if shared_imsis:
        return (f"The same SIM (IMSI {shared_imsis[0]}) appears in {n} cases — the same "
                "subscription is active across them.")
    if shared_phones:
        return f"The same number ({shared_phones[0]}) appears directly in {n} cases."
    return (f"Identifiers bound to this entity within single cases place it in {n} cases; "
            "no single identifier spans them — verify the binding evidence before relying on this.")
