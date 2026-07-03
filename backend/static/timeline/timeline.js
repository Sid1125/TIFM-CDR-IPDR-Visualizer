// timeline/timeline.js — the Entity Timeline tab: groups records by entity (subject + counterparts),
// renders a lazy, paginated list of entity cards (headers first, bodies on expand) with an activity
// density strip, a per-session Gantt (from the shared session engine) and a recent-event list; plus a
// 2-up compare mode. Extracted from app.js (feature layer). Uses reconstructSessions + recordSvcAttr +
// svcColor. showProfile / showGanttTip / scheduleHideGanttTip in onclick strings resolve via the
// window bridge; tlToggleEntity + _tlLoadMore are re-exposed here (they moved out of app.js). No
// behavior change.

import { esc, fmts, debounce } from '../core/utils.js';
import { D } from '../core/dom.js';
import { state } from '../core/state.js';
import { svcColor } from '../core/constants.js';
import { reconstructSessions } from '../services/sessions.js';
import { recordSvcAttr } from '../services/attribution.js';
import { registerTab } from '../core/router.js';

// Entity store for lazy timeline body rendering \u2014 keyed by index in the current render pass
window._tlEntityStore={};
const _tlOpenEntities=new Set();  // persist open state across re-renders
const TL_PAGE=80;                  // entities rendered per page

export function renderTimeline(){
  if(!state.data.records.length)return;
  // Populate compare dropdown
  const curVal=D.tlCompare.value;
  D.tlCompare.innerHTML='<option value="">Compare with...</option>'+state.subjects.map(s=>`<option value="${esc(s)}"${s===curVal?' selected':''}>${esc(s)}</option>`).join('');
  const compare=D.tlCompare.value;
  const type=D.tlType.value;
  const q=D.tlSearch.value.trim().toLowerCase();
  let rows=state.data.records;
  if(type)rows=rows.filter(r=>r.type===type);
  const entityMap={};
  for(const r of rows){
    const entities=[];
    if(r.sub)entities.push(r.sub);
    if(r.cnt&&r.cnt!==r.sub)entities.push(r.cnt);
    for(const e of entities){
      if(!entityMap[e])entityMap[e]={entity:e,events:[],types:new Set(),contacts:new Set(),first:r.ts,last:r.ts,count:0};
      entityMap[e].events.push(r);
      entityMap[e].types.add(r.type);
      if(r.cnt&&r.cnt!==e)entityMap[e].contacts.add(r.cnt);
      if(r.sub&&r.sub!==e)entityMap[e].contacts.add(r.sub);
      if(r.ts){if(!entityMap[e].first||r.ts<entityMap[e].first)entityMap[e].first=r.ts;if(!entityMap[e].last||r.ts>entityMap[e].last)entityMap[e].last=r.ts}
      entityMap[e].count++;
    }
  }
  let entities=Object.values(entityMap).sort((a,b)=>b.count-a.count);
  if(q)entities=entities.filter(e=>e.entity.toLowerCase().includes(q));
  D.tlCount.textContent=`${entities.length} entities`;

  if(compare&&compare!==entities[0]?.entity){
    // Compare mode: render full bodies for exactly 2 entities (already fast)
    const e1=entities.find(e=>e.entity===compare);
    const e2=entities.find(e=>e.entity!==compare);
    D.tlContainer.innerHTML='<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">'+
      [e1,e2].filter(Boolean).map(ent=>'<div><h4 style="font-size:0.85rem;margin:0 0 8px;color:var(--muted)">'+esc(ent.entity)+'</h4>'+
        renderEntityTimeline(ent)+'</div>'
      ).join('')+'</div>';
    return;
  }

  // Lazy-body mode: render headers only; bodies generated on first expand
  window._tlEntityStore={};
  const page=entities.slice(0,TL_PAGE);
  const more=entities.length-TL_PAGE;
  page.forEach((e,i)=>{window._tlEntityStore[i]=e;});
  D.tlContainer.innerHTML=
    page.map((e,i)=>_tlEntityHeader(e,i)).join('')+
    (more>0?`<button class="tl-more-btn" onclick="_tlLoadMore(this,${TL_PAGE})">${more} more entities \u2014 click to load</button>`:'');
  // Restore previously-open entities
  D.tlContainer.querySelectorAll('.tl-entity[data-eidx]').forEach(el=>{
    const e=window._tlEntityStore[+el.dataset.eidx];
    if(e&&_tlOpenEntities.has(e.entity)){
      const body=el.querySelector('.tl-entity-body');
      if(body&&!body.dataset.rendered){body.innerHTML=renderEntityBody(e);body.dataset.rendered='1';}
      body.style.display='block';el.classList.add('open');
      const arrow=el.querySelector('.tl-entity-arrow');if(arrow)arrow.textContent='\u25BC';
    }
  });
}

