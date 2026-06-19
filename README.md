# CDR/IPDR Investigation Visualizer

A full-stack telecom investigation platform for analyzing Call Detail Records (CDRs), IP Data Records (IPDRs), and mobile tower locations. Built for law enforcement and forensic investigators to visualize communication patterns, reconstruct sessions, map geo-spatial activity, and generate AI-powered investigation reports.

## Features

- **Dashboard** — Summary KPIs, service distribution, hourly activity, top contacts, mini network graph
- **Network Graph** — D3.js force-directed graph showing entity relationships with centrality metrics and community detection
- **Tower Map** — Leaflet-based geo-spatial visualization with 5 modes: movement paths, heatmap, operational zones, co-location detection, meeting points
- **Entity Timeline** — Session-reconstructed timeline with collapsible entity cards, Gantt-style session bars, density strips, and service-colored activity indicators
- **Charts** — Service usage pie, hourly activity bar, top contacts, service timeline
- **Records Table** — Full 24-column searchable table with type/service filters and infinite scroll pagination
- **AI Insights** — Local LLM (Ollama) generated investigation reports from collected data, plus follow-up Q&A with investigator notes
- **Session Management** — PBKDF2-authenticated sessions with AFK auto-logout, health checks, and multi-session tracking

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python 3.8+, FastAPI, SQLAlchemy, Pandas, NetworkX |
| Database | PostgreSQL (primary) with SQLite fallback |
| Frontend | Vanilla JavaScript SPA, HTML5, CSS3 (custom properties) |
| Visualizations | D3.js v7 (force graph), Chart.js 4.4.7 (charts), Leaflet 1.9.4 (maps) |
| AI | Local Ollama API (default: Gemma 4 E4B, 128K context) |
| Auth | Session-based with PBKDF2-SHA256 password hashing |

## Getting Started

### Prerequisites

