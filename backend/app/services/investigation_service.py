from __future__ import annotations

from datetime import datetime

from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord
from app.models.tower import Tower
from app.services.service_attribution_service import FAMILY_GAP_MAP
from app.services.service_attribution_service import PORT_FAMILY_MAP
from app.services.service_attribution_service import attribute_service

# Port -> activity family and family -> session idle gap come from the shared
# attribution_data.json (see service_attribution_service), keeping reconstruction
# thresholds consistent with the frontend.
_FAMILY_GAP = FAMILY_GAP_MAP


def _port_family(record: IPDRRecord) -> str:
    for raw in (record.destination_port, record.source_port):
        try:
            port = int(raw)
        except (TypeError, ValueError):
            continue
        if port in PORT_FAMILY_MAP:
            return PORT_FAMILY_MAP[port]
    return "Other"


def _to_int(value) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _finalize_session(recs):
    starts = [r.start_time for r in recs if r.start_time]
    ends = [r.end_time or r.start_time for r in recs if (r.end_time or r.start_time)]
    start = min(starts) if starts else None
    end = max(ends) if ends else start
    duration = int((end - start).total_seconds()) if (start and end) else None
    # Representative attribution = the most confident classification across the session.
    best = max((attribute_service(r) for r in recs), key=lambda a: a.get("confidence", 0))
    return {
        "start": start,
        "end": end,
        "duration_seconds": duration,
        "subject": recs[0].source_ip,
        "peer": recs[0].destination_ip,
        "tower_id": recs[0].tower_id,
        "service": best["service"],
        "subtype": best.get("subtype"),
        "confidence": best.get("confidence"),
        "family": best.get("family"),
        "record_count": len(recs),
        "bytes_uploaded": sum(_to_int(r.bytes_uploaded) for r in recs),
        "bytes_downloaded": sum(_to_int(r.bytes_downloaded) for r in recs),
        "evidence": best.get("evidence", []),
    }


def reconstruct_ipdr_sessions(records):
    """Group IPDR records into sessions. Records are bucketed into concurrent tracks
    keyed by (counterpart IP, activity family) so interleaved conversations form coherent
    parallel sessions, and each track is split on a family-adaptive idle gap."""
    ordered = sorted(records, key=lambda r: r.start_time or datetime.min)
    open_tracks: dict = {}
    sessions = []

    def flush(key):
        track = open_tracks.pop(key, None)
        if track and track["recs"]:
            sessions.append(_finalize_session(track["recs"]))

    for record in ordered:
        family = _port_family(record)
        key = (record.destination_ip or "?", family)
        ts = record.start_time
        track = open_tracks.get(key)
        if track and ts and track["last"] and (ts - track["last"]).total_seconds() > _FAMILY_GAP.get(family, 300):
            flush(key)
            track = None
        if track is None:
            open_tracks[key] = {"recs": [record], "last": ts}
        else:
            track["recs"].append(record)
            if ts:
                track["last"] = ts

    for key in list(open_tracks):
        flush(key)
    sessions.sort(key=lambda s: (s["start"] is None, s["start"] or datetime.min))
    return sessions


def _cdr_movement(records):
    """Per-subject (a_party) movement delta between consecutive located calls, so the
    timeline carries distance/speed/mode and impossible-travel flags, not just events."""
    from app.services.geo import IMPOSSIBLE_KMH, classify_speed, haversine_km

    by_subject = {}
    for r in records:
        by_subject.setdefault(r.a_party_number, []).append(r)
    moves = {}
    for subj, recs in by_subject.items():
        recs.sort(key=lambda r: r.start_time or datetime.min)
        prev = None
        for r in recs:
            if prev and prev.start_time and r.start_time:
                dist = haversine_km(prev.latitude, prev.longitude, r.latitude, r.longitude)
                dt_min = (r.start_time - prev.start_time).total_seconds() / 60.0
                if dist is not None and dist >= 1.0 and dt_min > 0:
                    speed = dist / (dt_min / 60.0)
                    moves[id(r)] = {
                        "from_tower": prev.tower_id, "distance_km": round(dist, 2),
                        "dt_minutes": round(dt_min, 1), "speed_kmh": round(speed, 1),
                        "mode": classify_speed(speed),
                        "impossible": bool(speed > IMPOSSIBLE_KMH and dist >= 5.0),
                    }
                elif dist is not None and dist >= 5.0 and dt_min <= 0:
                    # Same-minute records at far towers: undefined (infinite) speed, impossible.
                    moves[id(r)] = {
                        "from_tower": prev.tower_id, "distance_km": round(dist, 2),
                        "dt_minutes": round(dt_min, 1), "speed_kmh": None,
                        "mode": "impossible", "impossible": True,
                    }
            prev = r
    return moves


