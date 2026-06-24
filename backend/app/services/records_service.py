from __future__ import annotations

from sqlalchemy import or_, literal, union_all, select, func, desc

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


def _cdr_id_select(case_id=None, search=None, service=None):
    """A (id, rtype, ts) projection over CDR for the unified page query — only the columns
    needed to sort+paginate across both tables; full rows are hydrated afterwards."""
    s = select(
        CDRRecord.id.label("rid"),
        literal("CDR").label("rtype"),
        CDRRecord.start_time.label("ts"),
    )
    if case_id is not None:
        s = s.where(CDRRecord.case_id == str(case_id))
    if service:  # CDR "service" maps to call_type (Voice/SMS/…)
        s = s.where(CDRRecord.call_type == service)
    if search:
        like = f"%{search}%"
        s = s.where(or_(
            CDRRecord.a_party_number.ilike(like), CDRRecord.b_party_number.ilike(like),
            CDRRecord.tower_id.ilike(like), CDRRecord.msisdn.ilike(like),
            CDRRecord.imsi.ilike(like), CDRRecord.imei.ilike(like),
            CDRRecord.cell_id.ilike(like), CDRRecord.call_type.ilike(like),
        ))
    return s


def _ipdr_id_select(case_id=None, search=None, service=None):
    s = select(
        IPDRRecord.id.label("rid"),
        literal("IPDR").label("rtype"),
        IPDRRecord.start_time.label("ts"),
    )
    if case_id is not None:
        s = s.where(IPDRRecord.case_id == str(case_id))
    if service:  # IPDR "service" maps to protocol
        s = s.where(IPDRRecord.protocol == service)
    if search:
        like = f"%{search}%"
        s = s.where(or_(
            IPDRRecord.source_ip.ilike(like), IPDRRecord.destination_ip.ilike(like),
            IPDRRecord.protocol.ilike(like), IPDRRecord.tower_id.ilike(like),
            IPDRRecord.msisdn.ilike(like), IPDRRecord.imsi.ilike(like),
            IPDRRecord.imei.ilike(like), IPDRRecord.apn.ilike(like),
        ))
    return s


def page_records(db, case_id=None, rtype="all", search=None, service=None, limit=60, offset=0):
    """Server-side, time-ordered, paginated page across CDR and IPDR for one case.

    Returns ``{"total": int, "rows": [ORM record, …], "types": {id: "CDR"|"IPDR"}}`` where rows
    are the hydrated CDR/IPDR ORM objects in display order (newest first). Pagination is done on
    a lightweight (id, rtype, start_time) UNION so it is correct across both tables without
    loading either fully. CDR and IPDR are never cross-attributed — the discriminator is carried
    through so the caller serializes each with its own schema.
    """
    rtype = (rtype or "all").upper()
    want_cdr = rtype in ("ALL", "CDR")
    want_ipdr = rtype in ("ALL", "IPDR")
    limit = max(1, min(int(limit or 60), 500))
    offset = max(0, int(offset or 0))

    # total
    total = 0
    if want_cdr:
        total += db.execute(
            select(func.count()).select_from(_cdr_id_select(case_id, search, service).subquery())
        ).scalar_one()
    if want_ipdr:
        total += db.execute(
            select(func.count()).select_from(_ipdr_id_select(case_id, search, service).subquery())
        ).scalar_one()

    # the page of (id, rtype) ordered by time across both tables
    parts = []
    if want_cdr:
        parts.append(_cdr_id_select(case_id, search, service))
    if want_ipdr:
        parts.append(_ipdr_id_select(case_id, search, service))
    if not parts:
        return {"total": 0, "rows": [], "order": []}
    if len(parts) == 1:
        u = parts[0].subquery()
    else:
        u = union_all(*parts).subquery()
    page = db.execute(
        select(u.c.rid, u.c.rtype).order_by(desc(u.c.ts)).limit(limit).offset(offset)
    ).all()

    cdr_ids = [r.rid for r in page if r.rtype == "CDR"]
    ipdr_ids = [r.rid for r in page if r.rtype == "IPDR"]
    cdr_by_id = {}
    ipdr_by_id = {}
    if cdr_ids:
        cdr_by_id = {r.id: r for r in db.query(CDRRecord).filter(CDRRecord.id.in_(cdr_ids)).all()}
    if ipdr_ids:
        ipdr_by_id = {r.id: r for r in db.query(IPDRRecord).filter(IPDRRecord.id.in_(ipdr_ids)).all()}

    rows, order = [], []
    for r in page:
        rec = cdr_by_id.get(r.rid) if r.rtype == "CDR" else ipdr_by_id.get(r.rid)
        if rec is None:
            continue
        rows.append(rec)
        order.append(r.rtype)
    return {"total": total, "rows": rows, "order": order}


def distinct_services(db, case_id=None):
    """Distinct service values present in a case: CDR call types + IPDR protocols."""
    cq = db.query(CDRRecord.call_type).filter(CDRRecord.call_type.isnot(None))
    iq = db.query(IPDRRecord.protocol).filter(IPDRRecord.protocol.isnot(None))
    if case_id is not None:
        cq = cq.filter(CDRRecord.case_id == str(case_id))
        iq = iq.filter(IPDRRecord.case_id == str(case_id))
    vals = {v[0] for v in cq.distinct().all()} | {v[0] for v in iq.distinct().all()}
    return sorted(v for v in vals if v)

