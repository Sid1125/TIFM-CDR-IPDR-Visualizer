// entities/entities.js — the Entity Intelligence tab: identifiers resolved into persistent,
// reviewable entities. Left: entity cards (confidence, review status, lifecycle flags) plus the
// suggested-merge queue (pairs ARGUS deliberately did NOT auto-merge — investigator decides).
// Right: the INVESTIGATION GRAPH — a radial ego graph centred on the entity (phones / SIMs /
// devices / IPs / services / towers / cases / related entities, every edge typed and carrying
// its deterministic "why"), then the review bar, then the identity tree with binding evidence.
// Resolution is server-side and persisted (/entities, entity_graph_service.py); investigator
// merge verdicts are durable: rejected stays rejected, confirmed survives the hub guard.
// Self-registers the tab.

import { esc, n, fmt, _fmtDT } from '../core/utils.js';
import { state } from '../core/state.js';
import { API } from '../core/api.js';
import { registerTab, switchTab } from '../core/router.js';
import { svcColor } from '../core/constants.js';
import { toast } from '../ui/toast.js';
import { showProfile } from '../records/profile.js';

let _entities=[],_edges=[],_suggestions=[],_selected=null,_labels={},_meta={};
// Scope the CURRENT detail view resolved in: ''=case scope of the active case, or 'global' when
// the entity only exists in the all-cases resolution (cross-case deep-links). Review calls must
// target the same scope the entity row lives in, or the backend rightly 404s.
let _detailGlobal=false;

const FLAG_META={
  sim_swap:{l:'SIM swap',c:'#8b5cf6',t:'One device carried more than one SIM'},
  device_change:{l:'Device change',c:'#b07d2b',t:'One SIM moved between devices'},
  multiple_numbers:{l:'Multiple numbers',c:'#b94a48',t:'More than one phone number in this cluster'},
  multi_case:{l:'Multi-case',c:'#d4a017',t:'Appears in more than one case'},
  device_reuse:{l:'Device reuse',c:'#c0392b',t:'An identifier is shared widely inside this cluster — strong as a device/organisation cluster, weak as an individual'},
};
const TYPE_META={
  individual:{icon:'\u{1F464}',c:'#1f7a8c'},
  linked_identity:{icon:'\u{1F517}',c:'#3f6485'},
  identity_cluster:{icon:'\u{1F5C3}',c:'#b07d2b'},
  identifier:{icon:'\u{1F4C7}',c:'#6b839e'},
};
function typeMeta(e){return TYPE_META[e.entity_type]||TYPE_META.identifier}

function flagChips(flags){
  return (flags||[]).map(f=>{const m=FLAG_META[f]||{l:f,c:'#888',t:''};
    return '<span class="ent-flag" style="--fc:'+m.c+'" title="'+esc(m.t)+'">'+esc(m.l)+'</span>';}).join('');
}
const CONF_COLOR={HIGH:'#2e7d32',MEDIUM:'#c68a2c',LOW:'#b3261e'};
function confChip(c){const col=CONF_COLOR[c]||'#888';return '<span class="ent-conf" style="--cc:'+col+'">'+esc(c||'')+'</span>';}
function pctChip(p){const col=p>=85?'#2e7d32':p>=65?'#c68a2c':'#b3261e';
  return '<span class="ent-conf" style="--cc:'+col+'" title="Confidence these identifiers belong together — the weakest binding link defines it">'+p+'%</span>';}
const REVIEW_META={confirmed:{l:'CONFIRMED',c:'#2e7d32',t:'An investigator confirmed this entity'},
  rejected:{l:'REJECTED',c:'#b3261e',t:'An investigator marked this entity as a false merge'}};
function reviewChip(st){const m=REVIEW_META[st];if(!m)return'';
  return '<span class="ent-conf" style="--cc:'+m.c+'" title="'+esc(m.t)+'">'+m.l+'</span>';}

