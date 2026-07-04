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


def pair_key(a, b):
    """Stable, order-independent key for an identifier pair — the handle investigator merge
    decisions hang on ('type:value|type:value', sides sorted)."""
    return "|".join(sorted(f"{t}:{v}" for t, v in (a, b)))


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


def _adaptive_hub_fanout(type_partners, floor=8, ceil=150, default=12, min_sample=20):
    """The dataset defines what 'abnormal fan-out' means, instead of a fixed cap.

    A fixed threshold mis-serves both extremes: in a rural case one device carrying 12 SIMs is
    highly unusual and should be questioned, while in a SIM-box/fraud case 40 SIMs per device is
    normal and shouldn't be torn apart. So we learn the threshold from the distribution of
    per-identifier fan-out in THIS case using a Tukey far-outlier fence (Q3 + 3·IQR): anything
    beyond the case's own upper fence is anomalous FOR THIS CASE. A blank/placeholder identifier
    (fanning out to hundreds) sits far past the fence in any case and is still caught; a SIM-box's
    own normal reuse level moves the fence up so its devices are kept as one cluster, not shredded.
    A percentile was rejected — on a small bimodal sample it just returns the outlier itself; the
    IQR fence is derived from the bulk of the distribution and is unmoved by the extreme tail.
    Clamped to a [floor, ceil] band (floor protects legit multi-SIM people in a quiet case; ceil
    stops a degenerate sample producing an absurd threshold), with a fixed default when there's
    too little data to learn from. Returns the chosen threshold — surfaced in the API so the
    number is never a black box."""
    fanouts = []
    for parts in type_partners.values():
        m = max((len(v) for v in parts.values()), default=0)
        if m >= 2:
            fanouts.append(m)
    if len(fanouts) < min_sample:
        return default
    fanouts.sort()
    n = len(fanouts)

    def _q(p):
        return fanouts[min(n - 1, int(round(p * (n - 1))))]

    q1, q3 = _q(0.25), _q(0.75)
    fence = q3 + 3 * (q3 - q1)
    return max(floor, min(ceil, fence))


_LINK_NOUN = {"phone": "phone number", "imsi": "SIM", "imei": "device (IMEI)"}


def _fmt_day(dt):
    return dt.strftime("%d %b %Y") if dt else None


def _explain_link(a_type, b_type, count, window, fanout, confidence):
    """Plain-language, fully deterministic 'why linked' explanation — no model, just the facts
    the merge rests on, phrased for an investigator or a court. E.g.:
      "This phone number and SIM appeared together in 9,003 telecom records between
       01 Jun 2026 and 30 Jun 2026. Across the case these two identifiers were only ever
       observed with each other — a strong identity relationship." """
    a_noun = _LINK_NOUN.get(a_type, a_type)
    b_noun = _LINK_NOUN.get(b_type, b_type)
    rec_word = "record" if count == 1 else "records"
    when = ""
    if window:
        f, l = _fmt_day(window[0]), _fmt_day(window[1])
        if f and l:
            when = f" on {f}" if f == l else f" between {f} and {l}"
    s1 = f"This {a_noun} and {b_noun} appeared together in {count:,} telecom {rec_word}{when}."
    # Second sentence: how exclusive the pairing is, tied to the confidence tier.
    if fanout <= 1:
        strength = {"HIGH": "a strong identity relationship",
                    "MEDIUM": "a probable link",
                    "LOW": "a weak link — too few records to be certain"}.get(confidence, "a link")
        s2 = f"Across the case these two identifiers were only ever observed with each other — {strength}."
    elif fanout <= 6:
        others = fanout - 1
        s2 = (f"They were seen together repeatedly, though the identifiers also appear with "
              f"{others} other{'s' if others != 1 else ''} — "
              + ("a probable link an investigator should confirm." if confidence != "LOW"
                 else "a weak link, treat with caution."))
    else:
        s2 = (f"One of these identifiers is shared across {fanout} different identifiers, so it is "
              "weak as identity evidence and is kept as an observation, not a merge.")
    return s1 + " " + s2


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


