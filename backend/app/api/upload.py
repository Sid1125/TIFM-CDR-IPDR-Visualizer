from __future__ import annotations

import json
import os
import tempfile

import pandas as pd
from fastapi import APIRouter
from fastapi import Depends
from fastapi import File
from fastapi import Form
from fastapi import HTTPException
from fastapi import Request
from fastapi import UploadFile
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.auth import User
from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord
from app.models.tower import Tower
from app.schemas.upload import UploadResponse
from app.services.audit_service import log_action
from app.services.auth_service import get_current_user
from app.services.ingest_service import coerce_frame
from app.services.ingest_service import resolve_columns
from app.utils.validators import ensure_columns

router = APIRouter()


def _parse_mapping(mapping_json: str):
    """Parse the optional UI-supplied column override (canonical -> actual header). Bad JSON is
    ignored (falls back to auto-detection) rather than failing the upload."""
    if not mapping_json:
        return None
    try:
        m = json.loads(mapping_json)
        return {str(k): str(v) for k, v in m.items()} if isinstance(m, dict) else None
    except Exception:
        return None


def _read_table(path: str, filename: str, nrows=None, dtype=None):
    """Read an uploaded CDR/IPDR/tower file into a DataFrame, dispatching on the original filename's
    extension so operators can hand us the formats they actually export: .csv, .txt (delimiter
    sniffed), and Excel .xls/.xlsx — not only CSV. Defaults to CSV for unknown extensions.
    `dtype=str` reads everything as text (used for SDR, where a blank cell must not floatify an
    identifier column like 9811099887 -> '9811099887.0')."""
    name = (filename or "").lower()
    if name.endswith(".xlsx") or name.endswith(".xlsm"):
        return pd.read_excel(path, engine="openpyxl", nrows=nrows, dtype=dtype)
    if name.endswith(".xls"):
        return pd.read_excel(path, engine="xlrd", nrows=nrows, dtype=dtype)
    if name.endswith(".txt"):
        return pd.read_csv(path, sep=None, engine="python", nrows=nrows, dtype=dtype)
    return pd.read_csv(path, nrows=nrows, dtype=dtype)


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


def _harvest_towers(db: Session, df) -> int:
    """Grow the permanent, case-independent tower repository from a CDR/IPDR upload. ISP dumps
    carry tower_id + lat/lng on their rows, so every case teaches the global `towers` table the
    towers it touched (with authoritative operator coordinates). Upserts by tower_id: inserts new
    towers, back-fills coordinates only when missing, and NEVER clobbers an existing tower's
    city/state. Returns the number of newly-created towers."""
    if "tower_id" not in df.columns:
        return 0
    keep = [c for c in ("tower_id", "latitude", "longitude") if c in df.columns]
    sub = df[keep].dropna(subset=["tower_id"]).drop_duplicates()  # collapse to distinct towers (small)
    if sub.empty:
        return 0
    has_lat, has_lng = "latitude" in sub.columns, "longitude" in sub.columns
    # tower_id -> (lat, lng); prefer a row that actually has coordinates
    seen: dict = {}
    for _, row in sub.iterrows():
        tid = _to_str(row.get("tower_id"))
        if not tid:
            continue
        lat = _to_float(row.get("latitude")) if has_lat else None
        lng = _to_float(row.get("longitude")) if has_lng else None
        cur = seen.get(tid)
        if cur is None or (cur[0] is None and lat is not None):
            seen[tid] = (lat, lng)
    if not seen:
        return 0
    existing = {t.tower_id: t for t in db.query(Tower).filter(Tower.tower_id.in_(list(seen.keys()))).all()}
    added = 0
    for tid, (lat, lng) in seen.items():
        t = existing.get(tid)
        if t is None:
            db.add(Tower(tower_id=tid, latitude=lat, longitude=lng))
            added += 1
        else:
            if t.latitude is None and lat is not None:
                t.latitude = lat
            if t.longitude is None and lng is not None:
                t.longitude = lng
    return added


