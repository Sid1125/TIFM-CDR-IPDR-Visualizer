from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.auth import User
from app.models.subscriber import Subscriber
from app.services.auth_service import get_current_user

router = APIRouter()


def _serialize(s: Subscriber) -> dict:
    return {
        "msisdn": s.msisdn, "imsi": s.imsi, "imei": s.imei, "name": s.name,
        "address": s.address, "alt_number": s.alt_number, "id_proof": s.id_proof,
        "activation_date": s.activation_date, "operator": s.operator,
        "updated_by": s.updated_by,
    }


@router.get("/{msisdn}")
def get_subscriber(msisdn: str, db: Session = Depends(get_db),
                   _user: User = Depends(get_current_user)):
    """Resolve one MSISDN -> its subscriber identity (or {found:false})."""
    s = db.query(Subscriber).filter(Subscriber.msisdn == msisdn).one_or_none()
    if s is None:
        return {"found": False, "msisdn": msisdn}
    return {"found": True, **_serialize(s)}


@router.get("/")
def search_subscribers(q: str = Query(""), limit: int = 50,
                       db: Session = Depends(get_db), _user: User = Depends(get_current_user)):
    """Search subscribers by number, name, alt-number or address fragment."""
    query = db.query(Subscriber)
    if q:
        like = f"%{q}%"
        query = query.filter(
            (Subscriber.msisdn.ilike(like)) | (Subscriber.name.ilike(like))
            | (Subscriber.alt_number.ilike(like)) | (Subscriber.address.ilike(like))
        )
    return [_serialize(s) for s in query.limit(limit).all()]
