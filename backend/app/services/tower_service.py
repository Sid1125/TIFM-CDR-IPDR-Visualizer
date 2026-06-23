from __future__ import annotations

from collections import Counter, defaultdict

from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord
from app.models.tower import Tower


def list_tower_activity(db, case_id=None):
    towers = db.query(Tower).all()

    cq = db.query(CDRRecord.tower_id, CDRRecord.id)
    iq = db.query(IPDRRecord.tower_id, IPDRRecord.id)
    if case_id:
        cq = cq.filter(CDRRecord.case_id == case_id)
        iq = iq.filter(IPDRRecord.case_id == case_id)

    cdr_counts = Counter()
    for tower_id, _record_id in cq.all():
        if tower_id:
            cdr_counts[str(tower_id)] += 1

    ipdr_counts = Counter()
    for tower_id, _record_id in iq.all():
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


def find_colocation_candidates(db, limit: int = 50, case_id=None):
    cdr_q = db.query(CDRRecord.a_party_number, CDRRecord.b_party_number, CDRRecord.tower_id, CDRRecord.start_time)
    if case_id:
        cdr_q = cdr_q.filter(CDRRecord.case_id == case_id)
    cdr_rows = cdr_q.all()
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
