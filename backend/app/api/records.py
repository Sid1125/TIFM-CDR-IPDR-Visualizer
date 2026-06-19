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

router = APIRouter()


@router.delete("/reset")
def reset_records(case_id: str | None = Query(default=None), db: Session = Depends(get_db)):
    try:
        if case_id:
            cdr_deleted = db.query(CDRRecord).filter(CDRRecord.case_id == case_id).delete(synchronize_session=False)
            ipdr_deleted = db.query(IPDRRecord).filter(IPDRRecord.case_id == case_id).delete(synchronize_session=False)
        else:
            cdr_deleted = db.query(CDRRecord).delete(synchronize_session=False)
            ipdr_deleted = db.query(IPDRRecord).delete(synchronize_session=False)
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