async function renderEntities(){
  const list=document.getElementById('entList');if(!list)return;
  if(!state.data.records.length){list.innerHTML='<div class="story-muted" style="padding:30px">Load a case first.</div>';return;}
  list.innerHTML='<div class="story-muted" style="padding:30px">Resolving entities…</div>';
  let res;
  try{res=await API.get('/entities/'+(state.data.caseId?'?case_id='+encodeURIComponent(state.data.caseId):''));}
  catch(e){list.innerHTML='<div class="story-muted" style="padding:30px">Entity resolution failed: '+esc(e.message||'')+'</div>';return;}
  _entities=res.entities||[];_edges=res.edges||[];_meta=res.meta||{};_suggestions=res.suggestions||[];
  _labels={};_entities.forEach(e=>_labels[e.id]=e.label);
  const sum=document.getElementById('entSummary');
  if(sum){const flagged=_entities.filter(e=>e.flags&&e.flags.length).length;
    const clusters=_meta.cluster_count||0;
    const thr=_meta.hub_fanout_threshold;
    sum.innerHTML=(_meta.total??_entities.length)+' resolved '+((_meta.total??_entities.length)===1?'entity':'entities')+' · '+_edges.length+' links'
      +(clusters?' · '+clusters+' cluster'+(clusters===1?'':'s'):'')+(flagged?' · '+flagged+' flagged':'')
      +(_suggestions.length?' · <span style="color:#c68a2c">'+_suggestions.length+' suggested merge'+(_suggestions.length===1?'':'s')+'</span>':'')
      +(thr?' <span class="ent-thr" title="Learned from this case: an identifier linked to more than this many distinct others is treated as a shared/placeholder value and not merged through. Derived from the case’s own fan-out distribution, not a fixed cap.">merge cut-off: '+thr+'</span>':'');}
  _renderList();
  const search=document.getElementById('entSearch');
  if(search&&!search._wired){search._wired=true;search.addEventListener('input',_renderList);}
}

function _matches(e,q){
  if(!q)return true;
  return [...e.phones,...e.imsis,...e.imeis,...(e.ips||[]).map(i=>i.ip)].some(v=>v.toLowerCase().includes(q));
}

// The suggested-merge queue: pairs ARGUS withheld (shared/placeholder identifier). The
// investigator's verdict is durable — reject and it never merges; confirm and it merges
// even through the hub guard. Every row states exactly why the automatic merge was withheld.
function _suggestionQueue(){
  if(!_suggestions.length)return'';
  const rows=_suggestions.slice(0,8).map(s=>(
    '<div class="ent-sug" title="'+esc(s.reason||'')+'">'
    +'<div class="ent-sug-main">'+confChip(s.confidence)
    +'<span class="ent-val">'+esc(s.a_label)+' ↔ '+esc(s.b_label)+'</span>'
    +'<span class="ent-count">'+n(s.records)+' rec</span></div>'
    +'<div class="ent-evid-why">'+esc(s.reason||'')+'</div>'
    +'<div class="ent-sug-btns">'
    +'<button class="btn-sm" data-sug-act="confirm_merge" data-pk="'+esc(s.pair_key)+'" data-uid="'+esc(s.a_entity)+'">Confirm merge</button>'
    +'<button class="btn-sm" data-sug-act="reject_merge" data-pk="'+esc(s.pair_key)+'" data-uid="'+esc(s.a_entity)+'">Reject</button>'
    +'</div></div>')).join('');
  return '<div class="ent-sug-box"><div class="ent-branch-h">&#9888; <b>Suggested merges</b> <span class="story-muted">('+_suggestions.length+') — ARGUS did not merge these automatically; your verdict is recorded and durable</span></div>'
    +rows+(_suggestions.length>8?'<div class="story-muted" style="font-size:.72rem;padding:4px 2px">+'+(_suggestions.length-8)+' more…</div>':'')+'</div>';
}

