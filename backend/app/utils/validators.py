from __future__ import annotations

from datetime import datetime


def ensure_columns(frame_columns, required_columns: list[str]) -> None:
    missing = [column for column in required_columns if column not in frame_columns]
    if missing:
        raise ValueError(f"Missing required columns: {', '.join(missing)}")


def parse_datetime(value) -> datetime:
    if isinstance(value, datetime):
        return value
    parsed = datetime.fromisoformat(str(value))
    return parsed
