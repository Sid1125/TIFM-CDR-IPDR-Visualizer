from sqlalchemy import Column, DateTime, Integer, String, Text, UniqueConstraint, func

from app.core.database import Base


class IngestFormatProfile(Base):
    """A learned (or seeded) CSV column-header format for one record kind. `signature` is a hash of
    the file's sorted+normalized headers, so any upload whose header set matches a known format is
    recognised before a single data row is read and its saved canonical->header mapping is applied
    automatically. Profiles are created by seeding known operator formats and by investigators
    saving a manually-corrected mapping from the upload preview — new ISP formats never require a
    code change."""

    __tablename__ = "ingest_format_profiles"
    __table_args__ = (UniqueConstraint("kind", "signature", name="uq_format_profile_kind_sig"),)

    id = Column(Integer, primary_key=True, index=True)
    kind = Column(String, index=True, nullable=False)      # 'cdr' | 'ipdr' | 'dump' | 'sdr'
    name = Column(String, nullable=False)                  # e.g. "DoT IPDR Standard"
    signature = Column(String, index=True, nullable=False)  # sha256 of sorted normalized headers
    headers_json = Column(Text, nullable=False)            # raw header list (display / fuzzy match)
    mapping_json = Column(Text, nullable=False)            # canonical -> actual header
    times_used = Column(Integer, nullable=False, default=0)
    last_used = Column(DateTime(timezone=True), nullable=True)
    created_by = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
