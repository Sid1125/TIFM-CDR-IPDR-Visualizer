# Service Attribution & Timeline Expansion — Progress Tracker

_Last updated: 2026-06-20_

Tracks the multi-step effort to improve service attribution (no-AI) and timeline
reconstruction across the backend (`service_attribution_service.py`,
`investigation_service.py`) and frontend (`app.js`) engines.

Single source of truth for the shared knowledge base: **`backend/app/data/attribution_data.json`**.
After editing it, run `python scripts/gen_attribution_js.py` to regenerate the frontend copy.

---

## ✅ Done

| # | Item | Where |
|---|------|-------|
| 1 | Bug fixes: duplicate port keys (27017→MongoDB, 9418→Git), dead code, low-conf resort no-op | `service_attribution_service.py` |
| 2 | Ephemeral source-port guard (49152+) so a coincidental source port isn't read as the service | both engines |
| 3 | Frontend engine fixes: bogus VoIP ports (9000/45000/65535) removed, `pickBest` "undefined" evidence, DoT 853, Google Meet 19304 | `app.js` |
| 4 | New providers: Indian carriers (Jio/Airtel/Vi/BSNL), Yandex, Alibaba Cloud, Hetzner, Vultr — verified ASNs/ranges | both engines |
| 5 | Carrier (ISP) handling: access-network label, never overrides a content match | both engines |
| 6 | Backend IP/provider attribution layer (parity with frontend) | `service_attribution_service.py` |
| 7 | **Timeline reconstruction**: concurrent `(peer, family)` tracks + family-adaptive idle gaps; backend now reconstructs sessions server-side | `app.js` `reconstructSessions`, `investigation_service.py` `reconstruct_ipdr_sessions` |
| 8 | Longest-prefix-match (most-specific CIDR wins) | both engines |
| 9 | First-class flags: `category` = content/hosting/access_network/vpn/anonymization/internal/service/unknown; deterministic CGNAT/private/loopback detection | both engines |
| 10 | Metrics harness: 17 labeled fixtures, per-category breakdown, ≥95% assertion (currently 100%) | `tests/test_attribution.py` |
| 11 | Pluggable ASN/CIDR loader (`asn_ranges.csv` / `ASN_RANGES_CSV` env) — GeoLite2/IPinfo drop-in | `service_attribution_service.py` |
| 12 | **Unified knowledge base**: one JSON consumed by both engines (data only, not scoring) | `attribution_data.json` + `scripts/gen_attribution_js.py` |
| 13 | **Official provider IP-feed fetcher**: pulls AWS / Google / Cloudflare / Fastly / GitHub published feeds, collapses to minimal CIDR sets, writes the gitignored `data/asn_ranges.csv` the engine already merges (longest-prefix → fresh ranges win). `--update-json` refreshes small curated providers in the JSON. Stdlib-only, best-effort per feed, certifi-aware TLS | `scripts/fetch_provider_ranges.py`, `tests/test_provider_ranges.py` |
| 14 | **Indexed longest-prefix lookup**: first-octet buckets + integer `(lo,hi)` bounds so IP matching stays fast once the live feeds add ~2k ranges. Full pipeline (attribute + summarize + reconstruct) over 100k rows ≈ 5s (was ≈205s with the linear scan); ~14 µs/row, linear. Parity test vs brute-force scan | `service_attribution_service.py` `_match_ip` / `_V4_BUCKETS`, `tests/test_attribution.py` |

Shared data today: 62 providers, 83 CIDR ranges, 53 port-families, 40 port names.
Live feed adds ~2,000 collapsed CIDRs at runtime (AWS ~1,776, Google ~97, Cloudflare 15,
Fastly 19, GitHub 61) via `data/asn_ranges.csv` — kept out of git, refreshed on demand.

---

## 🔜 Left / queued (rough priority order)

1. **Real ASN-DB data** wired through the loader (MaxMind GeoLite2-ASN / IPinfo) → coverage of
   every ASN, not just curated providers. Infra is in place; needs the data file + license key.
   _(next)_
2. **Hostname / DNS / SNI ingest** — add an optional column (and/or DNS-log upload); IP→host→service
   is the single biggest accuracy lever. Needs an IPDR model migration.
3. **Unify the scoring algorithms** (currently only *data* is unified) and add a calibrated
   confidence model — resolves the backend-vs-frontend confidence-scale divergence (e.g. 95 vs 76).
4. **Auto-generate `PORT_MAP`** from the IANA service-name/port registry instead of hand-maintaining.
5. **Flow-feature heuristics** formalized into a calibrated feature-vector + rule table.