function _renderList(){
  const list=document.getElementById('entList');if(!list)return;
  const q=(document.getElementById('entSearch')?.value||'').trim().toLowerCase();
  const shown=_entities.filter(e=>_matches(e,q)).slice(0,300);
  const queue=q?'':_suggestionQueue();
  if(!shown.length){list.innerHTML=queue+'<div class="story-muted" style="padding:30px">No entities'+(q?' match “'+esc(q)+'”':'')+'.</div>';_wireList(list);return;}
  list.innerHTML=queue+shown.map(e=>{const tm=typeMeta(e);return (
    '<div class="ent-card'+(_selected===e.id?' sel':'')+'" data-id="'+e.id+'">'
    +'<div class="ent-card-h"><span class="ent-avatar" style="color:'+tm.c+'">'+tm.icon+'</span><b>'+esc(e.label)+'</b>'
    +(e.confidence!=null?pctChip(e.confidence):'')+reviewChip(e.reviewed_status)+flagChips(e.flags)+'</div>'
    +'<div class="ent-type" style="color:'+tm.c+'">'+esc(e.entity_type_label||'')+'</div>'
    +'<div class="ent-chips">'
    +(e.phones.length?'<span title="Phone numbers">&#9742; '+e.phones.length+'</span>':'')
    +(e.imsis.length?'<span title="SIMs (IMSI)">&#128273; '+e.imsis.length+'</span>':'')
    +(e.imeis.length?'<span title="Devices (IMEI)">&#128241; '+e.imeis.length+'</span>':'')
    +((e.ips||[]).length?'<span title="Observed IP endpoints">&#127760; '+e.ips.length+'</span>':'')
    +(e.cases.length>1?'<span title="Cases">&#128193; '+e.cases.length+'</span>':'')
    +'</div>'
    +'<div class="evidence-meta">'+n(e.record_count)+' records'+(e.first_seen?' · '+_fmtDT(e.first_seen)+' → '+_fmtDT(e.last_seen):'')+'</div>'
    +'</div>');}).join('');
  _wireList(list);
}
function _wireList(list){
  list.querySelectorAll('.ent-card').forEach(c=>c.onclick=()=>{_selected=c.dataset.id;_renderList();_renderDetail(c.dataset.id);});
  list.querySelectorAll('[data-sug-act]').forEach(b=>b.onclick=ev=>{ev.stopPropagation();
    _review(b.dataset.uid,b.dataset.act||b.dataset.sugAct,b.dataset.pk,null,true);});
}

// ── Investigation ego graph — radial, typed, capped server-side; expansion = click a neighbour ──
const NODE_COLOR={phone:'#1f7a8c',sim:'#8b5cf6',device:'#b07d2b',ip:'#6b839e',
  service:'#3f6485',tower:'#2e7d32',case:'#d4a017',entity:'#1f7a8c',external:'#888'};
const NODE_GLYPH={phone:'☎',sim:'\u{1F511}',device:'\u{1F4F1}',ip:'\u{1F310}',
  service:'▶',tower:'\u{1F4CD}',case:'\u{1F4C1}',entity:'\u{1F464}',external:'↗'};
const GROUP_ORDER=['phone','sim','device','ip','service','tower','case','entity','external'];
const EDGE_LABEL={USES_NUMBER:'uses number',OWNS_SIM:'owns SIM',USES_DEVICE:'uses device',
  OBSERVED_IP:'observed IP',USES_SERVICE:'uses service',SEEN_AT:'seen at',
  APPEARS_IN_CASE:'appears in case',CONTACTED:'contacted',CO_LOCATED:'co-located',
  POSSIBLE_ASSOCIATION:'possible association',SUGGESTED_MERGE:'suggested merge'};
const DASHED=new Set(['CO_LOCATED','POSSIBLE_ASSOCIATION','SUGGESTED_MERGE']);

