from datetime import datetime

from pydantic import BaseModel


class AnnotationCreate(BaseModel):
    record_type: str
    record_id: int
    tag: str
    note: str | None = None


class AnnotationUpdate(BaseModel):
    tag: str | None = None
    note: str | None = None


class AnnotationRead(BaseModel):
    id: int
    record_type: str
    record_id: int
    tag: str
    note: str | None = None
    created_by: str | None = None
    created_at: datetime | None = None

    model_config = {"from_attributes": True}
