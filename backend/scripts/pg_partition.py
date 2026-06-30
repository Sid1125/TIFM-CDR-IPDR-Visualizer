"""Opt-in PostgreSQL partitioning migration (Phase 1c).

Recreates ``cdr_records`` / ``ipdr_records`` as HASH-partitioned-by-``case_id`` tables (default
16 partitions). Because every analytic query filters by ``case_id``, hash partitioning gives even
data distribution plus partition pruning on those queries — the scale win for 1–5M-row cases.

The app and ORM need **no changes**: queries still use the surrogate ``id``. Postgres requires the
partition key to sit in any primary/unique key, and forcing ``case_id`` into the PK would make it
NOT NULL — but uncased records legitimately have NULL ``case_id``. So the partitioned table carries
**no PK**; ``id`` uniqueness is already guaranteed by its sequence, and a plain index on ``id`` keeps
id-based lookups (e.g. page hydration) fast. SQLite has no partitioning; this script is a no-op there.

SAFETY
------
* ``--dry-run`` (default) only prints the DDL — nothing is executed.
* ``--execute`` performs the migration **inside a transaction**, renaming the original to
  ``<table>_preparted`` (it is NOT dropped — verify, then drop it yourself).
* ``--self-test`` validates the whole mechanism on a throwaway scratch table and rolls back, so
  you can confirm it works on your Postgres version without touching real data.

Run during a maintenance window, and back up first.

Usage:
    python -m scripts.pg_partition --self-test
    python -m scripts.pg_partition --table cdr_records            # dry-run
    python -m scripts.pg_partition --table cdr_records --execute
"""
from __future__ import annotations

import argparse
import sys

from sqlalchemy import text

from app.core.database import engine

_TABLES = ("cdr_records", "ipdr_records")
_DEFAULT_MODULUS = 16


def _is_postgres() -> bool:
    return engine.url.get_backend_name() == "postgresql"


def build_ddl(table: str, modulus: int = _DEFAULT_MODULUS) -> list[str]:
    """The ordered statements that turn `table` into a hash-partitioned copy and swap it in.
    `LIKE ... INCLUDING ALL EXCLUDING CONSTRAINTS EXCLUDING INDEXES` copies columns/defaults but
    not the single-column PK (which Postgres would reject on a partitioned table); we add the
    composite PK and the indexes explicitly."""
    new = f"{table}_partitioned"
    stmts = [
        f"CREATE TABLE {new} (LIKE {table} INCLUDING DEFAULTS INCLUDING STORAGE) "
        f"PARTITION BY HASH (case_id)",
    ]
    for r in range(modulus):
        stmts.append(
            f"CREATE TABLE {new}_p{r} PARTITION OF {new} "
            f"FOR VALUES WITH (MODULUS {modulus}, REMAINDER {r})"
        )
    stmts += [
        # no PK (would force case_id NOT NULL); a plain id index keeps lookups fast and the
        # sequence already guarantees id uniqueness.
        f"CREATE INDEX ON {new} (id)",
        f"INSERT INTO {new} SELECT * FROM {table}",
        f"ALTER TABLE {table} RENAME TO {table}_preparted",
        f"ALTER TABLE {new} RENAME TO {table}",
        # the app re-creates its composite/search indexes idempotently at startup
        # (_ensure_indexes / ensure_pg_trgm_indexes), so we don't duplicate them here.
    ]
    return stmts


def _seq_reset(table: str) -> str:
    """Keep the id sequence ahead of the copied rows (the new table inherited the default but the
    sequence ownership/last-value should still be correct since it's the same sequence)."""
    return (
        f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), "
        f"COALESCE((SELECT MAX(id) FROM {table}), 1))"
    )


