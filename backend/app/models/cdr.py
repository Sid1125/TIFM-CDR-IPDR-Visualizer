from sqlalchemy import Column
from sqlalchemy import DateTime
from sqlalchemy import ForeignKey
from sqlalchemy import Integer
from sqlalchemy import String
from sqlalchemy import Float

from app.core.database import Base


class CDRRecord(Base):
    __tablename__ = "cdr_records"

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
