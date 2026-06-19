from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import declarative_base
from sqlalchemy.orm import sessionmaker

from app.core.config import settings


database_url = settings.DATABASE_URL
url = make_url(database_url)
engine_kwargs = {"pool_pre_ping": True}

if url.get_backend_name() == "sqlite":
    engine_kwargs["connect_args"] = {"check_same_thread": False}


def _create_engine(url_string: str):
    parsed = make_url(url_string)
    kwargs = {"pool_pre_ping": True}
    if parsed.get_backend_name() == "sqlite":
        kwargs["connect_args"] = {"check_same_thread": False}
    return create_engine(url_string, **kwargs)


engine = _create_engine(database_url)

try:
    with engine.connect():
        pass
except OperationalError:
    fallback_db = Path(__file__).resolve().parents[2] / "cdrdb.sqlite3"
    engine = _create_engine(f"sqlite:///{fallback_db.as_posix()}")

SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine,
)

Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
