from __future__ import annotations

from fastapi import APIRouter
from fastapi import Depends
from datetime import datetime
from fastapi import HTTPException
from fastapi import Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord
from app.models.tower import Tower
from app.schemas.cdr import CDRRead
from app.schemas.ipdr import IPDRRead
from app.services.records_service import list_cdr_records
from app.services.records_service import list_ipdr_records
from app.services.records_service import page_records
from app.services.records_service import distinct_services
from app.services.analytics_materialize_service import invalidate, invalidate_all

router = APIRouter()


@router.get("/page")
def get_records_page(
    db: Session = Depends(get_db),
    case_id: str | None = Query(default=None),
    type: str = Query(default="all"),
    search: str | None = Query(default=None),
    service: str | None = Query(default=None),
    limit: int = Query(default=60, ge=1, le=200000),
    offset: int = Query(default=0, ge=0),
):
    """Server-side, time-ordered, paginated records page across CDR + IPDR for one case.
    Returns {total, rows:[…rtype-tagged…], limit, offset}. The browser fetches pages on demand
    instead of holding the whole case in memory."""
    res = page_records(db, case_id=case_id, rtype=type, search=search, service=service, limit=limit, offset=offset)
    rows = []
    for rec, rt in zip(res["rows"], res["order"]):
        d = (CDRRead if rt == "CDR" else IPDRRead).model_validate(rec).model_dump(mode="json")
        d["rtype"] = rt
        rows.append(d)
    return {"total": res["total"], "rows": rows, "limit": limit, "offset": offset}


@router.get("/services")
def get_record_services(db: Session = Depends(get_db), case_id: str | None = Query(default=None)):
    """Distinct service values (CDR call types + IPDR protocols) present in a case, so the
    Service filter works without loading the whole case client-side."""
    return distinct_services(db, case_id=case_id)


@router.delete("/reset")
def reset_records(case_id: str | None = Query(default=None), db: Session = Depends(get_db)):
    try:
        if case_id:
            cdr_deleted = db.query(CDRRecord).filter(CDRRecord.case_id == case_id).delete(synchronize_session=False)
            ipdr_deleted = db.query(IPDRRecord).filter(IPDRRecord.case_id == case_id).delete(synchronize_session=False)
            invalidate(db, case_id)  # stale materialised analytics would otherwise survive the reset
        else:
            cdr_deleted = db.query(CDRRecord).delete(synchronize_session=False)
            ipdr_deleted = db.query(IPDRRecord).delete(synchronize_session=False)
            invalidate_all(db)
        db.commit()
        return {
            "success": True,
            "cdr_deleted": cdr_deleted,
            "ipdr_deleted": ipdr_deleted,
        }
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/cdr", response_model=list[CDRRead])
def get_cdr_records(
    db: Session = Depends(get_db),
    start_date: datetime | None = Query(default=None),
    end_date: datetime | None = Query(default=None),
    tower_id: str | None = Query(default=None),
    search: str | None = Query(default=None),
    msisdn: str | None = Query(default=None),
    imsi: str | None = Query(default=None),
    imei: str | None = Query(default=None),
    call_type: str | None = Query(default=None),
    direction: str | None = Query(default=None),
    case_id: str | None = Query(default=None),
    limit: int = Query(default=0, ge=0),
    offset: int = Query(default=0, ge=0),
):
    return list_cdr_records(
        db,
        start_date=start_date,
        end_date=end_date,
        tower_id=tower_id,
        search=search,
        msisdn=msisdn,
        imsi=imsi,
        imei=imei,
        call_type=call_type,
        direction=direction,
        case_id=case_id,
        limit=limit,
        offset=offset,
    )


@router.get("/ipdr", response_model=list[IPDRRead])
def get_ipdr_records(
    db: Session = Depends(get_db),
    start_date: datetime | None = Query(default=None),
    end_date: datetime | None = Query(default=None),
    tower_id: str | None = Query(default=None),
    search: str | None = Query(default=None),
    msisdn: str | None = Query(default=None),
    imsi: str | None = Query(default=None),
    imei: str | None = Query(default=None),
    protocol: str | None = Query(default=None),
    apn: str | None = Query(default=None),
    rat: str | None = Query(default=None),
    case_id: str | None = Query(default=None),
    limit: int = Query(default=0, ge=0),
    offset: int = Query(default=0, ge=0),
):
    return list_ipdr_records(
        db,
        start_date=start_date,
        end_date=end_date,
        tower_id=tower_id,
        search=search,
        msisdn=msisdn,
        imsi=imsi,
        imei=imei,
        protocol=protocol,
        apn=apn,
        rat=rat,
        case_id=case_id,
        limit=limit,
        offset=offset,
    )
