# Dashboard QA Report - 2026-06-23

Scope: live dashboard/API at `http://127.0.0.1:8000`, checked against `docs/features.md`.

Test artifacts:
- `backend/qa_endpoint_results.json`
- `backend/qa_negative_dataset_results.json`
- `backend/qa_shared_transport_detail.json`

## Executive Summary

The application is reachable, authentication works, core CRUD/upload endpoints respond, and the existing automated unit suites are mostly healthy. A disposable case with `normal_user` data completed a 43-step endpoint matrix with no unexpected HTTP failures.

However, several high-impact gaps remain. The biggest risk is that multiple analytics endpoints ignore the active `case_id`, so selected-case dashboards can silently mix records from other investigations. The second biggest risk is false-positive behavior in validation datasets: `shared_transport`, which is explicitly documented as a commuter negative test that should not produce suspicious leads, produced 58 findings and 23 high-priority findings from `/ai/investigate`.

## What Passed

- `GET /health` returned `{"status":"ok"}`.
- Unauthenticated `/auth/me` correctly returned 401.
- Admin login with configured bootstrap credentials worked.
- Auth session listing worked.
- Disposable case create/update/delete worked.
- Case-scoped CDR/IPDR upload worked.
- Tower upload worked.
- Records, geo, graph, timeline, inference, watchlist, annotations, AI knowledge base, admin user listing, export markdown, reset-case, and cleanup routes all returned successful HTTP statuses in the endpoint matrix.
- Python tests passed: 99 tests across attribution, AI, inference, and provider ranges.
- JS identity test passed: 38 assertions.

## Critical / High Findings

### 1. Case isolation is broken in multiple analytics endpoints

Several backend routes do not accept or apply `case_id`, even though the frontend and feature list present the app as case-aware. Passing `?case_id=...` to these routes currently does nothing.

Evidence:
- `backend/app/api/stats.py:11-23` has no `case_id` parameters for `/stats/top-contacts`, `/stats/cdr`, `/stats/ipdr`.
- `backend/app/api/investigation.py:18-36` has no `case_id` filtering for timeline, services, towers, or colocation.
- `backend/app/api/graph.py:17-32` has no `case_id` filtering for graph or metrics.
- `backend/app/api/geo.py:143-155` returns all towers globally.

Impact: dashboard cards, charts, graph metrics, colocation, tower activity, and stats can include records from unrelated cases. This is a serious investigation integrity issue because the UI still looks valid.

### 2. Negative validation dataset produces many high-priority AI findings

`shared_transport` is documented as a false-positive stress test where commuters should not be flagged as suspicious and should not produce leads above 50. The live `/ai/investigate` result produced:

- `total_records_analyzed`: 2400
- `total_subjects`: 10
- `total_findings`: 58
- `high_priority_findings`: 23
- first sample finding: `Behavioral Shift - New Contact Surge`

Impact: the system can overstate normal co-movement/social patterns as high-priority investigative leads.

### 3. Admin edit/reset-password UI is wired to a missing API helper

The frontend `API` object defines `get`, `post`, `del`, and `upload`, but not `put`.

Evidence:
- `backend/static/app.js:3` lacks `put`.
- `backend/static/app.js:4054` calls `API.put('/auth/admin/users/'+id, ...)`.
- `backend/static/app.js:4068` calls `API.put('/auth/admin/users/'+id+'/password', ...)`.

Impact: Admin user creation and listing work, but edit and reset-password actions fail in the browser with `API.put is not a function`.

### 4. AI tab backend mode ignores the active case

Several AI frontend calls omit `case_id`, despite the backend supporting it.

Evidence:
- `backend/static/app.js:3353` calls `/ai/generate-report?report_type=...` without `case_id`.
- `backend/static/app.js:3401` calls `/ai/analyze` without `case_id`.
- `backend/static/app.js:3441` calls `/ai/chat?...` without `case_id`.
- `backend/static/app.js:3528` calls `/ai/investigate` without `case_id`.

Impact: using AI Insights from a selected case can analyze all records or the wrong record set, producing misleading reports.

### 5. Performance benchmark did not complete within 120 seconds

`node backend/tests/benchmark.js` timed out at 120s during `LCS 100-Subject Profiling`. Before timeout it showed:

- 100 subjects, 500 observations each: 8083ms
- 100 subjects, 1000 observations each: 34179ms

Impact: the documented `large_dataset` performance story is not proven. LCS-heavy meeting/route similarity logic is a likely bottleneck at scale.

## Medium Findings

### 6. Map/tower data can look empty or contradictory

In the normal-user disposable case, `/geo/records?case_id=4` returned `0` records while `/geo/subjects?case_id=4` returned 74 subjects and `/geo/towers` returned 271 global towers.

Impact: the map subject selector can be populated even when no geocoded records exist for that case, producing confusing empty map modes.

### 7. CDN dependencies are a single point of failure

The dashboard loads Chart.js, D3, Leaflet, Leaflet.draw, Leaflet.heat, Turf, and Google Fonts from external CDNs.

Evidence: `backend/static/index.html:8-17` and `backend/static/index.html:470-471`.

Impact: offline, restricted, or air-gapped environments will lose graphs, charts, maps, geofencing, heatmaps, and triangulation. Some chart renderers silently return if `Chart` is missing; Leaflet/Turf paths are less consistently guarded.

### 8. Reset Case confirmation text is misleading

The UI prompt says: `Reset all case data? This will delete all CDR, IPDR, and Tower records.`

Evidence: `backend/static/app.js:4651`.

Actual behavior with an active case only deletes CDR/IPDR for that case and does not delete towers. The backend also never deletes towers in `/records/reset`.

Impact: users may believe global tower records are deleted or may be scared away from a case-scoped reset.

### 9. Many dynamic controls still use inline `onclick`

The feature list says named event handlers prevent listener accumulation, but many generated elements still use inline handlers.

Evidence examples:
- `backend/static/app.js:1509`
- `backend/static/app.js:2091`
- `backend/static/app.js:2357`
- `backend/static/app.js:2738`
- `backend/static/app.js:3176`

Impact: this increases XSS/escaping risk and makes event lifecycle harder to reason about.

## Lower-Priority UX / Robustness Gaps

- The top navigation has 11 visible tabs for admin users, while the feature list says 10.
- `mapTimelineBar` has contradictory inline CSS: `display:none;...;display:flex`, so its initial hidden state depends on cascade order and later JS.
- CDN-loaded visual features need explicit fallback messaging per tab, not silent empty canvases.
- There is no evidence of automated browser regression coverage for actual tab switching, modal flows, uploads, chart rendering, geofencing, or responsive layout.

## Recommended Fix Order

1. Make every analytics/stat/graph/investigation endpoint case-aware and add regression tests proving selected-case isolation.
2. Patch AI Insights frontend calls to append `case_id` everywhere backend supports it.
3. Add `API.put` to the frontend helper and manually retest admin edit/reset-password.
4. Tune or gate high-priority AI findings using the validation checklist, starting with `shared_transport` and `call_center`.
5. Add a browser smoke suite that logs in, switches every tab, uploads a small dataset, verifies charts/graph/map render non-empty, exercises admin CRUD, and captures console errors.
6. Vendor or locally bundle the critical dashboard libraries for investigation environments that cannot rely on CDNs.
7. Rework LCS/pairwise movement similarity to cap pair counts, cache by subject sequence, or degrade gracefully on large cases.

## Notes

I could not complete a Playwright browser run because the local `npx` Playwright commands timed out while resolving packages. The report is therefore based on live HTTP/API probes, repository tests, generated validation data uploads, and frontend/backend source inspection.
