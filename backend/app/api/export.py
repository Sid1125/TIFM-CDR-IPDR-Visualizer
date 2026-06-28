from __future__ import annotations

import re

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response, StreamingResponse
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.auth import User
from app.schemas.cdr import CDRRead
from app.schemas.ipdr import IPDRRead
from app.services.auth_service import get_current_user
from app.services.export_service import build_xlsx
from app.services.records_service import page_records

router = APIRouter()

_XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

_REC_HEADERS = [
    "Time", "Type", "Subject", "Counterpart", "Dur(s)",
    "Call Type / Protocol", "Direction / APN", "Service",
    "Src Port", "Dst Port", "Tower", "Cell ID", "LAC",
    "IMSI", "IMEI", "MSISDN", "Latitude", "Longitude", "Case",
]


def _safe_filename(raw: str, ext: str) -> str:
    base = re.sub(r"[^A-Za-z0-9_.-]+", "_", raw).strip("_") or "export"
    if not base.lower().endswith("." + ext):
        base += "." + ext
    return base


def _rec_to_row(d: dict, rt: str) -> list:
    is_cdr = rt == "CDR"
    dur = d.get("duration_seconds")
    src_port = d.get("source_port")
    dst_port = d.get("destination_port")
    lat = d.get("latitude")
    lon = d.get("longitude")
    call_type = (d.get("call_type") or "").upper()
    svc = "SMS" if call_type in ("SMS", "MMS") else ("Voice" if is_cdr else (d.get("protocol") or "Unknown"))
    return [
        d.get("start_time") or "",
        rt,
        d.get("a_party_number") or "" if is_cdr else d.get("source_ip") or "",
        d.get("b_party_number") or "" if is_cdr else d.get("destination_ip") or "",
        "" if dur is None else dur,
        d.get("call_type") or "" if is_cdr else d.get("protocol") or "",
        d.get("direction") or "" if is_cdr else d.get("apn") or "",
        svc,
        "" if (is_cdr or src_port is None) else src_port,
        "" if (is_cdr or dst_port is None) else dst_port,
        d.get("tower_id") or "",
        d.get("cell_id") or "",
        d.get("lac") or "",
        d.get("imsi") or "",
        d.get("imei") or "",
        d.get("msisdn") or "",
        "" if lat is None else lat,
        "" if lon is None else lon,
        d.get("case_id") or "",
    ]


@router.get("/records")
def export_records(
    format: str = Query(default="csv"),
    case_id: str | None = Query(default=None),
    type: str = Query(default="all"),
    search: str | None = Query(default=None),
    service: str | None = Query(default=None),
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """Stream all records matching the current Records-tab filters as CSV or XLSX.
    Pulls directly from the database — no allRows dependency — so export always
    matches every page of the paginated table."""
    res = page_records(
        db,
        case_id=case_id,
        rtype=type or "all",
        search=search,
        service=service,
        limit=200_000,
        offset=0,
    )

    rows = []
    for rec, rt in zip(res["rows"], res["order"]):
        d = (CDRRead if rt == "CDR" else IPDRRead).model_validate(rec).model_dump(mode="json")
        rows.append(_rec_to_row(d, rt))

    safe_case = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(case_id or "all")).strip("_") or "all"
    fmt = (format or "csv").lower()

    if fmt == "xlsx":
        buf = build_xlsx("Records", _REC_HEADERS, rows)
        fname = _safe_filename(f"ARGUS_records_{safe_case}", "xlsx")
        return StreamingResponse(
            buf,
            media_type=_XLSX_MIME,
            headers={"Content-Disposition": f'attachment; filename="{fname}"'},
        )

    # CSV (default)
    def _esc(v: object) -> str:
        s = "" if v is None else str(v)
        if any(c in s for c in (",", '"', "\n", "\r")):
            s = '"' + s.replace('"', '""') + '"'
        return s

    lines = [",".join(_esc(h) for h in _REC_HEADERS)]
    for row in rows:
        lines.append(",".join(_esc(v) for v in row))
    content = "﻿" + "\r\n".join(lines)
    fname = _safe_filename(f"ARGUS_records_{safe_case}", "csv")
    return Response(
        content=content.encode("utf-8"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.post("/xlsx")
def export_xlsx(payload: dict, _user: User = Depends(get_current_user)):
    """Generic table -> .xlsx. Body: {sheet_name, headers:[...], rows:[[...], ...], filename?}.
    Lets any frontend report download Excel without vendoring a JS xlsx library."""
    sheet = payload.get("sheet_name") or "Report"
    headers = payload.get("headers") or []
    rows = payload.get("rows") or []
    buf = build_xlsx(sheet, headers, rows)
    raw = payload.get("filename") or sheet or "export"
    safe = _safe_filename(str(raw), "xlsx")
    return StreamingResponse(
        buf,
        media_type=_XLSX_MIME,
        headers={"Content-Disposition": f'attachment; filename="{safe}"'},
    )