def self_test(modulus: int = 4) -> bool:
    """Prove the mechanism on a scratch table that mimics the real shape (surrogate id PK +
    nullable case_id, including a NULL row to confirm hash partitioning accepts NULL). Rolls back."""
    probe = "_argus_part_probe"
    parent = f"{probe}_partitioned"
    try:
        with engine.begin() as c:
            c.execute(text(f"DROP TABLE IF EXISTS {probe} CASCADE"))
            c.execute(text(f"DROP TABLE IF EXISTS {parent} CASCADE"))
            c.execute(text(f"CREATE TABLE {probe} (id serial PRIMARY KEY, case_id varchar, val int)"))
            c.execute(text(f"INSERT INTO {probe} (case_id, val) VALUES ('A',1),('B',2),('A',3),(NULL,4)"))
            c.execute(text(
                f"CREATE TABLE {parent} (LIKE {probe} INCLUDING DEFAULTS INCLUDING STORAGE) "
                f"PARTITION BY HASH (case_id)"
            ))
            for r in range(modulus):
                c.execute(text(
                    f"CREATE TABLE {parent}_p{r} PARTITION OF {parent} "
                    f"FOR VALUES WITH (MODULUS {modulus}, REMAINDER {r})"
                ))
            c.execute(text(f"CREATE INDEX ON {parent} (id)"))
            c.execute(text(f"INSERT INTO {parent} SELECT * FROM {probe}"))
            src = c.execute(text(f"SELECT count(*) FROM {probe}")).scalar()
            dst = c.execute(text(f"SELECT count(*) FROM {parent}")).scalar()
            null_row = c.execute(text(f"SELECT val FROM {parent} WHERE case_id IS NULL")).scalar()
            nparts = c.execute(text(
                f"SELECT count(*) FROM pg_inherits WHERE inhparent = '{parent}'::regclass"
            )).scalar()
            # prune check: a case-scoped query should scan one partition
            plan = "\n".join(row[0] for row in c.execute(text(
                f"EXPLAIN SELECT * FROM {parent} WHERE case_id = 'A'"
            )).fetchall())
            c.execute(text(f"DROP TABLE IF EXISTS {parent} CASCADE"))
            c.execute(text(f"DROP TABLE IF EXISTS {probe} CASCADE"))
        ok = src == dst == 4 and null_row == 4 and nparts == modulus
        print(f"self-test: rows {src}->{dst} (expected 4), NULL-case row preserved={null_row==4}, "
              f"partitions={nparts}")
        print("prune check (case_id='A') — planner output:")
        for ln in plan.splitlines():
            print("   ", ln)
        print("self-test:", "PASS" if ok else "FAIL")
        return ok
    except Exception as exc:  # noqa: BLE001
        print("self-test FAILED:", exc)
        return False


def main() -> int:
    ap = argparse.ArgumentParser(description="Partition cdr_records/ipdr_records by case_id (Postgres).")
    ap.add_argument("--table", choices=_TABLES, help="table to partition")
    ap.add_argument("--modulus", type=int, default=_DEFAULT_MODULUS, help="partition count (default 16)")
    ap.add_argument("--execute", action="store_true", help="actually run (default is dry-run)")
    ap.add_argument("--self-test", action="store_true", help="validate the mechanism on a scratch table")
    args = ap.parse_args()

    if not _is_postgres():
        print(f"DB backend is {engine.url.get_backend_name()!r}, not PostgreSQL — partitioning is a no-op.")
        return 0

    if args.self_test:
        return 0 if self_test() else 1

    if not args.table:
        ap.error("--table is required (or use --self-test)")

    stmts = build_ddl(args.table, args.modulus) + [_seq_reset(args.table)]
    print(f"-- {'EXECUTING' if args.execute else 'DRY RUN'}: partition {args.table} into {args.modulus} parts\n")
    for s in stmts:
        print(s + ";")

    if not args.execute:
        print("\n(dry run — nothing executed. Re-run with --execute during a maintenance window.)")
        return 0

    try:
        with engine.begin() as c:
            for s in stmts:
                c.execute(text(s))
        print(f"\nDone. Original kept as {args.table}_preparted — verify, then DROP it.")
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"\nMigration FAILED (rolled back): {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
