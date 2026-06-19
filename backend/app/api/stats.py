from fastapi import APIRouter
from fastapi import Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.services.stats_service import get_top_contacts, get_cdr_stats, get_ipdr_stats

router = APIRouter()


@router.get("/top-contacts")
def top_contacts(db: Session = Depends(get_db)):
    return get_top_contacts(db)


@router.get("/cdr")
def cdr_stats(db: Session = Depends(get_db)):
    return get_cdr_stats(db)


@router.get("/ipdr")
def ipdr_stats(db: Session = Depends(get_db)):
    return get_ipdr_stats(db)
