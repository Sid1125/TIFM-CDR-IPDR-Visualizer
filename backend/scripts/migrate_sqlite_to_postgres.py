"""One-shot migration of the existing SQLite data into PostgreSQL.

Creates the target database + schema, copies every table preserving primary keys
(so case_id references stay valid), backfills stub tower rows for any tower a record
references but the towers table is missing (SQLite didn't enforce the FK, Postgres
does), and resets the id sequences so future inserts don't collide.

Usage:
    python scripts/migrate_sqlite_to_postgres.py \
        --sqlite cdrdb.sqlite3 \
        --pg postgresql://postgres:root@localhost:5432/cdrdb
"""
from __future__ import annotations

import argparse

import psycopg2
from sqlalchemy import create_engine, insert, select
from sqlalchemy.orm import Session

from app.core.database import Base
# Import every model so Base.metadata is complete.
from app.models.tower import Tower
from app.models.case import Case
from app.models.auth import User, AuthSession
from app.models.cdr import CDRRecord
from app.models.ipdr import IPDRRecord
from app.models.annotation import Annotation

# Insertion order respects FKs: towers + users before the rows that reference them.
ORDER = [Tower, User, Case, CDRRecord, IPDRRecord, Annotation, AuthSession]
SEQUENCE_TABLES = ["cases", "cdr_records", "ipdr_records", "users", "annotations", "auth_sessions"]


def ensure_database(pg_url: str):
    """CREATE DATABASE <name> if it doesn't exist (connecting to the maintenance db)."""
    from sqlalchemy.engine.url import make_url
    url = make_url(pg_url)
    dbname = url.database
    admin = psycopg2.connect(host=url.host, port=url.port or 5432, user=url.username,
                             password=url.password, dbname="postgres")
    admin.autocommit = True
    cur = admin.cursor()
    cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (dbname,))
    if cur.fetchone():
        print(f"database {dbname!r} already exists")
    else:
        cur.execute(f'CREATE DATABASE "{dbname}"')
        print(f"created database {dbname!r}")
    admin.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sqlite", default="cdrdb.sqlite3")
    ap.add_argument("--pg", required=True)
    args = ap.parse_args()

    ensure_database(args.pg)

    src = create_engine(f"sqlite:///./{args.sqlite}")
    dst = create_engine(args.pg)
    Base.metadata.create_all(dst)
    print("schema created on postgres")

    with Session(src) as s, Session(dst) as d:
        # Collect tower ids the records reference, plus the ones in the towers table.
        have_towers = {t.tower_id for t in s.execute(select(Tower)).scalars()}
        referenced = set()
        for Model in (CDRRecord, IPDRRecord):
            for (tid,) in s.execute(select(Model.tower_id)).all():
                if tid:
                    referenced.add(tid)
        missing = referenced - have_towers

        for Model in ORDER:
            table = Model.__table__
            rows = [dict(r._mapping) for r in s.execute(select(table))]
            if Model is Tower and missing:
                # Stub rows so the FK is satisfied (records carry their own lat/long anyway).
                rows += [{"tower_id": tid, "latitude": None, "longitude": None,
                          "city": None, "state": None} for tid in sorted(missing)]
            if rows:
                d.execute(insert(table), rows)
            print(f"  {table.name}: {len(rows)} rows"
                  + (f" (+{len(missing)} stub towers)" if Model is Tower and missing else ""))
        d.commit()

        # Reset sequences to max(id)+1.
        for tname in SEQUENCE_TABLES:
            d.execute(
                __import__("sqlalchemy").text(
                    f"SELECT setval(pg_get_serial_sequence('{tname}','id'), "
                    f"COALESCE((SELECT MAX(id) FROM {tname}), 1), true)"
                )
            )
        d.commit()
        print("sequences reset")

    print("migration complete")


if __name__ == "__main__":
    main()
