from datetime import datetime

from pydantic import BaseModel


class CaseCreate(BaseModel):
    name: str
    description: str | None = None


class CaseUpdate(BaseModel):
    name: str | None = None
    description: str | None = None


class CaseRead(BaseModel):
    id: int
    name: str
    description: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    record_count: int = 0

    model_config = {"from_attributes": True}
