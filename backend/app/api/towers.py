from __future__ import annotations

import os
import tempfile

import pandas as pd
from fastapi import APIRouter
from fastapi import Depends
from fastapi import File
from fastapi import HTTPException
from fastapi import UploadFile
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.tower import Tower
from app.schemas.tower import TowerRead
from app.schemas.upload import UploadResponse
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


@router.get("/", response_model=list[TowerRead])
def list_towers(db: Session = Depends(get_db)):
    return db.query(Tower).order_by(Tower.tower_id.asc()).all()

