// entities/entities.js — the Entities tab: the resolved ENTITIES behind the identifiers. An
// entity is a linked-identifier cluster — a person, a shared handset, a device farm/SIM-box, an
// organisation, or an unknown group — deliberately NOT assumed to be one person (see entity_type).
// Left: entity cards (label, identifier counts, lifecycle flags). Right: the selected entity
// as an identity tree — PERSON -> phones / SIMs / devices / IPs / apps / locations / cases —
// plus the binding evidence (which record co-occurrences fused the identifiers, so the
// resolution is court-explainable) and inter-entity communication edges. Resolution itself is
// server-side (/entities, entity_service.py: same-record co-occurrence union-find; IPs are
// attributes, never merge keys). Self-registers the tab.

import { esc, n, fmt, _fmtDT } from '../core/utils.js';
import { state } from '../core/state.js';
import { API } from '../core/api.js';
import { registerTab, switchTab } from '../core/router.js';
import { svcColor } from '../core/constants.js';

let _entities=[],_edges=[],_selected=null,_labels={},_meta={};

const FLAG_META={
  sim_swap:{l:'SIM swap',c:'#8b5cf6',t:'One device carried more than one SIM'},
  device_change:{l:'Device change',c:'#b07d2b',t:'One SIM moved between devices'},
  multiple_numbers:{l:'Multiple numbers',c:'#b94a48',t:'More than one phone number in this cluster'},
  multi_case:{l:'Multi-case',c:'#d4a017',t:'Appears in more than one case'},
  device_reuse:{l:'Device reuse',c:'#c0392b',t:'An identifier is shared widely inside this cluster — strong as a device/organisation cluster, weak as an individual'},
};
// Entities are NOT assumed to be people: a cluster can be a person, a shared handset, a
// device farm/SIM-box, an organisation, or an unknown linked group. Icon + label reflect that.
const TYPE_META={
  individual:{icon:'\u{1F464}',c:'#1f7a8c'},        // person
  linked_identity:{icon:'\u{1F517}',c:'#3f6485'},   // linked identity
  identity_cluster:{icon:'\u{1F5C3}',c:'#b07d2b'},  // card-box: cluster / farm / org
  identifier:{icon:'\u{1F4C7}',c:'#6b839e'},        // single identifier
};
function typeMeta(e){return TYPE_META[e.entity_type]||TYPE_META.identifier}

function flagChips(flags){
  return (flags||[]).map(f=>{const m=FLAG_META[f]||{l:f,c:'#888',t:''};
    return '<span class="ent-flag" style="--fc:'+m.c+'" title="'+esc(m.t)+'">'+esc(m.l)+'</span>';}).join('');
}
const CONF_COLOR={HIGH:'#2e7d32',MEDIUM:'#c68a2c',LOW:'#b3261e'};
function confChip(c){const col=CONF_COLOR[c]||'#888';return '<span class="ent-conf" style="--cc:'+col+'">'+esc(c||'')+'</span>';}

async function renderEntities(){
  const list=document.getElementById('entList');if(!list)return;
  if(!state.data.records.length){list.innerHTML='<div class="story-muted" style="padding:30px">Load a case first.</div>';return;}
  list.innerHTML='<div class="story-muted" style="padding:30px">Resolving entities…</div>';
  let res;
  try{res=await API.get('/entities/'+(state.data.caseId?'?case_id='+encodeURIComponent(state.data.caseId):''));}
  catch(e){list.innerHTML='<div class="story-muted" style="padding:30px">Entity resolution failed: '+esc(e.message||'')+'</div>';return;}
  _entities=res.entities||[];_edges=res.edges||[];_meta=res.meta||{};
  _labels={};_entities.forEach(e=>_labels[e.id]=e.label);
  const sum=document.getElementById('entSummary');
  if(sum){const flagged=_entities.filter(e=>e.flags&&e.flags.length).length;
    const clusters=_entities.filter(e=>e.entity_type==='identity_cluster').length;
    const thr=_meta.hub_fanout_threshold;
    sum.innerHTML=_entities.length+' resolved '+(_entities.length===1?'entity':'entities')+' · '+_edges.length+' links'+(clusters?' · '+clusters+' cluster'+(clusters===1?'':'s'):'')+(flagged?' · '+flagged+' flagged':'')
      +(thr?' <span class="ent-thr" title="Learned from this case: an identifier linked to more than this many distinct others is treated as a shared/placeholder value and not merged through. Derived from the case’s own fan-out distribution, not a fixed cap.">merge cut-off: '+thr+'</span>':'');}
  _renderList();
  const search=document.getElementById('entSearch');
  if(search&&!search._wired){search._wired=true;search.addEventListener('input',_renderList);}
}

