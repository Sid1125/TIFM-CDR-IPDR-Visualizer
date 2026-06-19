from fastapi import APIRouter
from fastapi import Depends
from fastapi import Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.services.timeline_service import get_timeline

router = APIRouter()


@router.get("/")
def timeline(db: Session = Depends(get_db), limit: int = Query(default=500, ge=1, le=5000)):
    return get_timeline(db, limit=limit)
