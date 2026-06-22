# Project ARGUS
### Advanced Records & Geospatial Unified Surveillance

A full-stack telecom forensics platform for analysing **Call Detail Records (CDR)**, **IP
Data Records (IPDR)** and **cell-tower locations**. It reconstructs communication and
internet sessions, maps movement, attributes traffic to services/providers, and runs a
spatiotemporal inference engine that surfaces investigative leads — all organised per case.

> **CDR and IPDR are analysed separately.** A CDR subject is a **phone number**; an IPDR
> subject is an **IP address**. The two streams are never cross-attributed.

---

## Table of contents
- [Features](#features)
- [Tech stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Quick start (setup script)](#quick-start-setup-script)
- [Manual setup](#manual-setup)
- [Configuration (.env)](#configuration-env)
- [Database](#database)
- [Running the app](#running-the-app)
- [Usage guide](#usage-guide)
- [Input CSV formats](#input-csv-formats)
- [Scripts](#scripts)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Project structure](#project-structure)
- [Documentation](#documentation)

---

## Features

- **Dashboard** — case hero summary, key metrics, network/service/activity panels.
- **Network Graph** — D3 force-directed contact graph with centrality & community detection.
- **Tower Map** — Leaflet map: movement path (with per-leg distance / time / speed / travel-mode hover), heatmap, operational zones, co-location, meetings, **inference overlays** (impossible travel, convoys, home/work anchors) and an interactive **geofence**.
- **Timeline** — session-reconstructed, entity-grouped timeline.
- **Charts / Services / Correlation / Records** — service distribution, behavioural charts, cross-subject correlation, and a full searchable record table.
- **Inferences** — automated **spatiotemporal analysis**, split into:
  - **CDR (phone subjects):** impossible-travel / SIM-clone, SIM-swap & burner handsets, convoys & "met but never called" hidden links, scheduled-contact cadence, home/work anchors, odd-hours activity — with a ranked **Persons of Interest** list.
  - **IPDR (IP subjects):** VPN / proxy connections by source IP, with the destination server and provider.
- **Service / app attribution** — two-layer engine (provider IP-range match + port classification) with longest-prefix matching, an indexed lookup that scales to ~100k rows, and pluggable live provider-range feeds.
- **AI Insights** — optional local LLM (Ollama) report generation and Q&A.
- **Cases & Auth** — multi-case workspaces; PBKDF2-authenticated sessions with sliding expiry.

## Tech stack

| Layer | Technology |
|-------|-----------|
| Backend | Python 3.10+, FastAPI, SQLAlchemy, Pandas, NetworkX |
| Database | PostgreSQL (recommended) — automatic SQLite fallback if it can't connect |
| Frontend | Vanilla-JS SPA served by FastAPI (no build step) |
| Visualisation | D3.js v7, Chart.js 4, Leaflet 1.9 (+ draw, heat), Turf.js |
| Auth | Session cookies, PBKDF2-SHA256 (210k iterations) |
| AI (optional) | Local Ollama API |

---

## Prerequisites

- **Python 3.10 or newer** (developed on 3.14). Check: `python --version`.
- **PostgreSQL 13+** — *recommended*. If unavailable, the app automatically falls back to a
  local SQLite file, so Postgres is **optional** for a quick trial.
- **Git** (to clone).
- **Ollama** *(optional)* — only for the AI Insights tab. See <https://ollama.com>.

No Node.js/npm is required — the frontend is plain static files served by the backend.

---

## Quick start (setup script)

From the **`backend/`** directory:

**Windows (PowerShell)**
```powershell
cd backend
.\setup.ps1
```

**macOS / Linux**
```bash
cd backend
chmod +x setup.sh
./setup.sh
```

The script creates a virtual environment, installs dependencies, copies `.env.example` →
`.env`, and creates the Postgres database (if you configured one). It then prints the
command to start the app. **Edit `backend/.env`** when prompted (database URL + admin
password), then run the app as shown below.

---

## Manual setup

```bash
# 1. Clone
git clone <repo-url>
cd <repo>/backend

# 2. Virtual environment
python -m venv .venv
# Windows:        .\.venv\Scripts\Activate.ps1
# macOS/Linux:    source .venv/bin/activate

# 3. Dependencies
python -m pip install --upgrade pip
pip install -r requirements.txt

# 4. Environment file
cp .env.example .env          # Windows: copy .env.example .env
#   …then edit .env (see Configuration below)

# 5. Database (Postgres only — no-op for SQLite)
python scripts/init_db.py
```

---

## Configuration (.env)

`backend/.env` (created from `.env.example`):

```env
# PostgreSQL (recommended). If this connection fails the app falls back to SQLite.
DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/cdrdb
# Or, for the simplest no-Postgres start:
# DATABASE_URL=sqlite:///./cdrdb.sqlite3

APP_NAME=CDR/IPDR Investigation Visualizer

AUTH_SESSION_COOKIE_NAME=gpcssi_session
AUTH_SESSION_TTL_HOURS=168

# Default admin, created on first startup. CHANGE THE PASSWORD (min 8 chars).
AUTH_BOOTSTRAP_USERNAME=admin
AUTH_BOOTSTRAP_PASSWORD=change-this-password
AUTH_BOOTSTRAP_ROLE=admin

# Optional: external ASN/CIDR CSV (network,provider,is_isp) to extend attribution.
# ASN_RANGES_CSV=data/asn_ranges.csv
```

If you don't create a `.env` at all, the app still runs — it defaults to a local SQLite
file (`backend/cdrdb.sqlite3`). Create `.env` to use PostgreSQL or change the admin password.

---

## Database

**PostgreSQL (recommended)**
1. Ensure the server is running and you have a user/password.
2. Put the connection string in `DATABASE_URL`.
3. `python scripts/init_db.py` creates the `cdrdb` database if missing.
4. On first app start, tables and the default admin user are created automatically.

**SQLite (zero-config)** — set `DATABASE_URL=sqlite:///./cdrdb.sqlite3` (or just let the
automatic fallback kick in if Postgres can't connect). A `backend/cdrdb.sqlite3` file is
created on demand.

**Migrating SQLite → PostgreSQL** (if you started on SQLite and want to move):
```bash
python scripts/migrate_sqlite_to_postgres.py \
  --sqlite cdrdb.sqlite3 \
  --pg postgresql://USER:PASSWORD@localhost:5432/cdrdb
```
This creates the database + schema and copies every table (preserving ids).

---

## Running the app

```bash
cd backend
uvicorn app.main:app --reload          # add --port 8000 to be explicit
```

- **Web UI:** <http://127.0.0.1:8000>
- **API docs (Swagger):** <http://127.0.0.1:8000/docs>
- **Login:** `admin` / the password from your `.env`

`.env` is read at **startup** — restart `uvicorn` after changing it.

---

## Usage guide

1. **Sign in** with the admin credentials.
2. **Pick or create a case** from the case selector (top bar). A "Default Case" is created
   automatically the first time. Your selected case is remembered across refreshes.
3. **Upload data** on the Dashboard — drop **CDR**, **IPDR** and (optionally) **Tower** CSVs.
   - Records are attached to the **currently selected case**. Re-uploading the same type
     **replaces** that type for the case (it is not appended).
4. **Explore the tabs:** Dashboard → Network Graph → Tower Map → Timeline → Charts →
   Services → Correlation → **Inferences** → Records → AI Insights.
5. **Inferences** is the analyst's starting point: it ranks Persons of Interest and groups
   leads (identity fraud, covert coordination, evasion) for CDR, and VPN/proxy activity for
   IPDR. Click a subject to open its profile; use the **Tower Map** inference overlays and
   geofence to see leads on the map.

> A case needs **both CDR and IPDR** for full coverage — CDR drives calls/movement/network,
> IPDR drives internet-session attribution and VPN/proxy detection.

---

## Input CSV formats

Headers are matched by name; extra columns are ignored. Timestamps are `YYYY-MM-DD HH:MM:SS`.

**CDR** — required: `a_party_number, b_party_number, start_time, end_time, duration_seconds`.
Recommended: `msisdn, imsi, imei, call_type, direction, tower_id, cell_id, lac, latitude, longitude, technology`.

**IPDR** — required: `start_time, end_time, source_ip, destination_ip`.
Recommended: `msisdn, imsi, imei, source_port, destination_port, protocol, bytes_uploaded, bytes_downloaded, tower_id, cell_id, lac, latitude, longitude, apn, rat`.

**Towers** — required: `tower_id`. Recommended: `latitude, longitude, city, state`.

Need test data? See [Scripts](#scripts) → `generate_sample_data.py`.

---

## Scripts

Run from `backend/` with the venv active:

| Script | Purpose |
|--------|---------|
| `scripts/init_db.py` | Create the Postgres database named in `DATABASE_URL` (no-op for SQLite). |
| `scripts/generate_sample_data.py` | Generate sample CDR/IPDR/Tower CSVs into `sample_data/`. |
| `scripts/migrate_sqlite_to_postgres.py` | Migrate an existing SQLite DB into PostgreSQL. |
| `scripts/fetch_provider_ranges.py` | Refresh provider IP ranges from official feeds (AWS/Google/Cloudflare/Fastly/GitHub) into `data/asn_ranges.csv`. |
| `scripts/gen_attribution_js.py` | Regenerate the frontend attribution data from `app/data/attribution_data.json`. |

---

## Testing

```bash
cd backend
python -m unittest tests.test_inference tests.test_attribution tests.test_provider_ranges tests.test_ai
```

The suites cover the inference engine, the service-attribution metrics harness, the
provider-range fetcher, and the AI dataset utilities.

---

## Troubleshooting

| Symptom | Fix |
|--------|-----|
| **`password authentication failed`** / app silently uses SQLite | The Postgres credentials in `DATABASE_URL` are wrong, so the app fell back to SQLite. Fix the user/password; run `python scripts/init_db.py`; restart. |
| **`database "cdrdb" does not exist`** | Run `python scripts/init_db.py` (creates it). |
| **App won't start — settings error** | `.env` is missing or `DATABASE_URL` isn't set. Copy `.env.example` → `.env`. |
| **Port 8000 already in use** | `uvicorn app.main:app --reload --port 8001`. |
| **Changed `.env` but nothing changed** | `.env` is read at startup — restart `uvicorn`. |
| **AI Insights does nothing** | Ollama isn't running/configured — optional; everything else works without it. |
| **Uploaded a CSV but the case is empty** | Make sure a case is selected before uploading; records attach to the active case. |

---

## Project structure

Key paths only. The optional AI fine-tuning tooling under `backend/`
(`pipeline_tifm_finetune.py`, `train_qwen_tifm.py`, `*.ipynb`) is omitted here for brevity;
its generated model weights/outputs (`llm_models/`, `tifm_lora_output/`, `tifm_merged/`) are
git-ignored.

```
backend/
├── app/
│   ├── main.py                 # FastAPI entry point + static serving
│   ├── api/                    # REST routers: auth, upload, records, geo, graph,
│   │                           #   timeline, stats, investigation, inference, cases,
│   │                           #   annotations, towers, ai
│   ├── core/
│   │   ├── config.py           # Pydantic settings (.env)
│   │   └── database.py         # SQLAlchemy engine + automatic SQLite fallback
│   ├── models/                 # SQLAlchemy models: cdr, ipdr, tower, case, annotation, auth
│   ├── schemas/                # Pydantic schemas: cdr, ipdr, tower, case, annotation, query, upload, auth
│   ├── services/
│   │   ├── service_attribution_service.py  # IP-range + port attribution engine
│   │   ├── inference_service.py            # spatiotemporal inference (CDR vs IPDR)
│   │   ├── geo.py                          # haversine + travel-mode helpers
│   │   ├── investigation_service.py        # unified-timeline builder
│   │   ├── records_service.py  graph_service.py  stats_service.py
│   │   ├── tower_service.py    timeline_service.py  csv_parser.py
│   │   └── auth_service.py     # password hashing + session management
│   ├── utils/validators.py     # CSV column / datetime validation
│   ├── data/attribution_data.json          # shared attribution knowledge base
│   └── ai/                     # optional LLM investigator / dataset tooling
├── static/
│   ├── index.html  app.js  styles.css      # frontend SPA (no build step)
│   └── attribution_data.js                 # generated from app/data/attribution_data.json
├── scripts/
│   ├── init_db.py  generate_sample_data.py  migrate_sqlite_to_postgres.py
│   ├── fetch_provider_ranges.py  gen_attribution_js.py
│   └── extract_attribution_data.js  seed_triangulation.py   # one-off helpers
├── tests/                      # test_inference, test_attribution, test_provider_ranges, test_ai
├── requirements.txt
├── .env.example
├── setup.ps1  setup.sh         # fresh-setup scripts
└── cdrdb.sqlite3               # SQLite DB (only if used; git-ignored)
```

---

## Documentation

- [docs/architecture.md](docs/architecture.md) — system design & data flow
- [docs/api.md](docs/api.md) — endpoint reference (also live at `/docs`)
- [docs/frontend.md](docs/frontend.md) — tab walkthrough & state
- [docs/features.md](docs/features.md) — detailed feature catalogue
- [docs/deployment.md](docs/deployment.md) — production / reverse-proxy
- [docs/development.md](docs/development.md) — contributing & code style
