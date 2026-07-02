// analytics/crosscase.js — the Cross-Case Linking feature: surfaces a subject's history in OTHER
// cases (matched by number + handset IMEI / SIM IMSI; IP matches flagged low-confidence). Includes the
// dashboard "cross-case hits" panel, the profile-modal panel, and the Cross-Case tab with List
// (dossier) and Graph (subjects bridging cases, D3) views. Extracted from app.js (feature layer).
// Snapshot capture of the link graph goes through the evidence board. showProfile in onclick strings
// resolves via the window bridge; openInCase is re-exposed on window (it moved out of app.js).
// Self-registers the crosscase tab. No behavior change.

import { esc, fmtd, n } from '../core/utils.js';
import { D } from '../core/dom.js';
import { state } from '../core/state.js';
import { API } from '../core/api.js';
import { subjLabel } from '../core/subjects.js';
import { toast } from '../ui/toast.js';
import { evLoad, unpinEvidenceBySig, captureSvgToEvidence, refreshCapButtons } from '../workspace/evidence.js';
import { registerTab } from '../core/router.js';

const _XTYPE={number:'number',imei:'IMEI',imsi:'IMSI',ip:'IP'};
function _xtypes(m){return (m.match_types&&m.match_types.length?m.match_types:[m.match_type]).map(t=>_XTYPE[t]||t).join('+');}

// Dashboard panel: this case's subjects that also appear in other cases.
export async function renderCrossCaseHits(){
  const el=D.crossCaseHits;if(!el)return;
  if(!state.data.caseId){el.style.display='none';el.innerHTML='';return;}
  try{
    const data=await API.get('/cross-case/overview?case_id='+encodeURIComponent(state.data.caseId));
    const hits=(data&&data.hits)||[];
    if(!hits.length){el.style.display='none';el.innerHTML='';return;}
    const rows=hits.map(h=>{
      const conf=h.confidence==='high'?'var(--success)':'var(--warn)';
      const label=h.kind==='ip'?'IP':(h.top_match_type==='imei'?'handset (IMEI)':h.top_match_type==='imsi'?'SIM (IMSI)':'number');
      const cs=h.other_cases||[];
      const names=cs.slice(0,3).map(c=>'<b>'+esc(c.case_name)+'</b>').join(', ')+(cs.length>3?' +'+(cs.length-3)+' more':'');
      return '<div class="xcase-row" data-sub="'+esc(h.subject)+'" onclick="showProfile(this.dataset.sub)" title="Open subject profile">'
        +'<span class="xcase-dot" style="background:'+conf+'"></span>'
        +'<span class="xcase-sub">'+subjLabel(h.subject)+'</span>'
        +'<span class="xcase-meta">also in '+(names||('<b>'+h.other_case_count+'</b> other case'+(h.other_case_count===1?'':'s')))+' &middot; '+label+(h.confidence==='low'?' &middot; low-confidence':'')+'</span></div>';
    }).join('');
    el.innerHTML='<div class="xcase-head"><span class="xcase-title">&#9888; Cross-case hits</span>'
      +'<span class="xcase-sub2">'+data.total+' subject'+(data.total===1?'':'s')+' from this case also appear in other cases</span></div>'
      +'<div class="xcase-list">'+rows+'</div>';
    el.style.display='block';
  }catch(e){el.style.display='none';el.innerHTML='';}
}

// Profile-modal panel (filled async after the modal is shown).
export async function fillProfileCrossCase(sub){
  const el=document.getElementById('profileCrossCase');if(!el)return;
  try{
    const data=await API.get('/cross-case/subject?case_id='+encodeURIComponent(state.data.caseId)+'&subject='+encodeURIComponent(sub));
    const matches=(data&&data.matches)||[];
    if(!matches.length){el.innerHTML='<h4>Cross-case links</h4><div style="font-size:0.74rem;color:var(--muted)">No prior occurrences in other cases.</div>';return;}
    const chips=matches.map(m=>{
      const low=m.confidence==='low';
      const types=_xtypes(m);
      const span=(m.first_seen?fmtd(m.first_seen):'?')+(m.last_seen?(' → '+fmtd(m.last_seen)):'');
      const title=low?'Dynamic IP — verify the timeframe before linking':('Matched on '+types+(m.role==='counterpart'?' (as counterpart)':''));
      return '<span class="case-link'+(low?' low':'')+'" data-case="'+esc(m.case_id)+'" data-sub="'+esc(sub)+'" onclick="openInCase(this.dataset.case,this.dataset.sub)" title="'+esc(title)+'">'
        +esc(m.case_name)+' — '+types+(low?' (low)':'')+' &middot; '+m.record_count+' rec'+(m.record_count===1?'':'s')+' &middot; '+span+'</span>';
    }).join('');
    el.innerHTML='<h4 class="alert">Also seen in '+matches.length+' other case'+(matches.length===1?'':'s')+'</h4><div class="prof-tags">'+chips+'</div>';
  }catch(e){el.innerHTML='<h4>Cross-case links</h4><div style="font-size:0.74rem;color:var(--danger)">Lookup failed.</div>';}
}

