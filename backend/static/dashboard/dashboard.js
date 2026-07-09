// dashboard/dashboard.js — the Dashboard (landing) tab: the hero summary + stat cards, the data-
// quality card, the mini connection graph (D3) + service pie / activity heatmap / top-contacts bar
// (Chart.js), plus the Investigation Summary and Compare-Periods panels that render alongside it.
// _getDashAgg is the single-pass aggregation cache feeding the cards. Extracted from app.js (feature
// layer); pulls the shared engines (sessions, meetings, attribution) + cross-case hits panel. Reads
// the d3 / Chart / turf globals; showProfile in onclick strings resolves via the window bridge.
// Exports renderDashboard (app.js re-renders it on load); self-registers the dashboard tab.

import { esc, n, fmt, fmts } from '../core/utils.js';
import { $, D } from '../core/dom.js';
import { state } from '../core/state.js';
import { dashAgg } from '../services/cache.js';
import { _totalCdrFn, _totalIpdrFn, rowsFor } from '../data/records.js';
import { reconstructSessions } from '../services/sessions.js';
import { recordSvcAttr } from '../services/attribution.js';
import { svcColor } from '../core/constants.js';
import { subjLabel } from '../core/subjects.js';
import { ensureMeetingsLoaded, meetingTotals } from '../services/meetings.js';
import { renderCrossCaseHits } from '../analytics/crosscase.js';
import { showProfile } from '../records/profile.js';
import { registerTab, switchTab } from '../core/router.js';

function _getDashAgg(){
  if(dashAgg.len===state.data.records.length&&dashAgg.v)return dashAgg.v;
  const contactCounts={},towerCounts={},svcCounts={},subDays=new Map();
  let totalEvents=0;
  for(const r of state.data.records){
    if(r.cnt)contactCounts[r.cnt]=(contactCounts[r.cnt]||0)+1;
    if(r.tow)towerCounts[r.tow]=(towerCounts[r.tow]||0)+1;
    const sv=r.svc||'Unknown';svcCounts[sv]=(svcCounts[sv]||0)+1;
    if(r.type==='CDR'||(r.type==='IPDR'&&r.svc))totalEvents++;
    if(r.ts&&r.sub){const d=r.ts.slice(0,10);if(!subDays.has(r.sub))subDays.set(r.sub,new Map());subDays.get(r.sub).set(d,(subDays.get(r.sub).get(d)||0)+1);}
  }
  // reconstructSessions is self-caching — calling per-subject here populates cache for the tabs
  const totalSessions=state.subjects.reduce((sum,s)=>sum+reconstructSessions(s).length,0);
  let totalBursts=0;
  subDays.forEach(days=>{const counts=[...days.values()];if(counts.length<3)return;const avg=counts.reduce((a,c)=>a+c,0)/counts.length,thr=Math.max(avg*3,20);days.forEach(c=>{if(c>=thr)totalBursts++;});});
  dashAgg.v={contactCounts,towerCounts,svcCounts,totalEvents,totalSessions,totalBursts};
  dashAgg.len=state.data.records.length;
  return dashAgg.v;
}

// Score = 100 − Σ(share-missing × weight). Weights are each metric's max cost when 100% of
// rows lack it, so the score is file-size independent (the old per-row × count formula floored
// ANY large real-world file to 0%). Missing coordinates splits in two: rows that still carry a
// tower/cell id are RESOLVABLE — uploading a tower master lights them up on the map — and cost
// little; rows with no tower id at all are anchorless and cost full weight.
function computeQualityMetrics(){
  if(!state.data.records.length)return{score:100,total:0,penalties:[]};
  let missingTower=0,coordViaTower=0,coordAnchorless=0,missingDur=0,badTs=0,unknownProto=0;
  state.data.records.forEach(r=>{
    if(!r.tow)missingTower++;
    if(r.lat==null||r.lng==null){if(r.tow)coordViaTower++;else coordAnchorless++;}
    if(!r.dur&&r.dur!==0)missingDur++;
    if(r.ts){const d=new Date(r.ts);if(isNaN(d.getTime()))badTs++}else badTs++;
    if(r.type==='IPDR'&&(!r.prot||r.prot==='Unknown'))unknownProto++;
  });
  const total=state.data.records.length;
  const penalties=[];
  const addPenalty=(label,count,weight,hint)=>{
    const pct=total?Math.round(count/total*100):0;
    const pen=Math.round((count/total)*weight);
    if(pen||count)penalties.push({label,count,pct,pen,weight,hint});
  };
  addPenalty('Missing tower',missingTower,15);
  addPenalty('No coords (tower known)',coordViaTower,5,'resolvable — upload a tower master CSV');
  addPenalty('No coords (no tower)',coordAnchorless,20);
  addPenalty('Missing duration',missingDur,20);
  addPenalty('Invalid timestamps',badTs,30);
  addPenalty('Unknown protocol',unknownProto,10);
  const totalPenalty=penalties.reduce((s,p)=>s+p.pen,0);
  const score=Math.max(0,Math.min(100,100-totalPenalty));
  return{score,total,penalties};
}