function _egoSvg(g){
  const W=780,H=440,cx=W/2,cy=H/2,R=150;
  const others=g.nodes.filter(nd=>!nd.center);
  others.sort((a,b)=>GROUP_ORDER.indexOf(a.type)-GROUP_ORDER.indexOf(b.type));
  const N=others.length||1;
  const pos={};others.forEach((nd,i)=>{const a=(i/N)*2*Math.PI-Math.PI/2;
    const r=nd.type==='entity'||nd.type==='external'?R+34:R;
    pos[nd.id]={x:cx+r*Math.cos(a),y:cy+r*Math.sin(a)};});
  const center=g.nodes.find(nd=>nd.center);
  pos[center.id]={x:cx,y:cy};
  let svg='<svg viewBox="0 0 '+W+' '+H+'" class="ent-ego-svg" role="img" aria-label="Investigation graph">';
  g.edges.forEach((ed,i)=>{
    const p1=pos[ed.source],p2=pos[ed.target];if(!p1||!p2)return;
    const col=CONF_COLOR[ed.confidence]||'#8da0b7';
    svg+='<line x1="'+p1.x+'" y1="'+p1.y+'" x2="'+p2.x+'" y2="'+p2.y+'" stroke="'+col+'" stroke-opacity=".55" stroke-width="1.4"'
      +(DASHED.has(ed.type)?' stroke-dasharray="5 4"':'')
      +' class="ent-ego-edge" data-ei="'+i+'"><title>'+esc((EDGE_LABEL[ed.type]||ed.type)+(ed.evidence_count?' · '+ed.evidence_count+' rec':'')+(ed.explanation?'\n'+ed.explanation:''))+'</title></line>';
  });
  others.forEach(nd=>{
    const p=pos[nd.id],col=NODE_COLOR[nd.type]||'#888';
    const lbl=(nd.label||'').length>15?(nd.label||'').slice(0,14)+'…':(nd.label||'');
    svg+='<g class="ent-ego-node" data-nid="'+esc(nd.id)+'" data-ntype="'+nd.type+'" data-nlabel="'+esc(nd.label||'')+'">'
      +'<circle cx="'+p.x+'" cy="'+p.y+'" r="13" fill="'+col+'" fill-opacity=".14" stroke="'+col+'" stroke-width="1.5"/>'
      +'<text x="'+p.x+'" y="'+(p.y+3.5)+'" text-anchor="middle" font-size="10">'+NODE_GLYPH[nd.type]+'</text>'
      +'<text x="'+p.x+'" y="'+(p.y+26)+'" text-anchor="middle" font-size="9" fill="currentColor" opacity=".85">'+esc(lbl)+'</text>'
      +'<title>'+esc(nd.type+': '+(nd.label||'')+(nd.records?' · '+nd.records+' rec':'')+(nd.city?' · '+nd.city:''))+'</title></g>';
  });
  const cc=NODE_COLOR[center.classification==='identity_cluster'?'device':'entity']||'#1f7a8c';
  svg+='<g class="ent-ego-center"><circle cx="'+cx+'" cy="'+cy+'" r="30" fill="'+cc+'" fill-opacity=".18" stroke="'+cc+'" stroke-width="2.2"/>'
    +'<text x="'+cx+'" y="'+(cy+5)+'" text-anchor="middle" font-size="15">'+(TYPE_META[center.classification]||TYPE_META.identifier).icon+'</text>'
    +'<text x="'+cx+'" y="'+(cy+46)+'" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">'+esc(center.label)+'</text></g>';
  svg+='</svg>';
  const truncNote=Object.keys(g.truncated||{}).length
    ?'<div class="story-muted" style="font-size:.7rem;padding:2px 6px">Capped for readability — '
      +Object.entries(g.truncated).map(([k,v])=>'+'+v+' more '+k).join(', ')+' in the identity tree below.</div>':'';
  return '<div class="ent-ego">'+svg+truncNote
    +'<div class="ent-ego-why story-muted" id="entEgoWhy">Hover an edge or node for its evidence; click a related entity to pivot.</div></div>';
}

