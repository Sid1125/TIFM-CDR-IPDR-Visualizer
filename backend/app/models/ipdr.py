from sqlalchemy import BigInteger
from sqlalchemy import Column
from sqlalchemy import DateTime
from sqlalchemy import ForeignKey
from sqlalchemy import Integer
from sqlalchemy import String
from sqlalchemy import Float
from sqlalchemy import Index

from app.core.database import Base


class IPDRRecord(Base):
    __tablename__ = "ipdr_records"

    # Composite indexes for case-scoped, time-ordered paging and tower/source lookups at scale.
    __table_args__ = (
        Index("ix_ipdr_case_start", "case_id", "start_time"),
        Index("ix_ipdr_case_tower", "case_id", "tower_id"),
        Index("ix_ipdr_case_srcip", "case_id", "source_ip"),
    )

    id = Column(Integer, primary_key=True, index=True)
    case_id = Column(String, index=True, nullable=True)
    msisdn = Column(String, index=True, nullable=True)
    imsi = Column(String, index=True, nullable=True)
    imei = Column(String, index=True, nullable=True)
    start_time = Column(DateTime, index=True, nullable=True)
    end_time = Column(DateTime, index=True, nullable=True)
    duration_seconds = Column(Integer, nullable=True)
    source_ip = Column(String, index=True, nullable=True)
    destination_ip = Column(String, index=True, nullable=True)
    source_port = Column(Integer, nullable=True)
    destination_port = Column(Integer, nullable=True)
    protocol = Column(String, index=True, nullable=True)
    bytes_uploaded = Column(BigInteger, nullable=True)
    bytes_downloaded = Column(BigInteger, nullable=True)
    tower_id = Column(String, ForeignKey("towers.tower_id"), index=True, nullable=True)
    cell_id = Column(String, index=True, nullable=True)
    lac = Column(String, nullable=True)
    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)
    apn = Column(String, nullable=True)
    rat = Column(String, nullable=True)
