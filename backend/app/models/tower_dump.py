from sqlalchemy import Column, DateTime, Float, Integer, String, Index

from app.core.database import Base


class TowerDumpRecord(Base):
    """A row from a tower dump — the mass list of every number seen on a cell during a window.

    Kept deliberately SEPARATE from CDR/IPDR: a tower dump is bulk cell data (everyone present at a
    location/time), not one subject's call records, so it must never pollute subject analytics. Each
    import is tagged with a `dump_label` (typically the tower/site + window, or the filename) so a
    case can hold several dumps and we can ask "which number appears across multiple dumps" — the
    classic 'present at every crime scene' analysis."""

    __tablename__ = "tower_dump_records"

    id = Column(Integer, primary_key=True, index=True)
    case_id = Column(String, index=True, nullable=True)
    dump_label = Column(String, index=True, nullable=False)
    msisdn = Column(String, index=True, nullable=True)
    imei = Column(String, index=True, nullable=True)
    imsi = Column(String, nullable=True)
    other_party = Column(String, nullable=True)
    start_time = Column(DateTime, index=True, nullable=True)
    end_time = Column(DateTime, nullable=True)
    call_type = Column(String, nullable=True)
    tower_id = Column(String, index=True, nullable=True)
    cell_id = Column(String, nullable=True)
    lac = Column(String, nullable=True)
    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)


Index("ix_dump_case_label", TowerDumpRecord.case_id, TowerDumpRecord.dump_label)
Index("ix_dump_case_msisdn", TowerDumpRecord.case_id, TowerDumpRecord.msisdn)
