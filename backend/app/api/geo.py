from fastapi import APIRouter
from fastapi import Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord
from app.models.tower import Tower

router = APIRouter()


def _tower_info(db: Session, tower_id: str):
    t = db.query(Tower).filter(Tower.tower_id == tower_id).first()
    if not t:
        return None
    return {
        "tower_id": t.tower_id,
        "latitude": t.latitude,
        "longitude": t.longitude,
        "city": t.city,
        "state": t.state,
    }


@router.get("/records")
def get_geo_records(subject: str = "", case_id: str = "", db: Session = Depends(get_db)):
    tower_cache = {}
    results = []

    cdr_q = db.query(CDRRecord).filter(
        CDRRecord.latitude.isnot(None),
        CDRRecord.longitude.isnot(None),
    )
    if case_id:
        cdr_q = cdr_q.filter(CDRRecord.case_id == case_id)
    cdr_rows = cdr_q.all()
    for r in cdr_rows:
        a = r.a_party_number or ""
        b = r.b_party_number or ""
        if subject and subject not in a and subject not in b:
            continue
        tid = r.tower_id or ""
        if tid and tid not in tower_cache:
            tower_cache[tid] = _tower_info(db, tid)
        results.append({
            "type": "CDR",
            "id": r.id,
            "subject": a,
            "counterpart": b,
            "tower_id": tid,
            "cell_id": r.cell_id,
            "lac": r.lac,
            "latitude": r.latitude,
            "longitude": r.longitude,
            "start_time": r.start_time.isoformat() if r.start_time else None,
            "end_time": r.end_time.isoformat() if r.end_time else None,
            "duration_seconds": r.duration_seconds,
            "call_type": r.call_type,
            "direction": r.direction,
            "msisdn": r.msisdn,
            "imsi": r.imsi,
            "imei": r.imei,
            "technology": r.technology,
            "tower": tower_cache.get(tid),
        })

    ipdr_q = db.query(IPDRRecord).filter(
        IPDRRecord.latitude.isnot(None),
        IPDRRecord.longitude.isnot(None),
    )
    if case_id:
        ipdr_q = ipdr_q.filter(IPDRRecord.case_id == case_id)
    ipdr_rows = ipdr_q.all()
    for r in ipdr_rows:
        sip = r.source_ip or ""
        dip = r.destination_ip or ""
        if subject and subject not in sip and subject not in dip and subject not in (r.msisdn or ""):
            continue
        tid = r.tower_id or ""
        if tid and tid not in tower_cache:
            tower_cache[tid] = _tower_info(db, tid)
        results.append({
            "type": "IPDR",
            "id": r.id,
            "subject": sip,
            "counterpart": dip,
            "tower_id": tid,
            "cell_id": r.cell_id,
            "lac": r.lac,
            "latitude": r.latitude,
            "longitude": r.longitude,
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
            "tower": tower_cache.get(tid),
        })

    results.sort(key=lambda x: x["start_time"] or "", reverse=True)
    return results


@router.get("/subjects")
def get_subjects(case_id: str = "", db: Session = Depends(get_db)):
    # Only *located parties* that appear in geo-TAGGED records (lat/lon present): the device
    # whose own position is recorded, never the remote endpoint it contacted. For CDR that is
    # the A-party (and msisdn); for IPDR it is the source_ip. The B-party / destination_ip is
    # the counterpart — e.g. a CDN or DNS server like 1.1.1.1 — and has no movement of its own,
    # so including it produced "subjects" whose every map mode came up empty. This also keeps
    # the picker consistent with the strict CDR/IPDR subject definitions.
    subjects = set()
    cdr_q = db.query(CDRRecord.a_party_number, CDRRecord.msisdn).filter(
        CDRRecord.latitude.isnot(None), CDRRecord.longitude.isnot(None))
    if case_id:
        cdr_q = cdr_q.filter(CDRRecord.case_id == case_id)
    for a, m in cdr_q.all():
        if a:
            subjects.add(a)
        if m:
            subjects.add(m)
    ipdr_q = db.query(IPDRRecord.source_ip).filter(
        IPDRRecord.latitude.isnot(None), IPDRRecord.longitude.isnot(None))
    if case_id:
        ipdr_q = ipdr_q.filter(IPDRRecord.case_id == case_id)
    for (s,) in ipdr_q.all():
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
