# CDR/IPDR Investigation Visualizer — 10-Slide Presentation Content

Presentation-ready content. Each slide has a **title**, **on-slide bullets** (keep them short),
**speaker notes** (what you say), and a **visual** suggestion.

---

## Slide 1 — Title

**CDR / IPDR Investigation Visualizer**
*A forensic analytics platform for telecom investigations*

- Analyze Call Detail Records (CDR), IP Data Records (IPDR) & tower locations
- Visualize communication patterns, movement, meetings & services
- Built for law-enforcement and forensic investigators

**Speaker notes:** Introduce the project in one line — a full-stack platform that turns raw
telecom records into investigative intelligence. Mention your name, the program (GPCSSI), and
that it is a working end-to-end system, not a mock-up.

**Visual:** Project logo / a dark dashboard screenshot, your name + date.

---

## Slide 2 — The Problem

**Why this is hard**

- Investigators receive **millions of rows** of CDR/IPDR across many formats
- Raw records hide the story: *who talks to whom, who meets whom, what apps are used*
- IPDR is almost all **encrypted HTTPS** — no app names, only IPs/ports/bytes
- Manual analysis in Excel is slow, error-prone, and misses cross-record patterns

**Speaker notes:** Frame the gap. A spreadsheet can't reconstruct sessions, detect meetings from
tower co-location, or attribute encrypted traffic to a service. The challenge is extracting signal
(relationships, movement, app usage) from noisy, high-volume, low-context data — legally and offline.

**Visual:** Split image — messy CSV on the left, a clean network graph on the right.

---

## Slide 3 — The Solution

**One platform, seven investigative lenses**

- **Dashboard** — KPIs, service mix, activity, top contacts
- **Network Graph** — D3 force-directed entity relationships + centrality
- **Tower Map** — 6 modes: movement, heatmap, zones, co-location, meetings, triangulation
- **Timeline** — reconstructed sessions per entity (Gantt + density)
- **Charts, Records (24 cols), Services, Correlation, AI Insights**

**Speaker notes:** Walk through the tabs at a high level — each is a different "lens" on the same
case data. Emphasize it's a single-page app: upload CSVs, and every view updates. Everything runs
**locally** — data never leaves the machine, which matters for sensitive investigations.

**Visual:** A 2×3 grid of small screenshots (one per tab).

---

## Slide 4 — System Architecture

**Layered, offline-first, full-stack**

- **Frontend:** Vanilla-JS SPA — D3.js, Chart.js, Leaflet (no framework, fast)
- **Backend:** Python + FastAPI, SQLAlchemy, Pandas, NetworkX
- **Database:** PostgreSQL with automatic **SQLite fallback** (zero-config)
- **Auth:** Session-based, PBKDF2-SHA256, AFK auto-logout, multi-session, RBAC (admin)
- **AI:** Local LLM (Ollama) + fine-tuned TIFM model — *fully offline*

**Speaker notes:** Stress the design choices: no cloud dependency (data sovereignty), graceful
DB fallback so it runs anywhere, and a clean services layer separating business logic from the API.
40+ REST endpoints, all authenticated via HttpOnly cookies.

**Visual:** The layered architecture diagram (Browser → FastAPI → Services → DB).

---

## Slide 5 — Core Visualizations

**Seeing the case**

- **Network Graph** — degree/betweenness centrality, communities, bridges (NetworkX)
- **Tower Map** — movement paths, heatmaps, co-location, **meeting detection**, tech-aware triangulation
- **Meeting engine** — temporal proximity + encounter frequency + LCS movement similarity
- **Geofencing** — draw a polygon, count records inside (Turf.js)

**Speaker notes:** These are the "wow" visuals for a demo. Highlight the meeting-detection engine:
it flags when two subjects are at the same tower within a time window, scored by how often and how
closely their movement patterns match (Longest Common Subsequence of tower sequences). Triangulation
draws coverage circles sized by cell tech (5G≈1km … 2G≈15km) and computes overlap zones.

**Visual:** Tower map with movement path + meeting markers; network graph beside it.

---

## Slide 6 — Service Attribution Engine (key technical contribution)

**Naming the app behind encrypted traffic — without AI**

- **Two layers:** IP-range/provider (Level 1) + port/protocol/behavior (Level 2)
- **62 providers, 83 CIDR ranges, 250+ ports** — incl. Indian carriers (Jio/Airtel/Vi/BSNL)
- **Longest-prefix match**, ephemeral-port guard, **VPN/Tor/datacenter & CGNAT/private flags**
- **Carrier identification** that never overrides a real service match
- **Single source of truth** JSON shared by both engines; **100%** on labeled metrics harness

