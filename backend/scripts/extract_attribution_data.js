// One-time bootstrap: extract the attribution knowledge base out of static/app.js
// into the canonical backend/app/data/attribution_data.json. After this, the JSON is
// the single source of truth; scripts/gen_attribution_js.py regenerates the frontend copy.
const fs = require('fs');
const path = require('path');

const appJs = path.join(__dirname, '..', 'static', 'app.js');
const outJson = path.join(__dirname, '..', 'app', 'data', 'attribution_data.json');
const src = fs.readFileSync(appJs, 'utf8');

// Extract `const NAME = <expr>;` honoring brace/bracket depth and skipping string contents.
function extractConst(name) {
  const at = src.indexOf('const ' + name + '=');
  if (at < 0) throw new Error('not found: ' + name);
  const eq = src.indexOf('=', at) + 1;
  let depth = 0, end = -1, inStr = false, q = '';
  for (let i = eq; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === q && src[i - 1] !== '\\') inStr = false;
      continue;
    }
    if (c === "'" || c === '"') { inStr = true; q = c; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === ';' && depth === 0) { end = i; break; }
  }
  return eval('(' + src.slice(eq, end) + ')');
}

const SERVICE_DB = extractConst('SERVICE_DB');
const PORT_SVC = extractConst('PORT_SVC');
const PORT_FAMILY = extractConst('PORT_FAMILY');
const FAMILY_GAP = extractConst('FAMILY_GAP');
const HOSTING = ['Alibaba Cloud', 'Hetzner', 'Vultr', 'DigitalOcean', 'OVH', 'Oracle'];

for (const p of SERVICE_DB) {
  if (HOSTING.includes(p.pr)) p.hosting = true;
}

const data = {
  providers: SERVICE_DB,
  port_svc: PORT_SVC,
  port_families: PORT_FAMILY,
  family_gaps: FAMILY_GAP,
  constants: {
    ephemeral_min: 49152,
    cgnat: '100.64.0.0/10',
    hosting_providers: HOSTING,
    generic_families: ['Web', 'Encrypted Web/App'],
  },
};

fs.mkdirSync(path.dirname(outJson), { recursive: true });
fs.writeFileSync(outJson, JSON.stringify(data, null, 2));
console.log('providers:', SERVICE_DB.length, '| isp:', SERVICE_DB.filter(p => p.isp).length,
  '| hosting:', SERVICE_DB.filter(p => p.hosting).length, '| with ranges:', SERVICE_DB.filter(p => p.ranges && p.ranges.length).length);
console.log('port_svc:', Object.keys(PORT_SVC).length, '| port_families:', Object.keys(PORT_FAMILY).length, '| family_gaps:', Object.keys(FAMILY_GAP).length);
