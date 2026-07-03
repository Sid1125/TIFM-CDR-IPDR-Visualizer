// analytics/dossier.js — the Court-Ready Dossier: composes a styled, print-optimised case dossier
// (cover / letterhead, executive summary, narrative, persons of interest, key findings, comms, cross-
// case links, bookmarked evidence, charts, towers, methodology appendix) from data already in state,
// for Print -> Save as PDF. Air-gapped: no PDF lib, only our own endpoints. Extracted from app.js
// (feature layer). Pulls the story engine (narrative/xcase), inference, meetings, identity and the
// evidence board. Exports renderDossier (app.js injects it into the evidence board). No behavior change.

import { esc, n, _fmtDT } from '../core/utils.js';
import { D } from '../core/dom.js';
import { state } from '../core/state.js';
import { API } from '../core/api.js';
import { subjLabel } from '../core/subjects.js';
import { rowsFor, towerMeta, _totalCdrFn, _totalIpdrFn } from '../data/records.js';
import { buildIdentityProfile } from '../services/identity.js';
import { getInfReport, INF } from '../services/inference.js';
import { ensureMeetingsLoaded, meetingTotals, meetingsCache } from '../services/meetings.js';
import { evLoad, EVK } from '../workspace/evidence.js';
import { getStoryXcase, buildCaseEvents, buildStoryNarrative, resetStory } from '../story/story.js';

if(D.dossierBtn)D.dossierBtn.addEventListener('click',renderDossier);
if(D.dossierCloseBtn)D.dossierCloseBtn.addEventListener('click',()=>{D.dossier.style.display='none'});
if(D.dossierPrintBtn)D.dossierPrintBtn.addEventListener('click',()=>window.print());
{const ab=document.getElementById('dossierAgencyBtn');if(ab)ab.addEventListener('click',setAgencyDetails);}
{const rb=document.getElementById('dossierRegenBtn');if(rb)rb.addEventListener('click',()=>{resetStory();INF.report=null;meetingsCache.v=null;renderDossier();});}

// All-seeing-eye seal (Argus Panoptes) rendered in monochrome navy so it prints cleanly.
const ARGUS_EMBLEM='<svg class="dc-emblem" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-label="ARGUS emblem">'
  +'<circle cx="50" cy="50" r="47" fill="#fff" stroke="#16284a" stroke-width="2"/>'
  +'<circle cx="50" cy="50" r="41" fill="none" stroke="#16284a" stroke-width="0.9"/>'
  +'<path d="M16 50 Q50 26 84 50 Q50 74 16 50 Z" fill="none" stroke="#16284a" stroke-width="2.6"/>'
  +'<circle cx="50" cy="50" r="11" fill="#16284a"/><circle cx="50" cy="50" r="4.2" fill="#fff"/>'
  +'<g stroke="#16284a" stroke-width="1.7" stroke-linecap="round">'
  +'<path d="M50 16 V7"/><path d="M50 84 V93"/><path d="M16 50 H7"/><path d="M84 50 H93"/>'
  +'<path d="M27 27 L21 21"/><path d="M73 27 L79 21"/><path d="M27 73 L21 79"/><path d="M73 73 L79 79"/></g></svg>';

function getAgency(){try{return JSON.parse(localStorage.getItem('argus_agency')||'{}')||{}}catch(e){return{}}}
function setAgencyDetails(){
  const a=getAgency();
  const name=prompt('Agency / unit name for the dossier letterhead:',a.name||'');if(name===null)return;
  const sub=prompt('Sub-line (e.g. "Telecom Forensics Unit · Cyber Crime Cell"):',a.sub||'');if(sub===null)return;
  const logo=prompt('Optional logo image URL or /static path (blank = ARGUS emblem):',a.logo||'');if(logo===null)return;
  localStorage.setItem('argus_agency',JSON.stringify({name:name.trim(),sub:(sub||'').trim(),logo:(logo||'').trim()}));
  alert('Saved. Regenerate the dossier to apply.');
}

