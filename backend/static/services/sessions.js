// services/sessions.js — the IPDR session-reconstruction engine (the analytics keystone shared by
// dashboard, timeline, profile, services, correlation, AI and investigation). classifySession scores
// a record cluster into a provider/service attribution; reconstructSessions buckets an entity's IPDR
// records into concurrent (counterpart, activity-family) tracks split on a family-adaptive idle gap,
// then classifies each track. Results are memoised in the shared session cache. Extracted from app.js
// (frontend services layer). Pure over its inputs — depends only on constants, the attribution
// helpers, utils and the shared cache. No behavior change.

import { IP_RANGES, EPHEMERAL_MIN, SERVICE_DB, DISTINCTIVE_INDICATORS, PORT_FAMILY, FAMILY_GAP } from '../core/constants.js';
import { fmtBytes } from '../core/utils.js';
import { state } from '../core/state.js';
import { ipInRange, isIspProvider, ipHint, trafficPattern } from './attribution.js';
import { sessionCache, clearAnalyticsCaches } from './cache.js';

function classifySession(recs){
  if(!recs.length)return null;
  const start=recs.reduce((e,r)=>!e||r.ts<e?r.ts:e,null);
  const end=recs.reduce((e,r)=>!e||r.ts>e?r.ts:e,null);
  const S=start?new Date(start):null,E=end?new Date(end):null;
  const durSec=S&&E?Math.round((E-S)/1000):recs.reduce((s,r)=>s+(r.dur||0),0);
  const ips=new Set(recs.map(r=>r.cnt).filter(i=>i&&i.includes('.')));
  const ipRanges=[...ips].map(ip=>ipInRange(ip,IP_RANGES)).filter(Boolean);
  const portSet=new Set();recs.forEach(r=>{const sp=parseInt(r.sport),dp=parseInt(r.dport);if(dp)portSet.add(dp);if(sp&&!(dp&&sp>=EPHEMERAL_MIN))portSet.add(sp)});
  const protos=new Set(recs.filter(r=>r.prot).map(r=>r.prot.toUpperCase()));
  const dur=recs.reduce((m,r)=>Math.max(m,r.dur||0),0);
  const totalDur=recs.reduce((s,r)=>s+(r.dur||0),0);
  const continuous=recs.length>3&&dur>10;
  const shortBurst=recs.length<=3&&totalDur<5;
  const dataVol=recs.some(r=>(r.bytesUp||0)+(r.bytesDn||0)>5e6);
  const upSum=recs.reduce((s,r)=>s+(r.bytesUp||0),0);
  const dnSum=recs.reduce((s,r)=>s+(r.bytesDn||0),0);
  const evidence=[];
  // Provider consensus
  const provCounts={},provSpec={};ipRanges.forEach(ir=>{provCounts[ir.provider]=(provCounts[ir.provider]||0)+1;if(!provSpec[ir.provider]||ir.specificity>provSpec[ir.provider])provSpec[ir.provider]=ir.specificity});
  // Sort by count, but always rank content providers ahead of access-network/ISP matches.
  const provEntries=Object.entries(provCounts).sort((a,b)=>{const ai=isIspProvider(a[0])?1:0,bi=isIspProvider(b[0])?1:0;if(ai!==bi)return ai-bi;return b[1]-a[1]});
  const primaryProv=provEntries.length?provEntries[0][0]:null;
  const mixedProv=provEntries.length>1;
  // Known IP hint check
  const hint=[...ips].map(ip=>ipHint(ip)).filter(Boolean);
  if(hint.length){
    const h=hint[0];
    evidence.push(h.provider+' '+h.service+' IP ('+h.activity+')');
    // Check behavioral consistency
    const tp=trafficPattern(durSec,upSum,dnSum,protos.size===1?[...protos][0]:null,portSet,recs.length,start?new Date(start).getHours():undefined);
    const actLabel=tp?tp.category:'Activity';
    evidence.push('Session: '+durSec+'s, '+recs.length+' records'+(tp?', pattern: '+tp.category:''));
    return{provider:h.provider,providerConfidence:96,tier:1,primary:{service:h.service,activity:h.activity+' '+actLabel},serviceLabel:h.service,activityLabel:h.activity+' — '+actLabel,serviceConfidence:95,candidates:[],evidence,start,end,duration:durSec,records:recs.length};
  }
  // Provider-specific session matching (Level 2 — Behavioral Fingerprinting)
  if(primaryProv){
    evidence.push(primaryProv+' IP range ('+ipRanges.length+' IPs, '+recs.length+' records, '+durSec+'s)');
    const prov=SERVICE_DB.find(p=>p.pr===primaryProv);
    if(prov){
      const tp=trafficPattern(durSec,upSum,dnSum,protos.size===1?[...protos][0]:null,portSet,recs.length,start?new Date(start).getHours():undefined);
      if(tp){tp.evidence.forEach(e=>evidence.push(e));evidence.unshift('Behavior: '+tp.category)}
      const scored=prov.services.map(svc=>{
        const allPorts=[...(svc.ports.tcp||[]),...(svc.ports.udp||[])];
        const pMatch=portSet.size>0&&[...portSet].some(p=>allPorts.includes(p));
        const protoMatch=protos.size>0&&[...protos].some(p=>svc.proto.includes(p));
        let score=75;
        if(pMatch)score+=15;
        if(protoMatch)score+=10;
        if(continuous)score+=4;
        if(dataVol)score+=5;
        if(shortBurst)score+=4;
        if(mixedProv)score=Math.round(score*0.7);
        // IP range specificity factor (tighter CIDR = more confidence)
        const specFactor=provSpec[primaryProv]||0.6;
        if(specFactor<0.8)score=Math.round(score*specFactor);
        // Category-based scoring with penalties
        if(tp&&svc.cats){
          if(svc.cats.includes(tp.category)){
            score+=15; // matching behavior category
          }else if(svc.cats.length>0&&tp.category!=='Network Traffic'&&tp.category!=='Presence'){
            score-=10; // penalty for non-matching specific activity
          }
        }
        // VPN services: penalize heavily for non-VPN traffic
        if(svc.cats&&svc.cats.length===1&&svc.cats[0]==='VPN'&&tp&&tp.category!=='VPN'){
          score-=25;
        }
        // Infrastructure-only services (empty cats): reduce for specific activities
        if(svc.cats&&svc.cats.length===0&&tp&&tp.category!=='Network Traffic'){
          score=Math.round(score*0.6);
        }
        // Distinctive indicators: strong multi-factor signatures
        const di=DISTINCTIVE_INDICATORS.find(d=>d.svc===svc.n);
        const diHit=di&&primaryProv&&di.check(primaryProv,protos.size===1?[...protos][0]:null,portSet,new Set(portSet));
        if(diHit){
          score+=15; // moderate service confidence boost
          evidence.push('Distinctive signature: '+svc.n+' ('+di.svc+')');
        }
        return{svc:svc.n,act:svc.acts[0],score,pMatch,protoMatch,behavior:tp?tp.activity:null,diHit};
      });
      scored.sort((a,b)=>b.score-a.score);
      const top=scored[0];
      const strong=scored.filter(s=>s.score>=top.score*0.85);
      let tier,serviceConfidence,providerConfidence,label,actLabel;
      const hasPortProto=scored.some(s=>s.pMatch||s.protoMatch);
      const hasBehavior=tp!==null;
      // Provider confidence: based on IP range specificity, consensus, ASN, distinctive indicators
      const specFactor=provSpec[primaryProv]||0.6;
      providerConfidence=Math.round(70+specFactor*25);
      if(provEntries.length===1)providerConfidence+=5;
      if(mixedProv)providerConfidence=Math.round(providerConfidence*0.85);
      // Distinctive indicator bonus for provider confidence (stronger than service)
      const hasDI=scored.some(s=>s.diHit);
      if(hasDI)providerConfidence+=10;
      providerConfidence=Math.min(95,Math.max(20,providerConfidence));
      // Service confidence: based on ports, protocol, behavior, indicators
      if(hasPortProto&&hasBehavior&&strong.length===1&&top.score>=100){tier=2;serviceConfidence=top.score;label='Likely '+top.svc;actLabel=top.act+' — '+(tp?tp.activity:'')}
      else if(hasPortProto&&strong.length===1){tier=2;serviceConfidence=Math.min(top.score,88);label='Likely '+top.svc;actLabel=top.act}
      else if(hasBehavior&&strong.length===1){tier=2;serviceConfidence=Math.min(top.score,82);label='Likely '+top.svc;actLabel=top.act+' Activity'}
      else if(hasPortProto&&strong.length>1){tier=4;serviceConfidence=Math.min(top.score,55);label=primaryProv+' ('+strong.map(s=>s.svc).join('/')+')';actLabel='Multiple: '+strong.map(s=>s.svc).join('/');top.svc=primaryProv;top.act='Multiple'}
      else if(hasBehavior&&!hasPortProto){tier=1;serviceConfidence=50;label=primaryProv+' Infrastructure';actLabel=tp?tp.activity:'Network Traffic';top.svc=primaryProv;top.act=tp?tp.activity:'Network Traffic'}
      else if(!hasPortProto&&!hasBehavior){tier=1;serviceConfidence=30;label=primaryProv+' Infrastructure';actLabel='Network Traffic';top.svc=primaryProv;top.act='Network Traffic'}
      else{tier=4;serviceConfidence=40;label='Unknown - '+primaryProv;actLabel='Possible Service'}
      // Cap service confidence at 95, floor at 5
      serviceConfidence=Math.min(95,Math.max(5,serviceConfidence));
      // Build evidence
      if(scored.some(s=>s.pMatch)){evidence.push('Port match: '+[...portSet].filter(p=>strong.some(s=>{const ap=[...(prov.services.find(x=>x.n===s.svc)?.ports.tcp||[]),...(prov.services.find(x=>x.n===s.svc)?.ports.udp||[])];return ap.includes(p)})).join(','))}
      if(scored.some(s=>s.protoMatch))evidence.push(protos.size?[...protos].join('/')+' protocol':'');
      if(portSet.size)evidence.push('Ports: '+[...portSet].join(','));
      if(tp)evidence.push('Pattern: '+tp.category+', '+tp.activity);
      if(continuous)evidence.push('Continuous session ('+durSec+'s)');
      if(dataVol)evidence.push('Data volume: '+fmtBytes(upSum+dnSum));
      if(!hasBehavior)evidence.push('Behavioral: no distinct activity pattern');
      if(strong.length>1)evidence.push('Candidates: '+strong.map(s=>s.svc+' ('+s.score+'%)').join(', '));
      const candidates=scored.map(s=>({service:s.svc,activity:s.act,score:s.score,behavior:s.behavior}));
      const dedupedEv=evidence.filter((v,i,a)=>a.indexOf(v)===i);
      return{provider:primaryProv,providerConfidence,tier,primary:{service:top.svc,activity:top.act},serviceLabel:label,activityLabel:actLabel,serviceConfidence,candidates,evidence:dedupedEv,start,end,duration:durSec,records:recs.length,recordsData:recs.map(r=>({ts:r.ts,type:r.type,cnt:r.cnt,tow:r.tow,lat:r.lat,lng:r.lng}))};
    }
  }
  // Fallback: port-only session attribution
  const genericPorts=[80,443,8080,8443,9443,10443];
  const hasOnlyGeneric=portSet.size>0&&[...portSet].every(p=>genericPorts.includes(p));
  if(hasOnlyGeneric||portSet.size===0)return{provider:'',providerConfidence:15,tier:4,primary:{service:'Unknown',activity:'Encrypted Traffic'},serviceLabel:'Unknown',activityLabel:'Encrypted Session',serviceConfidence:10,candidates:[],evidence:['No provider match — generic HTTPS session'],start,end,duration:durSec,records:recs.length};
  evidence.push('Distinctive port: '+[...portSet].join(','));
  if(continuous)evidence.push('Continuous traffic');
  return{provider:'',providerConfidence:10,tier:4,primary:{service:'Unknown',activity:'Unclassified'},serviceLabel:'Unknown',activityLabel:'Unclassified Session',serviceConfidence:8,candidates:[],evidence,start,end,duration:durSec,records:recs.length};
}
function recPortFamily(r){
  const dp=parseInt(r.dport),sp=parseInt(r.sport);
  return PORT_FAMILY[dp]||PORT_FAMILY[sp]||'Other';
}
// Reconstruct IPDR sessions for an entity. Records are bucketed into concurrent tracks
// keyed by (counterpart, activity family) so interleaved conversations form coherent
// parallel sessions instead of fragmenting, and each track splits on a family-adaptive
// idle gap rather than one fixed threshold.
export function reconstructSessions(entity){
  clearAnalyticsCaches();
  if(sessionCache[entity])return sessionCache[entity];
  // IPDR data sessions belong to IP subjects (source/destination IP), not to phone numbers —
  // CDR/IPDR are kept strictly separate, so a phone (CDR) subject is voice/SMS only and has no
  // data sessions of its own. Match the entity only as a source/destination IP; do NOT join
  // via msisdn (that pulled a subscriber's IPDR data into their CDR-phone timeline and showed
  // IPDR services where only voice should appear, and double-counted sessions).
  const ipdrs=((state.data.rowIdx.get(entity)||[])).filter(r=>r.type==='IPDR').sort((a,b)=>a.tsMs-b.tsMs);
  if(!ipdrs.length)return[];
  const open={};const sessions=[];
  const flush=k=>{const o=open[k];if(o&&o.recs.length){const cls=classifySession(o.recs);if(cls)sessions.push(cls)}delete open[k]};
  for(const r of ipdrs){
    // Peer = the destination service IP for the subject's own sessions; if the entity is
    // itself the destination IP, the peer is the source.
    const peer=(r.cnt===entity)?(r.sub||'?'):(r.cnt||'?');
    const fam=recPortFamily(r);
    const key=peer+'|'+fam;
    const ts=r.tsMs;
    const o=open[key];
    if(o&&ts-o.lastTs>(FAMILY_GAP[fam]||300)*1000){flush(key);open[key]={recs:[r],lastTs:ts}}
    else if(o){o.recs.push(r);o.lastTs=ts}
    else{open[key]={recs:[r],lastTs:ts}}
  }
  Object.keys(open).forEach(flush);
  sessions.sort((a,b)=>new Date(a.start)-new Date(b.start));
  return(sessionCache[entity]=sessions);
}
