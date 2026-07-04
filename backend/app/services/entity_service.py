"""Entity resolution — from identifiers to PEOPLE.

ARGUS's analytics historically treat each identifier (phone number, IMSI, IMEI, IP) as its
own subject. This layer resolves them into ENTITIES — the probable person behind the
identifiers — so the investigation can reason about "this person switched SIMs and phones
twice and shows up in three cases", not four unrelated identifier strings:

    PERSON
      + phone numbers (MSISDN)
      + SIMs (IMSI)
      + devices (IMEI)
      + IP addresses (observed endpoints)
      + apps / services
      + locations (towers)
      + cases

Resolution rules (v1 — deliberately simple and court-explainable):
  * MERGE KEYS: msisdn / IMSI / IMEI. Identifiers co-occurring on the SAME RECORD are
    bound (that row physically witnessed the SIM in that device answering that number);
    binding is transitive via union-find. Transitivity is the point, not a hazard: the
    same IMEI carrying a new IMSI is a SIM swap, the same IMSI moving to a new IMEI is a
    device change — both stay ONE entity and are surfaced as flags with the per-pair
    record counts as evidence, so the investigator can judge (a sold handset looks like
    one weak IMEI link bridging two otherwise-dense clusters).
  * IPs are ATTRIBUTES, NEVER merge keys. Carrier/CGNAT addresses are shared and
    reassigned across unrelated subscribers; merging on them would fuse strangers.
  * Counterpart (b-party) numbers are NOT entity members — they become communication
    edges between entities (or to outside numbers).

Everything is derived from the records on demand — no stored entity table to drift out of
sync; determinism comes from the data (entity id = stable hash of the sorted member set).
"""
from __future__ import annotations

import hashlib
from collections import Counter, defaultdict

from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord
from app.models.tower import Tower
from app.services.service_attribution_service import _ip_kind


class _UnionFind:
    def __init__(self):
        self.parent = {}

    def find(self, x):
        self.parent.setdefault(x, x)
        root = x
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[x] != root:  # path compression
            self.parent[x], x = root, self.parent[x]
        return root

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


def _idents(record):
    """The merge-key identifiers present on one record, namespaced by type."""
    out = []
    if getattr(record, "msisdn", None):
        out.append(("phone", record.msisdn))
    if getattr(record, "imsi", None):
        out.append(("imsi", record.imsi))
    if getattr(record, "imei", None):
        out.append(("imei", record.imei))
    # CDR a-party is the subject's own number even when msisdn is blank.
    a_party = getattr(record, "a_party_number", None)
    if a_party:
        out.append(("phone", a_party))
    return out


_LINK_TYPE = {
    frozenset(("phone", "imsi")): "Number ↔ SIM",
    frozenset(("phone", "imei")): "Number ↔ Device",
    frozenset(("imsi", "imei")): "SIM ↔ Device",
}


def _link_type(a_type, b_type):
    return _LINK_TYPE.get(frozenset((a_type, b_type)), "Identifier link")


def _link_confidence(records, fanout):
    """Confidence a binding is genuine identity evidence, not coincidence.
    records = witnessing co-occurrence rows; fanout = the larger distinct-partner count of the
    two endpoints (a link through a widely-shared identifier is weak as identity even if the
    two were seen together often). HIGH needs repeated co-occurrence AND a tight identifier;
    a shared-ish identifier caps the link at MEDIUM/LOW however many records back it."""
    if fanout > 6:
        return "LOW"
    if records >= 10 and fanout <= 2:
        return "HIGH"
    if records >= 3 and fanout <= 4:
        return "MEDIUM"
    if records >= 25:
        return "MEDIUM"
    return "LOW"


def _entity_classification(phones, imsis, imeis, max_internal_fanout):
    """What KIND of thing this cluster is — never assume 'person'. Large membership or an
    internally high-reuse identifier means a device farm / shared handset / organisation /
    unknown cluster, not an individual. Returns (type_key, human_label)."""
    total = len(phones) + len(imsis) + len(imeis)
    if len(phones) >= 8 or len(imeis) >= 8 or len(imsis) >= 12 or max_internal_fanout >= 6:
        return "identity_cluster", "Linked identity cluster"
    if total <= 1:
        return "identifier", "Single identifier"
    if len(phones) <= 1 and len(imeis) <= 3 and len(imsis) <= 4:
        return "individual", "Individual (probable)"
    return "linked_identity", "Linked identity"


