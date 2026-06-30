"""Portable backup / restore (Phase 5).

Snapshots the whole database into a single **portable SQLite file** and restores from it — works
across the SQLite and PostgreSQL backends with no external tool (no ``pg_dump``), so it fits the
air-gapped design and lets a case be carried between machines. Rows are streamed in chunks, so it
scales to large cases without loading a table into memory.

The snapshot contains *every* table in the ORM metadata, including ``users`` (password hashes) and
the ``audit_logs`` — treat the file as sensitive. FTS indexes are not copied (they're rebuilt from
the data at startup) and analytics_cache is regenerable but harmless to include.
"""
from __future__ import annotations

import logging
from pathlib import Path

from sqlalchemy import create_engine, inspect, select

from app.core.database import Base

log = logging.getLogger(__name__)

_CHUNK = 5000


def _load_all_models() -> None:
    """Import every module under app.models so Base.metadata is fully populated regardless of
    entry point (the standalone backup script doesn't go through app.main, which imports them)."""
    import importlib
    import pkgutil
    import app.models as models_pkg
    for mod in pkgutil.iter_modules(models_pkg.__path__):
        importlib.import_module(f"app.models.{mod.name}")


def _sqlite_url(path: str | Path) -> str:
    return f"sqlite:///{Path(path).resolve().as_posix()}"


def _copy_table(src_conn, dst_conn, table) -> int:
    result = src_conn.execution_options(stream_results=True).execute(select(table))
    total = 0
    while True:
        chunk = result.fetchmany(_CHUNK)
        if not chunk:
            break
        dst_conn.execute(table.insert(), [dict(r._mapping) for r in chunk])
        total += len(chunk)
    return total


def export_database(src_engine, dest_path: str | Path) -> dict[str, int]:
    """Copy every ORM table from `src_engine` into a fresh portable SQLite file at `dest_path`.
    Returns per-table row counts. Overwrites an existing file at the path."""
    _load_all_models()
    dest_path = Path(dest_path)
    if dest_path.exists():
        dest_path.unlink()
    dest_engine = create_engine(_sqlite_url(dest_path))
    Base.metadata.create_all(dest_engine)  # mirror the schema into the snapshot
    counts: dict[str, int] = {}
    try:
        with src_engine.connect() as s, dest_engine.begin() as d:
            for table in Base.metadata.sorted_tables:  # FK-safe insert order
                counts[table.name] = _copy_table(s, d, table)
    finally:
        dest_engine.dispose()
    log.info("backup: exported %d tables to %s", len(counts), dest_path)
    return counts


def restore_database(dest_engine, backup_path: str | Path, replace: bool = False) -> dict[str, int]:
    """Load rows from a backup SQLite file into `dest_engine`. With replace=True the target tables
    are emptied first (reverse FK order). Tables missing from an older snapshot are skipped."""
    _load_all_models()
    backup_path = Path(backup_path)
    if not backup_path.exists():
        raise FileNotFoundError(f"backup file not found: {backup_path}")
    src_engine = create_engine(_sqlite_url(backup_path))
    src_insp = inspect(src_engine)
    counts: dict[str, int] = {}
    try:
        with src_engine.connect() as s, dest_engine.begin() as d:
            if replace:
                for table in reversed(Base.metadata.sorted_tables):
                    d.execute(table.delete())
            for table in Base.metadata.sorted_tables:
                if not src_insp.has_table(table.name):
                    continue  # snapshot predates this table
                counts[table.name] = _copy_table(s, d, table)
    finally:
        src_engine.dispose()
    log.info("backup: restored %d tables from %s (replace=%s)", len(counts), backup_path, replace)
    return counts
