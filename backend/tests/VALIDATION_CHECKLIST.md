# Investigation Validation Checklist

## How to use
1. Upload each dataset from `testdata/<scenario>/` (cdr.csv + ipdr.csv + towers.csv)
2. Open the AI Insights tab
3. For each AI Finding, click to expand and mark **Useful** or **False Positive**
4. At the end, click **Export Feedback** to save results
5. Run `node tests/identity.test.js` to verify identity resolution
6. Run `node tests/benchmark.js` to measure performance

---

## Identity Resolution

| Test Case | Input | Expected | Actual | Pass/Fail |
|-----------|-------|----------|--------|-----------|
| No change | Same IMEI+IMSI throughout | 0 changes, 1 identity | | |
| SIM swap | Same IMEI, different IMSI | 1 sim_swap change | | |
| Device change | Same IMSI, different IMEI | 1 device_change change | | |
| Combined change | Both IMEI and IMSI change | 1 combined_change | | |
| A→B→A | Switch to new pair then back | 3 timeline states, 2 transitions | | |
| Partial (IMEI only) | IMEI changes, no IMSI context | 1 partial_device_change | | |
| Partial (IMSI only) | IMSI changes, no IMEI context | 1 partial_sim_swap | | |
| MSISDN accumulation | Same pair appears with different MSISDNs | Both MSISDNs collected | | |
| Empty input | No rows | 0 identities, 0 changes | | |

**Automated test:** `node tests/identity.test.js` — 38 assertions

---

## Meeting Detection

| Dataset | Expected Meetings | False Positives Expected | Actual | Notes |
|---------|-------------------|--------------------------|--------|-------|
| normal_user | 0-2 (family contacts) | None (different towers) | | |
| family_group | Several (same home tower) | High false-positive risk (co-located families) | Review gap level |
| business_user | 0 (many contacts, different towers) | None | | |
| call_center | 0 (single tower, single subject) | None | | |
| criminal_network | 5-10 (night meetings, same tower) | Low | | |
| criminal_network_noise | 5-10 (night meetings, same tower) | **Critical:** Normal contacts may create false meeting detections at home tower | Signal buried in noise — this is the key test |
| shared_transport | 0 (commuters, not meetings) | **Critical:** Should NOT detect meetings — same train, same towers, same times | This is the most important negative test |
| large_dataset | Variable | Monitor performance | |

---

## Subject Assessments

