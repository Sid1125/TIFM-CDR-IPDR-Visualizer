from sqlalchemy import Column, DateTime, Integer, String, Text, func

from app.core.database import Base


class Subscriber(Base):
    """Subscriber Detail Record (SDR / CAF) — the real identity behind a number.

    Global by MSISDN (no per-case scoping, latest import wins), mirroring SubjectTag, so the
    identity follows the number across every case it appears in. Surfaces in the subject profile,
    the dossier, and SDR search."""

    __tablename__ = "subscribers"

    id = Column(Integer, primary_key=True, index=True)
    msisdn = Column(String, unique=True, index=True, nullable=False)
    imsi = Column(String, nullable=True)
    imei = Column(String, nullable=True)
    name = Column(String, nullable=True)
    address = Column(Text, nullable=True)
    alt_number = Column(String, index=True, nullable=True)
    id_proof = Column(String, nullable=True)
    activation_date = Column(String, nullable=True)
    operator = Column(String, nullable=True)
    case_id = Column(String, nullable=True)
    updated_by = Column(String, nullable=True)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