function renderQualityCard(){
  const q=computeQualityMetrics();
  const cards=document.getElementById('dashCards');
  if(!cards)return;
  const existing=document.querySelector('.dq-card');
  if(existing)existing.remove();
  const div=document.createElement('div');
  div.className='dq-card';
  div.style.cssText='background:var(--bg);border-radius:8px;padding:12px;margin-bottom:10px;border:1px solid var(--line)';
  div.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:center"><h4 style="margin:0;font-size:0.85rem">Data Quality</h4>
    <span style="font-size:1.2rem;font-weight:700;color:${q.score>80?'var(--success)':q.score>50?'var(--warn)':'var(--danger)'}">${q.score}%</span></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:8px;font-size:0.72rem;color:var(--muted)">
      ${q.penalties.map(p=>`<div title="${p.hint||''}"><span style="color:${p.pen>10?'var(--warn)':''}">-${p.pen}</span> ${p.label}: ${p.count} (${p.pct}%)${p.hint?' <span style="color:var(--success)">ⓘ</span>':''}</div>`).join('')}
    </div>
    <div style="font-size:0.65rem;color:var(--muted);margin-top:4px;padding-top:4px;border-top:1px solid var(--line)">
      Score = 100 ${q.penalties.filter(p=>p.pen).map(p=>`- ${p.pen}`).join(' ')} = ${q.score}% (${q.total} records; each penalty = share missing × weight)
    </div>`;
  cards.parentNode.insertBefore(div,cards.nextSibling);
}

export function renderDashboard(){
  const _ht=$('dashHeroTitle'),_hs=$('dashHeroSub');
  if(!(_totalCdrFn()+_totalIpdrFn())){
    if(_ht)_ht.textContent='Dashboard';
    if(_hs)_hs.textContent='Upload CDR, IPDR and Tower CSVs to begin building the case.';
    D.dashCards.innerHTML='<div class="dash-card" style="grid-column:1/-1;text-align:center;padding:36px;color:var(--muted)">No data yet — use the upload cards above to add CDR / IPDR records and begin analysis.</div>';
    D.dashGraph.innerHTML='<p style="color:var(--muted);text-align:center;padding:40px 0;font-size:0.85rem">No data to display</p>';
    ['dashPie','dashHeat','dashBar'].forEach(k=>{if(D[k])D[k].innerHTML=''});
    try{window.dashPieChart&&(window.dashPieChart.destroy(),window.dashPieChart=null)}catch(e){}
    try{window.dashHeatChart&&(window.dashHeatChart.destroy(),window.dashHeatChart=null)}catch(e){}
    try{window.dashBarChart&&(window.dashBarChart.destroy(),window.dashBarChart=null)}catch(e){}
    return;
  }
  const total=_totalCdrFn()+_totalIpdrFn();
  const totalCdr=_totalCdrFn(),totalIpdr=_totalIpdrFn();
  // Single-pass aggregation (cached; rebuilds when state.data.records grows after background load)
  const{contactCounts,towerCounts,svcCounts,totalEvents,totalSessions,totalBursts}=_getDashAgg();
  // Server stats for accurate totals; sample for top-N approximations
  const uniqueContactsCount=(state._cdrStats&&state._cdrStats.unique_b_party)||Object.keys(contactCounts).length;
  const uniqueSubjectsCount=(state._cdrStats&&state._cdrStats.unique_a_party)||state.subjects.length;
  const topContact=Object.entries(contactCounts).sort((a,b)=>b[1]-a[1])[0];
  const topTower=Object.entries(towerCounts).sort((a,b)=>b[1]-a[1])[0];
  const topSvc=Object.entries(svcCounts).sort((a,b)=>b[1]-a[1])[0];

  // Hero: case name + live one-line summary
  if(_ht){const opt=D.caseSelector&&D.caseSelector.options[D.caseSelector.selectedIndex];
    const cn=opt?opt.text.replace(/\s*\(\d+\)\s*$/,'').trim():'';_ht.textContent=cn||'Investigation overview';}
  if(_hs){
    // Use server date range if available; fall back to sample
    const dr=state._cdrStats&&state._cdrStats.date_range;
    let span='';
    if(dr&&dr.min&&dr.max){span=new Date(dr.min).toLocaleDateString()+' – '+new Date(dr.max).toLocaleDateString();}
    else{let _mn=Infinity,_mx=-Infinity;state.data.records.forEach(r=>{if(r.tsMs){if(r.tsMs<_mn)_mn=r.tsMs;if(r.tsMs>_mx)_mx=r.tsMs;}});if(_mx>-Infinity)span=new Date(_mn).toLocaleDateString()+' – '+new Date(_mx).toLocaleDateString();}
    _hs.textContent=n(total)+' records · '+n(uniqueSubjectsCount)+' subjects · '+n(uniqueContactsCount)+' contacts'+(span?' · '+span:'');}

  D.dashCards.innerHTML=[
    {l:'Total Records',v:n(total),d:`${n(totalCdr)} CDR + ${n(totalIpdr)} IPDR`},
    {l:'Reconstructed Sessions',v:n(totalSessions),d:'From session reconstruction engine'},
    {l:'Call/Service Events',v:n(totalEvents),d:'CDR calls + attributed IPDR'},
    {l:'Top Contact',v:topContact?esc(topContact[0]):'n/a',d:topContact?topContact[1]+' interactions':'No data'},
    {l:'Top Service',v:topSvc?esc(topSvc[0]):'n/a',d:topSvc?topSvc[1]+' sessions':'No data'},
    {l:'Most Active Tower',v:topTower?esc(topTower[0]):'n/a',d:topTower?topTower[1]+' visits':'No data'},
    {l:'Unique Contacts',v:n(uniqueContactsCount),d:n(uniqueSubjectsCount)+' unique subjects'},
    {l:'Unique Subjects',v:n(uniqueSubjectsCount),d:'Network of '+n(uniqueContactsCount)+' contacts'},
    state.map.fenceDrawn&&state.map.fenceLayer?(()=>{
      const fencePts=state.map.fenceLayer.getLatLngs();
      const coords=Array.isArray(fencePts[0])?fencePts[0].map(p=>[p.lng,p.lat]):fencePts.map(p=>[p.lng,p.lat]);
      if(!coords.length)return null;
      const poly=turf.polygon([coords]);
      let inside=0;
      (state.data.geoRecords||[]).forEach(r=>{
        if(r.latitude!=null&&r.longitude!=null&&turf.booleanPointInPolygon(turf.point([r.longitude,r.latitude]),poly))inside++;
      });
      return {l:'Geo-fenced Records',v:n(inside),d:'Within drawn geofence',cat:'warn'};
    })():null,
    totalBursts?{l:'Activity Spikes',v:n(totalBursts),d:'Days with anomalous volume',cat:'alert'}:null,
  ].filter(Boolean).map(c=>`<div class="dash-card ${c.cat||''}"><div class="dash-label">${c.l}</div><div class="dash-value">${c.v}</div><div class="dash-detail">${c.d}</div></div>`).join('');

  renderCaseSummary();
  renderQualityCard();
  renderCrossCaseHits();
  if(D.compareBar)D.compareBar.style.display='flex';
  // Pre-fill date inputs with data range (server date_range preferred over sample)
  if(!D.cpStartA.value||!D.cpStartB.value){
    const dr=state._cdrStats&&state._cdrStats.date_range;
    const minT=dr&&dr.min?new Date(dr.min):null;
    const maxT=dr&&dr.max?new Date(dr.max):null;
    if(minT&&maxT&&minT<maxT){
      const mid=new Date((minT.getTime()+maxT.getTime())/2);
      if(!D.cpStartA.value){D.cpStartA.value=minT.toISOString().slice(0,10);D.cpEndA.value=mid.toISOString().slice(0,10)}
      if(!D.cpStartB.value){D.cpStartB.value=mid.toISOString().slice(0,10);D.cpEndB.value=maxT.toISOString().slice(0,10)}
    }else{
      const times=state.data.records.filter(r=>r.ts).map(r=>new Date(r.ts));
      if(times.length>1){const mn=new Date(Math.min(...times)),mx=new Date(Math.max(...times));const mid=new Date((mn.getTime()+mx.getTime())/2);if(!D.cpStartA.value){D.cpStartA.value=mn.toISOString().slice(0,10);D.cpEndA.value=mid.toISOString().slice(0,10)}if(!D.cpStartB.value){D.cpStartB.value=mid.toISOString().slice(0,10);D.cpEndB.value=mx.toISOString().slice(0,10)}}
    }
  }

  try{renderDashGraph()}catch(e){console.error('dashGraph:',e);if(D.dashGraph)D.dashGraph.innerHTML='<p style="color:var(--danger);font-size:0.75rem">'+e.message+'</p>'}
  D.dashGraph.onclick=()=>switchTab('graph');
  try{renderDashPie(svcCounts)}catch(e){console.error('dashPie:',e)}
  try{renderDashHeatmap()}catch(e){console.error('dashHeat:',e)}
  try{renderDashBar(contactCounts)}catch(e){console.error('dashBar:',e)}
}

// ---- Dashboard Graph (mini D3) ----
function renderDashGraph(){
  if(typeof d3==='undefined'){D.dashGraph.innerHTML='<p style="color:var(--danger);font-size:0.75rem">D3.js not loaded</p>';return}
  const sampled=state.data.records.filter(r=>r.sub&&r.cnt).slice(0,200);
  if(!sampled.length){D.dashGraph.innerHTML='<p style="color:var(--muted);font-size:0.82rem;text-align:center;padding:40px 0">No connections to display</p>';return}
  const rect=D.dashGraph.getBoundingClientRect();
  const w=rect.width||D.dashGraph.clientWidth||400,h=rect.height||D.dashGraph.clientHeight||240;
  D.dashGraph.innerHTML=`<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"></svg>`;
  const svg=d3.select(D.dashGraph).select('svg');
  const linkMap=new Map(),nodeW=new Map();
  sampled.forEach(r=>{const k=[r.sub,r.cnt].join('|');linkMap.set(k,(linkMap.get(k)||0)+1);nodeW.set(r.sub,(nodeW.get(r.sub)||0)+1);nodeW.set(r.cnt,(nodeW.get(r.cnt)||0)+1)});
  const links=[...linkMap.entries()].map(([k,w])=>{const [s,t]=k.split('|');return{source:s,target:t,weight:w}});
  const nodes=[...nodeW.entries()].map(([id,w])=>({id,weight:w}));
  const sim=d3.forceSimulation(nodes).force('link',d3.forceLink(links).id(d=>d.id).distance(60)).force('charge',d3.forceManyBody().strength(-80)).force('center',d3.forceCenter(w/2,h/2)).force('collision',d3.forceCollide(8));
  const link=svg.append('g').selectAll('line').data(links).join('line').attr('stroke','#dccfc0').attr('stroke-width',1);
  const node=svg.append('g').selectAll('circle').data(nodes).join('circle').attr('r',d=>Math.max(3,Math.min(10,d.weight*0.8))).style('fill','var(--accent)').attr('stroke','#fff').attr('stroke-width',1).style('cursor','pointer')
    .on('click',(e,d)=>showProfile(d.id));
  sim.on('tick',()=>{link.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y).attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);node.attr('cx',d=>d.x).attr('cy',d=>d.y)});
}

