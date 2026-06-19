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


def build_unified_timeline(db, limit: int = 200):
    events = []

    for record in db.query(CDRRecord).order_by(CDRRecord.start_time).limit(limit).all():
        events.append(
            {
                "time": record.start_time,
                "event_type": "Voice Call",
                "service": "Voice",
                "subject": record.a_party_number,
                "peer": record.b_party_number,
                "tower_id": record.tower_id,
                "details": {"duration": record.duration_seconds},
            }
        )

    ipdr_records = db.query(IPDRRecord).order_by(IPDRRecord.start_time).limit(limit).all()
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
