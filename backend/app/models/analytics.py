from __future__ import annotations

from datetime import datetime

from sqlalchemy import Column, DateTime, Integer, String, Text, UniqueConstraint

from app.core.database import Base


class AnalyticsCache(Base):
    """Pre-computed analytics keyed by (case_id, key).

    One row per metric.  Examples:
      key="dashboard"            → get_chart_data() result
      key="subjects"             → {cdr:[...], ipdr:[...]}
      key="ai_overview"          → {pair_counts, sub_days, svc_counts, meetings}
      key="cdr_report:9876543210"
      key="ipdr_report:10.0.0.1"

    Populated asynchronously after every upload via BackgroundTasks.
    Invalidated (and recomputed) on the next upload to the same case.
    """

    __tablename__ = "analytics_cache"

    id = Column(Integer, primary_key=True, autoincrement=True)
    case_id = Column(String(64), nullable=False, index=True)
    key = Column(String(512), nullable=False)
    data = Column(Text, nullable=False)
    computed_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    # Versioning (Phase 1b): a stored row whose schema_version != the running
    # SCHEMA_VERSION is treated as a cache miss, so analytics never go stale across a
    # code update that changes their shape. record_count / build_ms are telemetry.
    schema_version = Column(Integer, default=0, nullable=False)
    record_count = Column(Integer, nullable=True)
    build_ms = Column(Integer, nullable=True)

    __table_args__ = (UniqueConstraint("case_id", "key", name="uq_analytics_case_key"),)