// ---- Dashboard Pie ----
function renderDashPie(svcCounts){
  if(typeof Chart==='undefined')return;
  const sorted=Object.entries(svcCounts).sort((a,b)=>b[1]-a[1]);
  const labels=sorted.slice(0,8).map(s=>s[0]),data=sorted.slice(0,8).map(s=>s[1]);
  const colors=['#2c6f79','#b94a48','#d4a017','#3a7d5a','#8b5cf6','#ec4899','#f97316','#6b7280'];
  if(window.dashPieChart){try{window.dashPieChart.destroy()}catch(e){}window.dashPieChart=null}
  if(!D.dashPie)return;
  window.dashPieChart=new Chart(D.dashPie,{type:'doughnut',data:{labels,datasets:[{data,backgroundColor:colors,borderWidth:0}]},options:{plugins:{legend:{display:true,position:'right',labels:{boxWidth:12,font:{size:10}}}},responsive:true,maintainAspectRatio:false}});
}

// ---- Dashboard Heatmap ----
function renderDashHeatmap(){
  if(typeof Chart==='undefined')return;
  const hours=Array(24).fill(0);const days=Array(7).fill(0);
  const dayNames=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  state.data.records.forEach(r=>{if(r.tsMs){const d=new Date(r.tsMs);hours[d.getHours()]++;days[d.getDay()]++}});
  if(window.dashHeatChart){try{window.dashHeatChart.destroy()}catch(e){}window.dashHeatChart=null}
  if(!D.dashHeat)return;
  window.dashHeatChart=new Chart(D.dashHeat,{type:'bar',data:{labels:dayNames,datasets:[{label:'Activity',data:days,backgroundColor:days.map(d=>d>Math.max(...days)*0.7?'#b94a48':d>Math.max(...days)*0.4?'#d4a017':'#3a7d5a'),borderRadius:4}]},options:{plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,grid:{}},x:{grid:{display:false}}},responsive:true,maintainAspectRatio:false}});
}

