// Benchmark Suite for AI Insights & Core Analytics
// Measures timing for LCS, meeting detection, identity resolution at scale.
// Usage: node benchmark.js

// Extracted implementation (same as app.js)
function towerSequenceSimilarity(seqA, seqB) {
  const m = seqA.length, n = seqB.length;
  let prev = new Uint16Array(n + 1), curr = new Uint16Array(n + 1);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++)
      curr[j] = seqA[i - 1] === seqB[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    [prev, curr] = [curr, prev];
  }
  return prev[n] / Math.max(m, n, 1);
}

function greedySimilarity(seqA, seqB) {
  const shorter = seqA.length <= seqB.length ? seqA : seqB;
  const longer = seqA.length <= seqB.length ? seqB : seqA;
  let matches = 0, ptr = 0;
  for (let i = 0; i < shorter.length; i++) {
    for (let j = ptr; j < longer.length; j++) {
      if (shorter[i] === longer[j]) { matches++; ptr = j + 1; break }
    }
  }
  return matches / Math.max(seqA.length, seqB.length, 1);
}

// ── Helpers ──
function makeSeq(n) { return Array.from({ length: n }, (_, i) => `TWR${String(rng(1, 100)).padStart(3, '0')}`) }
function rng(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min }
function time(fn) { const s = Date.now(); fn(); return Date.now() - s }

// ── LCS Benchmark ──
console.log('=== LCS vs Greedy Benchmark ===\n');
const SIZES = [100, 500, 1000, 2000, 5000];
SIZES.forEach(n => {
  const a = makeSeq(n), b = makeSeq(n);
  const tLcs = time(() => towerSequenceSimilarity(a, b));
  const tGreedy = time(() => greedySimilarity(a, b));
  console.log(`  n=${n.toString().padStart(5)}: LCS=${tLcs}ms, Greedy=${tGreedy}ms, ratio=${(tLcs / Math.max(tGreedy, 1)).toFixed(1)}x`);
});

// ── Scalability projection ──
console.log('\n=== Scalability Projection (LCS, all pairs) ===\n');
const SUBJECT_COUNTS = [10, 25, 50, 100];
const AVG_SEQ_LEN = 500;
const SAMPLE_TIME = SIZES.includes(500) ? (() => {
  const a = makeSeq(500), b = makeSeq(500);
  return time(() => towerSequenceSimilarity(a, b));
})() : 4;

SUBJECT_COUNTS.forEach(n => {
  const pairs = n * (n - 1) / 2;
  const est = Math.round(pairs * SAMPLE_TIME);
  console.log(`  ${n} subjects (${pairs} pairs): ~${est}ms (at ${SAMPLE_TIME}ms/pair)`);
});

// ── Identity Resolution Benchmark ──
console.log('\n=== Identity Resolution ===\n');
function buildIdentityProfile(rows) {
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
      changes.push({ type: 'sim_swap' });
    else if (p.imsi !== null && c.imsi !== null && p.imsi === c.imsi && p.imei !== null && c.imei !== null && p.imei !== c.imei)
      changes.push({ type: 'device_change' });
    else if (p.imei !== null && c.imei !== null && p.imsi !== null && c.imsi !== null && p.imei !== c.imei && p.imsi !== c.imsi)
      changes.push({ type: 'combined_change' });
  }
  return { timeline, changes };
}

function genIdentityRows(n, swaps) {
  const imeis = Array.from({ length: swaps + 1 }, (_, i) => `IMEI${i}`);
  const imsis = Array.from({ length: swaps + 1 }, (_, i) => `IMSI${i}`);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.min(i % (swaps + 1), swaps);
    rows.push({ ts: new Date(2025, 0, 1, i / 24, 0, 0).toISOString(), imei: imeis[idx], imsi: imsis[idx], msisdn: '999' });
  }
  return rows;
}

[1000, 5000, 10000, 50000].forEach(n => {
  const swaps = 5;
  const rows = genIdentityRows(n, swaps);
  const t = time(() => buildIdentityProfile(rows));
  console.log(`  ${n.toString().padStart(6)} records, ${swaps} device changes: ${t}ms`);
});

// ── Meeting Detection Benchmark ──
console.log('\n=== Meeting Detection ===\n');
function detectMeetingsSimple(rows, maxGapMs) {
  const sorted = rows.filter(r => r.ts && r.tow && r.sub)
    .map(r => ({ ...r, t: new Date(r.ts).getTime() }))
    .sort((a, b) => a.t - b.t);
  const meetings = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const gap = Math.abs(sorted[j].t - sorted[i].t);
      if (gap > maxGapMs) break;
      if (sorted[i].tow === sorted[j].tow && sorted[i].sub !== sorted[j].sub)
        meetings.push({ a: sorted[i].sub, b: sorted[j].sub, tow: sorted[i].tow, gap });
    }
  }
  return meetings;
}

function genMeetingRows(n, subjects, towers) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      ts: new Date(2025, 0, 1, rng(0, 23), rng(0, 59), rng(0, 59)).toISOString(),
      tow: towers[rng(0, towers.length - 1)],
      sub: subjects[rng(0, subjects.length - 1)],
    });
  }
  return rows;
}

