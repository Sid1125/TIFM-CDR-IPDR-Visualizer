from datetime import datetime

from pydantic import BaseModel


class RecordQuery(BaseModel):
    start_date: datetime | None = None
    end_date: datetime | None = None
    tower_id: str | None = None
    search: str | None = None
    limit: int = 100
    offset: int = 0

