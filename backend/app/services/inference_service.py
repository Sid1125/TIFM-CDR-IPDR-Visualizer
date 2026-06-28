"""Spatiotemporal inference engine.

Turns raw CDR/IPDR rows into per-subject **movement-annotated timelines** and derives
investigative inferences on top:

  A. Movement & travel  - leg speed/mode, impossible-travel, home/work anchors, trips
  B. Co-presence        - co-location/convoy, "met but didn't call" hidden links
  C. Behavioral         - activity bursts, odd-hours, periodic contact, going dark
  D. Identity & device  - SIM swap, multi-SIM/burner handset, clone corroboration

Everything operates on plain iterables of records (anything with the documented
attributes — ORM rows or duck-typed objects), so it is unit-testable without a DB.
`*_db` wrappers load from the session for the API layer.

Honest limits: tower coordinates approximate handset location, and start times are
minute-resolution in this dataset, so speeds are area-to-area estimates. Inferences
are graded signals, never proof.
"""
from __future__ import annotations

import statistics
from collections import Counter, defaultdict
from datetime import datetime

import networkx as nx

from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord
from app.models.tower import Tower
from app.services.geo import IMPOSSIBLE_KMH, classify_speed, haversine_km
from app.services.service_attribution_service import _match_ip

# --- Tunables -------------------------------------------------------------------
COLOC_WINDOW_MIN = 20      # two subjects within this many minutes = potentially together
COLOC_RADIUS_KM = 1.5      # ...and within this distance (or the same tower)
CONVOY_MIN_DAYS = 2        # repeated co-location across >= this many days = convoy/associate
MOVE_MIN_KM = 1.0          # ignore sub-km jitter when computing a leg
IMPOSSIBLE_MIN_KM = 5.0    # only flag impossible travel over a real distance
ODD_HOURS = range(1, 5)    # 01:00-04:59 local
ODD_HOUR_MIN_SHARE = 0.20  # flag a subject if this share of activity is in odd hours
BURST_Z = 2.0              # daily activity z-score above which a day is a "burst"
PERIODIC_MIN_CALLS = 4     # need at least this many calls to judge a cadence
PERIODIC_CV_MAX = 0.35     # coefficient of variation of intervals below which it's "regular"
PERIODIC_MIN_SPAN_H = 12   # calls must span at least this long, else it's a burst not a cadence

# Call-graph structure (Phase 2). Expensive measures are bounded so a 50k-row case stays responsive.
NET_BROKER_TOPN = 8
NET_BETWEENNESS_SAMPLE_OVER = 1200  # above this many nodes, sample betweenness (k) to bound O(V*E) cost
NET_PREDICT_MAX_NODES = 3000        # skip link prediction above this many nodes
NET_PREDICT_HUB_DEG = 200           # don't expand candidate links around hubs this large (they predict everything)
NET_PREDICT_TOPN = 10
NET_RELAY_WINDOW_MIN = 15           # A->B then B->C within this TIGHT window = onward relay (a
                                    # wider window catches coincidental, unrelated B->C calls)
NET_RELAY_MAX = 30
NET_RECIPROCITY_MIN = 3             # min calls on the dominant side to report a one-way tie

# Temporal/behavioral (Phase 3). Timestamps are naive and treated as a single (data-local)
# timezone — day/hour bucketing assumes that convention.
BASELINE_MIN_EVENTS = 5            # below this a per-subject baseline is "insufficient history"
ESCALATION_MIN_DAYS = 5           # need this many active days to judge a trend (not one spike)
ESCALATION_MIN_RECENT = 3         # recent-window mean must clear this absolute floor
ESCALATION_FACTOR = 2.0           # ...and be >= this multiple of the earlier baseline
DORMANCY_MIN_GAP_DAYS = 14        # silence >= this then renewed activity = reactivation
FIRST_CONTACT_TOPN = 12

# IPDR analytics (Phase 4). Subject = source IP. bytes_* are nullable, so coverage is reported.
MB = 1024 * 1024
EXFIL_MIN_UP_MB = 50              # only sizable uploads are exfiltration candidates
EXFIL_UP_DOWN_RATIO = 3.0        # upload >= ratio * download = asymmetric (exfil-shaped)
BEACON_MIN_SESSIONS = 4
BEACON_CV_MAX = 0.25             # inter-session gap CV below this = regular/automated cadence
BEACON_MIN_SPAN_H = 6            # ...over at least this long (else it's a burst, not a beacon)
DEST_RARE_MAX_SOURCES = 2        # a destination reached from <= this many sources is "rare"...
DEST_RARE_MIN_SESSIONS = 3       # ...AND reached repeatedly by the subject (one-off browsing to a
                                 # unique endpoint is normal in sparse data — this avoids that FP)
IPDR_TOPN = 15

# Geospatial (Phase 5). Tower coordinates approximate the handset; towers with no coords are
# skipped. Location precision is the tower point (no azimuth/range), so these are estimates.
DWELL_TOPN = 6
DWELL_MAX_GAP_H = 24             # ignore gaps longer than this (data holes, not real dwell)
ROUTE_NGRAM = 3                  # length of the tower-sequence shingle
ROUTE_MIN_SHARED = 3            # pairs sharing >= this many ordered tower-triples = shared route
                               # (2 was weak — same-neighbourhood commuters can share one segment)
ROUTE_COMMON_SUBS = 30         # a segment shared by more subjects than this is a common corridor (skip)
ROUTE_MAX_SUBJECTS = 1500       # cap subjects shingled to bound cost

# Tunnel/anonymisation destination ports, shared by going-dark and VPN/proxy detection.
VPN_PORTS = {500, 1194, 1195, 1701, 1723, 4500, 51820, 51821}
PROXY_TOR_PORTS = {1080, 3128, 8118, 9001, 9030, 9050, 9051}


def _to_int(value) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _subject(record) -> str | None:
    return getattr(record, "msisdn", None) or getattr(record, "imsi", None)


# --- Foundation: per-subscriber CDR event stream --------------------------------
# CDR and IPDR are kept STRICTLY SEPARATE. A CDR subject is a phone number (MSISDN);
# an IPDR subject is an IP address. They are not the same entity, so IPDR sessions are
# never folded into a phone subject's stream (that would falsely attribute internet
# behaviour to a person via the operator's MSISDN linking column). CDR-based inferences
# use these streams; IPDR-based inferences (see vpn_proxy_use) work on IPDR alone.

def build_subject_streams(cdr_records, tower_coords: dict | None = None):
    """Per-MSISDN chronological stream of a subscriber's calls/SMS (CDR only).

    tower_coords: optional {tower_id: (lat, lon)} lookup; used to enrich events whose
    CDR row has a tower_id but no direct lat/lon columns populated (which is the common
    case — most operators only store the serving cell-id, not resolved coordinates).
    Without this enrichment, haversine_km returns None and impossible-travel / anchor
    detection silently produces no results."""
    streams: dict[str, list] = defaultdict(list)

    for r in cdr_records:
        subj = _subject(r)
        if not subj:
            continue
        kind = "sms" if str(getattr(r, "call_type", "") or "").upper() == "SMS" else "call"
        lat = getattr(r, "latitude", None)
        lon = getattr(r, "longitude", None)
        tid = getattr(r, "tower_id", None)
        if (lat is None or lon is None) and tid and tower_coords:
            lat, lon = tower_coords.get(tid, (None, None))
        streams[subj].append({
            "time": r.start_time,
            "end": getattr(r, "end_time", None) or r.start_time,
            "kind": kind,
            "peer": getattr(r, "b_party_number", None),
            "direction": getattr(r, "direction", None),
            "tower_id": tid,
            "lat": lat,
            "lon": lon,
            "imsi": getattr(r, "imsi", None),
            "imei": getattr(r, "imei", None),
            "duration": getattr(r, "duration_seconds", None),
        })

    for subj in streams:
        streams[subj].sort(key=lambda e: e["time"] or datetime.min)
        annotate_movement(streams[subj])
    return streams