def find_meetings(db, case_id=None, subject=None, window_min: int = 60, limit: int = 500):
    """Exact, full-coverage co-location ("meeting") detection: two phones at the SAME tower
    within ``window_min`` minutes. Server-side and case-scoped, this replaces the client-side
    O(n^2) detectMeetings (which also sampled only the top-30 subjects). Uses a time-sorted
    sweep with an early break once the window is exceeded, so it is ~O(n * window-density) and
    scales to large cases. ``subject`` keeps only encounters involving that number. Returns the
    encounters sorted by smallest gap (tightest = most likely a real meeting), capped to
    ``limit`` rows for transport; the detection itself is exhaustive.

    CDR-only: a "meeting" is two people physically co-located at a cell, so IPDR (IP endpoints)
    is intentionally excluded — consistent with the strict CDR/IPDR separation."""
    q = db.query(
        CDRRecord.start_time, CDRRecord.a_party_number, CDRRecord.tower_id,
        CDRRecord.latitude, CDRRecord.longitude,
    ).filter(
        CDRRecord.start_time.isnot(None), CDRRecord.tower_id.isnot(None),
        CDRRecord.a_party_number.isnot(None),
    )
    if case_id:
        q = q.filter(CDRRecord.case_id == case_id)
    located = sorted(q.all(), key=lambda r: r[0])

    window = window_min * 60
    out = []
    n = len(located)
    for i in range(n):
        ti, si, twi, lai, loi = located[i]
        for j in range(i + 1, n):
            tj, sj, twj, laj, loj = located[j]
            if (tj - ti).total_seconds() > window:
                break
            if si == sj or twi != twj:
                continue
            if subject and subject not in (si, sj):
                continue
            gap_min = round((tj - ti).total_seconds() / 60.0, 1)
            out.append({
                "subject_a": si, "subject_b": sj, "tower_id": twi,
                "latitude": lai, "longitude": loi,
                "time_a": ti, "time_b": tj, "gap_min": gap_min,
                "confidence": "High" if gap_min < 5 else "Medium" if gap_min < 15 else "Low",
            })
    out.sort(key=lambda m: m["gap_min"])
    pairs = {tuple(sorted((m["subject_a"], m["subject_b"]))) for m in out}
    levels = {"High": 0, "Medium": 0, "Low": 0}
    for m in out:
        levels[m["confidence"]] += 1
    return {
        "total": len(out), "distinct_pairs": len(pairs),
        "high": levels["High"], "medium": levels["Medium"], "low": levels["Low"],
        "meetings": out[:limit],
    }


def build_unified_timeline(db, limit: int = 200, case_id=None):
    events = []

    cdr_q = db.query(CDRRecord)
    if case_id:
        cdr_q = cdr_q.filter(CDRRecord.case_id == case_id)
    cdr_records = cdr_q.order_by(CDRRecord.start_time).limit(limit).all()
    moves = _cdr_movement(cdr_records)
    for record in cdr_records:
        details = {"duration": record.duration_seconds}
        move = moves.get(id(record))
        if move:
            details["move"] = move
        events.append(
            {
                "time": record.start_time,
                "event_type": "Voice Call",
                "service": "Voice",
                "subject": record.a_party_number,
                "peer": record.b_party_number,
                "tower_id": record.tower_id,
                "details": details,
            }
        )

    ipdr_q = db.query(IPDRRecord)
    if case_id:
        ipdr_q = ipdr_q.filter(IPDRRecord.case_id == case_id)
    ipdr_records = ipdr_q.order_by(IPDRRecord.start_time).limit(limit).all()
    for session in reconstruct_ipdr_sessions(ipdr_records):
        events.append(
            {
                "time": session["start"],
                "event_type": "IP Session",
                "service": session["service"],
                "confidence": session["confidence"],
                "subject": session["subject"],
                "peer": session["peer"],
                "tower_id": session["tower_id"],
                "details": {
                    "subtype": session["subtype"],
                    "family": session["family"],
                    "end": session["end"],
                    "duration_seconds": session["duration_seconds"],
                    "record_count": session["record_count"],
                    "bytes_uploaded": session["bytes_uploaded"],
                    "bytes_downloaded": session["bytes_downloaded"],
                    "evidence": session["evidence"],
                },
            }
        )

    for tower in db.query(Tower).all():
        events.append(
            {
                "time": None,
                "event_type": "Tower Known",
                "service": "Tower Registry",
                "subject": tower.tower_id,
                "peer": None,
                "tower_id": tower.tower_id,
                "details": {
                    "city": tower.city,
                    "state": tower.state,
                    "latitude": tower.latitude,
                    "longitude": tower.longitude,
                },
            }
        )

    return sorted(events, key=lambda event: (event["time"] is None, event["time"] or datetime.min))
