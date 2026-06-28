<div align="center">
  <img src="backend/static/logo-readme.png" alt="Project ARGUS" width="320"/>
</div>

<h1 align="center">Project ARGUS</h1>

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
- [AI & the fine-tuned model](#ai--the-fine-tuned-model)
- [Input CSV formats](#input-csv-formats)
- [Scripts](#scripts)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Project structure](#project-structure)
- [Documentation](#documentation)

---

## Features

- **Dashboard** — case hero summary, key metrics (10+ KPI cards), network/service/activity panels.
- **Network Graph** — D3 force-directed contact graph with centrality & community detection, behavioural traffic classification, IP range analysis, 40+ provider DB.
- **Tower Map** — Leaflet map: movement path (with per-leg distance / time / speed / travel-mode hover), **tower-frequency heatmap** (L.circleMarker), operational zones, co-location, meetings, **inference overlays** (impossible travel, convoys, home/work anchors) and an interactive **geofence**.
- **Timeline** — session-reconstructed, entity-grouped timeline.
- **Charts / Services / Correlation / Records** — 12+ chart types, service distribution with evidence scorecards, port-level attribution, cross-subject correlation, and a full searchable record table.
- **Inferences** — automated **spatiotemporal + network analytics**, all on one tab, CDR and IPDR kept strictly separate:
  - **Composite risk scoring** — every CDR phone subject and IPDR IP subject ranked **0–100** with banding (low → critical) and a transparent, hover-able **factor breakdown**; two independent leaderboards that never share a subject.
  - **CDR (phone subjects):** impossible-travel / SIM-clone, SIM-swap & burner handsets, **multi-SIM identity resolution**, convoys & "met but never called" hidden links, **call-graph structure** (brokers, cut-points, one-way ties, relay chains, predicted hidden links), **behavioural shifts** (escalation, dormancy → reactivation, newest first-contacts), scheduled-contact cadence, odd-hours, **movement** (home/work anchors, mobility class, longest dwell) and **shared travel routes**.
  - **IPDR (IP subjects):** VPN / proxy, **data volume & exfiltration**, **beaconing** (automated check-ins), and **rare destinations** — with the destination server and provider.
  - **Watchlist** (flag numbers/IPs → forced to Critical) and one-click **Markdown case-report export**.
- **Service / app attribution** — two-layer engine (provider IP-range match + port classification) with ~240-port PORT_MAP, port-range matching (Teams, Steam, FaceTime, Discord ranges), longest-prefix matching, indexed lookup scaling to ~100k rows, pluggable live provider-range feeds, and GENERIC_SVC frontend fallback for mail/DNS/infrastructure ports.
- **AI Insights** — optional fine-tuned Qwen2.5-3B-Instruct (LoRA) or local Ollama for report generation, Q&A, and single-pass fine-tuned inference.
- **Cases & Auth** — multi-case workspaces; PBKDF2-authenticated sessions with sliding expiry.

## Tech stack

| Layer | Technology |
|-------|-----------|
| Backend | Python 3.10+, FastAPI, SQLAlchemy, Pandas, NetworkX |
| Database | PostgreSQL (primary) — automatic SQLite fallback only if unreachable |
| Frontend | Vanilla-JS SPA served by FastAPI (no build step) |
| Visualisation | D3.js v7, Chart.js 4, Leaflet 1.9 (+ draw), Turf.js |
| Auth | Session cookies, PBKDF2-SHA256 (210k iterations) |
| AI (optional) | Fine-tuned Qwen2.5-3B-Instruct (QLoRA 4-bit) + local Ollama |

---

## Prerequisites

- **Python 3.10 or newer** (developed on 3.14). Check: `python --version`.
- **PostgreSQL 13+** — the primary database. Install and start it before setup
  (the setup script creates the `cdrdb` database for you). SQLite is only an automatic
  fallback/backup if Postgres can't be reached — not the intended way to run.
- **Git** (to clone).
- **Ollama** *(optional)* — only for the AI Insights tab. See <https://ollama.com>.

No Node.js/npm is required — the frontend is plain static files served by the backend.

---

## Quick start (setup script)

With **PostgreSQL installed and running**, from the **`backend/`** directory:

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

The script creates the virtual environment, installs dependencies, **prompts for your
PostgreSQL connection** (host / port / user / password / database), writes it to
`backend/.env`, and **creates the `cdrdb` database**. Then just run the dashboard:

```bash
uvicorn app.main:app --reload     # http://127.0.0.1:8000  (login: admin / admin12345)
```

On first run the tables and the default admin user are created automatically. That's the
whole flow: **clone → run setup → run the dashboard.** (Leaving the password blank during
setup falls back to SQLite — handy for a quick look, but Postgres is the intended database.)

---

## Manual setup

```bash
# 1. Clone
git clone https://github.com/Sid1125/TIFM-CDR-IPDR-Visualizer
cd TIFM-CDR-IPDR-Visualizer/backend

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

The setup script writes this for you; you normally won't edit it by hand.

```env
# PRIMARY database — PostgreSQL.
DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/cdrdb

APP_NAME=Project ARGUS

AUTH_SESSION_COOKIE_NAME=gpcssi_session
AUTH_SESSION_TTL_HOURS=168

# Default admin, created on first startup. CHANGE THE PASSWORD (min 8 chars).
AUTH_BOOTSTRAP_USERNAME=admin
AUTH_BOOTSTRAP_PASSWORD=change-this-password
AUTH_BOOTSTRAP_ROLE=admin

# Optional: external ASN/CIDR CSV (network,provider,is_isp) to extend attribution.
# ASN_RANGES_CSV=data/asn_ranges.csv
```

SQLite is **only a fallback**: if no `.env` exists or Postgres can't be reached, the app
quietly uses a local `backend/cdrdb.sqlite3` so it never hard-crashes — but the intended
database is PostgreSQL.

---

## Database

**PostgreSQL (primary)** — the setup script does steps 2–3 for you:
1. Install & start PostgreSQL; have a user/password ready.
2. Set `DATABASE_URL` in `backend/.env`.
3. `python scripts/init_db.py` creates the `cdrdb` database if missing.
4. On first app start, the tables and default admin user are created automatically.

**SQLite (fallback/backup)** — used automatically when Postgres isn't configured/reachable,
or explicitly via `DATABASE_URL=sqlite:///./cdrdb.sqlite3`. Created on demand at
`backend/cdrdb.sqlite3`.

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
5. **Services tab** shows per-subject service attribution with evidence scorecards, port-level
   breakdowns, alt-service rankings, and inline session lists — all computed by a ~240-port
   PORT_MAP with port-range matching for Teams, Steam, FaceTime, and Discord.
6. **Correlation tab** enables cross-subject comparison of service usage patterns.
7. **Inferences** is the analyst's starting point: it ranks Persons of Interest and groups
   leads (identity fraud, covert coordination, evasion) for CDR, and VPN/proxy activity for
   IPDR. Click a subject to open its profile; use the **Tower Map** inference overlays and
   geofence to see leads on the map.

> A case needs **both CDR and IPDR** for full coverage — CDR drives calls/movement/network,
> IPDR drives internet-session attribution and VPN/proxy detection.

---

## AI & the fine-tuned model

The **AI Insights** tab has two backends:

- **Ollama (default, optional)** — point it at a local [Ollama](https://ollama.com) server.
  No Python extras needed.
- **Fine-tuned TIFM model** — a Qwen2.5-3B-Instruct model with a project-specific **LoRA
  adapter** that ships in this repo (`backend/tifm_lora_output/`). To enable it:

  ```bash
  cd backend
  pip install -r requirements-ai.txt
  ```

  Easiest: just answer **"y"** to the *"Install the fine-tuned-model dependencies?"* prompt in
  `setup.ps1` / `setup.sh` — the setup then installs these deps **and pre-downloads + verifies
  the model loads**, so it's ready before you even start the dashboard.

  Either way, start the app and select **"FINE-TUNED TIFM"** in the AI tab. The base model
  (~6 GB) is fetched from the Hugging Face Hub (during setup if you used the prompt, otherwise
  on first query); the LoRA adapter already ships in the clone — so the model answers.

  **Requires an NVIDIA GPU with CUDA** — the model loads in 4-bit (bitsandbytes). On CPU-only
  machines use the Ollama mode instead. `requirements-ai.txt` pins the exact versions and the
  PyTorch CUDA index; if your CUDA differs, install the matching `torch` from
  [pytorch.org](https://pytorch.org/get-started/locally/) first.

### Training data

The model is fine-tuned on **3,218 examples** spanning **15 question types** (up from 7):

| # | Type | Description |
|---|------|-------------|
| 1 | Subject role analysis | Network centrality → inferred role |
| 2 | Identity / SIM swap analysis | Burner scores, SIM swaps, device changes |
| 3 | Meeting analysis | Tower co-location evidence |
| 4 | Movement patterns | Mobility index, tower coverage |
| 5 | Full investigation report | Multi-section synthesised report |
| 6 | Anomaly analysis | Flags suspicious patterns |
| 7 | Context chips | Subject profile + tower movement |
| 8 | Meeting evidence | Structured evidence report |
| 9 | Schema boundary | Per-subject breakdown not available in attribution |
| 10 | Missing sections | Graceful "no data available" responses |
| 11 | Physical meeting vs app session | Distinguishes co-location from digital comms |
| 12 | Confidence caveats | Explains low/moderate/high confidence levels |
| 13 | Burner score explanation | Score interpretation (threshold > 30) |
| 14 | Multi-section cross-reference | Assembles complete subject profile |
| 15 | Data completeness | Warns about missing CDR/IPDR types |

Training data covers both **CDR (phone number)** and **IPDR (IP address)** identifier formats.
The `attribution` section is aggregate (no per-subject breakdown) — the model is trained to
say "not available" rather than hallucinate.

### Training pipeline

Training artefacts under `backend/`:

| File | Purpose |
|------|---------|
| `app/ai/training_data.py` | Generates the 15-type, 3,218-example dataset |
| `app/ai/tifm_train.jsonl` | Pre-generated training dataset |
| `train_qwen_tifm.py` | Local training script (max_steps=1500, seq_len=1024, bf16) |
| `pipeline_tifm_finetune.py` | Unified pipeline: `--generate-only`, `--train-only`, `--train` |
| `tifm_kaggle_train.ipynb` | Kaggle notebook for 7B training on T4/P100 (16 GB VRAM) |
| `tifm_colab_train.ipynb` | Colab variant (legacy) |
| `app/ai/inference.py` | Single-pass fine-tuned inference (no hybrid fallback) |
| `app/api/ai.py` | `POST /ai/chat` endpoint feeds analytics → fine-tuned model |
| `tifm_lora_output/` | Trained LoRA adapter (~60 MB) |

### Inference

Single-pass: the model receives trimmed analytics (≤2000 chars) + question, generates directly
(max_new_tokens=256, temperature=0.3). No hybrid two-model fallback. The `POST /ai/chat`
endpoint runs multi-agent analytics first, then feeds the structured result to the fine-tuned
model.

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
| `scripts/seed_triangulation.py` | Seed tower triangulation reference data. |
| `scripts/extract_attribution_data.js` | Extract attribution data for frontend (Node.js helper). |
| `train_qwen_tifm.py` | Local QLoRA training of Qwen2.5-3B on the TIFM dataset. |
| `pipeline_tifm_finetune.py` | Unified pipeline: generate training data and/or train the model. |

---

## Testing

```bash
cd backend
python -m unittest tests.test_inference tests.test_attribution tests.test_provider_ranges tests.test_ai
python -m unittest tests.test_ingest tests.test_meetings tests.test_watchlist
python -m unittest tests.test_graph_scale tests.test_records_pagination tests.test_case_isolation
```

The suites cover the inference engine, service-attribution metrics, provider-range fetcher,
AI dataset utilities, CSV ingest pipeline, meeting detection, watchlist enforcement,
graph scalability, pagination, case isolation, and more (25 test files in `tests/`).

---

## Troubleshooting

| Symptom | Fix |
|--------|-----|
| **`password authentication failed`** / app silently uses SQLite | The Postgres credentials in `DATABASE_URL` are wrong, so the app fell back to SQLite. Fix the user/password; run `python scripts/init_db.py`; restart. |
| **`database "cdrdb" does not exist`** | Run `python scripts/init_db.py` (creates it). |
| **App won't start — settings error** | `.env` is missing or `DATABASE_URL` isn't set. Copy `.env.example` → `.env`. |
| **Port 8000 already in use** | `uvicorn app.main:app --reload --port 8001`. |
| **Changed `.env` but nothing changed** | `.env` is read at startup — restart `uvicorn`. |
| **AI Insights does nothing** | Ollama isn't running/configured or no fine-tuned model loaded — optional; everything else works without it. Select "Ollama" or "FINE-TUNED TIFM" in the AI tab dropdown. |
| **Fine-tuned model not loading** | Ensure `requirements-ai.txt` is installed and an NVIDIA GPU with CUDA is available. The base model (~6 GB) downloads from Hugging Face Hub on first load. |
| **Uploaded a CSV but the case is empty** | Make sure a case is selected before uploading; records attach to the active case. |

---

## Project structure

```
backend/
├── app/
│   ├── main.py                 # FastAPI entry point + static serving + startup hooks
│   ├── api/                    # 25 REST routers: auth, upload, records, geo, graph,
│   │                           #   timeline, stats, investigation, inference, cases,
│   │                           #   annotations, towers, ai, analysis, analytics,
│   │                           #   cross-case, audit, reference, tower-dump,
│   │                           #   subscribers, export, watchlist, subject-tags
│   ├── core/
│   │   ├── config.py           # Pydantic settings (.env)
│   │   └── database.py         # SQLAlchemy engine + automatic SQLite fallback
│   ├── models/                 # 15 SQLAlchemy models: cdr, ipdr, tower, case,
│   │                           #   annotation, auth, analytics, audit_log, etc.
│   ├── schemas/                # Pydantic schemas: cdr, ipdr, tower, case, auth, etc.
│   ├── services/               # 23 services:
│   │   ├── service_attribution_service.py  # IP-range + port attribution (~240 ports)
│   │   ├── inference_service.py            # spatiotemporal inference (CDR vs IPDR)
│   │   ├── geo.py                          # haversine + travel-mode helpers
│   │   ├── investigation_service.py        # unified-timeline builder
│   │   ├── analysis_service.py             # case analysis orchestration
│   │   ├── analytics_materialize_service.py # pre-computed analytics caching
│   │   ├── auth_service.py                 # password hashing + session management
│   │   └── (records, graph, stats, tower, timeline, csv_parser, export, etc.)
│   ├── utils/validators.py     # CSV column / datetime validation
│   ├── data/attribution_data.json          # shared attribution knowledge base
│   └── ai/                     # LLM fine-tuning + inference pipeline
│       ├── training_data.py    # 15-type, 3,218-example dataset generator
│       ├── inference.py        # single-pass fine-tuned inference
│       ├── orchestrator.py     # multi-agent analytics orchestration
│       ├── investigator.py     # PoliceInvestigator model
│       ├── knowledge_base.json # structured app knowledge base
│       └── tifm_train.jsonl    # pre-generated training examples
├── static/
│   ├── index.html  app.js  styles.css      # frontend SPA (no build step)
│   ├── attribution_data.js                 # generated port/service mapping
│   └── vendor/  workers/                   # vendor libs + web workers
├── scripts/
│   ├── init_db.py  generate_sample_data.py  migrate_sqlite_to_postgres.py
│   ├── fetch_provider_ranges.py  gen_attribution_js.py
│   └── extract_attribution_data.js  seed_triangulation.py
├── tests/                      # 25 test files (inference, attribution, ingest, etc.)
├── train_qwen_tifm.py          # local QLoRA training script
├── pipeline_tifm_finetune.py   # unified generate+train pipeline
├── tifm_kaggle_train.ipynb     # Kaggle notebook (7B training on T4/P100)
├── tifm_lora_output/           # trained LoRA adapter (~60 MB)
├── llm_models/                 # base model cache (git-ignored)
├── requirements.txt
├── requirements-ai.txt
├── .env.example
├── setup.ps1  setup.sh         # fresh-setup scripts
└── cdrdb.sqlite3               # SQLite DB (only if used; git-ignored)
```

---

## Documentation

- [docs/architecture.md](docs/architecture.md) — system design & data flow
- [docs/api.md](docs/api.md) — endpoint reference (also live at `/docs`)
- [docs/frontend.md](docs/frontend.md) — tab walkthrough & state
- [docs/features.md](docs/features.md) — detailed feature catalogue (21 sections, 829 lines)
- [docs/deployment.md](docs/deployment.md) — production / reverse-proxy
- [docs/development.md](docs/development.md) — contributing & code style
- [docs/PRESENTATION.md](docs/PRESENTATION.md) — project slide deck
- [docs/ATTRIBUTION_EXPANSION.md](docs/ATTRIBUTION_EXPANSION.md) — service attribution design notes
