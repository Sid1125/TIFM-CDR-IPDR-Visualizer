from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.case import Case
from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord
from app.schemas.case import CaseCreate, CaseRead, CaseUpdate
from app.services.auth_service import get_current_user
from app.models.auth import User

router = APIRouter()


@router.get("/", response_model=list[CaseRead])
def list_cases(db: Session = Depends(get_db), _user: User = Depends(get_current_user)):
    cases = db.query(Case).order_by(Case.updated_at.desc()).all()
    result = []
    for c in cases:
        cdr_count = db.query(CDRRecord).filter(CDRRecord.case_id == str(c.id)).count()
        ipdr_count = db.query(IPDRRecord).filter(IPDRRecord.case_id == str(c.id)).count()
        result.append(CaseRead(
            id=c.id,
            name=c.name,
            description=c.description,
            created_at=c.created_at,
            updated_at=c.updated_at,
            record_count=cdr_count + ipdr_count,
        ))
    return result


@router.post("/", response_model=CaseRead, status_code=status.HTTP_201_CREATED)
def create_case(payload: CaseCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    c = Case(name=payload.name, description=payload.description, created_at=datetime.utcnow(), updated_at=datetime.utcnow())
    db.add(c)
    db.commit()
    db.refresh(c)
    return CaseRead(id=c.id, name=c.name, description=c.description, created_at=c.created_at, updated_at=c.updated_at, record_count=0)


@router.put("/{case_id}", response_model=CaseRead)
def update_case(case_id: int, payload: CaseUpdate, db: Session = Depends(get_db), _user: User = Depends(get_current_user)):
    c = db.query(Case).filter(Case.id == case_id).one_or_none()
    if c is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Case not found")
    if payload.name is not None:
        c.name = payload.name
    if payload.description is not None:
        c.description = payload.description
    c.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(c)
    cdr_count = db.query(CDRRecord).filter(CDRRecord.case_id == str(c.id)).count()
    ipdr_count = db.query(IPDRRecord).filter(IPDRRecord.case_id == str(c.id)).count()
    return CaseRead(id=c.id, name=c.name, description=c.description, created_at=c.created_at, updated_at=c.updated_at, record_count=cdr_count + ipdr_count)


@router.delete("/{case_id}")
def delete_case(case_id: int, db: Session = Depends(get_db), _user: User = Depends(get_current_user)):
    c = db.query(Case).filter(Case.id == case_id).one_or_none()
    if c is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Case not found")
    db.query(CDRRecord).filter(CDRRecord.case_id == str(c.id)).delete(synchronize_session=False)
    db.query(IPDRRecord).filter(IPDRRecord.case_id == str(c.id)).delete(synchronize_session=False)
    db.delete(c)
    db.commit()
    return {"success": True, "deleted_records": True}