function _matches(e,q){
  if(!q)return true;
  return [...e.phones,...e.imsis,...e.imeis,...(e.ips||[]).map(i=>i.ip)].some(v=>v.toLowerCase().includes(q));
}

function _renderList(){
  const list=document.getElementById('entList');if(!list)return;
  const q=(document.getElementById('entSearch')?.value||'').trim().toLowerCase();
  const shown=_entities.filter(e=>_matches(e,q)).slice(0,300);
  if(!shown.length){list.innerHTML='<div class="story-muted" style="padding:30px">No entities'+(q?' match “'+esc(q)+'”':'')+'.</div>';return;}
  list.innerHTML=shown.map(e=>{const tm=typeMeta(e);return
    '<div class="ent-card'+(_selected===e.id?' sel':'')+'" data-id="'+e.id+'">'
    +'<div class="ent-card-h"><span class="ent-avatar" style="color:'+tm.c+'">'+tm.icon+'</span><b>'+esc(e.label)+'</b>'+flagChips(e.flags)+'</div>'
    +'<div class="ent-type" style="color:'+tm.c+'">'+esc(e.entity_type_label||'')+'</div>'
    +'<div class="ent-chips">'
    +(e.phones.length?'<span title="Phone numbers">&#9742; '+e.phones.length+'</span>':'')
    +(e.imsis.length?'<span title="SIMs (IMSI)">&#128273; '+e.imsis.length+'</span>':'')
    +(e.imeis.length?'<span title="Devices (IMEI)">&#128241; '+e.imeis.length+'</span>':'')
    +((e.ips||[]).length?'<span title="Observed IP endpoints">&#127760; '+e.ips.length+'</span>':'')
    +(e.cases.length>1?'<span title="Cases">&#128193; '+e.cases.length+'</span>':'')
    +'</div>'
    +'<div class="evidence-meta">'+n(e.record_count)+' records'+(e.first_seen?' · '+_fmtDT(e.first_seen)+' → '+_fmtDT(e.last_seen):'')+'</div>'
    +'</div>';}).join('');
  list.querySelectorAll('.ent-card').forEach(c=>c.onclick=()=>{_selected=c.dataset.id;_renderList();_renderDetail(c.dataset.id);});
}

function _branch(glyph,title,rowsHtml,count){
  if(!count)return'';
  return '<div class="ent-branch"><div class="ent-branch-h">'+glyph+' <b>'+title+'</b> <span class="story-muted">('+count+')</span></div>'
    +'<div class="ent-branch-rows">'+rowsHtml+'</div></div>';
}

