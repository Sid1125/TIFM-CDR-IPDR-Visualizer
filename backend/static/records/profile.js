// records/profile.js — the Subject Profile modal: a full dossier for one subject (records/contacts/
// towers/sessions/meetings stats, identity + SIM-swap history, tower analytics, attributed services,
// cross-case links, hourly activity, an auto-narrative and recent activity). Extracted from app.js
// (feature layer), together with its two private helpers towerAnalytics + buildNarrative. Pulls the
// now-modular engines; the profile's action buttons (saveProfileTag / add/removeFromSuspectGroup /
// showTower / showMeetingOverlay / showProfile) resolve via the window bridge, and the recent-activity
// mini-map rows delegate through data-act="mapView". showProfile is re-exposed on window. No behavior
// change (beyond reviving the recent-activity zoom rows, dead since app.js became a module).

import { esc, fmt } from '../core/utils.js';
import { D } from '../core/dom.js';
import { state } from '../core/state.js';
import { API } from '../core/api.js';
import { auditView } from '../ui/admin.js';
import { rowsFor, ownedRowsFor, twr } from '../data/records.js';
import { recordSvcAttr } from '../services/attribution.js';
import { detectMeetings } from '../services/meetings.js';
import { buildIdentityProfile } from '../services/identity.js';
import { reconstructSessions } from '../services/sessions.js';
import { refLookup } from '../reference/telecom.js';
import { subjLabel, subjLabelTxt, subjTag, isSuspect } from '../core/subjects.js';
import { svcColor } from '../core/constants.js';
import { fillProfileCrossCase } from '../analytics/crosscase.js';

function towerAnalytics(sub){
  const rows=ownedRowsFor(sub).filter(r=>r.ts&&r.tow).sort((a,b)=>new Date(a.ts)-new Date(b.ts));
  if(!rows.length)return{};
  const towerCounts={};let nightTower=null,weekendTower=null;
  const nightCounts={},weekendCounts={};
  rows.forEach(r=>{
    const d=new Date(r.ts);const h=d.getHours();const day=d.getDay();
    const isNight=h>=23||h<5;const isWeekend=day===0||day===6;
    towerCounts[r.tow]=(towerCounts[r.tow]||0)+1;
    if(isNight){nightCounts[r.tow]=(nightCounts[r.tow]||0)+1}
    if(isWeekend){weekendCounts[r.tow]=(weekendCounts[r.tow]||0)+1}
  });
  const sorted=Object.entries(towerCounts).sort((a,b)=>b[1]-a[1]);
  const nightSorted=Object.entries(nightCounts).sort((a,b)=>b[1]-a[1]);
  const weekendSorted=Object.entries(weekendCounts).sort((a,b)=>b[1]-a[1]);
  return{
    towerCounts:towerCounts,
    topTowers:sorted.slice(0,5),
    nightTower:nightSorted[0]?nightSorted[0][0]:null,
    weekendTower:weekendSorted[0]?weekendSorted[0][0]:null,
    totalTowers:sorted.length
  };
}

// Builds a chronological narrative: Communication ? Movement ? Meetings ? Service Usage
function buildNarrative(subject){
  if(!subject)return[];
  const narrative=[];
  const rows=rowsFor(subject).filter(r=>r.tsMs).sort((a,b)=>a.tsMs-b.tsMs);
  const sessions=reconstructSessions(subject);
  const meetings=detectMeetings({subject,maxResults:20});
  // Track last tower for movement detection
  let lastTow=null;
  rows.forEach(r=>{
    const t=new Date(r.ts);
    const timeStr=t.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    // Service/communication events
    if(r.type==='CDR'){
      narrative.push({time:t,text:timeStr+' — '+(r.dir||'')+' call '+(r.cnt?'with '+r.cnt:'')+(r.dur?' ('+r.dur+'s)':''),type:'call'});
    }else if(r.type==='IPDR'){
      const svc=recordSvcAttr(r)||r.svc||'';
      if(svc)narrative.push({time:t,text:timeStr+' — '+svc,type:'service'});
    }
    // Movement detection (tower change)
    if(r.tow&&r.tow!==lastTow&&lastTow){
      narrative.push({time:t,text:timeStr+' — Tower change: '+lastTow+' — '+r.tow,type:'movement'});
    }
    if(r.tow)lastTow=r.tow;
  });
  // Add reconstructed sessions
  sessions.forEach(s=>{
    if(s.start&&s.end){
      const startT=new Date(s.start);
      const endT=new Date(s.end);
      const durMin=Math.round((endT-startT)/60000);
      const svcName=s.primary?s.primary.service:(s.service||'');
      const label=s.activityLabel||s.activity||'';
      if(svcName){
        narrative.push({time:startT,text:startT.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+' — Session: '+svcName+(label?' ('+label+')':'')+(durMin?' '+durMin+'m':''),type:'session'});
      }
    }
  });
  // Add meeting events
  meetings.forEach(m=>{
    narrative.push({time:m.time,text:m.time.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+' — Meeting: with '+(m.subB||'another subject')+' at '+m.tow+' (gap:'+m.gap+'m, score:'+m.score+')',type:'meeting'});
  });
  narrative.sort((a,b)=>a.time-b.time);
  return narrative.slice(0,50);
}

