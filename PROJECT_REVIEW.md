# CDR/IPDR Investigation Visualizer — Project Review

> Full-stack telecom investigation platform for analyzing Call Detail Records (CDRs), IP Data Records (IPDRs), and mobile tower locations. Built for law enforcement and forensic investigators.

---

## 1. Screenshots

### Authentication & Session Management

| Screen | Description |
|---|---|
| `login.png` | Centered auth panel with username/password fields, session-based login via HttpOnly cookie. Auto-logout after 10 min inactivity with 3-stage status indicator (green/yellow/pulsing red). |
| `topbar.png` | Top navigation bar with 10 tabs (Dashboard, Network Graph, Tower Map, Timeline, Charts, Services, Correlation, Records, AI Insights, Admin), case selector dropdown, Export button, dark mode toggle, and session status dot. |

### Dashboard

| Screen | Description |
|---|---|
| `dashboard.png` | Collapsible investigation summary (11-metric grid), date-range comparison bar (Period A vs B), 4 KPI cards (Total Records, Top Contact, Top Service, etc.), mini D3 force-directed graph, service distribution doughnut chart, daily activity bar chart, top contacts bar chart. Activity spike card appears when bursts are detected. Geo-fenced records card appears when a geofence polygon is active. |

### Network Graph

| Screen | Description |
|---|---|
| `graph_full.png` | D3.js force-directed graph with subject filter dropdown, search/highlight input, zoom/pan controls, Reset and Center buttons, node stats sidebar. Nodes sized by connection weight, edges weighted by interaction count. Hover shows node details, click opens subject profile. |

### Tower Map

| Screen | Description |
|---|---|
| `map_path.png` | Leaflet map (centered India) showing movement path polyline connecting towers in chronological order, with circle markers and time playback slider. |
| `map_heat.png` | Activity heatmap overlay with gradient (green → red), tower visit counts in sidebar. |
| `map_zones.png` | Operational zones with radius circles sized by activity, tower markers with popups. |
| `map_colocation.png` | Co-location detection highlighting towers shared by multiple subjects. |
| `map_meetings.png` | Meeting detection — circle markers colored by gap time (red <5min, yellow <15min, green >15min) with confidence labels. |
| `map_triangulation.png` | Triangulation with 30-min time clusters, tech-aware coverage circles (1-15km radius), Turf.js polygon intersections shown as dashed red overlays. |
| `map_geofence.png` | Geofence polygon drawn via Leaflet.draw, with 3-state toggle button (Geofence → Cancel → Clear Fence). |

### Entity Timeline

| Screen | Description |
|---|---|
| `timeline.png` | Entity-grouped collapsible cards with activity density strips (50 time buckets), Gantt-style session bars colored by service type, event lists with service badges. Side-by-side comparison mode shows two entities in a 2-column grid. Hovering a Gantt bar shows a tooltip with full session details. |

### Charts

| Screen | Description |
|---|---|
| `charts.png` | 12 charts in a 3-column grid: Service Usage (doughnut), Hourly Activity (24h bar), Top Contacts (horizontal bar), Service Timeline (multi-line, 14 days), Contact Direction, Contact Duration, Day of Week, Duration Distribution, Protocol Distribution, Top Ports, Data Volume (up/down), Tower Activity. |

### Service Attribution

| Screen | Description |
|---|---|
| `services.png` | Service card grid with search and min-confidence filter. Each card shows: service badge with color, session count, total duration, subjects, contacts, towers. Expandable body with evidence scorecard (6 pass/fail checks + strength %), ranked candidates, recent session list. Activity burst cards above the grid show anomalous days (≥3x avg, min 10 records). |

### Cross-Subject Correlation

| Screen | Description |
|---|---|
| `correlation.png` | Two subject selectors with swap button. Results grid: meeting confidence card (High/Medium/Low with events and gap minutes), overview card (record counts, sessions, contacts), common towers, common contacts (clickable), common services, service comparison grid (colored bar counts), overlapping time windows. |

### Records Table

| Screen | Description |
|---|---|
| `records.png` | 24-column horizontally scrollable table with: Time, Type, Subject, Counterpart, Dur(s), Detail, Dir/APN, Service, SrcPort, DstPort, Port Svc, App Attr, Tower, Cell, LAC, IMSI, IMEI, MSISDN, Tec/RAT, Up(B), Dn(B), Lat, Lng, Case. Star annotations per row, type filter, service filter, live text search, Load More pagination (60 rows per page). Row click opens subject profile. |

### AI Insights

