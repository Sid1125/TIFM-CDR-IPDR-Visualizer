from pydantic import BaseModel


class TowerBase(BaseModel):
    tower_id: str
    latitude: float | None = None
    longitude: float | None = None
    city: str | None = None
    state: str | None = None


class TowerCreate(TowerBase):
    pass


class TowerRead(TowerBase):
    class Config:
        from_attributes = True

