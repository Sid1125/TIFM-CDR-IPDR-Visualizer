from datetime import datetime

from pydantic import BaseModel


class CaseCreate(BaseModel):
    name: str
    description: str | None = None


class CaseUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    archived: bool | None = None


class CaseRead(BaseModel):
    id: int
    name: str
    description: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    record_count: int = 0
    archived: bool = False

    model_config = {"from_attributes": True}