// ---- Dashboard Bar ----
function renderDashBar(contactCounts){
  if(typeof Chart==='undefined')return;
  const sorted=Object.entries(contactCounts).sort((a,b)=>b[1]-a[1]).slice(0,10);
  if(window.dashBarChart){try{window.dashBarChart.destroy()}catch(e){}window.dashBarChart=null}
  if(!D.dashBar)return;
  window.dashBarChart=new Chart(D.dashBar,{type:'bar',data:{labels:sorted.map(s=>s[0].length>12?s[0].slice(0,12)+'...':s[0]),datasets:[{label:'Interactions',data:sorted.map(s=>s[1]),backgroundColor:'#2c6f79',borderRadius:4}]},options:{plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,grid:{}},x:{grid:{display:false}}},responsive:true,maintainAspectRatio:false,onClick:(e,el)=>{if(el.length){const idx=el[0].datasetIndex;const sub=state.subjects.find(s=>sorted[idx]&&s.includes(sorted[idx][0].slice(0,8)));if(sub)showProfile(sub)}}}});
}

// Meeting cache (ensureMeetingsLoaded + meetingTotals + detectMeetings) -> services/meetings.js

// AI analytics cache (getAiCache/_prefetchAiCache/invalidateAiCache) -> analytics/ai.js
// detectMeetings (synchronous filter over the meeting cache) -> services/meetings.js