def annotate_movement(events):
    """Attach a `move` block (distance/dt/speed/mode/impossible) to each event,
    relative to the previous located event in the same stream."""
    prev = None
    for e in events:
        e["move"] = None
        if prev and prev["time"] and e["time"]:
            dist = haversine_km(prev["lat"], prev["lon"], e["lat"], e["lon"])
            dt_min = (e["time"] - prev["time"]).total_seconds() / 60.0
            if dist is not None and dist >= MOVE_MIN_KM and dt_min > 0:
                speed = dist / (dt_min / 60.0)
                e["move"] = {
                    "from_tower": prev["tower_id"],
                    "to_tower": e["tower_id"],
                    "distance_km": round(dist, 2),
                    "dt_minutes": round(dt_min, 1),
                    "speed_kmh": round(speed, 1),
                    "mode": classify_speed(speed),
                    "impossible": bool(speed > IMPOSSIBLE_KMH and dist >= IMPOSSIBLE_MIN_KM),
                }
            elif dist is not None and dist >= IMPOSSIBLE_MIN_KM and dt_min <= 0:
                # Two distant locations sharing one (minute-resolution) timestamp: the
                # implied speed is undefined/infinite and the record is physically
                # impossible — the strongest single clone/spoof signal, which a strict
                # dt>0 guard would silently drop.
                e["move"] = {
                    "from_tower": prev["tower_id"],
                    "to_tower": e["tower_id"],
                    "distance_km": round(dist, 2),
                    "dt_minutes": round(dt_min, 1),
                    "speed_kmh": None,
                    "mode": "impossible",
                    "impossible": True,
                }
        prev = e
    return events


# --- A. Movement & travel --------------------------------------------------------

def infer_anchors(events):
    """Home = dominant tower during night hours (22:00-05:59); work = dominant tower
    during weekday daytime (09:00-17:59). Both with the tower's coordinates."""
    night, day, coords = Counter(), Counter(), {}
    for e in events:
        tid, t = e["tower_id"], e["time"]
        if not tid or not t:
            continue
        coords[tid] = (e["lat"], e["lon"])
        if t.hour >= 22 or t.hour < 6:
            night[tid] += 1
        elif t.weekday() < 5 and 9 <= t.hour < 18:
            day[tid] += 1

    def top(counter):
        if not counter:
            return None
        tid, n = counter.most_common(1)[0]
        return {"tower_id": tid, "events": n, "latitude": coords[tid][0], "longitude": coords[tid][1]}

    return {"home": top(night), "work": top(day)}


def impossible_travel(events):
    """Legs whose implied speed exceeds human possibility — likely clone/spoof."""
    out = []
    prev = None
    for e in events:
        m = e.get("move")
        if m and m["impossible"]:
            out.append({
                "from_time": prev["time"], "to_time": e["time"],
                "from_tower": m["from_tower"], "to_tower": m["to_tower"],
                "distance_km": m["distance_km"], "dt_minutes": m["dt_minutes"],
                "speed_kmh": m["speed_kmh"],
                "from_imei": prev["imei"], "to_imei": e["imei"],
            })
        prev = e
    return out


def subject_movement(events):
    """Per-subject movement profile: anchors, distinct towers (footprint), the set of
    travel modes used, and any impossible-travel legs."""
    located = [e for e in events if e["tower_id"]]
    towers = {e["tower_id"] for e in located}
    legs = [e["move"] for e in events if e.get("move")]
    modes = Counter(l["mode"] for l in legs if l["mode"])
    max_leg = max(legs, key=lambda l: l["distance_km"], default=None)
    return {
        "anchors": infer_anchors(events),
        "distinct_towers": len(towers),
        "total_events": len(events),
        "modes": dict(modes),
        "max_leg_km": max_leg["distance_km"] if max_leg else 0,
        "impossible_travel": impossible_travel(events),
        "dwell": tower_dwell(events),
        "mobility": mobility_class(events),
    }


def tower_dwell(events):
    """Approximate time spent at each cell (attribute each inter-event gap to the tower the
    subject was at when it started). Towers without coordinates still count for dwell but are
    reported with null coords; implausibly long gaps (data holes) are ignored."""
    located = [e for e in events if e.get("tower_id") and e.get("time")]
    if len(located) < 2:
        return []
    dwell: dict[str, float] = defaultdict(float)
    visits: Counter = Counter()
    coords: dict[str, tuple] = {}
    for i in range(len(located) - 1):
        e, nxt = located[i], located[i + 1]
        gap = (nxt["time"] - e["time"]).total_seconds() / 3600.0
        if 0 < gap <= DWELL_MAX_GAP_H:
            dwell[e["tower_id"]] += gap
        visits[e["tower_id"]] += 1
        if e.get("lat") is not None:
            coords[e["tower_id"]] = (e["lat"], e["lon"])
    visits[located[-1]["tower_id"]] += 1
    rows = [{"tower_id": t, "dwell_hours": round(h, 1), "visits": visits[t],
             "latitude": coords.get(t, (None, None))[0], "longitude": coords.get(t, (None, None))[1]}
            for t, h in dwell.items()]
    return sorted(rows, key=lambda x: -x["dwell_hours"])[:DWELL_TOPN]


def mobility_class(events):
    """Stationary vs mobile classification from the movement footprint (tower count + legs)."""
    towers = {e["tower_id"] for e in events if e.get("tower_id")}
    legs = [e["move"] for e in events if e.get("move")]
    total_km = round(sum(l["distance_km"] for l in legs), 1)
    max_km = max((l["distance_km"] for l in legs), default=0)
    if len(towers) <= 1:
        cls = "stationary"
    elif len(towers) <= 3 and max_km < 25:
        cls = "local"
    elif max_km >= 100 or len(towers) >= 8:
        cls = "highly mobile"
    else:
        cls = "mobile"
    return {"class": cls, "distinct_towers": len(towers), "total_km": total_km, "max_leg_km": max_km}


def shared_routes(streams):
    """Pairs of subjects who repeatedly traverse the SAME ordered tower sequence — the path
    analogue of point co-presence. Tower-sequence shingles keep it near-linear; very common
    corridors (shared by many subjects) are dropped as non-distinctive."""
    items = list(streams.items())[:ROUTE_MAX_SUBJECTS]
    ngram_subs: dict[tuple, set] = defaultdict(set)
    for subj, events in items:
        seq = []
        for e in events:
            t = e.get("tower_id")
            if t and (not seq or seq[-1] != t):  # dedup consecutive — ignore same-tower jitter
                seq.append(t)
        for i in range(len(seq) - ROUTE_NGRAM + 1):
            ngram_subs[tuple(seq[i:i + ROUTE_NGRAM])].add(subj)
    pair_shared: dict[tuple, set] = defaultdict(set)
    for ng, subs in ngram_subs.items():
        if len(subs) < 2 or len(subs) > ROUTE_COMMON_SUBS:
            continue
        ordered = sorted(subs)
        for i in range(len(ordered)):
            for j in range(i + 1, len(ordered)):
                pair_shared[(ordered[i], ordered[j])].add(ng)
    out = [{"subject_a": a, "subject_b": b, "shared_segments": len(ngs)}
           for (a, b), ngs in pair_shared.items() if len(ngs) >= ROUTE_MIN_SHARED]
    return sorted(out, key=lambda x: -x["shared_segments"])[:15]


# --- B. Co-presence & network ----------------------------------------------------

