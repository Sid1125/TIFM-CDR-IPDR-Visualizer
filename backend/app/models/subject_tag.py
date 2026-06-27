from sqlalchemy import Column, DateTime, Integer, String, Text, func

from app.core.database import Base


class SubjectTag(Base):
    """A free-text intel tag/comment attached to a subject identifier (a phone number or an IP).

    Global by identifier on purpose: the tag is keyed by the literal subject string and carries no
    case_id, so a tag set on a number/IP surfaces in EVERY case that identifier appears in. This is
    deliberate — it lets outside intel ("financier", "uses 3 SIMs") follow a reoffender across
    cases. CDR/IPDR separation is preserved automatically: phone identifiers and IP identifiers are
    distinct strings, so a phone tag can never land on an IP row."""

    __tablename__ = "subject_tags"

    id = Column(Integer, primary_key=True, index=True)
    subject = Column(String, unique=True, index=True, nullable=False)
    tag = Column(Text, nullable=False)
    updated_by = Column(String, nullable=True)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