**Speaker notes:** This is the deepest technical part. Explain the core insight: you can't read
encrypted payloads, so you infer the service from *who* the IP belongs to (provider CIDR ranges) and
*how* the flow behaves (ports, bytes, duration). Mention the accuracy discipline — only providers
with verifiable IP ranges were added (no padding), and a metrics harness *measures* accuracy instead
of asserting it. Confidence is evidence-based with a category for each result.

**Visual:** Flow diagram: IP → provider match → else port/behavior → service + confidence + evidence.

---

## Slide 7 — Timeline & Session Reconstruction

**From rows to sessions to a story**

- Groups IPDR rows into **concurrent activity tracks** by `(counterpart, activity family)`
- **Family-adaptive idle gaps** — DNS 60s, Web 300s, RTC/VoIP 1200s, VPN 1800s
- Interleaved conversations form **coherent parallel sessions** (no fragmentation)
- Per-session: duration, bytes, record count, attributed service + evidence hash
- Runs both **client-side** (Gantt timeline) and **server-side** (unified timeline)

**Speaker notes:** Contrast old vs new: a naive fixed-gap splitter shattered interleaved traffic
(e.g., background DNS during a WhatsApp call) into dozens of fragments. The new track-based
reconstruction keeps simultaneous conversations separate and coherent, with gaps tuned per activity.
Each session is integrity-hashed (EVID-xxxx) for evidentiary chain-of-custody.

**Visual:** Before/after — fragmented bars vs clean parallel session bars (Gantt).

---

## Slide 8 — AI Insights (TIFM)

**Analytics-first, LLM-last investigation assistant**

- Auto-generated **findings, leads & investigation questions** (computed, not hallucinated)
- **PoliceInvestigator** — 12 analysis modules (identity, network, temporal, anomalies, calls…)
- **TIFM multi-agent** backend + fine-tuned Qwen2.5-3B (QLoRA) — all local
- Z-score activity-spike detection, burner-phone scoring, SIM/device-swap tracking
- False-positive feedback loop; context-aware AI chat

**Speaker notes:** Emphasize the architecture: analytics are computed deterministically first, then
the LLM *explains* them — so the AI grounds its answers in real evidence instead of inventing
conclusions. The model is fine-tuned and runs offline. Mention identity resolution: detecting SIM
swaps (same device, new SIM) and device changes from chronological IMEI/IMSI transitions.

**Visual:** AI Insights tab — findings cards with confidence breakdown + the 8-module accordion.

---

## Slide 9 — Security, Validation & Results

**Trustworthy by design, measured by data**

- **Security:** PBKDF2 (210k iters), HttpOnly sessions, RBAC, local-only data, no eval of input
- **Validation pack:** 8 curated datasets incl. false-positive stress tests (call-center, shared-transport)
- **Test suites:** identity (38 assertions), TIFM AI (13 classes), attribution metrics (100%)
- **Performance benchmarks:** scales to ~119k-record datasets; LCS/graph/cache timing profiled
- **Data-quality scoring** on every upload (0–100% with penalty breakdown)

**Speaker notes:** Show rigor. The false-positive benchmarks are important for law enforcement —
e.g., a call center or a shared train shouldn't look like a criminal meeting. Quote that attribution
accuracy is *measured* at 100% on the labeled fixtures, and that validation datasets encode expected
behavior so regressions are caught.

**Visual:** A small results table (datasets × expected vs actual) or the data-quality card.

---

## Slide 10 — Impact, Roadmap & Conclusion

**Where it stands and where it's going**

- **Delivered:** end-to-end investigation platform — ingest → visualize → attribute → report
- **Impact:** turns hours of manual CSV work into interactive, evidence-backed analysis
- **Next:** live provider IP-feed refresh, full ASN database, hostname/DNS signals, impossible-travel & convoy detection, court-ready PDF + audit log
- **Principle throughout:** accuracy over coverage — only verifiable signals, every claim measured

**Speaker notes:** Close on value and honesty. The platform already covers the full investigative
loop and is built offline-first for sensitive data. The roadmap targets the biggest remaining
accuracy lever (richer signals like DNS/ASN feeds) and broader forensic features. End with a one-line
takeaway: *it makes encrypted, high-volume telecom data legible to an investigator — locally,
quickly, and with evidence.*

**Visual:** Roadmap timeline or a clean closing slide with the takeaway line + contact/repo.

---

### Presenter tips
- **Time:** ~1 min/slide for a 10-min talk; expand slides 6–8 if you have 15+ min.
- **Demo:** if live, demo after slide 5 (visuals) or slide 7 (timeline) — most impressive moments.
- **Audience:** for police/forensic audiences lead with slides 2, 5, 9 (problem, meetings, false-positive rigor); for technical reviewers emphasize 4, 6, 7.
- **One-liner to memorize:** "We make encrypted, high-volume telecom data legible — who talks to whom, who meets whom, and what apps they use — locally and with evidence."
