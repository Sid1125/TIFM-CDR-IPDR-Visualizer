// Identity Resolution Test Suite
// Run: node test_identity.js

// Extracted from app.js buildIdentityProfile()
function buildIdentityProfile(sub, rows) {
  rows = rows.filter(r => r.ts && (r.imei || r.imsi || r.msisdn))
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const timeline = [];
  rows.forEach(r => {
    const imei = r.imei || null, imsi = r.imsi || null, t = new Date(r.ts);
    if (!imei && !imsi) return;
    const last = timeline.length ? timeline[timeline.length - 1] : null;
    if (!last || last.imei !== imei || last.imsi !== imsi)
      timeline.push({ imei, imsi, firstSeen: t, lastSeen: t, records: 1, msisdns: new Set(r.msisdn ? [r.msisdn] : []) });
    else { last.lastSeen = t; last.records++; if (r.msisdn) last.msisdns.add(r.msisdn) }
  });
  const changes = [];
  for (let i = 1; i < timeline.length; i++) {
    const p = timeline[i - 1], c = timeline[i];
    if (p.imei !== null && c.imei !== null && p.imei === c.imei && p.imsi !== null && c.imsi !== null && p.imsi !== c.imsi)
      changes.push({ time: c.firstSeen, type: 'sim_swap', from: p.imsi, to: c.imsi, confidence: 'high' });
    else if (p.imsi !== null && c.imsi !== null && p.imsi === c.imsi && p.imei !== null && c.imei !== null && p.imei !== c.imei)
      changes.push({ time: c.firstSeen, type: 'device_change', from: p.imei, to: c.imei, confidence: 'high' });
    else if (p.imei !== null && c.imei !== null && p.imsi !== null && c.imsi !== null && p.imei !== c.imei && p.imsi !== c.imsi)
      changes.push({ time: c.firstSeen, type: 'combined_change', from: p.imei + '/' + p.imsi, to: c.imei + '/' + c.imsi, confidence: 'high' });
    else if (p.imei !== null && c.imei !== null && p.imei !== c.imei)
      changes.push({ time: c.firstSeen, type: 'partial_device_change', from: p.imei, to: c.imei, confidence: 'medium' });
    else if (p.imsi !== null && c.imsi !== null && p.imsi !== c.imsi)
      changes.push({ time: c.firstSeen, type: 'partial_sim_swap', from: p.imsi, to: c.imsi, confidence: 'medium' });
  }
  const seen = new Map(), identities = [];
  timeline.forEach(s => {
    const k = s.imei + '|' + s.imsi;
    if (!seen.has(k)) {
      seen.set(k, identities.length);
      identities.push({ imei: s.imei, imsi: s.imsi, firstSeen: s.firstSeen, lastSeen: s.lastSeen, records: s.records, msisdns: [...s.msisdns] });
    } else {
      const idx = seen.get(k), id = identities[idx];
      if (s.lastSeen > id.lastSeen) id.lastSeen = s.lastSeen;
      if (s.firstSeen < id.firstSeen) id.firstSeen = s.firstSeen;
      id.records += s.records;
      s.msisdns.forEach(m => { if (!id.msisdns.includes(m)) id.msisdns.push(m) });
    }
  });
  return { identities, changes, timeline };
}

// ── Test Helpers ──
let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  PASS:', label) }
  else { failed++; console.log('  FAIL:', label) }
}
function isChange(ch, type, from, to) {
  return ch.type === type && ch.from === from && ch.to === to;
}

// ── Test 1: A→B→A (transition re-appearance) ──
console.log('\n=== A→B→A Re-appearance ===');
const t1 = buildIdentityProfile('x', [
  { ts: '2025-01-01T10:00Z', imei: 'IMEI1', imsi: 'IMSI1' },
  { ts: '2025-01-02T10:00Z', imei: 'IMEI2', imsi: 'IMSI2' },
  { ts: '2025-01-03T10:00Z', imei: 'IMEI1', imsi: 'IMSI1' },
]);
assert(t1.timeline.length === 3, 'timeline has 3 states (A, B, A)');
assert(t1.changes.length === 2, '2 transitions detected (A→B, B→A)');
assert(t1.identities.length === 2, '2 deduplicated identities (A, B)');
assert(t1.changes[0].type === 'combined_change', 'A→B is combined_change');
assert(t1.changes[1].type === 'combined_change', 'B→A is combined_change');

// ── Test 2: SIM Swap (same IMEI, different IMSI) ──
console.log('\n=== SIM Swap ===');
const t2 = buildIdentityProfile('x', [
  { ts: '2025-01-01T10:00Z', imei: 'IMEI1', imsi: 'IMSI1' },
  { ts: '2025-01-02T10:00Z', imei: 'IMEI1', imsi: 'IMSI2' },
]);
assert(t2.changes.length === 1, '1 change detected');
assert(t2.changes[0].type === 'sim_swap', 'type = sim_swap');
assert(t2.changes[0].from === 'IMSI1', 'from = IMSI1');
assert(t2.changes[0].to === 'IMSI2', 'to = IMSI2');

// ── Test 3: Device Change (same IMSI, different IMEI) ──
console.log('\n=== Device Change ===');
const t3 = buildIdentityProfile('x', [
  { ts: '2025-01-01T10:00Z', imei: 'IMEI1', imsi: 'IMSI1' },
  { ts: '2025-01-02T10:00Z', imei: 'IMEI2', imsi: 'IMSI1' },
]);
assert(t3.changes.length === 1, '1 change detected');
assert(t3.changes[0].type === 'device_change', 'type = device_change');
assert(t3.changes[0].from === 'IMEI1', 'from = IMEI1');
assert(t3.changes[0].to === 'IMEI2', 'to = IMEI2');

