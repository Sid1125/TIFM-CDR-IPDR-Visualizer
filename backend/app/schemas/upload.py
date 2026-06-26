from typing import Optional

from pydantic import BaseModel


class UploadResponse(BaseModel):
    success: bool
    records_imported: int
    validation: Optional[dict] = None  # ingest validation report (rows dropped/coerced, mapping)
