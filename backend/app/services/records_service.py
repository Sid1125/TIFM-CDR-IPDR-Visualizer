from __future__ import annotations

from sqlalchemy import or_

from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord


def list_cdr_records(
    db,
    start_date=None,
    end_date=None,
    tower_id=None,
    search=None,
    msisdn=None,
    imsi=None,
    imei=None,
    call_type=None,
    direction=None,
    case_id=None,
    limit: int = 0,
    offset: int = 0,
):
    query = db.query(CDRRecord)

    if start_date is not None:
        query = query.filter(CDRRecord.start_time >= start_date)
    if end_date is not None:
        query = query.filter(CDRRecord.start_time <= end_date)
    if tower_id:
        query = query.filter(CDRRecord.tower_id == tower_id)
    if msisdn:
        query = query.filter(CDRRecord.msisdn == msisdn)
    if imsi:
        query = query.filter(CDRRecord.imsi == imsi)
    if imei:
        query = query.filter(CDRRecord.imei == imei)
    if call_type:
        query = query.filter(CDRRecord.call_type == call_type)
    if direction:
        query = query.filter(CDRRecord.direction == direction)
    if case_id is not None:
        query = query.filter(CDRRecord.case_id == str(case_id))
    if search:
        like = f"%{search}%"
        query = query.filter(
            or_(
                CDRRecord.a_party_number.ilike(like),
                CDRRecord.b_party_number.ilike(like),
                CDRRecord.tower_id.ilike(like),
                CDRRecord.case_id.ilike(like),
                CDRRecord.msisdn.ilike(like),
                CDRRecord.imsi.ilike(like),
                CDRRecord.imei.ilike(like),
            )
        )

    q = query.order_by(CDRRecord.start_time.desc()).offset(offset)
    if limit > 0:
        q = q.limit(limit)
    return q.all()


def list_ipdr_records(
    db,
    start_date=None,
    end_date=None,
    tower_id=None,
    search=None,
    msisdn=None,
    imsi=None,
    imei=None,
    protocol=None,
    apn=None,
    rat=None,
    case_id=None,
    limit: int = 0,
    offset: int = 0,
):
    query = db.query(IPDRRecord)

    if start_date is not None:
        query = query.filter(IPDRRecord.start_time >= start_date)
    if end_date is not None:
        query = query.filter(IPDRRecord.start_time <= end_date)
    if tower_id:
        query = query.filter(IPDRRecord.tower_id == tower_id)
    if msisdn:
        query = query.filter(IPDRRecord.msisdn == msisdn)
    if imsi:
        query = query.filter(IPDRRecord.imsi == imsi)
    if imei:
        query = query.filter(IPDRRecord.imei == imei)
    if protocol:
        query = query.filter(IPDRRecord.protocol == protocol)
    if apn:
        query = query.filter(IPDRRecord.apn == apn)
    if rat:
        query = query.filter(IPDRRecord.rat == rat)
    if case_id is not None:
        query = query.filter(IPDRRecord.case_id == str(case_id))
    if search:
        like = f"%{search}%"
        query = query.filter(
            or_(
                IPDRRecord.source_ip.ilike(like),
                IPDRRecord.destination_ip.ilike(like),
                IPDRRecord.protocol.ilike(like),
                IPDRRecord.tower_id.ilike(like),
                IPDRRecord.case_id.ilike(like),
                IPDRRecord.msisdn.ilike(like),
                IPDRRecord.imsi.ilike(like),
                IPDRRecord.imei.ilike(like),
                IPDRRecord.apn.ilike(like),
            )
        )

    q = query.order_by(IPDRRecord.start_time.desc()).offset(offset)
    if limit > 0:
        q = q.limit(limit)
    return q.all()