| Dataset | Subjects | Expected Assessment | Should NOT Say |
|---------|----------|---------------------|----------------|
| normal_user | 1 | "Normal activity" or "Limited data" | "High-risk", "Communication hub" |
| family_group | 4 | "Multiple co-location events" for all members | "Suspicious" for non-anomalous behavior |
| business_user | 1 | "High mobility" or "Many contacts" | "Night-dominant", "SIM swap" |
| call_center | 1 | "High communication volume" | "Communication hub", "Suspicious activity" |
| criminal_network | 5 | "Night-dominant", "SIM change detected" for relevant subjects | "Normal activity" |
| criminal_network_noise | 5 | "Night-dominant" still detected despite normal daytime activity | "Normal activity" for criminal subjects; "Suspicious" for family contacts |
| shared_transport | 10 | "Normal activity" for all 10 | "Communication hub", "Suspicious" (they're just commuters) |
| large_dataset | 50 | Variable — no universal statement | "SIM swap" unless actually present |

---

## Investigation Leads

| Dataset | Expected Top Lead | Score Range | Should NOT Produce |
|---------|-------------------|-------------|--------------------|
| normal_user | Low-score pair communication | 40-60 | High-risk leads (>80) |
| family_group | Highest intra-family pair | 50-70 | SIM swap / device change leads |
| business_user | Most-contacted business contact | 40-60 | Night activity leads |
| call_center | Most-called number | 30-50 | "SIM swap", "Device change", "Night activity" |
| criminal_network | Meeting cluster or SIM swap | 70-95 | Low-priority leads ranked higher |
| criminal_network_noise | Meeting cluster or SIM swap | 60-90 | Family contacts ranked above criminal associates |
| shared_transport | None or low-priority | <50 | Any lead score >50 (commuters shouldn't generate actionable leads) |
| large_dataset | Variable — highest-volume pair | Variable | Monitor for correct ranking |

---

## AI Findings False Positive Tracking

| Dataset | Total Findings | Marked Useful | Marked FP | FP Rate |
|---------|---------------|---------------|-----------|---------|
| normal_user | | | | |
| family_group | | | | |
| business_user | | | | |
| call_center | | | | |
| criminal_network | | | | |
| criminal_network_noise | | | | |
| shared_transport | | | | |
| large_dataset | | | | |

**Target:** FP rate < 20% for all datasets. Call center and shared_transport should be near 0%.

---

## Activity Spike Detection

| Dataset | Expected Spikes | False Positives |
|---------|----------------|-----------------|
| normal_user | 0 (consistent daily pattern) | Weekend/weekday variation should not trigger |
| family_group | 0 (consistent daily pattern) | Family gatherings should not trigger |
| business_user | 0 (consistent weekday pattern) | Day with more meetings should not trigger |
| call_center | 0 (very consistent daily volume) | None — this is the most important negative test |
| criminal_network | 2-4 (spike on nights with meetings) | Low |
| criminal_network_noise | 2-4 (nights with meetings) | Normal daytime variation should NOT be flagged as spikes |
| shared_transport | 0 (same pattern every weekday) | Commute hours should not trigger |
| large_dataset | Variable per subject | Monitor for false spikes |

---

## Why This Case Matters

| Dataset | Scope | Key Finding Correct? |
|---------|-------|----------------------|
| normal_user | Single subject, ~88 records | Should say "load more data" or simple scope |
| family_group | 4 subjects, same tower | Should identify family as group |
| business_user | Many contacts, many towers | Should note mobility + volume |
| call_center | Single subject, 326 records | Should NOT flag as suspicious |
| criminal_network | 5 subjects, night meetings | Should identify network structure |
| criminal_network_noise | 5 subjects, 800 recs, signal+noise | Should identify criminal core despite normal noise |
| shared_transport | 10 commuters, 2400 records, same towers | Should NOT identify as meetings or suspicious |
| large_dataset | 50 subjects, ~119k records | Should load within 5s, no OOM |

---

## Performance Benchmarks

Run `node tests/benchmark.js` before and after changes.

| Operation | Baseline (ms) | After Change (ms) | Acceptable? |
|-----------|---------------|-------------------|-------------|
| LCS n=100 | 1 | | <5ms |
| LCS n=500 | 4 | | <20ms |
| LCS n=1000 | 9 | | <50ms |
| LCS n=2000 | 22 | | <100ms |
| LCS n=5000 | 114 | | <500ms |
| Meeting 5sub/1k | 3 | | <10ms |
| Meeting 50sub/10k | 56 | | <100ms |
| Graph 10k records | 24 | | <30ms |
| Graph 100k records | 111 | | <150ms |
| Identity 1k records | 2 | | <5ms |
| Identity 10k records | 10 | | <20ms |
| Identity 50k records | 55 | | <60ms |
| AI Cache 10k/30sub | 16 | | <100ms |
| AI Cache 100k/30sub | 139 | | <500ms |
| AI Cache 50k/300sub | 91 | | <200ms |
| Spike 10sub/365days | 2 | | <10ms |
| Timeline 50k/100ent | 15 | | <100ms |
| Timeline 50k/500ent | 32 | | <200ms |

---

## Pre-Demo Checklist

- [ ] `node tests/identity.test.js` — 38/38 passing
- [ ] `node tests/benchmark.js` — run and record results
- [ ] `node -c backend/static/app.js` — syntax clean
- [ ] Server starts: `python -m uvicorn app.main:app --port 8000`
- [ ] Health endpoint returns `{"status":"ok"}`
- [ ] Upload CDR — records appear in dashboard
- [ ] Upload IPDR — records merge with CDR
- [ ] Upload towers — towers appear on map
- [ ] Switch to AI Insights — findings load within 2 seconds
- [ ] Click each finding — detail panel opens
- [ ] Mark a finding as useful/noise — check: survives page refresh (localStorage)
- [ ] Export feedback — JSON file downloads
- [ ] Switch to Graph — nodes and edges render
- [ ] Switch to Timeline — events display
- [ ] Hover Gantt bar — tooltip appears at top-right of bar, stays fixed (no cursor follow)
- [ ] Move mouse from Gantt bar to tooltip — tooltip stays visible
- [ ] Leave tooltip — tooltip disappears
- [ ] Click a subject — profile modal opens with identity, sessions, meetings
- [ ] SIM swap subject shows SIM swap in identity section
- [ ] Generate report — PDF downloads
- [ ] **shared_transport dataset** — meeting detection should report 0 meetings
- [ ] **large_dataset** — AI Insights load within 5 seconds, no browser hangs
- [ ] **call_center dataset** — false-positive rate < 20%
- [ ] **criminal_network dataset** — SIM swaps + device changes detected correctly
- [ ] **criminal_network_noise dataset** — criminal signal detected despite normal activity noise; FP rate < 30%
- [ ] All datasets generated: `node tests/generate_datasets.js` — 8 scenarios