export function showProfile(sub){
  if(!sub){D.profile.style.display='none';return}
  auditView('view_subject',{case_id:state.data.caseId,target:sub});
  const rows=rowsFor(sub);
  const contacts=new Set();const towers=new Set();const svcCounts={};const hours=Array(24).fill(0);const dailyMap={};
  rows.forEach(r=>{
    if(r.cnt&&r.cnt!==sub)contacts.add(r.cnt);if(r.sub&&r.sub!==sub)contacts.add(r.sub);
    const s=r.svc||'Unknown';svcCounts[s]=(svcCounts[s]||0)+1;
    if(r.ts){hours[new Date(r.ts).getHours()]++;const d=new Date(r.ts).toLocaleDateString();dailyMap[d]=(dailyMap[d]||0)+1}
  });
  // Towers must be the subject's OWN serving cells (a CDR locates the caller only).
  ownedRowsFor(sub).forEach(r=>{if(r.tow)towers.add(r.tow)});
  const topSvc=Object.entries(svcCounts).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const topHourIdx=hours.indexOf(Math.max(...hours));
  const dayNight=hours.slice(6,18).reduce((s,v)=>s+v,0)>hours.slice(18,24).concat(hours.slice(0,6)).reduce((s,v)=>s+v,0)?'Day (6-18)':'Night (18-6)';
  // Frequency: avg records/day
  const days=Object.keys(dailyMap);const avgDay=days.length?Math.round(rows.length/days.length):0;
  // First seen / Last seen
  const times=rows.filter(r=>r.ts).map(r=>new Date(r.ts)).sort((a,b)=>a-b);
  const firstSeen=times.length?times[0]:null;
  const lastSeen=times.length?times[times.length-1]:null;
  // Dormancy: gaps > 24h between consecutive records
  let maxDormancy=0, dormantPeriods=0;
  for(let i=1;i<times.length;i++){
    const gapH=(times[i]-times[i-1])/3600000;
    if(gapH>24){dormantPeriods++;if(gapH>maxDormancy)maxDormancy=gapH}
  }
  // Activity spike detection: days with >3x average daily count
  const dayEntries=Object.entries(dailyMap);
  const avgDaily=dayEntries.length?dayEntries.reduce((s,[,c])=>s+c,0)/dayEntries.length:0;
  const spikeDays=dayEntries.filter(([,c])=>c>avgDaily*3&&c>=20).length;
  // Meetings via unified engine
  const meetings=detectMeetings({subject:sub,maxResults:20});
  window.meetingStore=window.meetingStore||{};window.meetingStore[sub+'|'+sub]=meetings;
  // Identity profile
  const identity=buildIdentityProfile(sub);
  const changes=identity.changes;
  // Collect the subject's OWN MSISDNs and IMEIs/IMSIs (identity is already owned-only).
  const allMsisdns=new Set();const allImeis=new Set();const allImsis=new Set();
  identity.identities.forEach(id=>{id.msisdns.forEach(m=>allMsisdns.add(m));if(id.imei)allImeis.add(id.imei);if(id.imsi)allImsis.add(id.imsi)});
  // Tower analytics
  const towerAn=towerAnalytics(sub);
  // Sessions
  const sessions=reconstructSessions(sub);
  const svcFromSessions={};sessions.forEach(s=>{const n=s.primary?s.primary.service:(s.service||'Unknown');svcFromSessions[n]=(svcFromSessions[n]||0)+1});
  const topSessionSvcs=Object.entries(svcFromSessions).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const maxDorm=maxDormancy>24?Math.round(maxDormancy/24)+'d':Math.round(maxDormancy)+'h';
  D.profileTitle.textContent=`Subject: ${subjLabelTxt(sub)}`;
  D.profileBody.innerHTML=`
    <div class="prof-tagbar">
      <span class="prof-tag-label" title="Outside intel about this subject — shown in brackets wherever this number/IP appears, in every case">&#127991; Intel tag</span>
      <input id="profileTagInput" class="prof-tag-input" maxlength="200" value="${esc(subjTag(sub))}" placeholder="e.g. financier, uses 3 SIMs, prime suspect…">
      <button class="btn" onclick="saveProfileTag('${esc(sub).replace(/'/g,"\\'")}')">Save</button>
      ${isSuspect(sub)?`<button class="btn" style="color:var(--danger);border-color:var(--danger)" title="Remove from all suspect groups" onclick="removeFromSuspectGroup('${esc(sub).replace(/'/g,"\\'")}')">&#9678; In group &times;</button>`:`<button class="btn" title="Add this subject to a suspect group" onclick="addToSuspectGroup('${esc(sub).replace(/'/g,"\\'")}')">&#43; Suspect group</button>`}
    </div>
    <div class="prof-grid">
      <div class="prof-card"><div class="prof-label">Records</div><div class="prof-value">${rows.length}</div></div>
      <div class="prof-card"><div class="prof-label">Contacts</div><div class="prof-value">${contacts.size}</div></div>
      <div class="prof-card"><div class="prof-label">Towers</div><div class="prof-value">${towers.size}</div></div>
      <div class="prof-card"><div class="prof-label">Sessions</div><div class="prof-value">${sessions.length}</div></div>
      <div class="prof-card"><div class="prof-label">Meetings</div><div class="prof-value">${meetings.length}</div></div>
      <div class="prof-card"><div class="prof-label">Avg / Day</div><div class="prof-value">${avgDay}</div></div>
    </div>
    <div class="prof-sub">
      <b>${firstSeen?firstSeen.toLocaleDateString():'n/a'}</b> → <b>${lastSeen?lastSeen.toLocaleDateString():'n/a'}</b> &middot; ${days.length} day span &middot;
      peak <b>${String(topHourIdx).padStart(2,'0')}:00</b> &middot; ${dayNight} &middot; top service <b>${esc(topSvc[0]?topSvc[0][0]:'n/a')}</b>
      <br>Dormancy: ${dormantPeriods} period${dormantPeriods===1?'':'s'} (max ${maxDorm}) &middot; activity spikes: ${spikeDays}
    </div>
    <div class="prof-two">
      <div class="prof-section">
        <h4>Identity</h4>
        <div class="prof-id">
          ${(()=>{const rl=refLookup(sub);const bits=[];if(rl.operator)bits.push(esc(rl.operator));if(rl.circle)bits.push(esc(rl.circle));if(rl.is_isd&&rl.country)bits.push('Intl: '+esc(rl.country));return bits.length?'<div><strong>Operator / Circle</strong> '+bits.join(' &middot; ')+'</div>':'';})()}
          <div id="profileSubscriber"></div>
          ${allMsisdns.size?`<div><strong>MSISDN</strong> ${[...allMsisdns].join(', ')}</div>`:''}
          ${allImeis.size?`<div><strong>IMEI</strong> ${[...allImeis].join(', ')}</div>`:''}
          ${allImsis.size?`<div><strong>IMSI</strong> ${[...allImsis].join(', ')}</div>`:''}
          ${identity.identities.length>1?`<div style="margin-top:5px">${identity.identities.map(id=>`<div class="tl">${id.imei||'?'} / ${id.imsi||'?'} — ${id.firstSeen.toLocaleDateString()}→${id.lastSeen.toLocaleDateString()} (${id.records})</div>`).join('')}</div>`:''}
        </div>
        ${changes.length?`<h4 class="alert" style="margin-top:8px">Identity changes (${changes.length})</h4>
          <div class="prof-list">${changes.slice(-5).map(c=>`<div style="padding:1px 0"><span style="color:${c.type==='sim_swap'?'var(--danger)':'var(--warn)'}">&#9654;</span> ${esc(c.detail)} <span style="color:var(--muted)">${c.time.toLocaleDateString()}</span></div>`).join('')}</div>`:''}
      </div>
      <div class="prof-section">
        <h4>Tower analytics</h4>
        <div class="prof-id">
          <div>${towerAn.totalTowers||towers.size} towers${towerAn.nightTower?` &middot; night <strong>${esc(towerAn.nightTower)}</strong>`:''}${towerAn.weekendTower?` &middot; weekend <strong>${esc(towerAn.weekendTower)}</strong>`:''}</div>
          ${towerAn.topTowers?`<div style="color:var(--muted);font-size:0.7rem;margin-top:2px">Top: ${towerAn.topTowers.map(([t,c])=>esc(t)+' ('+c+')').join(', ')}</div>`:''}
        </div>
        <h4 style="margin-top:8px">Attributed services</h4>
        ${topSessionSvcs.length?'<div class="prof-id">'+topSessionSvcs.map(([nm,c])=>'<div style="display:flex;gap:6px;align-items:center;padding:1px 0"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:'+svcColor(nm)+';flex-shrink:0"></span><span style="flex:1">'+esc(nm)+'</span><span style="color:var(--muted)">'+c+'</span></div>').join('')+'</div>':'<div style="font-size:0.74rem;color:var(--muted)">No session data</div>'}
      </div>
    </div>
    ${towers.size?`<div class="prof-section"><h4>Towers (${towers.size})</h4>
      <div class="prof-tags">${[...towers].slice(0,15).map(t=>'<span class="prof-tag" data-tower="'+esc(t)+'" onclick="showTower(this.dataset.tower)" title="Show on map" style="cursor:pointer">'+esc(t)+'</span>').join('')}</div></div>`:''}
    <div class="prof-section" id="profileCrossCase"><h4>Cross-case links</h4><div style="font-size:0.74rem;color:var(--muted)">Checking other cases…</div></div>
    ${meetings.length?`<div class="prof-section"><h4 class="alert">Detected co-locations (${meetings.length})</h4>
      <div class="prof-list">${meetings.slice(0,8).map((m,mi)=>{
        const confColor=m.gapLevel==='high'?'var(--success)':m.gapLevel==='medium'?'var(--warn)':'var(--muted)';
        const confLabel=m.gapLevel==='high'?'High':m.gapLevel==='medium'?'Med':'Low';
        return '<div style="padding:2px 0;display:flex;align-items:center;gap:4px"><span style="color:'+confColor+'">&#9679;</span> '+esc(m.time.toLocaleString())+' with <strong style="cursor:pointer;color:var(--accent)" onclick="showProfile(\''+esc(m.subB)+'\')">'+subjLabel(m.subB)+'</strong> at '+twr(m.tow)+' <span style="color:'+confColor+';font-weight:600;font-size:0.68rem">['+confLabel+' '+m.score+']</span><button onclick="showMeetingOverlay(\''+esc(sub+'|'+sub)+'\','+mi+')" style="background:none;border:1px solid var(--line);color:var(--accent);padding:1px 6px;border-radius:3px;cursor:pointer;font-size:0.6rem">View</button></div>';
      }).join('')}</div></div>`:''}
    <div class="prof-section"><h4>Hourly activity</h4>
      <div class="prof-hours">${hours.map((h,i)=>`<div class="prof-hour" style="background:${h>Math.max(...hours)*0.7?'#b94a48':h>Math.max(...hours)*0.4?'#d4a017':'var(--accent)'};height:${Math.max(4,(h/Math.max(...hours||1))*40)}px" title="${i}:00 - ${h}"></div>`).join('')}</div></div>
    <div class="prof-section"><h4>Timeline narrative</h4>
      <div class="prof-list" style="border-left:2px solid var(--line);padding-left:8px">${(()=>{
      const narr=buildNarrative(sub);
      return narr.length?narr.map(nn=>`<div style="padding:1px 0;display:flex;gap:4px"><span style="color:${nn.type==='call'?'var(--danger)':nn.type==='movement'?'var(--warn)':nn.type==='meeting'?'var(--accent)':'var(--muted)'};flex-shrink:0">&#x2022;</span><span>${esc(nn.text)}</span></div>`).join(''):'<span style="color:var(--muted)">Insufficient data for narrative</span>';
    })()}</div></div>
    <div class="prof-section"><h4>Recent activity</h4>
      ${rows.slice(-10).reverse().map(r=>`<div class="evt" data-act="mapView" data-lat="${r.lat||0}" data-lng="${r.lng||0}" data-z="13"><span class="evt-time">${fmt(r.ts)}</span> <span class="evt-loc">${esc(r.type)} ${esc(r.cnt||'')} ${r.cll||''}</span></div>`).join('')}</div>
  `;
  D.profile.style.display='flex';
  fillProfileCrossCase(sub);
  fillProfileSubscriber(sub);
}
// SDR / subscriber identity card in the profile (async; only shows when an SDR record exists).
async function fillProfileSubscriber(sub){
  const box=document.getElementById('profileSubscriber');if(!box)return;
  try{
    const s=await API.get('/subscribers/'+encodeURIComponent(sub));
    if(!s||!s.found){box.innerHTML='';return;}
    const row=(label,val)=>val?'<div><strong>'+label+'</strong> '+esc(val)+'</div>':'';
    box.innerHTML='<div class="prof-sdr">'
      +'<div class="prof-sdr-h">&#128100; Subscriber (SDR)</div>'
      +row('Name',s.name)+row('Address',s.address)
      +(s.alt_number?'<div><strong>Alt number</strong> <span style="cursor:pointer;color:var(--accent)" onclick="showProfile(\''+esc(s.alt_number)+'\')">'+esc(s.alt_number)+'</span></div>':'')
      +row('ID proof',s.id_proof)+row('Activation',s.activation_date)+row('Operator',s.operator)
      +'</div>';
  }catch(e){box.innerHTML='';}
}

D.profileClose.addEventListener('click',()=>D.profile.style.display='none');
D.profile.addEventListener('click',e=>{if(e.target===D.profile)D.profile.style.display='none'});
// showProfile is referenced in onclick strings across many tabs; re-expose it (it moved out of app.js).
Object.assign(window,{showProfile});
