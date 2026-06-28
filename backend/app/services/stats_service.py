from __future__ import annotations

from collections import Counter

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord


def get_top_contacts(db: Session, limit: int = 10, case_id: str | None = None) -> list[dict]:
    """Top contacts by total CDR involvement (union of a_party + b_party appearances)."""
    cnt: Counter = Counter()

    def _cq(*cols):
        q = db.query(*cols)
        return q.filter(CDRRecord.case_id == case_id) if case_id else q

    for row in _cq(CDRRecord.a_party_number, func.count(CDRRecord.id)).filter(CDRRecord.a_party_number.isnot(None)).group_by(CDRRecord.a_party_number).all():
        cnt[str(row[0])] += row[1]
    for row in _cq(CDRRecord.b_party_number, func.count(CDRRecord.id)).filter(CDRRecord.b_party_number.isnot(None)).group_by(CDRRecord.b_party_number).all():
        cnt[str(row[0])] += row[1]

    return [{"contact": c, "count": n} for c, n in cnt.most_common(limit)]


def get_cdr_stats(db: Session, case_id: str | None = None) -> dict:
    def cq(*cols):
        q = db.query(*cols)
        return q.filter(CDRRecord.case_id == case_id) if case_id else q

    row = cq(
        func.count(CDRRecord.id).label("total"),
        func.sum(CDRRecord.duration_seconds).label("dur_sum"),
        func.count(func.distinct(CDRRecord.a_party_number)).label("uniq_a"),
        func.count(func.distinct(CDRRecord.b_party_number)).label("uniq_b"),
        func.min(CDRRecord.start_time).label("min_ts"),
        func.max(CDRRecord.start_time).label("max_ts"),
    ).one()

    total = row.total or 0
    dur_sum = int(row.dur_sum or 0)
    avg_dur = round(dur_sum / total, 2) if total else 0.0

    call_type_counts = dict(
        cq(CDRRecord.call_type, func.count(CDRRecord.id))
        .filter(CDRRecord.call_type.isnot(None))
        .group_by(CDRRecord.call_type)
        .all()
    )
    direction_counts = dict(
        cq(CDRRecord.direction, func.count(CDRRecord.id))
        .filter(CDRRecord.direction.isnot(None))
        .group_by(CDRRecord.direction)
        .all()
    )
    tech_counts = dict(
        cq(CDRRecord.technology, func.count(CDRRecord.id))
        .filter(CDRRecord.technology.isnot(None))
        .group_by(CDRRecord.technology)
        .all()
    )

    return {
        "total_records": total,
        "unique_a_party": row.uniq_a or 0,
        "unique_b_party": row.uniq_b or 0,
        "total_duration_seconds": dur_sum,
        "avg_duration_seconds": avg_dur,
        "call_type_distribution": call_type_counts,
        "direction_distribution": direction_counts,
        "technology_distribution": tech_counts,
        "date_range": {
            "min": row.min_ts.isoformat() if row.min_ts else None,
            "max": row.max_ts.isoformat() if row.max_ts else None,
        },
    }


def get_ipdr_stats(db: Session, case_id: str | None = None) -> dict:
    def iq(*cols):
        q = db.query(*cols)
        return q.filter(IPDRRecord.case_id == case_id) if case_id else q

    row = iq(
        func.count(IPDRRecord.id).label("total"),
        func.sum(IPDRRecord.bytes_uploaded).label("up_sum"),
        func.sum(IPDRRecord.bytes_downloaded).label("dn_sum"),
        func.count(func.distinct(IPDRRecord.msisdn)).label("uniq_msisdn"),
        func.min(IPDRRecord.start_time).label("min_ts"),
        func.max(IPDRRecord.start_time).label("max_ts"),
    ).one()

    up = int(row.up_sum or 0)
    dn = int(row.dn_sum or 0)

    protocol_counts = dict(
        iq(IPDRRecord.protocol, func.count(IPDRRecord.id))
        .filter(IPDRRecord.protocol.isnot(None))
        .group_by(IPDRRecord.protocol)
        .all()
    )
    apn_counts = dict(
        iq(IPDRRecord.apn, func.count(IPDRRecord.id))
        .filter(IPDRRecord.apn.isnot(None))
        .group_by(IPDRRecord.apn)
        .all()
    )
    rat_counts = dict(
        iq(IPDRRecord.rat, func.count(IPDRRecord.id))
        .filter(IPDRRecord.rat.isnot(None))
        .group_by(IPDRRecord.rat)
        .all()
    )

    return {
        "total_records": row.total or 0,
        "total_bytes_uploaded": up,
        "total_bytes_downloaded": dn,
        "total_bytes": up + dn,
        "unique_msisdn": row.uniq_msisdn or 0,
        "protocol_distribution": protocol_counts,
        "apn_distribution": apn_counts,
        "rat_distribution": rat_counts,
        "date_range": {
            "min": row.min_ts.isoformat() if row.min_ts else None,
            "max": row.max_ts.isoformat() if row.max_ts else None,
        },
    }
