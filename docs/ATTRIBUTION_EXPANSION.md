# Service Attribution & Timeline Expansion — Progress Tracker

_Last updated: 2026-06-19_

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

Shared data today: 62 providers, 83 CIDR ranges, 53 port-families, 40 port names.

---

## 🔜 Left / queued (rough priority order)

1. **Official provider IP-feed fetcher** — Google/AWS/Cloudflare/Meta/Apple publish live range
   feeds; scheduled fetch refreshes `attribution_data.json` to kill range staleness. _(next)_
2. **Real ASN-DB data** wired through the loader (MaxMind GeoLite2-ASN / IPinfo) → coverage of
   every ASN, not just curated providers. Infra is in place; needs the data file + license key.
3. **Hostname / DNS / SNI ingest** — add an optional column (and/or DNS-log upload); IP→host→service
   is the single biggest accuracy lever. Needs an IPDR model migration.
4. **Unify the scoring algorithms** (currently only *data* is unified) and add a calibrated
   confidence model — resolves the backend-vs-frontend confidence-scale divergence (e.g. 95 vs 76).
5. **Auto-generate `PORT_MAP`** from the IANA service-name/port registry instead of hand-maintaining.
6. **Flow-feature heuristics** formalized into a calibrated feature-vector + rule table.

### Broader project (beyond attribution)
- Impossible-travel detection (tower-to-tower speed feasibility)
- Convoy / co-movement detection (shared tower sequences over time)
- Court-ready PDF report with chain-of-custody + hashes; audit log of views/exports
- RBAC beyond admin (analyst/viewer, per-case permissions)
- Column-mapping UI for arbitrary operator CSV schemas; background job queue for heavy analytics

---

## Key files

- `backend/app/data/attribution_data.json` — canonical shared knowledge base (edit here)
- `backend/scripts/gen_attribution_js.py` — regenerate `static/attribution_data.js` after edits
- `backend/scripts/extract_attribution_data.js` — one-time bootstrap from old hardcoded tables
- `backend/app/services/service_attribution_service.py` — backend two-layer engine (IP + port)
- `backend/app/services/investigation_service.py` — server-side session reconstruction + timeline
- `backend/static/app.js` — frontend engine (`matchService`, `classifySession`, `reconstructSessions`)
- `backend/tests/test_attribution.py` — metrics harness / regression tests
- `backend/data/asn_ranges.csv` — optional external ASN range extension (not committed)