def co_presence(streams, call_pairs=None):
    """Find pairs of subjects co-located (same tower or within COLOC_RADIUS_KM) inside
    COLOC_WINDOW_MIN. Aggregate per pair; repeated across days = convoy. If a pair never
    calls each other (per `call_pairs`) yet repeatedly co-locates, flag a hidden link."""
    located = []
    for subj, events in streams.items():
        for e in events:
            if e["tower_id"] and e["time"] and e["lat"] is not None:
                located.append((e["time"], subj, e["tower_id"], e["lat"], e["lon"]))
    located.sort(key=lambda x: x[0])

    pairs = defaultdict(lambda: {"count": 0, "days": set(), "towers": set()})
    n = len(located)
    for i in range(n):
        ti, si, twi, lai, loi = located[i]
        for j in range(i + 1, n):
            tj, sj, twj, laj, loj = located[j]
            if (tj - ti).total_seconds() > COLOC_WINDOW_MIN * 60:
                break
            if si == sj:
                continue
            same = twi == twj
            near = same or (haversine_km(lai, loi, laj, loj) or 9e9) <= COLOC_RADIUS_KM
            if not near:
                continue
            key = tuple(sorted((si, sj)))
            rec = pairs[key]
            rec["count"] += 1
            rec["days"].add(ti.date())
            rec["towers"].add(twi if same else f"{twi}~{twj}")

    call_pairs = call_pairs or set()
    out = []
    for (a, b), rec in pairs.items():
        days = len(rec["days"])
        out.append({
            "subject_a": a, "subject_b": b,
            "occurrences": rec["count"], "distinct_days": days,
            "towers": sorted(rec["towers"])[:8],
            "convoy": days >= CONVOY_MIN_DAYS,
            "ever_called": tuple(sorted((a, b))) in call_pairs,
            "hidden_link": days >= CONVOY_MIN_DAYS and tuple(sorted((a, b))) not in call_pairs,
        })
    return sorted(out, key=lambda x: (x["convoy"], x["occurrences"]), reverse=True)


# --- B2. Call-graph structure ----------------------------------------------------

def network_structure(cdr_records):
    """Structural roles in the CDR call graph (phone-number nodes only):
      - brokers           : high-betweenness connectors between otherwise separate groups
      - articulation pts  : cut-vertices whose removal splits the network
      - reciprocity       : strongly one-way ties (caller never called back)
      - relay_chains      : A->B then B->C within a short window (onward forwarding)
      - predicted_links   : likely-missing edges (shared contacts), hubs down-weighted

    Numbers are used as-is (consistent with the rest of the engine) so broker subjects line
    up with the risk leaderboard's keys. Self-calls (a==b) and missing parties are skipped.
    """
    directed: Counter = Counter()
    undirected_w: Counter = Counter()
    out_calls: dict[str, list] = defaultdict(list)
    for r in cdr_records:
        a = getattr(r, "a_party_number", None) or _subject(r)
        b = getattr(r, "b_party_number", None)
        if not a or not b or a == b:
            continue
        directed[(a, b)] += 1
        undirected_w[tuple(sorted((a, b)))] += 1
        t = getattr(r, "start_time", None)
        if t:
            out_calls[a].append((t, b))

    graph = nx.Graph()
    for (a, b), w in undirected_w.items():
        graph.add_edge(a, b, weight=w)
    n = graph.number_of_nodes()
    if n == 0:
        return {"nodes": 0, "edges": 0, "brokers": [], "articulation_points": [],
                "reciprocity": [], "relay_chains": [], "predicted_links": [], "notes": []}
    notes = []

    # Brokers — betweenness (sampled on large graphs to bound cost).
    if n > NET_BETWEENNESS_SAMPLE_OVER:
        bc = nx.betweenness_centrality(graph, k=min(500, n), seed=42)
        notes.append(f"betweenness sampled (k=500) over {n} nodes")
    else:
        bc = nx.betweenness_centrality(graph)
    brokers = [{"subject": s, "betweenness": round(v, 4), "degree": graph.degree(s)}
               for s, v in sorted(bc.items(), key=lambda kv: -kv[1])[:NET_BROKER_TOPN] if v > 0]

    # Articulation points (cut-vertices) — linear, safe on any size.
    arts = sorted(nx.articulation_points(graph), key=lambda s: -graph.degree(s))[:NET_BROKER_TOPN]
    articulation = [{"subject": s, "degree": graph.degree(s)} for s in arts]

    # Reciprocity — strongly one-way ties (caller never called back).
    recip, seen = [], set()
    for (a, b), ab in directed.items():
        key = tuple(sorted((a, b)))
        if key in seen:
            continue
        seen.add(key)
        ba = directed.get((b, a), 0)
        if max(ab, ba) >= NET_RECIPROCITY_MIN and min(ab, ba) == 0:
            caller, callee = (a, b) if ab >= ba else (b, a)
            recip.append({"caller": caller, "callee": callee, "calls": max(ab, ba)})
    recip = sorted(recip, key=lambda x: -x["calls"])[:12]

    # Relay chains A->B->C within the window (B forwards onward shortly after hearing from A).
    for c in out_calls:
        out_calls[c].sort(key=lambda x: x[0])
    relay, seen_chain, win = [], set(), NET_RELAY_WINDOW_MIN * 60
    for a in out_calls:
        if len(relay) >= NET_RELAY_MAX:
            break
        for (t1, b) in out_calls[a]:
            for (t2, c) in out_calls.get(b, ()):
                dt = (t2 - t1).total_seconds()
                if dt <= 0:
                    continue
                if dt > win:
                    break  # out_calls[b] is time-sorted, so everything after is also out of window
                if c == a or c == b:
                    continue
                ch = (a, b, c)
                if ch in seen_chain:
                    continue
                seen_chain.add(ch)
                relay.append({"a": a, "b": b, "c": c, "gap_min": round(dt / 60, 1)})
                if len(relay) >= NET_RELAY_MAX:
                    break
            if len(relay) >= NET_RELAY_MAX:
                break

    # Predicted (likely-missing) links — candidate non-edges among pairs sharing a contact.
    predicted = []
    if n <= NET_PREDICT_MAX_NODES and graph.number_of_edges() > 0:
        cand = set()
        for node in graph:
            nbrs = list(graph.neighbors(node))
            if len(nbrs) > NET_PREDICT_HUB_DEG:   # skip hubs — they'd "predict" everything
                continue
            for i in range(len(nbrs)):
                for j in range(i + 1, len(nbrs)):
                    u, v = nbrs[i], nbrs[j]
                    if not graph.has_edge(u, v):
                        cand.add(tuple(sorted((u, v))))
        for u, v, score in nx.adamic_adar_index(graph, cand):
            predicted.append({"subject_a": u, "subject_b": v, "score": round(score, 3),
                              "common_contacts": sum(1 for _ in nx.common_neighbors(graph, u, v))})
        predicted = sorted(predicted, key=lambda x: -x["score"])[:NET_PREDICT_TOPN]
    elif n > NET_PREDICT_MAX_NODES:
        notes.append(f"link prediction skipped — {n} nodes over cap")

    return {"nodes": n, "edges": graph.number_of_edges(), "brokers": brokers,
            "articulation_points": articulation, "reciprocity": recip,
            "relay_chains": relay, "predicted_links": predicted, "notes": notes}


# --- C. Behavioral ---------------------------------------------------------------

def activity_bursts(events):
    """Days whose event count is >= mean + BURST_Z*std for this subject."""
    per_day = Counter(e["time"].date() for e in events if e["time"])
    if len(per_day) < 3:
        return []
    counts = list(per_day.values())
    mean = statistics.mean(counts)
    std = statistics.pstdev(counts) or 1.0
    out = [{"date": str(d), "events": c, "z": round((c - mean) / std, 2)}
           for d, c in per_day.items() if (c - mean) / std >= BURST_Z]
    return sorted(out, key=lambda x: x["z"], reverse=True)


def odd_hours_profile(events):
    """Share of a subject's activity in the dead-of-night window."""
    timed = [e for e in events if e["time"]]
    if not timed:
        return None
    odd = sum(1 for e in timed if e["time"].hour in ODD_HOURS)
    share = odd / len(timed)
    return {"odd_events": odd, "total": len(timed), "share": round(share, 3),
            "flag": share >= ODD_HOUR_MIN_SHARE and odd >= 3}


