// Frontend attribution-engine smoke test (node scripts/test_attribution_frontend.mjs).
// Mirrors the key backend fixtures in tests/test_attribution.py against the FRONTEND engine
// (static/services/attribution.js), so the two engines' behavior stays aligned: destination
// names the service, source only identifies the carrier, shared 250-port table, QUIC, and the
// ephemeral source-port guard.
import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.join(HERE, '..', 'static');

// attribution_data.js is a classic script defining `var ATTR_DATA` — evaluate it onto globalThis
// exactly as the browser would before the module graph loads.
const dataSrc = readFileSync(path.join(STATIC, 'attribution_data.js'), 'utf8');
(0, eval)(dataSrc);
globalThis.ATTR_DATA = ATTR_DATA;

const { matchService } = await import(pathToFileURL(path.join(STATIC, 'services', 'attribution.js')).href);

const rec = (o) => ({ sub: null, cnt: null, sport: null, dport: null, prot: null, dur: 0, bytesUp: 0, bytesDn: 0, ...o });

const FIXTURES = [
  ['meta_ip', rec({ cnt: '157.240.1.1', dport: 443, prot: 'TCP' }),
    (r) => r.provider === 'Meta'],
  ['jio_access', rec({ cnt: '49.40.1.2', dport: 443, prot: 'TCP' }),
    (r) => r.serviceLabel.includes('Jio') && r.serviceLabel.includes('Access Network')],
  ['meta_beats_jio', rec({ sub: '49.40.1.2', cnt: '157.240.1.1', dport: 443, prot: 'TCP' }),
    (r) => r.provider === 'Meta'],
  // POLICY: a content-provider SOURCE IP must never name the contacted service.
  ['src_not_service', rec({ sub: '157.240.1.1', cnt: '45.10.20.30', dport: 8333, prot: 'TCP' }),
    (r) => r.provider !== 'Meta'],
  ['cgnat_internal', rec({ cnt: '100.70.1.1', dport: 443, prot: 'TCP' }),
    (r) => r.category === 'internal' && r.serviceLabel.includes('CGNAT')],
  // Shared 250-port table now reachable from the frontend (was a ~30-port subset):
  ['dns_port', rec({ cnt: '45.10.20.30', dport: 53, prot: 'UDP' }),
    (r) => r.serviceLabel.includes('DNS')],
  ['vpn_port_category', rec({ cnt: '45.10.20.30', dport: 51820, prot: 'UDP' }),
    (r) => r.category === 'vpn'],
  ['tor_port_category', rec({ cnt: '45.10.20.30', dport: 9050, prot: 'TCP' }),
    (r) => r.category === 'anonymization'],
  ['mongodb_27018', rec({ cnt: '45.10.20.30', dport: 27018, prot: 'TCP' }),
    (r) => r.serviceLabel.includes('Database')],
  ['rdp_3389', rec({ cnt: '45.10.20.30', dport: 3389, prot: 'TCP' }),
    (r) => r.serviceLabel.includes('Remote Desktop')],
  ['quic_udp_443', rec({ cnt: '45.10.20.30', dport: 443, prot: 'UDP' }),
    (r) => JSON.stringify(r).includes('QUIC')],
  // Ephemeral source port must not masquerade as Teams/Discord when a real dest port exists.
  ['ephemeral_src', rec({ sub: '1.2.3.4', cnt: '45.10.20.30', sport: 50005, dport: 8333, prot: 'TCP' }),
    (r) => !r.serviceLabel.includes('Teams') && !r.serviceLabel.includes('Discord')],
];

let pass = 0;
const fails = [];
for (const [label, record, check] of FIXTURES) {
  let r;
  try { r = matchService(record); } catch (e) { fails.push([label, 'THREW: ' + e.message]); continue; }
  if (check(r)) pass++;
  else fails.push([label, r.serviceLabel + ' [' + (r.category || '?') + '] prov=' + (r.provider || '')]);
}
console.log(`frontend attribution: ${pass}/${FIXTURES.length} fixtures pass`);
if (fails.length) { for (const [l, got] of fails) console.log('  FAIL ' + l + ' → ' + got); process.exit(1); }