function _tlEntityHeader(e,i){
  const evSorted=e.events.slice().sort((a,b)=>new Date(a.ts)-new Date(b.ts));
  const firstT=evSorted.length?new Date(evSorted[0].ts).getTime():0;
  const lastT=evSorted.length?new Date(evSorted[evSorted.length-1].ts).getTime():0;
  const span=Math.max(lastT-firstT,1);
  const density=Array(50).fill(0);
  evSorted.forEach(r=>{if(r.ts){const idx=Math.min(49,Math.floor((new Date(r.ts).getTime()-firstT)/span*49));density[idx]++;}});
  const maxD=Math.max(...density,1);
  return `<div class="tl-entity" data-eidx="${i}">
    <div class="tl-entity-head" onclick="tlToggleEntity(this)">
      <span class="tl-entity-name">${esc(e.entity)}</span>
      <span class="tl-entity-meta">${e.count} events &middot; ${e.contacts.size} contacts</span>
      <div class="tl-density">${density.map(d=>`<i style="height:${Math.max(2,(d/maxD)*14)}px"></i>`).join('')}</div>
      <span class="tl-entity-arrow">&#9654;</span>
    </div>
    <div class="tl-entity-body" style="display:none"></div>
  </div>`;
}

function _tlLoadMore(btn,offset){
  const entities=Object.values(window._tlEntityStore||{});
  // _tlEntityStore only holds the first page; need the full list from the DOM context
  // Re-render remaining entities by rebuilding from state.data.records filtered to current query
  const type=D.tlType.value,q=D.tlSearch.value.trim().toLowerCase();
  let rows=state.data.records;if(type)rows=rows.filter(r=>r.type===type);
  const entityMap={};
  for(const r of rows){
    const ents=[];if(r.sub)ents.push(r.sub);if(r.cnt&&r.cnt!==r.sub)ents.push(r.cnt);
    for(const e of ents){
      if(!entityMap[e])entityMap[e]={entity:e,events:[],types:new Set(),contacts:new Set(),first:r.ts,last:r.ts,count:0};
      entityMap[e].events.push(r);entityMap[e].types.add(r.type);
      if(r.cnt&&r.cnt!==e)entityMap[e].contacts.add(r.cnt);if(r.sub&&r.sub!==e)entityMap[e].contacts.add(r.sub);
      entityMap[e].count++;
    }
  }
  let all=Object.values(entityMap).sort((a,b)=>b.count-a.count);
  if(q)all=all.filter(e=>e.entity.toLowerCase().includes(q));
  const next=all.slice(offset,offset+TL_PAGE);
  const remaining=all.length-offset-TL_PAGE;
  next.forEach((e,j)=>{window._tlEntityStore[offset+j]=e;});
  const frag=document.createDocumentFragment();
  next.forEach((e,j)=>{ const div=document.createElement('div');div.innerHTML=_tlEntityHeader(e,offset+j);frag.appendChild(div.firstElementChild); });
  const newBtn=remaining>0?Object.assign(document.createElement('button'),{className:'tl-more-btn',textContent:remaining+' more entities \u2014 click to load',onclick:()=>_tlLoadMore(newBtn,offset+TL_PAGE)}):null;
  btn.replaceWith(frag,...(newBtn?[newBtn]:[]));
}