// Jump to another case and reopen the subject's profile there.
async function openInCase(caseId,sub){
  if(!caseId)return;
  D.profile.style.display='none';
  setActiveCase(caseId);
  if(D.caseSelector){try{D.caseSelector.value=String(caseId);}catch(e){}}
  await loadCaseData();
  await loadCases();
  if(sub)showProfile(sub);
}

// ---- Cross-Case tab (full dossier) ----
function _xcBadge(t){
  const map={number:['#2c6f79','number'],imei:['#8b5cf6','IMEI'],imsi:['#3a7d5a','IMSI'],ip:['#d4a017','IP']};
  const m=map[t]||['#6b7280',t];
  return '<span class="xc-badge" style="background:'+m[0]+'">'+m[1]+'</span>';
}
// "What the subject was doing in that case" — headline one-liner + a top-contacts/towers detail line.
function _xcActivity(act,full){
  if(!act||!act.text)return '';
  if(!full)return '<div class="xc-act-mini">'+esc(act.text)+'</div>';
  const extra=[];
  if(act.kind==='phone'){
    if(act.top_contacts&&act.top_contacts.length)extra.push('contacts: '+act.top_contacts.map(c=>esc(c[0])+' ('+c[1]+')').join(', '));
    if(act.top_towers&&act.top_towers.length)extra.push('towers: '+act.top_towers.map(c=>esc(c[0])+' ('+c[1]+')').join(', '));
  }else if(act.kind==='ip'){
    if(act.top_dest&&act.top_dest.length)extra.push('destinations: '+act.top_dest.map(c=>esc(c[0])+' ('+c[1]+')').join(', '));
  }
  return '<div class="xc-act"><span class="xc-act-label">Activity in this case:</span> '+esc(act.text)
    +(extra.length?'<div class="xc-act-extra">'+extra.join(' &middot; ')+'</div>':'')+'</div>';
}
async function renderCrossCaseTab(){
  const el=D.crossCaseTab;if(!el)return;
  if(!state.data.caseId){el.innerHTML='<div class="xc-empty">No case selected.</div>';return;}
  el.innerHTML='<div class="xc-empty">Analysing cross-case links…</div>';
  try{
    const rep=await API.get('/cross-case/report?case_id='+encodeURIComponent(state.data.caseId));
    renderCrossCaseReport(rep);
  }catch(e){el.innerHTML='<div class="xc-empty" style="color:var(--danger)">Failed to load cross-case report: '+esc(e.message||String(e))+'</div>';}
}
function renderCrossCaseReport(rep){
  const el=D.crossCaseTab;if(!el)return;
  const s=(rep&&rep.summary)||{};const cur=(rep&&rep.current_case)||{};
  if(!s.recurring_subjects){
    el.innerHTML='<div class="xc-empty"><div style="font-size:1.3rem;margin-bottom:8px;color:var(--text)">No cross-case links</div>'
      +'<div>None of <b>'+esc(cur.name||'this case')+'</b>&rsquo;s subjects appear in any other loaded case.</div>'
      +'<div style="margin-top:6px;color:var(--muted);font-size:0.8rem;max-width:520px">As more cases are loaded, prior occurrences of these subjects &mdash; matched by phone number, handset IMEI, SIM IMSI, or IP &mdash; will surface here.</div></div>';
    return;
  }
  const mt=s.by_match_type||{};
  const stats=[
    {l:'Recurring subjects',v:s.recurring_subjects,d:'from this case seen elsewhere'},
    {l:'Linked cases',v:s.linked_cases,d:'other cases involved'},
    {l:'High-confidence',v:s.high_confidence,d:'number / handset / SIM',cls:'ok'},
    {l:'Low-confidence',v:s.low_confidence,d:'IP only — verify timeframe',cls:'warn'},
    {l:'Link pairs',v:s.link_pairs,d:'subject ↔ case connections'},
  ];
  let h='<div class="xc-report">';
  h+='<div class="xc-head"><b>'+esc(cur.name||'')+'</b> cross-referenced against all other loaded cases'
     +(s.truncated?' <span class="xc-warn-tag">top '+s.recurring_subjects+' subjects shown</span>':'')+'</div>';
  h+='<div class="xc-stats">'+stats.map(c=>'<div class="xc-stat '+(c.cls||'')+'"><div class="xc-stat-v">'+c.v+'</div><div class="xc-stat-l">'+esc(c.l)+'</div><div class="xc-stat-d">'+esc(c.d)+'</div></div>').join('')+'</div>';
  h+='<div class="xc-mix">Strongest link per subject: &nbsp;'
     +['number','imei','imsi','ip'].map(t=>mt[t]?_xcBadge(t)+' <b>'+mt[t]+'</b>':'').filter(Boolean).join(' &nbsp;&middot;&nbsp; ')+'</div>';

  h+='<h4 class="xc-sec">Linked cases ('+rep.by_case.length+')</h4>';
  rep.by_case.forEach(c=>{
    h+='<div class="xc-case-card"><div class="xc-case-head">'
      +'<span class="xc-case-name">'+esc(c.case_name)+'</span>'
      +'<span class="xc-case-meta">'+c.shared_subject_count+' shared subject'+(c.shared_subject_count===1?'':'s')
      +' &middot; '+c.high_count+' high'+(c.low_count?' / '+c.low_count+' low':'')+'</span>'
      +'<button class="case-link" onclick="openInCase(\''+esc(c.case_id)+'\',\'\')">Open case &rarr;</button></div>';
    h+='<div class="xc-case-subs">'+c.subjects.map(su=>{
      const conf=su.confidence==='high'?'var(--success)':'var(--warn)';
      const badges=(su.match_types||[su.match_type]).map(_xcBadge).join('');
      return '<div class="xc-case-sub" onclick="openInCase(\''+esc(c.case_id)+'\',\''+esc(su.subject)+'\')" title="Open '+esc(su.subject)+' in '+esc(c.case_name)+'">'
        +'<div class="xc-case-sub-main"><span class="xc-dot" style="background:'+conf+'"></span>'
        +'<span class="xc-sub-id">'+esc(su.subject)+'</span>'+badges
        +(su.role==='counterpart'?'<span class="xc-role">counterpart</span>':'')
        +'<span class="xc-sub-meta">'+su.record_count+' rec &middot; '+(su.first_seen?fmtd(su.first_seen):'?')+(su.last_seen?' → '+fmtd(su.last_seen):'')+'</span></div>'
        +_xcActivity(su.activity,false)+'</div>';
    }).join('')+'</div></div>';
  });

  h+='<h4 class="xc-sec">Recurring subjects ('+rep.subjects.length+')</h4>';
  rep.subjects.forEach(su=>{
    const conf=su.confidence==='high'?'var(--success)':'var(--warn)';
    h+='<div class="xc-subj"><div class="xc-subj-head" onclick="this.parentNode.classList.toggle(\'open\')">'
      +'<span class="xc-arrow">&#9656;</span>'
      +'<span class="xc-dot" style="background:'+conf+'"></span>'
      +'<span class="xc-sub-id" onclick="event.stopPropagation();showProfile(\''+esc(su.subject)+'\')" title="Open profile">'+esc(su.subject)+'</span>'
      +'<span class="xc-kind">'+(su.kind==='ip'?'IP':'phone')+'</span>'
      +_xcBadge(su.strongest_match)
      +'<span class="xc-sub-meta">seen in '+su.other_case_count+' other case'+(su.other_case_count===1?'':'s')+'</span></div>';
    h+='<div class="xc-subj-body">'+su.matches.map(m=>{
      const mc=m.confidence==='high'?'var(--success)':'var(--warn)';
      const badges=(m.match_types||[m.match_type]).map(_xcBadge).join('');
      const vals=(m.matched_values&&m.matched_values.length)?'<span class="xc-vals">matched: '+m.matched_values.map(esc).join(', ')+'</span>':'';
      return '<div class="xc-match">'
        +'<span class="case-link'+(m.confidence==='low'?' low':'')+'" onclick="openInCase(\''+esc(m.case_id)+'\',\''+esc(su.subject)+'\')">'+esc(m.case_name)+' &rarr;</span>'
        +badges+'<span class="xc-conf" style="color:'+mc+'">'+m.confidence+'</span>'
        +(m.role==='counterpart'?'<span class="xc-role">counterpart</span>':'')
        +'<span class="xc-sub-meta">'+m.record_count+' rec &middot; '+(m.first_seen?fmtd(m.first_seen):'?')+(m.last_seen?' → '+fmtd(m.last_seen):'')+'</span>'+vals+_xcActivity(m.activity,true)+'</div>';
    }).join('')+'</div></div>';
  });
  h+='</div>';
  el.innerHTML=h;
}
if(D.xcRefreshBtn)D.xcRefreshBtn.addEventListener('click',()=>{xcView==='graph'?renderCrossCaseGraph():renderCrossCaseTab();});

