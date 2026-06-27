# Features List

Comprehensive inventory of every feature in the CDR/IPDR Investigation Visualizer, organized by functional area. Each feature includes a description and the technology used.

---

## 1. Authentication & Security

### Session-based Authentication
- **Description:** Users log in with username/password and receive an HttpOnly session cookie. All subsequent API calls are authenticated via the cookie. Session tokens are 48-byte cryptographically random URL-safe strings.
- **Tech:** FastAPI dependency injection, HttpOnly cookies, `secrets.token_urlsafe(48)`

### PBKDF2-SHA256 Password Hashing
- **Description:** Passwords are hashed using PBKDF2-HMAC-SHA256 with 210,000 iterations and a random 16-byte salt. The hash is stored in the format `pbkdf2_sha256$210000$salt$digest`.
- **Tech:** `hashlib.pbkdf2_hmac`, `secrets.token_bytes`, `base64` encoding

### Session Sliding Window
- **Description:** Each authenticated API request extends the session expiry by the configured TTL (default 168 hours). Ensures active sessions don't expire mid-use.
- **Tech:** `last_seen_at` and `expires_at` timestamps updated on every request via `get_session_from_request()`

### Multi-Session Tracking
- **Description:** Users can view all active sessions (via `GET /auth/sessions`), revoke individual sessions, or revoke all sessions (logout everywhere).
- **Tech:** `AuthSession` model with `user_id` foreign key, `revoked_at` soft-delete

### Password Change
- **Description:** Authenticated users can change their password by providing the current and new password.
- **Tech:** `POST /auth/password` endpoint, `verify_password` + `hash_password`

### Default Admin Bootstrapping
- **Description:** On first startup, if no admin user exists, one is created automatically from environment variables (`AUTH_BOOTSTRAP_USERNAME`, `AUTH_BOOTSTRAP_PASSWORD`, `AUTH_BOOTSTRAP_ROLE`).
- **Tech:** `bootstrap_default_user()` called in FastAPI `on_startup` event

### AFK Auto-Logout (Frontend)
- **Description:** After 10 minutes of inactivity (no mouse/keyboard/scroll/touch events), the frontend automatically logs the user out and revokes the session. The status transitions through 3 stages: Active (green, 0-2 min) → Idle (yellow, 2-9 min) → Expiring soon (red pulse, 9-10 min) → Expired (red, logged out).
- **Tech:** Vanilla JS `setTimeout`/`clearTimeout`, 3-stage timeout chain (`IDLE_MS=2min`, `WARN_MS=1min`, `AFK_MS=10min`), event listeners on `mousemove`, `mousedown`, `click`, `keydown`, `scroll`, `touchstart`, `touchmove`, `wheel`

### Health Check Ping
- **Description:** Every 5 minutes, the frontend pings `GET /auth/me`. If the response is 401 (cookie expired or session revoked elsewhere), auto-logout is triggered immediately.
- **Tech:** `setInterval`, `fetch` with credentials, `doLogout()`

### Session Status Indicator
- **Description:** A colored dot with text in the top bar shows the current session status through 4 states: green dot "Active", yellow dot "Idle", pulsing red dot "Expiring soon", red dot "Expired". Automatically transitions based on user activity.
- **Tech:** CSS classes `.sess-active` (green), `.sess-idle` (yellow), `.sess-warn` (red pulse with `@keyframes pulse` animation), `.sess-expired` (red), toggled by `resetIdle()` / `doLogout()`

### Data Persistence Across Sessions
- **Description:** Case data (CDR, IPDR, Tower records) persists in the database between sessions. Returning users see their previous investigation data.
- **Tech:** Removed `API.del('/records/reset')` from `bootstrap()`, data persists in database across sessions

### Reset Case Button
- **Description:** A prominent "Reset Case" button in the import toolbar allows manually clearing all case data. Supports optional `case_id` query param to reset only a specific case. Shows a confirmation dialog before deleting.
- **Tech:** `resetCase()` function, `confirm()` dialog, `API.del('/records/reset?case_id=...')`, client-side state reset (`allRows=[]; state.cdr=[]; state.ipdr=[]; state.towers=[]; state.subjects=[]`), `renderDashboard()`

### Auto-Create Default Case
- **Description:** When no cases exist, a "Default Case" is auto-created and set as active. Prevents data from being stored without a case association. Auto-selects the first existing case on login if none is active.
- **Tech:** `loadCases()` checks `cases.length === 0`, creates via `API.post('/cases/', {name:'Default Case'})`, sets `activeCaseId`

### Client IP & User-Agent Capture
- **Description:** Each session records the IP address (from `X-Forwarded-For` or direct client) and user-agent string.
- **Tech:** `request.headers.get("x-forwarded-for")`, `request.client.host`, `request.headers.get("user-agent")`

