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

from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord
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

def build_subject_streams(cdr_records):
    """Per-MSISDN chronological stream of a subscriber's calls/SMS (CDR only)."""
    streams: dict[str, list] = defaultdict(list)

    for r in cdr_records:
        subj = _subject(r)
        if not subj:
            continue
        kind = "sms" if str(getattr(r, "call_type", "") or "").upper() == "SMS" else "call"
        streams[subj].append({
            "time": r.start_time,
            "end": getattr(r, "end_time", None) or r.start_time,
            "kind": kind,
            "peer": getattr(r, "b_party_number", None),
            "direction": getattr(r, "direction", None),
            "tower_id": getattr(r, "tower_id", None),
            "lat": getattr(r, "latitude", None),
            "lon": getattr(r, "longitude", None),
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
    }


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
    "tor_proxy": 18,          # IPDR: Tor/proxy port usage
    "vpn": 12,                # IPDR: VPN tunnel port usage
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

    cdr_scores = []
    for subj, factors in factors_by_subj.items():
        ev = movement.get(subj, {}).get("total_events", 0)
        score, band = _score_factors(factors, ev)
        cdr_scores.append({"subject": subj, "score": score, "band": band, "events": ev,
                           "factors": sorted(factors, key=lambda f: -f["weight"])})
    cdr_scores.sort(key=lambda x: (-x["score"], x["subject"]))

    ipdr_scores = []
    for row in ipdr.get("vpn_proxy", []):
        factors = []
        if row.get("proxy_tor_sessions"):
            factors.append({"name": "Tor/proxy", "weight": RISK_WEIGHTS["tor_proxy"],
                            "detail": f"{row['proxy_tor_sessions']} session(s) on Tor/proxy ports"})
        if row.get("vpn_sessions"):
            factors.append({"name": "VPN tunnel", "weight": RISK_WEIGHTS["vpn"],
                            "detail": f"{row['vpn_sessions']} session(s) on VPN tunnel ports"})
        if not factors:
            continue
        ev = row.get("vpn_sessions", 0) + row.get("proxy_tor_sessions", 0)
        score, band = _score_factors(factors, ev)
        ipdr_scores.append({"subject": row["source_ip"], "score": score, "band": band,
                            "events": ev, "factors": factors})
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


def run_all(cdr_records, ipdr_records):
    """Compute all inferences, kept strictly separated into a CDR (phone-subject) block
    and an IPDR (network) block — the two data sources are never cross-attributed."""
    cdr_records = list(cdr_records)
    ipdr_records = list(ipdr_records)
    streams = build_subject_streams(cdr_records)
    call_pairs = _call_pairs(cdr_records)

    movement = {s: subject_movement(ev) for s, ev in streams.items()}
    impossible = [{"subject": s, **m["impossible_travel"][0]}
                  for s, m in movement.items() if m["impossible_travel"]]
    behavioral = {}
    for s, ev in streams.items():
        odd = odd_hours_profile(ev)
        bursts = activity_bursts(ev)
        if (odd and odd["flag"]) or bursts:
            behavioral[s] = {"odd_hours": odd, "bursts": bursts}

    devices = device_anomalies(cdr_records)
    report = {
        "cdr": {
            "subjects": len(streams),
            "movement": movement,
            "impossible_travel": impossible,
            "co_presence": co_presence(streams, call_pairs),
            "behavioral": behavioral,
            "periodic_contacts": periodic_contacts(cdr_records),
            "devices": devices,
            "clone_corroboration": clone_corroboration(streams, devices),
        },
        "ipdr": {
            "sessions": len(ipdr_records),
            "vpn_proxy": vpn_proxy_use(ipdr_records),
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
    return cdr, ipdr


def run_all_db(db, limit: int = 5000, case_id=None):
    return run_all(*_load(db, limit, case_id))


def subject_timeline_db(db, subject: str, limit: int = 5000, case_id=None):
    """Movement-annotated CDR timeline for one phone subject (kept separate from IPDR)."""
    cdr, _ipdr = _load(db, limit, case_id)
    streams = build_subject_streams(cdr)
    events = streams.get(subject, [])
    return {"subject": subject, "event_count": len(events),
            "movement": subject_movement(events) if events else None,
            "events": events}