| Screen | Description |
|---|---|
| `ai_config.png` | LLM endpoint/model configuration inputs (default: `http://localhost:11434/api/generate`, model `gemma4:e4b`). |
| `ai_report.png` | Generated investigation report rendered as formatted markdown with headings, tables, lists. Copy Report button. |
| `ai_qa.png` | Investigator notes textarea with Ask/Clear buttons, Q&A response panel, Copy Data Package button. |

### Subject Profile

| Screen | Description |
|---|---|
| `profile.png` | Modal overlay with: 10 summary cards (Contacts, Records, Sessions, Towers, Top Service, Avg/Day, Peak Hour, Pattern, Meetings with confidence, Date Span), clickable top contacts, attributed services list, towers (clickable → map), detected co-locations with confidence badges, 24-hour activity bar chart, recent 10 events. |

### Admin Panel

| Screen | Description |
|---|---|
| `admin.png` | User management table (ID, Username, Role, Active, Created, Last Login, Actions). Create User button opens modal with username/role/password fields. Edit and Reset Password per user. Tab only visible for admin-role users. |

### Dark Mode

| Screen | Description |
|---|---|
| `dark_dashboard.png` | Dashboard in dark theme — dark surface backgrounds (`#1a1c21`), warm text (`#e0ddd8`), muted teal accent. All components (charts, map, graph, tables, tooltips) respond to theme. Persisted via localStorage. |
| `dark_timeline.png` | Entity timeline in dark mode — dark cards, adjusted Gantt bar opacity, dark tooltip backgrounds. |

---

## 2. Architecture

### System Overview

```
+------------------------------------------------------------------+
|                       Browser (Vanilla SPA)                       |
|  index.html  +  styles.css  +  app.js (~2,500 lines)             |
|  Libraries:  D3.js v7  |  Chart.js 4.4.7  |  Leaflet 1.9.4      |
|            Leaflet.draw  |  Leaflet.heat  |  Turf.js v7          |
+-------------------------------+----------------------------------+
                                | HTTP (REST JSON)
                                | Session cookie (HttpOnly)
                                v
+------------------------------------------------------------------+
|                    FastAPI Application (Python)                    |
|  +------------------+  +------------------+  +----------------+  |
|  |   API Layer      |  |   Auth Layer     |  |  Static Files  |  |
|  |  11 routers      |  |  Session check   |  |  /static/*     |  |
|  |  35+ endpoints   |  |  Admin gate      |  |  index.html    |  |
|  +--------+---------+  +--------+---------+  +----------------+  |
|           |                       |                                |
|           v                       v                                |
|  +--------------------------------------------------------------+  |
|  |                   Services Layer                              |  |
|  |  auth_service      |  graph_service       |  stats_service   |  |
|  |  records_service   |  timeline_service    |  tower_service   |  |
|  |  investigation_svc |  service_attribution |  csv_parser      |  |
|  +--------------------------------------------------------------+  |
|           |                                                        |
|           v                                                        |
|  +--------------------------------------------------------------+  |
|  |  SQLAlchemy ORM — 6 Models                                    |  |
|  |  User | AuthSession | CDRRecord | IPDRRecord | Tower | Case  |  |
|  |  Annotation                                                   |  |
|  +--------------------------------------------------------------+  |
|           |                                                        |
|           v                                                        |
|  +--------------------------------------------------------------+  |
|  |  Database (PostgreSQL primary + SQLite fallback)              |  |
|  +--------------------------------------------------------------+  |
+------------------------------------------------------------------+
```

### Backend Layer Architecture

| Layer | Responsibility | Files |
|---|---|---|
| **API Layer** | Route declarations, param extraction, HTTP responses | `backend/app/api/` — 11 router files |
| **Auth Layer** | Session cookie validation, role verification | `auth_service.py:get_current_session()`, `get_current_user()`, `get_current_admin()` |
| **Services Layer** | Business logic, algorithms, data aggregation | 9 service files in `backend/app/services/` |
| **ORM Layer** | Database models with relationships | 6 models in `backend/app/models/` |
| **Schema Layer** | Pydantic request/response validation | 8 schema files in `backend/app/schemas/` |
| **Infrastructure** | Config, DB engine, utilities | `config.py`, `database.py`, `utils/validators.py` |

### Frontend Layer Architecture

| Layer | Responsibility | Implementation |
|---|---|---|
| **DOM Cache** | Element references cached at startup | `D` object — ~40 elements via `document.getElementById()` |
| **State Management** | Global application state | `state` object — auth, data arrays, UI state |
| **Tab System** | Multi-tab SPA navigation | `switchTab()` — show/hide via `.tab-content.active` |
| **API Client** | HTTP requests to backend | `API` object — `get()`, `post()`, `del()`, `upload()` |
| **Render Functions** | Tab content builders | `renderDashboard()`, `renderGraph()`, `renderTimeline()`, etc. |
| **Event Handlers** | User interaction wiring | `addEventListener` on `D.*` elements, named handler pattern |
| **External Libraries** | Visualizations | D3.js, Chart.js, Leaflet, Turf.js |