def build_entities(cdr_records, ipdr_records, rejected_pairs=frozenset(), forced_pairs=frozenset()):
    """Resolve records into entities. Returns a list of entity dicts, each carrying its
    member identifiers, observed IPs/towers/cases, activity window, per-pair binding
    evidence, flags, and inter-entity communication edges.

    `rejected_pairs` / `forced_pairs` are investigator merge decisions (pair_key strings):
    a rejected pair is NEVER unioned (and its co-occurrence is dropped as binding evidence);
    a forced (confirmed) pair is unioned even through the hub guard — the investigator has
    judged the shared identifier genuine for these two. Decisions always outrank heuristics."""
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
    # for any single type exceeds the threshold are treated as non-identifying: we don't merge
    # THROUGH them (their own records still stand alone). Court-explainable and conservative —
    # it only ever prevents merges, never invents one.
    type_partners = defaultdict(lambda: defaultdict(set))  # ident -> {type -> {partner values}}
    for (ia, ib) in pair_evidence:
        type_partners[ia][ib[0]].add(ib[1])
        type_partners[ib][ia[0]].add(ia[1])

    hub_fanout = _adaptive_hub_fanout(type_partners)

    def _is_hub(ident):
        return any(len(vals) > hub_fanout for vals in type_partners[ident].values())

    hubs = {ident for ident in type_partners if _is_hub(ident)}

    def _pair_allowed(ia, ib):
        """Whether this co-occurrence pair may act as a merge/evidence link, decisions applied."""
        key = pair_key(ia, ib)
        if key in rejected_pairs:
            return False
        if key in forced_pairs:
            return True
        return ia not in hubs and ib not in hubs

    for (ia, ib) in pair_evidence:
        if _pair_allowed(ia, ib):
            uf.union(ia, ib)

    # Group identifiers into entities.
    groups = defaultdict(list)
    for ident in list(uf.parent):
        groups[uf.find(ident)].append(ident)

    # Bucket the binding pairs by entity root ONCE. The per-entity link list used to rescan the
    # whole global pair table for every entity — O(entities × pairs), which on a large multi-case
    # dataset (esp. with a dense SIM-box mesh producing tens of thousands of pairs) ran for
    # minutes and timed the request out. Now each entity reads only its own pairs: O(pairs) total.
    pairs_by_root = defaultdict(list)
    for (ia, ib), count in pair_evidence.items():
        if not _pair_allowed(ia, ib):
            continue  # blocked by the hub guard or a rejected decision — not binding evidence
        ra = uf.find(ia)
        if ra == uf.find(ib):
            pairs_by_root[ra].append((ia, ib, count))

    entities = []
    phone_to_entity = {}
    ident_to_entity = {}
    for root, members in groups.items():
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
        max_internal_fanout = 0
        for (ia, ib, count) in pairs_by_root.get(root, ()):
                fanout = max(
                    max((len(v) for v in type_partners[ia].values()), default=1),
                    max((len(v) for v in type_partners[ib].values()), default=1),
                )
                max_internal_fanout = max(max_internal_fanout, fanout)
                win = pair_window.get(tuple(sorted((ia, ib))))
                conf = _link_confidence(count, fanout)
                explanation = _explain_link(ia[0], ib[0], count, win, fanout, conf)
                reviewed = pair_key(ia, ib) in forced_pairs
                if reviewed:
                    explanation += " An investigator reviewed and confirmed this merge."
                links.append({
                    "a": f"{ia[0]}:{ia[1]}", "b": f"{ib[0]}:{ib[1]}",
                    "type": _link_type(ia[0], ib[0]),
                    "records": count,
                    "first_seen": win[0].isoformat() if win else None,
                    "last_seen": win[1].isoformat() if win else None,
                    "fanout": fanout,
                    "confidence": conf,
                    "reviewed": reviewed,
                    "pair_key": pair_key(ia, ib),
                    "explanation": explanation,
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
        for ident in members:
            ident_to_entity[ident] = eid

    entities.sort(key=lambda e: -e["record_count"])

    # Suggested merges: co-occurrence pairs the hub guard BLOCKED whose endpoints landed in
    # different entities. ARGUS never merges these on its own — the shared identifier may be a
    # placeholder — but an investigator with context can confirm (forcing the union on the next
    # build) or reject (making the separation durable). Each suggestion states exactly why the
    # automatic merge was withheld. Deduped per entity pair, strongest evidence kept.
    best_suggestion = {}
    for (ia, ib), count in pair_evidence.items():
        key = pair_key(ia, ib)
        if key in rejected_pairs or key in forced_pairs:
            continue
        if ia not in hubs and ib not in hubs:
            continue  # was mergeable on its own; not a suggestion
        ea, eb = ident_to_entity.get(ia), ident_to_entity.get(ib)
        if not ea or not eb or ea == eb:
            continue
        fanout = max(
            max((len(v) for v in type_partners[ia].values()), default=1),
            max((len(v) for v in type_partners[ib].values()), default=1),
        )
        hub_side = ia if ia in hubs else ib
        conf = _link_confidence(count, fanout)
        noun = _LINK_NOUN.get(hub_side[0], hub_side[0])
        win = pair_window.get(tuple(sorted((ia, ib))))
        when = ""
        if win:
            f, l = _fmt_day(win[0]), _fmt_day(win[1])
            if f and l:
                when = f" on {f}" if f == l else f" between {f} and {l}"
        reason = (f"{ia[0]}:{ia[1]} and {ib[0]}:{ib[1]} appeared together in {count:,} "
                  f"record{'s' if count != 1 else ''}{when}, but the {noun} {hub_side[1]} is linked to "
                  f"{max(len(v) for v in type_partners[hub_side].values())} distinct identifiers in this "
                  "dataset — consistent with a shared or placeholder value — so ARGUS did not merge "
                  "automatically. Confirm only if independent evidence ties these two together.")
        ent_pair = tuple(sorted((ea, eb)))
        cur = best_suggestion.get(ent_pair)
        if cur is None or count > cur["records"]:
            best_suggestion[ent_pair] = {
                "a_entity": ea, "b_entity": eb,
                "a": f"{ia[0]}:{ia[1]}", "b": f"{ib[0]}:{ib[1]}",
                "pair_key": key, "records": count, "fanout": fanout,
                "confidence": conf, "reason": reason,
            }
    suggestions = sorted(best_suggestion.values(), key=lambda s: -s["records"])[:100]

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

    return {"entities": entities, "edges": edges, "suggestions": suggestions,
            "meta": {"hub_fanout_threshold": hub_fanout,
                     "entity_count": len(entities),
                     "suggestion_count": len(suggestions),
                     "cluster_count": sum(1 for e in entities if e["entity_type"] == "identity_cluster")}}


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
