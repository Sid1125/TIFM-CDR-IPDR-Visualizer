from sqlalchemy import Column, DateTime, Integer, String, Text, func

from app.core.database import Base


class Hypothesis(Base):
    """A structured 'theory of the case' an investigator maintains: a titled hypothesis with a body,
    a status (open / supported / refuted), and optional linked subjects. Case-scoped. This is the
    'what do we think happened' layer that sits above the raw evidence and analytics."""

    __tablename__ = "hypotheses"

    id = Column(Integer, primary_key=True, index=True)
    case_id = Column(String, index=True, nullable=True)
    title = Column(String, nullable=False)
    body = Column(Text, nullable=True)
    status = Column(String, default="open", nullable=False)  # open | supported | refuted
    subjects = Column(Text, nullable=True)                    # JSON array of linked subject ids
    created_by = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
