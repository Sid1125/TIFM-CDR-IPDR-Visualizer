from sqlalchemy import Column
from sqlalchemy import DateTime
from sqlalchemy import ForeignKey
from sqlalchemy import Integer
from sqlalchemy import String
from sqlalchemy import Float
from sqlalchemy import Index

from app.core.database import Base


class CDRRecord(Base):
    __tablename__ = "cdr_records"

    # Composite indexes for the dominant access pattern: case-scoped, time-ordered paging and
    # tower/subject lookups at 50k-500k rows. Single-column indexes below still help point
    # lookups; these speed the paginated record browser and tower/subject filters.
    __table_args__ = (
        Index("ix_cdr_case_start", "case_id", "start_time"),
        Index("ix_cdr_case_tower", "case_id", "tower_id"),
        Index("ix_cdr_case_aparty", "case_id", "a_party_number"),
    )

    id = Column(Integer, primary_key=True, index=True)
    case_id = Column(String, index=True, nullable=True)
    msisdn = Column(String, index=True, nullable=True)
    imsi = Column(String, index=True, nullable=True)
    imei = Column(String, index=True, nullable=True)
    a_party_number = Column(String, index=True, nullable=True)
    b_party_number = Column(String, index=True, nullable=True)
    call_type = Column(String, nullable=True)
    direction = Column(String, nullable=True)
    start_time = Column(DateTime, index=True, nullable=True)
    end_time = Column(DateTime, index=True, nullable=True)
    duration_seconds = Column(Integer, nullable=True)
    tower_id = Column(String, ForeignKey("towers.tower_id"), index=True, nullable=True)
    cell_id = Column(String, index=True, nullable=True)
    lac = Column(String, nullable=True)
    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)
    technology = Column(String, nullable=True)
