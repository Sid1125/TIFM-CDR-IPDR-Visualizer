from __future__ import annotations

from collections import Counter, defaultdict

from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord
from app.models.tower import Tower


def list_tower_activity(db):
    towers = db.query(Tower).all()

    cdr_counts = Counter()
    for tower_id, _record_id in db.query(CDRRecord.tower_id, CDRRecord.id).all():
        if tower_id:
            cdr_counts[str(tower_id)] += 1

    ipdr_counts = Counter()
    for tower_id, _record_id in db.query(IPDRRecord.tower_id, IPDRRecord.id).all():
        if tower_id:
            ipdr_counts[str(tower_id)] += 1

    return [
        {
            "tower_id": tower.tower_id,
            "city": tower.city,
            "state": tower.state,
            "latitude": tower.latitude,
            "longitude": tower.longitude,
            "cdr_events": cdr_counts.get(tower.tower_id, 0),
            "ipdr_events": ipdr_counts.get(tower.tower_id, 0),
        }
        for tower in towers
    ]


def find_colocation_candidates(db, limit: int = 50):
    cdr_rows = db.query(CDRRecord.a_party_number, CDRRecord.b_party_number, CDRRecord.tower_id, CDRRecord.start_time).all()
    tower_to_subjects = defaultdict(set)

    for a_party, b_party, tower_id, _start_time in cdr_rows:
        if not tower_id:
            continue
        if a_party:
            tower_to_subjects[str(tower_id)].add(str(a_party))
        if b_party:
            tower_to_subjects[str(tower_id)].add(str(b_party))

    candidates = []
    for tower_id, subjects in tower_to_subjects.items():
        if len(subjects) >= 2:
            candidates.append(
                {
                    "tower_id": tower_id,
                    "subject_count": len(subjects),
                    "subjects": sorted(subjects)[:limit],
                }
            )

    return sorted(candidates, key=lambda item: item["subject_count"], reverse=True)[:limit]
