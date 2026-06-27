from __future__ import annotations

import re

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from app.models.auth import User
from app.services.auth_service import get_current_user
from app.services.export_service import build_xlsx

router = APIRouter()

_XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@router.post("/xlsx")
def export_xlsx(payload: dict, _user: User = Depends(get_current_user)):
    """Generic table -> .xlsx. Body: {sheet_name, headers:[...], rows:[[...], ...], filename?}.
    Lets any frontend report download Excel without vendoring a JS xlsx library."""
    sheet = payload.get("sheet_name") or "Report"
    headers = payload.get("headers") or []
    rows = payload.get("rows") or []
    buf = build_xlsx(sheet, headers, rows)
    raw = (payload.get("filename") or sheet or "export")
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(raw)).strip("_") or "export"
    if not safe.lower().endswith(".xlsx"):
        safe += ".xlsx"
    return StreamingResponse(
        buf, media_type=_XLSX_MIME,
        headers={"Content-Disposition": f'attachment; filename="{safe}"'},
    )