const mTowers = ['TWR1','TWR2','TWR3','TWR4','TWR5'];
[5, 10, 25, 50].forEach(subCount => {
  const subs = Array.from({ length: subCount }, (_, i) => `sub_${i}`);
  [1000, 5000, 10000].forEach(recCount => {
    const rows = genMeetingRows(recCount, subs, mTowers);
    const t = time(() => detectMeetingsSimple(rows, 3600000));
    console.log(`  ${subCount} subjects, ${recCount} records: ${t}ms`);
  });
});

// ── Graph Build Benchmark ──
console.log('\n=== Graph Construction ===\n');
function buildGraph(rows) {
  const links = {}, nodes = new Set();
  rows.forEach(r => {
    if (!r.sub || !r.cnt) return;
    const k = [r.sub, r.cnt].sort().join('|');
    links[k] = (links[k] || 0) + 1;
    nodes.add(r.sub); nodes.add(r.cnt);
  });
  return { nodes: nodes.size, edges: Object.keys(links).length };
}

[10000, 50000, 100000].forEach(n => {
  const rows = genMeetingRows(n, Array.from({ length: 100 }, (_, i) => `sub_${i}`), mTowers);
  // Add cnt to simulate graph edges
  rows.forEach((r, i) => r.cnt = `cnt_${i % 200}`);
  const t = time(() => buildGraph(rows));
  console.log(`  ${n.toString().padStart(6)} records: ${t}ms`);
});

// ── AI Cache Build Benchmark ──
console.log('\n=== AI Cache Build ===\n');
function buildAiCache(rows, subjects) {
  const c = {};
  c.subCount = subjects.length;
  c.totalRows = rows.length;
  c.pairCounts = {};
  rows.forEach(r => { if (r.sub && r.cnt) { const k = [r.sub, r.cnt].sort().join('|'); c.pairCounts[k] = (c.pairCounts[k] || 0) + 1 } });
  c.subDays = new Map();
  rows.forEach(r => {
    if (!r.ts || !r.sub) return;
    const d = new Date(r.ts).toLocaleDateString();
    if (!c.subDays.has(r.sub)) c.subDays.set(r.sub, new Map());
    c.subDays.get(r.sub).set(d, (c.subDays.get(r.sub).get(d) || 0) + 1);
  });
  c.svcCounts = {};
  rows.forEach(r => { const s = r.svc || 'Unknown'; c.svcCounts[s] = (c.svcCounts[s] || 0) + 1 });
  return c;
}

function genCdrRows(n, subjects, towers) {
  const svcs = ['Call', 'WhatsApp', 'SMS', 'Facebook', 'YouTube'];
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      ts: new Date(2025, 0, rng(1, 30), rng(0, 23), rng(0, 59), 0).toISOString(),
      sub: subjects[rng(0, subjects.length - 1)],
      cnt: subjects[rng(0, subjects.length - 1)],
      tow: towers[rng(0, towers.length - 1)],
      svc: svcs[rng(0, svcs.length - 1)],
      dur: rng(10, 600),
    });
  }
  return rows;
}

function findSpikes(subDays) {
  const spikes = [];
  subDays.forEach((days) => {
    const entries = [...days.entries()].sort((a, b) => new Date(a[0]) - new Date(b[0]));
    if (entries.length < 5) return;
    const values = entries.map(([, c]) => c);
    const avg = values.reduce((a, v) => a + v, 0) / values.length;
    const std = Math.sqrt(values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length) || 1;
    entries.forEach(([d, c]) => {
      if (c < 20) return;
      const z = (c - avg) / std;
      if (z > 2.5) spikes.push({ day: d, count: c, zScore: z, pct: avg ? Math.round((c / avg - 1) * 100) : 0, avg });
    });
  });
  return spikes.sort((a, b) => b.zScore - a.zScore);
}

// AI Cache: vary total record count with fixed subject count
[1000, 5000, 10000, 50000, 100000].forEach(n => {
  const subs = Array.from({ length: 30 }, (_, i) => `sub_${i}`);
  const rows = genCdrRows(n, subs, mTowers);
  const t = time(() => buildAiCache(rows, subs));
  console.log(`  ${n.toString().padStart(6)} records (30 subjects): ${t}ms`);
});

// AI Cache: vary subject count with fixed record count
[10, 30, 100, 300].forEach(subCount => {
  const subs = Array.from({ length: subCount }, (_, i) => `sub_${i}`);
  const rows = genCdrRows(50000, subs, mTowers);
  const t = time(() => buildAiCache(rows, subs));
  console.log(`  50000 records (${subCount} subjects): ${t}ms`);
});