def periodic_contacts(cdr_records):
    """Subject->peer pairs called on a regular cadence (low variation in the gaps)."""
    pair_times = defaultdict(list)
    for r in cdr_records:
        a, b, t = _subject(r), getattr(r, "b_party_number", None), r.start_time
        if a and b and t:
            pair_times[(a, b)].append(t)
    out = []
    for (a, b), times in pair_times.items():
        if len(times) < PERIODIC_MIN_CALLS:
            continue
        times.sort()
        # A handful of calls inside a short window has low gap-variance too, but it's a
        # burst, not a recurring cadence — require the calls to span a real period.
        if (times[-1] - times[0]).total_seconds() / 3600.0 < PERIODIC_MIN_SPAN_H:
            continue
        gaps = [(times[i + 1] - times[i]).total_seconds() / 3600.0 for i in range(len(times) - 1)]
        mean = statistics.mean(gaps)
        if mean <= 0:
            continue
        cv = statistics.pstdev(gaps) / mean
        if cv <= PERIODIC_CV_MAX:
            out.append({"subject": a, "peer": b, "calls": len(times),
                        "mean_gap_hours": round(mean, 1), "regularity_cv": round(cv, 2)})
    return sorted(out, key=lambda x: x["regularity_cv"])


# --- C2. Temporal / behavioral (Phase 3) -----------------------------------------

def subject_baseline(events):
    """Per-subject daily-volume baseline, or None when history is too thin to judge.
    Lets later flags be expressed relative to a subject's own normal rather than a fixed
    threshold."""
    days = Counter(e["time"].date() for e in events if e["time"])
    if sum(days.values()) < BASELINE_MIN_EVENTS or len(days) < 2:
        return None
    counts = list(days.values())
    span = (max(days) - min(days)).days + 1
    return {"active_days": len(days), "span_days": span,
            "daily_mean": round(statistics.mean(counts), 2),
            "daily_std": round(statistics.pstdev(counts), 2),
            "peak_day": str(max(days, key=days.get)), "peak": max(counts)}


def escalation(events):
    """Sustained rise in daily activity: the recent half's mean is well above the earlier
    half (a trend, not a single spike — which `activity_bursts` already covers). None when
    history is too short to establish a trend."""
    per_day = sorted(Counter(e["time"].date() for e in events if e["time"]).items())
    if len(per_day) < ESCALATION_MIN_DAYS:
        return None
    counts = [c for _, c in per_day]
    half = len(counts) // 2
    # Median halves so a single isolated spike (which activity_bursts already catches) can't
    # masquerade as a sustained upward trend.
    base_med = statistics.median(counts[:half]) if counts[:half] else 0.0
    recent_med = statistics.median(counts[half:])
    if base_med <= 0:
        return None
    factor = recent_med / base_med
    if recent_med >= ESCALATION_MIN_RECENT and factor >= ESCALATION_FACTOR:
        return {"baseline": round(base_med, 2), "recent": round(recent_med, 2),
                "factor": round(factor, 2), "from_day": str(per_day[0][0]), "to_day": str(per_day[-1][0])}
    return None


def dormancy_reactivation(events):
    """A long silence followed by renewed activity — possible re-tasking or a burner cycle."""
    times = sorted(e["time"] for e in events if e["time"])
    if len(times) < 4:
        return None
    best = None
    for i in range(1, len(times)):
        gap = (times[i] - times[i - 1]).days
        if gap >= DORMANCY_MIN_GAP_DAYS and (best is None or gap > best["dormant_days"]):
            best = {"dormant_days": gap, "went_quiet": str(times[i - 1].date()),
                    "resumed": str(times[i].date()),
                    "events_after": sum(1 for t in times if t >= times[i])}
    return best


def first_contacts(cdr_records):
    """Earliest-ever interaction per pair; the most RECENT first-contacts are newly forming
    ties (a new number being introduced into the network)."""
    earliest: dict[tuple, datetime] = {}
    for r in cdr_records:
        a, b, t = _subject(r), getattr(r, "b_party_number", None), getattr(r, "start_time", None)
        if not a or not b or a == b or not t:
            continue
        key = tuple(sorted((a, b)))
        if key not in earliest or t < earliest[key]:
            earliest[key] = t
    rows = [{"subject_a": k[0], "subject_b": k[1], "first_contact": v.isoformat()}
            for k, v in earliest.items()]
    rows.sort(key=lambda x: x["first_contact"], reverse=True)
    return rows[:FIRST_CONTACT_TOPN]


# --- D. Identity & device --------------------------------------------------------

def device_anomalies(records):
    """Subscriber (msisdn) <-> handset (imei) cross-mapping. One number on multiple
    handsets = SIM swap/clone; one handset cycling multiple numbers = burner. msisdn is
    the reliable subscriber key — IMSI is intentionally reused across files in this
    dataset, so keying on it would report artifacts rather than real device anomalies."""
    msisdn_to_imei = defaultdict(set)
    imei_to_msisdn = defaultdict(set)
    msisdn_to_imsi = defaultdict(set)
    for r in records:
        msisdn, imei = getattr(r, "msisdn", None), getattr(r, "imei", None)
        imsi = getattr(r, "imsi", None)
        if msisdn and imei:
            msisdn_to_imei[msisdn].add(imei)
            imei_to_msisdn[imei].add(msisdn)
        if msisdn and imsi:
            msisdn_to_imsi[msisdn].add(imsi)

    sim_swaps = [{"msisdn": k, "imeis": sorted(v), "imsis": sorted(msisdn_to_imsi.get(k, []))}
                 for k, v in msisdn_to_imei.items() if len(v) > 1]
    burner_handsets = [{"imei": k, "msisdns": sorted(v)} for k, v in imei_to_msisdn.items() if len(v) > 1]
    return {"sim_swaps": sim_swaps, "burner_handsets": burner_handsets}


def clone_corroboration(streams, devices):
    """Strongest identity signal: a subject with impossible travel whose number is also
    seen on more than one handset (imei) -> the SIM is almost certainly cloned."""
    swapped = {s["msisdn"] for s in devices["sim_swaps"]}
    out = []
    for subj, events in streams.items():
        legs = impossible_travel(events)
        if not legs:
            continue
        corroborated = subj in swapped
        out.append({"subject": subj, "impossible_legs": len(legs),
                    "number_on_multiple_handsets": corroborated,
                    "verdict": "likely cloned SIM" if corroborated else "impossible movement (clone or spoofed record)",
                    "example": legs[0]})
    return out


def resolve_entities(cdr_records, devices=None):
    """Cluster phone numbers that are likely ONE actor — multiple SIMs used in shared
    handsets, grouped transitively (A&B share a handset, B&C share another -> {A,B,C}).
    CDR-only: an IP is never part of a phone actor. Confidence rises when a pair shares more
    than one handset (coincidental single-handset sharing is downgraded to 'medium')."""
    devices = devices or device_anomalies(cdr_records)
    parent: dict[str, str] = {}

    def find(x):
        parent.setdefault(x, x)
        root = x
        while parent[root] != root:
            root = parent[root]
        while parent[x] != root:
            parent[x], x = root, parent[x]
        return root

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    shared_handsets: dict[tuple, int] = defaultdict(int)
    for b in devices["burner_handsets"]:
        ms = b["msisdns"]
        for i in range(len(ms)):
            for j in range(i + 1, len(ms)):
                union(ms[i], ms[j])
                shared_handsets[tuple(sorted((ms[i], ms[j])))] += 1

    clusters: dict[str, set] = defaultdict(set)
    for m in list(parent):
        clusters[find(m)].add(m)

    out = []
    for members in clusters.values():
        if len(members) < 2:
            continue
        ms = sorted(members)
        multi = any(shared_handsets.get(tuple(sorted((a, b))), 0) > 1
                    for i, a in enumerate(ms) for b in ms[i + 1:])
        out.append({"numbers": ms, "size": len(ms), "confidence": "high" if multi else "medium"})
    return sorted(out, key=lambda x: -x["size"])


