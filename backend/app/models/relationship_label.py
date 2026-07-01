from sqlalchemy import Column, DateTime, Integer, String, Text, UniqueConstraint, func

from app.core.database import Base


class RelationshipLabel(Base):
    """A label on the relationship BETWEEN two subjects — the edge analogue of a subject intel tag.

    e.g. "brothers", "supplier -> dealer", "same vehicle", "landlord/tenant". Global by pair (no
    case_id) so a known relationship follows the two identifiers across every case, and stored with
    the pair normalised (subject_a <= subject_b) so the label is order-independent. Phone and IP
    identifiers are distinct strings, so CDR/IPDR separation holds automatically."""

    __tablename__ = "relationship_labels"

    id = Column(Integer, primary_key=True, index=True)
    subject_a = Column(String, index=True, nullable=False)  # normalised: subject_a <= subject_b
    subject_b = Column(String, index=True, nullable=False)
    label = Column(String, nullable=False)
    note = Column(Text, nullable=True)
    updated_by = Column(String, nullable=True)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (UniqueConstraint("subject_a", "subject_b", name="uq_reledge_pair"),)
