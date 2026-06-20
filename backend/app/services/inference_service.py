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
from app.services.service_attribution_service import attribute_service

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


# --- Foundation: per-subject unified, movement-annotated timeline ----------------

def build_subject_streams(cdr_records, ipdr_records, attribute: bool = True):
    """Merge a subject's calls/SMS and data sessions into one chronological stream,
    keyed by msisdn (falling back to imsi). Each event is a normalized dict."""
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

    for r in ipdr_records:
        subj = _subject(r)
        if not subj:
            continue
        attr = attribute_service(r) if attribute else {}
        streams[subj].append({
            "time": r.start_time,
            "end": getattr(r, "end_time", None) or r.start_time,
            "kind": "data",
            "peer": getattr(r, "destination_ip", None),
            "tower_id": getattr(r, "tower_id", None),
            "lat": getattr(r, "latitude", None),
            "lon": getattr(r, "longitude", None),
            "imsi": getattr(r, "imsi", None),
            "imei": getattr(r, "imei", None),
            "service": attr.get("service"),
            "category": attr.get("category"),
            "dst_port": _to_int(getattr(r, "destination_port", 0)) or None,
            "bytes_up": _to_int(getattr(r, "bytes_uploaded", 0)),
            "bytes_down": _to_int(getattr(r, "bytes_downloaded", 0)),
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


def going_dark(events):
    """First adoption of encrypted-tunnel / anonymisation traffic, with how messaging
    activity changed afterwards — a behavioral shift worth a timeline marker. Detected by
    category (vpn/anonymization) OR a tunnel/proxy destination port, so a VPN run on a
    cloud/VPS IP (which the attribution layer labels 'hosting') is still caught. Plain
    'hosting' alone is NOT treated as going dark — ordinary cloud use isn't a tunnel."""
    tunnel_ports = VPN_PORTS | PROXY_TOR_PORTS

    def is_encrypted(e):
        if e.get("kind") != "data" or not e["time"]:
            return False
        return e.get("category") in ("vpn", "anonymization") or e.get("dst_port") in tunnel_ports

    enc = [e for e in events if is_encrypted(e)]
    if not enc:
        return None
    first = min(e["time"] for e in enc)
    msg_before = sum(1 for e in events
                     if e["kind"] in ("call", "sms") and e["time"] and e["time"] < first)
    msg_after = sum(1 for e in events
                    if e["kind"] in ("call", "sms") and e["time"] and e["time"] >= first)
    return {"first_encrypted": first, "encrypted_sessions": len(enc),
            "calls_sms_before": msg_before, "calls_sms_after": msg_after,
            "flag": len(enc) >= 2}


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


# --- VPN / proxy use -------------------------------------------------------------

def vpn_proxy_use(ipdr_records):
    """Heuristic likelihood that a subject is using a VPN or proxy, from IPDR alone.

    Logic (each subject scored, then graded high/medium/low):
      * Explicit tunnel ports (WireGuard/OpenVPN/IPsec/L2TP/PPTP) or `vpn` category  -> strong.
      * Tor/proxy ports or `anonymization` category                                  -> strong.
      * Traffic *concentration*: a VPN/proxy funnels almost everything through ONE
        host, unlike normal browsing which fans out across many CDNs. So a single
        cloud/VPS endpoint carrying a large share of the subject's bytes is tunnel-like
        even on port 443 (the stealth case that simple port rules miss).
    """
    by_subj = defaultdict(list)
    for r in ipdr_records:
        s = _subject(r)
        if s:
            by_subj[s].append(r)

    out = []
    for subj, recs in by_subj.items():
        total = 0
        dest_bytes = defaultdict(int)
        dest_cat = {}
        vpn = anon = hosting = 0
        endpoints = set()
        for r in recs:
            attr = attribute_service(r)
            cat = attr.get("category")
            try:
                port = int(getattr(r, "destination_port", None))
            except (TypeError, ValueError):
                port = None
            b = _to_int(getattr(r, "bytes_uploaded", 0)) + _to_int(getattr(r, "bytes_downloaded", 0))
            total += b
            dip = getattr(r, "destination_ip", None)
            if dip:
                dest_bytes[dip] += b
                dest_cat[dip] = cat
            if cat == "vpn" or port in VPN_PORTS:
                vpn += 1
                if dip:
                    endpoints.add(dip)
            elif cat == "anonymization" or port in PROXY_TOR_PORTS:
                anon += 1
                if dip:
                    endpoints.add(dip)
            elif cat == "hosting":
                hosting += 1

        top_ip, top_share = None, 0.0
        if total > 0 and dest_bytes:
            top_ip = max(dest_bytes, key=dest_bytes.get)
            top_share = dest_bytes[top_ip] / total

        score, evidence = 0, []
        if vpn:
            score += 3
            evidence.append(f"{vpn} VPN-tunnel session(s) on WireGuard/OpenVPN/IPsec ports")
        if anon:
            score += 3
            evidence.append(f"{anon} Tor/proxy session(s)")
        # Concentration only means something with sustained activity — a single session
        # is trivially "100% to one host" and must not flag.
        enough = len(recs) >= 3
        if enough and top_ip and dest_cat.get(top_ip) == "hosting" and top_share >= 0.40:
            score += 2
            evidence.append(f"{round(top_share*100)}% of data funnelled to one cloud/VPS host "
                            f"({top_ip}) — tunnel-like concentration")
            endpoints.add(top_ip)
        elif enough and top_ip and top_share >= 0.75 and len(dest_bytes) >= 3 and dest_cat.get(top_ip) != "content":
            score += 1
            evidence.append(f"{round(top_share*100)}% of data to a single endpoint ({top_ip}) "
                            f"despite {len(dest_bytes)} destinations")
            endpoints.add(top_ip)
        if not score:
            continue
        out.append({
            "subject": subj,
            "score": score,
            "confidence": "high" if score >= 3 else ("medium" if score == 2 else "low"),
            "vpn_sessions": vpn,
            "proxy_tor_sessions": anon,
            "hosting_sessions": hosting,
            "top_endpoint": top_ip,
            "top_endpoint_share": round(top_share, 2),
            "endpoints": sorted(e for e in endpoints if e)[:8],
            "evidence": evidence,
        })
    return sorted(out, key=lambda x: x["score"], reverse=True)


# --- Orchestration ---------------------------------------------------------------

def _call_pairs(cdr_records):
    pairs = set()
    for r in cdr_records:
        a, b = _subject(r), getattr(r, "b_party_number", None)
        if a and b:
            pairs.add(tuple(sorted((a, b))))
    return pairs


def run_all(cdr_records, ipdr_records):
    """Compute every inference group over a batch of records. Returns a single report."""
    cdr_records = list(cdr_records)
    ipdr_records = list(ipdr_records)
    streams = build_subject_streams(cdr_records, ipdr_records)
    call_pairs = _call_pairs(cdr_records)

    movement = {s: subject_movement(ev) for s, ev in streams.items()}
    impossible = [{"subject": s, **m["impossible_travel"][0]}
                  for s, m in movement.items() if m["impossible_travel"]]
    behavioral = {}
    for s, ev in streams.items():
        odd = odd_hours_profile(ev)
        dark = going_dark(ev)
        dark = dark if (dark and dark["flag"]) else None
        bursts = activity_bursts(ev)
        if (odd and odd["flag"]) or dark or bursts:
            behavioral[s] = {"odd_hours": odd, "going_dark": dark, "bursts": bursts}

    devices = device_anomalies(cdr_records + ipdr_records)
    return {
        "subjects": len(streams),
        "movement": movement,
        "impossible_travel": impossible,
        "co_presence": co_presence(streams, call_pairs),
        "behavioral": behavioral,
        "periodic_contacts": periodic_contacts(cdr_records),
        "vpn_proxy": vpn_proxy_use(ipdr_records),
        "devices": devices,
        "clone_corroboration": clone_corroboration(streams, devices),
    }


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
    """Movement-annotated unified timeline for one subject (msisdn or imsi)."""
    cdr, ipdr = _load(db, limit, case_id)
    streams = build_subject_streams(cdr, ipdr)
    events = streams.get(subject, [])
    return {"subject": subject, "event_count": len(events),
            "movement": subject_movement(events) if events else None,
            "events": events}
