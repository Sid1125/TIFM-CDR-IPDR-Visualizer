from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.annotation import Annotation
from app.schemas.annotation import AnnotationCreate, AnnotationRead
from app.services.auth_service import get_current_user
from app.models.auth import User

router = APIRouter()


@router.get("/", response_model=list[AnnotationRead])
def list_annotations(
    record_type: str | None = None,
    record_id: int | None = None,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    q = db.query(Annotation)
    if record_type:
        q = q.filter(Annotation.record_type == record_type)
    if record_id is not None:
        q = q.filter(Annotation.record_id == record_id)
    return q.order_by(Annotation.created_at.desc()).all()


@router.post("/", response_model=AnnotationRead, status_code=status.HTTP_201_CREATED)
def create_annotation(
    payload: AnnotationCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    a = Annotation(
        record_type=payload.record_type,
        record_id=payload.record_id,
        tag=payload.tag,
        note=payload.note,
        created_by=user.username,
        created_at=datetime.utcnow(),
    )
    db.add(a)
    db.commit()
    db.refresh(a)
    return a


@router.delete("/{annotation_id}")
def delete_annotation(
    annotation_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    a = db.query(Annotation).filter(Annotation.id == annotation_id).one_or_none()
    if a is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Annotation not found")
    db.delete(a)
    db.commit()
    return {"success": True}
