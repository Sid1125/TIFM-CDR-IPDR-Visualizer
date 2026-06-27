from sqlalchemy import Column, DateTime, Integer, String, func

from app.core.database import Base


class WatchlistEntry(Base):
    """A suspect-group member. A 'suspect group' is a named set of identifiers (numbers, IPs,
    IMEIs, cell-IDs) the investigator builds up and compares cases/records against. `group_name`
    partitions entries into named groups (default 'Default'); existing rows fall into 'Default'."""

    __tablename__ = "watchlist_entries"

    id = Column(Integer, primary_key=True, index=True)
    case_id = Column(String, index=True, nullable=True)
    group_name = Column(String, index=True, nullable=True, default="Default")
    value = Column(String, index=True, nullable=False)   # number / IP / IMEI / cell-id
    kind = Column(String, nullable=False)                # 'phone' | 'ip' | 'imei' | 'cell'
    note = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
