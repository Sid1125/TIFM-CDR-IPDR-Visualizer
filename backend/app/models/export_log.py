from sqlalchemy import Column, DateTime, Integer, String, Text, func

from app.core.database import Base


class ExportLog(Base):
    """Audit record of a generated case-report export, so every export is trackable:
    who exported what, from where (navbar evidence report vs Inferences analysis report),
    under which official reference id, and a manifest of the contents."""

    __tablename__ = "export_logs"

    id = Column(Integer, primary_key=True, index=True)
    ref_id = Column(String, index=True, nullable=False)   # ARGUS-ANL/EVD-YYYYMMDD-HHMMSS-XXXX
    source = Column(String, nullable=False)               # 'analysis' (Inferences tab) | 'evidence' (navbar)
    case_id = Column(String, index=True, nullable=True)
    case_name = Column(String, nullable=True)
    exported_by = Column(String, nullable=True)
    details = Column(Text, nullable=True)                 # JSON manifest of what was exported
    created_at = Column(DateTime(timezone=True), server_default=func.now())
