from fastapi import APIRouter

from app.services import reference_service

router = APIRouter()


@router.get("/meta")
def reference_meta():
    """Series + ISD maps for the client to cache and apply locally."""
    return reference_service.reference_meta()


@router.get("/number/{value}")
def lookup_number(value: str):
    """Resolve a phone number -> operator/circle (domestic) or country (international)."""
    return reference_service.lookup_number(value)


@router.get("/imei/{value}")
def lookup_imei(value: str):
    """Resolve an IMEI's TAC -> make/model."""
    return reference_service.lookup_imei(value)