export async function renderDossier(){
  if(!state.data.records.length){alert('Load a case first — there is nothing to put in a dossier yet.');return}
  const prev=D.dossierBtn.textContent;D.dossierBtn.textContent='Building…';D.dossierBtn.disabled=true;
  try{
    const caseName=(D.caseSelector.options[D.caseSelector.selectedIndex]?.text||'None').replace(/\s*\(\d+\)\s*$/,'');
    const officer=state.auth&&state.auth.user?state.auth.user.username:'Unknown';
    const role=state.auth&&state.auth.user?state.auth.user.role:'';
    const now=new Date();
    const ag=getAgency();
    const agencyName=(ag.name||'LAW ENFORCEMENT AGENCY').toUpperCase();
    const agencySub=ag.sub||'Telecom Forensics Unit';
    const CLASS='RESTRICTED — FOR OFFICIAL USE ONLY';
    // Official reference id + chain-of-custody log (best-effort; dossier still renders if it fails).
    let ref='';let serverCase=caseName;
    try{const r=await API.post('/inference/dossier'+(state.data.caseId?'?case_id='+encodeURIComponent(state.data.caseId):''),{});if(r){ref=r.ref||'';if(r.case_name)serverCase=r.case_name;}}catch(e){}
    if(!ref)ref='ARGUS-EVD-'+now.toISOString().slice(0,10).replace(/-/g,'')+'-LOCAL';

    // Ensure analytical inputs are loaded for the narrative / summary.
    try{await ensureMeetingsLoaded();}catch(e){}
    try{await getInfReport();}catch(e){}
    const xrep=await getStoryXcase();

    const ts=state.data.records.filter(r=>r.ts).map(r=>new Date(r.ts).getTime()).filter(t=>!isNaN(t));
    const minD=ts.length?new Date(Math.min(...ts)):null,maxD=ts.length?new Date(Math.max(...ts)):null;
    const dr=ts.length?(minD.toLocaleString()+'  —  '+maxD.toLocaleString()):'—';
    const spanDays=ts.length?Math.max(1,Math.round((Math.max(...ts)-Math.min(...ts))/86400000)):0;

    // Per-subject rollup.
    const subStat={};
    state.data.records.forEach(r=>{const s=r.sub;if(!s)return;const o=subStat[s]||(subStat[s]={n:0,c:new Set(),t:new Set(),type:r.type});o.n++;if(r.cnt&&r.cnt!==s)o.c.add(r.cnt);if(r.tow)o.t.add(r.tow);});
    const subjects=Object.entries(subStat).map(([s,o])=>({s,n:o.n,c:o.c.size,t:o.t.size,type:o.type})).sort((a,b)=>b.n-a.n);
    const topSub=subjects.length?subjects[0].s:null;
    const caseTowerN=new Set(state.data.records.filter(r=>r.tow).map(r=>r.tow)).size; // towers in THIS case (not the global repo)
    const topCnt=Object.entries(state.data.records.reduce((a,r)=>{if(r.cnt&&r.cnt!==r.sub){a[r.cnt]=(a[r.cnt]||0)+1}return a},{})).sort((a,b)=>b[1]-a[1]).slice(0,15);

    const mt=(typeof meetingTotals==='function')?meetingTotals():{total:0};
    const xcount=(xrep&&xrep.subjects)?xrep.subjects.length:0;
    const rep=INF.report||{};const poi=((rep.cdr&&rep.cdr.risk)||[]).filter(r=>r.band==='Critical'||r.band==='High').length;
    const imposs=((rep.cdr&&rep.cdr.impossible_travel)||[]).length;
    const ev=evLoad();

    let h='';
    // ── Cover / letterhead ──
    const logoHtml=ag.logo?('<img class="dc-emblem" src="'+esc(ag.logo)+'" alt="agency logo">'):ARGUS_EMBLEM;
    h+='<section class="dossier-cover">'
      +'<div class="dc-class-top">'+CLASS+'</div>'
      +'<div class="dc-letterhead">'+logoHtml
        +'<div class="dc-agency"><div class="dc-agency-name">'+esc(agencyName)+'</div><div class="dc-agency-sub">'+esc(agencySub)+'</div>'
        +'<div class="dc-agency-tool">Project ARGUS · CDR / IPDR Forensic Analysis Platform</div></div></div>'
      +'<div class="dc-rule"></div>'
      +'<div class="dc-doctype">CASE ANALYSIS DOSSIER</div>'
      +'<h1 class="dc-title">'+esc(serverCase)+'</h1>'
      +'<table class="dc-meta">'
      +'<tr><td>Document reference</td><td><b>'+esc(ref)+'</b></td></tr>'
      +'<tr><td>Case</td><td>'+esc(serverCase)+(state.data.caseId?' (ID '+esc(state.data.caseId)+')':'')+'</td></tr>'
      +'<tr><td>Prepared by</td><td>'+esc(officer)+(role?' ('+esc(role)+')':'')+'</td></tr>'
      +'<tr><td>Date / time generated</td><td>'+esc(now.toLocaleString())+'</td></tr>'
      +'<tr><td>Evidence window</td><td>'+esc(dr)+'</td></tr>'
      +'<tr><td>Records examined</td><td>'+n(_totalCdrFn()+_totalIpdrFn())+' ('+n(_totalCdrFn())+' CDR, '+n(_totalIpdrFn())+' IPDR)</td></tr>'
      +'<tr><td>Subjects / towers</td><td>'+n(state.subjects.length)+' subjects · '+n(caseTowerN)+' towers in this case</td></tr>'
      +'<tr><td>Classification</td><td>'+CLASS+'</td></tr>'
      +'</table>'
      +'<div class="dc-control"><b>Document control.</b> This dossier was generated programmatically by Project ARGUS from the telecom records loaded into the named case under reference <b>'+esc(ref)+'</b>, which is recorded in the system audit log (chain of custody). It is an investigative aid and does not by itself constitute proof; all findings should be corroborated with the underlying CDR/IPDR records and primary evidence before being relied upon in proceedings.</div>'
      +'<div class="dc-class-bottom">'+CLASS+'</div>'
      +'</section>';

    // ── Analytical inputs (case-specific) ──
    const repC=(rep.cdr)||{},repI=(rep.ipdr)||{};
    const riskMap={};(repC.risk||[]).forEach(r=>{riskMap[r.subject]={score:r.score,band:r.band,kind:'phone'}});(repI.risk||[]).forEach(r=>{if(!riskMap[r.subject])riskMap[r.subject]={score:r.score,band:r.band,kind:'ip'}});
    // Persons of interest: risk-ranked, falling back to activity.
    const poiList=subjects.slice().sort((a,b)=>((riskMap[b.s]?riskMap[b.s].score:0)-(riskMap[a.s]?riskMap[a.s].score:0))||(b.n-a.n)).slice(0,8);
    // Case-only towers (distinct tower_ids appearing in THIS case's records) with activity counts.
    const tm=towerMeta();const towCount={};state.data.records.forEach(r=>{if(r.tow)towCount[r.tow]=(towCount[r.tow]||0)+1;});
    const caseTowers=Object.entries(towCount).map(([tw,c])=>({tw,c,city:(tm[tw]||{}).city,state:(tm[tw]||{}).state})).sort((a,b)=>b.c-a.c);
    // Identity changes across subjects (SIM / handset swaps).
    const idChanges=[];(state.subjects||[]).slice(0,400).forEach(s=>{try{(buildIdentityProfile(s).changes||[]).forEach(c=>idChanges.push({sub:s,time:c.time,detail:c.detail,from:c.from,to:c.to,confidence:c.confidence}))}catch(e){}});
    idChanges.sort((a,b)=>new Date(a.time)-new Date(b.time));
    const meetingsList=((meetingsCache.v&&meetingsCache.v.list)||[]).slice().sort((a,b)=>b.score-a.score);
    const impossible=(repC.impossible_travel||[]);
    const hidden=(repC.co_presence||[]).filter(p=>p.hidden_link||p.convoy);

    // ── Table of contents ──
    h+='<section class="dossier-section"><h2>Contents</h2><ol class="dossier-toc">'
      +'<li>Executive Summary</li><li>Case Narrative</li><li>Persons of Interest</li>'
      +'<li>Key Findings</li><li>Communication Analysis</li><li>Cross-Case Links</li>'
      +'<li>Bookmarked Evidence</li><li>Analytical Charts</li><li>Towers in this Case</li>'
      +'<li>Appendix A — Methodology &amp; Limitations</li></ol></section>';

    // ── 1. Executive summary ──
    const headline=[];
    if(poi)headline.push(n(poi)+' person(s) of interest at High/Critical risk');
    if(mt.total)headline.push(n(mt.total)+' co-location meeting(s)');
    if(imposs)headline.push(n(imposs)+' impossible-travel flag(s)');
    if(idChanges.length)headline.push(n(idChanges.length)+' identity change(s)');
    if(xcount)headline.push(n(xcount)+' subject(s) linked to other cases');
    if(hidden.length)headline.push(n(hidden.length)+' hidden link/convoy pattern(s)');
    h+='<section class="dossier-section"><h2>1. Executive Summary</h2>'
      +'<p class="d-app">This case comprises <b>'+n(_totalCdrFn()+_totalIpdrFn())+'</b> telecom records ('+n(_totalCdrFn())+' CDR, '+n(_totalIpdrFn())+' IPDR) across <b>'+n(state.subjects.length)+'</b> subjects over <b>'+n(spanDays)+'</b> day(s) ('+esc(dr)+'). '
      +(headline.length?'Automated analysis surfaced: '+headline.join('; ')+'.':'No high-severity anomalies were automatically flagged.')+'</p>'
      +'<table class="d-kv">'
      +'<tr><td>Evidence window</td><td>'+esc(dr)+' ('+n(spanDays)+' day'+(spanDays===1?'':'s')+')</td></tr>'
      +'<tr><td>Records examined</td><td>'+n(_totalCdrFn()+_totalIpdrFn())+' — '+n(_totalCdrFn())+' CDR, '+n(_totalIpdrFn())+' IPDR</td></tr>'
      +'<tr><td>Distinct subjects / case towers</td><td>'+n(state.subjects.length)+' subjects · '+n(caseTowers.length)+' towers touched</td></tr>'
      +'<tr><td>Persons of interest (High/Critical)</td><td>'+n(poi)+'</td></tr>'
      +'<tr><td>Co-location meetings</td><td>'+n(mt.total||0)+'</td></tr>'
      +'<tr><td>Impossible-travel flags</td><td>'+n(imposs)+'</td></tr>'
      +'<tr><td>Identity changes (SIM/handset)</td><td>'+n(idChanges.length)+'</td></tr>'
      +'<tr><td>Subjects linked to other cases</td><td>'+n(xcount)+'</td></tr>'
      +'<tr><td>Bookmarked evidence items</td><td>'+n(ev.length)+'</td></tr>'
      +'</table></section>';

    // ── 2. Case narrative ──
    let narr='';
    try{if(topSub){const evs=await buildCaseEvents(topSub);narr='<p class="d-narr-lead">Principal subject (by activity): <b>'+esc(topSub)+'</b>.</p>'+buildStoryNarrative(topSub,evs);}else{narr=buildStoryNarrative('__all__',[]);}}catch(e){narr='<div class="d-note">Narrative unavailable.</div>';}
    h+='<section class="dossier-section"><h2>2. Case Narrative</h2><div class="d-narr">'+narr+'</div>'
      +'<div class="d-note">Auto-reconstructed from the chronological record. See the Story tab for the full timeline and other subjects.</div></section>';

    // ── 3. Persons of interest (detailed) ──
    h+='<section class="dossier-section"><h2>3. Persons of Interest</h2>';
    // Prefetch subscriber (SDR) identities for the profiled POIs.
    let _sdrMap={};
    try{const fs2=await Promise.all(poiList.map(p=>API.get('/subscribers/'+encodeURIComponent(p.s)).catch(()=>null)));poiList.forEach((p,idx)=>{const f=fs2[idx];if(f&&f.found)_sdrMap[p.s]=f;});}catch(e){}
    if(poiList.length){
      poiList.forEach((p,i)=>{
        const sub=p.s;const rk=riskMap[sub];
        const owned=state.data.records.filter(r=>r.ts&&(r.sub===sub||r.msisdn===sub));
        const tms=rowsFor(sub).filter(r=>r.ts).map(r=>new Date(r.ts).getTime());
        const fs=tms.length?new Date(Math.min(...tms)):null,ls=tms.length?new Date(Math.max(...tms)):null;
        let idents=[],changes=[];try{const ip=buildIdentityProfile(sub);idents=ip.identities||[];changes=ip.changes||[];}catch(e){}
        const cc={};owned.filter(r=>r.cnt&&r.cnt!==sub).forEach(r=>cc[r.cnt]=(cc[r.cnt]||0)+1);
        const topc=Object.entries(cc).sort((a,b)=>b[1]-a[1]).slice(0,5);
        const tc={};owned.forEach(r=>{if(r.tow)tc[r.tow]=(tc[r.tow]||0)+1});
        const topt=Object.entries(tc).sort((a,b)=>b[1]-a[1]).slice(0,5);
        const mts=meetingsList.filter(m=>m.subA===sub||m.subB===sub);
        const xs=((xrep&&xrep.subjects)||[]).find(x=>x.subject===sub);
        h+='<div class="d-poi"><div class="d-poi-h"><span class="d-poi-n">POI '+(i+1)+'</span> <b>'+subjLabel(sub)+'</b> <span class="d-poi-type">'+esc(p.type)+'</span>'
          +(rk?' <span class="d-poi-risk d-risk-'+esc((rk.band||'').toLowerCase())+'">Risk: '+esc(rk.band||'')+' ('+n(rk.score||0)+')</span>':'')+'</div>';
        h+='<table class="d-kv">'
          +'<tr><td>Activity</td><td>'+n(p.n)+' records · '+n(p.c)+' contacts · '+n(p.t)+' towers</td></tr>'
          +'<tr><td>First / last seen</td><td>'+(fs?esc(_fmtDT(fs)):'—')+'  →  '+(ls?esc(_fmtDT(ls)):'—')+'</td></tr>';
        {const sdr=_sdrMap[sub];if(sdr)h+='<tr><td>Subscriber (SDR)</td><td>'+[sdr.name,sdr.address,sdr.alt_number?('Alt: '+sdr.alt_number):'',sdr.id_proof,sdr.operator].filter(Boolean).map(esc).join(' &middot; ')+'</td></tr>';}
        if(idents.length)h+='<tr><td>Devices / SIMs</td><td>'+idents.slice(0,4).map(d=>'IMEI '+esc(d.imei||'—')+' / IMSI '+esc(d.imsi||'—')).join('<br>')+'</td></tr>';
        if(topc.length)h+='<tr><td>Top contacts</td><td>'+topc.map(([c,k])=>esc(c)+' ('+n(k)+')').join(', ')+'</td></tr>';
        if(topt.length)h+='<tr><td>Top towers</td><td>'+topt.map(([t,k])=>{const m=tm[t]||{};return esc(t)+(m.city?' — '+esc(m.city):'')+' ('+n(k)+')';}).join('<br>')+'</td></tr>';
        if(changes.length)h+='<tr><td>Identity changes</td><td>'+changes.map(c=>esc(c.detail)+' on '+esc(_fmtDT(c.time))).join('<br>')+'</td></tr>';
        if(mts.length)h+='<tr><td>Meetings</td><td>'+mts.slice(0,5).map(m=>{const o=m.subA===sub?m.subB:m.subA;return 'with '+esc(o)+' @ tower '+esc(m.tow||'?')+' ('+esc(_fmtDT(m.time))+', '+esc(m.gapLevel)+')';}).join('<br>')+(mts.length>5?'<br>… +'+(mts.length-5)+' more':'')+'</td></tr>';
        if(xs)h+='<tr><td>Cross-case</td><td>also in '+(xs.matches||[]).map(mm=>esc(mm.case_name||mm.case_id)+' ('+((mm.match_types||[mm.match_type]).join('/'))+', '+esc(mm.confidence)+')').join('; ')+'</td></tr>';
        h+='</table></div>';
      });
      if(subjects.length>poiList.length)h+='<div class="d-note">'+n(poiList.length)+' of '+n(subjects.length)+' subjects profiled (risk-ranked). Full subject list available in the platform.</div>';
    }else h+='<div class="d-note">No subjects.</div>';
    h+='</section>';

    // ── 4. Key findings ──
    h+='<section class="dossier-section"><h2>4. Key Findings</h2>';
    // Only emit subsections that actually have findings, numbered 4.1, 4.2 … in sequence.
    let kf=0;const kn=()=>'4.'+(++kf);
    if(meetingsList.length){
      h+='<h3 class="d-h3">'+kn()+' Co-location meetings ('+n(mt.total||meetingsList.length)+')</h3>'
        +'<table class="d-table"><thead><tr><th>Subject A</th><th>Subject B</th><th>Tower</th><th>Place</th><th>Time</th><th>Gap</th><th>Confidence</th></tr></thead><tbody>'
        +meetingsList.slice(0,25).map(m=>{const pl=tm[m.tow]||{};return '<tr><td>'+esc(m.subA)+'</td><td>'+esc(m.subB)+'</td><td>'+esc(m.tow||'?')+'</td><td>'+esc([pl.city,pl.state].filter(Boolean).join(', ')||'—')+'</td><td>'+esc(_fmtDT(m.time))+'</td><td>'+Math.round(m.gap)+'m</td><td>'+esc(m.gapLevel)+'</td></tr>';}).join('')
        +'</tbody></table>'+(meetingsList.length>25?'<div class="d-note">Showing top 25 by confidence of '+n(mt.total||meetingsList.length)+'.</div>':'');
    }
    if(impossible.length){
      h+='<h3 class="d-h3">'+kn()+' Impossible travel / possible cloning ('+n(impossible.length)+')</h3>'
        +'<table class="d-table"><thead><tr><th>Subject</th><th>From → To tower</th><th>Distance</th><th>Elapsed</th><th>Implied speed</th></tr></thead><tbody>'
        +impossible.slice(0,20).map(r=>'<tr><td>'+esc(r.subject||'—')+'</td><td>'+esc(r.from_tower||'?')+' → '+esc(r.to_tower||'?')+'</td><td>'+Math.round(r.distance_km||0)+' km</td><td>'+Math.round(r.dt_minutes||0)+' min</td><td>'+Math.round(r.speed_kmh||0)+' km/h</td></tr>').join('')
        +'</tbody></table>';
    }
    if(idChanges.length){
      h+='<h3 class="d-h3">'+kn()+' Identity changes — SIM / handset swaps ('+n(idChanges.length)+')</h3>'
        +'<table class="d-table"><thead><tr><th>Subject</th><th>Change</th><th>From → To</th><th>When</th><th>Confidence</th></tr></thead><tbody>'
        +idChanges.slice(0,25).map(c=>'<tr><td>'+esc(c.sub)+'</td><td>'+esc(c.detail)+'</td><td>'+esc(c.from||'—')+' → '+esc(c.to||'—')+'</td><td>'+esc(_fmtDT(c.time))+'</td><td>'+esc(c.confidence||'')+'</td></tr>').join('')
        +'</tbody></table>'+(idChanges.length>25?'<div class="d-note">Showing 25 of '+n(idChanges.length)+'.</div>':'');
    }
    if(hidden.length){
      h+='<h3 class="d-h3">'+kn()+' Hidden links &amp; convoys ('+n(hidden.length)+')</h3>'
        +'<table class="d-table"><thead><tr><th>Subject A</th><th>Subject B</th><th>Pattern</th><th>Co-locations</th><th>Days</th><th>Towers</th><th>Ever called</th></tr></thead><tbody>'
        +hidden.slice(0,20).map(p=>{const pat=[p.hidden_link?'Hidden link':null,p.convoy?'Convoy':null].filter(Boolean).join(' / ')||'Co-presence';
          return '<tr><td>'+esc(p.subject_a||'—')+'</td><td>'+esc(p.subject_b||'—')+'</td><td>'+esc(pat)+'</td><td>'+n(p.occurrences||0)+'</td><td>'+n(p.distinct_days||0)+'</td><td>'+esc((p.towers||[]).join(', ')||'—')+'</td><td>'+(p.ever_called?'yes':'no')+'</td></tr>';}).join('')
        +'</tbody></table>';
    }
    if(!kf)h+='<div class="d-note">Automated analysis flagged no co-location meetings, impossible-travel legs, identity changes or hidden-link/convoy patterns in this case.</div>';
    h+='</section>';

    // ── 5. Communication analysis ──
    h+='<section class="dossier-section"><h2>5. Communication Analysis</h2><h3 class="d-h3">Most frequent contacts in this case</h3>';
    if(topCnt.length){
      h+='<table class="d-table"><thead><tr><th>#</th><th>Contact</th><th>Interactions</th></tr></thead><tbody>'
        +topCnt.map(([c,k],i)=>'<tr><td>'+(i+1)+'</td><td>'+esc(c)+'</td><td>'+n(k)+'</td></tr>').join('')+'</tbody></table>';
    }else h+='<div class="d-note">None.</div>';
    h+='</section>';

    // ── 6. Cross-case links ──
    h+='<section class="dossier-section"><h2>6. Cross-Case Links</h2><div id="dossierXcase" class="d-note">Loading…</div></section>';

    // ── 7. Bookmarked evidence (with screenshots) ──
    h+='<section class="dossier-section"><h2>7. Bookmarked Evidence ('+n(ev.length)+')</h2>';
    if(ev.length){
      h+=ev.map((it,i)=>{const m=EVK[it.kind]||{l:it.kind};
        return '<div class="d-ev"><div class="d-ev-h"><span class="d-poi-n">E'+(i+1)+'</span> <b>'+esc(it.label||'')+'</b> <span class="d-poi-type">'+esc(m.l)+'</span></div>'
        +(it.detail?'<div class="d-ev-d">'+esc(it.detail)+'</div>':'')
        +'<div class="d-note">'+(it.subject?'Subject '+esc(it.subject)+' · ':'')+(it.ts?esc(_fmtDT(it.ts))+' · ':'')+'pinned '+esc(_fmtDT(it.addedAt))+'</div>'
        +(it.image?'<figure class="d-fig"><img src="'+it.image+'"></figure>':'')+'</div>';
      }).join('');
    }else h+='<div class="d-note">No items bookmarked. Pin findings (☆) on the Story tab, or capture chart/graph snapshots, to include them here.</div>';
    h+='</section>';

    // ── 8. Charts ──
    const chartList=[['chartDailyTrend','Daily activity trend'],['chartCdrIpdrTime','CDR vs IPDR over time'],['chartActiveSubjects','Most active subjects'],['chartNewReturning','New vs returning contacts'],['chartGeoState','Geographic spread by state'],['chartTowerDiversity','Tower diversity']];
    let chartsHtml='';
    chartList.forEach(([id,title])=>{
      const cv=document.getElementById(id);
      if(cv&&cv.tagName==='CANVAS'&&cv.width>0){
        try{const url=cv.toDataURL('image/png');if(url&&url.length>2000)chartsHtml+='<figure class="d-fig"><img src="'+url+'"><figcaption>'+esc(title)+'</figcaption></figure>';}catch(e){}
      }
    });
    h+='<section class="dossier-section"><h2>8. Analytical Charts</h2>'+(chartsHtml||'<div class="d-note">No chart snapshots available — open the Charts tab once, then regenerate the dossier.</div>')+'</section>';

    // ── 9. Towers in this case (case-specific, with activity) ──
    h+='<section class="dossier-section"><h2>9. Towers in this Case</h2>';
    if(caseTowers.length){
      h+='<table class="d-table"><thead><tr><th>#</th><th>Tower ID</th><th>City</th><th>State</th><th>Records at tower</th></tr></thead><tbody>'
        +caseTowers.slice(0,80).map((t,i)=>'<tr><td>'+(i+1)+'</td><td>'+esc(t.tw)+'</td><td>'+esc(t.city||'—')+'</td><td>'+esc(t.state||'—')+'</td><td>'+n(t.c)+'</td></tr>').join('')
        +'</tbody></table>'+(caseTowers.length>80?'<div class="d-note">Showing top 80 of '+n(caseTowers.length)+' towers touched by this case.</div>':'<div class="d-note">'+n(caseTowers.length)+' distinct tower(s) appear in this case&rsquo;s records.</div>');
    }else h+='<div class="d-note">No tower references in this case&rsquo;s records.</div>';
    h+='</section>';

    // ── Appendix ──
    h+='<section class="dossier-section"><h2>Appendix A — Methodology &amp; Limitations</h2>'
      +'<p class="d-app">Findings are derived from Call Detail Records (CDR) and Internet Protocol Detail Records (IPDR) loaded into the named case. CDR and IPDR are analysed under strict separation — a phone-number subject is never merged with an IP subject. Co-location ("meeting") detection infers proximity from same-tower activity within a short time window and is probabilistic, not positional proof. "Impossible travel" flags legs whose implied speed exceeds human possibility and may indicate a cloned SIM or a spoofed record. Cross-case links are an identity/intelligence lookup (number, IMEI handset, IMSI SIM, or IP); IP-only matches are low-confidence because operators reassign addresses. Tower place-names may be approximate where derived by offline reverse-geocoding. All times are shown in the analyst workstation\'s local timezone. This dossier is an investigative aid; corroborate every finding against the primary records before relying on it in proceedings.</p></section>';

    h+='<div class="dossier-end">— End of dossier · '+esc(ref)+' · '+CLASS+' —</div>';
    D.dossierBody.innerHTML=h;
    D.dossier.style.display='block';D.dossier.scrollTop=0;

    // Fill cross-case section async (non-blocking).
    fillDossierXcase();
  }catch(e){console.error(e);alert('Could not build the dossier: '+(e.message||'error'))}
  finally{D.dossierBtn.textContent=prev;D.dossierBtn.disabled=false;}
}

