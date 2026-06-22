"""Create the PostgreSQL database named in DATABASE_URL, if it doesn't already exist.

The application auto-creates the *tables* (and the default admin user) on first startup,
but PostgreSQL itself needs the database to exist beforehand. Run this once for a fresh
Postgres setup. For SQLite this is a no-op — the file is created automatically.

    python scripts/init_db.py
"""
from __future__ import annotations

import sys

from sqlalchemy.engine.url import make_url

from app.core.config import settings


def main():
    url = make_url(settings.DATABASE_URL)
    backend = url.get_backend_name()

    if backend == "sqlite":
        print("SQLite configured — no database creation needed (the file is auto-created).")
        return
    if not backend.startswith("postgresql"):
        print(f"Unsupported database backend: {backend}. Nothing to do.")
        return

    import psycopg2

    dbname = url.database
    try:
        admin = psycopg2.connect(host=url.host, port=url.port or 5432,
                                 user=url.username, password=url.password, dbname="postgres")
    except Exception as exc:  # noqa: BLE001
        print("Could not connect to the PostgreSQL server with the credentials in DATABASE_URL:")
        print(f"  {exc}")
        print("Check the server is running and the user/password/host/port are correct.")
        sys.exit(1)

    admin.autocommit = True
    cur = admin.cursor()
    cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (dbname,))
    if cur.fetchone():
        print(f"Database {dbname!r} already exists.")
    else:
        cur.execute(f'CREATE DATABASE "{dbname}"')
        print(f"Created database {dbname!r}.")
    admin.close()
    print("Done. Start the app and the tables + default admin will be created automatically.")


if __name__ == "__main__":
    main()
