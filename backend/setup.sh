#!/usr/bin/env bash
# Fresh-project setup for the Project ARGUS (Advanced Records & Geospatial Unified Surveillance) (macOS / Linux).
# Run from the backend/ directory:   ./setup.sh
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

echo "== 3/4  Environment file =="
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created backend/.env from .env.example."
  echo "EDIT backend/.env now: set DATABASE_URL (Postgres user/password/host) and AUTH_BOOTSTRAP_PASSWORD."
  echo "Tip: for the simplest start with no Postgres, set  DATABASE_URL=sqlite:///./cdrdb.sqlite3"
else
  echo "backend/.env already exists — leaving it untouched."
fi

echo "== 4/4  Database =="
python scripts/init_db.py

echo
echo "Setup complete."
echo "Start the app:"
echo "  source .venv/bin/activate"
echo "  uvicorn app.main:app --reload"
echo "Open http://127.0.0.1:8000  (login: admin / the password set in backend/.env)"