### Broader project (beyond attribution)
- ~~Impossible-travel detection (tower-to-tower speed feasibility)~~ ✅ done (inference engine)
- ~~Convoy / co-movement detection (shared tower sequences over time)~~ ✅ done (inference engine)
- Court-ready PDF report with chain-of-custody + hashes; audit log of views/exports
- RBAC beyond admin (analyst/viewer, per-case permissions)
- Column-mapping UI for arbitrary operator CSV schemas; background job queue for heavy analytics
- Surface the inference report in the frontend UI (engine + API exist; no dedicated view yet)

---

## Spatiotemporal inference engine (`inference_service.py`)

Turns raw CDR/IPDR rows into **per-subject, movement-annotated unified timelines** (calls +
SMS + data sessions, keyed by msisdn) and derives investigative inferences on top. Every
function is pure (operates on record iterables) and unit-tested without a DB; `*_db` wrappers
feed the API. Honest framing throughout: tower location ≈ handset area and timestamps are
minute-resolution, so distances/speeds are area-to-area estimates and every output is a graded
signal, not proof.

| Group | Inferences |
|---|---|
| A. Movement & travel | leg distance/speed + **travel-mode banding** (stationary→walking→road→rail→air→impossible), **impossible-travel** flags, home/work **anchors**, mobility footprint |
| B. Co-presence | **co-location / convoy** (same tower within a window, repeated across days), **"met but never called" hidden links** |
| C. Behavioral | activity **bursts** (per-subject z-score), **odd-hours** share, **periodic-contact** cadence, **going-dark** (shift to VPN/Tor/hosting tunnels) |
| E. VPN/proxy use | scored likelihood from explicit tunnel ports (WireGuard/OpenVPN/IPsec), Tor/proxy ports, and **traffic-concentration** (a single cloud/VPS endpoint carrying most of a subject's bytes — catches stealth proxies on 443); gated by a minimum session count |
| D. Identity & device | **SIM swap/clone** (one number on multiple handsets), **burner** (one handset, multiple numbers), **clone corroboration** (impossible travel + multi-handset) — keyed on msisdn, since IMSI is reused across files in this dataset |

- API: `GET /inference/report` (full report) and `GET /inference/subject/{subject}` (movement-annotated timeline + anchors + impossible legs).
- `build_unified_timeline` now annotates each call with a per-subject `move` block (distance/speed/mode/impossible).
- **Map**: Tower-Map Movement-Path legs are per-segment polylines with a sticky hover tooltip (distance, time gap, estimated speed, travel mode; impossible legs in red). Three inference overlays (impossible-travel, co-presence, anchors) and an interactive geofence (subjects-in-area) live on the same tab. Possible-VPN/proxy subjects are surfaced in the Inferences tab.
- Validated on the dummy dataset: 1 impossible-travel (5,816 km/h) + clone, 1 burner, 2 convoys, 1 hidden link, periodic D_A→organiser cadence, organiser going-dark via VPN.
- Geo math in `geo.py` (`haversine_km`, `classify_speed`); tests in `tests/test_inference.py`.

---

## Key files

- `backend/app/data/attribution_data.json` — canonical shared knowledge base (edit here)
- `backend/scripts/gen_attribution_js.py` — regenerate `static/attribution_data.js` after edits
- `backend/scripts/extract_attribution_data.js` — one-time bootstrap from old hardcoded tables
- `backend/scripts/fetch_provider_ranges.py` — refresh provider ranges from official live feeds
- `backend/app/services/service_attribution_service.py` — backend two-layer engine (IP + port)
- `backend/app/services/inference_service.py` — spatiotemporal inference engine (movement/co-presence/behavioral/device)
- `backend/app/services/geo.py` — haversine + speed/travel-mode helpers
- `backend/app/api/inference.py` — `/inference/report` and `/inference/subject/{subject}`
- `backend/app/services/investigation_service.py` — server-side session reconstruction + timeline
- `backend/static/app.js` — frontend engine (`matchService`, `classifySession`, `reconstructSessions`)
- `backend/tests/test_attribution.py` — metrics harness / regression tests
- `backend/tests/test_inference.py` — inference-engine tests (movement/co-presence/behavioral/device)
- `backend/tests/test_provider_ranges.py` — offline tests for the feed fetcher's parsing logic
- `backend/data/asn_ranges.csv` — external ASN range extension; written by the fetcher (not committed)

## Refreshing provider IP ranges

Curated ranges in the JSON are broad summaries and go stale. To pull current ranges from the
providers' own published feeds (no code/JSON edits needed for runtime):

```bash
cd backend
python scripts/fetch_provider_ranges.py            # writes data/asn_ranges.csv (IPv4)
python scripts/fetch_provider_ranges.py --ipv6     # include IPv6
python scripts/fetch_provider_ranges.py --update-json   # also refresh small providers in the JSON
```

The CSV is gitignored and loaded at engine import; longest-prefix matching means these specific
ranges automatically win over the curated `/8`-style blocks. Run it on a schedule (cron/Task
Scheduler) to keep coverage fresh. After `--update-json`, re-run `gen_attribution_js.py`.