### Key Data Flows

**Data Ingestion:**
```
CSV file → showUploadPreview() → confirm → POST /upload/{type}
→ Pandas parse → DELETE old records → INSERT new records
→ Response → loadCaseData() → renderDashboard()
```

**Service Attribution:**
```
IPDR records → reconstructSessions(entity) → classifySession(session)
→ Port match (+40) + Protocol match (+20) + Duration (+15-20) + Pattern (+10)
→ Best match capped at 95% → Primary service + evidence + candidates
```

**Meeting Detection:**
```
Two subjects → detectMeetings({subject, rowsA, rowsB, allPairs})
→ Same tower + within 60 min → Dedup by sorted key
→ Confidence: High (≤5 min gap), Medium (≤15 min), Low (≤60 min)
→ Return {subA, subB, tow, time, gap, gapLevel, subAEvent, subBEvent}
```

**AI Report Generation:**
```
Generate Report → buildDataPackage() (20-line text summary)
→ buildCsvDump() (up to 500 CDR + 500 IPDR pipe-delimited rows)
→ POST to local Ollama API (128K context, gemma4:e4b, temp=0.2)
→ Stream response → renderMd() → innerHTML
```

### Authentication Architecture

```
Login → POST /auth/login → Validate password (PBKDF2-SHA256, 210K iters)
→ Generate 48-byte random token → Store SHA-256 hash in DB
→ Set HttpOnly cookie → Frontend: 10-min AFK timer + 5-min health ping
→ Each request: cookie → get_current_session() → sliding window TTL
→ Admin routes: + get_current_admin() role check
```

---

## 3. Workflow Analysis

