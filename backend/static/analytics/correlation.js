// analytics/correlation.js — the Cross-Subject Correlation tab: compares two subjects on common
// towers / contacts / services / sessions, time overlaps and a weighted correlation score. Extracted
// from app.js (feature layer). Uses svcColor + recordSvcAttr + the shared session engine; detectMeetings
// (still in app.js's dashboard region) is injected via provideDetectMeetings(). Self-registers with the
// router. No behavior change.

import { esc } from '../core/utils.js';
import { D } from '../core/dom.js';
import { state } from '../core/state.js';
import { svcColor } from '../core/constants.js';
import { recordSvcAttr } from '../services/attribution.js';
import { reconstructSessions } from '../services/sessions.js';
import { registerTab } from '../core/router.js';

// detectMeetings lives in app.js's dashboard region; injected at boot.
let _detectMeetings=()=>[];
export function provideDetectMeetings(fn){ _detectMeetings=fn; }

function renderCorrelationTab(){
  // Build the two subject dropdowns ONCE per dataset (signature-guarded). Rebuilding thousands
  // of <option>s on every change is what made this tab crawl; on change we only toggle the
  // Compare button. Same subject for A and B is allowed in the list but rejected on Compare.
  // Use the real subjects (a-parties + source IPs), not every counterpart/destination IP.
  const subs=(state._ownedSubjects&&state._ownedSubjects.length)?state._ownedSubjects:(state.subjects||[]);
  const sig=subs.length+'|'+(subs[0]||'')+'|'+(subs[subs.length-1]||'');
  if(D.corrSubA.dataset.sig!==sig){
    const opts=subs.map(s=>`<option value="${esc(s)}">${esc(s)}</option>`).join('');
    const curA=D.corrSubA.value,curB=D.corrSubB.value;
    D.corrSubA.innerHTML='<option value="">Select subject A...</option>'+opts;
    D.corrSubB.innerHTML='<option value="">Select subject B...</option>'+opts;
    if(curA)D.corrSubA.value=curA;
    if(curB)D.corrSubB.value=curB;
    D.corrSubA.dataset.sig=sig;D.corrSubB.dataset.sig=sig;
  }
  D.corrGoBtn.disabled=!(D.corrSubA.value&&D.corrSubB.value);
}
function runCorrelation(){
  const a=D.corrSubA.value,b=D.corrSubB.value;
  if(!a||!b){D.corrResults.innerHTML='<div class="corr-empty">Select two subjects and click Compare.</div>';return}
  if(a===b){D.corrResults.innerHTML='<div class="corr-empty">Pick two different subjects.</div>';return}
  const rowsA=state.data.records.filter(r=>r.sub===a),rowsB=state.data.records.filter(r=>r.sub===b);
  if(!rowsA.length||!rowsB.length){D.corrResults.innerHTML='<div class="corr-empty">One or both subjects have no records.</div>';return}
  // Common towers
  const towsA=new Set(rowsA.map(r=>r.tow).filter(Boolean));
  const towsB=new Set(rowsB.map(r=>r.tow).filter(Boolean));
  const commonTows=[...towsA].filter(t=>towsB.has(t));
  // Common contacts
  const cntsA=new Set(rowsA.map(r=>r.cnt).filter(Boolean));
  const cntsB=new Set(rowsB.map(r=>r.cnt).filter(Boolean));
  const commonCnts=[...cntsA].filter(c=>cntsB.has(c));
  // Common services
  const svcsA={};rowsA.forEach(r=>{const s=recordSvcAttr(r)||r.svc||'Unknown';svcsA[s]=(svcsA[s]||0)+1});
  const svcsB={};rowsB.forEach(r=>{const s=recordSvcAttr(r)||r.svc||'Unknown';svcsB[s]=(svcsB[s]||0)+1});
  const commonSvcs=Object.keys(svcsA).filter(s=>svcsB[s]);
  // All services union
  const allSvcKeys=new Set([...Object.keys(svcsA),...Object.keys(svcsB)]);
  // Common sessions (reconstructed)
  const sA=reconstructSessions(a),sB=reconstructSessions(b);
  // Time overlaps: both subjects active within 1 hour
  const overlapWindows=[];
  const timesA=rowsA.filter(r=>r.ts).map(r=>new Date(r.ts).getTime()).sort((x,y)=>x-y);
  const timesB=rowsB.filter(r=>r.ts).map(r=>new Date(r.ts).getTime()).sort((x,y)=>x-y);
  timesA.forEach(tA=>{
    const nearB=timesB.filter(tB=>Math.abs(tA-tB)<3600000);
    nearB.forEach(tB=>{
      const start=new Date(Math.min(tA,tB)),end=new Date(Math.max(tA,tB));
      const label=`${start.toLocaleString()} — ${end.toLocaleString()} (${Math.round(Math.abs(tA-tB)/60000)}m gap)`;
      if(!overlapWindows.find(o=>o.label===label))overlapWindows.push({label,start,end});
    });
  });
  overlapWindows.sort((a,b)=>a.start-b.start).slice(0,20);
  // Common towers with map
  const commonTowerData=state.towers.filter(t=>commonTows.includes(t.tower_id||t.id));
  // Meeting detection via unified engine
  const meetings=_detectMeetings({subjectA:a,subjectB:b});
  window.meetingStore=window.meetingStore||{};const msKey=a+'|'+b;window.meetingStore[msKey]=meetings;
  // -- Weighted Correlation Score --
  const weights={contact:5,service:2,tower:1,session:4};
  let weightedScore=0;
  if(commonCnts.length)weightedScore+=commonCnts.length*weights.contact;
  if(commonSvcs.length)weightedScore+=commonSvcs.length*weights.service;
  if(commonTows.length)weightedScore+=commonTows.length*weights.tower;
  if(meetings.length)weightedScore+=meetings.length*weights.session;
  const maxPossible=Math.max(1,Math.min(rowsA.length,rowsB.length)*weights.contact+Object.keys(svcsA).length*weights.service+towsA.size*weights.tower+meetings.length*weights.session);
  const correlationPct=Math.min(100,Math.round((weightedScore/maxPossible)*100));
  // Build HTML
  let html='';
  // Correlation score card
  html+=`<div class="corr-card" style="grid-column:1/-1;border-color:${correlationPct>=50?'var(--danger)':correlationPct>=25?'var(--warn)':'var(--muted)'}">
    <h4 style="color:${correlationPct>=50?'var(--danger)':correlationPct>=25?'var(--warn)':'var(--muted)'}">
      Correlation Score: ${correlationPct}%
      <span style="font-size:0.7rem;font-weight:400;color:var(--muted);margin-left:8px">
        weighted: contact—${weights.contact} | service—${weights.service} | tower—${weights.tower} | meeting—${weights.session}
      </span>
    </h4>
    <div style="display:flex;gap:12px;font-size:0.72rem;color:var(--muted);flex-wrap:wrap">
      <span>${commonCnts.length} shared contacts (+${commonCnts.length*weights.contact})</span>
      <span>${commonSvcs.length} shared services (+${commonSvcs.length*weights.service})</span>
      <span>${commonTows.length} shared towers (+${commonTows.length*weights.tower})</span>
      <span>${meetings.length} meetings (+${meetings.length*weights.session})</span>
    </div>
  </div>`;
  // Meeting card - MOST PROMINENT
  const mHigh=meetings.filter(m=>m.gapLevel==='high').length,mMed=meetings.filter(m=>m.gapLevel==='medium').length,mLow=meetings.filter(m=>m.gapLevel==='low').length;
  html+=`<div class="corr-card" style="grid-column:1/-1;border-color:var(--danger);background:rgba(185,74,72,0.04)">
    <h4 style="color:var(--danger)">&#128680; Meeting Confidence: ${meetings.length?'<span style="color:'+(mHigh?'var(--success)':mMed?'var(--warn)':'var(--muted)')+'">'+(mHigh>mMed?'High':mMed>0?'Medium':'Low')+'</span>':'None'}<span class="corr-count" style="color:var(--danger)">${meetings.length} events</span></h4>
    <div style="font-size:0.72rem;color:var(--muted);margin:-4px 0 8px">${esc(a)} & ${esc(b)} — ${mHigh} high, ${mMed} med, ${mLow} low confidence</div>
    ${meetings.length?meetings.slice(0,15).map((m,meetingIdx)=>{
      const confLabel=m.gapLevel==='high'?'High Confidence':m.gapLevel==='medium'?'Medium Confidence':'Low Confidence';
      const confColor=m.gapLevel==='high'?'var(--success)':m.gapLevel==='medium'?'var(--warn)':'var(--muted)';
      return `<div class="ct-block" style="border-left:3px solid ${confColor};display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 10px">
        <span style="font-weight:600">${esc(m.time.toLocaleString())}</span>
        <span style="font-size:0.72rem;color:${confColor};font-weight:600">${confLabel}</span>
        <span style="font-size:0.72rem;color:var(--muted)">gap: ${m.gap}m</span>
        <span style="font-size:0.72rem;color:var(--muted)">at ${esc(m.tow)}</span>
        <span style="font-size:0.72rem;color:var(--muted)">score: ${m.score} (${m.encounterCount} encounters)</span>
        <span style="font-size:0.7rem;color:var(--muted)">${esc(a)}: ${m.subAEvent}</span>
        <span style="font-size:0.7rem;color:var(--muted)">${esc(b)}: ${m.subBEvent}</span>
        ${m.evidence&&m.evidence.length?`<span style="font-size:0.68rem;color:var(--muted);width:100%">Why: ${m.evidence.join('; ')}</span>`:''}
        <button onclick="showMeetingOverlay('${esc(a+'|'+b)}',${meetingIdx})" style="background:none;border:1px solid var(--line);color:var(--accent);padding:2px 8px;border-radius:4px;cursor:pointer;font-size:0.65rem">View</button>
      </div>`;
    }).join('')+(meetings.length>15?'<div style="font-size:0.72rem;color:var(--muted);padding-top:4px">... and '+(meetings.length-15)+' more</div>':'')
      :'<div style="font-size:0.75rem;color:var(--muted)">No co-location events detected.</div>'}
  </div>`;
  // Overview card
  const sessionsA=sA.length,sessionsB=sB.length;
  html+=`<div class="corr-card" style="grid-column:1/-1">
    <h4>Correlation Overview: ${esc(a)} ? ${esc(b)}</h4>
    <div style="display:flex;gap:20px;font-size:0.78rem">
      <div><strong>${esc(a)}</strong>: ${rowsA.length} records, ${sessionsA} sessions, ${cntsA.size} contacts</div>
      <div><strong>${esc(b)}</strong>: ${rowsB.length} records, ${sessionsB} sessions, ${cntsB.size} contacts</div>
      <div style="color:var(--accent);font-weight:600">${commonTows.length} shared towers &middot; ${commonCnts.length} shared contacts &middot; ${commonSvcs.length} shared services</div>
    </div>
  </div>`;
  // Common towers card
  html+=`<div class="corr-card">
    <h4>&#128205; Common Towers <span class="corr-count">${commonTows.length}</span></h4>
    ${commonTows.length?commonTows.map(t=>`<div class="corr-item"><span class="corr-badge" style="background:var(--accent)"></span>${esc(t)}</div>`).join(''):
      '<div style="font-size:0.75rem;color:var(--muted)">No towers in common.</div>'}
  </div>`;
  // Common contacts card
  html+=`<div class="corr-card">
    <h4>&#128101; Common Contacts <span class="corr-count">${commonCnts.length}</span></h4>
    ${commonCnts.length?commonCnts.map(c=>`<div class="corr-item"><span class="corr-badge" style="background:var(--warn)"></span>
      <span style="cursor:pointer;color:var(--accent)" onclick="showProfile('${esc(c)}')">${esc(c)}</span></div>`).join(''):
      '<div style="font-size:0.75rem;color:var(--muted)">No contacts in common.</div>'}
  </div>`;
  // Common services card
  html+=`<div class="corr-card">
    <h4>&#128268; Common Services <span class="corr-count">${commonSvcs.length}</span></h4>
    ${commonSvcs.length?commonSvcs.sort((x,y)=>svcsA[y]-svcsA[x]).map(s=>`<div class="corr-item">
      <span class="corr-badge" style="background:${svcColor(s)}"></span>
      <span style="flex:1">${esc(s)}</span>
      <span style="font-size:0.7rem;color:var(--muted)">A: ${svcsA[s]} | B: ${svcsB[s]}</span>
    </div>`).join(''):'<div style="font-size:0.75rem;color:var(--muted)">No services in common.</div>'}
  </div>`;
  // Service comparison card
  html+=`<div class="corr-card">
    <h4>&#128202; Service Comparison</h4>
    <div style="font-size:0.75rem;display:grid;grid-template-columns:1fr 60px 60px;gap:3px">
      <div style="font-weight:600;color:var(--muted);padding:4px 0;border-bottom:1px solid var(--line)">Service</div>
      <div style="font-weight:600;color:var(--muted);padding:4px 0;border-bottom:1px solid var(--line);text-align:right">${esc(a)}</div>
      <div style="font-weight:600;color:var(--muted);padding:4px 0;border-bottom:1px solid var(--line);text-align:right">${esc(b)}</div>
      ${[...allSvcKeys].sort().map(s=>{
        const c=svcColor(s);
        const vA=svcsA[s]||0,vB=svcsB[s]||0;
        const barA=Math.min(40,vA*2),barB=Math.min(40,vB*2);
        return `<div style="display:contents">
          <div style="padding:3px 0"><span class="svc-badge" style="background:${c};font-size:0.65rem;padding:1px 6px">${esc(s)}</span></div>
          <div style="padding:3px 0;text-align:right"><span style="background:${c}22;padding:1px 4px;border-radius:3px;font-size:0.7rem;display:inline-block;min-width:${barA}px">${vA}</span></div>
          <div style="padding:3px 0;text-align:right"><span style="background:${c}22;padding:1px 4px;border-radius:3px;font-size:0.7rem;display:inline-block;min-width:${barB}px">${vB}</span></div>
        </div>`;
      }).join('')}
    </div>
  </div>`;
  // Time overlaps card
  html+=`<div class="corr-card corr-timeline">
    <h4>&#128339; Overlapping Time Windows <span class="corr-count">${overlapWindows.length}</span></h4>
    ${overlapWindows.length?overlapWindows.slice(0,10).map(o=>`<div class="ct-block">${esc(o.label)}</div>`).join('')+
      (overlapWindows.length>10?`<div style="font-size:0.72rem;color:var(--muted);padding-top:4px">... and ${overlapWindows.length-10} more</div>`:'')
      :'<div style="font-size:0.75rem;color:var(--muted)">No overlapping time windows found.</div>'}
  </div>`;
  D.corrResults.innerHTML=html;
}

// Wire up Correlation tab
D.corrSubA.addEventListener('change',()=>{renderCorrelationTab()});
D.corrSubB.addEventListener('change',()=>{renderCorrelationTab()});
D.corrGoBtn.addEventListener('click',runCorrelation);
D.corrSwapBtn.addEventListener('click',()=>{
  const a=D.corrSubA.value,b=D.corrSubB.value;
  if(!a&&!b)return;
  // Dropdowns are already populated — just exchange the two selected values (no rebuild).
  D.corrSubA.value=b;D.corrSubB.value=a;
  D.corrGoBtn.disabled=!(D.corrSubA.value&&D.corrSubB.value);
});
registerTab('correlation', renderCorrelationTab);