// Cross-Case tab: List (dossier) vs Graph (subjects bridging cases) view.
let xcView='list';
function setXcView(v){
  xcView=v;
  if(D.xcViewList)D.xcViewList.classList.toggle('active',v==='list');
  if(D.xcViewGraph)D.xcViewGraph.classList.toggle('active',v==='graph');
  if(D.crossCaseTab)D.crossCaseTab.style.display=v==='list'?'':'none';
  if(D.crossCaseGraph)D.crossCaseGraph.style.display=v==='graph'?'flex':'none';
  if(D.xcGraphCaptureBtn)D.xcGraphCaptureBtn.style.display=v==='graph'?'':'none';
  if(v==='graph'){renderCrossCaseGraph();refreshCapButtons();}else renderCrossCaseTab();
}
if(D.xcViewList)D.xcViewList.addEventListener('click',()=>setXcView('list'));
if(D.xcViewGraph)D.xcViewGraph.addEventListener('click',()=>setXcView('graph'));
if(D.xcGraphCaptureBtn)D.xcGraphCaptureBtn.addEventListener('click',()=>{
  const sig='graph|Cross-case link graph';
  if(evLoad().some(x=>x.sig===sig)){unpinEvidenceBySig(sig);toast('Removed cross-case graph from evidence.');}
  else{captureSvgToEvidence(D.xcGraphSvg,'Cross-case link graph');}
});