### Primary Investigation Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                    ENTRY — Login                                 │
│  10-min AFK timer starts. Session cookie set.                   │
│  Auto-creates "Default Case" if none exist.                     │
└──────────────────────────┬───────────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                    UPLOAD DATA (Dashboard Tab)                   │
│  1. Upload CDR CSV (call records)                                │
│  2. Upload IPDR CSV (IP data sessions)                           │
│  3. Upload Tower CSV (tower registry)                            │
│  Preview first 20 rows before confirming each upload.            │
│  Replace-on-upload strategy (old data cleared, new inserted).    │
└──────────────────────────┬───────────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                    OVERVIEW (Dashboard Tab)                      │
│  Case Summary: Subjects, records, meetings, activity spikes      │
│  KPI Cards: Total, Top Contact, Top Service, Active Tower        │
│  Mini Graph: Entity relationship snapshot                        │
│  Charts: Service distribution, daily activity, top contacts      │
│  Compare Periods: Before/after analysis with delta cards         │
└──────────────────────────┬───────────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│           INVESTIGATION PHASE — Multiple Paths                   │
│                                                                  │
│  ┌─────────────────┐   ┌──────────────────┐   ┌───────────────┐ │
│  │ Who contacted   │   │ Where did they   │   │ When were     │ │
│  │ whom?           │   │ go?              │   │ they active?  │ │
│  │                 │   │                  │   │               │ │
│  │ Network Graph   │   │ Tower Map (6     │   │ Entity        │ │
│  │ (Graph Tab)     │   │ modes) (Map Tab) │   │ Timeline      │ │
│  │                 │   │                  │   │ (Timeline Tab)│ │
│  └────────┬────────┘   └────────┬─────────┘   └───────┬───────┘ │
│           ▼                     ▼                      ▼         │
│  ┌─────────────────┐   ┌──────────────────┐   ┌───────────────┐ │
│  │ Centrality      │   │ Path/Heat/Zones/ │   │ Session bars  │ │
│  │ Communities     │   │ Colocation/      │   │ Activity      │ │
│  │ Bridges         │   │ Meetings/        │   │ density       │ │
│  │ Search/highlight│   │ Triangulation    │   │ Gantt tooltip │ │
│  └─────────────────┘   └──────────────────┘   └───────────────┘ │
└──────────────────────────┬───────────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│              DEEP ANALYSIS — Specialized Tabs                   │
│                                                                  │
│  ┌───────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ Service       │  │ Cross-       │  │ Records      │          │
│  │ Attribution   │  │ Subject      │  │ Table        │          │
│  │ (Services     │  │ Correlation  │  │ (Records     │          │
│  │  Tab)         │  │ (Correlation │  │  Tab)        │          │
│  │               │  │  Tab)        │  │              │          │
│  │ Evidence      │  │ Meeting      │  │ 24 columns   │          │
│  │ scorecards    │  │ confidence   │  │ Annotations  │          │
│  │ Burst alerts  │  │ Shared towers│  │ Search/filter│          │
│  │ Candidates    │  │ Service comp │  │ Load more    │          │
│  └───────────────┘  └──────────────┘  └──────────────┘          │
└──────────────────────────┬───────────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│              REPORT & CLOSURE                                    │
│                                                                  │
│  1. Charts Tab — Exportable visual evidence                      │
│  2. Export Button — Full .txt investigation report               │
│     (Summary → Subject Profiles → Sessions → Records → Towers)   │
│  3. AI Insights Tab — Auto-generated LLM report                  │
│     (Data package + raw CSV dump → Ollama → markdown report)    │
│     Follow-up Q&A with investigator notes                        │
└──────────────────────────────────────────────────────────────────┘
```

### Typical User Journey

1. **Login** — Admin credentials, session-based auth, AFK timer starts.

2. **Import** — Upload CDR and IPDR CSV files through the Dashboard import panel. Preview first 20 rows. Data replaces previous case data (unless a specific case is selected).

3. **First Look** — Dashboard shows case summary (subjects, records, meetings, bursts), KPI cards, mini network graph, and charts. This tells you: scale of the data, who's most active, what services are used.

4. **Follow the Network** — Switch to the Network Graph tab. Search for a specific subject. See who they connect to. Click a node to open their profile.

5. **Geo-Spatial Analysis** — Switch to the Tower Map. Movement Path mode shows where the subject traveled. Triangulation mode narrows down locations from tower handoffs. Meeting Detection identifies potential in-person meetings. Draw a geofence to filter records spatially.

6. **Timeline Reconstruction** — Switch to the Timeline tab. Expand entity cards to see reconstructed sessions as Gantt bars. Hover for session details (service, confidence, duration). Compare two entities side-by-side.

7. **Service Attribution** — Switch to Services tab. Each service card shows evidence scorecard (6 checks), ranked candidates, burst detection alerts. Filter by minimum confidence.

8. **Cross-Subject Correlation** — Switch to Correlation tab. Select two subjects. The system shows: meeting confidence with timestamps and gaps, common towers, common contacts, service comparison, overlapping time windows.

9. **Evidence Collection** — Switch to Records tab. Star important records. Search and filter. Click rows to open subject profiles. Export the full report.

10. **Report Generation** — Click Export for a .txt report, or use the AI Insights tab for a local LLM-generated investigation report with follow-up Q&A.

### Meeting Confidence Workflow

The system's meeting detection engine answers the investigator's core question: **Did they meet?**

```
Select Subject A + Subject B (Correlation Tab)
           │
           ▼
    detectMeetings({rowsA, rowsB})
           │
           ├── Same tower check
           ├── Same time window (≤60 min)
           ├── Deduplication
           └── Gap computation
           │
           ▼
    Meeting Result:

    High Confidence    Medium Confidence     Low Confidence
    ───────────────    ─────────────────     ──────────────
    Gap: ≤5 min        Gap: 6-15 min         Gap: 16-60 min
    Same tower         Same tower            Same tower
    Direct overlap     Near overlap          Same hour
    ───────────────    ─────────────────     ──────────────
    "They were in     "They were likely      "Possible meeting,
     the same place     in the same area      lower confidence"
     at nearly the      within minutes"
     same time"
