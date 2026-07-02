// analytics/inferences.js — the Spatiotemporal Inferences tab: renders the server inference report
// (persons of interest, risk, impossible travel, co-presence/convoys, beaconing, movement anchors, …)
// plus the suspect-group watchlist bar (add/remove/export) and a scroll-spy nav. Extracted from app.js
// (feature layer). loadWatchlist / loadExports live here (only this tab uses them); loadSuspects (the
// suspect-group loader in app.js) is injected via provideLoadSuspects(). Imports renderGraph +
// showProfile for the suspect-removal flow. Self-registers the inferences tab. No behavior change.

import { esc, n } from '../core/utils.js';
import { $, D } from '../core/dom.js';
import { state } from '../core/state.js';
import { API } from '../core/api.js';
import { getInfReport, INF } from '../services/inference.js';
import { twr } from '../data/records.js';
import { toast } from '../ui/toast.js';
import { renderGraph } from '../graph/network.js';
import { showProfile } from '../records/profile.js';
import { registerTab } from '../core/router.js';

// loadSuspects (suspect-group loader) stays in app.js; injected at boot.
let _loadSuspects=async()=>{};
export function provideLoadSuspects(fn){ _loadSuspects=fn; }

async function loadWatchlist(){try{const cq=state.data.caseId?'?case_id='+encodeURIComponent(state.data.caseId):'';state.watchlist=await API.get('/watchlist'+cq);}catch(e){state.watchlist=[];}}
export async function loadExports(){try{const cq=state.data.caseId?'?case_id='+encodeURIComponent(state.data.caseId):'';state.exports=await API.get('/inference/exports'+cq);}catch(e){state.exports=[];}}
export function _exportsHtml(){
  if(!(state.exports||[]).length)return '<span class="wl-exp-empty">No exports yet.</span>';
  return state.exports.slice(0,6).map(e=>{
    const items=Object.entries(e.details||{}).filter(([k,v])=>v).map(([k,v])=>v+' '+k.replace(/_/g,' ')).join(', ');
    const src=e.source==='evidence'?'Evidence (navbar)':'Analysis (inferences)';
    return '<div class="wl-exp-row"><code>'+esc(e.ref_id)+'</code>'
      +'<span class="wl-exp-meta">'+esc(src)+(e.exported_by?' · '+esc(e.exported_by):'')+(e.created_at?' · '+esc(e.created_at.slice(0,16).replace('T',' ')):'')+'</span>'
      +(items?'<span class="wl-exp-items" title="'+esc(items)+'">'+esc(items)+'</span>':'')+'</div>';
  }).join('');
}
function _watchlistBarHtml(rep){
  const hits=(rep&&rep.watchlist_hits)||[];
  // Group chips by suspect group.
  const byGroup={};(state.watchlist||[]).forEach(e=>{const g=e.group_name||'Default';(byGroup[g]=byGroup[g]||[]).push(e);});
  const groups=Object.keys(byGroup).sort();
  const chips=groups.map(g=>'<div class="wl-group"><span class="wl-gname">'+esc(g)+'</span>'
    +byGroup[g].map(e=>'<span class="wl-chip">'+esc(e.value)+' <span class="k">'+esc(e.kind)+'</span> <a onclick="wlRemove('+e.id+')" title="remove">&times;</a></span>').join('')+'</div>').join('');
  const knownGroups=[...new Set([...(state.suspectGroups||[]).map(x=>x.group_name),...groups,'Default'])];
  return '<div class="wl-bar">'
    +'<div class="wl-row"><strong>Suspect groups</strong>'
    +'<input id="wlInput" placeholder="number / IP / IMEI / cell-id" onkeydown="if(event.key===\'Enter\')wlAdd()"/>'
    +'<input id="wlGroup" list="wlGroupList" placeholder="group (Default)" value="'+esc(state._lastGroup||'Default')+'"/>'
    +'<datalist id="wlGroupList">'+knownGroups.map(g=>'<option value="'+esc(g)+'">').join('')+'</datalist>'
    +'<button class="btn-sm" onclick="wlAdd()">Add</button>'
    +'<button id="wlExportBtn" class="btn-sm wl-export" onclick="wlExport()" title="Download the full analysis as an official, audit-logged Markdown case report">&#8623; Export analysis (.md)</button></div>'
    +(chips?'<div class="wl-chips">'+chips+'</div>':'<div class="wl-empty">No suspect-group entries. Add a number/IP/IMEI/cell-id — it is forced to the top as Critical and highlighted across records & graph.</div>')
    +(hits.length?'<div class="wl-hits">&#9873; '+hits.length+' suspect-group match'+(hits.length>1?'es':'')+' &mdash; forced to Critical at the top of the lists.</div>':'')
    +'<details class="wl-exports"><summary>Export history <span id="wlExportNote" class="wl-note"></span></summary><div id="wlExportsList">'+_exportsHtml()+'</div></details>'
    +'</div>';
}
window.wlAdd=async function(){const i=$('wlInput');const v=(i&&i.value||'').trim();if(!v)return;const g=($('wlGroup')&&$('wlGroup').value||'Default').trim()||'Default';state._lastGroup=g;try{await API.post('/watchlist',{value:v,group_name:g,case_id:state.data.caseId||null});await loadWatchlist();await _loadSuspects();INF.cache=null;INF.report=null;renderInferences(true);}catch(e){alert('Failed: '+e.message);}};
window.wlRemove=async function(id){try{await API.del('/watchlist/'+id);await loadWatchlist();await _loadSuspects();INF.cache=null;INF.report=null;renderInferences(true);}catch(e){alert('Failed: '+e.message);}};
window.removeFromSuspectGroup=async function(value){
  // Use /watchlist/by-value so removal works regardless of which case the entry was
  // created in — state.watchlist is case-scoped and would miss cross-case suspect entries.
  try{await API.del('/watchlist/by-value?value='+encodeURIComponent(value));}catch(e){toast('Remove failed: '+e.message);return;}
  await loadWatchlist();await _loadSuspects();INF.cache=null;INF.report=null;
  if(state.tab==='graph')renderGraph();
  if(state.tab==='inferences')renderInferences(true);
  showProfile(value);
};
function _caseSafe(){const cn=(D.caseSelector&&D.caseSelector.options[D.caseSelector.selectedIndex]?.text)||'case';return cn.replace(/[^a-z0-9]+/gi,'_').replace(/^_|_$/g,'')||'case';}
window.wlExport=async function(){
  const btn=$('wlExportBtn');const prev=btn?btn.innerHTML:'';if(btn){btn.innerHTML='Exporting…';btn.disabled=true;}
  try{
    const base=state.data.caseId?'?case_id='+encodeURIComponent(state.data.caseId)+'&':'?';
    const r=await fetch('/inference/report.md'+base+'source=analysis',{credentials:'same-origin'});
    if(!r.ok)throw new Error('HTTP '+r.status);
    const ref=r.headers.get('X-Export-Ref')||'ARGUS-ANL';
    const t=await r.text();
    const b=new Blob([t],{type:'text/markdown;charset=utf-8'});const u=URL.createObjectURL(b);
    const a=document.createElement('a');a.href=u;a.download=ref+'_'+_caseSafe()+'.md';a.click();URL.revokeObjectURL(u);
    await loadExports();const note=$('wlExportNote');if(note)note.textContent='Saved '+ref;
    const list=$('wlExportsList');if(list)list.innerHTML=_exportsHtml();
  }catch(e){alert('Export failed: '+e.message);}
  finally{if(btn){btn.innerHTML=prev;btn.disabled=false;}}
};
function _scrollParent(el){while(el&&el!==document.body){const o=getComputedStyle(el).overflowY;if((o==='auto'||o==='scroll')&&el.scrollHeight>el.clientHeight)return el;el=el.parentElement;}return window;}
let _infSpyCleanup=null;
function _decorateInferences(box){
  if(_infSpyCleanup){_infSpyCleanup();_infSpyCleanup=null;}
  const wrap=box.querySelector('.inf-wrap');if(!wrap)return;
  const secs=[];
  const poi=wrap.querySelector(':scope > .inf-card');
  if(poi){poi.id='infsec-poi';secs.push({id:'infsec-poi',label:'Persons of interest'});}
  wrap.querySelectorAll('.inf-theme').forEach((el,i)=>{el.id='infsec-'+i;secs.push({id:'infsec-'+i,label:el.textContent.trim()});});
  if(secs.length<3)return;  // short page — no nav needed
  const nav=document.createElement('div');nav.className='inf-nav';
  nav.innerHTML='<span class="inf-nav-label">On this page</span>'+secs.map(s=>'<a data-t="'+s.id+'">'+esc(s.label)+'</a>').join('');
  wrap.insertBefore(nav,wrap.firstChild);
  const links=[...nav.querySelectorAll('a')];
  links.forEach(a=>a.onclick=()=>{const t=document.getElementById(a.dataset.t);if(t)t.scrollIntoView({behavior:'smooth',block:'start'});});
  const sp=_scrollParent(box),tgt=sp===window?window:sp;
  const spy=()=>{let cur=secs[0].id;for(const s of secs){const el=document.getElementById(s.id);if(el&&el.getBoundingClientRect().top<=150)cur=s.id;}links.forEach(a=>a.classList.toggle('active',a.dataset.t===cur));};
  tgt.addEventListener('scroll',spy,{passive:true});window.addEventListener('scroll',spy,{passive:true});
  _infSpyCleanup=()=>{tgt.removeEventListener('scroll',spy);window.removeEventListener('scroll',spy);};
  spy();
}
export async function renderInferences(force){
  const box=$('infResults'),status=$('infStatus'),btn=$('infRefreshBtn');
  if(!box)return;
  if(btn&&!btn._bound){btn._bound=true;btn.onclick=()=>{INF.cache=null;INF.report=null;renderInferences(true);};}
  if(INF.cache&&!force){box.innerHTML=INF.cache;_decorateInferences(box);return;}
  status.textContent='Analyzing...';
  box.innerHTML='<div style="padding:40px;text-align:center;color:var(--muted)">Running inference engine...</div>';
  let rep;
  try{rep=await getInfReport(force);}
  catch(e){status.textContent='Error';box.innerHTML='<div style="padding:40px;text-align:center;color:var(--danger)">Failed: '+esc(e.message)+'</div>';return;}
  await loadWatchlist();
  await loadExports();
  INF.cache=_watchlistBarHtml(rep)+buildInferenceHtml(rep);
  box.innerHTML=INF.cache;
  _decorateInferences(box);
  status.textContent=n((rep.cdr&&rep.cdr.subjects)||0)+' phone subjects · '+n((rep.ipdr&&rep.ipdr.sessions)||0)+' IPDR sessions';
}
function _infCard(title,count,color,body){
  return '<div class="inf-card"><div class="inf-card-head">'
    +'<span class="dot" style="background:'+color+'"></span><strong>'+title+'</strong>'
    +(count!=null?'<span class="count">'+count+'</span>':'')
    +'</div>'+(body||'')+'</div>';
}
function _infChip(t,c,title){return '<span class="inf-chip"'+(c?' style="color:'+c+'"':'')+(title?' title="'+esc(title)+'"':'')+'>'+esc(t)+'</span>';}
function _infSubj(s){return '<a class="inf-link" onclick="showProfile(\''+esc(s)+'\')">'+esc(s)+'</a>';}
function buildInferenceHtml(rep){
  const C=rep.cdr||{}, I=rep.ipdr||{};
  const subjects=C.subjects||0, sessions=I.sessions||0;
  if(!subjects && !sessions){
    return '<div class="inf-empty">No records in this case yet.<br>Upload CDR/IPDR data to run the analysis.</div>';
  }
  const cps=C.co_presence||[];
  const convoys=cps.filter(c=>c.convoy&&!c.hidden_link);
  const hidden=cps.filter(c=>c.hidden_link);
  const beh=Object.entries(C.behavioral||{});
  const odd=beh.filter(e=>e[1].odd_hours&&e[1].odd_hours.flag);
  const swaps=(C.devices&&C.devices.sim_swaps)||[];
  const burners=(C.devices&&C.devices.burner_handsets)||[];
  const imp=C.impossible_travel||[];
  const periodic=C.periodic_contacts||[];
  const vp=I.vpn_proxy||[];

  // ----- Persons of interest: the engine's composite risk leaderboard (CDR phone subjects) -----
  const cdrRisk=C.risk||[];
  const bandStyle=b=>({
    critical:{l:'Critical',c:'var(--danger)',s:'crit'},
    high:    {l:'High',    c:'var(--warn)',  s:'high'},
    elevated:{l:'Elevated',c:'var(--accent)',s:'info'},
    low:     {l:'Low',     c:'var(--muted)', s:'info'},
  }[b]||{l:b||'—',c:'var(--muted)',s:'info'});

  const critN=imp.length+swaps.length+burners.length+hidden.length;
  const highN=convoys.length;
  const vpIps=vp.length;

  let h='<div class="inf-wrap">';
  h+='<div class="inf-intro"><h3>Automated case analysis</h3>'
    +'<p>Two <b>separate</b> data sources, analysed independently and never cross-linked: '
    +'<b>CDR</b> (calls/SMS &mdash; subjects are <b>phone numbers</b>) and <b>IPDR</b> '
    +'(internet sessions &mdash; subjects are <b>IP addresses</b>). Every item is a lead to verify; '
    +'distances and times are tower-based estimates.</p></div>';

  h+='<div class="inf-summary">'
    +'<div class="inf-stat"><div class="n">'+n(subjects)+'</div><div class="t">CDR subjects (phone)</div></div>'
    +'<div class="inf-stat crit"><div class="n" style="color:'+(critN?'var(--danger)':'var(--muted)')+'">'+n(critN)+'</div><div class="t">Critical leads</div></div>'
    +'<div class="inf-stat high"><div class="n" style="color:'+(highN?'var(--warn)':'var(--muted)')+'">'+n(highN)+'</div><div class="t">Notable leads</div></div>'
    +'<div class="inf-stat info"><div class="n">'+n(sessions)+'</div><div class="t">IPDR sessions (IP)</div></div>'
    +'</div>';

  // ===================== CDR ANALYSIS (phone numbers) =====================
  if(cdrRisk.length){
    let rows='';
    cdrRisk.slice(0,12).forEach(r=>{
      const bs=bandStyle(r.band);
      rows+='<div class="inf-poi-row">'
        +'<span class="inf-sev '+bs.s+'" title="composite risk score '+r.score+'/100, from '+r.events+' event(s)">'+bs.l+' &middot; '+r.score+'</span>'
        +'<span class="who">'+_infSubj(r.subject)+'</span>'
        +'<span class="flags">'+(r.factors||[]).map(f=>_infChip(f.name,bs.c,f.detail+(f.weight?' (+'+f.weight+')':''))).join('')+'</span></div>';
    });
    h+=_infCard('Persons of interest','phone subjects, risk-ranked','var(--danger)',
      '<div class="inf-blurb">CDR phone-number subjects ranked by a composite <b>0&ndash;100 risk score</b>. Each chip is a contributing factor (hover to see why and its weight); correlated signals are de-duplicated and thin-evidence subjects are capped. The score is a triage aid, not proof. Click a number to open its profile.</div>'+rows);
  }

  const card=(title,count,color,sev,blurb,rows)=>_infCard(
     title+' <span class="inf-sev '+sev+'" style="margin-left:6px">'+(sev==='crit'?'Critical':sev==='high'?'Notable':'Context')+'</span>',
     count,color,'<div class="inf-blurb">'+blurb+'</div>'+rows);

  // -- Identity & device fraud --
  let theme='';
  const cloneBy={};(C.clone_corroboration||[]).forEach(c=>cloneBy[c.subject]=c);
  if(imp.length){
    const rows=imp.map(x=>{const cl=cloneBy[x.subject];
      return '<div class="inf-row"><div class="top"><strong>'+_infSubj(x.subject)+'</strong>'
        +'<span style="color:var(--danger);font-weight:700">'+(x.speed_kmh!=null?n(Math.round(x.speed_kmh))+' km/h':'same minute (∞)')+'</span>'
        +'<span style="font-size:0.7rem;color:var(--muted)">'+twr(x.from_tower)+' → '+twr(x.to_tower)+'</span></div>'
        +'<div class="meta">'+x.distance_km+' km in '+x.dt_minutes+' min'+(x.from_imei!==x.to_imei?' · IMEI changed':'')+(cl?' · '+esc(cl.verdict):'')+'</div></div>';
    }).join('');
    theme+=card('Impossible travel &amp; cloning',imp.length+' flagged','var(--danger)','crit',
      'The same number registered in two places too far apart for the time between them &mdash; physically impossible. Almost always a <b>cloned/duplicated SIM</b> or a spoofed record.',rows);
  }
  if(swaps.length||burners.length){
    let rows='';
    swaps.forEach(s=>{rows+='<div class="inf-row"><div class="top"><strong>'+_infSubj(s.msisdn)+'</strong>'+_infChip('on '+s.imeis.length+' handsets','var(--danger)')+'</div><div class="meta">IMEIs: '+esc(s.imeis.join(', '))+'</div></div>';});
    burners.forEach(b=>{rows+='<div class="inf-row"><div class="top"><strong>'+esc(b.imei)+'</strong>'+_infChip(b.msisdns.length+' numbers','var(--warn)')+'</div><div class="meta">Numbers: '+b.msisdns.map(_infSubj).join(', ')+'</div></div>';});
    theme+=card('SIM swaps &amp; burner handsets',swaps.length+burners.length,'var(--danger)','crit',
      'One number seen on several handsets (possible <b>SIM swap/clone</b>), or one handset cycling several numbers (a <b>burner</b>).',rows);
  }
  const entities=(C.entities||[]).filter(e=>e.size>1);
  if(entities.length){
    const rows=entities.slice(0,12).map(e=>'<div class="inf-row"><div class="top"><strong>'+e.numbers.map(_infSubj).join(' = ')+'</strong>'
      +_infChip(e.confidence+' confidence',e.confidence==='high'?'var(--danger)':'var(--warn)')+'</div>'
      +'<div class="meta">'+e.size+' numbers sharing handset(s) &mdash; likely one person</div></div>').join('');
    theme+=card('Multi-SIM identities',entities.length,'var(--warn)','high',
      'Phone numbers grouped into a <b>single likely actor</b> because they share handsets (transitively). CDR-only &mdash; an IP is never part of a phone identity. Treat as a lead; shared/family devices can group numbers too.',rows);
  }
  if(theme){h+='<div class="inf-theme">CDR · Identity &amp; device fraud</div>'+theme;}

  // -- Covert & structured coordination --
  theme='';
  if(hidden.length){
    const rows=hidden.map(c=>'<div class="inf-row"><div class="top">'+_infSubj(c.subject_a)+'<span style="color:var(--muted)">&amp;</span>'+_infSubj(c.subject_b)+_infChip('never call','var(--danger)')+'</div>'
      +'<div class="meta">Together '+c.occurrences+'× over '+c.distinct_days+' day(s) at '+(c.towers||[]).slice(0,3).map(t=>twr(String(t).split('~')[0])).join(', ')+'</div></div>').join('');
    theme+=card('Hidden links',hidden.length,'var(--danger)','crit',
      'Pairs repeatedly in the <b>same place at the same time</b> who <b>never call each other</b> &mdash; meeting in person while avoiding a phone trail.',rows);
  }
  if(convoys.length){
    const rows=convoys.map(c=>'<div class="inf-row"><div class="top">'+_infSubj(c.subject_a)+'<span style="color:var(--muted)">&amp;</span>'+_infSubj(c.subject_b)+_infChip(c.distinct_days+' days','var(--warn)')+'</div>'
      +'<div class="meta">Co-located '+c.occurrences+'× · '+(c.ever_called?'also call each other':'no calls between them')+'</div></div>').join('');
    theme+=card('Convoys / co-movement',convoys.length,'var(--warn)','high',
      'Subjects repeatedly together across <b>different days</b> &mdash; they travel together or meet regularly. Likely close associates.',rows);
  }
  if(periodic.length){
    const rows=periodic.slice(0,12).map(p=>'<div class="inf-row" style="padding:5px 0;font-size:0.74rem">'+_infSubj(p.subject)+' → '+esc(p.peer)+' · '+p.calls+' calls every ~'+p.mean_gap_hours+'h <span style="color:var(--muted)">(very regular)</span></div>').join('');
    theme+=card('Scheduled contact',periodic.length,'var(--accent)','info',
      'Pairs who call on a <b>regular cadence</b> &mdash; a structured, recurring relationship rather than ad-hoc contact.',rows);
  }
  if(theme){h+='<div class="inf-theme">CDR · Covert &amp; structured coordination</div>'+theme;}

  // -- Network structure --
  const net=C.network||{};
  if((net.brokers||[]).length||(net.articulation_points||[]).length||(net.reciprocity||[]).length||(net.relay_chains||[]).length||(net.predicted_links||[]).length){
    let rows='';
    if((net.brokers||[]).length)
      rows+='<div class="inf-row"><div class="top"><strong>Brokers</strong>'+_infChip('connect separate groups','var(--warn)')+'</div><div class="meta">'
        +net.brokers.map(b=>_infSubj(b.subject)+' <span style="color:var(--muted)">(betw '+b.betweenness+')</span>').join(' · ')+'</div></div>';
    if((net.articulation_points||[]).length)
      rows+='<div class="inf-row"><div class="top"><strong>Cut-points</strong>'+_infChip('removal splits network','var(--warn)')+'</div><div class="meta">'
        +net.articulation_points.map(a=>_infSubj(a.subject)+' <span style="color:var(--muted)">(deg '+a.degree+')</span>').join(' · ')+'</div></div>';
    if((net.reciprocity||[]).length)
      rows+='<div class="inf-row"><div class="top"><strong>One-way ties</strong>'+_infChip('caller never called back','var(--accent)')+'</div><div class="meta">'
        +net.reciprocity.slice(0,8).map(r=>_infSubj(r.caller)+' &rarr; '+esc(r.callee)+' ('+r.calls+')').join(' · ')+'</div></div>';
    if((net.relay_chains||[]).length)
      rows+='<div class="inf-row"><div class="top"><strong>Relay chains</strong>'+_infChip('A&rarr;B&rarr;C','var(--accent)')+'</div><div class="meta">'
        +net.relay_chains.slice(0,8).map(c=>_infSubj(c.a)+'&rarr;'+esc(c.b)+'&rarr;'+esc(c.c)+' <span style="color:var(--muted)">('+c.gap_min+'m)</span>').join(' · ')+'</div></div>';
    if((net.predicted_links||[]).length)
      rows+='<div class="inf-row"><div class="top"><strong>Likely hidden links</strong>'+_infChip('shared contacts, no call','var(--accent)')+'</div><div class="meta">'
        +net.predicted_links.slice(0,8).map(p=>_infSubj(p.subject_a)+' ~ '+esc(p.subject_b)+' <span style="color:var(--muted)">('+p.common_contacts+' shared)</span>').join(' · ')+'</div></div>';
    h+='<div class="inf-theme">CDR · Network structure</div>';
    h+=card('Call-graph roles',(net.brokers||[]).length+' broker(s)','var(--accent)','high',
      '<b>Brokers</b> sit between groups (high betweenness) and <b>cut-points</b> hold the network together &mdash; both are often coordinators. <b>One-way ties</b>, <b>relay chains</b> (A calls B, B calls C shortly after) and <b>likely hidden links</b> (shared contacts but no call) round out the structure.',rows);
  }

  // -- Movement & behaviour --
  theme='';
  if(odd.length){
    const rows=odd.map(e=>'<div class="inf-row" style="padding:5px 0;font-size:0.74rem">'+_infSubj(e[0])+' · '+Math.round(e[1].odd_hours.share*100)+'% of activity between 01:00–05:00</div>').join('');
    theme+=card('Odd-hours activity',odd.length,'var(--accent)','info',
      'Subjects unusually active in the <b>dead of night</b>.',rows);
  }
  const movers=Object.entries(C.movement||{}).map(e=>Object.assign({s:e[0]},e[1])).filter(m=>m.distinct_towers>1).sort((a,b)=>b.distinct_towers-a.distinct_towers).slice(0,8);
  if(movers.length){
    const rows=movers.map(m=>{const home=m.anchors&&m.anchors.home?twr(m.anchors.home.tower_id):'?';const work=m.anchors&&m.anchors.work?twr(m.anchors.work.tower_id):'?';
      const mob=m.mobility?m.mobility.class:'';const dwell=(m.dwell&&m.dwell.length)?' · longest dwell '+twr(m.dwell[0].tower_id)+' ('+m.dwell[0].dwell_hours+'h)':'';
      return '<div class="inf-row" style="padding:5px 0"><div class="top"><strong>'+_infSubj(m.s)+'</strong>'+(mob?_infChip(mob,'var(--accent)'):'')+'<span style="font-size:0.7rem;color:var(--muted)">'+m.distinct_towers+' towers · home '+home+' / work '+work+dwell+'</span></div></div>';}).join('');
    theme+=card('Movement &amp; anchors','top '+movers.length,'var(--accent)','info',
      'Each subject&rsquo;s likely <b>home and work cells</b>, how mobile they are (stationary&rarr;highly&nbsp;mobile) and where they <b>dwell longest</b> &mdash; context for the flags above.',rows);
  }
  const routes=C.shared_routes||[];
  if(routes.length){
    const rows=routes.slice(0,10).map(r=>'<div class="inf-row" style="padding:5px 0"><div class="top">'+_infSubj(r.subject_a)+'<span style="color:var(--muted)">&amp;</span>'+_infSubj(r.subject_b)+_infChip(r.shared_segments+' shared segments','var(--warn)')+'</div></div>').join('');
    theme+=card('Shared travel routes',routes.length,'var(--warn)','high',
      'Pairs who repeatedly travel the <b>same ordered sequence of towers</b> &mdash; the path version of co-location (they move together, not just meet at a point). Common corridors everyone uses are filtered out.',rows);
  }
  const temp=C.temporal||{};
  const escE=Object.entries(temp.escalation||{}), dormE=Object.entries(temp.dormancy||{}), fc=temp.first_contacts||[];
  if(escE.length||dormE.length||fc.length){
    let rows='';
    if(escE.length)
      rows+='<div class="inf-row"><div class="top"><strong>Escalating activity</strong>'+_infChip('vs own baseline','var(--warn)')+'</div><div class="meta">'
        +escE.slice(0,8).map(([s,e])=>_infSubj(s)+' <span style="color:var(--muted)">('+e.factor+'&times;, '+e.baseline+'&rarr;'+e.recent+'/day)</span>').join(' · ')+'</div></div>';
    if(dormE.length)
      rows+='<div class="inf-row"><div class="top"><strong>Dormant &rarr; reactivated</strong>'+_infChip('went quiet, resurfaced','var(--accent)')+'</div><div class="meta">'
        +dormE.slice(0,8).map(([s,d])=>_infSubj(s)+' <span style="color:var(--muted)">('+d.dormant_days+'d silent, resumed '+esc(d.resumed)+')</span>').join(' · ')+'</div></div>';
    if(fc.length)
      rows+='<div class="inf-row"><div class="top"><strong>Newest first-contacts</strong>'+_infChip('new ties forming','var(--accent)')+'</div><div class="meta">'
        +fc.slice(0,8).map(p=>_infSubj(p.subject_a)+' ~ '+esc(p.subject_b)+' <span style="color:var(--muted)">('+esc((p.first_contact||'').slice(0,10))+')</span>').join(' · ')+'</div></div>';
    theme+=card('Behavioural shifts',(escE.length+dormE.length)+' flagged','var(--accent)','info',
      '<b>Escalation</b> is a sustained surge in a subject&rsquo;s activity vs their own baseline (not a one-day spike). <b>Dormant&rarr;reactivated</b> is a long silence then renewed activity. <b>First-contacts</b> are the most recently-formed ties &mdash; new numbers entering the network.',rows);
  }
  if(theme){h+='<div class="inf-theme">CDR · Movement &amp; behaviour</div>'+theme;}

  if(critN+highN+odd.length+periodic.length+movers.length+escE.length+dormE.length+routes.length+(net.brokers||[]).length+(net.articulation_points||[]).length===0){
    h+='<div class="inf-blurb" style="padding:8px 0">No CDR (call) patterns flagged for the '+n(subjects)+' phone subjects.</div>';
  }

  // ===================== IPDR ANALYSIS (IP addresses) =====================
  const ipdrRisk=I.risk||[], vol=(I.volume&&I.volume.subjects)||[], beac=I.beaconing||[], dests=I.destinations||[];
  const volCov=I.volume?I.volume.byte_coverage:null;
  if(ipdrRisk.length||vp.length||vol.length||beac.length||dests.length)
    h+='<div class="inf-theme">IPDR · Internet sessions (IP subjects)</div>';

  // Flagged IPs — risk leaderboard (mirrors the CDR persons-of-interest, IP subjects only)
  if(ipdrRisk.length){
    let rows='';
    ipdrRisk.slice(0,12).forEach(r=>{
      const bs=bandStyle(r.band);
      rows+='<div class="inf-poi-row">'
        +'<span class="inf-sev '+bs.s+'" title="composite risk score '+r.score+'/100">'+bs.l+' &middot; '+r.score+'</span>'
        +'<span class="who" style="font-family:monospace">'+esc(r.subject)+'</span>'
        +'<span class="flags">'+(r.factors||[]).map(f=>_infChip(f.name,bs.c,f.detail+(f.weight?' (+'+f.weight+')':''))).join('')+'</span></div>';
    });
    h+=_infCard('Flagged IP addresses','IP subjects, risk-ranked','var(--accent)',
      '<div class="inf-blurb"><b>IP addresses</b> (never phone numbers) ranked by a composite risk score over anonymisation, exfiltration and beaconing. Hover a chip for the reason.</div>'+rows);
  }

  if(vp.length){
    const rows=vp.slice(0,30).map(v=>{
      return '<div class="inf-row"><div class="top"><strong style="font-family:monospace">'+esc(v.source_ip)+'</strong>'
        +'<span style="font-size:0.66rem;color:var(--muted)">source IP</span>'
        +(v.vpn_sessions?_infChip(v.vpn_sessions+' VPN','var(--danger)'):'')
        +(v.proxy_tor_sessions?_infChip(v.proxy_tor_sessions+' proxy/Tor','var(--warn)'):'')+'</div>'
        +'<div class="meta">'+v.evidence.map(esc).join(' · ')
        +(v.servers&&v.servers.length?'<br>Servers: '+esc(v.servers.join(', ')):'')
        +' · ports '+esc((v.ports||[]).join(', '))+'</div></div>';
    }).join('');
    h+=card('VPN / proxy connections',vp.length+' source IP'+(vp.length===1?'':'s'),'var(--warn)','high',
      'IPDR <b>data sessions</b> opened to VPN/Tor tunnel ports. Subjects here are <b>source IP addresses</b> &mdash; not linked to any phone number. The destination is the server reached.',rows);
  }

  // Data volume / exfiltration
  const exf=vol.filter(v=>v.exfil_suspected);
  if(vol.length){
    const rows=vol.slice(0,12).map(v=>'<div class="inf-row"><div class="top"><strong style="font-family:monospace">'+esc(v.source_ip)+'</strong>'
      +(v.exfil_suspected?_infChip('asymmetric upload','var(--danger)'):'')+'</div>'
      +'<div class="meta">&uarr; '+n(v.up_mb)+' MB up &middot; &darr; '+n(v.down_mb)+' MB down &middot; '+v.sessions+' session(s)</div></div>').join('');
    h+=card('Data volume &amp; exfiltration',exf.length+' flagged','var(--danger)',exf.length?'crit':'info',
      'Per source IP, bytes uploaded vs downloaded. A large, <b>upload-heavy asymmetry</b> is exfiltration-shaped &mdash; a lead to review (cloud backup/video can look similar)'+(volCov!=null?'. Byte coverage: '+Math.round(volCov*100)+'% of sessions':'')+'.',rows);
  }

  // Beaconing
  if(beac.length){
    const rows=beac.slice(0,12).map(b=>'<div class="inf-row"><div class="top"><strong style="font-family:monospace">'+esc(b.source_ip)+'</strong> &rarr; <span style="font-family:monospace">'+esc(b.destination_ip)+'</span>'
      +(b.non_web_port?_infChip('port '+b.port,'var(--warn)'):(b.port!=null?_infChip('port '+b.port,'var(--muted)'):''))+'</div>'
      +'<div class="meta">'+b.sessions+' sessions every ~'+b.mean_interval_hours+'h (very regular, cv '+b.regularity_cv+')</div></div>').join('');
    h+=card('Beaconing (automated check-ins)',beac.length,'var(--warn)','high',
      'A source IP connecting to the <b>same destination on a regular, low-jitter cadence</b> &mdash; automated rather than human (agent/C2-shaped). Non-web destination ports raise confidence.',rows);
  }

  // Rare destinations
  if(dests.length){
    const rows=dests.slice(0,10).map(d=>'<div class="inf-row"><div class="top"><strong style="font-family:monospace">'+esc(d.source_ip)+'</strong>'
      +_infChip(d.rare.length+' rare dest','var(--accent)')+'<span style="font-size:0.66rem;color:var(--muted)">of '+d.distinct_destinations+' total</span></div>'
      +'<div class="meta">'+d.rare.slice(0,4).map(x=>esc(x.destination_ip)+(x.provider?' ('+esc(x.provider)+')':'')+' ×'+x.sessions).join(' · ')+'</div></div>').join('');
    h+=card('Rare destinations',dests.length,'var(--accent)','info',
      'Destinations reached from <b>very few source IPs</b> &mdash; uncommon endpoints worth a look (labelled with the destination provider where known).',rows);
  }

  h+='</div>';
  return h;
}

// wlAdd / wlRemove / wlExport / removeFromSuspectGroup are assigned to window above (inline onclick
// handlers reference them). Register the inferences tab with the router.
registerTab('inferences', renderInferences);
