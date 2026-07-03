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


def build_entities(cdr_records, ipdr_records):
    """Resolve records into entities. Returns a list of entity dicts, each carrying its
    member identifiers, observed IPs/towers/cases, activity window, per-pair binding
    evidence, flags, and inter-entity communication edges."""
    uf = _UnionFind()
    pair_evidence = Counter()      # (identA, identB) -> co-occurrence record count
    ident_records = defaultdict(int)
    ident_cases = defaultdict(set)
    ident_window = {}              # ident -> [first, last]
    phone_ips = defaultdict(Counter)     # phone -> {ip: count} (attributes, not keys)
    phone_towers = defaultdict(Counter)  # ident -> {tower: count}
    calls = Counter()              # (a_phone, b_phone) -> count (entity edges later)

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
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                if ids[i] != ids[j]:
                    uf.union(ids[i], ids[j])
                    pair_evidence[tuple(sorted((ids[i], ids[j])))] += 1
        b = getattr(record, "b_party_number", None)
        a = getattr(record, "a_party_number", None) or getattr(record, "msisdn", None)
        if a and b and a != b:
            calls[(a, b)] += 1

    for record in ipdr_records:
        ids = _idents(record)
        for ident in ids:
            observe(ident, record)
            uf.find(ident)
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                if ids[i] != ids[j]:
                    uf.union(ids[i], ids[j])
                    pair_evidence[tuple(sorted((ids[i], ids[j])))] += 1
        src = getattr(record, "source_ip", None)
        owner = getattr(record, "msisdn", None)
        if src and owner:
            phone_ips[("phone", owner)][src] += 1

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
        # Binding evidence within this entity (which pair, how many witnessing records).
        links = []
        member_set = set(members)
        for (ia, ib), count in pair_evidence.items():
            if ia in member_set and ib in member_set:
                links.append({"a": f"{ia[0]}:{ia[1]}", "b": f"{ib[0]}:{ib[1]}", "records": count})
        links.sort(key=lambda l: -l["records"])
        flags = []
        if len(imsis) > 1 and imeis:
            flags.append("sim_swap")       # one device carried more than one SIM
        if len(imeis) > 1 and imsis:
            flags.append("device_change")  # one SIM moved between devices
        if len(phones) > 1:
            flags.append("multiple_numbers")
        if len(cases) > 1:
            flags.append("multi_case")
        ip_list = [{"ip": ip, "records": cnt,
                    "kind": _ip_kind(ip) or "public"} for ip, cnt in ips.most_common(20)]
        entities.append({
            "id": eid,
            "label": phones[0] if phones else (imsis[0] if imsis else (imeis[0] if imeis else "?")),
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