// ── Test 4: No Change (same IMEI+IMSI throughout) ──
console.log('\n=== No Change ===');
const t4 = buildIdentityProfile('x', [
  { ts: '2025-01-01T10:00Z', imei: 'IMEI1', imsi: 'IMSI1', msisdn: '999' },
  { ts: '2025-01-02T10:00Z', imei: 'IMEI1', imsi: 'IMSI1', msisdn: '999' },
  { ts: '2025-01-03T10:00Z', imei: 'IMEI1', imsi: 'IMSI1', msisdn: '888' },
]);
assert(t4.changes.length === 0, '0 changes');
assert(t4.timeline.length === 1, '1 timeline state');
assert(t4.identities.length === 1, '1 deduplicated identity');
assert(t4.identities[0].records === 3, '3 records aggregated');
assert(t4.identities[0].msisdns.includes('999') && t4.identities[0].msisdns.includes('888'), 'both MSISDNs collected');

// ── Test 5: Combined Change (both change simultaneously) ──
console.log('\n=== Combined Change ===');
const t5 = buildIdentityProfile('x', [
  { ts: '2025-01-01T10:00Z', imei: 'IMEI1', imsi: 'IMSI1' },
  { ts: '2025-01-02T10:00Z', imei: 'IMEI2', imsi: 'IMSI2' },
]);
assert(t5.changes.length === 1, '1 change detected');
assert(t5.changes[0].type === 'combined_change', 'type = combined_change');

// ── Test 6: Partial Device Change (IMEI only, no IMSI context) ──
console.log('\n=== Partial Device Change ===');
const t6 = buildIdentityProfile('x', [
  { ts: '2025-01-01T10:00Z', imei: 'IMEI1' },
  { ts: '2025-01-02T10:00Z', imei: 'IMEI2' },
]);
assert(t6.changes.length === 1, '1 change detected');
assert(t6.changes[0].type === 'partial_device_change', 'type = partial_device_change');

// ── Test 7: Partial SIM Swap (IMSI only, no IMEI context) ──
console.log('\n=== Partial SIM Swap ===');
const t7 = buildIdentityProfile('x', [
  { ts: '2025-01-01T10:00Z', imsi: 'IMSI1' },
  { ts: '2025-01-02T10:00Z', imsi: 'IMSI2' },
]);
assert(t7.changes.length === 1, '1 change detected');
assert(t7.changes[0].type === 'partial_sim_swap', 'type = partial_sim_swap');

// ── Test 8: Empty Input ──
console.log('\n=== Empty Input ===');
const t8 = buildIdentityProfile('x', []);
assert(t8.identities.length === 0, '0 identities');
assert(t8.changes.length === 0, '0 changes');

// ── Test 9: Single Record ──
console.log('\n=== Single Record ===');
const t9 = buildIdentityProfile('x', [
  { ts: '2025-01-01T10:00Z', imei: 'IMEI1', imsi: 'IMSI1' },
]);
assert(t9.identities.length === 1, '1 identity');
assert(t9.changes.length === 0, '0 changes');
assert(t9.identities[0].records === 1, '1 record');

// ── Test 10: Complex Sequence A→B→C→A (multiple re-appearances) ──
console.log('\n=== Complex A→B→C→A ===');
const t10 = buildIdentityProfile('x', [
  { ts: '2025-01-01T10:00Z', imei: 'IMEI1', imsi: 'IMSI1' },
  { ts: '2025-01-02T10:00Z', imei: 'IMEI2', imsi: 'IMSI2' },
  { ts: '2025-01-03T10:00Z', imei: 'IMEI3', imsi: 'IMSI3' },
  { ts: '2025-01-04T10:00Z', imei: 'IMEI1', imsi: 'IMSI1' },
]);
assert(t10.timeline.length === 4, '4 timeline states');
assert(t10.changes.length === 3, '3 transitions');
assert(t10.identities.length === 3, '3 deduplicated identities');

// ── Test 11: SIM Swap → Device Change (sequential) ──
console.log('\n=== SIM Swap then Device Change ===');
const t11 = buildIdentityProfile('x', [
  { ts: '2025-01-01T10:00Z', imei: 'IMEI1', imsi: 'IMSI1' },
  { ts: '2025-01-02T10:00Z', imei: 'IMEI1', imsi: 'IMSI2' },  // SIM swap
  { ts: '2025-01-03T10:00Z', imei: 'IMEI2', imsi: 'IMSI2' },  // Device change
]);
assert(t11.changes.length === 2, '2 transitions');
assert(t11.changes[0].type === 'sim_swap', 'first = sim_swap');
assert(t11.changes[1].type === 'device_change', 'second = device_change');

// ── Test 12: Same pair reappears with MSISDN accumulation ──
console.log('\n=== MSISDN Accumulation ===');
const t12 = buildIdentityProfile('x', [
  { ts: '2025-01-01T10:00Z', imei: 'IMEI1', imsi: 'IMSI1', msisdn: '111' },
  { ts: '2025-01-02T10:00Z', imei: 'IMEI2', imsi: 'IMSI2', msisdn: '222' },
  { ts: '2025-01-03T10:00Z', imei: 'IMEI1', imsi: 'IMSI1', msisdn: '333' },
]);
assert(t12.identities[0].msisdns.length === 2, '2 MSISDNs on identity A');
assert(t12.identities[0].msisdns.includes('111') && t12.identities[0].msisdns.includes('333'), 'both 111 and 333');
assert(t12.identities[1].msisdns.includes('222'), 'MSISDN 222 on identity B');

// ── Summary ──
console.log('\n=======================');
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log('=======================');
process.exit(failed ? 1 : 0);
