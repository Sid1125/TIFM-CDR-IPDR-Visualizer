<div align="center">
  <img src="docs/assets/argus-banner.svg" alt="Project ARGUS — Advanced Records & Geospatial Unified Surveillance" width="100%"/>
</div>

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.10+-0d1b2a?style=for-the-badge&logo=python&logoColor=8da0b7" alt="Python"/>
  <img src="https://img.shields.io/badge/FastAPI-1a3050?style=for-the-badge&logo=fastapi&logoColor=8da0b7" alt="FastAPI"/>
  <img src="https://img.shields.io/badge/PostgreSQL-0d1b2a?style=for-the-badge&logo=postgresql&logoColor=8da0b7" alt="PostgreSQL"/>
  <img src="https://img.shields.io/badge/D3.js-1a3050?style=for-the-badge&logo=d3dotjs&logoColor=8da0b7" alt="D3.js"/>
  <img src="https://img.shields.io/badge/Leaflet-0d1b2a?style=for-the-badge&logo=leaflet&logoColor=8da0b7" alt="Leaflet"/>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/tests-271_passing-3f6485?style=flat-square" alt="tests"/>
  <img src="https://img.shields.io/badge/frontend-47_ES_modules-3f6485?style=flat-square" alt="modules"/>
  <img src="https://img.shields.io/badge/build-air--gapped_.exe-3f6485?style=flat-square" alt="build"/>
  <img src="https://img.shields.io/badge/no_build_step-vanilla_JS-6b839e?style=flat-square" alt="vanilla"/>
  <img src="https://img.shields.io/badge/database-Postgres_%2F_SQLite-6b839e?style=flat-square" alt="database"/>
</p>

<p align="center"><b>Air-gapped telecom forensics · Evidence-grade intelligence.</b></p>

<p align="center">
A full-stack platform for analysing <b>Call Detail Records (CDR)</b>, <b>IP Data Records (IPDR)</b>
and <b>cell-tower geolocation</b>. It reconstructs communication and internet sessions, maps
movement, attributes traffic to services and providers, resolves identifiers into people, and
turns raw telecom dumps into <b>evidence that stands up in court</b> — all organised per case,
fully offline.
</p>

> **CDR and IPDR are analysed separately.** A CDR subject is a **phone number**; an IPDR
> subject is an **IP address**. Call and IP networks render as disjoint graph components —
> **no false cross-attribution, ever.**

---

