from sqlalchemy import Column
from sqlalchemy import Float
from sqlalchemy import String

from app.core.database import Base


class Tower(Base):
    __tablename__ = "towers"

    tower_id = Column(String, primary_key=True, index=True)
    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)
    city = Column(String, nullable=True)
    state = Column(String, nullable=True)