@router.post("/cdr", response_model=UploadResponse)
async def upload_cdr(
    request: Request,
    file: UploadFile = File(...),
    case_id: str = Form(""),
    mode: str = Form("replace"),
    mapping_json: str = Form(""),
    operator: str = Form(""),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".csv") as temp_file:
            temp_file.write(await file.read())
            temp_path = temp_file.name

        df = _read_table(temp_path, file.filename)
        # Operator-aware mapping: resolve the file's headers onto canonical CDR fields (honouring a
        # UI-supplied override), then bail clearly if a required field can't be found.
        override = _parse_mapping(mapping_json)
        resolved = resolve_columns(df.columns, "cdr", override=override)
        if resolved["unmapped_required"]:
            raise HTTPException(
                status_code=422,
                detail="Could not map required CDR column(s): " + ", ".join(resolved["unmapped_required"]),
            )
        df, report = coerce_frame(df, "cdr", resolved["mapping"])

        # Append mode adds the new rows alongside what's already in the case; replace mode
        # (default) clears the case's existing CDR first.
        if mode.lower() != "append":
            if case_id:
                db.query(CDRRecord).filter(CDRRecord.case_id == case_id).delete(synchronize_session=False)
            else:
                # No case selected: replace only un-cased records, never wipe other cases' data.
                db.query(CDRRecord).filter(
                    (CDRRecord.case_id.is_(None)) | (CDRRecord.case_id == "")
                ).delete(synchronize_session=False)

        records = []
        for _, row in df.iterrows():
            records.append(
                CDRRecord(
                    case_id=case_id or None,  # the selected case is authoritative; never trust a CSV's own case_id column (it scatters rows into phantom, unregistered cases)
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

        _harvest_towers(db, df)  # ensure Tower rows exist before IPDR/CDR FK refs
        db.flush()
        db.add_all(records)
        db.commit()

        log_action(db, user, request, "upload", case_id=case_id or None,
                   detail={"kind": "cdr", "mode": mode.lower(), "rows_imported": len(records),
                           "rows_dropped": report["rows_dropped"], "filename": file.filename})
        return UploadResponse(success=True, records_imported=len(records), validation=report)
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)


@router.post("/ipdr", response_model=UploadResponse)
async def upload_ipdr(
    request: Request,
    file: UploadFile = File(...),
    case_id: str = Form(""),
    mode: str = Form("replace"),
    mapping_json: str = Form(""),
    operator: str = Form(""),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".csv") as temp_file:
            temp_file.write(await file.read())
            temp_path = temp_file.name

        df = _read_table(temp_path, file.filename)
        # Operator-aware mapping onto canonical IPDR fields (UI override honoured), then a clear
        # failure if a required field is missing.
        override = _parse_mapping(mapping_json)
        resolved = resolve_columns(df.columns, "ipdr", override=override)
        if resolved["unmapped_required"]:
            raise HTTPException(
                status_code=422,
                detail="Could not map required IPDR column(s): " + ", ".join(resolved["unmapped_required"]),
            )
        df, report = coerce_frame(df, "ipdr", resolved["mapping"])

        # Append mode adds the new rows alongside what's already in the case; replace mode
        # (default) clears the case's existing IPDR first.
        if mode.lower() != "append":
            if case_id:
                db.query(IPDRRecord).filter(IPDRRecord.case_id == case_id).delete(synchronize_session=False)
            else:
                # No case selected: replace only un-cased records, never wipe other cases' data.
                db.query(IPDRRecord).filter(
                    (IPDRRecord.case_id.is_(None)) | (IPDRRecord.case_id == "")
                ).delete(synchronize_session=False)

        records = []
        for _, row in df.iterrows():
            records.append(
                IPDRRecord(
                    case_id=case_id or None,  # the selected case is authoritative; never trust a CSV's own case_id column (it scatters rows into phantom, unregistered cases)
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

        _harvest_towers(db, df)  # ensure Tower rows exist before IPDR FK refs
        db.flush()
        db.add_all(records)
        db.commit()

        log_action(db, user, request, "upload", case_id=case_id or None,
                   detail={"kind": "ipdr", "mode": mode.lower(), "rows_imported": len(records),
                           "rows_dropped": report["rows_dropped"], "filename": file.filename})
        return UploadResponse(success=True, records_imported=len(records), validation=report)
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)


@router.post("/towers", response_model=UploadResponse)
async def upload_towers(
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".csv") as temp_file:
            temp_file.write(await file.read())
            temp_path = temp_file.name

        df = _read_table(temp_path, file.filename)
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

        log_action(db, user, request, "upload",
                   detail={"kind": "towers", "rows_imported": len(records),
                           "filename": file.filename})
        return UploadResponse(success=True, records_imported=len(records))
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)


@router.post("/tower-dump", response_model=UploadResponse)
async def upload_tower_dump(
    request: Request,
    file: UploadFile = File(...),
    case_id: str = Form(""),
    dump_label: str = Form(""),
    mode: str = Form("replace"),
    mapping_json: str = Form(""),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Import a tower dump (the bulk list of numbers on a cell over a window) into its own table,
    tagged by dump_label so several dumps in a case can be cross-analysed. Kept separate from CDR."""
    from app.models.tower_dump import TowerDumpRecord
    label = (dump_label or "").strip() or (file.filename or "dump").rsplit(".", 1)[0]
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".csv") as temp_file:
            temp_file.write(await file.read())
            temp_path = temp_file.name

        df = _read_table(temp_path, file.filename)
        override = _parse_mapping(mapping_json)
        resolved = resolve_columns(df.columns, "dump", override=override)
        if resolved["unmapped_required"]:
            raise HTTPException(
                status_code=422,
                detail="Could not map required tower-dump column(s): " + ", ".join(resolved["unmapped_required"]),
            )
        df, report = coerce_frame(df, "dump", resolved["mapping"])

        # Replace mode clears this dump_label within the case; append adds to it.
        if mode.lower() != "append":
            q = db.query(TowerDumpRecord).filter(TowerDumpRecord.dump_label == label)
            q = q.filter(TowerDumpRecord.case_id == case_id) if case_id else q.filter(
                (TowerDumpRecord.case_id.is_(None)) | (TowerDumpRecord.case_id == ""))
            q.delete(synchronize_session=False)

        records = []
        for _, row in df.iterrows():
            records.append(TowerDumpRecord(
                case_id=case_id or None,
                dump_label=label,
                msisdn=_to_str(row.get("msisdn")),
                imsi=_to_str(row.get("imsi")),
                imei=_to_str(row.get("imei")),
                other_party=_to_str(row.get("other_party")),
                start_time=_to_pydatetime(row.get("start_time")),
                end_time=_to_pydatetime(row.get("end_time")),
                call_type=_to_str(row.get("call_type")),
                tower_id=_to_str(row.get("tower_id")),
                cell_id=_to_str(row.get("cell_id")),
                lac=_to_str(row.get("lac")),
                latitude=_to_float(row.get("latitude")),
                longitude=_to_float(row.get("longitude")),
            ))
        _harvest_towers(db, df)  # ensure Tower rows exist before any FK refs
        db.flush()
        db.add_all(records)
        db.commit()

        log_action(db, user, request, "upload", case_id=case_id or None, target=label,
                   detail={"kind": "tower_dump", "dump_label": label, "mode": mode.lower(),
                           "rows_imported": len(records), "rows_dropped": report["rows_dropped"],
                           "filename": file.filename})
        report["dump_label"] = label
        return UploadResponse(success=True, records_imported=len(records), validation=report)
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)


@router.post("/sdr", response_model=UploadResponse)
async def upload_sdr(
    request: Request,
    file: UploadFile = File(...),
    case_id: str = Form(""),
    mapping_json: str = Form(""),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Import Subscriber Detail Records (SDR / CAF) and upsert them GLOBALLY by MSISDN (latest
    wins), so the real identity behind a number follows it across cases. No time anchor, so this
    path doesn't use coerce_frame's date-drop — it maps and upserts directly."""
    from app.models.subscriber import Subscriber
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".csv") as temp_file:
            temp_file.write(await file.read())
            temp_path = temp_file.name

        df = _read_table(temp_path, file.filename, dtype=str)
        override = _parse_mapping(mapping_json)
        resolved = resolve_columns(df.columns, "sdr", override=override)
        if resolved["unmapped_required"]:
            raise HTTPException(
                status_code=422,
                detail="Could not map required SDR column(s): " + ", ".join(resolved["unmapped_required"]),
            )
        mapping = resolved["mapping"]
        imported, skipped = 0, 0
        for _, row in df.iterrows():
            msisdn = _to_str(row.get(mapping["msisdn"]))
            if not msisdn:
                skipped += 1
                continue
            fields = {canon: _to_str(row.get(actual)) for canon, actual in mapping.items()}
            existing = db.query(Subscriber).filter(Subscriber.msisdn == msisdn).one_or_none()
            if existing is None:
                existing = Subscriber(msisdn=msisdn)
                db.add(existing)
            for canon in ("imsi", "imei", "name", "address", "alt_number", "id_proof",
                          "activation_date", "operator"):
                val = fields.get(canon)
                if val:
                    setattr(existing, canon, val)
            existing.case_id = case_id or existing.case_id
            existing.updated_by = user.username
            imported += 1
        db.commit()

        log_action(db, user, request, "upload", case_id=case_id or None,
                   detail={"kind": "sdr", "rows_imported": imported, "rows_skipped": skipped,
                           "filename": file.filename})
        return UploadResponse(success=True, records_imported=imported,
                              validation={"rows_total": int(len(df)), "rows_imported": imported,
                                          "rows_dropped": skipped, "mapping": mapping})
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)


@router.post("/preview")
async def upload_preview(
    file: UploadFile = File(...),
    kind: str = Form(...),
    mapping_json: str = Form(""),
):
    """Dry-run a CDR/IPDR upload: resolve the file's headers onto canonical fields (no DB writes),
    so the UI can show the auto-detected mapping, any unmapped required columns, and the detected
    operator before the investigator commits the upload."""
    kind = (kind or "").lower()
    if kind not in ("cdr", "ipdr"):
        raise HTTPException(status_code=400, detail="kind must be 'cdr' or 'ipdr'")
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".csv") as temp_file:
            temp_file.write(await file.read())
            temp_path = temp_file.name
        df = _read_table(temp_path, file.filename, nrows=50)
        resolved = resolve_columns(df.columns, kind, override=_parse_mapping(mapping_json))
        return {
            "kind": kind,
            "headers": list(df.columns),
            "mapping": resolved["mapping"],
            "unmapped_required": resolved["unmapped_required"],
            "required": resolved["required"],
            "canonical": resolved["canonical"],
            "detected_operator": resolved["detected_operator"],
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)