def build_entities(cdr_records, ipdr_records):
    """Resolve records into entities. Returns a list of entity dicts, each carrying its
    member identifiers, observed IPs/towers/cases, activity window, per-pair binding
    evidence, flags, and inter-entity communication edges."""
    uf = _UnionFind()
    pair_evidence = Counter()      # (identA, identB) -> co-occurrence record count
    pair_window = {}               # (identA, identB) -> [first, last] co-occurrence times
    ident_records = defaultdict(int)
    ident_cases = defaultdict(set)
    ident_window = {}              # ident -> [first, last]
    phone_ips = defaultdict(Counter)     # phone -> {ip: count} (attributes, not keys)
    phone_towers = defaultdict(Counter)  # ident -> {tower: count}
    calls = Counter()              # (a_phone, b_phone) -> count (entity edges later)

    def _record_pair(a, b, ts):
        key = tuple(sorted((a, b)))
        pair_evidence[key] += 1
        if ts:
            w = pair_window.get(key)
            if w is None:
                pair_window[key] = [ts, ts]
            else:
                if ts < w[0]:
                    w[0] = ts
                if ts > w[1]:
                    w[1] = ts

    def observe(ident, record):
        ident_records[ident] += 1
        if getattr(record, "case_id", None):
            ident_cases[ident].add(record.case_id)
        ts = getattr(record, "start_time", None)
        if ts:
            w = ident_window.get(ident)
            if w is None:
                ident_window[ident] = [ts, ts]
            else:
                if ts < w[0]:
                    w[0] = ts
                if ts > w[1]:
                    w[1] = ts
        tower = getattr(record, "tower_id", None)
        if tower:
            phone_towers[ident][tower] += 1

    for record in cdr_records:
        ids = _idents(record)
        for ident in ids:
            observe(ident, record)
            uf.find(ident)  # register even a lone identifier — it's still an entity
        ts = getattr(record, "start_time", None)
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                if ids[i] != ids[j]:
                    _record_pair(ids[i], ids[j], ts)
        b = getattr(record, "b_party_number", None)
        a = getattr(record, "a_party_number", None) or getattr(record, "msisdn", None)
        if a and b and a != b:
            calls[(a, b)] += 1

    for record in ipdr_records:
        ids = _idents(record)
        for ident in ids:
            observe(ident, record)
            uf.find(ident)
        ts = getattr(record, "start_time", None)
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                if ids[i] != ids[j]:
                    _record_pair(ids[i], ids[j], ts)
        src = getattr(record, "source_ip", None)
        owner = getattr(record, "msisdn", None)
        if src and owner:
            phone_ips[("phone", owner)][src] += 1

    # Fan-out guard against over-merging. A real device holds a handful of SIMs and a SIM
    # sits in a handful of devices over its life, so a genuine person's identifiers form a
    # small tight cluster. An identifier that co-occurs with MANY distinct others of a given
    # type is not a person — it's a placeholder/invalid value (blank/"0"/all-same-digit IMEI),
    # a test SIM, or a shared device-farm handset. Union-find is transitive, so unioning
    # through one such hub would fuse hundreds of unrelated subscribers into a single blob
    # (observed: one bad IMEI merging 320 phones). Identifiers whose distinct-partner count
    # for any single type exceeds this cap are treated as non-identifying: we don't merge
    # THROUGH them (their own records still stand alone). Court-explainable and conservative —
    # it only ever prevents merges, never invents one.
    HUB_FANOUT = 12
    type_partners = defaultdict(lambda: defaultdict(set))  # ident -> {type -> {partner values}}
    for (ia, ib) in pair_evidence:
        type_partners[ia][ib[0]].add(ib[1])
        type_partners[ib][ia[0]].add(ia[1])

    def _is_hub(ident):
        return any(len(vals) > HUB_FANOUT for vals in type_partners[ident].values())

    hubs = {ident for ident in type_partners if _is_hub(ident)}
    for (ia, ib) in pair_evidence:
        if ia not in hubs and ib not in hubs:
            uf.union(ia, ib)

    # Group identifiers into entities.
    groups = defaultdict(list)
    for ident in list(uf.parent):
        groups[uf.find(ident)].append(ident)

    entities = []
    phone_to_entity = {}
    for members in groups.values():
        members.sort()
        phones = sorted(v for t, v in members if t == "phone")
        imsis = sorted(v for t, v in members if t == "imsi")
        imeis = sorted(v for t, v in members if t == "imei")
        eid = "ent_" + hashlib.sha1("|".join(f"{t}:{v}" for t, v in members).encode()).hexdigest()[:12]
        ips = Counter()
        towers = Counter()
        cases = set()
        records = 0
        first = last = None
        for ident in members:
            records += ident_records[ident]
            cases |= ident_cases[ident]
            towers.update(phone_towers.get(ident, {}))
            ips.update(phone_ips.get(ident, {}))
            w = ident_window.get(ident)
            if w:
                first = w[0] if first is None or w[0] < first else first
                last = w[1] if last is None or w[1] > last else last
        # Binding evidence within this entity: each identifier pair carries WHY we believe the
        # link — type, witnessing record count, the co-occurrence time window, the endpoints'
        # fan-out, and a confidence tier — so every merge is auditable, not asserted.
        links = []
        member_set = set(members)
        max_internal_fanout = 0
        for (ia, ib), count in pair_evidence.items():
            if ia in member_set and ib in member_set:
                fanout = max(
                    max((len(v) for v in type_partners[ia].values()), default=1),
                    max((len(v) for v in type_partners[ib].values()), default=1),
                )
                max_internal_fanout = max(max_internal_fanout, fanout)
                win = pair_window.get(tuple(sorted((ia, ib))))
                links.append({
                    "a": f"{ia[0]}:{ia[1]}", "b": f"{ib[0]}:{ib[1]}",
                    "type": _link_type(ia[0], ib[0]),
                    "records": count,
                    "first_seen": win[0].isoformat() if win else None,
                    "last_seen": win[1].isoformat() if win else None,
                    "fanout": fanout,
                    "confidence": _link_confidence(count, fanout),
                })
        links.sort(key=lambda l: (-{"HIGH": 3, "MEDIUM": 2, "LOW": 1}[l["confidence"]], -l["records"]))
        flags = []
        if len(imsis) > 1 and imeis:
            flags.append("sim_swap")       # one device carried more than one SIM
        if len(imeis) > 1 and imsis:
            flags.append("device_change")  # one SIM moved between devices
        if len(phones) > 1:
            flags.append("multiple_numbers")
        if len(cases) > 1:
            flags.append("multi_case")
        if max_internal_fanout >= 6:
            flags.append("device_reuse")   # an identifier shared widely inside the cluster
        type_key, type_label = _entity_classification(phones, imsis, imeis, max_internal_fanout)
        ip_list = [{"ip": ip, "records": cnt,
                    "kind": _ip_kind(ip) or "public"} for ip, cnt in ips.most_common(20)]
        entities.append({
            "id": eid,
            "label": phones[0] if phones else (imsis[0] if imsis else (imeis[0] if imeis else "?")),
            "entity_type": type_key,
            "entity_type_label": type_label,
            "phones": phones, "imsis": imsis, "imeis": imeis,
            "ips": ip_list,
            "towers": [{"tower_id": t, "records": c} for t, c in towers.most_common(10)],
            "cases": sorted(cases),
            "record_count": records,
            "first_seen": first.isoformat() if first else None,
            "last_seen": last.isoformat() if last else None,
            "links": links[:30],
            "flags": flags,
        })
        for p in phones:
            phone_to_entity[p] = eid

    entities.sort(key=lambda e: -e["record_count"])

    # Inter-entity communication edges (calls between phones of resolved entities;
    # counterparts that resolve to no entity stay as 'external' endpoints).
    edge_counter = Counter()
    for (a, b), count in calls.items():
        ea = phone_to_entity.get(a)
        eb = phone_to_entity.get(b, "ext_" + b)
        if ea is None:
            continue
        if ea == eb:
            continue
        key = tuple(sorted((ea, eb)))
        edge_counter[key] += count
    edges = [{"a": a, "b": b, "calls": c} for (a, b), c in edge_counter.most_common()]

    return {"entities": entities, "edges": edges}


def resolve_entities(db, case_id=None):
    cdr_q = db.query(CDRRecord)
    ipdr_q = db.query(IPDRRecord)
    if case_id:
        cdr_q = cdr_q.filter(CDRRecord.case_id == case_id)
        ipdr_q = ipdr_q.filter(IPDRRecord.case_id == case_id)
    result = build_entities(cdr_q.all(), ipdr_q.all())
    # Resolve tower ids to places for the top towers (one query, small set).
    tower_ids = {t["tower_id"] for e in result["entities"] for t in e["towers"]}
    if tower_ids:
        meta = {t.tower_id: t for t in db.query(Tower).filter(Tower.tower_id.in_(tower_ids)).all()}
        for e in result["entities"]:
            for t in e["towers"]:
                m = meta.get(t["tower_id"])
                if m:
                    t["city"] = m.city
                    t["state"] = m.state
    return result
