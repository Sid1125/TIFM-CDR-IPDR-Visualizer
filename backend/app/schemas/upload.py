from pydantic import BaseModel


class UploadResponse(BaseModel):
    success: bool
    records_imported: int