function _wireEgo(box,g){
  const why=box.querySelector('#entEgoWhy');
  box.querySelectorAll('.ent-ego-edge').forEach(l=>{
    l.addEventListener('mouseenter',()=>{const ed=g.edges[+l.dataset.ei];if(ed&&why)
      why.textContent=(EDGE_LABEL[ed.type]||ed.type).toUpperCase()+(ed.confidence?' · '+ed.confidence:'')+(ed.explanation?' — '+ed.explanation:'');
      l.setAttribute('stroke-width','2.6');});
    l.addEventListener('mouseleave',()=>l.setAttribute('stroke-width','1.4'));
  });
  box.querySelectorAll('.ent-ego-node').forEach(nd=>{
    nd.style.cursor='pointer';
    nd.addEventListener('click',()=>{
      const t=nd.dataset.ntype,id=nd.dataset.nid,label=nd.dataset.nlabel;
      if(t==='phone')showProfile(label);
      else if(t==='entity'){_selected=id;_renderList();_renderDetail(id);}
      else if(why)why.textContent=t+': '+label;
    });
  });
}

function _branch(glyph,title,rowsHtml,count){
  if(!count)return'';
  return '<div class="ent-branch"><div class="ent-branch-h">'+glyph+' <b>'+title+'</b> <span class="story-muted">('+count+')</span></div>'
    +'<div class="ent-branch-rows">'+rowsHtml+'</div></div>';
}

// Review bar: the entity-level verdict (confirm / false positive / note). Merge verdicts live
// on the suggestion rows and the binding-evidence rows. Everything lands in the audit chain.
function _reviewBar(e){
  const st=e.reviewed_status||'unreviewed';
  const btns=st==='unreviewed'
    ?'<button class="btn-sm" data-rev="confirm">&#10003; Confirm entity</button><button class="btn-sm" data-rev="reject">&#10007; False merge</button>'
    :'<button class="btn-sm" data-rev="unreview">Un-review</button>';
  return '<div class="ent-review">'+(reviewChip(st)||'<span class="ent-conf" style="--cc:#6b839e" title="Machine-resolved; not yet reviewed">SYSTEM</span>')
    +(e.confidence!=null?pctChip(e.confidence):'')
    +'<span style="flex:1"></span>'+btns
    +'<button class="btn-sm" data-rev="note">&#9998; Note</button>'
    +(e.review_note?'<div class="ent-evid-why" style="width:100%">&#128221; '+esc(e.review_note)+(e.reviewed_by?' — '+esc(e.reviewed_by):'')+'</div>':'')
    +'</div>';
}

async function _review(uid,action,pairKey,note,reloadAll,useGlobal){
  if(action==='note'&&note==null){note=prompt('Investigator note for this entity:','');if(note==null)return;}
  if(action==='reject_merge'&&note==null){note=prompt('Why reject this merge? (optional, recorded in the audit chain)','')||'';}
  const qs=(!useGlobal&&state.data.caseId)?'?case_id='+encodeURIComponent(state.data.caseId):'';
  try{
    await API.post('/entities/'+encodeURIComponent(uid)+'/review'+qs,
      {action,pair_key:pairKey||null,note:note||null});
    toast(action.includes('merge')?(action==='confirm_merge'?'Merge confirmed — entities combined':'Merge rejected — will never auto-merge again'):'Saved');
  }catch(e){toast('Review failed: '+(e.message||''));return;}
  if(reloadAll||action.includes('merge')){_selected=null;await renderEntities();
    const box=document.getElementById('entDetail');
    if(box)box.innerHTML='<div class="story-muted" style="padding:40px;text-align:center">Select an entity to see the identifiers behind it and why they were linked.</div>';
  }else if(useGlobal){_renderDetail(uid);}
  else{await renderEntities();_renderDetail(uid);}
}

