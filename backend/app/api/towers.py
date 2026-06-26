from __future__ import annotations

import os
import tempfile

import pandas as pd
from fastapi import APIRouter
from fastapi import Depends
from fastapi import File
from fastapi import HTTPException
from fastapi import Query
from fastapi import UploadFile
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.tower import Tower
from app.schemas.tower import TowerRead
from app.schemas.upload import UploadResponse
from app.services.geocode_service import geocode_missing
from app.services.tower_service import rebuild_tower_repo
from app.services.tower_service import tower_repo_list
from app.services.tower_service import tower_repo_stats
from app.utils.validators import ensure_columns

router = APIRouter()


@router.post("/upload", response_model=UploadResponse)
async def upload_towers(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".csv") as temp_file:
            temp_file.write(await file.read())
            temp_path = temp_file.name

        df = pd.read_csv(temp_path)
        ensure_columns(df.columns, ["tower_id"])

        records = []
        for _, row in df.iterrows():
            records.append(
                Tower(
                    tower_id=str(row["tower_id"]),
                    latitude=None if pd.isna(row.get("latitude")) else float(row["latitude"]),
                    longitude=None if pd.isna(row.get("longitude")) else float(row["longitude"]),
                    city=None if pd.isna(row.get("city")) else str(row["city"]),
                    state=None if pd.isna(row.get("state")) else str(row["state"]),
                )
            )

        for record in records:
            db.merge(record)
        db.commit()

        return UploadResponse(success=True, records_imported=len(records))
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)


@router.get("/repo/stats")
def repo_stats(db: Session = Depends(get_db)):
    """Headline stats for the permanent tower repository (total, coords coverage, by state)."""
    return tower_repo_stats(db)


@router.get("/repo")
def repo_list(
    db: Session = Depends(get_db),
    search: str = Query(default=""),
    limit: int = Query(default=300, ge=1, le=2000),
    offset: int = Query(default=0, ge=0),
):
    """Searchable, paginated listing of the tower repository."""
    return tower_repo_list(db, search=search, limit=limit, offset=offset)


@router.post("/repo/rebuild")
def repo_rebuild(db: Session = Depends(get_db)):
    """Backfill the tower repository from CDR/IPDR records already loaded (fills coordinates from
    the records' own tower_id+lat/lng), then offline-geocode newly-located towers to city/state.
    Idempotent; never clobbers existing data."""
    return rebuild_tower_repo(db)


@router.post("/repo/geocode")
def repo_geocode(db: Session = Depends(get_db)):
    """Offline reverse-geocode: fill city/state for repository towers that have coordinates but no
    place name (nearest-major-city lookup, no external API). Never overwrites existing names."""
    return geocode_missing(db)


@router.get("/", response_model=list[TowerRead])
def list_towers(db: Session = Depends(get_db)):
    return db.query(Tower).order_by(Tower.tower_id.asc()).all()