def apply_watchlist(report, phones=None, ips=None):
    """Mark risk-leaderboard subjects that match an investigator watchlist: prepend a
    'Watchlist match' factor and force the band to 'critical'. Phones match CDR subjects,
    IPs match IPDR subjects — the two are kept separate. Returns the list of hits."""
    phones = set(phones or [])
    ips = set(ips or [])
    hits = []
    for entry in report.get("cdr", {}).get("risk", []):
        if entry["subject"] in phones:
            entry["factors"].insert(0, {"name": "Watchlist match", "weight": 100,
                                        "detail": "subject is on the investigator watchlist"})
            entry["score"], entry["band"] = 100, "critical"
            hits.append({"subject": entry["subject"], "kind": "phone"})
    for entry in report.get("ipdr", {}).get("risk", []):
        if entry["subject"] in ips:
            entry["factors"].insert(0, {"name": "Watchlist match", "weight": 100,
                                        "detail": "IP is on the investigator watchlist"})
            entry["score"], entry["band"] = 100, "critical"
            hits.append({"subject": entry["subject"], "kind": "ip"})
    # re-sort so watchlist hits float to the top
    report.get("cdr", {}).get("risk", []).sort(key=lambda x: (-x["score"], x["subject"]))
    report.get("ipdr", {}).get("risk", []).sort(key=lambda x: (-x["score"], x["subject"]))
    report["watchlist_hits"] = hits
    return hits


_EXPORT_CODES = {"analysis": "ANL", "evidence": "EVD"}
_EXPORT_LABELS = {"analysis": "Analytics report (Inferences tab)", "evidence": "Case evidence report (navbar)"}


def make_export_ref(source: str) -> str:
    """Official, sortable, self-describing export reference, e.g.
    ARGUS-ANL-20260622-143052-3F9A (ANL = analysis export, EVD = evidence export)."""
    import secrets
    code = _EXPORT_CODES.get(source, "GEN")
    return f"ARGUS-{code}-{datetime.now():%Y%m%d-%H%M%S}-{secrets.token_hex(2).upper()}"


def export_manifest(report) -> dict:
    """Count what an export contains — recorded in the audit log and shown in the report."""
    cdr, ipdr = report.get("cdr", {}), report.get("ipdr", {})
    net, temporal = cdr.get("network", {}), cdr.get("temporal", {})
    return {
        "cdr_subjects": cdr.get("subjects", 0),
        "ipdr_sessions": ipdr.get("sessions", 0),
        "persons_of_interest": len(cdr.get("risk", [])),
        "flagged_ips": len(ipdr.get("risk", [])),
        "watchlist_hits": len(report.get("watchlist_hits", [])),
        "impossible_travel": len(cdr.get("impossible_travel", [])),
        "hidden_links_convoys": sum(1 for p in cdr.get("co_presence", []) if p.get("hidden_link") or p.get("convoy")),
        "network_roles": len(net.get("brokers", [])) + len(net.get("articulation_points", [])),
        "multi_sim_identities": len(cdr.get("entities", [])),
        "behavioural_shifts": len(temporal.get("escalation", {})) + len(temporal.get("dormancy", {})),
        "ipdr_vpn_proxy": len(ipdr.get("vpn_proxy", [])),
        "ipdr_beaconing": len(ipdr.get("beaconing", [])),
    }


def report_markdown(report, case_name=None, ref_id=None, source=None, exported_by=None):
    """Serialise the full inference report into a comprehensive, readable Markdown case
    report (for export) — leaderboards plus the key CDR and IPDR findings behind them. When
    a reference id is supplied, a Document-control block (ref, type, case, contents manifest)
    leads the document so the export is self-identifying and auditable."""
    cdr, ipdr = report.get("cdr", {}), report.get("ipdr", {})
    net = cdr.get("network", {})
    temporal = cdr.get("temporal", {})
    L = ["# ARGUS — Case Analysis Report", ""]
    if ref_id:
        man = export_manifest(report)
        contents = " · ".join(f"{v} {k.replace('_', ' ')}" for k, v in man.items() if v)
        L += ["## Document control", "",
              "| Field | Value |", "|---|---|",
              f"| Reference | `{ref_id}` |",
              f"| Document type | {_EXPORT_LABELS.get(source, source or 'report')} |",
              f"| Case | {case_name or '(all data)'} |",
              f"| Generated | {datetime.now().isoformat(timespec='seconds')} |",
              f"| Exported by | {exported_by or 'unknown'} |",
              "", f"**Contents exported:** {contents or 'none'}", ""]
    elif case_name:
        L.append(f"**Case:** {case_name}  ")
    L += [f"**Generated:** {datetime.now().isoformat(timespec='seconds')}  ",
          f"**CDR phone subjects:** {cdr.get('subjects', 0)} · **IPDR sessions:** {ipdr.get('sessions', 0)}",
          "",
          "> CDR (phone numbers) and IPDR (IP addresses) are analysed separately and never "
          "cross-attributed. Every item below is an investigative lead to verify, not proof."]

    hits = report.get("watchlist_hits", [])
    if hits:
        L += ["", "## ⚑ Watchlist hits", *[f"- `{h['subject']}` ({h['kind']})" for h in hits]]

    def section(title, items, render):
        # `title` already carries its own heading level (e.g. "### ..."); subsections only
        # appear when they have content, so an empty case stays out of the report.
        if not items:
            return
        L.append("")
        L.append(title)
        for it in items:
            L.append(render(it))

    def leaderboard(title, rows):
        L.append("")
        L.append(f"## {title}")
        if not rows:
            L.append("_none flagged_")
        for r in rows[:20]:
            L.append(f"- **{r['subject']}** — {r['score']}/100 _({r['band']})_")
            for f in r.get("factors", []):
                L.append(f"  - {f['name']}: {f['detail']}")

    leaderboard("Persons of interest (CDR — phone numbers)", cdr.get("risk", []))
    leaderboard("Flagged IP addresses (IPDR)", ipdr.get("risk", []))

    L += ["", "## CDR findings"]
    section("### Impossible travel / cloning", cdr.get("impossible_travel", [])[:15],
            lambda x: f"- `{x['subject']}` — {x['distance_km']} km in {x['dt_minutes']} min "
                      f"({x['from_tower']} → {x['to_tower']})")
    section("### Hidden links & convoys",
            [p for p in cdr.get("co_presence", []) if p.get("hidden_link") or p.get("convoy")][:15],
            lambda p: f"- `{p['subject_a']}` & `{p['subject_b']}` — "
                      f"{'hidden link, ' if p.get('hidden_link') else ''}{p['occurrences']}× over {p['distinct_days']} day(s)")
    section("### Multi-SIM identities", cdr.get("entities", [])[:15],
            lambda e: f"- {' = '.join(e['numbers'])} ({e['confidence']} confidence)")
    section("### Network brokers / cut-points",
            (net.get("brokers", []) + net.get("articulation_points", []))[:15],
            lambda b: f"- `{b['subject']}` — {'broker, betweenness ' + str(b['betweenness']) if 'betweenness' in b else 'cut-point, degree ' + str(b['degree'])}")
    section("### Behavioural shifts — escalation",
            list(temporal.get("escalation", {}).items())[:15],
            lambda kv: f"- `{kv[0]}` — recent volume {kv[1]['factor']}× the earlier baseline")
    section("### Behavioural shifts — dormant → reactivated",
            list(temporal.get("dormancy", {}).items())[:15],
            lambda kv: f"- `{kv[0]}` — {kv[1]['dormant_days']}d silent, resumed {kv[1]['resumed']}")
    section("### Shared travel routes", cdr.get("shared_routes", [])[:15],
            lambda r: f"- `{r['subject_a']}` & `{r['subject_b']}` — {r['shared_segments']} shared tower segments")

    L += ["", "## IPDR findings"]
    section("### VPN / proxy", ipdr.get("vpn_proxy", [])[:15],
            lambda v: f"- `{v['source_ip']}` — {v['vpn_sessions']} VPN / {v['proxy_tor_sessions']} proxy-Tor session(s)")
    section("### Data volume / exfiltration",
            [s for s in ipdr.get("volume", {}).get("subjects", []) if s.get("exfil_suspected")][:15],
            lambda s: f"- `{s['source_ip']}` — {s['up_mb']} MB up vs {s['down_mb']} MB down (asymmetric)")
    section("### Beaconing", ipdr.get("beaconing", [])[:15],
            lambda b: f"- `{b['source_ip']}` → `{b['destination_ip']}`:{b.get('port')} — every ~{b['mean_interval_hours']}h ({b['sessions']} sessions)")
    section("### Rare destinations", ipdr.get("destinations", [])[:15],
            lambda d: f"- `{d['source_ip']}` — {len(d['rare'])} rare destination(s): " +
                      ", ".join(f"{x['destination_ip']}×{x['sessions']}" for x in d['rare'][:4]))

    L += ["", "_Generated by ARGUS. Each item is a graded lead, not proof._"]
    return "\n".join(L)


