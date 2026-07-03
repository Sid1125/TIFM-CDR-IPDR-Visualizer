import os
import sys
from pathlib import Path

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import declarative_base
from sqlalchemy.orm import sessionmaker

from app.core.config import settings


_DEFAULT_SQLITE_URL = "sqlite:///./cdrdb.sqlite3"
database_url = settings.DATABASE_URL
url = make_url(database_url)


def _create_engine(url_string: str):
    parsed = make_url(url_string)
    kwargs: dict = {"pool_pre_ping": True}
    if parsed.get_backend_name() == "sqlite":
        # timeout: how long the DBAPI itself waits for a lock before raising — a defense-in-depth
        # backstop for the very first connection (before the PRAGMA below has run). check_same_thread
        # is off because a Session's connection can be used from whichever threadpool worker FastAPI
        # hands the request to, not necessarily the thread that opened it.
        kwargs["connect_args"] = {"check_same_thread": False, "timeout": 30}
    else:
        kwargs["pool_size"] = 10
        kwargs["max_overflow"] = 20
        kwargs["pool_timeout"] = 30
        kwargs["pool_recycle"] = 1800
    new_engine = create_engine(url_string, **kwargs)
    if new_engine.url.get_backend_name() == "sqlite":
        _enable_wal(new_engine)
    return new_engine


def _enable_wal(sqlite_engine) -> None:
    """Every uvicorn request can land on a different threadpool worker, each opening its own
    SQLite connection — with the default rollback-journal mode, one thread's write transaction
    (e.g. an upload's analytics-cache invalidation) blocks every other connection's writes, and
    without a busy timeout SQLite raises "database is locked" immediately instead of waiting.
    WAL lets readers proceed without blocking on a writer at all (the single-writer-at-a-time
    limitation SQLite always has stays, but contention drops sharply), and busy_timeout makes any
    remaining writer/writer collision a brief wait instead of a hard failure. Set once per new
    DBAPI connection, so it survives connection-pool recycling."""
    @event.listens_for(sqlite_engine, "connect")
    def _set_sqlite_pragmas(dbapi_connection, _record):  # noqa: ANN001
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.close()


def app_data_dir() -> Path:
    """A writable, machine-wide app-data directory for a frozen (PyInstaller) build.

    A frozen build's `__file__`/CWD resolves inside the install directory (Program Files, per
    argus_installer.iss) — a standard, non-elevated user can read there but not write. Anything
    the running app needs to write at runtime (the SQLite fallback DB, admin-triggered backups)
    belongs here instead, not next to the executable. Shared machine-wide (not per-user) so every
    investigator account on the box sees the same case data and backups, matching the app's
    multi-user model. Unfrozen (dev/test) callers shouldn't call this — see each caller's own
    dev-path fallback.
    """
    if os.name == "nt":
        base = Path(os.environ.get("PROGRAMDATA", r"C:\ProgramData")) / "ARGUS"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "argus"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _fallback_db_path() -> Path:
    """Where the zero-config SQLite fallback lives — see app_data_dir() for why frozen builds
    can't just use a path next to the executable. Unfrozen (dev/test) runs are unaffected — same
    repo-relative path as before."""
    if getattr(sys, "frozen", False):
        return app_data_dir() / "cdrdb.sqlite3"
    return Path(__file__).resolve().parents[2] / "cdrdb.sqlite3"


def _writable(candidate_engine) -> bool:
    """SQLite only: a real write+commit probe, not just connect(). SQLite happily "connects" to a
    file in a read-only directory (the OS handle opens fine) and only fails once a write actually
    touches the file — a bare connect() check misses an unwritable install directory entirely,
    which is exactly how a Program Files install limped along until the first login write. Other
    backends (Postgres, …) keep the original connect-only check: a DDL probe there risks racing
    concurrent workers over a shared throwaway table for a failure mode (directory permissions)
    that's SQLite-specific anyway."""
    try:
        with candidate_engine.connect() as conn:
            if candidate_engine.url.get_backend_name() != "sqlite":
                return True
            conn.execute(text("CREATE TABLE IF NOT EXISTS _argus_write_probe (id INTEGER)"))
            conn.execute(text("DROP TABLE _argus_write_probe"))
            conn.commit()
        return True
    except OperationalError:
        return False


# The baked-in zero-config default (unset DATABASE_URL) always points next to the source/install
# tree. In a frozen build that's inside Program Files, so route straight to a writable app-data
# location rather than probing a path we already know is the risky pattern. An explicit
# DATABASE_URL (env/.env — Postgres or a custom path) is an operator choice and is respected as-is
# unless it turns out to be unwritable/unreachable, in which case it still falls back below.
if database_url == _DEFAULT_SQLITE_URL and getattr(sys, "frozen", False):
    database_url = f"sqlite:///{_fallback_db_path().as_posix()}"

engine = _create_engine(database_url)

if not _writable(engine):
    fallback_db = _fallback_db_path()
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
