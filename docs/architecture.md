# Architecture

## System Overview

The CDR/IPDR Investigation Visualizer follows a layered service-oriented architecture with a Python/FastAPI backend and a vanilla JavaScript single-page application (SPA) frontend.

```
+---------------------------------------------------------------+
|                        Browser (SPA)                          |
|  index.html  +  styles.css  +  app.js                         |
|  (D3.js, Chart.js, Leaflet, Ollama API client)                |
+------------------------------+--------------------------------+
                               | HTTP (REST JSON)
                               v
+---------------------------------------------------------------+
|                   FastAPI Application                          |
|  +------------------+  +------------------+  +--------------+ |
|  |   API Layer      |  |   Auth Middleware|  | Static Files | |
|  |  (route handlers)|  |  (session check) |  |  (/static/*) | |
|  +--------+---------+  +------------------+  +--------------+ |
|           |                                                    |
|           v                                                    |
|  +----------------------------------------------------------+ |
|  |                Services Layer                             | |
|  |  auth_service  |  graph_service  |  stats_service        | |
|  |  records_service | timeline_service | tower_service       | |
|  |  investigation_service | service_attribution_service     | |
|  +----------------------------------------------------------+ |
|           |                                                    |
|           v                                                    |
|  +----------------------------------------------------------+ |
|  |  SQLAlchemy ORM (models/cdr.py, ipdr.py, auth.py, ...)   | |
|  +----------------------------------------------------------+ |
|           |                                                    |
|           v                                                    |
|  +----------------------------------------------------------+ |
|  |  Database (PostgreSQL or SQLite fallback)                 | |
|  +----------------------------------------------------------+ |
+---------------------------------------------------------------+
```

## Data Flow

### Data Ingestion Flow

```
CSV File Upload
      |
      v
POST /upload/cdr or /upload/ipdr or /upload/towers
      |
      v
Pandas parses CSV into DataFrame
      |
      v
Old records deleted (CDR/IPDR) or upserted (Towers)
      |
      v
New records inserted into database
      |
      v
Response: { success: true, records_imported: N }
```

### Query Flow

```
User interacts with SPA tab
      |
      v
Frontend calls API endpoint (e.g., GET /records/cdr?limit=100)
      |
      v
API route handler extracts query params
      |
      v
Service layer queries database with filters
      |
      v
SQLAlchemy executes query, returns ORM objects
      |
      v
Pydantic schemas serialize to JSON
      |
      v
Frontend receives response, renders visualization
```

### AI Insights Flow

```
User clicks "Generate Report"
      |
      v
Frontend calls buildDataPackage() — compact text summary of all records
      |
      v
Frontend calls buildCsvDump() — pipe-delimited raw records (up to 500 CDR + 500 IPDR)
      |
      v
HTTP POST to Ollama API (http://localhost:11434/api/generate)
      |
      v
Gemma 4 E4B (128K context) generates investigation report
      |
      v
Frontend renders markdown response via renderMd() -> innerHTML
```

## Component Details

### Backend API Layer

Each API router module in `backend/app/api/` is responsible for:
- Route declaration and HTTP method mapping
- Request parameter extraction and validation
- Calling the appropriate service function
- Returning Pydantic-serialized responses

All authenticated routes use the `get_current_user` FastAPI dependency, which resolves the session cookie to a `User` object. If the cookie is missing, expired, or revoked, the dependency raises HTTP 401.

### Services Layer

Business logic is isolated in `backend/app/services/`:

| Service | Responsibility |
|---------|---------------|
| `auth_service.py` | Password hashing (PBKDF2-SHA256), session token management, user bootstrapping |
| `records_service.py` | CDR and IPDR query building with dynamic filter construction |
| `graph_service.py` | NetworkX graph construction, centrality computation, community detection |
| `stats_service.py` | Aggregate statistics for CDR and IPDR records |
| `timeline_service.py` | Sorted timeline event construction |
| `investigation_service.py` | Unified timeline merging CDR + IPDR + tower data |
| `tower_service.py` | Tower activity counting, colocation candidate detection |
| `service_attribution_service.py` | Port-to-service classification with confidence scores |
| `csv_parser.py` | CSV file parsing via Pandas |

### Database Layer

Two database modes are supported:

**PostgreSQL (primary):**
- Configured via `DATABASE_URL` in `.env`
- Used in production deployments

**SQLite (fallback):**
- Activated if PostgreSQL connection fails
- Uses `backend/cdrdb.sqlite3` with `check_same_thread=False`
- Works out of the box with no configuration

### Frontend SPA

The frontend is a single `index.html` file containing the entire application structure, with `app.js` (~930 lines) handling all logic and `styles.css` (~229 lines) providing styling with CSS custom properties for theming.

**Key design patterns:**
- Module-like organization with section comments (auth, AFK, upload, dashboard, graph, etc.)
- State stored in global variables (`state.cdr`, `state.ipdr`, `allRows`)
- DOM element references cached in a `D` object at startup
- No framework dependencies — vanilla JS event-driven architecture
- Tab-based navigation with `display:none`/`display:block` toggling

## Authentication Architecture

```
Login Request (POST /auth/login)
      |
      v
Validate username + password against stored PBKDF2 hash
      |
      v
Generate random 48-byte session token
      |
      v
Store SHA-256 hash of token in auth_sessions table
      |
      v
Set HttpOnly cookie with raw token (configurable name, default: gpcssi_session)
      |
      v
Subsequent requests:
  Cookie -> get_current_session() -> lookup hash in DB -> check expiry
      |
      v
Session sliding window: each request extends expires_at by TTL
```

**Frontend session management:**
- AFK timer: 60 minutes of inactivity triggers auto-logout
- Health check: pings `/auth/me` every 5 minutes
- Status indicator: green (active), yellow (idle warning), red (expired)

## Security Considerations

- Passwords hashed with PBKDF2-SHA256, 210,000 iterations, random 16-byte salt
- Session tokens are 48-byte cryptographically random strings
- Cookies are HttpOnly (not accessible to JavaScript)
- All data routes require authentication via FastAPI dependency injection
- No user input is executed or evaluated
- AI queries go to localhost Ollama instance (data stays local)