function tlToggleEntity(head){
  const card=head.closest('.tl-entity');
  if(!card)return;
  const body=card.querySelector('.tl-entity-body');
  const arrow=card.querySelector('.tl-entity-arrow');
  const isOpen=!card.classList.contains('open');
  card.classList.toggle('open',isOpen);
  body.style.display=isOpen?'block':'none';
  if(arrow)arrow.textContent=isOpen?'\u25BC':'\u25B6';
  const e=window._tlEntityStore&&window._tlEntityStore[+card.dataset.eidx];
  if(e){
    if(isOpen)_tlOpenEntities.add(e.entity); else _tlOpenEntities.delete(e.entity);
    if(isOpen&&!body.dataset.rendered){body.innerHTML=renderEntityBody(e);body.dataset.rendered='1';}
  }
}
// Body-only renderer \u2014 called lazily when user first expands an entity card.
// Uses cached reconstructSessions so the per-entity cost is paid once.
function renderEntityBody(e){
  const sessions=reconstructSessions(e.entity);  // cached
  const evSorted=e.events.slice().sort((a,b)=>new Date(a.ts)-new Date(b.ts));
  const firstT=evSorted.length?new Date(evSorted[0].ts).getTime():0;
  const lastT=evSorted.length?new Date(evSorted[evSorted.length-1].ts).getTime():0;
  const span=Math.max(lastT-firstT,1);
  const gantt=sessions.length?`<div class="tl-gantt">${sessions.map(s=>{
    const svcName=s.primary?s.primary.service:(s.service||'');
    const c=svcColor(svcName);
    const st=s.start?new Date(s.start).getTime():firstT;
    const et=s.end?new Date(s.end).getTime():lastT;
    const left=Math.max(0,((st-firstT)/span)*100);
    const w=Math.max(2,((et-st)/span)*100);
    const evText=Array.isArray(s.evidence)?s.evidence.join(', '):(s.evidence||'');
    // Prefer the synthesized activity event ("Probable WhatsApp Voice Call · 86%") over the
    // raw session label — the event overlay fuses IP + port + session-level behavior.
    const disLabel=s.eventActivity||s.activityLabel||s.activity||'';
    const conf=s.eventConfidence||s.serviceConfidence;
    const attr=esc(disLabel)+(conf?` (${Math.round(conf)}%)`:'');
    const badgeLabel=s.eventTitle||s.serviceLabel||s.service||svcName;
    const alts=s.candidates&&s.candidates.length?JSON.stringify(s.candidates.slice(0,4)):'';
    const sid='sess_'+s.start+'_'+Math.random().toString(36).slice(2,6);
    window.evSessions=window.evSessions||{};window.evSessions[sid]=s;
    return `<div class="tl-gantt-bar" style="margin-left:${left}%;width:${w}%;background:${c}18;border-left:2px solid ${c}"
      data-svc="${esc(svcName)}" data-attr="${attr}" data-start="${s.start||''}" data-end="${s.end||''}" data-dur="${s.duration}" data-conf="${conf?Math.round(conf):''}" data-ev="${esc(evText)}" data-alts="${esc(alts)}" data-sid="${sid}" data-recs="${s.records||0}"
      onmouseover="showGanttTip(this,event)" onmouseout="scheduleHideGanttTip()">
      <span style="background:${c}">${esc(badgeLabel)}</span> ${esc(disLabel)} <em>${s.duration>=60?Math.floor(s.duration/60)+'m':s.duration+'s'}</em>
    </div>`;
  }).join('')}</div>`:'';
  const eventRows=evSorted.slice(-50).reverse().map(r=>`
    <div class="tl-ev" onclick="event.stopPropagation();showProfile('${esc(r.sub||r.cnt||'')}')">
      <span class="tl-ev-time">${fmts(r.ts)}</span>
      <span class="tl-ev-dot" style="background:${r.type==='IPDR'?'#b94a48':'var(--accent)'}"></span>
      <span class="tl-ev-type${r.type==='IPDR'?' ipdr':''}">${r.type}</span>
      <span class="tl-ev-peer">${esc(r.cnt||r.sub||'')}</span>
      <span class="tl-ev-meta">${r.dur?r.dur+'s':''} ${esc(r.cll||r.prot||'')}</span>
      <span class="tl-ev-svc">${r.type==='IPDR'?esc(recordSvcAttr(r)||r.svc||''):esc(r.svc||'')}</span>
    </div>`).join('');
  return gantt+'<div class="tl-events">'+eventRows+'</div>';
}

// Full-card renderer used only for compare mode (exactly 2 entities \u2014 no perf concern)
function renderEntityTimeline(e){
  const evSorted=e.events.slice().sort((a,b)=>new Date(a.ts)-new Date(b.ts));
  const firstT=evSorted.length?new Date(evSorted[0].ts).getTime():0;
  const lastT=evSorted.length?new Date(evSorted[evSorted.length-1].ts).getTime():0;
  const span=Math.max(lastT-firstT,1);
  const density=Array(50).fill(0);
  evSorted.forEach(r=>{if(r.ts){const idx=Math.min(49,Math.floor((new Date(r.ts).getTime()-firstT)/span*49));density[idx]++;}});
  const maxD=Math.max(...density,1);
  const sessions=reconstructSessions(e.entity);
  return `<div class="tl-entity open">
    <div class="tl-entity-head" onclick="tlToggleEntity(this)">
      <span class="tl-entity-name">${esc(e.entity)}</span>
      <span class="tl-entity-meta">${e.count} events${sessions.length?` &middot; ${sessions.length} sessions`:''} &middot; ${e.contacts.size} contacts</span>
      <div class="tl-density">${density.map(d=>`<i style="height:${Math.max(2,(d/maxD)*14)}px"></i>`).join('')}</div>
      <span class="tl-entity-arrow">&#9660;</span>
    </div>
    <div class="tl-entity-body" style="display:block" data-rendered="1">${renderEntityBody(e)}</div>
  </div>`;
}
// Legacy alias used inside old code paths
function toggleEntity(el){tlToggleEntity(el);}
D.tlSearch.addEventListener('input',debounce(renderTimeline));
D.tlType.addEventListener('change',renderTimeline);
D.tlCompare.addEventListener('change',renderTimeline);

// This tab owns its rendering; register + re-expose the two inline-handler names that moved here.
registerTab('timeline', renderTimeline);
Object.assign(window,{tlToggleEntity,_tlLoadMore});
