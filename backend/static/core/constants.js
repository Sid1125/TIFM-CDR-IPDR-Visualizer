// core/constants.js — cross-cutting lookup tables for the offline service/IP/port attribution
// engine. Derived from ATTR_DATA, the attribution database that attribution_data.js loads as a
// global (a classic <script>, so it executes before this module graph runs). Extracted verbatim
// from app.js (step 2 of the frontend modularization). No behavior change.
//
// NOTE: ATTR_DATA is referenced as a global here transitionally; a later step converts
// attribution_data.js to `export const ATTR_DATA` and imports it directly.

// -- Service Provider Database --
// Format: { provider, asn, domains, ranges, services: [{name, activities, ports:{tcp,udp}, proto}] }
export const SERVICE_DB=ATTR_DATA.providers;
// -- IP Range Lookup --
export const IP_RANGES=SERVICE_DB.flatMap(p=>(p.ranges||[]).map(c=>{const[r,bits]=c.split('/');const m=~(2**(32-parseInt(bits))-1)>>>0;const rn=r.split('.').reduce((s,o)=>(s*256+parseInt(o))>>>0,0);const pfx=parseInt(bits);return{mask:m,range:rn,provider:p.pr,raw:c,isp:!!p.isp,specificity:pfx>=24?1:pfx>=20?0.8:pfx>=16?0.6:0.4}}));
// Providers that are access networks (telecom/ISP), not content services. A match on
// these identifies the carrier, and must never override a real content-provider match.
export const ISP_PROVIDERS=new Set(SERVICE_DB.filter(p=>p.isp).map(p=>p.pr));
export const KNOWN_IP_HINTS=[{cidr:'8.8.8.0/24',prov:'Google',svc:'Google DNS',act:'DNS Resolution'},{cidr:'8.8.4.0/24',prov:'Google',svc:'Google DNS',act:'DNS Resolution'},{cidr:'1.1.1.0/24',prov:'Cloudflare',svc:'Cloudflare DNS',act:'DNS Resolution'},{cidr:'1.0.0.0/24',prov:'Cloudflare',svc:'Cloudflare DNS',act:'DNS Resolution'}].map(h=>{const[r,bits]=h.cidr.split('/');const m=~(2**(32-parseInt(bits))-1)>>>0;const rn=r.split('.').reduce((s,o)=>(s*256+parseInt(o))>>>0,0);return{mask:m,range:rn,...h}});
export const HOSTING_PROVIDERS=new Set(ATTR_DATA.constants.hosting_providers);
export const PRIVATE_LABEL={cgnat:'Carrier NAT (CGNAT)',private:'Private / Internal Network',loopback:'Loopback',link_local:'Link-Local'};
// -- Distinctive Indicators --
// Strong multi-factor signatures that add +30 to service score
export const DISTINCTIVE_INDICATORS=[
  {svc:'WhatsApp',check:(p,pr,pt,ps)=>p==='Meta'&&pr==='UDP'&&([3478,3479,3480].some(po=>ps.has(po)))},
  {svc:'Telegram',check:(p,pr,pt,ps)=>p==='Telegram'},
  {svc:'Google Meet',check:(p,pr,pt,ps)=>p==='Google'&&pr==='UDP'&&[19302,19303,19304,19305].some(po=>ps.has(po))},
  {svc:'MS Teams',check:(p,pr,pt,ps)=>p==='Microsoft'&&pr==='UDP'&&[3478,3479,3480,3481].some(po=>ps.has(po))},
  {svc:'Zoom',check:(p,pr,pt,ps)=>p==='Zoom'&&pr==='UDP'&&[8801,8810].some(po=>ps.has(po))},
  {svc:'FaceTime',check:(p,pr,pt,ps)=>p==='Apple'&&pr==='UDP'&&[16384,16387,3497].some(po=>ps.has(po))},
  {svc:'Steam',check:(p,pr,pt,ps)=>p==='Valve'&&([27000,27100,27015,27050].some(po=>ps.has(po)))},
  {svc:'NordVPN',check:(p,pr,pt,ps)=>p==='NordVPN'&&pr==='UDP'&&ps.has(1194)},
  {svc:'Mullvad',check:(p,pr,pt,ps)=>p==='Mullvad'&&pr==='UDP'&&ps.has(51820)},
];
// IANA dynamic/ephemeral port range. A connection's own source port is usually drawn from here,
// so a match on it is likely coincidental, not the real service.
export const EPHEMERAL_MIN=ATTR_DATA.constants.ephemeral_min;
export const PORT_SVC=ATTR_DATA.port_svc;
// Coarse activity family per port, used to pick session idle thresholds and to keep distinct
// activities to the same peer in separate sessions.
export const PORT_FAMILY=ATTR_DATA.port_families;
// Idle gap (seconds) that ends a session, tuned per activity: chatty/streaming flows tolerate
// long pauses; lookups/browsing are bursty.
export const FAMILY_GAP=ATTR_DATA.family_gaps;