// Spike detection: vary days of data per subject
[10, 30, 90, 365].forEach(days => {
  const subDays = new Map();
  const subs = Array.from({ length: 10 }, (_, i) => `sub_${i}`);
  subs.forEach(s => {
    const dayMap = new Map();
    for (let d = 0; d < days; d++) {
      const date = new Date(2025, 0, d + 1).toLocaleDateString();
      dayMap.set(date, rng(5, 100));
    }
    subDays.set(s, dayMap);
  });
  const t = time(() => findSpikes(subDays));
  console.log(`  10 subjects, ${days} days each: ${t}ms`);
});

// ── Timeline Entity Mapping Benchmark ──
console.log('\n=== Timeline Entity Mapping ===\n');
function buildTimelineEntities(rows) {
  const entityMap = {};
  rows.forEach(r => {
    const entities = [];
    if (r.sub) entities.push(r.sub);
    if (r.cnt && r.cnt !== r.sub) entities.push(r.cnt);
    entities.forEach(e => {
      if (!entityMap[e]) entityMap[e] = { entity: e, events: [], types: new Set(), contacts: new Set(), first: r.ts, last: r.ts, count: 0 };
      entityMap[e].events.push(r);
      entityMap[e].types.add(r.type);
      if (r.cnt && r.cnt !== e) entityMap[e].contacts.add(r.cnt);
      if (r.sub && r.sub !== e) entityMap[e].contacts.add(r.sub);
      if (r.ts) { if (!entityMap[e].first || r.ts < entityMap[e].first) entityMap[e].first = r.ts; if (!entityMap[e].last || r.ts > entityMap[e].last) entityMap[e].last = r.ts }
      entityMap[e].count++;
    });
  });
  return Object.values(entityMap).sort((a, b) => b.count - a.count);
}

function genTimelineRows(n, subjects) {
  const types = ['Call', 'Chat', 'Video', 'Data', 'Voice', 'Msg', 'Stream', 'Conf'];
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      ts: new Date(2025, 0, rng(1, 30), rng(0, 23), rng(0, 59), 0).toISOString(),
      sub: subjects[rng(0, subjects.length - 1)],
      cnt: subjects[rng(0, subjects.length - 1)],
      type: types[rng(0, types.length - 1)],
    });
  }
  return rows;
}

[1000, 5000, 10000, 50000].forEach(n => {
  const subs = Array.from({ length: 100 }, (_, i) => `sub_${i}`);
  const rows = genTimelineRows(n, subs);
  const t = time(() => buildTimelineEntities(rows));
  console.log(`  ${n.toString().padStart(6)} records (100 entities): ${t}ms`);
});

// Vary entity count
[10, 50, 200, 500].forEach(subCount => {
  const subs = Array.from({ length: subCount }, (_, i) => `sub_${i}`);
  const rows = genTimelineRows(50000, subs);
  const t = time(() => buildTimelineEntities(rows));
  console.log(`  50000 records (${subCount} entities): ${t}ms`);
});

// ── LCS 100-Subject Profiling ──
// Simulates the actual meeting-detection flow: for each pair of subjects,
// if they have co-location events, runs LCS on their tower sequences.
console.log('\n=== LCS 100-Subject Profiling ===\n');

function genTowerSeqs(subCount, seqLen) {
  const towers = Array.from({ length: 20 }, (_, i) => `TWR${String(i + 1).padStart(3, '0')}`);
  return Array.from({ length: subCount }, () =>
    Array.from({ length: seqLen }, () => towers[rng(0, towers.length - 1)])
  );
}

function lcsAllPairs(seqs) {
  let pairsRun = 0;
  const n = seqs.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const m = seqs[i].length, nLen = seqs[j].length;
      let prev = new Uint16Array(nLen + 1), curr = new Uint16Array(nLen + 1);
      for (let k = 1; k <= m; k++) {
        for (let l = 1; l <= nLen; l++)
          curr[l] = seqs[i][k - 1] === seqs[j][l - 1] ? prev[l - 1] + 1 : Math.max(prev[l], curr[l - 1]);
        [prev, curr] = [curr, prev];
      }
      pairsRun++;
    }
  }
  return pairsRun;
}

// All 100 subjects, vary tower sequence length per subject
[50, 100, 500, 1000, 5000].forEach(seqLen => {
  const seqs = genTowerSeqs(100, seqLen);
  const t = time(() => lcsAllPairs(seqs));
  const pairs = 4950;
  console.log(`  100 subjects, ${seqLen} obs each (${pairs} pairs): ${t}ms (${t > 0 ? (t / pairs).toFixed(3) : 'N/A'}ms/pair)`);
});

// Worst case: all 100 subjects at the same 5 towers (max co-location = all pairs LCS)
console.log('  --- worst-case (all pairs share towers) ---');
[100, 500, 1000].forEach(seqLen => {
  const towers = Array.from({ length: 5 }, (_, i) => `TWR${String(i + 1).padStart(3, '0')}`);
  const seqs = Array.from({ length: 100 }, () =>
    Array.from({ length: seqLen }, () => towers[rng(0, towers.length - 1)])
  );
  const t = time(() => lcsAllPairs(seqs));
  console.log(`  100 subjects, ${seqLen} obs each (5 shared towers): ${t}ms`);
});

console.log('\nDone.');
