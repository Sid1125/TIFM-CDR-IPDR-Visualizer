// analytics/services.js — the Service Attribution tab: aggregates every subject's reconstructed
// IPDR sessions into per-service buckets, detects activity-spike bursts, and renders an evidence
// scorecard card per service. Extracted from app.js (feature layer). Uses the shared session engine
// (reconstructSessions) + svcColor; showProfile in onclick strings resolves via the window bridge.
// Self-registers with the router. No behavior change.

import { esc } from '../core/utils.js';
import { D } from '../core/dom.js';
import { state } from '../core/state.js';
import { svcColor } from '../core/constants.js';
import { reconstructSessions } from '../services/sessions.js';
import { registerTab } from '../core/router.js';

let svcCorrData=null;
function renderServicesTab(){
  if(!state.data.records.length){D.svcCardGrid.innerHTML='<div style="padding:40px;text-align:center;color:var(--muted)">No data loaded.</div>';D.svcBursts.innerHTML='';D.svcCount.textContent='0 services';return}
  // Build service data from sessions
  const svcMap=new Map();// serviceName -> {sessions, subjects, contacts, totalDur, confidences, subjectsSet, contactsSet}
  const allSubjects=[...new Set(state.data.records.map(r=>r.sub).filter(Boolean))];
  allSubjects.forEach(sub=>{
    const sessions=reconstructSessions(sub);
    sessions.forEach(s=>{
      const sName=s.primary?s.primary.service:(s.service||'Unknown');
      if(!svcMap.has(sName))svcMap.set(sName,{name:sName,sessions:[],subjects:new Set(),contacts:new Set(),totalDur:0,confidences:[],towers:new Set(),ports:new Set(),protocols:new Set(),services:new Map()});
      const d=svcMap.get(sName);
      d.sessions.push({...s,subject:sub});
      d.subjects.add(sub);
      if(s.cnt)d.contacts.add(s.cnt);
      if(s.duration)d.totalDur+=s.duration;
      if(s.serviceConfidence)d.confidences.push(s.serviceConfidence);
      if(s.tow)d.towers.add(s.tow);
      // Track all candidate services under this bucket
      if(s.candidates)s.candidates.forEach(ca=>{
        const cur=d.services.get(ca.service)||{count:0,score:0};
        cur.count++;
        cur.score+=ca.score||0;
        d.services.set(ca.service,cur);
      });
      // Track evidence types
      if(s.evidence)s.evidence.forEach(ev=>{
        if(ev.includes('IP range')||ev.includes('DNS IP')){if(!d._ipEvidence)d._ipEvidence=0;d._ipEvidence++}
        if(ev.includes('Port')){if(!d._portEvidence)d._portEvidence=0;d._portEvidence++}
        if(ev.includes('Distinctive')){if(!d._distinctive)d._distinctive=0;d._distinctive++}
        if(ev.includes('Signature')){if(!d._sigEvidence)d._sigEvidence=0;d._sigEvidence++}
      });
    });
  });
  // Convert to array and sort by session count
  let services=[...svcMap.values()].sort((a,b)=>b.sessions.length-a.sessions.length);
  svcCorrData=services;
  // Apply filters
  const q=D.svcSearchInput.value.trim().toLowerCase();
  const minConf=parseInt(D.svcMinConf.value);
  if(q)services=services.filter(s=>s.name.toLowerCase().includes(q));
  if(minConf>0)services=services.filter(s=>{
    const avgConf=s.confidences.length?s.confidences.reduce((a,c)=>a+c,0)/s.confidences.length:0;
    return avgConf>=minConf;
  });
  D.svcCount.textContent=services.length+' services';
  // Render bursts
  renderServiceBursts();
  // Render cards
  D.svcCardGrid.innerHTML=services.map(s=>renderServiceCard(s)).join('');
}
function renderServiceBursts(){
  // Burst detection: per-subject daily activity vs rolling average
  const bursts=[];
  const subDays=new Map();// subject -> {date:count}
  state.data.records.forEach(r=>{
    if(!r.ts||!r.sub)return;
    const d=new Date(r.ts).toLocaleDateString();
    if(!subDays.has(r.sub))subDays.set(r.sub,new Map());
    const days=subDays.get(r.sub);
    days.set(d,(days.get(d)||0)+1);
  });
  subDays.forEach((days,sub)=>{
    const counts=[...days.values()];
    if(counts.length<3)return;
    const avg=counts.reduce((a,c)=>a+c,0)/counts.length;
    const threshold=Math.max(avg*3,10);
    days.forEach((count,date)=>{
      if(count>=threshold){
        const sessionsToday=state.data.records.filter(r=>r.sub===sub&&r.ts&&new Date(r.ts).toLocaleDateString()===date);
        bursts.push({subject:sub,date,count,avg:Math.round(avg),sessions:sessionsToday.length});
      }
    });
  });
  bursts.sort((a,b)=>b.count-a.count);
  if(!bursts.length){D.svcBursts.innerHTML='';return}
  D.svcBursts.innerHTML='<span style="font-size:0.78rem;font-weight:600;color:var(--danger);display:flex;align-items:center;gap:4px">&#9888; Activity Spikes Detected</span>'+
    bursts.slice(0,6).map(b=>`<div class="svc-burst-card">
      <span class="burst-icon">&#128200;</span>
      <span><span class="burst-date">${esc(b.date)}</span> — <strong>${esc(b.subject)}</strong></span>
      <span class="burst-detail">${b.count} records (avg ${b.avg}) &middot; ${b.sessions} sessions</span>
    </div>`).join('');
  if(bursts.length>6)D.svcBursts.innerHTML+='<span style="font-size:0.72rem;color:var(--muted);align-self:center">+'+(bursts.length-6)+' more</span>';
}
function renderServiceCard(svc){
  const avgConf=svc.confidences.length?Math.round(svc.confidences.reduce((a,c)=>a+c,0)/svc.confidences.length):0;
  const topCandidates=[...svc.services.entries()].sort((a,b)=>b[1].score-b[1].score).slice(0,5);
  const c=svcColor(svc.name);
  const durStr=svc.totalDur>=3600?Math.floor(svc.totalDur/3600)+'h '+Math.round((svc.totalDur%3600)/60)+'m':
    svc.totalDur>=60?Math.floor(svc.totalDur/60)+'m '+Math.round(svc.totalDur%60)+'s':svc.totalDur+'s';
  const initials=svc.name.replace(/[^A-Z0-9]/g,'').slice(0,2)||svc.name.slice(0,2).toUpperCase();
  const evidences=[
    {label:'IP/Infrastructure Match',pass:svc._ipEvidence>0||(svc.name!=='Unknown'&&svc.name!=='TCP'&&svc.name!=='UDP')},
    {label:'Port/Protocol Match',pass:svc._portEvidence>0||svc.protocols.size>0},
    {label:'Distinctive Indicators',pass:svc._distinctive>0},
    {label:'Session Pattern Match',pass:svc.name!=='Unknown'},
    {label:'Multiple Subjects',pass:svc.subjects.size>1},
    {label:'Clear Attribution',pass:topCandidates.length>1?false:true},
  ];
  const passCount=evidences.filter(e=>e.pass).length;
  const evidenceScore=Math.round((passCount/evidences.length)*100);
  const evColor=evidenceScore>=67?'var(--success)':evidenceScore>=34?'var(--warn)':'var(--danger)';
  return `<div class="svc-card">
    <div class="svc-card-head" style="border-left:3px solid ${c}" onclick="this.classList.toggle('open');this.nextElementSibling.style.display=this.classList.contains('open')?'block':'none'">
      <span class="svc-badge" style="background:${c}">${esc(initials)}</span>
      <span class="svc-name">${esc(svc.name)}</span>
      <span class="svc-stats">
        <span>${svc.sessions.length} sessions</span>
        <span>${durStr}</span>
        <span>${svc.subjects.size} subjects</span>
        <span>${svc.contacts.size} contacts</span>
      </span>
      <span class="svc-conf-badge" style="background:${avgConf>=70?'rgba(90,159,126,0.15)':avgConf>=40?'rgba(212,160,23,0.15)':'rgba(0,0,0,0.04)'};color:${avgConf>=70?'var(--success)':avgConf>=40?'var(--warn)':'var(--muted)'}">${avgConf}%</span>
      <span class="svc-arrow">&#9654;</span>
    </div>
    <div class="svc-card-body">
      <div class="svc-card-body-inner">
        <div class="svc-section-label">Evidence Scorecard</div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px">
          <div style="min-width:200px;flex:2">
            <div class="svc-evidences">
              ${evidences.map(e=>`<div class="svc-evidence-row ${e.pass?'pass':'fail'}">
                <span class="ev-icon ${e.pass?'pass':'fail'}">${e.pass?'&#10003;':'&#10007;'}</span>
                <span>${e.label}</span>
              </div>`).join('')}
            </div>
            <div class="svc-evidence-meter"><div class="svc-evidence-meter-fill" style="width:${evidenceScore}%;background:${evColor}"></div></div>
            <div style="font-size:0.68rem;color:var(--muted);margin-top:3px">${passCount}/${evidences.length} checks passed</div>
          </div>
          ${topCandidates.length?`<div style="min-width:160px;flex:1">
            <div style="font-size:0.7rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Alternative Services</div>
            <div class="svc-alt-grid">
              ${topCandidates.map(([n,data],i)=>{
                const maxScore=topCandidates[0][1].score;
                const avgScore=Math.round(data.score/data.count);
                const pct=data.score>0?Math.round((data.score/maxScore)*100):0;
                const barColor=avgScore>=70?'var(--success)':avgScore>=40?'var(--warn)':'var(--muted)';
                return `<div class="svc-alt-row">
                  <span class="svc-alt-rank">${i+1}.</span>
                  <span class="svc-alt-name">${esc(n)}</span>
                  <span class="svc-alt-bar" style="width:${Math.max(pct*0.6,3)}px;background:${barColor}" title="${data.count} sessions, avg ${avgScore}%"></span>
                  <span class="svc-alt-pct">${avgScore}%</span>
                </div>`;
              }).join('')}
            </div>
          </div>`:''}
        </div>
        <div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:14px">
          ${svc.subjects.size?`<div style="min-width:140px;flex:1">
            <div style="font-size:0.7rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Subjects (${svc.subjects.size})</div>
            <div class="svc-list-grid">${[...svc.subjects].slice(0,12).map(s=>'<div class="svc-list-item clickable" onclick="showProfile(\''+esc(s)+'\')">'+esc(s)+'</div>').join('')}</div>
          </div>`:''}
          ${svc.towers.size?`<div style="min-width:120px;flex:1">
            <div style="font-size:0.7rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Towers (${svc.towers.size})</div>
            <div class="svc-list-grid">${[...svc.towers].slice(0,10).map(t=>'<div class="svc-list-item">'+esc(t)+'</div>').join('')}</div>
          </div>`:''}
          ${svc.contacts.size?`<div style="min-width:140px;flex:1">
            <div style="font-size:0.7rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Contacts (${svc.contacts.size})</div>
            <div class="svc-list-grid">${[...svc.contacts].slice(0,10).map(c=>'<div class="svc-list-item clickable" onclick="showProfile(\''+esc(c)+'\')">'+esc(c)+'</div>').join('')}</div>
          </div>`:''}
        </div>
        <div style="margin-top:4px">
          <div style="font-size:0.7rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Recent Sessions (${Math.min(svc.sessions.length,20)})</div>
          <div class="svc-session-list">
            ${svc.sessions.slice(0,20).map(s=>{
              return `<div class="svc-session-row">
                <span class="ss-time">${s.start?new Date(s.start).toLocaleString():'?'}</span>
                <span class="ss-subj" onclick="showProfile('${esc(s.subject)}')">${esc(s.subject)}</span>
                <span class="ss-cnt">${esc(s.cnt||s.activityLabel||s.activity||'')}</span>
                <span class="ss-dur">${s.duration?s.duration+'s':''}</span>
                <span class="ss-conf" style="color:${s.serviceConfidence>=70?'var(--success)':s.serviceConfidence>=40?'var(--warn)':'var(--muted)'}">${s.serviceConfidence?Math.round(s.serviceConfidence)+'%':''}</span>
              </div>`;
            }).join('')}
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

// Wire up Services tab
D.svcSearchInput.addEventListener('input',renderServicesTab);
D.svcMinConf.addEventListener('change',renderServicesTab);
registerTab('services', renderServicesTab);
