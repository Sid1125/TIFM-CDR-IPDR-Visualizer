from __future__ import annotations

from collections import Counter, defaultdict

from sqlalchemy import func, or_

from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord
from app.models.tower import Tower
from app.services.geocode_service import geocode_missing


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


def tower_repo_stats(db) -> dict:
    """Headline stats for the permanent (case-independent) tower repository."""
    total = db.query(func.count(Tower.tower_id)).scalar() or 0
    with_coords = (
        db.query(func.count(Tower.tower_id))
        .filter(Tower.latitude.isnot(None), Tower.longitude.isnot(None))
        .scalar() or 0
    )
    state_rows = (
        db.query(Tower.state, func.count(Tower.tower_id))
        .group_by(Tower.state)
        .all()
    )
    by_state = sorted(
        [{"state": (s or "Unknown"), "count": c} for s, c in state_rows],
        key=lambda x: -x["count"],
    )
    cities = (
        db.query(func.count(func.distinct(Tower.city))).filter(Tower.city.isnot(None)).scalar() or 0
    )
    return {
        "total": total,
        "with_coords": with_coords,
        "without_coords": total - with_coords,
        "states_covered": sum(1 for s in by_state if s["state"] != "Unknown"),
        "cities_covered": cities,
        "by_state": by_state[:40],
    }


def tower_repo_list(db, search: str = "", limit: int = 300, offset: int = 0) -> dict:
    """Searchable, paginated listing of the tower repository (by tower_id / city / state)."""
    q = db.query(Tower)
    if search:
        like = f"%{search}%"
        q = q.filter(or_(Tower.tower_id.ilike(like), Tower.city.ilike(like), Tower.state.ilike(like)))
    total = q.count()
    rows = q.order_by(Tower.tower_id.asc()).offset(offset).limit(limit).all()
    return {
        "total": total,
        "rows": [
            {"tower_id": t.tower_id, "latitude": t.latitude, "longitude": t.longitude,
             "city": t.city, "state": t.state}
            for t in rows
        ],
    }


def rebuild_tower_repo(db) -> dict:
    """One-time backfill: harvest the tower repository from CDR/IPDR records already in the DB.
    Records carry authoritative tower_id + lat/lng, so this populates coordinates for towers that
    were registered (e.g. from an id-only CSV) without them. Inserts new towers, fills missing
    coordinates, and never clobbers existing coordinates or city/state. Newly-located towers are
    then reverse-geocoded offline to a city/state (only where missing). Idempotent."""
    best: dict = {}
    for model in (CDRRecord, IPDRRecord):
        rows = (
            db.query(model.tower_id, model.latitude, model.longitude)
            .filter(model.tower_id.isnot(None))
            .distinct()
            .all()
        )
        for tid, lat, lng in rows:
            if tid is None:
                continue
            tid = str(tid)
            cur = best.get(tid)
            if cur is None or (cur[0] is None and lat is not None):
                best[tid] = (lat, lng)
    existing = {t.tower_id: t for t in db.query(Tower).all()}
    added = updated = 0
    for tid, (lat, lng) in best.items():
        t = existing.get(tid)
        if t is None:
            db.add(Tower(tower_id=tid, latitude=lat, longitude=lng))
            added += 1
        else:
            changed = False
            if t.latitude is None and lat is not None:
                t.latitude = lat
                changed = True
            if t.longitude is None and lng is not None:
                t.longitude = lng
                changed = True
            if changed:
                updated += 1
    db.commit()
    geocoded = geocode_missing(db).get("filled", 0)
    return {"added": added, "updated": updated, "geocoded": geocoded,
            "total": db.query(func.count(Tower.tower_id)).scalar() or 0}


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
