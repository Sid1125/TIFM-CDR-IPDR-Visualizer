#!/usr/bin/env bash
# Fresh-project setup for Project ARGUS (Advanced Records & Geospatial Unified Surveillance) — macOS / Linux.
# Run from the backend/ directory:   ./setup.sh
#
# PostgreSQL is the primary database (SQLite is only an automatic fallback/backup).
# This script creates the venv, installs deps, writes backend/.env with your Postgres
# connection, and creates the database. Afterwards just run the dashboard.
set -euo pipefail
cd "$(dirname "$0")"

PY="${PYTHON:-python3}"

echo "== 1/4  Virtual environment =="
[ -d .venv ] || "$PY" -m venv .venv
# shellcheck disable=SC1091
source .venv/bin/activate

echo "== 2/4  Dependencies =="
python -m pip install --upgrade pip
pip install -r requirements.txt

echo "== 3/4  Database configuration =="
if [ -f .env ]; then
  echo "backend/.env already exists — leaving it untouched."
else
  cp .env.example .env
  echo "PostgreSQL is the primary database. Enter your connection details"
  echo "(press Enter to accept the [default]; leave the password blank to use SQLite instead)."
  read -rp "  host [localhost]: " PGHOST; PGHOST=${PGHOST:-localhost}
  read -rp "  port [5432]: " PGPORT; PGPORT=${PGPORT:-5432}
  read -rp "  user [postgres]: " PGUSER; PGUSER=${PGUSER:-postgres}
  read -rsp "  password: " PGPASS; echo
  read -rp "  database name [cdrdb]: " PGDB; PGDB=${PGDB:-cdrdb}

  python - "$PGHOST" "$PGPORT" "$PGUSER" "$PGPASS" "$PGDB" <<'PYEOF'
import re, sys, urllib.parse
host, port, user, pw, db = sys.argv[1:6]
if pw:
    url = f"postgresql://{urllib.parse.quote(user)}:{urllib.parse.quote(pw)}@{host}:{port}/{db}"
else:
    url = "sqlite:///./cdrdb.sqlite3"
    print("  No password entered — configuring SQLite.")
txt = open(".env", encoding="utf-8").read()
if re.search(r"^DATABASE_URL=.*$", txt, flags=re.M):
    txt = re.sub(r"^DATABASE_URL=.*$", "DATABASE_URL=" + url, txt, flags=re.M)
else:
    txt = "DATABASE_URL=" + url + "\n" + txt
open(".env", "w", encoding="utf-8").write(txt)
print("  Wrote DATABASE_URL to backend/.env")
PYEOF
fi

echo "== 4/4  Creating database =="
python scripts/init_db.py

echo
echo "Setup complete. Run the dashboard:"
echo "  source .venv/bin/activate"
echo "  uvicorn app.main:app --reload"
echo "Open http://127.0.0.1:8000  (login admin / the password in backend/.env)"
