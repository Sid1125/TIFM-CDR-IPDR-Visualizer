"""Admin backup endpoints (Phase 5).

POST /backup creates a portable snapshot on the server (into settings.BACKUP_DIR); GET /backup
lists existing snapshots. Restore is intentionally NOT exposed over HTTP — it overwrites live data,
so it stays a deliberate operator action via `python -m scripts.backup --restore … --replace`.

Admin-only: a snapshot contains every table including credential hashes and the audit log.
"""
from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

from app.core.config import settings
from app.core.database import app_data_dir, engine
from app.models.auth import User
from app.services.auth_service import get_current_admin
from app.services.backup_service import export_database

router = APIRouter()

_DEFAULT_BACKUP_DIR = "backups"


def _backup_dir() -> Path:
    # The default BACKUP_DIR ("backups") is CWD-relative — inside Program Files for a frozen
    # install, which a standard user can't write to (same failure mode as the SQLite fallback in
    # core/database.py). Route the unconfigured default to the writable app-data dir instead; an
    # operator-set BACKUP_DIR (e.g. a dedicated backup volume) is respected as-is.
    if settings.BACKUP_DIR == _DEFAULT_BACKUP_DIR and getattr(sys, "frozen", False):
        d = app_data_dir() / "backups"
    else:
        d = Path(settings.BACKUP_DIR)
    d.mkdir(parents=True, exist_ok=True)
    return d


@router.post("")
def create_backup(_admin: User = Depends(get_current_admin)):
    """Write a timestamped portable snapshot of the whole DB to the server's backup directory."""
    fname = f"argus_{datetime.utcnow():%Y%m%d_%H%M%S}.sqlite3"
    path = _backup_dir() / fname
    try:
        counts = export_database(engine, path)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"backup failed: {exc}") from exc
    return {
        "file": fname,
        "rows": sum(counts.values()),
        "tables": sum(1 for v in counts.values() if v),
        "bytes": path.stat().st_size,
        "restore_hint": f"python -m scripts.backup --restore {path} --replace",
    }


@router.get("")
def list_backups(_admin: User = Depends(get_current_admin)):
    """List snapshots in the backup directory, newest first."""
    d = _backup_dir()
    if not d.exists():
        return []
    items = [
        {"file": p.name, "bytes": p.stat().st_size,
         "modified": datetime.utcfromtimestamp(p.stat().st_mtime).isoformat()}
        for p in d.glob("*.sqlite3")
    ]
    return sorted(items, key=lambda x: x["file"], reverse=True)
