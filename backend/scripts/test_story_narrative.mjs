// Story narrative test (node scripts/test_story_narrative.mjs).
// Exercises buildStoryNarrative's day-grouped paragraph synthesis with synthetic events:
// activity events must be grouped into prose clauses, CDR rows into call/SMS sentences,
// days capped with an "omitted" note, and the case-wide overview left intact.
import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.join(HERE, '..', 'static');

// story.js's import chain reaches DOM modules (core/dom.js, core/events.js) and localStorage
// (workspace/evidence.js). Stub the browser surface it touches at import time.
const noopEl = new Proxy({}, { get: (t, k) => (k === 'addEventListener' || k === 'removeEventListener') ? () => {} : null });
globalThis.document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  createElement: () => noopEl,
  body: noopEl,
  documentElement: noopEl,
};
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.API = { get: async () => ({ subjects: [] }) };

const dataSrc = readFileSync(path.join(STATIC, 'attribution_data.js'), 'utf8');
(0, eval)(dataSrc);
globalThis.ATTR_DATA = ATTR_DATA;

const { state } = await import(pathToFileURL(path.join(STATIC, 'core', 'state.js')).href);
const { buildStoryNarrative } = await import(pathToFileURL(path.join(STATIC, 'story', 'story.js')).href);

let pass = 0;
const fails = [];
const check = (label, cond, got) => { if (cond) pass++; else fails.push([label, String(got).slice(0, 160)]); };

const SUB = '9998887777';
const day = (d, hm) => new Date(`2026-03-0${d}T${hm}:00`);

// Seed owned CDR rows: day 1 = 3 calls (2 to the same peer) + 1 SMS.
state.subjects = [SUB];
state.data.records = [
  { type: 'CDR', sub: SUB, cnt: '8887776666', ts: day(1, '09:10'), dur: 120, cll: 'VOICE' },
  { type: 'CDR', sub: SUB, cnt: '8887776666', ts: day(1, '11:40'), dur: 300, cll: 'VOICE' },
  { type: 'CDR', sub: SUB, cnt: '7776665555', ts: day(1, '14:05'), dur: 60, cll: 'VOICE' },
  { type: 'CDR', sub: SUB, cnt: '8887776666', ts: day(1, '15:00'), dur: 0, cll: 'SMS' },
];

const events = [
  { ts: day(1, '09:10'), kind: 'first', title: SUB + ' first appears in this case', detail: 'via call', sub: SUB },
  { ts: day(1, '09:10'), kind: 'call', title: 'Began contact with 8887776666', detail: '3 interactions', sub: SUB, cnt: '8887776666' },
  // Two identical activity titles on day 2 -> must group into one clause.
  { ts: day(2, '21:31'), end: day(2, '21:58'), kind: 'activity', title: 'Probable WhatsApp Voice Call', detail: '', sub: SUB, conf: 86, dur: 1620 },
  { ts: day(2, '23:05'), end: day(2, '23:12'), kind: 'activity', title: 'Probable WhatsApp Voice Call', detail: '', sub: SUB, conf: 78, dur: 420 },
  { ts: day(2, '22:10'), kind: 'meeting', title: 'Co-located with 7776665555', detail: 'tower TWR1 · 4m gap · High confidence', sub: SUB, cnt: '7776665555' },
  { ts: day(3, '10:00'), kind: 'move', title: 'First seen at tower TWR9', detail: 'Delhi', sub: SUB, tow: 'TWR9' },
];

const html = buildStoryNarrative(SUB, events);

check('intro_present', html.includes('first appears in this case'), html);
check('day_headers', /(1 March 2026|March 1, 2026)/.test(html) && /(2 March 2026|March 2, 2026)/.test(html), html);
check('calls_sentence', /made or received <b>3<\/b> calls/.test(html), html);
check('top_peer', html.includes('8887776666'), html);
check('sms_sentence', /<b>1<\/b> SMS message/.test(html), html);
check('activity_grouped', /<b>2<\/b> sessions read as <b>probable WhatsApp Voice Call<\/b>/.test(html), html);
check('activity_confidence', html.includes('86% confidence') || html.includes('up to 86%'), html);
check('meeting_clause', html.includes('co-located with 7776665555'), html);
check('movement_clause', html.includes('TWR9'), html);
check('prose_shape', html.includes('The subject '), html);

// Day cap: 40 active days -> at most 10 day paragraphs + an omitted note.
{
  const manyEvents = [];
  const recs = [];
  for (let i = 0; i < 40; i++) {
    const t = new Date(Date.UTC(2026, 2, 1 + i, 10, 0));
    recs.push({ type: 'CDR', sub: SUB, cnt: '111', ts: t, dur: 60, cll: 'VOICE' });
    manyEvents.push({ ts: t, kind: 'activity', title: 'Probable VPN Tunnel', detail: '', sub: SUB, conf: 80, dur: 600 });
  }
  state.data.records = recs;
  const big = buildStoryNarrative(SUB, manyEvents);
  const dayCount = (big.match(/story-para-day/g) || []).length;
  check('day_cap', dayCount <= 10, dayCount + ' day paragraphs');
  check('omitted_note', big.includes('omitted for brevity'), big.slice(-200));
}

// Case-wide overview unchanged in spirit.
{
  state.data.records = [];
  const overview = buildStoryNarrative('__all__', []);
  check('overview', overview.includes('This case spans'), overview);
}

console.log(`story narrative: ${pass}/${pass + fails.length} checks pass`);
if (fails.length) { for (const [l, got] of fails) console.log('  FAIL ' + l + ' → ' + got); process.exit(1); }