```

---

## 4. Feature Inventory

### 4.1 Authentication & Security — 14 Features

| # | Feature | Tech |
|---|---|---|
| 1 | Session-based login with HttpOnly cookies | FastAPI, `secrets.token_urlsafe(48)` |
| 2 | PBKDF2-SHA256 password hashing (210K iterations, 16-byte salt) | `hashlib.pbkdf2_hmac` |
| 3 | Sliding window session expiry (extended on each request) | `last_seen_at` / `expires_at` |
| 4 | Multi-session tracking with per-session revocation | `AuthSession` model, soft-delete |
| 5 | Password change endpoint | `verify_password()` + `hash_password()` |
| 6 | Default admin bootstrapping from env vars | Startup event, `bootstrap_default_user()` |
| 7 | AFK auto-logout (3-stage: Active/Idle/Expiring) | `setTimeout` chain, 10-min total |
| 8 | Health check ping every 5 minutes | `setInterval`, `GET /auth/me` |
| 9 | Session status indicator (green/yellow/pulsing red) | CSS classes with `@keyframes pulse` |
| 10 | Data persistence across sessions | Removed auto-reset on login |
| 11 | Reset Case button with confirmation | `confirm()` dialog, `DELETE /records/reset` |
| 12 | Auto-create Default Case | `loadCases()` when `cases.length === 0` |
| 13 | Client IP & User-Agent capture | `request.headers`, `request.client.host` |
| 14 | Admin role gate for user management | `get_current_admin()` FastAPI dependency |

### 4.2 Data Ingestion — 10 Features

| # | Feature | Tech |
|---|---|---|
| 1 | CDR CSV upload (replace-on-upload) | `POST /upload/cdr`, Pandas |
| 2 | IPDR CSV upload (replace-on-upload) | `POST /upload/ipdr`, Pandas |
| 3 | Tower CSV upload (merge/upsert) | `POST /upload/towers`, `db.merge()` |
| 4 | Column validation with error messages | `ensure_columns()` validator |
| 5 | Sample data generator (60 towers, 1200 CDR, 1800 IPDR) | `generate_sample_data.py` |
| 6 | Triangulation seed data (4 towers, 21 IPDR records) | `seed_triangulation.py` |
| 7 | Upload data preview (first 20 rows + confirm/cancel) | Client-side CSV parse, `file.slice(0, 512KB)` |
| 8 | Case-aware upload with `case_id` binding | Form field on upload endpoints |
| 9 | Replace-on-upload strategy | Transaction: DELETE → INSERT |
| 10 | Pandas CSV parser with flexible columns | `csv_parser.py` wrapper |

### 4.3 Dashboard — 10 Features

| # | Feature | Tech |
|---|---|---|
| 1 | Collapsible Case Investigation Summary (11 metrics) | `renderCaseSummary()`, `.cs-grid` |
| 2 | Meeting confidence breakdown (High/Med/Low counts) | `detectMeetings({allPairs: true})` |
| 3 | KPI summary cards (Total, Top Contact, Top Service, Tower, Contacts, Subjects) | Vanilla DOM, client-side aggregation |
| 4 | Mini D3 force-directed graph (200 sampled records) | D3.js v7, `forceSimulation` |
| 5 | Geofence record count card | Turf.js `booleanPointInPolygon()` |
| 6 | Service distribution doughnut chart | Chart.js, top 8 services |
| 7 | Daily activity bar chart (Sun-Sat, intensity-colored) | Chart.js, dynamic `backgroundColor` |
| 8 | Top contacts horizontal bar chart (clickable → profile) | Chart.js, `onClick` callback |
| 9 | Error-isolated sub-renders (try/catch per component) | Isolated `try/catch` blocks |
| 10 | Compare Periods (before/after delta analysis) | Date range pickers, `runComparePeriods()` |

### 4.4 Network Graph — 10 Features

| # | Feature | Tech |
|---|---|---|
| 1 | D3.js force-directed graph | `forceLink`, `forceManyBody`, `forceCenter`, `forceCollide` |
| 2 | Subject filtering dropdown | `rowsFor()` with capped links |
| 3 | Real-time search/highlight with opacity dimming | Named event handler pattern |
| 4 | Zoom & pan (0.2x to 8x) | `d3.zoom()`, `.scaleExtent()` |
| 5 | Node dragging with simulation reheat | `d3.drag()`, `alphaTarget()` |
| 6 | Node details sidebar (ID, weight, connections) | `onmouseover`/`onclick` |
| 7 | Node labels (truncated to 12 chars) | D3 `text` elements |
| 8 | Graph stats (N nodes, M links) | `D.graphStats.textContent` |
| 9 | Link deduplication (merged weighted edges) | Sorted-key Map |
| 10 | NetworkX backend metrics (centrality, communities, bridges) | `nx.degree_centrality()`, `nx.betweenness_centrality()`, `greedy_modularity_communities()`, `nx.bridges()` |

### 4.5 Tower Map — 20 Features

| # | Feature | Tech |
|---|---|---|
| 1 | Leaflet map with OpenStreetMap tiles | Leaflet 1.9.4 |
| 2 | Movement Path mode (polyline + markers + distance) | `L.polyline`, `L.circleMarker` |
| 3 | Activity Heatmap mode (gradient overlay) | Leaflet.heat, `L.heatLayer()` |
| 4 | Operational Zones mode (radius circles by activity) | `L.circle()`, dynamic sizing |
| 5 | Co-location mode (shared tower highlights) | Subject-tower aggregation |
| 6 | Meeting Detection mode (gap-colored markers) | Double-loop, gap-based coloring |
| 7 | Triangulation mode (time clusters + Turf.js intersections) | `L.circle()`, tech-aware radii, `turf.intersect()` |
| 8 | Geofencing with Leaflet.draw polygon | `L.Draw.Polygon`, 3-state toggle |
| 9 | Contextual sidebar per mode | `D.mapAnalysis.innerHTML` |
| 10 | Fit All / Fit Bounds buttons | `mapInstance.fitBounds()` |
| 11 | Subject filter dropdown | `geoSub()` filter |
| 12 | Marker popups with full record details | `bindPopup(popupHtml(r))` |
| 13 | Time playback slider with Play button | `<input type="range">`, `setTimeout` |
| 14 | Distance calculation in Path mode | `mapInstance.distance()` |
| 15 | Geo-fenced record count (live update) | Turf.js `booleanPointInPolygon()` |
| 16 | Persist geofence across mode switches | `geoFenceLayer` saved separately |
| 17 | Tech-aware triangulation radii (5G=1km, 4G=3km, 3G=5km, 2G=15km) | `covRadius()` lookup |
| 18 | Tower usage density coloring (green→red scale) | 10-color gradient |
| 19 | 30-min sliding window for tower clustering | Consecutive time comparison |
| 20 | Overlap polygons via Turf.js intersection | `turf.polygon()`, `turf.intersect()` |

### 4.6 Entity Timeline — 13 Features

| # | Feature | Tech |
|---|---|---|
| 1 | Entity-grouped collapsible cards | Entity map, `toggleEntity()` |
| 2 | Collapsible toggle on heading/arrow only | `el.closest('.tl-entity')` |
| 3 | Activity density strip (50 time buckets) | 50-section `<div>` with inline heights |
| 4 | Gantt-style session bars (positioned, colored) | Absolute `margin-left` + `width` percentage |
| 5 | Service color map (16 service families) | `SVC_COLORS` object |
| 6 | Gantt tooltip with smart viewport positioning | `getBoundingClientRect()` edge detection |
| 7 | Event list (50 most recent per entity, newest first) | `.tl-ev` CSS, `slice(-50).reverse()` |
| 8 | Search filter by entity name | `.filter(e => e.entity.toLowerCase().includes(q))` |
| 9 | Type filter (All/CDR/IPDR) | `<select>` with `change` event |
| 10 | Side-by-side entity comparison | 2-column grid, independent renders |
| 11 | Session count display per entity | `reconstructSessions(e.entity).length` |
| 12 | Service badge in tooltip (colored) | `svcColor()` + `background:` inline |
| 13 | Evidence text in tooltip | `s.evidence.join(', ')` |

### 4.7 Charts — 12 Features

| # | Feature | Tech |
|---|---|---|
| 1 | Service Usage doughnut chart (top 10) | Chart.js, `type: 'doughnut'` |
| 2 | Hourly Activity bar chart (24h, intensity-colored) | Chart.js, dynamic colors |
| 3 | Top Contacts horizontal bar chart (top 10) | Chart.js, `indexAxis: 'y'` |
| 4 | Service Timeline multi-line chart (14 days, 6 services) | Chart.js, `type: 'line'`, `tension: 0.3` |
| 5 | Contact Direction chart (MO/MT ratio) | Chart.js |
| 6 | Contact Duration chart (average duration per contact) | Chart.js |
| 7 | Day of Week chart (Sun-Sat activity) | Chart.js |
| 8 | Duration Distribution histogram | Chart.js |
| 9 | Protocol Distribution chart | Chart.js |
| 10 | Top Ports chart | Chart.js |
| 11 | Data Volume chart (upload/download per service) | Chart.js |
| 12 | Tower Activity chart (top towers by count) | Chart.js |

### 4.8 Records Table — 10 Features

| # | Feature | Tech |
|---|---|---|
| 1 | 24-column horizontally scrollable data table | Auto-layout `<table>`, `overflow-x: auto` |
| 2 | Dynamic column widths (IPv6=280px, IPv4=150px, etc.) | `colWidth(v)` helper |
| 3 | Record annotations (star/flag toggle) | `POST/DELETE /annotations` |
| 4 | Record type filter (All/CDR/IPDR) | `<select>` filter |
| 5 | Service filter (dynamically populated) | `new Set(allRows.map(r => r.svc))` |
| 6 | Live text search across 7 fields | `.includes()` on concatenated string |
| 7 | Infinite scroll pagination (60 records per page) | `recPage` counter, Load More button |
| 8 | Row click → subject profile | `<tr onclick="showProfile(...)">` |
| 9 | Port Service lookup (40+ ports) | `PORT_SVC` map |
| 10 | App Attr column (service signatures) | `recordSvcAttr()` |

### 4.9 Subject Profile — 8 Features

| # | Feature | Tech |
|---|---|---|
| 1 | Modal overlay (click-outside to close) | `.modal-overlay`, background click |
| 2 | 10 summary cards (Contacts, Records, Sessions, Towers, Top Service, Avg/Day, Peak Hour, Pattern, Meetings, Date Span) | `.prof-grid` |
| 3 | Clickable top contacts (recursive profile navigation) | `showProfile()` onclick |
| 4 | Attributed services list with color badges | Top 5 from session reconstruction |
| 5 | Clickable towers (switch to map tab) | `switchTab('map')` |
| 6 | Meeting confidence badges (High/Med/Low) | `detectMeetings({subject})` |
| 7 | 24-hour activity bar chart (intensity-colored) | Inline `div` bars |
| 8 | Recent 10 events list (clickable → map) | `mapInstance.setView()` |

### 4.10 AI Insights — 9 Features

| # | Feature | Tech |
|---|---|---|
| 1 | LLM endpoint/model configuration (default Ollama) | `<input>` fields, save button |
| 2 | Automated investigation report generation | `generateAiReport()`, Ollama API |
| 3 | Data package builder (compact ~20-line summary) | `buildDataPackage()` |
| 4 | Raw CSV dump builder (500 CDR + 500 IPDR, pipe-delimited) | `buildCsvDump()` |
| 5 | Investigator notes & follow-up Q&A | `analyzeWithAI()` with context |
| 6 | Markdown-to-HTML renderer (headings, tables, lists, code) | `renderMd()` regex pipeline |
| 7 | Copy Report / Copy Data Package to clipboard | `navigator.clipboard.writeText()` |
| 8 | Clear conversation | `clearAiConversation()` |
| 9 | LLM context config (128K context, 0.2 temp, num_predict) | Ollama `options` block |

### 4.11 Session Reconstruction & Service Classification — 7 Features

| # | Feature | Tech |
|---|---|---|
| 1 | Client-side session reconstruction (5-min gap threshold) | `reconstructSessions()` |
| 2 | 26 service signatures across 16 families | `SERVICE_SIGS` constant |
| 3 | Scoring engine: port (+40), protocol (+20), duration (+15-20), pattern (+10) | `classifySession()` |
| 4 | Best match capped at 95% confidence | `Math.min(score, 95)` |
| 5 | Service color map (16 colors) | `SVC_COLORS` |
| 6 | Backend port-to-service attribution (53+ ports) | `service_attribution_service.py` |
| 7 | Frontend port service lookup (40+ ports) | `PORT_SVC` |

### 4.12 Meeting Confidence Engine — 5 Features

| # | Feature | Tech |
|---|---|---|
| 1 | Unified `detectMeetings()` with 3 modes (allPairs, subject, rowsA/B) | Consolidated from 3 scattered implementations |
| 2 | Gap-based confidence levels (≤5 min High, ≤15 min Medium, ≤60 min Low) | `MEET_THRESHOLDS` constants |
| 3 | Deduplication via sorted unique key | `[a,b,tower,minTime].sort().join('|')` |
| 4 | Performance cap (top 30 most active subjects) | Subject ranking by record count |
| 5 | Integrated into: Investigation Summary, Subject Profile, Correlation tab, Export | 7 call sites across app.js |

### 4.13 Service Attribution Tab — 6 Features

| # | Feature | Tech |
|---|---|---|
| 1 | Per-service cards with color-coded badge | `svcColor()` |
| 2 | Session stats (count, total duration, avg confidence) | Client-side aggregation |
| 3 | Subjects, contacts, towers per service | Set-based collections |
| 4 | Evidence scorecard (6 pass/fail checks + strength %) | IP match, port match, indicators, session pattern, multiple subjects, alternatives |
| 5 | Ranked candidates with counts | Top candidates from session classification |
| 6 | Search + minimum confidence filter | `<input>` + `<select>` |

### 4.14 Cross-Subject Correlation — 7 Features

| # | Feature | Tech |
|---|---|---|
| 1 | Two subject selectors with swap button | `corrSubA`, `corrSubB` |
| 2 | Meeting confidence card (High/Medium/Low with events) | `detectMeetings()` |
| 3 | Correlation overview (record/session/contact counts) | `rowsA.length` + `rowsB.length` |
| 4 | Common towers list | Set intersection |
| 5 | Common contacts (clickable) | Set intersection → `showProfile()` |
| 6 | Service comparison grid with colored bar counts | Side-by-side svcCounts |
| 7 | Overlapping time windows (within 1 hour) | Times array comparison |

### 4.15 Backend Services — 9 Features

| # | Feature | Tech |
|---|---|---|
| 1 | Dynamic record querying with 10+ filters | SQLAlchemy `query.filter()`, `or_()`, `.ilike()` |
| 2 | NetworkX graph construction (weighted edges) | `nx.Graph()`, edge Counter |
| 3 | Graph metrics (centrality, communities, bridges) | NetworkX algorithms |
| 4 | Unified investigation timeline | Multi-model merge |
| 5 | Tower activity counting | Counter + Set |
| 6 | Colocation candidate detection | Subject-per-tower aggregation |
| 7 | CDR/IPDR aggregate statistics | `Counter`, `db.query().count()` |
| 8 | Database fallback (PostgreSQL → SQLite) | `try/except` in `database.py` |
| 9 | Automatic table creation on startup | `Base.metadata.create_all()` |

### 4.16 API Endpoints — 35+ Routes

| Router | Endpoints | Auth |
|---|---|---|
| Auth | 7 (login, me, logout, sessions CRUD, password) | Public (login), Session (others) |
| Admin | 5 (user CRUD + password reset) | Admin |
| Upload | 3 (CDR, IPDR, towers) | Session |
| Records | 3 (CDR list, IPDR list, reset) | Session |
| Geo | 3 (records, subjects, towers) | Session |
| Investigation | 4 (timeline, services, towers, colocation) | Session |
| Graph | 2 (graph, metrics) | Session |
| Timeline | 1 (timeline) | Session |
| Stats | 3 (top contacts, CDR stats, IPDR stats) | Session |
| Annotations | 3 (list, create, delete) | Session |
| Cases | 4 (CRUD with record counts) | Session |
| Infrastructure | 2 (health, favicon) | None |

### 4.17 Infrastructure — 6 Features

| # | Feature | Tech |
|---|---|---|
| 1 | Environment-based configuration (.env) | `pydantic-settings`, `@lru_cache` |
| 2 | Swagger UI (`/docs`) + ReDoc (`/redoc`) | FastAPI built-in |
| 3 | Static file serving via FastAPI | `StaticFiles` mount |
| 4 | SPA entry point (`/` serves `index.html`) | `FileResponse` |
| 5 | Health check endpoint | `GET /health → {"status": "ok"}` |
| 6 | SQLite fallback with auto-detection | `try/except ConnectionError` |

### 4.18 UI/UX — 12 Features

| # | Feature | Tech |
|---|---|---|
| 1 | Tab-based navigation (10 tabs) | `switchTab()`, `.tab-content.active` |
| 2 | Dark mode toggle (persisted to localStorage) | `.dark` CSS class, 28 design tokens |
| 3 | CSS custom properties for theming | `:root { --bg: ... }` |
| 4 | Warm readable color palette | Cream `#f0ebe4`, teal `#2c6f79` |
| 5 | HTML escaping (XSS prevention) | `esc()` function |
| 6 | Date/time formatting utilities (3 variants) | `fmt()`, `fmts()`, `fmtd()` |
| 7 | Byte formatting (B/KB/MB/GB) | `fmtBytes()` |
| 8 | Global DOM element cache (`D` object) | ~40 elements via `$()` |
| 9 | Global state management (`state` object) | Auth, data, UI state |
| 10 | Named event handlers (no listener leaks) | `._handler` property pattern |
| 11 | Gantt tooltip auto-width (`max-content`) | CSS `white-space: nowrap` |
| 12 | Responsive flexbox layout with fixed heights | `calc(100vh - 84px)`, `overflow: auto` |

