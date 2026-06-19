from __future__ import annotations

import os
import tempfile

import pandas as pd
from fastapi import APIRouter
from fastapi import Depends
from fastapi import File
from fastapi import Form
from fastapi import HTTPException
from fastapi import UploadFile
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord
from app.models.tower import Tower
from app.schemas.upload import UploadResponse
from app.utils.validators import ensure_columns

router = APIRouter()


def _to_pydatetime(val):
    if val is None or pd.isna(val):
        return None
    if hasattr(val, "to_pydatetime"):
        return val.to_pydatetime()
    return val


def _to_int(val):
    if val is None or pd.isna(val):
        return None
    return int(val)


def _to_float(val):
    if val is None or pd.isna(val):
        return None
    return float(val)


def _to_str(val):
    if val is None or pd.isna(val):
        return None
    return str(val)


@router.post("/cdr", response_model=UploadResponse)
async def upload_cdr(
    file: UploadFile = File(...),
    case_id: str = Form(""),
    db: Session = Depends(get_db),
):
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".csv") as temp_file:
            temp_file.write(await file.read())
            temp_path = temp_file.name

        df = pd.read_csv(temp_path)
        cdr_required = [
            "a_party_number",
            "b_party_number",
            "start_time",
            "end_time",
            "duration_seconds",
        ]
        ensure_columns(df.columns, cdr_required)

        if case_id:
            db.query(CDRRecord).filter(CDRRecord.case_id == case_id).delete(synchronize_session=False)
        else:
            db.query(CDRRecord).delete(synchronize_session=False)

        for col in ["start_time", "end_time"]:
            if col in df.columns:
                df[col] = pd.to_datetime(df[col], errors="coerce")

        records = []
        for _, row in df.iterrows():
            records.append(
                CDRRecord(
                    case_id=case_id or _to_str(row.get("case_id")),
                    msisdn=_to_str(row.get("msisdn")),
                    imsi=_to_str(row.get("imsi")),
                    imei=_to_str(row.get("imei")),
                    a_party_number=_to_str(row.get("a_party_number")),
                    b_party_number=_to_str(row.get("b_party_number")),
                    call_type=_to_str(row.get("call_type")),
                    direction=_to_str(row.get("direction")),
                    start_time=_to_pydatetime(row.get("start_time")),
                    end_time=_to_pydatetime(row.get("end_time")),
                    duration_seconds=_to_int(row.get("duration_seconds")),
                    tower_id=_to_str(row.get("tower_id")),
                    cell_id=_to_str(row.get("cell_id")),
                    lac=_to_str(row.get("lac")),
                    latitude=_to_float(row.get("latitude")),
                    longitude=_to_float(row.get("longitude")),
                    technology=_to_str(row.get("technology")),
                )
            )

        db.add_all(records)
        db.commit()

        return UploadResponse(success=True, records_imported=len(records))
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)


@router.post("/ipdr", response_model=UploadResponse)
async def upload_ipdr(
    file: UploadFile = File(...),
    case_id: str = Form(""),
    db: Session = Depends(get_db),
):
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".csv") as temp_file:
            temp_file.write(await file.read())
            temp_path = temp_file.name

        df = pd.read_csv(temp_path)
        ipdr_required = [
            "start_time",
            "end_time",
            "source_ip",
            "destination_ip",
        ]
        ensure_columns(df.columns, ipdr_required)

        if case_id:
            db.query(IPDRRecord).filter(IPDRRecord.case_id == case_id).delete(synchronize_session=False)
        else:
            db.query(IPDRRecord).delete(synchronize_session=False)

        for col in ["start_time", "end_time"]:
            if col in df.columns:
                df[col] = pd.to_datetime(df[col], errors="coerce")

        records = []
        for _, row in df.iterrows():
            records.append(
                IPDRRecord(
                    case_id=case_id or _to_str(row.get("case_id")),
                    msisdn=_to_str(row.get("msisdn")),
                    imsi=_to_str(row.get("imsi")),
                    imei=_to_str(row.get("imei")),
                    start_time=_to_pydatetime(row.get("start_time")),
                    end_time=_to_pydatetime(row.get("end_time")),
                    duration_seconds=_to_int(row.get("duration_seconds")),
                    source_ip=_to_str(row.get("source_ip")),
                    destination_ip=_to_str(row.get("destination_ip")),
                    source_port=_to_int(row.get("source_port")),
                    destination_port=_to_int(row.get("destination_port")),
                    protocol=_to_str(row.get("protocol")),
                    bytes_uploaded=_to_int(row.get("bytes_uploaded")),
                    bytes_downloaded=_to_int(row.get("bytes_downloaded")),
                    tower_id=_to_str(row.get("tower_id")),
                    cell_id=_to_str(row.get("cell_id")),
                    lac=_to_str(row.get("lac")),
                    latitude=_to_float(row.get("latitude")),
                    longitude=_to_float(row.get("longitude")),
                    apn=_to_str(row.get("apn")),
                    rat=_to_str(row.get("rat")),
                )
            )

        db.add_all(records)
        db.commit()

        return UploadResponse(success=True, records_imported=len(records))
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)


@router.post("/towers", response_model=UploadResponse)
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
