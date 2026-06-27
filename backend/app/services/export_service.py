from __future__ import annotations

import io
from typing import Iterable

from openpyxl import Workbook


def build_xlsx(sheet_name: str, headers: Iterable, rows: Iterable[Iterable]) -> io.BytesIO:
    """Build an .xlsx in memory from a header row + data rows. Used by the generic /export/xlsx
    endpoint so any frontend table can post its current rows and get Excel — no JS xlsx lib needed."""
    wb = Workbook()
    ws = wb.active
    ws.title = (str(sheet_name) or "Report")[:31] or "Report"
    if headers:
        ws.append([str(h) for h in headers])
    for r in rows:
        ws.append(["" if c is None else c for c in r])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf
