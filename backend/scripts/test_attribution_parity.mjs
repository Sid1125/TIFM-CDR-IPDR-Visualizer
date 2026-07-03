// Attribution engine PARITY test (node scripts/test_attribution_parity.mjs).
// Replays the backend-generated fixture corpus (attribution_parity_fixtures.json, produced by
// gen_attribution_parity.py) through the FRONTEND engine and asserts the two engines agree.
// Modes: exact (label+subtype+confidence+category), access (carrier label+conf+category),
// provider (provider identity + category — frontend does deeper per-service scoring by design).
import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.join(HERE, '..', 'static');

const dataSrc = readFileSync(path.join(STATIC, 'attribution_data.js'), 'utf8');
(0, eval)(dataSrc);
globalThis.ATTR_DATA = ATTR_DATA;

const { matchService } = await import(pathToFileURL(path.join(STATIC, 'services', 'attribution.js')).href);

const fixtures = JSON.parse(readFileSync(path.join(HERE, 'attribution_parity_fixtures.json'), 'utf8'));

let pass = 0;
const fails = [];
for (const f of fixtures) {
  const rec = { sub: null, cnt: null, sport: null, dport: null, prot: null, dur: 0, bytesUp: 0, bytesDn: 0, ...f.input };
  let r;
  try { r = matchService(rec); } catch (e) { fails.push([f.name, 'THREW: ' + e.message]); continue; }
  const e = f.expected;
  const problems = [];
  if (f.mode === 'exact') {
    if (r.serviceLabel !== e.service) problems.push(`service '${r.serviceLabel}' != '${e.service}'`);
    if (r.activityLabel !== e.subtype) problems.push(`subtype '${r.activityLabel}' != '${e.subtype}'`);
    if (r.serviceConfidence !== e.confidence) problems.push(`confidence ${r.serviceConfidence} != ${e.confidence}`);
    if (r.category !== e.category) problems.push(`category '${r.category}' != '${e.category}'`);
  } else if (f.mode === 'access') {
    if (r.serviceLabel !== e.service) problems.push(`service '${r.serviceLabel}' != '${e.service}'`);
    if (r.serviceConfidence !== e.confidence) problems.push(`confidence ${r.serviceConfidence} != ${e.confidence}`);
    if (r.category !== e.category) problems.push(`category '${r.category}' != '${e.category}'`);
  } else { // provider
    if (r.provider !== e.family) problems.push(`provider '${r.provider}' != '${e.family}'`);
    if (r.category !== e.category) problems.push(`category '${r.category}' != '${e.category}'`);
    if ((r.asn || null) !== (e.asn ?? null)) problems.push(`asn ${r.asn} != ${e.asn}`);
    if ((r.country || null) !== (e.country ?? null)) problems.push(`country '${r.country}' != '${e.country}'`);
  }
  if (problems.length) fails.push([f.name, problems.join('; ')]);
  else pass++;
}

console.log(`attribution parity: ${pass}/${fixtures.length} fixtures agree between engines`);
if (fails.length) {
  for (const [name, why] of fails) console.log('  DIVERGE ' + name + ' → ' + why);
  process.exit(1);
}
