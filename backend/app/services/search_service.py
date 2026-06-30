"""Free-text record search — substring ("contains") matching that scales.

The records table searches a handful of identifier columns with `ILIKE '%x%'`, which forces a
full scan at millions of rows. This module centralises that search and, when an accelerator is
available, makes it index-backed — transparently, with an ILIKE fallback so the air-gapped
default keeps working:

* **Postgres + pg_trgm**: GIN trigram indexes on the searched columns make the *existing* ILIKE
  queries index-backed with no query change (`ensure_pg_trgm_indexes`).
* **SQLite + FTS5 (trigram tokenizer)**: a per-table FTS index (`cdr_fts` / `ipdr_fts`) keyed by
  row id; search becomes `id IN (SELECT rowid FROM …_fts WHERE …_fts MATCH :q)`. Kept in sync by
  `fts_sync` (one prune + one insert-missing, pure SQL — no per-row Python, no bulk-insert
  triggers). Wired to the event bus so an upload/reset refreshes the index.

`cdr_search_clause` / `ipdr_search_clause` are the single source of truth used by every search
call site, so the FTS-vs-ILIKE decision lives in exactly one place.
"""
from __future__ import annotations

import logging

from sqlalchemy import or_, text

from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord

log = logging.getLogger(__name__)

# Trigram tokenisers index 3-char sequences; a query shorter than this can't use the index, so we
# fall back to ILIKE for 1–2 char terms.
_MIN_TRIGRAM = 3

# Canonical searched columns per kind — a superset of every ILIKE call site, so FTS results match
# exactly what ILIKE would return.
_CDR_COLS = ["a_party_number", "b_party_number", "tower_id", "case_id",
             "msisdn", "imsi", "imei", "cell_id", "call_type"]
_IPDR_COLS = ["source_ip", "destination_ip", "protocol", "tower_id", "case_id",
              "msisdn", "imsi", "imei", "apn"]

_TABLES = {"cdr": ("cdr_records", "cdr_fts", _CDR_COLS),
           "ipdr": ("ipdr_records", "ipdr_fts", _IPDR_COLS)}

# Set True only once the FTS tables are actually created (ensure_fts_tables). Gating the search
# path on this — not just CAPS.sqlite_fts5 — means a failed FTS init falls back to ILIKE instead
# of querying a table that doesn't exist.
_fts_ready = False


def fts_active() -> bool:
    from app.core.capabilities import CAPS
    return CAPS.sqlite_fts5 and _fts_ready


# ── query helpers ──────────────────────────────────────────────────────────────

def _fts_phrase(q: str) -> str:
    """Quote the term as a single FTS5 phrase so punctuation/operators are literal, not syntax."""
    return '"' + q.replace('"', '""') + '"'


def _ilike_clause(model, cols: list[str], search: str):
    like = f"%{search}%"
    return or_(*[getattr(model, c).ilike(like) for c in cols])


def _search_clause(kind: str, model, search: str | None):
    if not search or not search.strip():
        return None
    s = search.strip()
    _table, fts, cols = _TABLES[kind]
    if fts_active() and len(s) >= _MIN_TRIGRAM:
        # id IN (matching rowids) — the FTS index does the substring work.
        return text(f"{_table}.id IN (SELECT rowid FROM {fts} WHERE {fts} MATCH :fts_q)").bindparams(fts_q=_fts_phrase(s))
    # Postgres pg_trgm accelerates this ILIKE transparently; plain SQLite falls back to a scan.
    return _ilike_clause(model, cols, s)


def cdr_search_clause(search: str | None):
    return _search_clause("cdr", CDRRecord, search)


def ipdr_search_clause(search: str | None):
    return _search_clause("ipdr", IPDRRecord, search)


# ── FTS5 index lifecycle (SQLite) ───────────────────────────────────────────────

def _concat_sql(cols: list[str]) -> str:
    return " || ' ' || ".join(f"COALESCE({c}, '')" for c in cols)


def ensure_fts_tables(engine) -> None:
    """Create the FTS5 trigram tables if missing. No-op unless SQLite has FTS5. Marks the FTS
    path ready only once creation succeeds, so search never targets a missing table."""
    global _fts_ready
    from app.core.capabilities import CAPS
    if not CAPS.sqlite_fts5:
        return
    with engine.begin() as conn:
        for _kind, (_tbl, fts, _cols) in _TABLES.items():
            conn.execute(text(
                f"CREATE VIRTUAL TABLE IF NOT EXISTS {fts} USING fts5(text, tokenize='trigram')"
            ))
    _fts_ready = True


def fts_sync(db, kind: str) -> None:
    """Re-sync one FTS index to its table: drop orphans, add missing rows. Pure SQL, idempotent —
    correct after import (replace), append, reset, or delete alike."""
    from app.core.capabilities import CAPS
    if not CAPS.sqlite_fts5:
        return
    tbl, fts, cols = _TABLES[kind]
    db.execute(text(f"DELETE FROM {fts} WHERE rowid NOT IN (SELECT id FROM {tbl})"))
    db.execute(text(
        f"INSERT INTO {fts}(rowid, text) "
        f"SELECT t.id, {_concat_sql(cols)} FROM {tbl} t "
        f"LEFT JOIN {fts} f ON f.rowid = t.id WHERE f.rowid IS NULL"
    ))
    db.commit()


def fts_sync_all(db) -> None:
    for kind in _TABLES:
        fts_sync(db, kind)


# ── pg_trgm indexes (Postgres) ──────────────────────────────────────────────────

def ensure_pg_trgm_indexes(engine) -> None:
    """Create GIN trigram indexes so the existing ILIKE search is index-backed. No-op off pg_trgm."""
    from app.core.capabilities import CAPS
    if not CAPS.pg_trgm:
        return
    with engine.begin() as conn:
        for _kind, (tbl, _fts, cols) in _TABLES.items():
            for col in cols:
                idx = f"ix_trgm_{tbl}_{col}"
                try:
                    conn.execute(text(
                        f"CREATE INDEX IF NOT EXISTS {idx} ON {tbl} USING gin ({col} gin_trgm_ops)"
                    ))
                except Exception as exc:  # noqa: BLE001 — best effort, never fatal at startup
                    log.info("pg_trgm index %s skipped (%s)", idx, exc)
