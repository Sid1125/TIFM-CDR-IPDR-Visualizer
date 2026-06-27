from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.auth import User
from app.services.auth_service import get_current_user
from app.services import tower_dump_service as tds

router = APIRouter()


def _labels(labels: str | None):
    return [s for s in (labels or "").split(",") if s.strip()]


@router.get("/dumps")
def dumps(case_id: str = Query(""), db: Session = Depends(get_db),
          _user: User = Depends(get_current_user)):
    return tds.list_dumps(db, case_id or None)


@router.get("/common")
def common(case_id: str = Query(""), labels: str = Query(""), min: int = Query(2),
           db: Session = Depends(get_db), _user: User = Depends(get_current_user)):
    return tds.common_numbers(db, case_id or None, _labels(labels), min_dumps=max(2, min))


@router.get("/uncommon")
def uncommon(case_id: str = Query(""), labels: str = Query(""),
             db: Session = Depends(get_db), _user: User = Depends(get_current_user)):
    return tds.uncommon_numbers(db, case_id or None, _labels(labels))


@router.get("/under-tower")
def under_tower(case_id: str = Query(""), label: str = Query(""),
                db: Session = Depends(get_db), _user: User = Depends(get_current_user)):
    return tds.under_tower(db, case_id or None, label)


@router.get("/multiplicity")
def multiplicity(case_id: str = Query(""), labels: str = Query(""),
                 db: Session = Depends(get_db), _user: User = Depends(get_current_user)):
    return tds.device_multiplicity(db, case_id or None, _labels(labels))
