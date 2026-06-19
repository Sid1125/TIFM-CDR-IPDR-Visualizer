# Frontend Guide

## Overview

The frontend is a single-page application (SPA) built with vanilla JavaScript, HTML5, and CSS3. It renders entirely in the browser and communicates with the FastAPI backend via REST API calls.

**Key files:**
- `backend/static/index.html` — Application structure and UI layout
- `backend/static/app.js` — All application logic (~930 lines)
- `backend/static/styles.css` — Styling with CSS custom properties (~229 lines)

## Tab Walkthrough

### 1. Dashboard

The default landing tab after login. Displays:

- **4 KPI Cards** — Total records, entities, services, towers
- **Mini Network Graph** — D3.js force-directed graph showing entity relationships (capped to reduce clutter)
- **Service Distribution** — Chart.js doughnut chart of service usage
- **Daily Activity** — Chart.js bar chart showing activity over days
- **Top Contacts** — Chart.js bar chart of most frequent contacts

**Data sources:**
- KPI cards: aggregated from loaded `allRows` array
- Mini graph: client-side filtered from `allRows`
- Charts: client-side computed from `allRows`

**State management:**
- Dashboard sub-renders are isolated in try/catch blocks
- Failing components show inline error text without breaking the rest of the dashboard

---

### 2. Network Graph

Full D3.js force-directed graph visualization.

**Features:**
- Force-directed layout with configurable charge and link distance
- Subject search and filter dropdown
- Zoom support (mouse wheel + drag)
- Node hover shows label, click shows details in sidebar
- Edge hover shows relationship weight
- "All subjects" vs single subject filter (capped at 500 links for speed)

**Controls:**
- Search input — filters nodes by label
- Subject dropdown — limits graph to a single entity and its connections
- Scroll/pan — D3 zoom behavior

**Sidebar:**
- Shows selected node details
- Recent activity for the selected entity

**Technical notes:**
- D3 `forceLink()` requires `.id(d => d.id)` accessor — missing this causes "node not found" errors
- Event listeners use named handler pattern (`._handler`) to prevent accumulation on re-render
- Links are deduplicated before rendering

---

### 3. Tower Map

Leaflet-based map with OpenStreetMap tiles and heatmap plugin.

**5 Map Modes:**

| Mode | Description | Data Source |
|------|-------------|-------------|
| Movement Path | Draws lines between towers a subject visited, in chronological order | `/geo/records` |
| Activity Heatmap | Shows concentration of activity using leaflet.heat | `/geo/records` |
| Operational Zones | Tower markers colored by activity density | `/geo/towers` |
| Co-location | Towers where multiple subjects appear simultaneously | `/investigation/colocation` |
| Meetings | Pinpoint meetings between specific subjects at specific times | `/investigation/colocation` |

**Features:**
- Subject filter to view a single entity's movement
- Click on records in the sidebar to fly to that location
- Tower markers show city/state on hover

---

### 4. Timeline

Entity-centric timeline with session reconstruction.

**Features:**
- **Collapsible entity cards** — Each unique entity has a card that can be toggled open/closed
- **Density strips** — Visual indicator of activity density over time (thin colored bar above expanded content)
- **Gantt-style session bars** — Reconstructed sessions shown as horizontal bars colored by service type
- **Event list** — Individual records listed chronologically within each entity card
- **Service color coding** — Each service has a distinct color (16 services defined in `SVC_COLORS`)

**Session reconstruction (`reconstructSessions()`):**
- Groups records by IP pairs
- Merges records with ≤5 minute gaps into sessions
- Classifies each session against static signature database (`SERVICE_SIGS`)
- Assigns confidence scores (client-side heuristic)

**Gantt tooltip:**
- Hover over any session bar shows: service badge with color, activity description, start/end time, duration, confidence percentage, evidence match
- Smart positioning stays within viewport bounds

**Toggle behavior:**
- Click only on the entity heading or arrow — clicking body content does NOT toggle
- Implemented via `el.closest('.tl-entity')` check in `toggleEntity()`

---

### 5. Charts

Standalone chart tab with larger versions of dashboard charts.

**Charts displayed:**
- **Service Usage** — Doughnut/pie chart of services
- **Hourly Activity** — Bar chart showing activity by hour of day
- **Top Contacts** — Horizontal bar chart of most frequent counterparts
- **Service Timeline** — Line chart showing service activity over time

**Data:** All computed client-side from `allRows`.

---

### 6. Records

Full data table with all CDR/IPDR fields.

**24 columns:**
Time, Type, Subject, Counterpart, Dur(s), Detail, Dir/APN, Service, SrcPort, DstPort, Port Svc, App Attr, Tower, Cell, LAC, IMSI, IMEI, MSISDN, Tec/RAT, Up(B), Dn(B), Lat, Lng, Case

