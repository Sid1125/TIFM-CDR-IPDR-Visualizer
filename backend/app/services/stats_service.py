from __future__ import annotations

from collections import Counter

from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord


def get_top_contacts(db, limit: int = 10):
    counts = Counter()
    for a_party, b_party in db.query(CDRRecord.a_party_number, CDRRecord.b_party_number).all():
        if a_party:
            counts[str(a_party)] += 1
        if b_party:
            counts[str(b_party)] += 1

    return [
        {"contact": contact, "count": count}
        for contact, count in counts.most_common(limit)
    ]


def get_cdr_stats(db):
    total_records = db.query(CDRRecord).count()
    unique_a_party = db.query(CDRRecord.a_party_number).distinct().count()
    unique_b_party = db.query(CDRRecord.b_party_number).distinct().count()
    total_duration = db.query(CDRRecord.duration_seconds).filter(CDRRecord.duration_seconds.isnot(None)).all()
    total_duration_sum = sum(d[0] for d in total_duration if d[0])
    avg_duration = total_duration_sum / len(total_duration) if total_duration else 0

    call_types = db.query(CDRRecord.call_type, CDRRecord.id).all()
    call_type_counts = {}
    for ct, _ in call_types:
        if ct:
            call_type_counts[ct] = call_type_counts.get(ct, 0) + 1

    directions = db.query(CDRRecord.direction, CDRRecord.id).all()
    direction_counts = {}
    for d, _ in directions:
        if d:
            direction_counts[d] = direction_counts.get(d, 0) + 1

    techs = db.query(CDRRecord.technology, CDRRecord.id).all()
    tech_counts = {}
    for t, _ in techs:
        if t:
            tech_counts[t] = tech_counts.get(t, 0) + 1

    return {
        "total_records": total_records,
        "unique_a_party": unique_a_party,
        "unique_b_party": unique_b_party,
        "total_duration_seconds": total_duration_sum,
        "avg_duration_seconds": round(avg_duration, 2),
        "call_type_distribution": call_type_counts,
        "direction_distribution": direction_counts,
        "technology_distribution": tech_counts,
    }


def get_ipdr_stats(db):
    total_records = db.query(IPDRRecord).count()
    total_uploaded = db.query(IPDRRecord.bytes_uploaded).filter(IPDRRecord.bytes_uploaded.isnot(None)).all()
    total_downloaded = db.query(IPDRRecord.bytes_downloaded).filter(IPDRRecord.bytes_downloaded.isnot(None)).all()
    total_uploaded_sum = sum(u[0] for u in total_uploaded if u[0])
    total_downloaded_sum = sum(d[0] for d in total_downloaded if d[0])

    protocols = db.query(IPDRRecord.protocol, IPDRRecord.id).all()
    protocol_counts = {}
    for p, _ in protocols:
        if p:
            protocol_counts[p] = protocol_counts.get(p, 0) + 1

    apns = db.query(IPDRRecord.apn, IPDRRecord.id).all()
    apn_counts = {}
    for a, _ in apns:
        if a:
            apn_counts[a] = apn_counts.get(a, 0) + 1

    rats = db.query(IPDRRecord.rat, IPDRRecord.id).all()
    rat_counts = {}
    for r, _ in rats:
        if r:
            rat_counts[r] = rat_counts.get(r, 0) + 1

    return {
        "total_records": total_records,
        "total_bytes_uploaded": total_uploaded_sum,
        "total_bytes_downloaded": total_downloaded_sum,
        "total_bytes": total_uploaded_sum + total_downloaded_sum,
        "protocol_distribution": protocol_counts,
        "apn_distribution": apn_counts,
        "rat_distribution": rat_counts,
    }
