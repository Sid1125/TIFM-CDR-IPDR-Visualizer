from sqlalchemy import Column, DateTime, Integer, String, func

from app.core.database import Base


class WatchlistEntry(Base):
    __tablename__ = "watchlist_entries"

    id = Column(Integer, primary_key=True, index=True)
    case_id = Column(String, index=True, nullable=True)
    value = Column(String, index=True, nullable=False)   # phone number (CDR) or IP address (IPDR)
    kind = Column(String, nullable=False)                # 'phone' | 'ip'
    note = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