async function _renderDetail(id){
  const box=document.getElementById('entDetail');if(!box)return;
  box.innerHTML='<div class="story-muted" style="padding:30px">Loading entity…</div>';
  let e;
  try{e=await API.get('/entities/'+encodeURIComponent(id)+(state.data.caseId?'?case_id='+encodeURIComponent(state.data.caseId):''));}
  catch(err){box.innerHTML='<div class="story-muted" style="padding:30px">Failed: '+esc(err.message||'')+'</div>';return;}
  const kindTag=k=>k==='public'?'':' <span class="ent-ipkind">'+esc(k)+'</span>';
  const phones=e.phones.map(p=>'<div class="ent-row"><span class="ent-val ent-link" onclick="showProfile(\''+esc(p)+'\')">'+esc(p)+'</span></div>').join('');
  const imsis=e.imsis.map(v=>'<div class="ent-row"><span class="ent-val">'+esc(v)+'</span></div>').join('');
  const imeis=e.imeis.map(v=>'<div class="ent-row"><span class="ent-val">'+esc(v)+'</span></div>').join('');
  const ips=(e.ips||[]).map(i=>'<div class="ent-row"><span class="ent-val">'+esc(i.ip)+'</span>'+kindTag(i.kind)+'<span class="ent-count">'+n(i.records)+' rec</span></div>').join('');
  const apps=(e.services||[]).map(s=>'<div class="ent-row"><span class="ent-dot" style="background:'+svcColor((s.service||'').replace('Likely ',''))+'"></span><span class="ent-val">'+esc(s.service)+'</span><span class="ent-count">'+n(s.records)+' rec · '+s.confidence+'%</span></div>').join('');
  const locs=(e.towers||[]).map(t=>'<div class="ent-row"><span class="ent-val">'+esc(t.tower_id)+'</span>'+(t.city?'<span class="story-muted">'+esc([t.city,t.state].filter(Boolean).join(', '))+'</span>':'')+'<span class="ent-count">'+n(t.records)+' rec</span></div>').join('');
  const cases=e.cases.map(c=>'<div class="ent-row"><span class="ent-val">'+esc(c)+'</span></div>').join('');
  // Binding evidence: typed link, confidence tier, and a plain-language explanation of WHY
  // ARGUS believes these identifiers are one entity — auditable, court-readable, per link.
  const links=(e.links||[]).slice(0,14).map(l=>{
    return '<div class="ent-row ent-evid"><div class="ent-evid-main">'+confChip(l.confidence)
      +'<span class="ent-linktype">'+esc(l.type||'')+'</span>'
      +'<span class="ent-val">'+esc(l.a)+' ↔ '+esc(l.b)+'</span></div>'
      +(l.explanation?'<div class="ent-evid-why">'+esc(l.explanation)+'</div>':'')+'</div>';
  }).join('');
  const edges=(e.edges||[]).slice(0,15).map(ed=>{
    const other=ed.a===e.id?ed.b:ed.a;
    const ext=other.startsWith('ext_');
    const label=ext?other.slice(4):(_labels[other]||other);
    return '<div class="ent-row">'
      +(ext?'<span class="ent-val">'+esc(label)+'</span><span class="story-muted">outside number</span>'
           :'<span class="ent-val ent-link" data-ent="'+esc(other)+'">&#128100; '+esc(label)+'</span>')
      +'<span class="ent-count">'+n(ed.calls)+' call'+(ed.calls===1?'':'s')+'</span></div>';
  }).join('');
  const tm=typeMeta(e);
  box.innerHTML='<div class="ent-person">'
    +'<div class="ent-person-h"><span class="ent-avatar big" style="color:'+tm.c+'">'+tm.icon+'</span><div><div class="ent-person-name">'+esc(e.label)+'</div>'
    +'<div class="ent-type" style="color:'+tm.c+';font-size:.8rem">'+esc(e.entity_type_label||'')+'</div>'
    +'<div class="evidence-meta">'+n(e.record_count)+' records'+(e.first_seen?' · active '+_fmtDT(e.first_seen)+' → '+_fmtDT(e.last_seen):'')+'</div></div>'
    +'<div style="flex:1"></div>'+flagChips(e.flags)+'</div>'
    +'<div class="ent-tree">'
    +_branch('&#9742;','Phone numbers',phones,e.phones.length)
    +_branch('&#128273;','SIMs (IMSI)',imsis,e.imsis.length)
    +_branch('&#128241;','Devices (IMEI)',imeis,e.imeis.length)
    +_branch('&#127760;','IP endpoints',ips,(e.ips||[]).length)
    +_branch('&#9654;','Apps / services',apps,(e.services||[]).length)
    +_branch('&#128205;','Locations',locs,(e.towers||[]).length)
    +_branch('&#128193;','Cases',cases,e.cases.length)
    +_branch('&#128279;','Communicates with',edges,(e.edges||[]).length)
    +_branch('&#9878;','Binding evidence',links,(e.links||[]).length)
    +'</div></div>';
  box.querySelectorAll('.ent-link[data-ent]').forEach(a=>a.onclick=()=>{_selected=a.dataset.ent;_renderList();_renderDetail(a.dataset.ent);});
}

// Deep-link: open the Entities tab focused on one entity (used by the Graph tab's
// entity nodes, and available to inline handlers via the window bridge below).
export async function showEntity(id){
  switchTab('entities');
  _selected=id;
  if(!_entities.length)await renderEntities();
  _renderList();
  _renderDetail(id);
}
Object.assign(window,{showEntity});

registerTab('entities', renderEntities);