async function _renderDetail(id){
  const box=document.getElementById('entDetail');if(!box)return;
  box.innerHTML='<div class="story-muted" style="padding:30px">Loading entity…</div>';
  const qs=state.data.caseId?'?case_id='+encodeURIComponent(state.data.caseId):'';
  let e,g;
  _detailGlobal=false;
  try{[e,g]=await Promise.all([
    API.get('/entities/'+encodeURIComponent(id)+qs),
    API.get('/entities/'+encodeURIComponent(id)+'/graph'+qs).catch(()=>null)]);}
  catch(err){
    // Cross-case deep-links carry GLOBAL-scope uids (the same cluster hashes differently when
    // resolved within one case) — fall back to the all-cases view rather than failing.
    if(qs){try{[e,g]=await Promise.all([
      API.get('/entities/'+encodeURIComponent(id)),
      API.get('/entities/'+encodeURIComponent(id)+'/graph').catch(()=>null)]);
      _detailGlobal=true;}
    catch(e2){box.innerHTML='<div class="story-muted" style="padding:30px">Failed: '+esc(e2.message||'')+'</div>';return;}}
    else{box.innerHTML='<div class="story-muted" style="padding:30px">Failed: '+esc(err.message||'')+'</div>';return;}
  }
  const kindTag=k=>k==='public'?'':' <span class="ent-ipkind">'+esc(k)+'</span>';
  const phones=e.phones.map(p=>'<div class="ent-row"><span class="ent-val ent-link" onclick="showProfile(\''+esc(p)+'\')">'+esc(p)+'</span></div>').join('');
  const imsis=e.imsis.map(v=>'<div class="ent-row"><span class="ent-val">'+esc(v)+'</span></div>').join('');
  const imeis=e.imeis.map(v=>'<div class="ent-row"><span class="ent-val">'+esc(v)+'</span></div>').join('');
  const ips=(e.ips||[]).map(i=>'<div class="ent-row"><span class="ent-val">'+esc(i.ip)+'</span>'+kindTag(i.kind)+'<span class="ent-count">'+n(i.records)+' rec</span></div>').join('');
  const apps=(e.services||[]).map(s=>'<div class="ent-row"><span class="ent-dot" style="background:'+svcColor((s.service||'').replace('Likely ',''))+'"></span><span class="ent-val">'+esc(s.service)+'</span><span class="ent-count">'+n(s.records)+' rec · '+s.confidence+'%</span></div>').join('');
  const locs=(e.towers||[]).map(t=>'<div class="ent-row"><span class="ent-val">'+esc(t.tower_id)+'</span>'+(t.city?'<span class="story-muted">'+esc([t.city,t.state].filter(Boolean).join(', '))+'</span>':'')+'<span class="ent-count">'+n(t.records)+' rec</span></div>').join('');
  const cases=e.cases.map(c=>'<div class="ent-row"><span class="ent-val">'+esc(c)+'</span></div>').join('');
  // Binding evidence with per-pair merge verdicts: an investigator can reject any single
  // binding (splitting the cluster durably) without discarding the rest.
  const links=(e.links||[]).slice(0,14).map(l=>{
    return '<div class="ent-row ent-evid"><div class="ent-evid-main">'+confChip(l.confidence)
      +(l.reviewed?'<span class="ent-conf" style="--cc:#2e7d32" title="Confirmed by an investigator">&#10003;</span>':'')
      +'<span class="ent-linktype">'+esc(l.type||'')+'</span>'
      +'<span class="ent-val">'+esc(l.a)+' ↔ '+esc(l.b)+'</span>'
      +(l.pair_key&&!l.reviewed?'<button class="btn-sm ent-evid-reject" title="Reject this binding — the identifiers will be split apart and never auto-merged again" data-rev-pair="reject_merge" data-pk="'+esc(l.pair_key)+'">split</button>':'')
      +'</div>'
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
  // Associations: co-location / possible association — explained, never merged.
  const assoc=(e.associations||[]).slice(0,8).map(a=>{
    const other=a.a===e.id?a.b:a.a;
    return '<div class="ent-row ent-evid"><div class="ent-evid-main">'+confChip(a.confidence)
      +'<span class="ent-linktype">'+esc((EDGE_LABEL[a.type]||a.type))+'</span>'
      +'<span class="ent-val ent-link" data-ent="'+esc(other)+'">'+esc(_labels[other]||other)+'</span></div>'
      +(a.explanation?'<div class="ent-evid-why">'+esc(a.explanation)+'</div>':'')+'</div>';
  }).join('');
  const sugs=(e.suggestions||[]).map(s=>(
    '<div class="ent-row ent-evid"><div class="ent-evid-main">'+confChip(s.confidence)
    +'<span class="ent-val">'+esc(s.a_label)+' ↔ '+esc(s.b_label)+'</span>'
    +'<button class="btn-sm" data-sug-act="confirm_merge" data-pk="'+esc(s.pair_key)+'" data-uid="'+esc(s.a_entity)+'">Confirm merge</button>'
    +'<button class="btn-sm" data-sug-act="reject_merge" data-pk="'+esc(s.pair_key)+'" data-uid="'+esc(s.a_entity)+'">Reject</button></div>'
    +'<div class="ent-evid-why">'+esc(s.reason||'')+'</div></div>')).join('');
  const tm=typeMeta(e);
  box.innerHTML='<div class="ent-person">'
    +'<div class="ent-person-h"><span class="ent-avatar big" style="color:'+tm.c+'">'+tm.icon+'</span><div><div class="ent-person-name">'+esc(e.label)+'</div>'
    +'<div class="ent-type" style="color:'+tm.c+';font-size:.8rem">'+esc(e.entity_type_label||'')+'</div>'
    +'<div class="evidence-meta">'+n(e.record_count)+' records'+(e.first_seen?' · active '+_fmtDT(e.first_seen)+' → '+_fmtDT(e.last_seen):'')+'</div></div>'
    +'<div style="flex:1"></div>'+flagChips(e.flags)+'</div>'
    +_reviewBar(e)
    +(g&&g.nodes&&g.nodes.length>1?_egoSvg(g):'')
    +'<div class="ent-tree">'
    +_branch('&#9888;','Suggested merges',sugs,(e.suggestions||[]).length)
    +_branch('&#9742;','Phone numbers',phones,e.phones.length)
    +_branch('&#128273;','SIMs (IMSI)',imsis,e.imsis.length)
    +_branch('&#128241;','Devices (IMEI)',imeis,e.imeis.length)
    +_branch('&#127760;','IP endpoints',ips,(e.ips||[]).length)
    +_branch('&#9654;','Apps / services',apps,(e.services||[]).length)
    +_branch('&#128205;','Locations',locs,(e.towers||[]).length)
    +_branch('&#128193;','Cases',cases,e.cases.length)
    +_branch('&#128279;','Communicates with',edges,(e.edges||[]).length)
    +_branch('&#128300;','Associations (never merged)',assoc,(e.associations||[]).length)
    +_branch('&#9878;','Binding evidence',links,(e.links||[]).length)
    +'</div></div>';
  box.querySelectorAll('.ent-link[data-ent]').forEach(a=>a.onclick=()=>{_selected=a.dataset.ent;_renderList();_renderDetail(a.dataset.ent);});
  const glob=_detailGlobal;
  box.querySelectorAll('[data-rev]').forEach(b=>b.onclick=()=>_review(e.id,b.dataset.rev,null,null,false,glob));
  box.querySelectorAll('[data-rev-pair]').forEach(b=>b.onclick=()=>_review(e.id,'reject_merge',b.dataset.pk,null,true,glob));
  box.querySelectorAll('[data-sug-act]').forEach(b=>b.onclick=()=>_review(b.dataset.uid,b.dataset.sugAct,b.dataset.pk,null,true,glob));
  if(g&&g.nodes&&g.nodes.length>1)_wireEgo(box,g);
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
