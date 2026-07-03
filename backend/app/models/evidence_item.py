from sqlalchemy import Column, DateTime, Integer, String, Text, UniqueConstraint, func

from app.core.database import Base


class EvidenceItem(Base):
    """A pinned finding on the investigation board, with its review lifecycle.

    Findings start machine-made ('system': story pins, activity events, chart/graph
    snapshots, AI flags) and an investigator moves them through the lifecycle:

        system  ->  confirmed   (human judgement: this happened / matters)
                ->  rejected    (false positive; kept, not deleted — the decision is
                                 itself part of the record)

    plus a free-text note either way. Server-persisted so the board is shared across
    investigators and browsers and every transition lands in the chain of custody;
    the browser's localStorage copy is just a working cache. `sig` is the stable
    client-side identity of a finding (kind|timestamp|title), unique per case, so
    re-pinning the same finding upserts instead of duplicating."""

    __tablename__ = "evidence_items"
    __table_args__ = (UniqueConstraint("case_id", "sig", name="uq_evidence_case_sig"),)

    id = Column(Integer, primary_key=True, index=True)
    case_id = Column(String, index=True, nullable=True)
    sig = Column(String, nullable=False)
    kind = Column(String, nullable=False, default="note")
    label = Column(String, nullable=False, default="")
    detail = Column(Text, nullable=True)
    subject = Column(String, index=True, nullable=True)
    ts = Column(DateTime, nullable=True)          # when the underlying event happened
    image = Column(Text, nullable=True)           # data-URL snapshot (charts/graphs)
    status = Column(String, nullable=False, default="system")  # system | confirmed | rejected
    note = Column(Text, nullable=True)
    created_by = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    reviewed_by = Column(String, nullable=True)
    reviewed_at = Column(DateTime(timezone=True), nullable=True)
