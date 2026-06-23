from fastapi import APIRouter
from fastapi import Depends
from fastapi import Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.services.stats_service import get_top_contacts, get_cdr_stats, get_ipdr_stats

router = APIRouter()


@router.get("/top-contacts")
def top_contacts(db: Session = Depends(get_db), case_id: str = Query(default="")):
    return get_top_contacts(db, case_id=case_id or None)


@router.get("/cdr")
def cdr_stats(db: Session = Depends(get_db), case_id: str = Query(default="")):
    return get_cdr_stats(db, case_id=case_id or None)


@router.get("/ipdr")
def ipdr_stats(db: Session = Depends(get_db), case_id: str = Query(default="")):
    return get_ipdr_stats(db, case_id=case_id or None)