async function fillDossierXcase(){
  const box=document.getElementById('dossierXcase');if(!box)return;
  try{
    const rep=await API.get('/cross-case/report?case_id='+encodeURIComponent(state.data.caseId||''));
    const subs=(rep&&rep.subjects)||[];
    if(!subs.length){box.className='d-note';box.textContent='No subjects from this case were found in any other case.';return}
    let h='<div class="d-note">'+n(subs.length)+' subject(s) from this case also appear in other cases.</div>';
    h+='<table class="d-table"><thead><tr><th>Subject</th><th>Linked cases</th><th>Match types</th><th>Confidence</th></tr></thead><tbody>';
    subs.slice(0,40).forEach(s=>{
      const matches=s.matches||[];
      const cases=[...new Set(matches.map(m=>m.case_name||m.case_id))];
      const types=[...new Set(matches.flatMap(m=>m.match_types||[m.match_type]).filter(Boolean))];
      const conf=matches.some(m=>m.confidence==='high')?'high':'low';
      h+='<tr><td>'+esc(s.subject)+'</td><td>'+esc(cases.join(', '))+'</td><td>'+esc(types.join(', '))+'</td><td>'+esc(conf)+'</td></tr>';
    });
    h+='</tbody></table>';
    box.className='';box.innerHTML=h;
  }catch(e){box.className='d-note';box.textContent='Cross-case links unavailable.';console.error(e)}
}
