from fastapi import APIRouter
from fastapi import Depends
from sqlalchemy import false, or_
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord
from app.models.tower import Tower

router = APIRouter()

GEO_ROW_CAP = 10_000  # max records per type returned by /geo/records


def _load_tower_map(db: Session) -> dict:
    """Return {tower_id: Tower} for all towers with coordinates."""
    return {
        t.tower_id: t
        for t in db.query(Tower).filter(
            Tower.latitude.isnot(None), Tower.longitude.isnot(None)
        ).all()
    }


def _tower_dict(t: Tower) -> dict:
    return {
        "tower_id": t.tower_id,
        "latitude": t.latitude,
        "longitude": t.longitude,
        "city": t.city,
        "state": t.state,
    }


def _located_filter(lat_col, tid_col, tower_ids: list):
    """SQLAlchemy filter: direct lat/lon OR tower_id resolves to coordinates."""
    if tower_ids:
        return or_(lat_col.isnot(None), tid_col.in_(tower_ids))
    return lat_col.isnot(None)


@router.get("/records")
def get_geo_records(subject: str = "", case_id: str = "", db: Session = Depends(get_db)):
    # Pre-load towers with coordinates so CDR/IPDR records that carry only a tower_id
    # (the common operator format) can still be placed on the map.
    tower_map = _load_tower_map(db)
    tower_ids = list(tower_map.keys())

    results = []

    cdr_q = db.query(CDRRecord).filter(
        _located_filter(CDRRecord.latitude, CDRRecord.tower_id, tower_ids)
    )
    if case_id:
        cdr_q = cdr_q.filter(CDRRecord.case_id == case_id)
    for r in cdr_q.limit(GEO_ROW_CAP).all():
        a = r.a_party_number or ""
        b = r.b_party_number or ""
        if subject and subject not in a and subject not in b:
            continue
        tid = r.tower_id or ""
        lat, lon = r.latitude, r.longitude
        tower_info = None
        if tid and tid in tower_map:
            t = tower_map[tid]
            tower_info = _tower_dict(t)
            if lat is None:
                lat = t.latitude
            if lon is None:
                lon = t.longitude
        if lat is None or lon is None:
            continue
        results.append({
            "type": "CDR",
            "id": r.id,
            "subject": a,
            "counterpart": b,
            "tower_id": tid,
            "cell_id": r.cell_id,
            "lac": r.lac,
            "latitude": lat,
            "longitude": lon,
            "start_time": r.start_time.isoformat() if r.start_time else None,
            "end_time": r.end_time.isoformat() if r.end_time else None,
            "duration_seconds": r.duration_seconds,
            "call_type": r.call_type,
            "direction": r.direction,
            "msisdn": r.msisdn,
            "imsi": r.imsi,
            "imei": r.imei,
            "technology": r.technology,
            "tower": tower_info,
        })

    ipdr_q = db.query(IPDRRecord).filter(
        _located_filter(IPDRRecord.latitude, IPDRRecord.tower_id, tower_ids)
    )
    if case_id:
        ipdr_q = ipdr_q.filter(IPDRRecord.case_id == case_id)
    for r in ipdr_q.limit(GEO_ROW_CAP).all():
        sip = r.source_ip or ""
        dip = r.destination_ip or ""
        if subject and subject not in sip and subject not in dip and subject not in (r.msisdn or ""):
            continue
        tid = r.tower_id or ""
        lat, lon = r.latitude, r.longitude
        tower_info = None
        if tid and tid in tower_map:
            t = tower_map[tid]
            tower_info = _tower_dict(t)
            if lat is None:
                lat = t.latitude
            if lon is None:
                lon = t.longitude
        if lat is None or lon is None:
            continue
        results.append({
            "type": "IPDR",
            "id": r.id,
            "subject": sip,
            "counterpart": dip,
            "tower_id": tid,
            "cell_id": r.cell_id,
            "lac": r.lac,
            "latitude": lat,
            "longitude": lon,
            "start_time": r.start_time.isoformat() if r.start_time else None,
            "end_time": r.end_time.isoformat() if r.end_time else None,
            "duration_seconds": r.duration_seconds,
            "source_port": r.source_port,
            "destination_port": r.destination_port,
            "protocol": r.protocol,
            "bytes_uploaded": r.bytes_uploaded,
            "bytes_downloaded": r.bytes_downloaded,
            "msisdn": r.msisdn,
            "imsi": r.imsi,
            "imei": r.imei,
            "apn": r.apn,
            "rat": r.rat,
            "tower": tower_info,
        })

    results.sort(key=lambda x: x["start_time"] or "", reverse=True)
    return results


@router.get("/subjects")
def get_subjects(case_id: str = "", db: Session = Depends(get_db)):
    # Subjects that appear in *located* records (direct lat/lon or tower-resolvable).
    # Only the A-party / source_ip (the device whose movement we track) — never the
    # B-party / destination_ip, which is a remote endpoint with no movement to show.
    tower_ids = [
        r[0]
        for r in db.query(Tower.tower_id).filter(
            Tower.latitude.isnot(None), Tower.longitude.isnot(None)
        ).all()
    ]

    subjects: set = set()

    cdr_q = db.query(CDRRecord.a_party_number, CDRRecord.msisdn).filter(
        _located_filter(CDRRecord.latitude, CDRRecord.tower_id, tower_ids)
    )
    if case_id:
        cdr_q = cdr_q.filter(CDRRecord.case_id == case_id)
    for a, m in cdr_q.distinct().all():
        if a:
            subjects.add(a)
        if m:
            subjects.add(m)

    ipdr_q = db.query(IPDRRecord.source_ip).filter(
        _located_filter(IPDRRecord.latitude, IPDRRecord.tower_id, tower_ids)
    )
    if case_id:
        ipdr_q = ipdr_q.filter(IPDRRecord.case_id == case_id)
    for (s,) in ipdr_q.distinct().all():
        if s:
            subjects.add(s)

    return sorted(subjects)


@router.get("/towers")
def get_all_towers(db: Session = Depends(get_db)):
    towers = db.query(Tower).all()
    return [
        {
            "tower_id": t.tower_id,
            "latitude": t.latitude,
            "longitude": t.longitude,
            "city": t.city,
            "state": t.state,
        }
        for t in towers
    ]