# --- IPDR network analysis (kept separate from CDR; no person attribution) -------

def vpn_proxy_use(ipdr_records):
    """IPDR-only. The subject is the source IP (the IPDR record's subject) — never a phone
    number. Flags source IPs that open sessions on VPN/Tor tunnel ports, with the
    destination server(s) and the server's provider."""
    by_src = {}
    for r in ipdr_records:
        try:
            port = int(getattr(r, "destination_port", None))
        except (TypeError, ValueError):
            port = None
        kind = "vpn" if port in VPN_PORTS else ("proxy" if port in PROXY_TOR_PORTS else None)
        if not kind:
            continue
        src = getattr(r, "source_ip", None)
        if not src:
            continue
        d = by_src.setdefault(src, {"vpn": 0, "proxy": 0, "ports": set(), "dests": {}})
        d[kind] += 1
        d["ports"].add(port)
        dip = getattr(r, "destination_ip", None)
        if dip and dip not in d["dests"]:
            match = _match_ip(dip)
            d["dests"][dip] = match[0] if match else None

    out = []
    for src, d in by_src.items():
        evidence = []
        if d["vpn"]:
            evidence.append(f"{d['vpn']} session(s) on VPN tunnel ports (WireGuard/OpenVPN/IPsec)")
        if d["proxy"]:
            evidence.append(f"{d['proxy']} session(s) on Tor/proxy ports")
        servers = [f"{ip}{' (' + prov + ')' if prov else ''}" for ip, prov in list(d["dests"].items())[:6]]
        out.append({
            "source_ip": src,
            "vpn_sessions": d["vpn"],
            "proxy_tor_sessions": d["proxy"],
            "ports": sorted(d["ports"]),
            "servers": servers,
            "evidence": evidence,
        })
    return sorted(out, key=lambda x: -(x["vpn_sessions"] + x["proxy_tor_sessions"]))


