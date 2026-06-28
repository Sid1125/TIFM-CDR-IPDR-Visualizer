"""Tower-dump analysis: the bulk 'who was on this cell during this window' workflow. Operates over
TowerDumpRecord rows, kept separate from CDR/IPDR. The headline report is common-numbers across
multiple dumps — a number present at several crime-scene towers/windows is a strong lead."""
from __future__ import annotations

from collections import defaultdict

from sqlalchemy.orm import Session

from app.models.tower_dump import TowerDumpRecord


def list_dumps(db: Session, case_id: str | None) -> list[dict]:
    """Per-dump summary via SQL GROUP BY — no full table scan."""
    from sqlalchemy import func as _func
    q = db.query(
        TowerDumpRecord.dump_label,
        _func.count(TowerDumpRecord.id).label("rows"),
        _func.count(_func.distinct(TowerDumpRecord.msisdn)).label("distinct_numbers"),
        _func.min(TowerDumpRecord.start_time).label("first"),
        _func.max(TowerDumpRecord.start_time).label("last"),
    ).group_by(TowerDumpRecord.dump_label)
    if case_id:
        q = q.filter(TowerDumpRecord.case_id == str(case_id))
    return sorted(
        [
            {
                "dump_label": r.dump_label,
                "rows": r.rows,
                "distinct_numbers": r.distinct_numbers,
                "first": r.first.isoformat() if r.first else None,
                "last": r.last.isoformat() if r.last else None,
            }
            for r in q.all()
        ],
        key=lambda x: x["dump_label"],
    )


def _rows(db: Session, case_id, labels):
    q = db.query(TowerDumpRecord)
    if case_id:
        q = q.filter(TowerDumpRecord.case_id == str(case_id))
    if labels:
        q = q.filter(TowerDumpRecord.dump_label.in_(list(labels)))
    return q.all()


def common_numbers(db: Session, case_id, labels, min_dumps: int = 2, limit: int = 1000) -> dict:
    """Numbers present in at least `min_dumps` of the selected dumps — 'at multiple scenes'."""
    labels = [l for l in (labels or []) if l]
    seen: dict[str, set] = defaultdict(set)
    imei_of: dict[str, set] = defaultdict(set)
    for r in _rows(db, case_id, labels):
        if r.msisdn:
            seen[r.msisdn].add(r.dump_label)
            if r.imei:
                imei_of[r.msisdn].add(r.imei)
    rows = []
    for num, dumps in seen.items():
        if len(dumps) >= min_dumps:
            rows.append({"msisdn": num, "dump_count": len(dumps),
                         "dumps": sorted(dumps), "imeis": sorted(imei_of.get(num, []))})
    rows.sort(key=lambda x: (-x["dump_count"], x["msisdn"]))
    return {"labels": labels, "min_dumps": min_dumps,
            "total": len(rows), "rows": rows[:limit]}


def uncommon_numbers(db: Session, case_id, labels, limit: int = 2000) -> dict:
    """Numbers that appear in exactly ONE of the selected dumps — useful for elimination."""
    labels = [l for l in (labels or []) if l]
    seen: dict[str, set] = defaultdict(set)
    for r in _rows(db, case_id, labels):
        if r.msisdn:
            seen[r.msisdn].add(r.dump_label)
    rows = [{"msisdn": num, "dump": next(iter(dumps))}
            for num, dumps in seen.items() if len(dumps) == 1]
    rows.sort(key=lambda x: (x["dump"], x["msisdn"]))
    return {"labels": labels, "total": len(rows), "rows": rows[:limit]}


def under_tower(db: Session, case_id, label, limit: int = 5000) -> dict:
    """Every number under one dump with its appearance count (and IMEIs)."""
    counts: dict[str, int] = defaultdict(int)
    imeis: dict[str, set] = defaultdict(set)
    for r in _rows(db, case_id, [label] if label else None):
        if r.msisdn:
            counts[r.msisdn] += 1
            if r.imei:
                imeis[r.msisdn].add(r.imei)
    rows = [{"msisdn": k, "appearances": v, "imeis": sorted(imeis.get(k, []))}
            for k, v in counts.items()]
    rows.sort(key=lambda x: (-x["appearances"], x["msisdn"]))
    return {"label": label, "total": len(rows), "rows": rows[:limit]}


def device_multiplicity(db: Session, case_id, labels, limit: int = 1000) -> dict:
    """SIMs (MSISDN) used with >1 IMEI, and IMEIs used with >1 SIM — handset-swap / shared-device
    signals within the selected dumps."""
    labels = [l for l in (labels or []) if l]
    sim_to_imei: dict[str, set] = defaultdict(set)
    imei_to_sim: dict[str, set] = defaultdict(set)
    for r in _rows(db, case_id, labels):
        if r.msisdn and r.imei:
            sim_to_imei[r.msisdn].add(r.imei)
            imei_to_sim[r.imei].add(r.msisdn)
    imeis_per_sim = [{"msisdn": k, "imeis": sorted(v)} for k, v in sim_to_imei.items() if len(v) > 1]
    sims_per_imei = [{"imei": k, "msisdns": sorted(v)} for k, v in imei_to_sim.items() if len(v) > 1]
    imeis_per_sim.sort(key=lambda x: -len(x["imeis"]))
    sims_per_imei.sort(key=lambda x: -len(x["msisdns"]))
    return {"labels": labels,
            "imeis_per_sim": imeis_per_sim[:limit],
            "sims_per_imei": sims_per_imei[:limit]}
