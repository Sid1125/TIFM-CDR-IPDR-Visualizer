from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter
from fastapi import Depends
from fastapi import Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.services.graph_service import build_graph
from app.services.graph_service import get_graph_metrics

router = APIRouter()


@router.get("/")
def graph(
    db: Session = Depends(get_db),
    start_date: datetime | None = Query(default=None),
    end_date: datetime | None = Query(default=None),
):
    return build_graph(db, start_date=start_date, end_date=end_date)


@router.get("/metrics")
def graph_metrics(
    db: Session = Depends(get_db),
    start_date: datetime | None = Query(default=None),
    end_date: datetime | None = Query(default=None),
):
    return get_graph_metrics(db, start_date=start_date, end_date=end_date)