---

## Summary Statistics

| Metric | Value |
|---|---|
| Backend lines of code | ~1,200 (Python) |
| Frontend lines of code | ~2,500 (JS) + ~330 (CSS) + ~300 (HTML) |
| API endpoints | 35+ (11 routers) |
| Database models | 6 (User, AuthSession, CDRRecord, IPDRRecord, Tower, Case, Annotation) |
| Frontend tabs | 10 (Dashboard, Graph, Map, Timeline, Charts, Services, Correlation, Records, AI, Admin) |
| Map modes | 6 (Path, Heat, Zones, Colocation, Meetings, Triangulation) |
| Charts | 12 (in 3-column grid) |
| Table columns | 24 (all CDR/IPDR fields) |
| Service signatures | 26 (16 families) |
| External libraries | 6 (D3.js, Chart.js, Leaflet, Leaflet.draw, Leaflet.heat, Turf.js) |
| Meeting confidence levels | 3 (High ≤5min, Medium ≤15min, Low ≤60min) |
| AI model | Local Ollama, default `gemma4:e4b` (128K context) |
| Password hashing | PBKDF2-SHA256, 210,000 iterations |
| Session timeout | 10 min AFK (3-stage indicator) |
| Data volume | 500 CDR + 500 IPDR records sent to AI (capped for context) |
| Export format | Plain text `.txt` with 6 sections |