let xcGraphSim=null;
async function renderCrossCaseGraph(){
  const host=D.xcGraphSvg;if(!host)return;
  if(!state.data.caseId){host.innerHTML='<div class="xc-empty">No case selected.</div>';D.xcGraphStats.textContent='';return;}
  host.innerHTML='<div class="xc-empty">Building link graph…</div>';
  let data;
  try{data=await API.get('/cross-case/graph?case_id='+encodeURIComponent(state.data.caseId));}
  catch(e){host.innerHTML='<div class="xc-empty" style="color:var(--danger)">Failed to load graph.</div>';console.error(e);return;}
  const nodes=(data.nodes||[]).map(n=>({...n}));
  const edges=(data.edges||[]).map(e=>({source:e.source,target:e.target,confidence:e.confidence,match_type:e.match_type}));
  if(!nodes.length||nodes.filter(n=>n.type==='subject').length===0){
    host.innerHTML='<div class="xc-empty"><div style="font-size:1.2rem;margin-bottom:6px">No cross-case links to graph</div><div style="color:var(--muted)">None of this case&rsquo;s subjects appear in other cases yet.</div></div>';
    D.xcGraphStats.textContent='';return;
  }
  host.innerHTML='<svg width="100%" height="100%"></svg>';
  const svg=d3.select(host).select('svg'),w=host.clientWidth||800,h=host.clientHeight||520;
  const confColor=c=>c==='high'?'#3a7d5a':'#d4a017';
  const zoom=d3.zoom().scaleExtent([0.2,8]).on('zoom',e=>g.attr('transform',e.transform));
  svg.call(zoom);
  const g=svg.append('g');
  const sim=d3.forceSimulation(nodes)
    .force('link',d3.forceLink(edges).id(d=>d.id).distance(d=>d.confidence==='high'?90:120))
    .force('charge',d3.forceManyBody().strength(-220))
    .force('center',d3.forceCenter(w/2,h/2))
    .force('collision',d3.forceCollide(20));
  xcGraphSim=sim;
  const link=g.append('g').selectAll('line').data(edges).join('line')
    .attr('stroke',d=>confColor(d.confidence)).attr('stroke-width',d=>d.confidence==='high'?2:1.2)
    .attr('stroke-opacity',0.55).attr('stroke-dasharray',d=>d.confidence==='low'?'4 3':null);
  const node=g.append('g').selectAll('g.xc-node').data(nodes).join('g').attr('class','xc-node').style('cursor','pointer')
    .on('mouseover',(e,d)=>{
      if(d.type==='case')D.xcGraphDetails.innerHTML='<strong>Case: '+esc(d.label)+'</strong>'+(d.current?' <span style="color:var(--accent)">(current)</span>':'')+'<br>'+n(d.subject_count||0)+' shared subject(s)';
      else D.xcGraphDetails.innerHTML='<strong>'+esc(d.label)+'</strong> <span style="font-size:.65rem">'+(d.kind==='ip'?'IP':'phone')+'</span><br>'+_xcBadge(d.match_type)+' '+(d.confidence||'')+' &middot; in '+n(d.case_count||0)+' other case(s)';
    })
    .call(d3.drag()
      .on('start',(e,d)=>{d.fx=d.x;d.fy=d.y;d._sx=e.x;d._sy=e.y;d._moved=false})
      .on('drag',(e,d)=>{d._moved=true;if(!e.active)sim.alphaTarget(0.3).restart();d.fx=e.x;d.fy=e.y})
      .on('end',(e,d)=>{if(!e.active)sim.alphaTarget(0);d.fx=null;d.fy=null;const dx=e.x-(d._sx||0),dy=e.y-(d._sy||0);if(!d._moved||dx*dx+dy*dy<36){if(d.type==='case'){const id=String(d.id).replace('case:','');if(!d.current)openInCase(id,'');}else{showProfile(d.label);}}}));
  // Case nodes = rounded squares (teal, current case bigger/accent); subject nodes = circles by confidence.
  node.each(function(d){
    const sel=d3.select(this);
    if(d.type==='case'){
      const s=d.current?26:18;
      sel.append('rect').attr('width',s).attr('height',s).attr('x',-s/2).attr('y',-s/2).attr('rx',4)
        .attr('fill',d.current?'#2c6f79':'#4a929c').attr('stroke','#fff').attr('stroke-width',1.5);
    }else{
      sel.append('circle').attr('r',d=>Math.max(6,Math.min(14,6+(d.case_count||1)*2)))
        .attr('fill',d.confidence==='high'?'#3a7d5a':'#d4a017').attr('stroke','#fff').attr('stroke-width',1.5);
    }
  });
  const label=g.append('g').selectAll('text').data(nodes).join('text')
    .text(d=>{const t=d.type==='case'?d.label:d.label;return t&&t.length>16?t.slice(0,16)+'…':t;})
    .attr('font-size',d=>d.type==='case'?'10':'8.5').attr('dx',12).attr('dy',3)
    .attr('class','graph-label').style('pointer-events','none');
  sim.on('tick',()=>{
    link.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y).attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);
    node.attr('transform',d=>'translate('+d.x+','+d.y+')');
    label.attr('x',d=>d.x).attr('y',d=>d.y);
  });
  const ncase=nodes.filter(n=>n.type==='case').length,nsub=nodes.filter(n=>n.type==='subject').length;
  D.xcGraphStats.textContent=nsub+' subject'+(nsub===1?'':'s')+' bridging '+ncase+' case'+(ncase===1?'':'s')+' · '+edges.length+' links';
}

// This tab owns its rendering; register both views with the router and re-expose openInCase (used in
// onclick strings from here + the profile modal; it moved out of the app.js bridge).
registerTab('crosscase',()=>{xcView==='graph'?renderCrossCaseGraph():renderCrossCaseTab();});
Object.assign(window,{openInCase});
