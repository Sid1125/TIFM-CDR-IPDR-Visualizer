from datetime import datetime

from pydantic import BaseModel


class CDRBase(BaseModel):
    id: int | None = None
    case_id: str | None = None
    msisdn: str | None = None
    imsi: str | None = None
    imei: str | None = None
    a_party_number: str | None = None
    b_party_number: str | None = None
    call_type: str | None = None
    direction: str | None = None
    start_time: datetime | None = None
    end_time: datetime | None = None
    duration_seconds: int | None = None
    tower_id: str | None = None
    cell_id: str | None = None
    lac: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    technology: str | None = None


class CDRCreate(CDRBase):
    pass


class CDRRead(CDRBase):
    class Config:
        from_attributes = True