// ====== INVESTIGATION SUMMARY ======
function renderCaseSummary(){
  if(!state.data.records.length){D.csGrid.innerHTML='<div style="font-size:0.75rem;color:var(--muted);grid-column:1/-1">Load data to generate case summary.</div>';D.csMeta.textContent='';return}
  // Gather stats
  const totalSubjects=state.subjects.length;
  const totalCdr=_totalCdrFn(),totalIpdr=_totalIpdrFn();
  const towerCount=state.towers.length;
  // Most active subject
  const subCounts={};state.data.records.forEach(r=>{if(r.sub)subCounts[r.sub]=(subCounts[r.sub]||0)+1});
  const topSub=Object.entries(subCounts).sort((a,b)=>b[1]-a[1])[0];
  // Most used service (attributed)
  const svcCounts={};state.data.records.forEach(r=>{const s=recordSvcAttr(r)||r.svc||'Unknown';svcCounts[s]=(svcCounts[s]||0)+1});
  const topSvc=Object.entries(svcCounts).sort((a,b)=>b[1]-a[1])[0];
  // Most common tower
  const towCounts={};state.data.records.forEach(r=>{if(r.tow)towCounts[r.tow]=(towCounts[r.tow]||0)+1});
  const topTow=Object.entries(towCounts).sort((a,b)=>b[1]-a[1])[0];
  // Contacts
  const allCnts=new Set(state.data.records.map(r=>r.cnt).filter(Boolean));
  // Time span
  let _spanMin=Infinity,_spanMax=-Infinity;state.data.records.forEach(r=>{if(r.tsMs){if(r.tsMs<_spanMin)_spanMin=r.tsMs;if(r.tsMs>_spanMax)_spanMax=r.tsMs;}});
  const span=_spanMax>-Infinity?Math.round((_spanMax-_spanMin)/86400000)+' days':'n/a';
  // Meetings: counted server-side (exact, full-coverage) and filled in async below — the old
  // client scan only sampled the top-30 subjects, undercounting on real cases.
  // Communication direction
  const dirCounts={mo:0,mt:0};state.data.records.forEach(r=>{if(r.dir==='MO'||r.dir==='mo')dirCounts.mo++;else if(r.dir==='MT'||r.dir==='mt')dirCounts.mt++});
  // Burst count
  const subDays=new Map();
  state.data.records.forEach(r=>{if(!r.tsMs||!r.sub)return;const d=new Date(r.tsMs).toLocaleDateString();if(!subDays.has(r.sub))subDays.set(r.sub,new Map());subDays.get(r.sub).set(d,(subDays.get(r.sub).get(d)||0)+1)});
  let bursts=0;
  subDays.forEach((days,sub)=>{const counts=[...days.values()];if(counts.length<3)return;const avg=counts.reduce((a,c)=>a+c,0)/counts.length;days.forEach((c,d)=>{if(c>=Math.max(avg*3,10))bursts++})});

  D.csGrid.innerHTML=[
    {l:'Subjects',v:n(totalSubjects),sub:''},
    {l:'Records',v:n(totalCdr+totalIpdr),sub:n(totalCdr)+' CDR & '+n(totalIpdr)+' IPDR'},
    {l:'Towers',v:n(towerCount),sub:''},
    {l:'Contacts',v:n(allCnts.size),sub:span},
    {l:'Most Active',v:topSub?subjLabel(topSub[0]):'n/a',sub:topSub?topSub[1]+' records':''},
    {l:'Top Service',v:topSvc?esc(topSvc[0]):'n/a',sub:topSvc?topSvc[1]+' records':''},
    {l:'Top Tower',v:topTow?esc(topTow[0]):'n/a',sub:topTow?topTow[1]+' visits':''},
    {l:'Meetings',v:'<span id="dashMeetVal" style="color:var(--muted)">…</span>',sub:'<span id="dashMeetSub" style="color:var(--muted)">computing…</span>'},
    {l:'Comm. Direction',v:dirCounts.mo||dirCounts.mt?n(dirCounts.mo)+'MO / '+n(dirCounts.mt)+'MT':'n/a',sub:''},
    {l:'Activity Spikes',v:n(bursts),sub:'Anomalous days'},
    {l:'Case Span',v:span,sub:_spanMax>-Infinity?new Date(_spanMin).toLocaleDateString()+' — '+new Date(_spanMax).toLocaleDateString():''},
  ].map(c=>`<div class="cs-item"><div class="cs-label">${c.l}</div><div class="cs-value">${c.v}</div>${c.sub?'<div class="cs-sub">'+c.sub+'</div>':''}</div>`).join('');
  D.csMeta.textContent=`${totalSubjects} subjects — ${totalCdr+totalIpdr} records — ${allCnts.size} contacts — ${span}`;
  refreshDashMeetings();
}
// Fill the dashboard Meetings card from the server's exact, full-coverage co-location counts
// (cached in meetingsCache.v, preloaded on case open).
async function refreshDashMeetings(){
  const v=()=>document.getElementById('dashMeetVal'),s=()=>document.getElementById('dashMeetSub');
  try{
    const r=await ensureMeetingsLoaded();
    if(v()){v().style.color='';v().textContent=n(r.total||0);}
    if(s()){s().style.color='';s().innerHTML=(r.total?'<span style="color:var(--success)">'+n(r.high||0)+' high</span> — <span style="color:var(--warn)">'+n(r.medium||0)+' med</span> — <span style="color:var(--muted)">'+n(r.low||0)+' low</span> confidence':'Potential co-locations');}
  }catch(e){if(v())v().textContent='n/a';if(s())s().textContent='';}
}

