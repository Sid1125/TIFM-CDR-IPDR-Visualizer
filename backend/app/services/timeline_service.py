from __future__ import annotations

from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord
from app.models.tower import Tower
from app.services.service_attribution_service import attribute_service


def get_timeline(db, limit: int = 500):
    events = []

    for record in db.query(CDRRecord).order_by(CDRRecord.start_time).limit(limit).all():
        events.append(
            {
                "time": record.start_time,
                "event_type": "Voice Call",
                "event": f"{record.a_party_number} called {record.b_party_number}",
                "subject": record.a_party_number,
                "peer": record.b_party_number,
                "duration": record.duration_seconds,
                "tower_id": record.tower_id,
            }
        )

    for record in db.query(IPDRRecord).order_by(IPDRRecord.start_time).limit(limit).all():
        attribution = attribute_service(record)
        events.append(
            {
                "time": record.start_time,
                "event_type": "IP Session",
                "event": f"{record.source_ip} -> {record.destination_ip}",
                "subject": record.source_ip,
                "peer": record.destination_ip,
                "service": attribution["service"],
                "confidence": attribution["confidence"],
                "tower_id": record.tower_id,
            }
        )

    for tower in db.query(Tower).all():
        events.append(
            {
                "time": None,
                "event_type": "Tower Registry",
                "event": f"Tower {tower.tower_id} registered",
                "subject": tower.tower_id,
                "peer": None,
                "tower_id": tower.tower_id,
            }
        )

    return sorted(events, key=lambda item: (item["time"] is None, item["time"] or 0))
