// services/identity.js — per-subject identity resolution: links MSISDN / IMEI / IMSI over time and
// flags SIM swaps, device changes and combined changes. Extracted from app.js (frontend services
// layer). Owned-records only (a subject's own device/SIM), memoised in the shared identity cache.
// Depends only on the shared cache + the record-index helpers. No behavior change.

import { clearAnalyticsCaches, identCache } from './cache.js';
import { ownedRowsFor } from '../data/records.js';

// -- Identity Resolution --
// Builds per-subject identity profiles linking MSISDN, IMEI, IMSI
export function buildIdentityProfile(sub){
  clearAnalyticsCaches();
  if(identCache[sub])return identCache[sub];
  // Only records the subject OWNS (their own device/SIM) describe their identity. A
  // record where the subject is merely the counterpart (callee) carries the *other*
  // party's imei/imsi/msisdn — including those produced bogus "SIM swaps".
  const rows=ownedRowsFor(sub).filter(r=>(r.msisdn===sub||r.sub===sub)&&r.tsMs&&(r.imei||r.imsi||r.msisdn)).sort((a,b)=>a.tsMs-b.tsMs);
  const timeline=[]; // chronological (imei,imsi) state sequence (no dedup)
  const imeiHistory=[],imsiHistory=[];
  rows.forEach(r=>{
    const imei=r.imei||null,imsi=r.imsi||null,t=new Date(r.tsMs);
    if(!imei&&!imsi)return;
    const last=timeline.length?timeline[timeline.length-1]:null;
    if(!last||last.imei!==imei||last.imsi!==imsi)
      timeline.push({imei,imsi,firstSeen:t,lastSeen:t,records:1,msisdns:new Set(r.msisdn?[r.msisdn]:[])});
    else{last.lastSeen=t;last.records++;if(r.msisdn)last.msisdns.add(r.msisdn)}
    if(imei)imeiHistory.push({imei,imsi,time:t});
    if(imsi)imsiHistory.push({imsi,imei,time:t});
  });
  const changes=[];
  for(let i=1;i<timeline.length;i++){
    const p=timeline[i-1],c=timeline[i];
    if(p.imei!==null&&c.imei!==null&&p.imei===c.imei&&p.imsi!==null&&c.imsi!==null&&p.imsi!==c.imsi)
      changes.push({time:c.firstSeen,type:'sim_swap',from:p.imsi,to:c.imsi,detail:'SIM swap on '+p.imei,confidence:'high'});
    else if(p.imsi!==null&&c.imsi!==null&&p.imsi===c.imsi&&p.imei!==null&&c.imei!==null&&p.imei!==c.imei)
      changes.push({time:c.firstSeen,type:'device_change',from:p.imei,to:c.imei,detail:'Device change on '+p.imsi,confidence:'high'});
    else if(p.imei!==null&&c.imei!==null&&p.imsi!==null&&c.imsi!==null&&p.imei!==c.imei&&p.imsi!==c.imsi)
      changes.push({time:c.firstSeen,type:'combined_change',from:p.imei+'/'+p.imsi,to:c.imei+'/'+c.imsi,detail:'SIM+Device change',confidence:'high'});
    else if(p.imei!==null&&c.imei!==null&&p.imei!==c.imei)
      changes.push({time:c.firstSeen,type:'partial_device_change',from:p.imei,to:c.imei,detail:'IMEI change (no IMSI context)',confidence:'medium'});
    else if(p.imsi!==null&&c.imsi!==null&&p.imsi!==c.imsi)
      changes.push({time:c.firstSeen,type:'partial_sim_swap',from:p.imsi,to:c.imsi,detail:'IMSI change (no IMEI context)',confidence:'medium'});
  }
  // Build deduplicated identities for public API (same semantics as before)
  const seen=new Map(),identities=[];
  timeline.forEach(s=>{
    const k=s.imei+'|'+s.imsi;
    if(!seen.has(k)){
      seen.set(k,identities.length);
      identities.push({imei:s.imei,imsi:s.imsi,firstSeen:s.firstSeen,lastSeen:s.lastSeen,records:s.records,msisdns:[...s.msisdns]});
    }else{
      const idx=seen.get(k),id=identities[idx];
      if(s.lastSeen>id.lastSeen)id.lastSeen=s.lastSeen;
      if(s.firstSeen<id.firstSeen)id.firstSeen=s.firstSeen;
      id.records+=s.records;
      s.msisdns.forEach(m=>{if(!id.msisdns.includes(m))id.msisdns.push(m)});
    }
  });
  return(identCache[sub]={identities,changes});
}