- Python 3.8+
- PostgreSQL (optional — SQLite fallback works out of the box)
- [Ollama](https://ollama.ai/) (optional — for AI Insights tab)

### Installation

```bash
# Clone the repository
git clone <repo-url>
cd cdripdr-investigation-visualizer

# Create and activate virtual environment
python -m venv backend/.venv
# Windows:
.\backend\.venv\Scripts\Activate.ps1
# macOS/Linux:
source backend/.venv/bin/activate

# Install dependencies
pip install -r backend/requirements.txt
```

### Configuration

Copy `backend/.env` and adjust as needed:

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/cdrdb
AUTH_SESSION_COOKIE_NAME=gpcssi_session
AUTH_SESSION_TTL_HOURS=168
AUTH_BOOTSTRAP_USERNAME=admin
AUTH_BOOTSTRAP_PASSWORD=admin12345
AUTH_BOOTSTRAP_ROLE=admin
```

If PostgreSQL is unavailable, the app automatically falls back to SQLite (`backend/cdrdb.sqlite3`).

### Running

```bash
cd backend
uvicorn app.main:app --reload
```

- **Web UI:** http://127.0.0.1:8000
- **API Docs:** http://127.0.0.1:8000/docs
- **Default Login:** `admin` / `admin12345`

### Generating Sample Data

```bash
cd backend
python scripts/generate_sample_data.py
```

Generates 60 towers, 1200 CDR records, and 1800 IPDR records in `backend/sample_data/`.

## Project Structure

```
backend/
├── app/
│   ├── main.py                  # FastAPI entry point, static serving
│   ├── api/                     # REST API route handlers
│   │   ├── auth.py              # Authentication endpoints
│   │   ├── geo.py               # Geo-spatial endpoints
│   │   ├── graph.py             # Network graph endpoints
│   │   ├── investigation.py     # Unified timeline & services
│   │   ├── records.py           # CDR/IPDR record queries
│   │   ├── stats.py             # Statistics endpoints
│   │   ├── timeline.py          # Timeline events
│   │   ├── towers.py            # Tower management
│   │   └── upload.py            # CSV data upload
│   ├── core/
│   │   ├── config.py            # Pydantic Settings (env vars)
│   │   └── database.py          # SQLAlchemy engine & session
│   ├── models/                  # SQLAlchemy ORM models
│   │   ├── auth.py              # User & AuthSession
│   │   ├── cdr.py               # CDRRecord
│   │   ├── ipdr.py              # IPDRRecord
│   │   └── tower.py             # Tower
│   ├── schemas/                 # Pydantic request/response schemas
│   │   ├── auth.py, cdr.py, ipdr.py, query.py, tower.py, upload.py
│   ├── services/                # Business logic layer
│   │   ├── auth_service.py      # Password hashing, session management
│   │   ├── csv_parser.py        # CSV loading utility
│   │   ├── graph_service.py     # NetworkX graph building & metrics
│   │   ├── investigation_service.py # Unified timeline builder
│   │   ├── records_service.py   # Record filtering & pagination
│   │   ├── service_attribution_service.py # Port-to-service classification
│   │   ├── stats_service.py     # CDR & IPDR aggregations
│   │   ├── timeline_service.py  # Timeline event construction
│   │   └── tower_service.py     # Tower activity & colocation
│   ├── utils/
│   │   └── validators.py        # Column validation & datetime parsing
│   └── scripts/
│       └── generate_sample_data.py  # Mock data generator
├── sample_data/                 # Generated sample CSV files
├── static/                      # Frontend SPA
│   ├── index.html               # Main application HTML
│   ├── styles.css               # Application stylesheet
│   └── app.js                   # Core JavaScript (~930 lines)
├── .env                         # Environment configuration
├── requirements.txt             # Python dependencies
└── cdrdb.sqlite3                # SQLite fallback database
```

## API Overview

All endpoints except `/auth/login`, `/health`, `/`, and `/static/*` require authentication via HttpOnly session cookie.

| Router | Endpoints | Description |
|--------|-----------|-------------|
| `/auth` | 7 endpoints | Login, logout, session management, password change |
| `/geo` | 3 endpoints | Geo-tagged records, subjects, tower locations |
| `/upload` | 3 endpoints | CDR, IPDR, Tower CSV upload (replace-on-upload for records) |
| `/records` | 3 endpoints | List CDR/IPDR records with filters, reset all data |
| `/towers` | 2 endpoints | List and upload towers |
| `/investigation` | 4 endpoints | Unified timeline, service summary, tower activity, colocation |
| `/graph` | 2 endpoints | Network graph nodes/edges, centrality/community metrics |
| `/timeline` | 1 endpoint | Sorted timeline events |
| `/stats` | 3 endpoints | Top contacts, CDR stats, IPDR stats |

Full API documentation: [docs/api.md](docs/api.md) or visit `/docs` when running.

## Frontend Overview

The SPA has 7 tabs accessible from the top navigation bar:

| Tab | Libraries | Features |
|-----|-----------|----------|
| Dashboard | Chart.js, D3.js | 4 KPI cards, mini network graph, service pie, daily activity, top contacts |
| Network Graph | D3.js v7 | Force-directed graph with search, zoom, subject filter, node details sidebar |
| Tower Map | Leaflet + heat plugin | 5 map modes: Movement Path, Heatmap, Operational Zones, Co-location, Meetings |
| Timeline | Custom JS | Entity-grouped collapsible cards, Gantt session bars, density strips, activity events |
| Charts | Chart.js | Service usage pie, hourly activity, top contacts, service timeline |
| Records | Custom JS | 24-column table, type/service filters, search, infinite scroll |
| AI Insights | Ollama API | LLM config, Generate Report, investigator notes + Ask AI, markdown rendering |

## AI Insights

The AI tab connects to a local Ollama instance to generate investigation reports:

1. **Generate Report** — Sends a compact data summary plus raw CSV records to the LLM
2. **Investigator Notes** — Textarea for entering observations, hunches, or specific questions
3. **Ask AI** — Sends the follow-up query along with the original data package for context-aware answers
4. **Data Package Preview** — Shows the raw data being sent to the LLM

Default model: `gemma4:e4b` (128K context). Configurable endpoint and model name via UI.

## Documentation

- [API Reference](docs/api.md) — All endpoints with request/response examples
- [Architecture](docs/architecture.md) — System design, data flow, component interaction
- [Frontend Guide](docs/frontend.md) — Tab walkthrough, customization, state management
- [Deployment](docs/deployment.md) — Docker, production configuration, reverse proxy
- [Development](docs/development.md) — Contributing guidelines, code style, testing