def _int_or_none(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def ipdr_volume(ipdr_records):
    """IPDR-only. Per source IP: total bytes up/down and an asymmetric-upload
    (exfiltration-shaped) flag. Rows without byte counts are skipped and coverage reported,
    so the analyst knows how much data backed the result. Exfil is a 'review' lead, not proof
    — symmetric high-volume transfers (video) and cloud backups can look similar."""
    agg: dict[str, dict] = {}
    total = 0
    for r in ipdr_records:
        src = getattr(r, "source_ip", None)
        if not src:
            continue
        total += 1
        d = agg.setdefault(src, {"up": 0, "down": 0, "sessions": 0, "with_bytes": 0})
        d["sessions"] += 1
        up = _int_or_none(getattr(r, "bytes_uploaded", None))
        down = _int_or_none(getattr(r, "bytes_downloaded", None))
        if up is not None or down is not None:
            d["with_bytes"] += 1
            d["up"] += up or 0
            d["down"] += down or 0
    subjects = []
    for src, d in agg.items():
        if d["with_bytes"] == 0:
            continue
        up, down = d["up"], d["down"]
        exfil = up >= EXFIL_MIN_UP_MB * MB and (down == 0 or up >= EXFIL_UP_DOWN_RATIO * down)
        subjects.append({"source_ip": src, "bytes_up": up, "bytes_down": down,
                         "up_mb": round(up / MB, 1), "down_mb": round(down / MB, 1),
                         "sessions": d["sessions"], "exfil_suspected": exfil})
    subjects.sort(key=lambda x: -x["bytes_up"])
    covered = sum(a["with_bytes"] for a in agg.values())
    return {"subjects": subjects[:IPDR_TOPN],
            "byte_coverage": round(covered / total, 2) if total else 0.0}


def beaconing(ipdr_records):
    """IPDR-only. Per (source IP -> destination): a regular, low-jitter session cadence =
    automated 'beaconing' (agent/C2 check-ins), distinct from bursty human browsing. False
    positives (email/push/NTP sync) are reduced by requiring a real span and session count;
    a non-web destination port raises confidence."""
    pair_times: dict[tuple, list] = defaultdict(list)
    pair_port: dict[tuple, int] = {}
    for r in ipdr_records:
        src = getattr(r, "source_ip", None)
        dst = getattr(r, "destination_ip", None)
        t = getattr(r, "start_time", None)
        if not src or not dst or not t:
            continue
        pair_times[(src, dst)].append(t)
        p = _int_or_none(getattr(r, "destination_port", None))
        if p is not None:
            pair_port[(src, dst)] = p
    out = []
    for (src, dst), times in pair_times.items():
        if len(times) < BEACON_MIN_SESSIONS:
            continue
        times.sort()
        if (times[-1] - times[0]).total_seconds() / 3600.0 < BEACON_MIN_SPAN_H:
            continue
        gaps = [(times[i + 1] - times[i]).total_seconds() / 3600.0 for i in range(len(times) - 1)]
        mean = statistics.mean(gaps)
        if mean <= 0:
            continue
        cv = statistics.pstdev(gaps) / mean
        if cv <= BEACON_CV_MAX:
            port = pair_port.get((src, dst))
            out.append({"source_ip": src, "destination_ip": dst, "sessions": len(times),
                        "mean_interval_hours": round(mean, 2), "regularity_cv": round(cv, 2),
                        "port": port, "non_web_port": (port not in (80, 443)) if port is not None else None})
    return sorted(out, key=lambda x: x["regularity_cv"])[:IPDR_TOPN]


def destination_profile(ipdr_records):
    """IPDR-only. Per source IP: rare destinations (reached from few sources) with the
    destination's provider via attribution. Concentrated, rarely-seen destinations are leads;
    widely-shared destinations are filtered out by the 'rare' threshold."""
    dst_sources: dict[str, set] = defaultdict(set)
    src_dsts: dict[str, Counter] = defaultdict(Counter)
    for r in ipdr_records:
        src = getattr(r, "source_ip", None)
        dst = getattr(r, "destination_ip", None)
        if not src or not dst:
            continue
        dst_sources[dst].add(src)
        src_dsts[src][dst] += 1
    out = []
    for src, dsts in src_dsts.items():
        rare = []
        for dst, cnt in dsts.most_common():
            if len(dst_sources[dst]) <= DEST_RARE_MAX_SOURCES and cnt >= DEST_RARE_MIN_SESSIONS:
                m = _match_ip(dst)
                rare.append({"destination_ip": dst, "sessions": cnt,
                             "provider": (m[0] if m else None),
                             "seen_from_sources": len(dst_sources[dst])})
            if len(rare) >= 5:
                break
        if rare:
            out.append({"source_ip": src, "distinct_destinations": len(dsts), "rare": rare})
    return sorted(out, key=lambda x: -len(x["rare"]))[:IPDR_TOPN]


# --- Composite risk scoring ------------------------------------------------------
# Each signal contributes POINTS; a subject's score is the (capped) sum, banded for
# triage. Weights are deliberately explicit and the per-factor breakdown is ALWAYS
# returned, so a human can judge the basis — the score is a triage aid, never proof.
# Correlated identity signals (impossible-travel / cloned-SIM / multi-handset) describe
# the same underlying event, so they are de-duplicated (only the strongest is counted).
# CDR (phone) subjects are scored from CDR signals only and IPDR (IP) subjects from IPDR
# signals only — the two leaderboards never mix.
RISK_WEIGHTS = {
    "cloned_sim": 30,         # impossible travel + number on multiple handsets (combined)
    "impossible_travel": 22,  # impossible travel alone (no handset corroboration)
    "sim_multi_handset": 16,  # number on multiple handsets, no impossible travel
    "burner_handset": 14,     # number shares a handset with other numbers
    "hidden_link": 16,        # repeated co-presence with someone never called
    "convoy": 11,             # repeated co-movement with a known associate
    "periodic_contact": 8,    # regular scheduled cadence
    "activity_burst": 8,
    "odd_hours": 7,
    "broker": 10,             # high-betweenness connector in the call graph
    "cut_point": 8,           # articulation point (removal splits the network)
    "escalation": 9,          # sustained surge in activity vs the subject's own baseline
    "reactivation": 7,        # long dormancy then renewed activity
    "shared_route": 8,        # repeatedly travels the same tower path as another subject
    "tor_proxy": 18,          # IPDR: Tor/proxy port usage
    "vpn": 12,                # IPDR: VPN tunnel port usage
    "exfil": 16,              # IPDR: asymmetric upload (exfiltration-shaped)
    "beaconing": 16,          # IPDR: regular automated check-ins (C2-shaped)
}
RISK_BANDS = ((75, "critical"), (50, "high"), (25, "elevated"), (0, "low"))
LOW_EVIDENCE_MIN = 3   # subjects backed by fewer events than this can't exceed "elevated"
LOW_EVIDENCE_CAP = 49


def _risk_band(score: int) -> str:
    for threshold, name in RISK_BANDS:
        if score >= threshold:
            return name
    return "low"


def _score_factors(factors, evidence_count):
    """Sum factor weights (capped 0-100); low-evidence subjects can't exceed 'elevated'."""
    raw = min(100, sum(f["weight"] for f in factors))
    if evidence_count < LOW_EVIDENCE_MIN and raw > LOW_EVIDENCE_CAP:
        raw = LOW_EVIDENCE_CAP
    return raw, _risk_band(raw)


def risk_scores(report):
    """Roll already-computed inferences into a transparent, ranked per-subject score.
    Returns {"cdr": [...], "ipdr": [...]} — two independent leaderboards. The `factors`
    list is intentionally open so later analytics can contribute additional factors."""
    cdr = report.get("cdr", {})
    ipdr = report.get("ipdr", {})
    movement = cdr.get("movement", {})
    factors_by_subj: dict[str, list] = defaultdict(list)

    # Identity/movement family — de-duplicated: cloned-SIM > impossible-travel > multi-handset.
    impossible_subjs = {row["subject"] for row in cdr.get("impossible_travel", [])}
    clone = {c["subject"]: c for c in cdr.get("clone_corroboration", [])}
    sim_swap_subjs = {s["msisdn"] for s in cdr.get("devices", {}).get("sim_swaps", [])}
    for subj in impossible_subjs | set(clone) | sim_swap_subjs:
        c = clone.get(subj)
        if c and c.get("number_on_multiple_handsets"):
            factors_by_subj[subj].append({"name": "Cloned SIM", "weight": RISK_WEIGHTS["cloned_sim"],
                "detail": f"{c['impossible_legs']} impossible-travel leg(s) + number on multiple handsets"})
        elif subj in impossible_subjs:
            factors_by_subj[subj].append({"name": "Impossible travel", "weight": RISK_WEIGHTS["impossible_travel"],
                "detail": "physically impossible movement between consecutive locations"})
        elif subj in sim_swap_subjs:
            factors_by_subj[subj].append({"name": "SIM on multiple handsets", "weight": RISK_WEIGHTS["sim_multi_handset"],
                "detail": "number used across more than one IMEI"})

    burner_imeis: dict[str, list] = defaultdict(list)
    for b in cdr.get("devices", {}).get("burner_handsets", []):
        for m in b["msisdns"]:
            burner_imeis[m].append(b["imei"])
    for subj, imeis in burner_imeis.items():
        factors_by_subj[subj].append({"name": "Shared/burner handset", "weight": RISK_WEIGHTS["burner_handset"],
            "detail": f"shares handset(s) with other numbers: {', '.join(imeis[:3])}"})

    # Co-presence — convoy / hidden link, counted once per subject.
    hidden_assoc: dict[str, set] = defaultdict(set)
    convoy_assoc: dict[str, set] = defaultdict(set)
    for pair in cdr.get("co_presence", []):
        a, b = pair["subject_a"], pair["subject_b"]
        if pair.get("hidden_link"):
            hidden_assoc[a].add(b); hidden_assoc[b].add(a)
        elif pair.get("convoy"):
            convoy_assoc[a].add(b); convoy_assoc[b].add(a)
    for subj, assoc in hidden_assoc.items():
        factors_by_subj[subj].append({"name": "Hidden link", "weight": RISK_WEIGHTS["hidden_link"],
            "detail": f"repeatedly co-located with {len(assoc)} subject(s) never called"})
    for subj, assoc in convoy_assoc.items():
        factors_by_subj[subj].append({"name": "Convoy / associate", "weight": RISK_WEIGHTS["convoy"],
            "detail": f"repeated co-movement with {len(assoc)} associate(s)"})

    # Behavioral.
    for subj, beh in cdr.get("behavioral", {}).items():
        odd = beh.get("odd_hours")
        if odd and odd.get("flag"):
            factors_by_subj[subj].append({"name": "Odd-hours activity", "weight": RISK_WEIGHTS["odd_hours"],
                "detail": f"{int(odd['share'] * 100)}% of activity between 01:00-05:00"})
        if beh.get("bursts"):
            factors_by_subj[subj].append({"name": "Activity burst", "weight": RISK_WEIGHTS["activity_burst"],
                "detail": f"{len(beh['bursts'])} day(s) of abnormally high volume"})

    periodic_peers: dict[str, int] = defaultdict(int)
    for p in cdr.get("periodic_contacts", []):
        periodic_peers[p["subject"]] += 1
    for subj, n in periodic_peers.items():
        factors_by_subj[subj].append({"name": "Scheduled contact", "weight": RISK_WEIGHTS["periodic_contact"],
            "detail": f"regular call cadence with {n} peer(s)"})

    # Structural roles in the call graph (Phase 2). Broker and cut-point describe the same
    # "structurally important" idea, so a node that is both is counted once (broker wins).
    net = cdr.get("network", {})
    broker_subjs = {b["subject"] for b in net.get("brokers", [])}
    for b in net.get("brokers", []):
        factors_by_subj[b["subject"]].append({"name": "Network broker", "weight": RISK_WEIGHTS["broker"],
            "detail": f"high betweenness ({b['betweenness']}) — connects otherwise separate groups"})
    for a in net.get("articulation_points", []):
        if a["subject"] in broker_subjs:
            continue
        factors_by_subj[a["subject"]].append({"name": "Network cut-point", "weight": RISK_WEIGHTS["cut_point"],
            "detail": f"removing this number splits the network (degree {a['degree']})"})

    # Temporal/behavioral shifts (Phase 3).
    temporal = cdr.get("temporal", {})
    for subj, e in temporal.get("escalation", {}).items():
        factors_by_subj[subj].append({"name": "Escalating activity", "weight": RISK_WEIGHTS["escalation"],
            "detail": f"recent daily volume {e['factor']}x the earlier baseline"})
    for subj, d in temporal.get("dormancy", {}).items():
        factors_by_subj[subj].append({"name": "Dormant then reactivated", "weight": RISK_WEIGHTS["reactivation"],
            "detail": f"{d['dormant_days']}d silent, resumed {d['resumed']}"})

    # Shared travel routes (Phase 5) — counted once per subject (most-shared partner).
    route_partner: dict[str, int] = defaultdict(int)
    for r in cdr.get("shared_routes", []):
        route_partner[r["subject_a"]] = max(route_partner[r["subject_a"]], r["shared_segments"])
        route_partner[r["subject_b"]] = max(route_partner[r["subject_b"]], r["shared_segments"])
    for subj, seg in route_partner.items():
        factors_by_subj[subj].append({"name": "Shared travel route", "weight": RISK_WEIGHTS["shared_route"],
            "detail": f"repeats the same tower path as another subject ({seg} segment(s))"})

    cdr_scores = []
    for subj, factors in factors_by_subj.items():
        ev = movement.get(subj, {}).get("total_events", 0)
        score, band = _score_factors(factors, ev)
        cdr_scores.append({"subject": subj, "score": score, "band": band, "events": ev,
                           "factors": sorted(factors, key=lambda f: -f["weight"])})
    cdr_scores.sort(key=lambda x: (-x["score"], x["subject"]))

    # IPDR (IP subjects) — aggregate anonymisation, exfiltration and beaconing per source IP.
    ip_factors: dict[str, list] = defaultdict(list)
    ip_events: dict[str, int] = defaultdict(int)
    for row in ipdr.get("vpn_proxy", []):
        ip = row["source_ip"]
        if row.get("proxy_tor_sessions"):
            ip_factors[ip].append({"name": "Tor/proxy", "weight": RISK_WEIGHTS["tor_proxy"],
                                   "detail": f"{row['proxy_tor_sessions']} session(s) on Tor/proxy ports"})
        if row.get("vpn_sessions"):
            ip_factors[ip].append({"name": "VPN tunnel", "weight": RISK_WEIGHTS["vpn"],
                                   "detail": f"{row['vpn_sessions']} session(s) on VPN tunnel ports"})
        ip_events[ip] = max(ip_events[ip], row.get("vpn_sessions", 0) + row.get("proxy_tor_sessions", 0))
    for v in ipdr.get("volume", {}).get("subjects", []):
        if v.get("exfil_suspected"):
            ip_factors[v["source_ip"]].append({"name": "Possible exfiltration", "weight": RISK_WEIGHTS["exfil"],
                "detail": f"{v['up_mb']} MB up vs {v['down_mb']} MB down (asymmetric)"})
            ip_events[v["source_ip"]] = max(ip_events[v["source_ip"]], v.get("sessions", 0))
    for b in ipdr.get("beaconing", []):
        # Only a non-web-port beacon feeds the score — a regular cadence to 80/443 is usually
        # benign app sync (email/push) and would be a false positive. Web-port beacons still
        # appear in the beaconing card for review, just without inflating risk.
        if not b.get("non_web_port"):
            continue
        ip_factors[b["source_ip"]].append({"name": "Beaconing", "weight": RISK_WEIGHTS["beaconing"],
            "detail": f"regular {b['mean_interval_hours']}h cadence to {b['destination_ip']}:{b.get('port')} ({b['sessions']} sessions)"})
        ip_events[b["source_ip"]] = max(ip_events[b["source_ip"]], b.get("sessions", 0))

    ipdr_scores = []
    for ip, factors in ip_factors.items():
        ev = ip_events.get(ip, len(factors))
        score, band = _score_factors(factors, ev)
        ipdr_scores.append({"subject": ip, "score": score, "band": band, "events": ev,
                            "factors": sorted(factors, key=lambda f: -f["weight"])})
    ipdr_scores.sort(key=lambda x: (-x["score"], x["subject"]))

    return {"cdr": cdr_scores, "ipdr": ipdr_scores}


# --- Orchestration ---------------------------------------------------------------

def _call_pairs(cdr_records):
    pairs = set()
    for r in cdr_records:
        a, b = _subject(r), getattr(r, "b_party_number", None)
        if a and b:
            pairs.add(tuple(sorted((a, b))))
    return pairs


def run_all(cdr_records, ipdr_records, tower_coords: dict | None = None):
    """Compute all inferences, kept strictly separated into a CDR (phone-subject) block
    and an IPDR (network) block — the two data sources are never cross-attributed."""
    cdr_records = list(cdr_records)
    ipdr_records = list(ipdr_records)
    streams = build_subject_streams(cdr_records, tower_coords=tower_coords)
    call_pairs = _call_pairs(cdr_records)

    movement = {s: subject_movement(ev) for s, ev in streams.items()}
    impossible = [{"subject": s, **m["impossible_travel"][0]}
                  for s, m in movement.items() if m["impossible_travel"]]
    behavioral = {}
    temporal_esc, temporal_dorm = {}, {}
    for s, ev in streams.items():
        odd = odd_hours_profile(ev)
        bursts = activity_bursts(ev)
        if (odd and odd["flag"]) or bursts:
            behavioral[s] = {"odd_hours": odd, "bursts": bursts}
        esc = escalation(ev)
        if esc:
            temporal_esc[s] = esc
        dorm = dormancy_reactivation(ev)
        if dorm:
            temporal_dorm[s] = dorm

    devices = device_anomalies(cdr_records)
    report = {
        "cdr": {
            "subjects": len(streams),
            "movement": movement,
            "impossible_travel": impossible,
            "co_presence": co_presence(streams, call_pairs),
            "shared_routes": shared_routes(streams),
            "network": network_structure(cdr_records),
            "behavioral": behavioral,
            "temporal": {"escalation": temporal_esc, "dormancy": temporal_dorm,
                         "first_contacts": first_contacts(cdr_records)},
            "periodic_contacts": periodic_contacts(cdr_records),
            "devices": devices,
            "clone_corroboration": clone_corroboration(streams, devices),
            "entities": resolve_entities(cdr_records, devices),
        },
        "ipdr": {
            "sessions": len(ipdr_records),
            "vpn_proxy": vpn_proxy_use(ipdr_records),
            "volume": ipdr_volume(ipdr_records),
            "beaconing": beaconing(ipdr_records),
            "destinations": destination_profile(ipdr_records),
        },
    }
    # Composite triage scores derived from the signals above (kept additive: the CDR and
    # IPDR leaderboards are scored independently and never share a subject).
    scores = risk_scores(report)
    report["cdr"]["risk"] = scores["cdr"]
    report["ipdr"]["risk"] = scores["ipdr"]
    report["risk_weights"] = RISK_WEIGHTS
    return report


# --- DB wrappers for the API -----------------------------------------------------

def _load(db, limit, case_id=None):
    cq = db.query(CDRRecord)
    iq = db.query(IPDRRecord)
    if case_id:
        cq = cq.filter(CDRRecord.case_id == case_id)
        iq = iq.filter(IPDRRecord.case_id == case_id)
    cdr = cq.order_by(CDRRecord.start_time).limit(limit).all()
    ipdr = iq.order_by(IPDRRecord.start_time).limit(limit).all()
    tower_coords = {
        t.tower_id: (t.latitude, t.longitude)
        for t in db.query(Tower).filter(
            Tower.latitude.isnot(None), Tower.longitude.isnot(None)
        ).all()
    }
    return cdr, ipdr, tower_coords


def run_all_db(db, limit: int = 5000, case_id=None):
    cdr, ipdr, tower_coords = _load(db, limit, case_id)
    return run_all(cdr, ipdr, tower_coords=tower_coords)


def subject_timeline_db(db, subject: str, limit: int = 5000, case_id=None):
    """Movement-annotated CDR timeline for one phone subject (kept separate from IPDR)."""
    cdr, _ipdr, tower_coords = _load(db, limit, case_id)
    streams = build_subject_streams(cdr, tower_coords=tower_coords)
    events = streams.get(subject, [])
    return {"subject": subject, "event_count": len(events),
            "movement": subject_movement(events) if events else None,
            "baseline": subject_baseline(events) if events else None,
            "escalation": escalation(events) if events else None,
            "dormancy": dormancy_reactivation(events) if events else None,
            "events": events}