**Features:**
- **Filters:** Record type (CDR/IPDR/All), Service dropdown
- **Search:** Searches across subject, counterpart, tower, cell, protocol, IMSI, IMEI
- **Pagination:** "Load More" button loads 60 records at a time
- **Horizontal scroll:** Table container scrolls horizontally for all columns
- **Row click:** Opens subject profile modal

**Data source:** Loaded from `/records/cdr` and `/records/ipdr` on tab activation.

---

### 7. AI Insights

Connects to a local Ollama instance for LLM-powered investigation analysis.

**Layout:**
- **Top section:** Automated Investigation Report — the LLM-generated report (min-height 400px, grows with content)
- **Bottom section (350px):** Investigator Notes & Hunches textarea (left) + AI Response panel (right)

**Generate Report:**
1. Collects LLM endpoint and model name from config inputs
2. Builds `buildDataPackage()` — compact summary: record counts, time period, entities, services, contacts, towers, links, direction, duration, peak hour, night activity %, protocols, sessions
3. Builds `buildCsvDump()` — pipe-delimited CSV: up to 500 most recent CDR + 500 most recent IPDR records (epoch timestamps, service classifications)
4. Sends to Ollama: prompt includes date/time, summary, `=== RAW CDR RECORDS ===`, `=== RAW IPDR RECORDS ===`
5. Renders LLM markdown response via `renderMd()` → `innerHTML`

**Ask AI:**
- Sends investigator's notes + the full data package as context for follow-up Q&A
- `num_predict`: 8192 for reports, 4096 for follow-up queries
- `num_ctx`: 131072 (128K)

**Buttons:** Generate Report, Ask AI, Copy Report, Copy Data Package, Clear

**Default configuration:**
- Endpoint: `http://localhost:11434/api/generate`
- Model: `gemma4:e4b`

**Markdown rendering (`renderMd()`):**
- Supports: headings (h1-h6), bold, italic, inline code, links, tables, ordered/unordered lists, blockquotes, horizontal rules
- Sanitizes HTML tags (replaces `<` with `&lt;`)

## Subject Profile Modal

Clicking a subject name (in records table, graph, etc.) opens a modal showing:

- Contact count, session count, tower count
- Top service, peak hour, active period (day/night)
- Top 10 contacts (clickable to navigate)
- Hourly activity bars
- Recent activity list
- Click location entries to fly on map

## State Management

The frontend uses global variables for state:

| Variable | Purpose |
|----------|---------|
| `state.cdr` | Array of parsed CDR records |
| `state.ipdr` | Array of parsed IPDR records |
| `state.towers` | Array of parsed tower records |
| `state.auth` | Auth state: `{ user, session, authenticated }` |
| `allRows` | Merged array of all records with type flag, service classification |
| `afkTimer` | Inactivity timeout reference |
| `healthInterval` | Health check interval reference |
| `recPage` | Records table pagination offset |

The `D` object caches DOM element references for frequently accessed elements:

```javascript
const D={
  shell: ge('shell'),
  authOverlay: ge('authOverlay'),
  loginBtn: ge('loginBtn'),
  // ... ~40 more elements
};
```

## Key Technical Patterns

### Chart.js Safe Destroy

Chart.js `destroy()` on an already-destroyed chart throws — always wrapped in try/catch with null assignment:

```javascript
try{ window.chartSvcPie.destroy() }catch(e){}
window.chartSvcPie = null;
```

### Event Listener Management

Event listeners that can be registered multiple times (e.g., on re-render) use named handler pattern:

```javascript
D.graphSearch._handler = (e) => { /* ... */ };
D.graphSearch.removeEventListener('input', D.graphSearch._handler);
D.graphSearch.addEventListener('input', D.graphSearch._handler);
```

### Pagination Reset

Pagination resets to page 0 on tab switch and filter change:

```javascript
recPage = 0;
```

### AFK Auto-Logout

- Timer: 60 minutes of inactivity
- Warning: yellow status indicator at 50 minutes
- Health check: `/auth/me` every 5 minutes
- On logout: `POST /auth/logout`, clears intervals, resets auth state

## Customization

### Adding a New Tab

1. Add `<section>` in `index.html` with appropriate ID
2. Add tab button in `.topbar-tabs` with `data-tab` attribute
3. Add CSS rules in `styles.css` for the new section
4. Add render function and tab switch handler in `app.js`

### Changing Colors

CSS custom properties in `styles.css`:

```css
:root{
  --bg:#f0ebe4;
  --surface:#fff;
  --text:#1f2330;
  --muted:#78716c;
  --accent:#2c6f79;
  --danger:#b94a48;
  --warn:#d4a017;
  --success:#3a7d5a;
}
```

### Service Colors

Defined in `app.js` as `SVC_COLORS` map (16 services, each with a distinct color).