// ====== COMPARE PERIODS ======
function runComparePeriods(){
  const sA=D.cpStartA.value,eA=D.cpEndA.value,sB=D.cpStartB.value,eB=D.cpEndB.value;
  if(!sA||!eA||!sB||!eB){D.cpStatus.textContent='Select both date ranges.';return}
  const tMinA=new Date(sA).getTime(),tMaxA=new Date(eA).getTime()+86400000;
  const tMinB=new Date(sB).getTime(),tMaxB=new Date(eB).getTime()+86400000;
  const rowsA=state.data.records.filter(r=>r.tsMs&&r.tsMs>=tMinA&&r.tsMs<tMaxA);
  const rowsB=state.data.records.filter(r=>r.tsMs&&r.tsMs>=tMinB&&r.tsMs<tMaxB);
  if(!rowsA.length&&!rowsB.length){D.cpResults.innerHTML='<div style="color:var(--muted)">No records in either selected range.</div>';D.cpResults.style.display='block';return}
  // Contacts per period
  const cntsA=new Set(rowsA.map(r=>r.cnt).filter(Boolean));
  const cntsB=new Set(rowsB.map(r=>r.cnt).filter(Boolean));
  const sharedCnts=[...cntsA].filter(c=>cntsB.has(c));
  const newCnts=[...cntsB].filter(c=>!cntsA.has(c));
  const lostCnts=[...cntsA].filter(c=>!cntsB.has(c));
  // Towers per period
  const towsA=new Set(rowsA.map(r=>r.tow).filter(Boolean));
  const towsB=new Set(rowsB.map(r=>r.tow).filter(Boolean));
  const newTows=[...towsB].filter(t=>!towsA.has(t));
  // Service usage per period
  const svcA={};rowsA.forEach(r=>{const s=recordSvcAttr(r)||r.svc||'Unknown';svcA[s]=(svcA[s]||0)+1});
  const svcB={};rowsB.forEach(r=>{const s=recordSvcAttr(r)||r.svc||'Unknown';svcB[s]=(svcB[s]||0)+1});
  const allSvcs=new Set([...Object.keys(svcA),...Object.keys(svcB)]);
  const svcDeltas=[...allSvcs].map(s=>{
    const vA=svcA[s]||0,vB=svcB[s]||0;
    return {name:s,from:vA,to:vB,delta:vB-vA,pct:vA?Math.round((vB-vA)/vA*100):(vB?100:0)};
  }).sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta)).slice(0,8);
  // Volume
  const volPct=rowsA.length?Math.round((rowsB.length-rowsA.length)/rowsA.length*100):(rowsB.length?100:0);
  // Subjects
  const subsA=new Set(rowsA.map(r=>r.sub).filter(Boolean));
  const subsB=new Set(rowsB.map(r=>r.sub).filter(Boolean));
  const newSubs=[...subsB].filter(s=>!subsA.has(s));

  let html='<div style="font-weight:600;margin-bottom:8px">Period A: '+sA+' — '+eA+' ('+rowsA.length+' records) &nbsp;?&nbsp; Period B: '+sB+' — '+eB+' ('+rowsB.length+' records)</div>';
  html+=`<div class="cp-delta-grid">
    <div class="cp-delta-card"><div class="cp-label">Volume Change</div><div class="cp-val ${volPct>0?'pos':'neg'}">${volPct>0?'+':''}${volPct}%</div><div class="cp-detail">${rowsA.length} ? ${rowsB.length} records</div></div>
    <div class="cp-delta-card"><div class="cp-label">New Contacts</div><div class="cp-val pos">+${newCnts.length}</div><div class="cp-detail">${lostCnts.length} lost, ${sharedCnts.length} shared</div></div>
    <div class="cp-delta-card"><div class="cp-label">New Subjects</div><div class="cp-val pos">+${newSubs.length}</div><div class="cp-detail">Period B has ${subsB.size} subjects</div></div>
    <div class="cp-delta-card"><div class="cp-label">New Towers</div><div class="cp-val pos">+${newTows.length}</div><div class="cp-detail">${newTows.slice(0,5).join(', ')}${newTows.length>5?'...':''}</div></div>
  </div>`;
  if(svcDeltas.length){
    html+='<div style="font-weight:600;margin:10px 0 6px">Service Usage Change</div><div class="cp-delta-grid">';
    svcDeltas.forEach(s=>{
      const c=svcColor(s.name);
      html+=`<div class="cp-delta-card"><div class="cp-label"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c};margin-right:4px"></span>${esc(s.name)}</div>
        <div class="cp-val ${s.delta>0?'pos':'neg'}">${s.delta>0?'+':''}${s.delta} (${s.pct>0?'+':''}${s.pct}%)</div>
        <div class="cp-detail">${s.from} ? ${s.to}</div></div>`;
    });
    html+='</div>';
  }
  D.cpResults.innerHTML=html;D.cpResults.style.display='block';
  D.cpStatus.textContent='Compared '+sA+'—'+eA+' vs '+sB+'—'+eB;
}
// Wire up Compare Periods
D.cpGoBtn.addEventListener('click',runComparePeriods);
D.cpCloseBtn.addEventListener('click',()=>{D.cpResults.style.display='none';D.cpStatus.textContent=''});

// This tab owns its rendering; register with the router.
registerTab('dashboard', renderDashboard);
