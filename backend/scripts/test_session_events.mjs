// Frontend session -> activity-event overlay test (node scripts/test_session_events.mjs).
// Mirrors backend tests/test_activity_events.py against the FRONTEND session engine
// (services/sessions.js): the session-level fingerprint must see what per-record
// classification can't, titles must be investigation-shaped, confidence fused/explainable.
import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.join(HERE, '..', 'static');

const dataSrc = readFileSync(path.join(STATIC, 'attribution_data.js'), 'utf8');
(0, eval)(dataSrc);
globalThis.ATTR_DATA = ATTR_DATA;

const { state } = await import(pathToFileURL(path.join(STATIC, 'core', 'state.js')).href);
const { sessionCache } = await import(pathToFileURL(path.join(STATIC, 'services', 'cache.js')).href);
const { reconstructSessions } = await import(pathToFileURL(path.join(STATIC, 'services', 'sessions.js')).href);

const BASE = Date.parse('2026-03-01T21:31:00');
const rec = (i, offsetS, o) => {
  const ts = new Date(BASE + offsetS * 1000).toISOString();
  return { type: 'IPDR', sub: '100.70.1.9', cnt: '157.240.1.1', sport: 50000 + i, dport: 3478,
    prot: 'UDP', dur: 50, bytesUp: 150000, bytesDn: 170000, ts, tsMs: BASE + offsetS * 1000, ...o };
};

function run(entity, recs) {
  // Fresh per scenario: the session cache is keyed by entity and only auto-clears when the
  // loaded record COUNT changes, so scenarios with equal counts would otherwise collide.
  Object.keys(sessionCache).forEach(k => delete sessionCache[k]);
  state.data.records = recs;
  state.data.rowIdx = new Map([[entity, recs]]);
  return reconstructSessions(entity);
}

let pass = 0;
const fails = [];
const check = (label, cond, got) => { if (cond) pass++; else fails.push([label, got]); };

// 27 minutes of steady symmetric UDP/3478 to a Meta IP over 27 small records — no single
// record looks like a call; the session must.
{
  const recs = Array.from({ length: 27 }, (_, i) => rec(i, i * 60));
  const sessions = run('100.70.1.9', recs);
  check('one_session', sessions.length === 1, sessions.length + ' sessions');
  const s = sessions[0] || {};
  check('whatsapp_call_title', s.eventTitle === 'Probable WhatsApp Voice Call', s.eventTitle);
  check('call_confidence', s.eventConfidence >= 80 && s.eventConfidence <= 96, s.eventConfidence);
  check('confidence_parts', s.confidenceParts && 'behavior' in s.confidenceParts, JSON.stringify(s.confidenceParts));
  const ev = (s.evidence || []).join(' | ');
  check('flow_evidence', ev.includes('bidirectional'), ev.slice(0, 120));
  check('fingerprint_evidence', ev.includes('Behavioral fingerprint'), ev.slice(0, 120));
}

// Bulk download: TCP 443, download-heavy, big volume.
{
  const recs = Array.from({ length: 8 }, (_, i) => rec(i, i * 30, {
    cnt: '45.10.20.30', dport: 443, prot: 'TCP', bytesUp: 50000, bytesDn: 40000000, dur: 25 }));
  const s = run('100.70.1.9', recs)[0] || {};
  check('bulk_download_title', s.eventTitle === 'Probable Large Download', s.eventTitle);
  check('download_heavy', (s.evidence || []).join('|').includes('download-heavy'), (s.evidence || []).join('|').slice(0, 120));
}

// Tiny session must never claim a named app.
{
  const s = run('100.70.1.9', [rec(0, 0, { cnt: '45.10.20.30', dport: 4999, prot: 'TCP', bytesUp: 100, bytesDn: 200, dur: 2 })])[0] || {};
  const bad = ['WhatsApp', 'Zoom', 'Teams', 'Telegram'].some(a => (s.eventTitle || '').includes(a));
  check('tiny_no_app_claim', !bad, s.eventTitle);
}

// Carrier destination: mobile-data phrasing.
{
  const s = run('100.70.1.9', [rec(0, 0, { cnt: '49.40.1.2', dport: 443, prot: 'TCP', dur: 30 })])[0] || {};
  check('carrier_title', (s.eventTitle || '').startsWith('Mobile data session'), s.eventTitle);
}

console.log(`session events: ${pass}/${pass + fails.length} checks pass`);
if (fails.length) { for (const [l, got] of fails) console.log('  FAIL ' + l + ' → ' + got); process.exit(1); }