### Court-Ready Case Dossier (official, printable → PDF)
- **Description:** A **Dossier** button in the top bar generates a formal, government-style case report an investigating officer can **Print → Save as PDF** and attach to a charge sheet — fully offline (air-gapped; no PDF library bundled). The document is laid out as an official record: an **ARGUS all-seeing-eye emblem letterhead** with a configurable **agency / unit name + sub-line** (and optional agency logo), top and bottom **RESTRICTED — FOR OFFICIAL USE ONLY** classification banners, a titled cover with a metadata table and a **Document Control** statement tied to the audit-logged reference id. The content is **case-specific and substantive**, not generic counts: a **Contents** page, **1. Executive Summary** (prose headline of what analysis surfaced + key metrics), **2. Case Narrative** (auto-reconstructed story for the principal subject), **3. Persons of Interest** — *detailed per-subject cards* (risk band/score, devices/SIMs, first/last seen, top contacts, top towers with place, identity changes, meetings, cross-case), **4. Key Findings** (co-location meetings, impossible-travel/cloning, SIM/handset changes, hidden links & convoys — actual tables, not just totals), **5. Communication Analysis**, **6. Cross-Case Links**, **7. Bookmarked Evidence** (the evidence folder, **including captured screenshots**), **8. Analytical Charts** (live Chart.js canvases rasterized via `canvas.toDataURL()`), **9. Towers in this Case** (**only the towers that appear in this case's records**, with per-tower activity counts — not the global repository), and an **Appendix A — Methodology & Limitations**. The print stylesheet forces `print-color-adjust:exact` so the navy headers/banners/striping render in print exactly as on screen, sets margins, repeats the classification + **page X of Y** in the footer (`@page` margin boxes), and avoids splitting tables/cards. Generating a dossier is **logged** (ExportLog + AuditLog).
- **Tech:** Frontend `renderDossier()` (per-POI detail built from `buildIdentityProfile()`, `_meetings`, `_infReport` `cdr.risk`/`impossible_travel`/`co_presence`, `getStoryXcase()`, case-only towers from `allRows`+`towerMeta()`) + `fillDossierXcase()`; inline `ARGUS_EMBLEM` SVG; `getAgency()`/`setAgencyDetails()` (localStorage `argus_agency`, "Agency details" toolbar button); official `.dc-*`/`.dossier-*`/`.d-poi`/`.d-ev`/`.d-risk-*` styles + `@media print` (`print-color-adjust:exact`, `@page` footer counters); `POST /inference/dossier` for the ref + chain-of-custody.

### Investigation Story — Narrative & Unified Timeline
- **Description:** A dedicated **Story** tab that *tells the investigation*, not just displays evidence. A subject selector (default: highest-activity subject; plus an "All subjects" case overview) drives two linked panels: (1) an auto-generated **Case Narrative** — plain-language sentences reconstructed in order ("**A** first appears on…", "a **SIM swap** was detected on…", "communication with **X** began on…", "internet activity shifted on…", "co-located with **B** at tower…", "**cross-case match**: also appears in…", "**AI**: impossible travel flagged…"); and (2) a **Unified Investigation Timeline** that merges every event type into one chronological, day-grouped feed — calls, SMS, data-session onset, tower first-visits/movement, **meetings** (co-location), **identity changes** (SIM/handset swaps), **cross-case links**, and **AI/engine findings** (risk bands, impossible travel, hidden-link/convoy, beaconing). Each event is colour-coded by type with a glyph, links to the subject profile, and can be filtered by type via toggle chips. Bounded per subject (top contacts/towers) so the story stays readable.
- **Tech:** Frontend `buildCaseEvents(subject)` (assembles from `allRows`, `buildIdentityProfile().changes`, `_meetings.list`, `/cross-case/report`, and `_infReport` — `cdr.risk`/`cdr.impossible_travel`/`cdr.co_presence`/`ipdr.risk`/`ipdr.beaconing`), `buildNarrative()`, `renderStory()`/`renderStoryTimeline()`/`renderStoryFilters()`, `getStoryXcase()`; new **Story** tab + `.story-*` styles. Subject-focused or case-wide.

### Evidence Linking — bookmarks, screenshots & dedicated Evidence tab
- **Description:** Any finding can be **pinned** into a per-case **Evidence Folder**: text findings on the Story timeline (hidden link, SIM swap, meeting, cross-case match, AI insight) via ☆, **chart snapshots** via a **★ Pin** button added to every chart card (rasterized with `canvas.toDataURL()`), and the **Cross-Case link graph** via a **★ Pin graph** button (D3 SVG serialized to PNG). A **dedicated Evidence tab** (with a live count badge in the nav) shows everything saved — references *and* screenshots — as cards with the finding, detail, subject, timestamps, a thumbnail, and per-item remove; plus **Open dossier**, **Export (.json)**, and **Clear all**. The Story tab also keeps a quick slide-out evidence panel. The folder feeds the dossier's **Bookmarked Evidence** section (images included), so the analyst curates once and it flows into the report.
- **Tech:** Frontend `evLoad()`/`evSave()`/`pinEvidence()`/`unpinEvidence()` (per-case `localStorage` `argus_evidence_{caseId}`, deduped by signature, items may carry an `image` dataURL), `captureCanvasToEvidence()`/`captureSvgToEvidence()`/`installChartCaptureButtons()`, `renderEvidence()` (panel) + `renderEvidenceTab()` (full tab) + `toast()`; new **Evidence** tab and `.evt-*`/`.cap-btn`/`.tab-badge` styles.

### Audit Trail / Chain-of-Custody
- **Description:** Every meaningful action is recorded to an append-only `audit_logs` table for evidentiary accountability: who (username/role), from where (IP), what (action), against which case and target, plus a JSON detail blob and timestamp. Captured actions: `login` / `login_failed`, `upload` (with kind, mode, rows imported, filename), `export`, `dossier`, `case_create`, `case_delete`, and the read beacons `view_case` / `view_subject`. Audit writes are defensive — a logging failure never breaks the primary action.
- **Surfacing:** Admin-only **Audit Log** panel in the Admin tab, most-recent-first, filterable by user, action, and from-date. Reads are recorded via a debounced client beacon (`POST /audit/view`) fired when a case is opened or a subject profile is viewed.
- **Tech:** `AuditLog` model (auto-created via `Base.metadata.create_all`, composite `ix_audit_ts_user` index), `audit_service.log_action()` / `list_audit()`, `GET /audit/log` (admin-gated via `get_current_admin`), `POST /audit/view` (any authed user), frontend `renderAuditLog()` + `auditView()`

### Subject Intel Tags (global, outside-intel)
- **Description:** Investigators can attach a free-text **intel tag/comment** (a word, a few words, or a sentence — e.g. "financier", "uses 3 SIMs", "prime suspect") to any subject (a phone number or an IP). Tags are **global by identifier**: stored centrally and keyed by the literal subject string, so a tag set on a number/IP surfaces in **every case** that identifier appears in, for every officer, surviving refresh — letting outside intel follow a reoffender across cases. The tag is appended in brackets **wherever that subject is shown** — subject profile, records table, dashboard "Most Active", cross-case hits, the Story timeline + narrative, charts, dossier POIs, and subject dropdowns (`9876543210 (financier)`). On the **Network Graph** tab a **"Show tags"** toggle (off by default, to keep the graph clean) appends the tag to node labels (`<SUBJECT> (tag)`). The tag is edited from the subject profile, and every edit is recorded on the chain-of-custody. CDR/IPDR separation is preserved automatically — phone and IP identifiers are distinct strings.
- **Tech:** `SubjectTag` model (unique-indexed `subject`, no `case_id`; auto-created), `GET /subject-tags/` + `PUT /subject-tags/` (upsert; blank tag deletes; `tag_subject` audit row via `log_action`), frontend `state.subjectTags` cache + `subjTag()`/`subjLabel()`/`subjLabelTxt()` display helpers, `loadSubjectTags()`/`saveSubjectTag()`/`saveProfileTag()`, graph `#graphShowTags` toggle, `.subj-tag`/`.prof-tagbar`/`.graph-toggle` styles. Tests in `tests/test_subject_tags.py`.

### Legal Framework Reference (Laws tab — Indian CDR/IPDR)
- **Description:** A dedicated **Laws** tab giving officers the statutory basis for pulling and using CDR/IPDR, framed around "how to actually use it in an investigation." Comprehensive, searchable, category-filterable (Production · Interception · Evidence & Admissibility · Retention · Privacy & Misuse) cards covering: **BNSS 2023 §94** (production of stored records/devices — successor to CrPC §91/92), **BNSS §§175/176/179/185** (investigation, forensic-collection & attendance powers), **Telecommunications Act 2023 §20 + Lawful Interception Rules 2024** (real-time interception; replaces Telegraph Act §5(2)/Rule 419A; 60/180-day limits, Review Committee), **IT Act 2000 §69/§69B + 2009 Rules** (IPDR / digital-info interception & monitoring; ISP-assistance compulsion), **BSA 2023 §§61–63** (the mandatory §63 dual-signature + hash electronic-evidence certificate — the "make it stick in court" card), **data-retention** licence conditions (2-year CDR/IPDR retention; CERT-In 2022), **2013 CDR-procurement guidelines** (SP-rank authorization, monthly DM report — anti-misuse), **K.S. Puttaswamy** (privacy & proportionality), and **DPDP Act 2023** context. Each card lists what it covers, how to use it, who can authorize, timelines/safeguards, case law, and the common pitfall that gets evidence thrown out. Carries a visible "guidance, not legal advice" disclaimer.
- **Tech:** Frontend-only — `LAW_REFERENCE` data array + `renderLaws()` (search/category filter, native `<details>` expanders, expand-all), new **Laws** tab + `switchTab` hook, `.law-*` styles. No backend.

### Evidence Pin/Star Fixes (stateful pinning + star→evidence)
- **Description:** The chart/graph **★ Pin** capture buttons are now **stateful toggles**: they show ☆ Pin when absent and ★ Pinned when in the folder, click toggles in place, and removing an item from the Evidence tab flips the originating button back to ☆. (Previously the capture signature embedded `Date.now()`, so dedupe never matched and the same chart could be pinned repeatedly, removable only from the Evidence tab.) The Cross-Case graph capture button toggles likewise. Additionally, **starring a record** (the ☆/★ in the Records table) now **mirrors that record into the Evidence tab** as a flagged-record card (and un-starring removes it), so flagged rows flow into the dossier alongside other bookmarked evidence.
- **Tech:** Stable capture `sig` (`'chart|'+title` / `'graph|'+title`), `installChartCaptureButtons()` rewritten to the working Story-pin pattern + `_capBtnState()`/`refreshCapButtons()` (re-evaluated after every pin/unpin/clear), `toggleAnnot()` mirrors via `pinEvidence(_recordEvidence(...))` / `unpinEvidenceBySig()`, new `record` kind in `EVK`, `.cap-btn.pinned` style.

---

## 2. Data Ingestion

### CDR CSV Upload
- **Description:** Upload a CDR CSV file containing call detail records (voice calls, SMS, etc.). Replaces all existing CDR data before inserting.
- **Tech:** `POST /upload/cdr`, Pandas CSV parsing, SQLAlchemy bulk insert, transaction with delete-then-insert

### IPDR CSV Upload
- **Description:** Upload an IPDR CSV file containing IP data session records. Replaces all existing IPDR data before inserting.
- **Tech:** `POST /upload/ipdr`, Pandas CSV parsing, SQLAlchemy bulk insert

### Tower CSV Upload
- **Description:** Upload a tower location CSV file. Merges with existing towers using upsert semantics (by `tower_id`).
- **Tech:** `POST /upload/towers`, Pandas CSV parsing, `db.merge()` for upsert

### Permanent Tower Repository (auto-harvested)
- **Description:** The `towers` table is a **global, case-independent** master keyed by `tower_id` (no `case_id`), shared across every case and never wiped by case delete or `/records/reset`. Every CDR/IPDR upload now **auto-harvests** towers from the rows' own `tower_id`+lat/lng, so each case teaches the repository the towers it touched — using the operators' authoritative coordinates. Upserts **insert** new towers and **back-fill** missing coordinates but **never clobber** existing coordinates or city/state. A one-time **Rebuild from records** action backfills coordinates from CDR/IPDR records already loaded (for towers registered before harvesting). A dedicated **Tower Repo tab** shows totals, coordinate coverage, coverage-by-state bars, a searchable listing (tower_id / city / state, with click-to-map), and an "Import master CSV" button (e.g. an OpenCellID India export or an operator/TRAI master).
- **Tech:** `_harvest_towers()` in `api/upload.py` (called inside `upload_cdr`/`upload_ipdr`); `tower_repo_stats()` / `tower_repo_list()` / `rebuild_tower_repo()` in `services/tower_service.py`; endpoints `GET /towers/repo/stats`, `GET /towers/repo`, `POST /towers/repo/rebuild`. Frontend `renderTowerRepo()`/`renderTowerRepoView()` + `.tr-*` styles. Tested in `backend/tests/test_tower_repo.py` (harvest insert/backfill/no-clobber, missing-column guard, stats/search, rebuild).

### Offline Reverse-Geocoding (tower → city/state)
- **Description:** Auto-harvested towers carry coordinates from the records but no place name, while master-CSV towers do. This derives a **city + state from coordinates** with a *nearest major city* lookup against an embedded India reference table (~170 cities spanning every state/UT) — **fully offline**, no external API, matching the app's air-gapped design. State accuracy is high; city is the nearest known city (approximate). Values are **only ever filled in when missing** — an authoritative master CSV is never overwritten. Geocoding runs **automatically at the end of "Rebuild from records"** (so harvested towers get named in one click) and is also available standalone via a **"Fill place names"** button in the Tower Repo tab. The rebuild status line reports the count named; the by-state / cities-covered stats reflect the newly resolved names.
- **Tech:** `services/geocode_service.py` — `nearest_city(lat,lng)` (haversine over `INDIA_CITIES`), `fill_tower(tower)` (fills only-missing), `geocode_missing(db)` (bulk, idempotent). Wired into `rebuild_tower_repo()` (returns a `geocoded` count); endpoint `POST /towers/repo/geocode`. Frontend `trGeocodeBtn` handler + updated rebuild status. Tested in `backend/tests/test_geocode.py` (nearest-city state resolution, fill-only-missing, idempotency, rebuild integration).

### Append-or-Replace Upload Strategy
- **Description:** CDR and IPDR uploads support **two modes**, chosen per-upload in the preview dialog: **Add to existing** (append the new rows to whatever the case already holds — for loading additional dumps for the same case without losing prior data) or **Replace existing** (clear the case's CDR/IPDR first, then insert — for re-loading a corrected file). The preview shows how many records of that type the case already has so the choice is informed; the UI defaults to the non-destructive **Add to existing**. Tower uploads still use merge/upsert. The API parameter is `mode=append|replace` (defaults to `replace` for backward compatibility; the UI always sends an explicit mode).
- **Tech:** `mode: str = Form("replace")` on `POST /upload/cdr` and `/upload/ipdr`; the pre-insert `DELETE` runs only when `mode != "append"`. Frontend `showUploadPreview()` injects a radio toggle, `handleUploadConfirmed(kind,file,route,mode)` sends it. Tested in `backend/tests/test_upload_append.py` (append keeps existing, replace clears, default-is-replace), via dependency-overridden in-memory SQLite.

### Flexible Ingest — Operator Column Mapping & Validation Report
- **Description:** Real ISP dumps (Airtel/Jio/VI/BSNL and generic exports) use inconsistent header names and date formats; the old upload required *exact* canonical column names and silently coerced bad dates to `NaT`. Ingest now **resolves aliased headers onto canonical CDR/IPDR fields** (e.g. `Caller`/`calling_number` → `a_party_number`, `src_ip` → `source_ip`, `Call Date` → `start_time`) via a normalized alias table, with a best-effort **operator hint** from the header signature. Timestamps written in any of several common formats (ISO, `dd/mm/yyyy`, `d-mon-yyyy`, …) are parsed **row-by-row** so a file mixing formats resolves both, with a dayfirst-aware fallback. The upload returns a **validation report** — rows total / imported / dropped, date coercions, the mapping used, and example dropped rows. **Drop policy:** a row is dropped only if it has no parseable `start_time` (no temporal anchor); other null fields are kept. CDR/IPDR separation is preserved (each kind has its own canonical schema and alias set).
- **Surfacing:** The upload-preview dialog calls `POST /upload/preview` (dry-run, no DB write) and shows an **editable column-mapping** block — one `<select>` of the file's headers per required canonical field (pre-selected from auto-detection, required ones flagged when unmapped) plus a collapsible list of optional mapped columns. On confirm the chosen mapping is sent as `mapping_json`. A missing required column returns **HTTP 422** with the unmapped field(s) named (no opaque failure). After upload, an **import report** modal shows what was coerced/dropped with sample rows.
- **Tech:** `services/ingest_service.py` — `resolve_columns(headers, kind, override)`, `coerce_frame(df, kind, mapping)` (row-wise `_parse_datetimes`), `detect_operator()`, `ALIASES`/`CANONICAL`/`REQUIRED` tables; `api/upload.py` refactored to map → coerce → build records, with `mapping_json`/`operator` form params and a `POST /upload/preview` endpoint; `UploadResponse.validation`. Frontend `populateMapping()` / `collectMapping()` / `showValidationReport()`. Tested in `backend/tests/test_ingest.py` (alias mapping, unmapped-required, override wins, mixed-date parse + drop, aliased upload returns report, 422 on missing required, preview).

### CSV File Parser
- **Description:** Centralized CSV loading utility using Pandas with flexible column handling.
- **Tech:** `pandas.read_csv()`, `app/services/csv_parser.py`

### Column Validation
- **Description:** Validates and normalizes CSV column names against expected schema, with configurable strictness.
- **Tech:** `app/utils/validators.py`, case-insensitive column matching

### Sample Data Generator
- **Description:** A script that generates deterministic (seeded) sample data: 60 towers, 1200 CDR records, 1800 IPDR records across 10 Indian cities. Data includes realistic phone numbers, IMSI/IMEI, towers, call types, IP addresses, ports, protocols, and APNs.
- **Tech:** `backend/scripts/generate_sample_data.py`, `random.seed(42)`, output to `sample_data/*.csv`

### Triangulation Seed Data
- **Description:** A script that creates 4 towers (TRI_TWR_A–D) in the Mumbai corridor with different tech (LTE/NR/UMTS) and 21 IPDR records for subject 10.1.0.1 across 3 time clusters, for testing triangulation features.
- **Tech:** `backend/scripts/seed_triangulation.py`, SQLAlchemy bulk insert, tower + IPDR record seeding

### Upload Data Preview
- **Description:** Before uploading a CSV file, a preview modal shows the first 20 rows with detected column names and total row count. The user can confirm or cancel the upload. Parsed client-side using a custom CSV parser that handles quoted fields.
- **Tech:** `FileReader.readAsText()`, `file.slice(0, 1024*512)` for initial portion, custom `parseCsvPreview()` function, modal overlay with confirm/cancel buttons

### Case-Aware Upload
- **Description:** CDR and IPDR upload endpoints accept an optional `case_id` form field. When provided, records are inserted with that case_id and only that case's records are replaced. When omitted, all records are replaced as before.
- **Tech:** `case_id: str = Form("")` in upload endpoints, `CDRRecord.case_id == case_id` filter for selective delete

---

## 3. Dashboard

### KPI Summary Cards
- **Description:** Eight to ten cards showing: Total Records (CDR/IPDR breakdown), Reconstructed Sessions, Call/Service Events, Top Contact, Top Service, Most Active Tower, Unique Contacts, Unique Subjects, Geo-fenced Records (when geofence is active), Activity Spikes (when detected).
- **Tech:** Vanilla JS DOM manipulation, client-side aggregation from `allRows` array, `getAiCache()` for pre-computed metrics, `qualityCard` and `caseSummaryCard` dynamically appended

### Case Summary (11 Metrics)
- **Description:** A collapsible section in the dashboard showing: total subjects, total records, CDR count, IPDR count, time span, unique contacts, unique towers, total sessions, total meetings, total SIM swaps, total device changes. Each metric displayed as a labeled value in a grid.
- **Tech:** `renderCaseSummary()`, `.case-summary-grid` CSS grid, row counting from cached analytics

### Data Quality Score Card
- **Description:** Scores the loaded dataset 0-100% based on data completeness penalties: missing tower (-5 each), missing coordinates (-8 each), missing duration (-10 each), invalid timestamps (-15 each), unknown protocols (-3 each). Displays score, classification (Excellent/Good/Fair/Poor), and per-category penalty breakdown.
- **Tech:** `computeQualityMetrics()`, `renderQualityCard()`, penalty accumulator with category tracking

### Cross-Case Hits Panel
- **Description:** When the case is opened, a panel lists this case's subjects that **also appear in other cases** (matched by number + handset IMEI / SIM IMSI, or low-confidence IP), each row showing the other-case count and clickable to the subject profile. Hidden when there are no cross-case matches. See §11 Cross-Case Subject/Suspect Linking.
- **Tech:** `renderCrossCaseHits()` fetches `GET /cross-case/overview?case_id=`

### Compare Periods
- **Description:** Two date-range selectors (Period A and Period B) with a Compare button. Analyzes differences: volume change %, new/lost/shared contacts, new subjects, new towers, service usage changes (top 8 deltas). Results displayed as a delta grid with positive/negative coloring.
- **Tech:** `runComparePeriods()`, date inputs, per-period data filtering, `Set` operations for new/lost/shared entity detection, delta percentage calculation

### Mini D3 Force-Directed Graph
- **Description:** A compact network graph (200 records sampled) showing entity relationships. Nodes sized by connection weight, edges weighted by interaction count. Clicking a node opens the subject profile. Clicking "Network Overview" switches to the full Graph tab. Node labels use theme-aware colors in dark mode.
- **Tech:** D3.js v7, `forceSimulation`, `forceLink`, `forceManyBody`, `forceCenter`, `forceCollide`, `.graph-label` CSS class with `.dark .graph-label{fill:#e0ddd8}`, onclick navigates to graph tab

### Geofence Count Card
- **Description:** When a geofence polygon is drawn on the map, a "Geo-fenced Records" card appears in the dashboard showing the count and percentage of records whose coordinates fall within the polygon area. Updates live as data changes.
- **Tech:** `geoFenceDrawn` flag, `geoRecords` array, Turf.js `booleanPointInPolygon()`, `D.dashCards` append

### Service Distribution Doughnut Chart
- **Description:** Doughnut chart showing the top 8 services by record count, with color-coded segments and a legend positioned on the right.
- **Tech:** Chart.js 4.4.7, `type: 'doughnut'`, responsive with `maintainAspectRatio: false`

### Daily Activity Bar Chart
- **Description:** Bar chart showing activity distribution across days of the week (Sun-Sat). Bars are colored dynamically based on activity intensity relative to the peak day.
- **Tech:** Chart.js 4.4.7, dynamic `backgroundColor` using thresholds (`>70%` = red, `>40%` = yellow, else green)

### Top Contacts Bar Chart
- **Description:** Horizontal bar chart of the top 10 most frequent contacts. Clicking a bar navigates to the subject profile.
- **Tech:** Chart.js 4.4.7, `onClick` callback, `showProfile()` integration

### Error-Isolated Sub-Renders
- **Description:** Each dashboard component (graph, pie, heatmap, bar chart) renders inside its own `try/catch` block. If one component fails, it shows an inline error message without breaking the rest of the dashboard.
- **Tech:** JavaScript `try/catch`, `D.dashGraph.innerHTML = '<p style="color:var(--danger)">...'`

---

## 4. Network Graph

### D3.js Force-Directed Graph (server-built, bounded)
- **Description:** Full-page interactive network graph showing entity relationships. Nodes represent entities (phone numbers or IPs), edges represent connections with weight. The graph is **built server-side** (`/graph`) and the browser receives only a **bounded top-N subgraph** (the heaviest links), so it never assembles a 500k-record graph in memory. Node weights are the node's **true total over all edges** (full-coverage centrality even when the view is trimmed), and the endpoint reports `total_nodes`/`total_edges` for an honest "top N of M" label. Includes **both** the CDR call network (phone↔phone) and the IPDR connection network (source_ip↔destination_ip) as **disjoint components** (no CDR/IPDR cross-attribution); IPDR nodes are coloured distinctly (purple) and each node carries a `kind` tag (cdr/ipdr) shown on hover. Graph data is verified to exactly match the records (edge set, weights, and node weights identical; sum of edge weights == record count).
- **Tech:** server `build_graph()` (NetworkX, `Counter` edge aggregation over both tables); D3.js v7 `forceSimulation` with `forceLink`, `forceManyBody` (-150), `forceCenter`, `forceCollide`; client fetches `/graph/?case_id&subject&limit`

### Subject Filtering + Selectable Link Count
- **Description:** A dropdown filters the graph to one subject and its direct connections. A separate **"Max links" picker (150 / 300 / 500 / 1000 / 2000 / All, default 300)** controls how many of the heaviest links are drawn, so investigators can see more of the network on demand. The force layout tops out around 2000 nodes comfortably; "All" is available with a "may be slow" hint.
- **Tech:** `<select id="graphSubject">` + `<select id="graphLimit">`, both re-fetch `/graph` with the chosen `subject`/`limit`

### Search/Highlight
- **Description:** Real-time search input that dims non-matching nodes and edges (opacity 0.1/0.05) while highlighting matches (opacity 1/0.4).
- **Tech:** Named event handler pattern (`.removeEventListener` + `.addEventListener`), D3 `.attr('opacity', ...)`

### Zoom & Pan
- **Description:** Mouse wheel zoom and click-drag pan with scale limits (0.2x to 8x). "Center Graph" button resets the view.
- **Tech:** `d3.zoom()`, `d3.zoomIdentity`, `.scaleExtent([0.2, 8])`

### Node Dragging
- **Description:** Nodes can be clicked and dragged to rearrange the layout. Simulation re-heats temporarily during drag.
- **Tech:** `d3.drag()`, `sim.alphaTarget(0.3).restart()`, fixed position (`fx`/`fy`)

### Node Details Sidebar
- **Description:** Hovering over a node shows its ID, weight, and connection count in the sidebar. Clicking opens the subject profile modal.
- **Tech:** `onmouseover`/`onclick` events, `D.graphDetails.innerHTML`

### Node Labels
- **Description:** Text labels displayed next to each node (truncated to 12 characters with ellipsis).
- **Tech:** D3 `text` elements, positioned relative to node coordinates

### Graph Stats
- **Description:** Footer text showing "N nodes, M links (top X)" to quantify the current view.
- **Tech:** `D.graphStats.textContent`

### Link Deduplication
- **Description:** Multiple connections between the same pair of entities are merged into a single weighted edge.
- **Tech:** `Map` with sorted key `[r.sub, r.cnt].sort().join('|')`

### NetworkX Backend Metrics
- **Description:** Backend computes degree centrality, betweenness centrality, communities (greedy modularity), and bridge edges from CDR records.
- **Tech:** NetworkX, `nx.degree_centrality()`, `nx.betweenness_centrality()`, `greedy_modularity_communities()`, `nx.bridges()`

---

## 5. Tower Map

### Leaflet Map with OpenStreetMap Tiles
- **Description:** Full-screen interactive map centered on India (20.59, 78.96) with zoom controls and OSM tile layer.
- **Tech:** Leaflet 1.9.4, `L.tileLayer('https://{s}.tile.openstreetmap.org/...')`, `L.map()`

### 6 Map Modes

#### Movement Path
- **Description:** Draws a polyline connecting all towers visited by a subject in chronological order. Markers show each location. Distance calculation in km. Timeline sidebar lists recent locations. Playback slider animates through the path.
- **Tech:** `L.polyline`, `L.circleMarker`, `mapInstance.distance()`, `D.mapTimeSlider` + `D.mapTimePlay`

#### Activity Heatmap
- **Description:** Renders a true Gaussian density surface (not graduated bubbles) showing where activity is concentrated. Each location contributes a point weighted by its visit count, normalized against the busiest tower so colour reflects relative intensity. Small clickable dots overlay the surface so every location stays inspectable (tower id + visit count popups). Sidebar lists records, distinct locations, peak visit count, a gradient legend, and the top hotspots (click to zoom).
- **Tech:** `leaflet.heat` plugin, `L.heatLayer(points, {radius, blur, max: maxC, minOpacity, gradient})` with weighted `[lat, lng, count]` points and a blue→cyan→green→yellow→red gradient; bounds fit to the subject's points; graceful `L.circleMarker` fallback if the plugin is unavailable

#### Operational Zones
- **Description:** Draws radius circles around towers, sized proportionally to activity count. Tower markers with popups showing visit counts. Percentage breakdown in sidebar.
- **Tech:** `L.circle()` with dynamic radius (`10 + sqrt(count) * 4`), opacity based on normalized activity, `L.marker()` with `bindPopup()`

#### Co-location
- **Description:** Identifies towers where multiple subjects appear together. Highlights towers shared by the selected subject. Shows co-located subjects in sidebar.
- **Tech:** Client-side tower aggregation, `Set` for unique subjects per tower, filter by shared subjects

#### Meeting Detection
- **Description:** Detects potential in-person meetings when two subjects appear at the same tower within a time window. Detection now runs **server-side** (`/investigation/meetings`) — exact and full-coverage over the whole case (see the Meeting Detection Engine entry) — and the map plots the encounters, colour-coded by gap (red < 5 min, amber < 15 min, blue otherwise) with the closest encounters and exact total/distinct-pairs counts in the sidebar; each sidebar row zooms to its tower.
- **Tech:** `showMapMeetings(sub)` fetches `GET /investigation/meetings?case_id&subject`, `L.circleMarker` per encounter with gap-based colour

#### Triangulation
- **Description:** Time-based tower clustering (30-minute hand-off windows) to estimate subject location. Renders tech-aware coverage circles (5G/NR = 1km, 4G/LTE = 3km, 3G/UMTS = 5km, 2G/GPRS/EDGE = 15km) coloured green→red by tower-usage density. For each cluster it computes a **position fix**: an inverse-variance weighted centroid of the contributing towers (each weighted by `1/r²`, so tighter cells pull the estimate harder — the RF analogue of an inverse-variance mean), drawn as a crosshair marker with a ±precision uncertainty circle (bounded by the tightest cell) and geometry lines to each tower. When the cells genuinely overlap, the rigorous Turf.js intersection region is drawn as a red dashed polygon. Unlike a strict all-cells intersection, the overlap is computed tightest-first and *skips* non-overlapping cells instead of aborting, so a fix is always produced even when the cells don't all intersect. Sidebar reports tower count, position fixes, overlap fixes, best precision (±km), and a clickable list of estimated positions.
- **Tech:** `showMapTriangulation()`, `L.circle()` with tech-based radii, inverse-variance weighted centroid (`Σ w·p / Σ w`, `w = 1/r²`), `triangulateOverlap()` helper doing tightest-first `turf.intersect()` with skip-on-empty fallback, `turf.circle()`/`turf.polygon()` geometry, `L.divIcon` crosshair marker + uncertainty `L.circle`, green→red density colour scale

### Geofencing
- **Description:** "Geofence" button in the map toolbar toggles Leaflet.draw polygon drawing mode. Once a polygon is drawn, the dashboard shows a geo-fenced record count. "Clear Fence" button removes the polygon. Drawn polygon persists independently across map mode switches.
- **Tech:** `L.Draw.Polygon` with `showArea: true`, `mapInstance.on(L.Draw.Event.CREATED)`, `geoFenceLayer` saved separately from `clearMap()`, Turf.js `booleanPointInPolygon()` for record filtering

### Map Sidebar
- **Description:** Contextual sidebar that updates based on the active map mode showing statistics, tower lists, and event timelines.
- **Tech:** `D.mapAnalysis.innerHTML`, `.stat-row` and `.evt` CSS classes

### Fit All / Fit Bounds
- **Description:** "Fit All" button calculates the bounding box of all geo records and zooms to fit.
- **Tech:** `mapInstance.fitBounds(pts, {padding: [30, 30]})`

### Subject Filter
- **Description:** Dropdown to select a specific subject for the map, populated from geo endpoint data.
- **Tech:** `<select>` with `change` event, `geoSub(sub)` filter function

### Marker Popups
- **Description:** Clicking any map marker shows a detailed popup with: type, subject, counterpart, time, duration, call type, direction, protocol, MSISDN, tower, location, upload/download bytes.
- **Tech:** `L.marker.bindPopup(popupHtml(r))` with HTML string construction

### Time Playback Slider
- **Description:** For Movement Path mode, a time slider allows stepping through events in order. "Play" button auto-advances every second.
- **Tech:** `<input type="range">`, `setTimeout` loop, marker highlight (radius 10, red)

---

## 6. Entity Timeline

### Entity-Grouped Cards
- **Description:** Timeline events are grouped by entity (phone number or IP) into collapsible cards. Each card shows the entity name, event count, session count, and contact count.
- **Tech:** `entityMap` object grouped by entity ID, `D.tlContainer.innerHTML` with card HTML

### Collapsible Toggle (Heading/Arrow Only)
- **Description:** Cards expand/collapse only when clicking the heading area or arrow — clicking the body has no effect. Arrow rotates 90° when open.
- **Tech:** `toggleEntity()` with `el.closest('.tl-entity')`, `.open` CSS class, arrow text from ▶ to ▼

### Activity Density Strip
- **Description:** A thin colored bar strip showing 50 time buckets, each bucket's height proportional to event density at that point. Gives a bird's-eye view of when the entity was active.
- **Tech:** 50-section `<div>` with inline heights, `density[idx]++`, `Math.floor((time - first) / span * 49)`

### Gantt-Style Session Bars
- **Description:** Reconstructed sessions displayed as horizontal Gantt bars within each entity card. Bar position and width correspond to the session's time range relative to the entity's overall activity span. Colored by service type (100+ service color definitions). Hovering shows a detailed tooltip with service, times, duration, confidence, and evidence tree categorized into Infrastructure/Ports/Behavior/Signals. Tooltip stays fixed to the element (top-left corner touches top-right of bar) and does not follow the cursor. Tooltip can be hovered directly without disappearing (200ms grace period on bar leave, pointer-events enabled on tooltip itself). "View Records" button in the tooltip opens a session evidence overlay with full record listing and evidence integrity hash.
- **Tech:** Absolute positioning with `margin-left` and `width` percentages, `SVC_COLORS` map (100+ service definitions), `background: ${c}18` (12% opacity) + `border-left: 2px solid ${c}`, `showGanttTip()` / `positionGanttTip(el)` using `getBoundingClientRect()` with viewport edge detection and flip-to-left logic, `onmouseenter`/`onmouseleave` on tooltip, 200ms `setTimeout` hide delay, `pointer-events: auto` on tooltip, `evidenceHash()` for session integrity, `showSessionRecords()` overlay

### Gantt Tooltip Auto-Width
- **Description:** The Gantt hover tooltip uses `width: max-content` instead of a fixed `max-width`, so it expands horizontally to fit the full title text in a single line. Evidence/service lists still wrap normally via `ul{white-space:normal}`.
- **Tech:** `.gantt-tooltip{width:max-content;white-space:nowrap}`, `.gantt-tooltip ul{white-space:normal}`

### Event List (per entity)
- **Description:** Within each expanded entity card, the 50 most recent events are listed chronologically (newest first) showing: time, type dot (color-coded red for IPDR, teal for CDR), type badge, counterpart, duration, service attribution.
- **Tech:** `.tl-ev` CSS, `slice(-50).reverse()`, event type dot with inline background

### Search Filter
- **Description:** Filter entities by name using a search input. Non-matching entities are hidden.
- **Tech:** `.filter(e => e.entity.toLowerCase().includes(q))`

### Type Filter
- **Description:** Dropdown to show all records, only CDR, or only IPDR records in the timeline.
- **Tech:** `<select>` with `change` event, `rows.filter(r => r.type === type)`

### Side-by-Side Comparison
- **Description:** "Compare with..." dropdown selects a second entity. The timeline switches to a two-column grid layout showing both entities' timelines side by side, with their respective Gantt bars and event lists.
- **Tech:** `D.tlCompare` dropdown, `display:grid;grid-template-columns:1fr 1fr`, `renderEntityTimeline()` called independently for each entity

### Session Count Display
- **Description:** Each entity card shows the number of reconstructed sessions (e.g., "3 sessions") in the meta line.
- **Tech:** `reconstructSessions(e.entity).length`

---

## 7. Charts (20 Chart Types)

### Behavioural & Investigative charts (8, added)
- **Description:** A second band of charts below the original twelve, focused on investigative insight rather than raw counts. All compute client-side from `allRows` and auto-bucket the case window (daily, switching to weekly when the span exceeds ~120 buckets) so they stay legible on large cases:
  - **Daily Activity Trend** — total records per day/week across the *full* case window (the older Service Timeline only shows the last 14 days); surfaces escalation, lulls and dormant gaps.
  - **Pattern of Life (Day × Hour)** — a 7×24 CSS-grid heatmap of when activity happens (darker = busier), exposing routines and night/weekend behaviour. Built as a CSS grid because only the core Chart.js bundle is vendored (no matrix plugin).
  - **CDR vs IPDR Over Time** — stacked per-bucket bars splitting voice/SMS vs data, showing how the two evolve.
  - **Cumulative Activity** — running total curve (growth rate at a glance).
  - **Most Active Subjects** — top subjects by *owned* records; click a bar to open that subject's profile.
  - **New vs Returning Contacts** — per-bucket split of first-seen contacts vs already-seen ones (network expansion over time).
  - **Activity by Location** — records ranked by state/UT, joined from the tower repository's geocoded city/state (empty-state nudges to “Fill place names”).
  - **Tower Diversity Over Time** — distinct towers touched per bucket (movement/footprint breadth).
- **Tech:** `renderChartDailyTrend/PatternHeat/CdrIpdrTime/Cumulative/ActiveSubjects/NewReturning/GeoState/TowerDiversity()` in `app.js`, dispatched from `renderCharts()` (each wrapped in try/catch). Shared helpers `_timeBuckets()` (adaptive day/week bucketing), `_dayKey()`, `towerMeta()` (tower_id→city/state from `state.towers`). `.pol-*` / `.charts-divider` styles. Chart.js for all but the heatmap.

### Service Usage Doughnut Chart
- **Description:** Pie/doughnut chart showing the top 10 services by record count with a legend on the right.
- **Tech:** Chart.js 4.4.7, `type: 'doughnut'`, 10-color palette

### Hourly Activity Bar Chart
- **Description:** Bar chart showing activity across 24 hours (00:00 - 23:00). Bars colored dynamically based on activity intensity relative to peak hour.
- **Tech:** Chart.js 4.4.7, `type: 'bar'`, dynamic `backgroundColor` array

### Top Contacts Horizontal Bar Chart
- **Description:** Horizontal bar chart of the top 10 most frequent contacts, with custom tooltips showing the full contact identifier.
- **Tech:** Chart.js 4.4.7, `indexAxis: 'y'`, custom tooltip callback

### Service Timeline Line Chart
- **Description:** Multi-line chart showing the top 6 services' activity over the last 14 days. Each service is a separate colored line with fill area.
- **Tech:** Chart.js 4.4.7, `type: 'line'`, `fill: true`, `tension: 0.3`, multi-dataset

### Contact Direction Stacked Bar Chart
- **Description:** Stacked bar chart showing MO (outgoing) vs MT (incoming) calls per contact, with hover tooltips showing exact counts.
- **Tech:** Chart.js 4.4.7, `type: 'bar'`, stacked datasets for MO/MT

### Contact Duration Horizontal Bar Chart
- **Description:** Horizontal bar chart of average call duration per contact, sorted descending.
- **Tech:** Chart.js 4.4.7, `indexAxis: 'y'`, dynamic bar coloring

### Day of Week Bar Chart
- **Description:** Bar chart showing activity volume by day of week, with the peak day colored red and slowest day colored green.
- **Tech:** Chart.js 4.4.7, dynamic per-bar coloring based on relative intensity

### Duration Distribution Bar Chart
- **Description:** Histogram of call durations across 7 bins: <10s, 10-30s, 30-60s, 1-5m, 5-15m, 15-60m, >60m.
- **Tech:** Chart.js 4.4.7, binned duration aggregation

### Protocol Distribution Doughnut Chart
- **Description:** Doughnut chart showing IPDR protocol breakdown (TCP, UDP, ICMP, etc.) with percentage labels.
- **Tech:** Chart.js 4.4.7, protocol counting from IPDR records

### Top Ports Horizontal Bar Chart
- **Description:** Horizontal bar chart of the most used ports, with port service name labels.
- **Tech:** Chart.js 4.4.7, `portSvc()` lookup for labels

### Data Volume Horizontal Bar Chart
- **Description:** Horizontal bar chart showing total data volume (upload + download) per contact, formatted in human-readable units (KB, MB, GB).
- **Tech:** Chart.js 4.4.7, `fmtBytes()` for readable labels, sorted descending by volume

### Tower Activity Horizontal Bar Chart
- **Description:** Horizontal bar chart of the most active towers by record count, with tower ID labels.
- **Tech:** Chart.js 4.4.7, tower count aggregation

### Safe Chart Destruction
- **Description:** All chart instances are destroyed and nullified before re-creation, wrapped in try/catch to prevent errors from stale references.
- **Tech:** `window.chartSvcPie` / `window.dashPieChart` etc. global references, `try{ chart.destroy() }catch(e){}`, null assignment

### Theme-Aware Chart Colors
- **Description:** Chart.js default text color and grid line colors are updated when dark mode is toggled. Text switches between `#2c2418` (light) and `#e0ddd8` (dark). Grid colors use the theme's line color. Applied at startup and on theme change.
- **Tech:** `updateChartTheme()`, `Chart.defaults.color = textColor`, called from dark mode toggle and initial IIFE

---

## 8. Records Table

### 24-Column Data Table
- **Description:** Full table displaying: Time, Type, Subject, Counterpart, Dur(s), Detail, Dir/APN, Service, SrcPort, DstPort, Port Svc, App Attr, Tower, Cell, LAC, IMSI, IMEI, MSISDN, Tec/RAT, Up(B), Dn(B), Lat, Lng, Case. All CDR and IPDR fields are visible. Column widths are dynamically sized: time = 280px, IPv4/phone = 150px, other = 200px, empty = 120px.
- **Tech:** `<table>` with horizontal scroll, `renderRecTable()` builds HTML string, `colWidth(v)` helper for dynamic column sizing

### Record Annotations
- **Description:** A star/flag icon in the first column of each row. Clicking toggles an annotation on the record. Annotations are stored server-side linked by `record_type` + numeric `record_id`, and persisted per user. Starred records persist across sessions. Toggling repaints just that row's star in place (no table re-render).
- **Tech:** `POST /annotations/` (numeric `record_id`) to create, `DELETE /annotations/{id}` to remove, `GET /annotations/` to load on tab render, `.annot-cell[data-annot]` in-place repaint, star (★) / empty star (☆)

### Clickable Tower IDs
- **Description:** Every tower id shown in the table (and across the app — profile, map popups, inference cards) is a clickable chip; clicking it jumps to the Tower Map and zooms to that tower with a highlight marker. Works from any tab (loads the map/geo on demand) and resolves coordinates from the loaded geo records (falling back to the towers table).
- **Tech:** `twr(id)` chip (data-attr id, `event.stopPropagation()` so it doesn't open the row's profile) → `showTower(id)` → `towerLocate()` + `L.circleMarker` highlight

### Record Type Filter
- **Description:** Dropdown to show All, CDR only, or IPDR only records.
- **Tech:** `<select>` with `change` event, `.filter(r => r.type === value)`

### Service Filter
- **Description:** Dropdown populated dynamically from all unique service names in the loaded data. Filters records by service.
- **Tech:** `<select>` dynamically populated from `new Set(allRows.map(r => r.svc))`

### Text Search
- **Description:** Real-time search across subject, counterpart, tower, cell, protocol, IMSI, and IMEI fields. Re-renders instantly off the in-memory rows.
- **Tech:** `.filter(r => `${r.sub} ${r.cnt} ...`.includes(q))` over `allRows`

### Full Render (no pagination)
- **Description:** Every record of the case is loaded once into memory on case open (`allRows`), and the table renders the **entire filtered set in one pass** — there is no "Load more" button; you just scroll. Filters/search re-render instantly from memory. (A server-side paginated `/records/page` + `/records/services` pair exists and is tested as an opt-in fetch-on-demand mode for cases too large to hold comfortably in memory, but the default UI renders all at once.)
- **Tech:** `renderRecTable()` builds the full `rows.map(recRowHtml).join('')`; `recRowHtml(r)` per-row builder; Load-more button hidden

### Row Click → Subject Profile
- **Description:** Clicking any row in the table opens the subject profile modal for the record's subject.
- **Tech:** `<tr onclick="showProfile(...)">`, `cursor: pointer` style

### Port Service Lookup
- **Description:** The Port Svc column looks up well-known port numbers (30+ ports mapped) to show the service name (e.g., port 443 → "HTTPS", port 53 → "DNS").
- **Tech:** `PORT_SVC` map object, `portSvc()` function

### App Attr Column (Service Signatures)
- **Description:** Shows all matching service signatures for IPDR records based on port/protocol/IP-range matching against the multi-level service attribution engine (40+ providers, IP range analysis, behavioral traffic patterns, distinctive indicators).
- **Tech:** `recordSvcAttr()` function, `matchService()` pipeline: Phase 1 (IP infrastructure → provider-level via `scoreProvider()` + `pickBest()`), Phase 2 (port-only fallback), `SERVICE_DB` with 40+ providers and AS/domain/IP range metadata

### Record Type Badges
- **Description:** Color-coded badges: teal for CDR, red/coral for IPDR.
- **Tech:** `.tag` / `.tag-alt` CSS classes

### Horizontal Scroll
- **Description:** The table container has a horizontal scrollbar to accommodate all 24 columns without wrapping.
- **Tech:** `.data-table-wrapper { overflow-x: auto }`

---

## 9. Subject Profile

### Modal Overlay
- **Description:** A modal dialog that appears when clicking any subject name in the application. Dismissible via close button or clicking outside the modal.
- **Tech:** `display: flex` overlay, `onclick` on background to close, close button, close-on-Escape

### Profile Summary Cards (15 Metrics)
- **Description:** Fifteen metric cards showing: Contacts count, Total records, Sessions count, Towers count, Top Service, Avg records/day, Peak hour (busiest hour), Day/Night classification (>50% night = night-dominant), Detected meetings, First seen timestamp, Last seen timestamp, Dormant periods count, Activity spike count, Longest dormant gap (days), Observation period (days).
- **Tech:** `showProfile()` computes metrics from `allRows`, `.prof-grid` with `.prof-card` items, client-side aggregation

### Identity Profile
- **Description:** Subject identity linking showing MSISDN, IMEI, IMSI associated with the subject. Includes an identity timeline showing chronological (IMEI, IMSI) state transitions and detected changes (SIM swaps, device changes) with dates.
- **Tech:** `buildIdentityProfile(sub)` returns identity timeline + changes, `ShowLess`/`ShowMore` toggle for long lists

### Top Contacts (Clickable)
- **Description:** Up to 10 clickable contact chips. Clicking a chip opens that contact's profile, enabling recursive entity navigation.
- **Tech:** `showProfile('${esc(c)}')` onclick, `.prof-contact` CSS

### Tower Analytics
- **Description:** Total towers visited, top 5 towers by activity count, night tower (most used 23:00-05:00), weekend tower (most used Sat/Sun), and clickable tower list that switches to the Map tab.
- **Tech:** `towerAnalytics(sub)`, `showProfileTowers(towers, sub)`, `switchTab('map')` on tower click

### Attributed Services
- **Description:** Top session services with color indicators from the service classification engine. Shows service name, confidence %, and session count.
- **Tech:** Service color lookup, session classification from `classifySession()`

### Cross-Case Links
- **Description:** An "Also seen in N other cases" panel showing every other case this subject (or its handset/SIM/IP) appears in — one clickable chip per case with match type, confidence and date span. Clicking jumps to that case and reopens the subject. Shows "No prior occurrences" when isolated. See §11 Cross-Case Subject/Suspect Linking.
- **Tech:** `fillProfileCrossCase(sub)` fetches `GET /cross-case/subject`, chips call `openInCase(caseId, sub)`

### Detected Co-locations
- **Description:** Meeting events where this subject participated, showing counterpart, tower, time gap, score, and a "View" button opening a meeting detail overlay.
- **Tech:** `detectMeetings()` filtered to subject, `showMeetingOverlay()` for detail

### Hourly Activity Bars
- **Description:** A 24-bar chart showing the subject's activity by hour. Bar height is proportional to activity, colored by intensity relative to the subject's peak hour.
- **Tech:** 24 `<div>` elements with inline `height: Math.max(4, (h/maxH)*40)`, dynamic colors

### Timeline Narrative
- **Description:** Chronological text narrative of the subject's activity, with day headers and event descriptions.
- **Tech:** Day-grouped event text generation

### Recent Activity List
- **Description:** Last 10 events for the subject, showing time, type, counterpart, and call type. Clicking an event navigates to that location on the map (if map is initialized).
- **Tech:** `rows.slice(-10).reverse()`, `mapInstance.setView([lat, lng], 13)`

### Overlay Helpers
- **Description:** Three overlay types for detailed drill-down: Session Records (full evidence chain with record table and evidence hash), Meeting Detail (time, tower, gap, score, evidence, events), Subject Records (last 50 records for a subject with pagination).
- **Tech:** `showSessionRecords()` builds session evidence overlay, `showMeetingOverlay()` builds meeting detail overlay, `showSubjectRecords()` builds subject records overlay, all use modal overlay pattern with close-on-background-click

---

## 10. AI Insights

### Proactive Findings-First Architecture
- **Description:** The AI Insights tab is an investigator-oriented intelligence workspace with 4 subtabs. Findings are generated automatically on load (analytics-first, LLM-last).
- **Tech:** `renderAiInsights()`, `invalidateAiCache()`, section builders called in fixed order, LLM consumes pre-computed analytics instead of inventing conclusions

### 4 Subtabs
- **Description:** Overview (case summary + subject summaries), Findings & Leads (AI findings, investigation leads, investigation questions), Deep Investigate (timeline narrative, report generator, full investigation command center), AI Chat (context chips, analysis modes, Q&A).
- **Tech:** `.ai-subtab` buttons with active underline, subtab content panels

### Analytics Cache
- **Description:** All pre-computed analytics (pair counts, daily activity per subject, service counts, all meetings, change profiles) are computed once per dataset and cached in `window._aiCache`. Cache is invalidated on data load (`loadCaseData()` calls `invalidateAiCache()`) and on each AI tab render. Prevents repeated O(n) dataset scans across 4 subtab sections.
- **Tech:** `getAiCache()` with lazy initialization, `window._aiCache` singleton, `invalidateAiCache()`, `changeCache` for pre-computed identity profiles

### Overview Section: Case Summary
- **Description:** Top-level text summarizing the entire case: scope (subjects × records), key communication link (highest-volume pair), meeting count, central communication hub (highest-degree subject), and a natural-language most-significant-finding statement.
- **Tech:** `buildCaseSummary()`, degree centrality computed from pair counts, auto-generated finding text

### Overview Section: Case Overview Cards
- **Description:** Eight stat cards showing: subjects, total records, sessions, meetings, SIM swaps, device changes, observation period (days), high-risk findings count.
- **Tech:** `buildCaseOverview()`, `getAiCache()` for pre-computed metrics

### Overview Section: Subject Summaries
- **Description:** Per-subject cards showing: contacts count, top service, night activity %, meetings count, SIM swaps, device changes, and a descriptive assessment using observed characteristics (e.g., "Night-dominant activity (74%) • SIM change detected") instead of risk labels.
- **Tech:** `buildSubjectSummaries()`, sorted by meeting count + night activity, `c.changeCache` for identity changes, `detectMeetings()` for co-location

### Findings & Leads: AI Findings with Confidence Breakdown
- **Description:** Auto-generated findings from communication volume, meeting detection, activity patterns, night activity, and tower movement. Each finding has a title, description, evidence list, and confidence breakdown showing base score plus individual components (same tower, time window, repeated encounters, movement similarity). Findings are displayed as expandable cards with useful/false-positive feedback buttons. Findings are categorized into severity tiers: HIGH (most contacted pair, probable meetings, activity spikes), MEDIUM (night-dominant subjects, heavy service usage), LOW (frequent tower transitions, dormant subjects).
- **Tech:** `buildAIFindings()`, `confidenceBreakdown()` with component scoring, `confidenceBreakdownRules` for explainable confidence, `markFinding()` for feedback tracking, severity-colored left borders

### Z-Score Activity Spike Detection
- **Description:** Replaces simplistic `count >= avg * 3` with statistical z-score analysis: minimum baseline of 5 days, minimum volume of 20 records, z-score threshold > 2.5. Reduces false positives from normal daily variation.
- **Tech:** `findSpikes()`, per-subject daily counts, z-score calculation against baseline mean/stddev

### Findings & Leads: Investigation Leads with Ranking
- **Description:** Generates prioritized investigation leads scored 0-100: most contacted subject (volume-based), meeting clusters (confidence-weighted), SIM swaps (70-85), device changes (60-78), night activity (40+%). Leads are sorted by score and color-coded (red ≥80, yellow ≥60, gray).
- **Tech:** `buildInvestigationLeads()`, `c.changeCache` for pre-computed identity changes, `c.allMeetings` for meeting data, score formula per lead type, score badges with action buttons

### Findings & Leads: Investigation Questions Engine
- **Description:** Generates investigative hypotheses from real data: activity spikes (z-score), identity changes (SIM/device), shared contacts without direct communication, new service adoption, and night activity patterns. Each question has an "Ask AI" button that sends the question as context.
- **Tech:** `buildInvestigationQuestions()`, `c.subDays` for spike data, `c.changeCache` for identity changes, shared-contact overlap detection, `chatWithContext()` integration

### Deep Investigate: Timeline Narrative with Event Compression
- **Description:** Day-grouped narrative for a selected subject. Consecutive same-type events (e.g., repeated WhatsApp sessions) are merged into blocks with `×N` count. Tower changes, sessions, and meetings are interleaved. Shows up to 7 days with the most detail. Subject selector dropdown to switch between subjects.
- **Tech:** `buildTimelineNarrative()`, `switchNarrativeSubject()`, `reconstructSessions()`, `detectMeetings()`, block-flush pattern for event compression

### Deep Investigate: Report Generator (5 Report Types)
- **Description:** Generates full digital forensics investigation reports. Selectable report types: Executive Summary, Subject Report, Communication Analysis, Location Analysis, Full Investigation Report. Supports three modes: TIFM Backend (server-side `/ai/generate-report`), Fine-tuned TIFM (via `/ai/chat`), and Legacy Ollama (local LLM via configured endpoint). Report is rendered as formatted markdown with Copy Report and Copy Data Package buttons.
- **Tech:** `generateAiReport(type)`, `fetch()` to Ollama API or backend endpoints, `renderMd()` markdown-to-HTML converter, `buildDataPackage()` for context

### Deep Investigate: Full Investigation Command Center (8 Modules)
- **Description:** Calls backend `POST /ai/investigate` and renders 8 investigation modules in a collapsible accordion layout:
  1. **Findings** — Severity-badged findings with category summary, top high-severity with show-more
  2. **Identity** — Burner detection, SIM/device swap tracking, burner scores, burner tags
  3. **Anomalies** — Anomalies grouped by type with severity badges, show-more expansion
  4. **Sessions** — Session counts, gaps >24h table, affected subjects with row warnings
  5. **Network** — Role distribution (Kingpin/Lieutenant/Member/Broker), centrality table, critical bridges, hierarchy visualization
  6. **Location** — Hotspots table, subjects by range radius, location entropy
  7. **Calls** — Signal calls, odd-hour calls, call bursts, calling circles (3-way mutual), suspicious calling patterns
  8. **Temporal** — Day-of-week breakdown, night-dominant subjects, activity trends
- **Tech:** `runFullInvestigation()`, `renderFindings()`/`renderIdentity()`/etc., `toggleInvestModule()` for collapsible headers, `_showMoreBtn` / `investToggleMore` for lazy rendering

### False-Positive Tracking
- **Description:** Every AI finding has "Useful" and "False Positive" buttons in its detail panel. Feedback is persisted to localStorage (survives page refresh) and keyed by a content hash of the finding's title+evidence, so finding reordering doesn't break alignment. Exportable as JSON via the "Export Feedback" button that appears in the Case Summary section once feedback is recorded.
- **Tech:** `findingHash()` uses djb2 hash of `title|evidence` to generate `'F' + Math.abs(hash).toString(36)` stable key (encodes Unicode safely, no btoa), `localStorage.setItem('fp_'+hash)`, `markFinding()` updates button states and persists, `exportFeedback()` collects all localStorage `fp_*` entries into downloadable JSON, restored on findings render via `localStorage.getItem`

### Data Package Builder (`buildDataPackage`)
- **Description:** Produces a compact text summary (~20 lines) containing: total records with CDR/IPDR breakdown, time period, entity count, top 8 services with counts, top 8 contacts, top 6 towers, top 6 links, direction percentages (in/out), average and max duration, peak hour, night activity percentage, top 5 protocols, and reconstructed session summaries (up to 20 entities).
- **Tech:** Client-side aggregation from `allRows`, `lines.push()` formatting

### LLM Configuration Inputs
- **Description:** Editable fields for the Ollama endpoint URL and model name. Save button stores configuration. Endpoint field is hidden for TIFM Backend mode, model field is shown only for Legacy Ollama mode. Three analysis modes: TIFM Backend (server-side `/ai/analyze`), Fine-tuned TIFM (calls `/ai/chat` with fine-tuned Qwen model), Legacy Ollama (local LLM via API).
- **Tech:** `<input>` elements, `D.aiEndpoint.value`, `D.aiModel.value`, mode selector radio buttons, mode-dependent field visibility

### AI Chat: Context Chips (7 types)
- **Description:** Toggle-able context chips that inject specific data into the AI prompt: Selected Subject, Timeline, Meetings, Service Attribution, Graph Analysis, Tower Data, Raw Records. Active chips are included in the system prompt sent with each query.
- **Tech:** `initContextChips()`, `getActiveContexts()` returns active chip values, `chatWithContext()` builds system prompt from active chips

### AI Chat: Context Buttons (5 presets)
- **Description:** Preset context buttons: Explain Subject, Explain Meeting, Explain Tower, Explain Cluster, Explain Session. Each sends a targeted query with relevant context data.
- **Tech:** `chatWithContext(action)` dispatches to specific context builders

### Investigator Notes & Follow-up Q&A (`analyzeWithAI`)
- **Description:** Textarea for entering observations, hunches, or specific questions. The data package is sent as context for the LLM to provide targeted answers. Supports 3 modes: TIFM Backend (calls `/ai/analyze` then optionally sends to LLM), Fine-tuned TIFM (calls `/ai/chat`), Legacy Ollama (direct to local LLM).
- **Tech:** `analyzeWithAI()`, prompt that includes data package + investigator notes, mode-dependent API routing

### Context Chips (Data Injection)
- **Description:** Pre-built clickable context chips (Case Overview, Top Links, Activity Spikes, SIM/Device Changes, Night Activity) that inject specific data into the AI Chat input to guide the LLM's analysis.
- **Tech:** `initContextChips()`, `chatWithContext()` builds system prompt from active chip data

### Markdown-to-HTML Renderer (`renderMd`)
- **Description:** Converts raw markdown text to HTML for display in the report and response areas. Supports: headings (h1-h6), bold, italic, bold+italic, inline code, code blocks, links (target="_blank"), tables (basic), ordered and unordered lists, blockquotes, horizontal rules, paragraph wrapping.
- **Tech:** Regex-based replacement pipeline, HTML `<p>` wrapper, `<table>` auto-grouping, `<blockquote>` consolidation

### Copy Report / Copy Data Package
- **Description:** Buttons to copy the generated report text or the data package summary to the clipboard.
- **Tech:** `navigator.clipboard.writeText()`

### Session Records Overlay
- **Description:** Full-screen overlay showing session evidence chain, record table, and evidence integrity hash (EVID-XXXXXXXX). Accessible via "View Records" button in Gantt tooltips.
- **Tech:** `showSessionRecords(sessionData)`, builds table of records with evidence hash

### Meeting Detail Overlay
- **Description:** Meeting detail overlay with time, tower, gap, score, evidence, and event list. Accessible via "View" button in subject profile co-location section.
- **Tech:** `showMeetingOverlay(key, idx)`, meeting data from `detectMeetings()` results

### Subject Records Overlay
- **Description:** Shows the last 50 records for a subject in a paginated overlay. Accessible from subject profile.
- **Tech:** `showSubjectRecords(sub)`, builds scrollable record listing

### Meeting Detection Engine (server-side, exact)
- **Description:** Co-location ("meeting") detection — two phones at the **same tower within a time window** — runs **entirely server-side** (`/investigation/meetings`) via a time-sorted sweep with an early break once the window is exceeded (~O(n·window-density)), so it is **exact and full-coverage** over the whole case and scales to large data. Case-scoped and subject-filterable; CDR-only (a meeting is two people physically co-located, so IPDR endpoints are excluded). Returns per-encounter rows (tower, coords, both times, gap, confidence) plus exact `total` / `distinct_pairs` / `high` / `medium` / `low` counts. Confidence: High < 5 min, Medium < 15 min, Low < window (default 60 min). **Every** consumer now reads this: the whole case's meetings are fetched **once** into a client cache on case open (`ensureMeetingsLoaded`, preloaded in `loadCaseData`), and `detectMeetings()` is a thin **synchronous filter** over that cache (by subject, by a specific pair, or all) — so the Map "Meetings" mode, Dashboard card, subject profile, correlation A/B, AI-tab summaries and the generated reports all show the same exact server result. Count usages use the exact totals via `meetingTotals()`. The former client-side O(n²) scan that only sampled the top-30 subjects — and its LCS movement-similarity (`towerSequenceSimilarity`) — have been **removed**.
- **Tech:** server `find_meetings(db, case_id, subject, window_min, limit)` sweep-line + `GET /investigation/meetings`; client `ensureMeetingsLoaded()` cache (`_meetings`), `detectMeetings(opts)` sync filter, `meetingTotals()`

---

## 11. Identity Resolution

### Chronological Identity State Tracking
- **Description:** Tracks a chronological sequence of (IMEI, IMSI) states for each subject, including re-appearances. Unlike a simple deduplicated pair list, this captures A→B→A transitions where a subject returns to a previously used identity pair. Each state records firstSeen, lastSeen, record count, and associated MSISDNs.
- **Tech:** `buildIdentityProfile()`, `timeline` array pushed on every IMEI/IMSI change from previous row, `seen` Map for deduplicated public API

### Change Detection (5 Transition Types)
- **Description:** Detects five types of identity transitions between consecutive states: SIM Swap (same IMEI, different IMSI), Device Change (same IMSI, different IMEI), Combined Change (both change simultaneously), Partial Device Change (IMEI only, no IMSI context), Partial SIM Swap (IMSI only, no IMEI context). Each change is timestamped with the firstSeen time of the new state and has a confidence label (high/medium).
- **Tech:** Consecutive-state comparison loop, `p.imei/c.imei/p.imsi/c.imsi` null-safe equality checks, `changes.push()` with type/from/to/confidence

### Identity Test Suite
- **Description:** 38 assertions across 12 test scenarios in `tests/identity.test.js`: A→B→A re-appearance, SIM swap, device change, combined change, partial changes, no-change record aggregation, empty input, single record, complex A→B→C→A, sequential SIM-then-device change, MSISDN accumulation.
- **Tech:** Node.js standalone test, extracted function from `app.js`, `assert()` helper, `process.exit(failed ? 1 : 0)`

### Cross-Case Subject/Suspect Linking
- **Description:** Suspects reoffend, but every other view in ARGUS is single-case scoped, so a subject's history in *other* cases was invisible. Cross-case linking detects when a subject in the current case (or the handset/SIM behind it, or its IP) also appears in **previously loaded cases**, so the LEA sees prior history the moment a case is opened.
  - **Match rule (high-confidence):** a phone subject is linked by its **number** *and* by shared **IMEI** (handset) and **IMSI** (SIM) — so a suspect who swaps SIMs but keeps the phone (or swaps phones but keeps the SIM) is still caught. Number/device matches are flagged **high** confidence.
  - **IP matches (low-confidence):** IP subjects are linked by source/destination IP but flagged **low** confidence with a "dynamic IP — verify the timeframe" caveat, because ISPs reassign addresses over time.
  - **CDR/IPDR separation preserved:** this is an **identity/intelligence** lookup, *not* analytic attribution. A phone subject may legitimately match IPDR rows in another case via its IMEI/IMSI/MSISDN (same handset did data sessions there) — surfaced as a typed device hit, never merged into the phone's analytics. Phone identifiers never match an IP row and vice-versa.
  - **Three surfaces:** (1) a **dashboard "Cross-case hits" panel** listing this case's subjects that recur elsewhere — naming the **actual other cases** (e.g. "also in CASE_1, CS2"), sorted by other-case count, each opening the subject profile; (2) a **profile-modal panel** ("Also seen in N other cases") with one clickable chip per case showing match type, confidence, record count and date span — clicking jumps to that case and reopens the subject there; (3) a dedicated **Cross-Case tab** (see below) with the full dossier.
- **Cross-Case Tab (full dossier):** A dedicated tab giving the complete cross-reference of the current case against **all** other loaded cases: a headline summary (recurring subjects, linked cases, high/low-confidence counts, strongest-link-per-subject mix, total subject↔case link pairs), a **per-linked-case rollup** (each other case with its shared subjects, match-type badges, confidence, role and record counts), and a **per-recurring-subject** expandable list. Each match carries an **activity summary of what the subject was doing in that case** — for phones: voice/SMS split, distinct contacts (+top 3), towers (+top 3), data-session count and peak hour; for IPs: protocol mix, top destination IPs, data volume (↑/↓) and tower count. Every subject opens its profile; every case chip jumps to that case (optionally landing on the subject). Match types are colour-badged (number / IMEI / IMSI / IP). Refresh button recomputes.
- **Cross-Case Link Graph (Graph view):** A **List / Graph** toggle in the Cross-Case tab adds a D3 force-directed view of **recurring subjects bridging cases**: case nodes (rounded squares — the current case highlighted) and subject nodes (circles coloured by confidence, green=high / amber=low, sized by how many cases they touch), with an edge from each subject to **every case it appears in** (including the current case). Edges are coloured by confidence and dashed for low-confidence IP links. Hovering a node shows detail (case → shared-subject count; subject → match type, confidence, other-case count); clicking a **case** node jumps into that case, clicking a **subject** opens its profile. Zoom/pan/drag, reusing the Network Graph's D3 scaffolding.
- **Tech:** Server-side `backend/app/services/cross_case_service.py` (`subject_cross_case`, `case_cross_case_overview`, `case_cross_case_report`, `case_cross_case_graph`) — set-based, index-backed, chunked `IN()` lookups over the per-column identity indexes (`msisdn`/`imei`/`imsi`/`a_party_number`/`source_ip`), no full-case load; the graph builder reshapes the report into nodes/edges. Endpoints `GET /cross-case/subject`, `GET /cross-case/overview`, `GET /cross-case/report`, `GET /cross-case/graph`. Frontend `renderCrossCaseHits()`, `fillProfileCrossCase()`, `renderCrossCaseTab()`/`renderCrossCaseReport()`, `renderCrossCaseGraph()`/`setXcView()`, `openInCase()`; `.case-link` / `.xcase-*` / `.xc-*` / `.xc-graph-*` styles reuse the `twr()` chip + `renderGraph()` D3 patterns. Tested in `backend/tests/test_cross_case.py` (number + SIM-swap-by-IMEI links, isolated-subject negative, IP low-confidence, CDR/IPDR separation, overview counts, report aggregation/rollups, graph subjects-bridge-cases + low-confidence edges + empty-case).

---

## 12. Session Reconstruction & Service Classification

### Client-Side Session Reconstruction (`reconstructSessions`)
- **Description:** Groups an entity's IPDR records into sessions using **concurrent activity tracks**: records are bucketed by `(counterpart IP, activity family)` so simultaneous conversations (e.g. background DNS while in a WhatsApp call) form coherent parallel sessions instead of fragmenting when records interleave. Each track is split on a **family-adaptive idle gap** rather than one fixed threshold — DNS 60s, Web 300s, RTC/VoIP 1200s, VPN/Remote/P2P 1800s, Transfer 600s — so chatty/streaming flows tolerate long pauses while lookups stay bursty. Produces session objects (start, end, duration, record count) sorted chronologically, each classified by `classifySession()`.
- **Tech:** `PORT_FAMILY` map, `FAMILY_GAP` thresholds, `recPortFamily(r)`, per-key open-track accumulator keyed by `peer|family`, replaces the old fixed-180s/counterpart/protocol-change splitter. Mirrored server-side by `reconstruct_ipdr_sessions()` in `investigation_service.py`.

### Client-Side Session Classification (`classifySession`)
- **Description:** Scores each reconstructed session using a multi-level service attribution engine. Phase 1 checks IP infrastructure against 40+ provider database with AS numbers, domains, and IP CIDR ranges. Scores providers on: base + port match (+15), protocol match (+10), activity category match (+10), duration bonuses, data volume bonuses, distinctive indicators (+15, e.g. WhatsApp UDP 3478-3480 from Meta IPs), VPN penalty (-25), infrastructure penalty (0.6x). Phase 2 falls back to port-only matching. Selected service is sorted into confidence tiers: Tier 1 (Infrastructure), Tier 2 (Likely service), Tier 3 (Possible service), Tier 4 (Multi/Unknown). Best match wins, capped at 95% confidence.
- **Tech:** `scoreProvider()` scoring function, `pickBest()` tier selector, `matchService()` pipeline, `SERVICE_DB` with 40+ providers and IP/AS/domain metadata, `IP_RANGES` parsed CIDR ranges, `KNOWN_IP_HINTS` for well-known IPs (8.8.8.0/24, 1.1.1.0/24), `ipInRange()` / `ipHint()` for fast IP lookup, `trafficPattern()` behavioral classification. Port matching ignores an **ephemeral source port** (≥ `EPHEMERAL_MIN` = 49152) when a destination port exists, so a connection's own short-lived port can't be mistaken for the service. Port 853 (DNS-over-TLS) is classified rather than treated as generic encrypted traffic.

### Behavioral Traffic Classification (`trafficPattern`)
- **Description:** Classifies IPDR network behavior into 14+ categories with confidence deltas and evidence: VPN/Encrypted Tunnel (VPN ports + persistent UDP/TCP + duration >30s), Remote Desktop (RDP/VNC ports + TCP), File Transfer (FTP/SMB ports + bidirectional data), Cloud Sync (TCP + persistent + bidirectional + moderate data), Screen Sharing (UDP + sustained + moderate data), Video Call (UDP + high volume + long duration + symmetric), Voice Call (UDP + symmetric + moderate duration + VoIP ports), Streaming (TCP + download-heavy + long duration), Conference (UDP + long duration + moderate data), Media Upload (upload-heavy ratio > 0.7), Messaging (short burst + small data + UDP), Browsing/Interactive (TCP + short duration + moderate data), Presence/Keep-alive (minimal traffic + very short duration), Network Traffic (default fallback). Supports time-of-day enhancement for late-night / business hours annotations.
- **Tech:** `trafficPattern(dur, up, dwn, protocol, portSet, recCount, hour)`, category-specific rules, evidence text generation. The VoIP/media port set used for Voice/Video detection covers real RTP/STUN ports only (3478-3481, 16384/16387, 19302-19305, 8801/8810, 5004) — spurious entries (9000, 45000, 65535) were removed to avoid false Voice/Video classification.

### Service Provider Knowledge Base (60+ Providers)
- **Description:** Hard-coded database of 60+ internet service providers with AS numbers, domains, IP CIDR ranges, and detailed service metadata. Covers: Meta (WhatsApp, Instagram, Facebook/Messenger, Threads), Google (Search, Gmail, YouTube, Meet, Drive, DNS, Pay, Gemini), Microsoft (Teams, Outlook, OneDrive, Skype, Xbox, LinkedIn), Amazon (AWS, Prime Video, Pay), Cloudflare CDN, Akamai CDN, Fastly CDN, Oracle Cloud, DigitalOcean, OVH, Telegram, Signal, Discord, Zoom, Cisco Webex, Slack, Apple (iMessage, FaceTime, iCloud, Push), Snapchat, X/Twitter, Reddit, Netflix, Spotify, Valve Steam, Riot Games, Epic Games, GitHub, GitLab, Docker Hub, OpenAI (ChatGPT, API), Anthropic Claude, Perplexity, Proton (VPN, Mail), NordVPN, ExpressVPN, Mullvad, Surfshark, Quad9 DNS, OpenDNS, Yahoo Mail, Dropbox, Mega, PayPal, PhonePe, Paytm, Flipkart, Myntra, Disney+, Blizzard Battle.net, Sony PlayStation Network, Yandex (Search, Mail), Alibaba Cloud, Hetzner, Vultr, Tor.
- **Indian telecom access networks:** Reliance Jio (AS55836), Bharti Airtel (AS9498), Vodafone Idea/Vi (AS55410), and BSNL (AS9829) are included with their major announced IPv4 aggregates. These are flagged `isp:true` and treated as **access-network identification** (carrier the subject is on / contacted), labeled `"<Carrier> (Access Network)"` at low confidence — they never override a real content-provider match. Note: only the matcher's `ranges` field drives IP attribution; `asn`/`domains` are documentation. Consumer apps served purely over HTTPS from shared CDNs (most Indian e-commerce/streaming/fintech) cannot be IP-attributed and are intentionally not padded into the DB.
- **Tech:** `SERVICE_DB` constant object in `app.js`, each entry with `asn`, `domains`, `ranges` (CIDR), optional `isp` flag, and a `services` array (name, ports, protocols, activities). `ISP_PROVIDERS` / `isIspProvider()` gate access-network handling; `matchService()` prefers a non-ISP counterpart-IP match before falling back to the subject's (carrier) IP.

### Distinctive Indicators
- **Description:** Multi-factor signatures that add confidence (+15) when port+protocol+provider combinations match: WhatsApp (UDP + ports 3478-3480 from Meta IPs), Telegram (provider match), Google Meet (UDP + 19302-19305 from Google), MS Teams (UDP + 3478-3481 from Microsoft), Zoom (UDP + 8801-8810 from Zoom), FaceTime (UDP + 16384-16387/3497 from Apple), Steam (27000-27100/27015-27050 from Valve), NordVPN (UDP + port 1194), Mullvad (UDP + port 51820).
- **Tech:** Hard-coded indicator rules in `scoreProvider()`, checked when provider matches

### Unified Attribution Knowledge Base (single source of truth)
- **Description:** Both engines — the backend `service_attribution_service.py` and the frontend `app.js` — now read their provider IP ranges, port→family map, session gap thresholds, port-name lookup, and constants (ephemeral-port floor, CGNAT block, hosting providers, generic web families) from **one canonical file**, `backend/app/data/attribution_data.json`. This eliminates the drift that previously caused duplicate-key and divergent-range bugs: edit the JSON once and both engines stay consistent. The backend loads the JSON directly; the frontend consumes a generated `static/attribution_data.js` (global `ATTR_DATA`) so it stays synchronous with no runtime fetch. Note: this unifies the shared *data*; each engine keeps its own scoring algorithm (the frontend's tiered `scoreProvider`/`pickBest` vs the backend's combiner).
- **Tech:** `attribution_data.json` (62 providers, 83 CIDR ranges, 53 port-families, 40 port names, constants), `scripts/gen_attribution_js.py` regenerates the frontend copy, `scripts/extract_attribution_data.js` was the one-time bootstrap from the old hardcoded tables; backend `_load_attribution_data()` builds `PROVIDER_RANGES`/`PORT_FAMILY_MAP`/`FAMILY_GAP_MAP`/`EPHEMERAL_MIN`/`_CGNAT_NET`/`_HOSTING_PROVIDERS`/`_GENERIC_PORT_FAMILIES`; frontend `SERVICE_DB`/`PORT_SVC`/`PORT_FAMILY`/`FAMILY_GAP`/`EPHEMERAL_MIN`/`HOSTING_PROVIDERS` all reference `ATTR_DATA`; `index.html` loads `attribution_data.js` before `app.js`

### Session Evidence Integrity Hashing
- **Description:** Generates EVID-XXXXXXXX hash from service label + evidence + duration + records for session integrity verification.
- **Tech:** `evidenceHash(sessionData)`, simple hash algorithm, displayed in Gantt tooltip "View Records" overlay

### Service Signature Knowledge Base (26 signatures)
- **Description:** 26 entries across 16 service families: WhatsApp (Call, Call Init, Messaging, Media), Telegram (Messaging, Voice Call), Signal (Messaging, Voice Call), Instagram (Messaging, Voice/Video Call), Facebook/Messenger (Messaging, Voice Call), Discord (Messaging, Voice Channel), Google Meet, Zoom, MS Teams, Skype (Voice Call, Messaging), Snapchat, YouTube, Netflix, Google, Apple, Amazon, Cloudflare. Each entry has ports, protocol, duration thresholds, and evidence text.
- **Tech:** `SERVICE_SIGS` constant array in `app.js` (legacy, superseded by `SERVICE_DB` for most lookups)

### Service Color Map (100+ service families)
- **Description:** Distinct colors for 100+ service families/entities used consistently across Gantt bars, service badges, and visual indicators. Falls back to a hash-based color for unknown services.
- **Tech:** `SVC_COLORS` object, `svcColor(s)` lookup function with fallback

### Backend Two-Layer Service Attribution (`service_attribution_service.py`)
- **Description:** Server-side classification of IPDR records combining an **IP-range / provider layer** (Level 1) with a **port layer** (Level 2), mirroring the frontend engine so the timelines and `/investigation/services` get the same quality of attribution. For each record the destination and source IPs are checked against a provider CIDR table; a content-provider match (Meta, Google, Microsoft, Cloudflare, Apple, Telegram, Yandex, Alibaba Cloud, Hetzner, Vultr, …) names the service directly with confidence scaled by CIDR specificity (78–90%). If only an Indian carrier (Reliance Jio / Bharti Airtel / Vodafone Idea / BSNL) matches, the record keeps a *specific* port-mapped service (DNS, mail, VPN, …) annotated with the carrier, and otherwise is labeled `"<Carrier> (Access Network)"` at low confidence — a carrier match never overrides a real content-provider match (counterpart IP is preferred over the subject's own/carrier IP).
- **Longest-prefix match:** `_match_ip()` returns the *most specific* CIDR containing an address (largest prefix length wins), so a tight block beats a broad one and overlaps resolve correctly. The frontend `ipInRange()` does the same (most 1-bits in the mask wins).
- **Indexed lookup (scales to live feeds):** IPv4 ranges are indexed by first octet into `_V4_BUCKETS` (a /8-or-longer prefix lives entirely in one /8), with rare `<8` prefixes in `_V4_BROAD` and IPv6 in `_V6_NETS`; each entry carries precomputed integer `(lo, hi)` bounds so a lookup is an integer-compare over a few dozen candidates instead of a linear scan over all ~2,000 ranges. Measured: full attribute + summarize + timeline reconstruction over **100,000 IPDR rows in ~5s** (was ~205s with the naive scan once the live feeds are loaded) — ~14 µs/row, linear in row count. A `test_index_matches_bruteforce_lpm` parity test guards that the index returns exactly what a linear scan would.
- **Categories & deterministic flags:** every result now carries a `category` — `content`, `hosting` (Alibaba/Hetzner/Vultr/DigitalOcean → "possible VPN/proxy/self-hosted endpoint"), `access_network`, `vpn` (VPN/Tunnel ports), `anonymization` (Tor/proxy ports), `internal`, `service`, or `unknown`. A private/CGNAT/loopback/link-local **destination** is detected deterministically (`_ip_kind()`, RFC 6598 `100.64.0.0/10` + RFC 1918) and labeled "Carrier NAT (CGNAT)" / "Private / Internal Network" instead of being guessed as an internet service.
- **Pluggable ASN/CIDR loader:** `_load_external_ranges()` optionally reads `backend/data/asn_ranges.csv` (or `ASN_RANGES_CSV` env path) with columns `network,provider,is_isp` — a drop-in for MaxMind GeoLite2-ASN / IPinfo data that extends coverage to every ASN with no code change (merged by longest-prefix specificity).
- **Official provider IP-feed fetcher:** `scripts/fetch_provider_ranges.py` pulls each provider's own published range feed — AWS (`ip-ranges.json`), Google (`goog.json`), Cloudflare (`/ips-v4`), Fastly (`public-ip-list`), GitHub (`/meta`, user-facing keys only, excluding Azure-hosted Actions runners) — collapses them to a minimal CIDR set with `ipaddress.collapse_addresses`, and writes the gitignored `data/asn_ranges.csv` the loader above already merges. ~2,000 fresh CIDRs (AWS ~1,776) supersede the curated `/8` summaries by longest-prefix at runtime; `--update-json` folds small providers back into the canonical JSON. Stdlib-only, best-effort per feed, certifi-aware TLS with an `--insecure` fallback. Run on a schedule to kill range staleness. Covered by `tests/test_provider_ranges.py`.
- **Tech:** `PROVIDER_RANGES` table parsed via `ipaddress` into `_PROVIDER_NETS`, `_match_ip()` (LPM) / `_classify_by_ip()` (content-provider-before-ISP, destination-before-source), `_merge_provider()`, `_access_network_result()`, `_private_result()`, `_ip_kind()`, `_category_for()`, `_GENERIC_PORT_FAMILIES` guard, `_load_external_ranges()`, orchestrated by `attribute_service()`

### Backend Port-to-Service Attribution (`_classify_by_port`)
- **Description:** The port layer (Level 2) maps 250+ exact ports plus 12 port ranges to service families (DNS, Web, WhatsApp, VPN, VoIP, Mail, Database, Remote Desktop, File Transfer, IoT, etc.), with confidence from port, protocol alignment, and data-transfer volume. The destination port is inspected before the source port (the destination is the well-known service port on an outbound session). Matches on an **ephemeral source port** (49152–65535) are demoted when a stronger non-ephemeral match exists, and marked low-confidence when they are the only signal — preventing a coincidental source port (e.g. 50005) from being misread as MS Teams/Discord. Each result returns `service`, `subtype`, `confidence`, `family`, `port`, and an `evidence` list.
- **Tech:** `PORT_MAP` dictionary, `PORT_RANGES` bands, `EPHEMERAL_MIN` guard, `_classify_whatsapp()` / `_classify_generic()` specialized classifiers, `_classify_by_port()` → `_public()` result builder

### Backend Service Summary (`summarize_services`)
- **Description:** Aggregates service classifications across all IPDR records, returning per service: record count, the **highest-confidence** classification as the representative example (evidence/subtype/family), and total bytes transferred. Using the most-confident example avoids reporting whichever record happened to be processed first.
- **Tech:** `Counter` for counts and `total_bytes`, `attribute_service()`, max-confidence `best_example` selection, `_record_bytes()` helper, `most_common()` sorting

### Port Service Lookup Map (30+ ports)
- **Description:** Frontend port-to-name lookup covering 30+ well-known ports: FTP, SSH, SMTP, DNS, DHCP, HTTP, HTTPS, POP3, IMAP, LDAP, SMB, RDP, MySQL, PostgreSQL, Redis, MongoDB, and more.
- **Tech:** `PORT_SVC` constant object in `app.js`, `portSvc()` function

### Spatiotemporal + Network Analytics Engine (`inference_service.py`, `geo.py`, `graph_service.py`)
- **Description:** Builds a **per-subject, movement-annotated unified timeline** — each subject's calls, SMS and data sessions merged chronologically and keyed by msisdn — then derives investigative inferences. **CDR and IPDR are kept strictly separate**: a CDR subject is a phone number, an IPDR subject is an IP address, and no analytic ever joins the two (enforced by a unit + live leaderboard-disjointness test). All output is **case-scoped** and carries an explicit `evidence`/`factors` breakdown — no bare numbers.
  - **(A) Movement:** distance/Δt/implied-speed between consecutive located events, **travel-mode banding** (stationary → walking → road → rail → air → impossible), **impossible-travel** flags (>900 km/h over ≥5 km), **home/work anchors** (a time-of-day heuristic over the subject's located events: **home** = the most-frequented tower during **night hours, 22:00–05:59**; **work** = the most-frequented tower during **weekday daytime, 09:00–17:59 Mon–Fri**. Evenings 18:00–21:59 and all of the weekend are deliberately excluded so commute/leisure cells can't skew either anchor; each anchor reports its tower id, coordinates and supporting event count, and either can be `null` when there's no activity in that window), and now **tower dwell** (time per cell), a **mobility class** (stationary → highly-mobile), and **shared travel routes** (pairs traversing the same ordered tower sequence — the path analogue of point co-presence).
  - **(B) Co-presence:** two subjects at the same tower (or within 1.5 km) inside a 20-min window — **convoy** (repeated across ≥2 days) and **"met but never called" hidden links**.
  - **(B2) Call-graph structure:** **brokers** (high betweenness, sampled on large graphs), **articulation points** (cut-vertices), **reciprocity** (one-way vs mutual, via a/b-party ordering), **relay chains** (A→B→C within 15 min), and **predicted hidden links** (Adamic-Adar over shared-contact candidates, hubs down-weighted).
  - **(C) Behavioral:** activity **bursts** (daily z-score), **odd-hours** share, **periodic-contact** cadence, plus a per-subject **baseline** and the **shifts** measured against it — **escalation** (sustained rise via median halves, so a lone spike can't fake a trend), **dormancy → reactivation**, and **newest first-contacts**.
  - **(D) Identity/device:** **SIM swap/clone**, **burner** handsets, **clone corroboration**, and **multi-SIM entity resolution** (numbers grouped into one likely actor via shared handsets, transitively; confidence-scored; CDR-only).
  - **(E) IPDR (IP subjects):** **VPN/proxy** (tunnel/Tor ports + provider of the destination), **data volume & exfiltration** (asymmetric upload, byte-coverage reported), **beaconing** (regular low-jitter cadence to one destination; only non-web-port beacons feed risk to avoid benign-sync false positives), and **rare destinations** (a unique endpoint hit ≥3 times).
  - **Composite risk scoring:** all of the above roll into a transparent **0–100 per-subject score** with banding, de-duplicated correlated signals (cloned-SIM > impossible-travel > multi-handset; broker > cut-point) and a low-evidence cap. CDR and IPDR produce **two independent leaderboards**.
  - **Watchlist & export:** an investigator watchlist forces matching subjects to **Critical**; the whole report exports as a **Markdown case summary**.
- **False-positive controls:** thresholds are tuned to stay silent on data lacking real patterns — rare-destination requires repeat visits to a unique endpoint, beaconing on web ports is shown-but-not-scored, relay uses a tight 15-min window, shared-routes require ≥3 ordered tower-triples, escalation uses robust medians, and thin-evidence subjects are capped.
- **Honest limits (documented in code):** tower coordinates approximate handset location and start times are minute-resolution, so speeds/dwell are area-to-area estimates; every inference is a graded lead, not proof.
- **Endpoints:** `GET /inference/report` (full report incl. risk leaderboards, network, temporal, IPDR analytics, entities, watchlist hits), `GET /inference/report.md` (downloadable Markdown summary), `GET /inference/subject/{subject}` (one subject's timeline + baseline/escalation/dormancy), and `GET|POST|DELETE /watchlist`.
- **Tech:** `build_subject_streams()`/`annotate_movement()` foundation; `subject_movement()`, `infer_anchors()`, `impossible_travel()`, `co_presence()`, `network_structure()`, `tower_dwell()`, `mobility_class()`, `shared_routes()`, `activity_bursts()`, `odd_hours_profile()`, `periodic_contacts()`, `subject_baseline()`, `escalation()`, `dormancy_reactivation()`, `first_contacts()`, `vpn_proxy_use()`, `ipdr_volume()`, `beaconing()`, `destination_profile()`, `device_anomalies()`, `clone_corroboration()`, `resolve_entities()`, `risk_scores()`, `apply_watchlist()`, `report_markdown()`, orchestrated by `run_all()`; `geo.haversine_km()`/`classify_speed()`; NetworkX for the graph measures. Covered by `tests/test_inference.py` (98 tests).
- **Map (Tower Map tab):** Movement-Path legs render as per-segment polylines **colour-graded by travel mode** (stationary/walking/road/rail/air/impossible) with a sticky hover tooltip (mode badge, distance, time gap, estimated speed, from→to towers and times via `segMetrics()` / `travelMode()`). **Direction arrows** (rotated to each leg's bearing) show travel direction; **start/end and numbered stop markers** mark the sequence; consecutive same-tower records are detected as **dwell/stays** (dotted, "stayed Xh") rather than fake movement; a **mode legend** and a clickable **Travel Legs** list (zoom-to-leg) sit in the sidebar alongside fastest-leg and impossible-leg counts. Three inference overlays in the mode dropdown — Impossible Travel, Co-presence/Convoy, Anchors (Home/Work) — plus an interactive **Geofence** (`analyzeGeofence()` with turf point-in-polygon) that lists and highlights the subjects/records inside a drawn area.

---

## 13. Services Tab

### Service Evidence Scorecards
- **Description:** For each detected service, a full evidence scorecard with 6 checks: IP match (provider IP range matched), Port/protocol alignment (ports + protocol match service definition), Distinctive indicators (multi-factor service-specific signature), Session pattern (duration, volume, behavior matches expected), Multiple subjects (service observed across multiple subjects), Clear attribution (no conflicting evidence). Each check is shown as a green check or red X with descriptive text.
- **Tech:** `renderServiceCard(svc)`, 6-criteria evidence analysis from session classification data

### Service Cards
- **Description:** Expandable cards for each detected service showing: evidence scorecard, alternative services (ranked bar chart with color-coded confidence bars), subject list using the service, tower list where service was detected, contact list communicating via the service, recent sessions (with Gantt-style bar and evidence tree).
- **Tech:** `renderServiceCard(svc)`, `classifySession()` for session classification, service color indicators

### Burst Detection
- **Description:** Detects per-subject daily activity spikes (>3x average, minimum 10 records) for each service. Listed in the Burst section with subject ID, date, count, and average comparison.
- **Tech:** `renderServiceBursts()`, daily per-subject frequency counting, threshold comparison

### Filtering
- **Description:** Name search filter for services and minimum confidence threshold selector (0-95%). Service list updates in real-time.
- **Tech:** Text input for name filter, range selector for confidence, `.filter()` on service data

---

## 14. Correlation Tab

### Cross-Subject Analysis
- **Description:** Select two subjects (A and B) for detailed correlation analysis. Compare button triggers computation. Results include: weighted correlation score (contact overlap=5pts, service overlap=2pts, tower overlap=1pt, session overlap=4pts), meeting detection between the pair, common towers, common contacts, common services, service comparison grid, and overlapping time windows.
- **Tech:** `runCorrelation()`, `Set` intersection for common entities, weighted score formula, `detectMeetings()` for A/B pair, `D.corrResults` display

### Swap Button
- **Description:** Swaps subjects A and B in the correlation interface for quick re-analysis.
- **Tech:** `D.corrSubA.value ↔ D.corrSubB.value`, `runCorrelation()`

---

## 15. Backend Services

### TIFM Multi-Agent AI Backend
- **Description:** 5 specialized agents in `app/ai/agents.py`: ServiceAttributionAgent (maps ports to apps via knowledge_base.json), IdentityAgent (SIM swaps, device changes, burner detection), MovementAgent (home/work tower classification, meeting detection via co-location), NetworkAgent (NetworkX centrality, communities, kingpin identification), ReportAgent (generates markdown forensics report). Orchestrated by `TelecomIntelligenceOrchestrator` in `orchestrator.py`.
- **Tech:** `agents.py` (374 lines), `orchestrator.py` (57 lines), `knowledge_base.json` (17 application entries, 187 lines)

### PoliceInvestigator (12-Module Analysis)
- **Description:** Comprehensive `PoliceInvestigator` in `investigator.py` with 12 analysis modules: SessionAnalyzer, CommunicationPatternAnalyzer, TemporalAnalyzer, LocationIntelligenceAnalyzer, SocialNetworkAnalyzer (k-core, triads, bridges, PageRank, clustering), IdentityDeepAnalyzer (SIM/device/burner/cycling/multi-SIM), AnomalyDetector (activity, contact, time-of-day, duration shifts), GapAnalyzer (network silence periods), CallDetailAnalyzer (short calls, odd hours, burst patterns).
- **Tech:** `investigator.py` (~1300 lines), invoked via `POST /ai/investigate`, `renderInvestModules()` frontend

### QLoRA Fine-Tuning Pipeline
- **Description:** 15-type Q&A training data generator (`training_data.py`, 930 lines, 200 examples/type → 3218 total), fine-tuning scaffold (`finetune_scaffold.py`), local training script (`train_qwen_tifm.py`), unified pipeline (`pipeline_tifm_finetune.py`), and inference engine (`inference.py`) for Qwen2.5-3B-Instruct with 4-bit LoRA adapters. Cloud training notebooks: `tifm_kaggle_train.ipynb`, `tifm_colab_train.ipynb`.
- **Tech:** transformers, peft, bitsandbytes, trl, SFTTrainer, QLoRA 4-bit, LoRA adapters saved to `tifm_lora_output/`

### Fine-Tuned Inference (`/ai/chat`)
- **Description:** Single-pass fine-tuned Qwen2.5-3B-Instruct inference. Loads LoRA adapter from `tifm_lora_output/`, accepts investigator question + trimmed analytics (2000 chars), returns evidence-grounded answer. Configurable via `POST /ai/chat`.
- **Tech:** `inference.py`, `generate_answer()`, `load_model()` (4-bit QLoRA), `unload_model()` for memory management

### Synthetic Data Generation
- **Description:** Generates synthetic CDR/IPDR/tower records for 5 investigation scenarios (criminal, drug, scam, human_trafficking, financial_fraud). Used for testing TIFM agents and fine-tuning pipeline.
- **Tech:** `dataset_generator.py`, `generate_synthetic_case()`, seeded with `random.seed(42)`, output format matching real CDR/IPDR schema

### Record Querying with Dynamic Filters (`records_service.py`)
- **Description:** Flexible query builder for CDR and IPDR records supporting: date range, tower ID, MSISDN, IMSI, IMEI, call type, direction, protocol, APN, RAT, free-text search (across 7-9 fields), limit, and offset. Also a **unified paginated page** across both tables: `page_records()` does a time-ordered `UNION ALL` (on a lightweight id/rtype/start_time projection, then hydrates rows) with `total`/`distinct_pairs` counts, plus `distinct_services()` for the service filter — the server-side, fetch-on-demand path for very large cases.
- **Tech:** SQLAlchemy `query.filter()` chaining, `or_()` multi-field `.ilike()` search, `union_all()` + `select()` + `func.count()`; endpoints `GET /records/page`, `GET /records/services`

### Scalability Indexes & Bounded Analytics
- **Description:** For 50k–500k-record cases: **composite indexes** `(case_id, start_time)`, `(case_id, tower_id)`, `(case_id, a_party_number/source_ip)` on both tables keep case-scoped, time-ordered, filtered scans fast; they're created idempotently on startup for existing databases. Heavy analytics are moved to the server and made full-coverage-but-bounded — the network graph returns a top-N subgraph with exact node weights, meeting detection is an exact server-side sweep, and graph betweenness samples above 800 nodes. The map subject picker lists only **located parties** (CDR a-party + msisdn, IPDR source_ip) — never the remote endpoint it contacted (e.g. a DNS/CDN server like `1.1.1.1`), so every map mode resolves.
- **Tech:** `Index()` in `cdr.py`/`ipdr.py` `__table_args__` + `_ensure_indexes()` `CREATE INDEX IF NOT EXISTS` on startup; `get_subjects()` located-party filter

### NetworkX Graph Construction (`graph_service.py`)
- **Description:** Builds the call/connection graph server-side: weighted edges between CDR A-party↔B-party **and** IPDR source_ip↔destination_ip (tagged per node as cdr/ipdr; the two never share an edge). Supports a `subject` focus and a `limit` (returns only the top-N heaviest edges for display) while keeping each node's weight its **true total over all edges**, and reports `total_nodes`/`total_edges`/`shown_edges`. Verified to exactly match the records.
- **Tech:** NetworkX `nx.Graph()`, `edge_counts`/`full_node_weight` Counters, `most_common()` top-N trim, `node_kind` map

### Graph Metrics Computation (`graph_service.py`)
- **Description:** Computes degree centrality (most connected entities), betweenness centrality (bridge entities), communities via greedy modularity, and structural bridges over the **full** graph. Betweenness falls back to **k-pivot sampling** above 800 nodes (exact betweenness is O(V·E) — infeasible at scale) and flags when it sampled.
- **Tech:** `nx.degree_centrality()`, `nx.betweenness_centrality(graph, k=…, seed=42)` when large, `greedy_modularity_communities()`, `nx.bridges()`, `betweenness_sampled` flag

### Unified Investigation Timeline (`investigation_service.py`)
- **Description:** Merges CDR calls, **reconstructed** IPDR sessions, and tower registry data into a single chronologically sorted timeline. IPDR records are no longer emitted one event per row — they are grouped server-side by `reconstruct_ipdr_sessions()` into concurrent `(counterpart, activity family)` tracks with family-adaptive idle gaps (mirroring the frontend), and each session reports aggregated bytes, duration, record count, and a most-confident service attribution.
- **Tech:** `reconstruct_ipdr_sessions()` + `_finalize_session()` (per-session byte/duration aggregation, most-confident `attribute_service()` across the session), `_port_family()`/`_FAMILY_GAP`, multi-model query, `sorted()` with `datetime.min`-safe key

### Tower Activity & Colocation (`tower_service.py`)
- **Description:** Counts CDR and IPDR events per tower. Identifies colocation candidates where multiple subjects appear at the same tower (potential meeting points).
- **Tech:** `Counter` for per-tower event counts, `defaultdict(set)` for subject aggregation

### Timeline Event Builder (`timeline_service.py`)
- **Description:** Builds sorted timeline of CDR calls, IPDR sessions, and tower registry events with service attribution.
- **Tech:** `get_timeline()`, multi-model query, `sorted()` with None-safe key

### CDR/IPDR Statistics (`stats_service.py`)
- **Description:** Aggregates CDR statistics (totals, duration, call type distribution, direction distribution, technology distribution, unique parties) and IPDR statistics (totals, bytes, protocol distribution, APN distribution, RAT distribution).
- **Tech:** `Counter`, `db.query().count()`, `db.query().distinct().count()`

### Database Fallback (PostgreSQL → SQLite)
- **Description:** If PostgreSQL is unavailable (connection error), the app automatically falls back to SQLite using `cdrdb.sqlite3` with `check_same_thread=False`.
- **Tech:** `try/except` in `database.py`, conditional SQLAlchemy `create_engine()`, `check_same_thread=False`

### Automatic Table Creation
- **Description:** All database tables are created automatically on startup via SQLAlchemy's `Base.metadata.create_all()`.
- **Tech:** FastAPI `@app.on_event("startup")`, `Base.metadata.create_all(bind=engine)`

---

## 16. API Endpoints (40+ Routes)

### Authentication (7 endpoints)
- `POST /auth/login` — Login with username/password, returns session cookie
- `GET /auth/me` — Get current user, session, and all active sessions
- `POST /auth/logout` — Revoke current session, clear cookie
- `GET /auth/sessions` — List all active sessions for the current user
- `DELETE /auth/sessions` — Revoke all sessions (logout everywhere)
- `DELETE /auth/sessions/{session_id}` — Revoke a specific session
- `POST /auth/password` — Change current user's password

### Data Upload (3 endpoints)
- `POST /upload/cdr` — Upload CDR CSV (replaces existing)
- `POST /upload/ipdr` — Upload IPDR CSV (replaces existing)
- `POST /upload/towers` — Upload Towers CSV (merges)

### Record Querying (5 endpoints)
- `GET /records/cdr` — List CDR records with 10+ optional filters
- `GET /records/ipdr` — List IPDR records with 10+ optional filters
- `GET /records/page` — Unified, time-ordered, paginated page across CDR+IPDR (case/type/search/service, limit/offset, total count) — server-side fetch-on-demand path for very large cases
- `GET /records/services` — Distinct services (CDR call types + IPDR protocols) in a case
- `DELETE /records/reset` — Delete all CDR, IPDR, and Tower records

### Geo-Spatial (3 endpoints)
- `GET /geo/records` — All geo-tagged records (CDR + IPDR) with optional subject filter
- `GET /geo/subjects` — Located parties that have geo-tagged records (CDR a-party + msisdn, IPDR source_ip; excludes remote endpoints like DNS/CDN destinations)
- `GET /geo/towers` — All tower locations with metadata

### Tower Repository (5 endpoints)
- `GET /towers/` — Full tower list (global, case-independent)
- `GET /towers/repo/stats` — Repository headline stats: total, coordinate coverage, states/cities covered, coverage-by-state
- `GET /towers/repo?search=&limit=&offset=` — Searchable, paginated tower listing (by tower_id / city / state)
- `POST /towers/repo/rebuild` — Backfill tower coordinates from CDR/IPDR records already loaded, then offline-geocode newly-located towers (idempotent, never clobbers)
- `POST /towers/repo/geocode` — Offline reverse-geocode: fill city/state for located towers that lack a place name (nearest-city, never overwrites)

### Investigation (5 endpoints)
- `GET /investigation/timeline` — Unified CDR/IPDR/Tower timeline
- `GET /investigation/services` — Service classification summary
- `GET /investigation/towers` — Tower activity counts
- `GET /investigation/colocation` — Colocation candidates (shared towers)
- `GET /investigation/meetings` — Exact server-side co-location/meeting detection (case/subject/window), with high/medium/low counts

### Graph Analysis (2 endpoints)
- `GET /graph/` — Bounded top-N network subgraph (CDR + IPDR), `subject`/`limit`, with true node weights + totals
- `GET /graph/metrics` — Centrality, communities, bridges (betweenness sampled above 800 nodes)

### Inference & Analytics (4 endpoints)
- `GET /inference/report` — Full analytics report: composite risk leaderboards (CDR + IPDR), call-graph structure, temporal/behavioral shifts, IPDR volume/beaconing/destinations, multi-SIM entity resolution, and any watchlist hits — all case-scoped
- `GET /inference/report.md` — The same report rendered as a downloadable Markdown case summary
- `POST /inference/dossier` — Registers a court-ready dossier generation: assigns an official reference id, writes ExportLog + AuditLog rows, returns `{ref, case_name}` for the dossier cover page
- `GET /inference/subject/{subject}` — One subject's movement-annotated timeline + anchors + baseline/escalation/dormancy
- `GET|POST|DELETE /watchlist` — Investigator watchlist CRUD; matches force the subject to Critical at the top of the leaderboards (phones match CDR, IPs match IPDR)

### Timeline (1 endpoint)
- `GET /timeline/` — Chronologically sorted timeline events

### Statistics (3 endpoints)
- `GET /stats/top-contacts` — Top 10 most frequent contacts
- `GET /stats/cdr` — CDR aggregate statistics
- `GET /stats/ipdr` — IPDR aggregate statistics

### Annotations (3 endpoints)
- `GET /annotations` — List all annotations for current user
- `POST /annotations` — Create a new annotation
- `DELETE /annotations/{id}` — Delete an annotation

### Cases (4 endpoints)
- `GET /cases` — List all cases with record counts
- `POST /cases` — Create a new case
- `PUT /cases/{id}` — Update a case
- `DELETE /cases/{id}` — Delete a case and cascade-delete its records

### Cross-Case Linking (3 endpoints)
- `GET /cross-case/subject?case_id=&subject=` — Every other case a subject (or its handset IMEI / SIM IMSI / IP) appears in, with per-case match type, confidence (high for number/device, low for IP), record count and date span
- `GET /cross-case/overview?case_id=` — This case's subjects that also appear in other cases (dashboard "Cross-case hits" panel), bounded list sorted by other-case count
- `GET /cross-case/report?case_id=` — Full cross-case dossier for the Cross-Case tab: headline summary, per-linked-case rollup, and every recurring subject expanded to its per-case match detail

### AI/TIFM (7 endpoints)
- `POST /ai/analyze` — Run TIFM multi-agent analysis on case data
- `POST /ai/generate-report` — Generate forensics report
- `GET /ai/knowledge-base` — Return the TIFM knowledge base
- `POST /ai/generate-synthetic` — Generate synthetic case data
- `POST /ai/investigate` — Run full PoliceInvestigator analysis (8 modules)
- `POST /ai/chat` — Fine-tuned model Q&A endpoint
- `GET /ai/finetune-dataset` — Export fine-tuning dataset

### Admin User Management (5 endpoints)
- `GET /auth/admin/users` — List all users (admin only)
- `POST /auth/admin/users` — Create a user (admin only)
- `PUT /auth/admin/users/{id}` — Update a user (admin only)
- `PUT /auth/admin/users/{id}/password` — Reset user password (admin only)
- `DELETE /auth/admin/users/{id}` — Delete a user (admin only)

### Infrastructure (2 endpoints)
- `GET /health` — Server health check
- `GET /favicon.ico` — Empty response (204)

---

## 17. UI/UX Features

### Grouped Tab Navigation (decluttered topbar)
- **Description:** The topbar was reorganised from a flat row of ~15 tabs into a compact, grouped bar. Left: ARGUS logo + the **active-case selector** (moved here as it's contextual). Centre: primary tabs **Dashboard · Story · Cross-Case · Evidence · Records** plus two **dropdown groups** — **Maps & Network** (Network Graph, Tower Map, Tower Repository) and **Analysis** (Timeline, Charts, Services, Correlation, Inferences, AI Insights) — with the **Admin** tab shown only for `role=admin`. The dropdown trigger shows an underline when one of its tabs is active. Right: **Dossier** and **Export** actions, a session-status indicator, and a compact **user menu** (avatar + name) housing the theme toggle and Sign out. Menus open on click and close on outside-click or tab selection.
- **Tech:** `.topbar-tab` buttons with `data-tab` (unchanged switch logic via `switchTab()`), `.nav-group`/`.nav-menu` dropdowns, `.user-menu`/`.user-pop`, `initTopbarMenus()` for open/close, `group-active` reflection in `switchTab()`; admin check `state.auth.user?.role === 'admin'`. Styles `.topbar-nav`/`.nav-*`/`.user-*`/`.tb-action`/`.case-select`.

### Dark Mode
- **Description:** A moon icon toggle button in the top bar switches the entire UI between light and dark color schemes. Palette is applied via CSS custom properties on `.dark` class. Persisted to `localStorage` and restored on page load. Applies to all surfaces, text, lines, charts, maps, tooltips, Gantt bars, and modals.
- **Tech:** `document.body.classList.toggle('dark')`, `localStorage.setItem('darkMode')`, `.dark` CSS class with full `--bg`, `--surface`, `--text`, `--line`, `--accent` overrides, IIFE for early restore, dark tile layer for the map

### CSS Custom Properties (Design Tokens)
- **Description:** Centralized color scheme via CSS variables: `--bg`, `--surface`, `--text`, `--muted`, `--line`, `--accent`, `--accent-light`, `--danger`, `--warn`, `--success`, `--shadow`, `--card-bg`, `--fg`. Single source of truth for theming across light and dark modes.
- **Tech:** `:root { --bg: #f0ebe4; ... }`, `.dark { --bg: #1a1a1a; ... }`, used throughout as `var(--bg)`

### Responsive Layout
- **Description:** Top bar with tabs, scrollable tab content, fixed session status. Uses flexbox for all layout components. Responsive breakpoint at 820px switches to single-column layout.
- **Tech:** `display: flex`, `flex: 1`, `height: calc(100vh - 160px)`, `overflow: auto`, `@media(max-width: 820px)`

### Dark/Light Readable Color Palette
- **Description:** Warm, high-contrast color scheme designed for long investigation sessions: cream background, dark text, teal accent, muted earth tones.
- **Tech:** CSS variables, `#f0ebe4` background, `#1f2330` text, `#2c6f79` accent

### HTML Escaping Utility
- **Description:** All user data rendered in the DOM is HTML-escaped to prevent XSS injection.
- **Tech:** `esc()` function: `replace(/&/g, '&amp;').replace(/</g, '&lt;')...`

### Date/Time Formatting Utilities
- **Description:** Three formatting functions: `fmt()` (full locale string), `fmts()` (short date + HH:MM), `fmtd()` (date only), `n()` (number with locale formatting), `fmtBytes()` (human-readable byte sizes).
- **Tech:** `new Date(v).toLocaleString()`, `.toLocaleTimeString()`, `.toLocaleDateString()`, `Number(v).toLocaleString()`, `['B','KB','MB','GB']` units for bytes

### Modal System
- **Description:** Reusable modal overlay pattern used for subject profile, session records, meeting details, admin forms, and upload preview. Click outside to close or press Escape.
- **Tech:** `.modal-overlay` CSS (fixed position, inset 0, flex centering), `onclick` for background dismissal, `keydown Escape` listener

### Gantt Tooltip with Smart Positioning
- **Description:** Hovering a Gantt bar shows a tooltip with: service badge (colored), activity description, start/end time, duration, confidence percentage, and evidence text categorized into Infrastructure/Ports/Behavior/Signals. "View Records" button opens session evidence overlay. Tooltip is positioned with its top-left corner touching the bar's top-right corner (flips to left side if viewport overflows). Tooltip can be hovered directly without disappearing (200ms grace period on mouse leave from bar). Tooltip does not follow the cursor.
- **Tech:** `showGanttTip()` / `scheduleHideGanttTip()` / `positionGanttTip(el)`, `getBoundingClientRect()` with viewport edge detection and flip-to-left logic, `onmouseenter`/`onmouseleave` on tooltip div, 200ms `setTimeout` hide delay, `pointer-events: auto` on tooltip, `position: fixed`, `width: max-content`

### Infinite Scroll / Load More
- **Description:** "Load More" button pattern used in the Records table. Loads 60 records at a time, shows/hides button based on remaining data.
- **Tech:** `recPage` counter, `row.slice(0, recPage + 60)`, `D.recLoadMore.style.display`

### Global HTML Element Cache
- **Description:** All DOM elements are cached once at startup in a `D` object (80+ elements), accessed via `D.elementId` throughout the application.
- **Tech:** `const D = { elementId: $('elementId'), ... }` where `$ = id => document.getElementById(id)`

### Client-Side State Management
- **Description:** Global `state` object holds application state: `auth`, `cdr`, `ipdr`, `towers`, `tab`, `subjects`, `graphData`, `timeline`, `charts`. Merged `allRows` array provides unified record access. `activeCaseId` tracks the selected case.
- **Tech:** JavaScript object with module-level scope, initialized at script load

### Named Event Handlers for Re-rendering
- **Description:** Event listeners that are re-registered on re-render use a `._handler` property pattern to properly remove the old listener before adding the new one, preventing listener accumulation.
- **Tech:** `D.graphSearch._handler = () => {...}`, `removeEventListener` + `addEventListener`

### Evidence Export (.txt Report)
- **Description:** "Export" button in the top bar generates a plain-text `.txt` investigation report. Includes: report header (timestamp, user, case name), summary with time span, top 10 attributed services, top 10 contacts, geofence coordinates if drawn, detailed subject profiles (up to 50 subjects with records, sessions, contacts, services, towers, APNs, RATs, meetings), all reconstructed sessions (up to 200 with service, confidence, duration, evidence, candidates), raw CDR/IPDR records (up to 200 each, non-empty fields only), tower list, and meeting evidence sorted by score. Download is timestamped.
- **Tech:** `state.ipdr`/`state.cdr` data access, `recordSvcAttr()` for service attribution, `reconstructSessions()` for session summaries, `Blob` + `URL.createObjectURL()` for file download, `a.download` for filename

---

## 18. Case Management

### Saved Cases (Backend)
- **Description:** Full CRUD for investigation cases. `Case` model with id, name, description, timestamps, and record count. Deleting a case cascade-deletes all associated CDR and IPDR records. Cases are listed sorted alphabetically.
- **Tech:** `Case` SQLAlchemy model, `GET/POST/PUT/DELETE /cases/` endpoints, `case_id` string field on `CDRRecord`/`IPDRRecord`, cascade delete via `session.delete()`, `record_count` computed via `db.query().filter()`

### Case Selector Dropdown
- **Description:** A dropdown in the top bar shows all cases with record counts. Selecting a case switches the active investigation and reloads all data filtered to that case. "New Case" option prompts for a name. "Manage Cases" opens the management modal.
- **Tech:** `<select id="caseSelector">`, `loadCases()` populates, `activeCaseId` variable, `loadCaseData()` passes `?case_id=...`

### Case Management Modal
- **Description:** A modal listing all cases with name, record count, Switch and Delete buttons per row. Delete cascades to all associated records.
- **Tech:** `showCaseManager()`, `API.del('/cases/'+c.id)`, `addEventListener` pattern (no inline onclick)

### Case-Aware Data Filtering
- **Description:** Records endpoints (`GET /records/cdr`, `GET /records/ipdr`, `DELETE /records/reset`) and upload endpoints (`POST /upload/cdr`, `POST /upload/ipdr`) accept optional `case_id` to filter or associate records with a specific case.
- **Tech:** `case_id: str | None = Query(default=None)` in backend, `CDRRecord.case_id == case_id` filter, `case_id: str = Form("")` in upload endpoints

---

## 19. Admin User Management

### Admin User CRUD
- **Description:** Admin users can list, create, update, and delete users. User creation requires username and password (≥8 chars). User update supports changing username, role, and active status. Admin cannot delete their own account. Only users with `role=admin` can access these endpoints.
- **Tech:** `get_current_admin()` dependency in `auth_service.py`, `GET/POST /auth/admin/users`, `PUT/DELETE /auth/admin/users/{id}`, `AdminCreateUserRequest`/`AdminUpdateUserRequest` schemas

### Admin Frontend Tab
- **Description:** An "Admin" tab visible only for admin users. Shows a table of all users with username, role, active status, and action buttons (Edit, Reset Password, Delete). Modal dialogs handle create/edit/reset-password forms.
- **Tech:** `switchTab()` checks `state.auth.user?.role === 'admin'` to show the tab button, `renderAdminTable()` builds user rows, modal with form fields for username/role/password

---

## 20. Infrastructure Features

### Environment-Based Configuration
- **Description:** All configurable settings (database URL, cookie name, session TTL, bootstrap credentials) are managed via `.env` file with Pydantic Settings validation.
- **Tech:** `pydantic-settings`, `.env` file, `Settings` class with `@lru_cache`

### Cached Settings Singleton
- **Description:** Application settings are loaded once and cached via `lru_cache(maxsize=1)`.
- **Tech:** `@lru_cache(maxsize=1)` on `get_settings()`

### FastAPI Swagger/ReDoc
- **Description:** Interactive API documentation auto-generated at `/docs` (Swagger UI) and `/redoc` (ReDoc).
- **Tech:** FastAPI built-in, `app.include_router()` with tags

### Static File Serving
- **Description:** Frontend static files (HTML, CSS, JS) are served directly by the backend via FastAPI's `StaticFiles`.
- **Tech:** `app.mount("/static", StaticFiles(directory=static_dir), ...)`, `FileResponse(static_dir / "index.html")`

### SPA Entry Point
- **Description:** The root URL `/` serves the SPA (`index.html`). All frontend routing is handled client-side via tab switching.
- **Tech:** `@app.get("/", include_in_schema=False)` returns `FileResponse`

### Health Check Endpoint
- **Description:** Simple `GET /health` returns `{"status": "ok"}`. No authentication required. Used by the frontend and monitoring tools.
- **Tech:** `@app.get("/health")`, returns plain JSON

### SQLite Fallback
- **Description:** If PostgreSQL connection fails, automatically falls back to local SQLite file with zero configuration.
- **Tech:** `try/except ConnectionError` in `database.py`, SQLite `check_same_thread=False` for multi-thread safety

---

## 21. Validation Infrastructure

### Synthetic Validation Dataset Pack
- **Description:** 8 curated CDR/IPDR datasets for testing AI findings, meeting detection, identity resolution, and false-positive rates: `normal_user` (regular 8am-10pm pattern, ~88 records), `family_group` (4 subjects sharing home tower, frequent intra-family calls), `business_user` (30+ contacts, multi-tower travel), `call_center` (326 records, single tower, repetitive 10am-7pm — critical false-positive benchmark), `criminal_network` (5 subjects, night meetings, SIM swaps, encrypted apps), `criminal_network_noise` (same criminal activity interleaved with normal family/business/social contacts per subject — 5 subjects, ~800 records, tests ability to extract signal from noise), `shared_transport` (10 commuters on same train, same towers/times — meeting detection false-positive stress test), `large_dataset` (50 subjects, ~119k records — performance stress test). Each dataset includes CDR/IPDR/towers CSVs and a `meta.json` describing expected behavior.
- **Tech:** `tests/generate_datasets.js` generates all 8 scenarios, deterministic random seeds, Node.js CSV writer

### Identity Resolution Test Suite
- **Description:** 38 assertions across 12 scenarios in `tests/identity.test.js`: A→B→A re-appearance, SIM swap, device change, combined change, partial changes, no-change aggregation, empty input, single record, complex A→B→C→A, sequential SIM-then-device change, MSISDN accumulation. Run via `node tests/identity.test.js`.
- **Tech:** Extracted `buildIdentityProfile()` function, standalone Node.js test runner

### TIFM AI Test Suite
- **Description:** 13 test classes (541 lines) in `tests/test_ai.py` covering: knowledge base validation, dataset generator (6 scenarios), all 5 TIFM agents, PoliceInvestigator (14 sub-tests across 5 scenarios), fine-tuning scaffold validation. Run via `python -m unittest tests.test_ai`.
- **Tech:** Python unittest, mock data generation, agent output validation

### LCS & Performance Benchmark
- **Description:** A standalone micro-benchmark (`backend/tests/benchmark.js`, self-contained copies of the algorithms) measuring LCS vs greedy matching timing across sequence sizes (100-5000), scalability projection for 10-100 subjects, identity resolution timing for 1k-50k records, meeting detection timing (5-50 subjects at 1k-10k records), graph construction timing (10k-100k records), AI cache build timing, spike detection, timeline entity mapping, and 100-subject LCS profiling. Run via `node backend/tests/benchmark.js`. *(Historical: the client-side LCS meeting detection it profiles has been superseded in production by the server-side Meeting Detection Engine and bounded server graph; the benchmark is retained as a performance reference for those original algorithms.)*
- **Tech:** `towerSequenceSimilarity()`/`greedySimilarity()`, `Date.now()` timing, `detectMeetingsSimple()`, `buildGraph()`, `buildAiCache()`, `findSpikes()`, `buildTimelineEntities()`

### Service-Attribution Metrics Harness
- **Description:** 17 hand-verified labeled fixtures in `tests/test_attribution.py` that turn "is attribution better?" into a measured number: overall accuracy plus a per-category breakdown (content/hosting/access_network/vpn/anonymization/internal/service). Locks in the regression fixes — duplicate port keys (27017→MongoDB, 9418→Git), ephemeral-source-port guard, longest-prefix match, carrier/CGNAT handling — and asserts ≥95% accuracy. Run as a report (`python -m tests.test_attribution`) or as tests (`python -m unittest tests.test_attribution`).
- **Tech:** `FIXTURES` list of (record, predicate), `evaluate()` returning accuracy/per-category/failures, `unittest.TestCase` with accuracy + required-keys + summary-aggregation assertions

### Investigation Validation Checklist
- **Description:** `tests/VALIDATION_CHECKLIST.md` provides step-by-step validation guidance: identity resolution tests, meeting detection expectations, subject assessment verification, lead scoring sanity checks, AI findings false-positive tracking table, activity spike detection expectations, and a pre-demo checklist (19 items).
- **Tech:** Markdown checklist with per-dataset expected/actual columns, FP rate target <20%
