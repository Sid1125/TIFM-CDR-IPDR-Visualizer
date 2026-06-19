from sqlalchemy import Column, DateTime, Integer, String, Text

from app.core.database import Base


class Annotation(Base):
    __tablename__ = "annotations"

    id = Column(Integer, primary_key=True, index=True)
    record_type = Column(String, index=True, nullable=False)
    record_id = Column(Integer, index=True, nullable=False)
    tag = Column(String, nullable=False)
    note = Column(Text, nullable=True)
    created_by = Column(String, nullable=True)
    created_at = Column(DateTime, nullable=True)