## Table of contents
- [The pipeline](#the-pipeline)
- [Features](#features)
- [Architecture](#architecture)
- [Entity resolution](#entity-resolution)
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

## The pipeline

ARGUS moves from *classifying packets* to *reconstructing what happened*. Every stage adds
meaning to the one before, and every conclusion carries its evidence and its uncertainty.

```mermaid
flowchart LR
  R["📇 CDR / IPDR<br/>rows"] --> S["🧩 Session<br/>reconstruction"]
  S --> E["▶ Activity<br/>events"]
  E --> N["🔗 Entity<br/>resolution"]
  N --> C["📊 Confidence<br/>model"]
  C --> V["⚖ Evidence<br/>explanation"]
  classDef stage fill:#0d1b2a,stroke:#6b839e,stroke-width:2px,color:#f5f7f9;
  class R,S,E,N,C,V stage;
```

> *"Probable WhatsApp voice call · 21:31–21:58 · 9998887777 ↔ WhatsApp (Meta) · 86%"* —
> not ten thousand rows of `UDP 3478`.

---

## Features

<table>
<tr>
<td width="33%" valign="top">

**📊 Dashboard**
Case hero summary, 10+ KPI cards, network / service / activity panels, data-quality score.

</td>
<td width="33%" valign="top">

**🕸 Network Graph**
D3 force layout, PageRank / betweenness / community detection, **group-by-entity** collapse, canvas mode for 10k+ nodes.

</td>
<td width="33%" valign="top">

**🗺 Tower Map**
Leaflet movement path with per-leg speed / travel-mode, tower heatmap, geofence, co-location, impossible-travel & convoy overlays.

</td>
</tr>
<tr>
<td valign="top">

**⏱ Timeline & Story**
Session-reconstructed, entity-grouped timeline; day-by-day **narrative paragraphs** an investigator can read aloud.

</td>
<td valign="top">

**🔗 Entities**
Identifiers → **people**: phones, SIMs, devices, IPs, apps, locations, cases — with a confidence tier and a plain-language *why* on every link.

</td>
<td valign="top">

**🧠 Inferences**
Composite 0–100 risk scoring, SIM-swap / burner / clone detection, beaconing, exfiltration, rare destinations — CDR and IPDR kept strictly apart.

</td>
</tr>
<tr>
<td valign="top">

**🎯 Service attribution**
Two-layer engine (provider IP-range + ~250-port table), QUIC-aware, historical IP ownership, ASN enrichment, behavioural fingerprints.

</td>
<td valign="top">

**⚖ Evidence & Reports**
Findings review lifecycle (system → confirmed / rejected), server-persisted board, selective court-ready report builder.

</td>
<td valign="top">

**🤖 AI Insights** *(optional)*
Fine-tuned Qwen2.5-3B (QLoRA) or local Ollama for report generation and case Q&A — never required, fully offline-capable.

</td>
</tr>
</table>

---

## Architecture

Three layers, built for air-gapped, self-contained deployment — no external service is ever required.

```mermaid
flowchart TB
  subgraph FE["🖥 Frontend · 47 native ES modules, no build step"]
    UI["SPA served by FastAPI StaticFiles"]
    VIZ["D3 · Chart.js · Leaflet · Turf"]
  end
  subgraph API["⚙ Backend · FastAPI + SQLAlchemy"]
    ROUTERS["Case-scoped routers"]
    ENGINES["Attribution · Sessions · Events · Entities · Inference"]
    CACHE["Materialised analytics cache<br/>(event-driven invalidation)"]
  end
  subgraph DATA["🗄 Storage"]
    PG[("PostgreSQL<br/>primary")]
    SQLITE[("SQLite<br/>air-gapped fallback")]
  end
  FE --> API
  API --> DATA
  ENGINES --> CACHE
  classDef fe fill:#1a3050,stroke:#8da0b7,color:#f5f7f9;
  classDef be fill:#0d1b2a,stroke:#6b839e,color:#f5f7f9;
  classDef db fill:#3f6485,stroke:#8da0b7,color:#f5f7f9;
  class UI,VIZ fe; class ROUTERS,ENGINES,CACHE be; class PG,SQLITE db;
```

Ships as a self-contained **`ARGUS.exe`** (PyInstaller + Inno Setup, ~122 MB installer): zero
configuration, runs on bundled SQLite, opens in its own standalone window. Drop a `.env` next
to it to point at PostgreSQL for large-scale deployments.

---

## Entity resolution

Identifiers become **entities** — the probable person (or device cluster / SIM-box) behind them.
Merging is transitive and **court-explainable**: a shared IMEI + new SIM is a swap, a shared SIM
+ new device is a device change — both stay one entity, flagged, with the witnessing record
counts as evidence.

```mermaid
flowchart TD
  P["📱 Phone / MSISDN"] -->|same-record<br/>co-occurrence| U{{"Union-find<br/>+ adaptive fan-out guard"}}
  I["🔑 IMSI / SIM"] --> U
  M["📟 IMEI / device"] --> U
  U -->|tight cluster| EN["🔗 Entity<br/>person · cluster · SIM-box"]
  IP["🌐 IP address"] -.->|attribute only,<br/>never a merge key| EN
  U -->|high fan-out identifier| OBS["👁 Observation only<br/>placeholder / shared value —<br/>kept, not merged through"]
  classDef id fill:#1a3050,stroke:#8da0b7,color:#f5f7f9;
  classDef core fill:#0d1b2a,stroke:#6b839e,color:#f5f7f9;
  classDef out fill:#3f6485,stroke:#8da0b7,color:#f5f7f9;
  class P,I,M,IP id; class U core; class EN,OBS out;
```

> **Over-linking is worse than under-linking.** A single placeholder identifier (blank / `0`
> IMEI) fanning out to hundreds is treated as a non-identifying *observation*, never merged
> through — so it can't fuse strangers into a fake "mastermind." The fan-out cut-off is learned
> from each case's own distribution (Tukey fence), not a fixed constant.

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Backend | Python 3.10+, FastAPI, SQLAlchemy, Pandas, NetworkX |
| Database | PostgreSQL (primary) — automatic SQLite fallback only if unreachable |
| Frontend | Vanilla-JS SPA, **47 native ES modules**, served by FastAPI (no build step) |
| Visualisation | D3.js v7, Chart.js 4, Leaflet 1.9 (+ draw), Turf.js |
| Auth | Session cookies, PBKDF2-SHA256 (210k iterations), sliding expiry |
| Packaging | PyInstaller + Inno Setup → self-contained `ARGUS.exe` |
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
