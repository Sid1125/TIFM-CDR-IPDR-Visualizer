from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter
from fastapi import Depends
from fastapi import Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.services.graph_service import build_graph
from app.services.graph_service import build_graph_with_layout
from app.services.graph_service import get_graph_metrics

router = APIRouter()


@router.get("/")
def graph(
    db: Session = Depends(get_db),
    start_date: datetime | None = Query(default=None),
    end_date: datetime | None = Query(default=None),
    case_id: str = Query(default=""),
    subject: str = Query(default=""),
    limit: int = Query(default=0, ge=0, le=5000),
    layout: int = Query(default=0),  # 1 = attach server-computed node positions (cached)
):
    args = dict(start_date=start_date, end_date=end_date, case_id=case_id or None,
                subject=subject or None, limit=limit)
    return build_graph_with_layout(db, **args) if layout else build_graph(db, **args)


@router.get("/metrics")
def graph_metrics(
    db: Session = Depends(get_db),
    start_date: datetime | None = Query(default=None),
    end_date: datetime | None = Query(default=None),
    case_id: str = Query(default=""),
):
    return get_graph_metrics(db, start_date=start_date, end_date=end_date, case_id=case_id or None)
