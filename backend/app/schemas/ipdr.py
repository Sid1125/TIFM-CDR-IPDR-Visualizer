from datetime import datetime

from pydantic import BaseModel


class IPDRBase(BaseModel):
    id: int | None = None
    case_id: str | None = None
    msisdn: str | None = None
    imsi: str | None = None
    imei: str | None = None
    start_time: datetime | None = None
    end_time: datetime | None = None
    duration_seconds: int | None = None
    source_ip: str | None = None
    destination_ip: str | None = None
    source_port: int | None = None
    destination_port: int | None = None
    protocol: str | None = None
    bytes_uploaded: int | None = None
    bytes_downloaded: int | None = None
    tower_id: str | None = None
    cell_id: str | None = None
    lac: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    apn: str | None = None
    rat: str | None = None


class IPDRCreate(IPDRBase):
    pass


class IPDRRead(IPDRBase):
    class Config:
        from_attributes = True
