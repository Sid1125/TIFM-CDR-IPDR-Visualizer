import { esc, fmt, fmts, fmtd, fmtBytes, colWidth, n, debounce, renderMd, _fmtDT, evidenceHash } from './core/utils.js';
import { SERVICE_DB, IP_RANGES, ISP_PROVIDERS, KNOWN_IP_HINTS, HOSTING_PROVIDERS, PRIVATE_LABEL, DISTINCTIVE_INDICATORS, EPHEMERAL_MIN, PORT_SVC, PORT_FAMILY, FAMILY_GAP, svcColor } from './core/constants.js';
import { $, D } from './core/dom.js';
import { state } from './core/state.js';
import { _W } from './data/workers.js';
import { _prefetchAiCache, invalidateAiCache } from './analytics/ai.js';  // self-registers the AI tab
import { API } from './core/api.js';
import { wireDelegation } from './core/events.js';
import { switchTab, registerTab, tabNeedsRender, tabMarkRendered } from './core/router.js';
import { checkAuth, resetIdle, startHealthCheck, initAuth, onAuthenticated } from './core/auth.js';
import { subjTag, subjLabel, subjLabelTxt, isSuspect } from './core/subjects.js';
import { toast } from './ui/toast.js';
import { nCdr, nIpdr, portSvc, twr, towerMeta, _totalCdrFn, _totalIpdrFn, rowsFor, ownedRowsFor } from './data/records.js';
import { isIspProvider, ipInRange, ipKind, ipHint, trafficPattern, scoreProvider, pickBest, recordSvcAttr, matchService } from './services/attribution.js';
import { renderRecords, renderRecTable } from './records/table.js';
import { renderCharts, onChartsRendered } from './charts/charts.js';
import './reference/laws.js';  // self-registers the Laws tab
import { provideInfReport } from './maps/map.js';  // self-registers the Map tab
import './towers/repo.js';  // self-registers the Tower Repository tab
import { loadReference, refLookup } from './reference/telecom.js';
import { _repCard, _wireVirtualTables } from './ui/report_table.js';
import './towers/dump.js';  // self-registers the Tower Dump tab
import { _wireExports } from './services/export.js';
import './analytics/reports.js';  // self-registers the Phase B/C report tabs
import './records/overlays.js';
import './records/annotations.js';
import { renderDashboard } from './dashboard/dashboard.js';  // self-registers the Dashboard tab
import './workspace/evidence_export.js';
import { loadSubjectTags, loadSuspects } from './data/subjects_intel.js';
import { renderGraph, initGraphSubjects } from './graph/network.js';  // self-registers the Graph tab
import { auditView } from './ui/admin.js';  // self-registers the Admin tab
import { identCache, dashAgg, clearAnalyticsCaches } from './services/cache.js';
import { reconstructSessions } from './services/sessions.js';
import './analytics/services.js';  // self-registers the Services tab
import { provideDetectMeetings } from './analytics/correlation.js';  // self-registers the Correlation tab
import { renderTimeline } from './timeline/timeline.js';  // self-registers the Timeline tab
import { detectMeetings, ensureMeetingsLoaded, meetingTotals, meetingsCache } from './services/meetings.js';
import { EVK, evLoad, evSave, updateEvidenceCount, pinEvidence, unpinEvidenceBySig, renderEvidence, captureSvgToEvidence, refreshCapButtons, installChartCaptureButtons, renderEvidenceTab, provideWorkspaceHooks } from './workspace/evidence.js';
import { renderCrossCaseHits, fillProfileCrossCase } from './analytics/crosscase.js';  // self-registers the Cross-Case tab
import { buildIdentityProfile } from './services/identity.js';
import { getInfReport, INF } from './services/inference.js';
import { renderStoryTimeline, resetStory } from './story/story.js';  // self-registers the Story tab
import { renderDossier } from './analytics/dossier.js';
import { showProfile } from './records/profile.js';
import './analytics/investigation.js';
import { renderInferences, loadExports, _exportsHtml, provideLoadSuspects } from './analytics/inferences.js';  // self-registers the Inferences tab
import './ui/gantt_tooltip.js';

// ====== WEB WORKERS ======
// Lazy-create workers once — reuse across calls.  Falls back to inline execution
// (same thread) when Workers are not supported (e.g. file:// origin).
// Web workers (_W: AI pre-warm + export) -> data/workers.js

// ====== STATE ======
// state now lives in core/state.js (imported above)
// _ownedSubjects: the case's real subjects from server — CDR a-parties + IPDR source IPs (NOT
// counterparts/destination IPs). Drives the analysis / correlation / group-compare subject pickers.
// _cdrStats/_ipdrStats: server-side aggregated totals (accurate even for large cases)
// _cd: chart data fetched lazily from /analysis/chart-data
// _totalCdr/_totalIpdr: true record counts (not bounded by the 500-row state.data.records sample)

// tab render tracking + switchTab now live in core/router.js (imported above); the gen/rendered
// counters are on state.render.
// Helper: true CDR/IPDR totals (server stats when available, fallback to sample length)



// Shared analytics caches (sessionCache/identCache/dashAgg + clearAnalyticsCaches) -> services/cache.js
// Dashboard single-pass aggregation cache (_getDashAgg) -> dashboard/dashboard.js

// Background loader: fetches ALL remaining records after the initial 500-row paint.
// Once done, state.data.records has the full dataset and features like timeline/map/story/graph work accurately.
let _bgLoadGen=0;
// Hard cap on the in-browser state.data.records mirror. Beyond this, the client holds a bounded sample
// (newest-first) for live previews — timeline, correlation, mini-graph, geofence — while the
// authoritative analytics (dashboard, analysis reports, inference, graph, search) are computed
// server-side over the WHOLE case. This is what keeps a 1–5M-row case from OOM-ing / freezing
// the browser; loadCaseData also seeds state.subjects from the server's full owned-subjects list,
// so the dropdowns still list every subject even when state.data.records is sampled.
const MAX_CLIENT_ROWS=150000;

async function _bgLoadAll(total,caseId,gen){
  if(total<=500)return;
  const want=Math.min(total,MAX_CLIENT_ROWS);   // rows to mirror client-side
  const sampled=total>want;
  if(want<=500){ // already have enough of a sample
    const b0=$('bgLoadBanner');
    if(b0&&sampled){b0.textContent='Showing a '+n(500)+'-record sample of '+n(total)+' — full analytics are server-side.';b0.style.display='block';setTimeout(()=>{if(b0)b0.style.display='none';},6000);}
    return;
  }
  const remaining=want-500;
  const banner=$('bgLoadBanner');
  if(banner){banner.textContent=sampled?('Loading a '+n(want)+'-record sample of '+n(total)+'…'):('Loading '+n(total)+' records…');banner.style.display='block';}
  try{
    const qp=new URLSearchParams({limit:remaining,offset:500});
    if(caseId)qp.set('case_id',caseId);
    const page=await API.get('/records/page?'+qp.toString());
    if(gen!==_bgLoadGen)return;  // case changed while we were loading
    const more=(page.rows||[]).map(r=>r.rtype==='CDR'?nCdr(r):nIpdr(r));
    // Merge into state.data.records (keep sorted by ts desc)
    state.data.records=[...state.data.records,...more].sort((a,b)=>b.tsMs-a.tsMs);
    _rebuildRowIdx();
    // Expand subjects list
    more.forEach(r=>{if(r.sub)state.subjects.push(r.sub);if(r.cnt)state.subjects.push(r.cnt);});
    state.subjects=[...new Set(state.subjects)].sort();
    if(banner){
      if(sampled){banner.textContent='Showing a '+n(want)+'-record sample of '+n(total)+' — full analytics are server-side.';setTimeout(()=>{if(banner)banner.style.display='none';},6000);}
      else{banner.style.display='none';}
    }
    // Pre-warm AI cache in background worker now that state.data.records is complete
    try{_prefetchAiCache();}catch(e){}
    // Re-render live features that depend on state.data.records
    try{renderTimeline&&renderTimeline();}catch(e){}
    try{renderDashboard();}catch(e){}
    try{if(state.tab==='graph')initGraphSubjects();}catch(e){}
    try{if(state.tab==='map'||state.tab==='geo')window.refreshGeoMap&&refreshGeoMap();}catch(e){}
  }catch(e){
    console.error('bgLoad:',e);
    if(banner){banner.textContent='Warning: only '+n(state.data.records.length)+' of '+n(total)+' records loaded.';setTimeout(()=>{if(banner)banner.style.display='none';},5000);}
  }
}
// API client now lives in core/api.js (imported above)

// ====== DOM REFS ====== ($ and D now live in core/dom.js, imported above)

// ====== DARK MODE ======
(function(){
  const saved=localStorage.getItem('darkMode');
  if(saved==='1'||saved==='true')document.body.classList.add('dark');
  updateChartTheme();
  D.darkModeBtn.addEventListener('click',()=>{
    document.body.classList.toggle('dark');
    localStorage.setItem('darkMode',document.body.classList.contains('dark')?'1':'0');
    updateChartTheme();
  });
})();

// ====== AUTH ====== (checkAuth/renderAuth/resetIdle/doLogout + session/AFK mgmt -> core/auth.js)
onAuthenticated(bootstrap);  // checkAuth/login run bootstrap on success (bootstrap is hoisted below)
initAuth();                  // wire login form, logout button, and idle-activity listeners

// ====== HELPERS ======
function updateChartTheme(){
  try{
    const isDark=document.body.classList.contains('dark');
    const textColor=isDark?'#e0ddd8':'#2c2418';
    Chart.defaults.color=textColor;
  }catch(e){}
}
// ====== SUBJECT INTEL TAGS ======
// Global-by-identifier tags loaded into state.subjectTags={subject:tag}. These helpers append the
// tag in brackets wherever a subject is shown, so outside intel follows the number/IP everywhere.
// (subjTag/subjLabel/subjLabelTxt/isSuspect now in core/subjects.js, imported above)
// Subject intel tags loader (loadSubjectTags) -> data/subjects_intel.js
// ====== TELECOM REFERENCE (offline number->operator/circle, ISD, IMEI TAC) ======
// Telecom reference (loadReference + refLookup/refOperator/refCircle/refImei/…) -> reference/telecom.js

// ====== SUSPECT GROUPS (named watchlist groups + cross-UI highlight) ======
// Suspect groups + subject-tag save (loadSuspects/addToSuspectGroup/saveProfileTag) -> data/subjects_intel.js
// ====== DATA LOADING ======
// Subject row index: rebuilt whenever state.data.records changes. Makes rowsFor/ownedRowsFor O(1)
// instead of O(n) state.data.records.filter() scans. For 50k rows and 10 subjects this eliminates
// ~500k iterations per AI render pass.
function _rebuildRowIdx(){
  state.data.rowIdx=new Map();state.data.ownedRowIdx=new Map();
  for(const r of state.data.records){
    if(r.sub){if(!state.data.rowIdx.has(r.sub))state.data.rowIdx.set(r.sub,[]);state.data.rowIdx.get(r.sub).push(r);}
    if(r.cnt&&r.cnt!==r.sub){if(!state.data.rowIdx.has(r.cnt))state.data.rowIdx.set(r.cnt,[]);state.data.rowIdx.get(r.cnt).push(r);}
    if(r.msisdn&&r.msisdn!==r.sub&&r.msisdn!==r.cnt){if(!state.data.rowIdx.has(r.msisdn))state.data.rowIdx.set(r.msisdn,[]);state.data.rowIdx.get(r.msisdn).push(r);}
    const ok=r.msisdn||r.sub;
    if(ok){if(!state.data.ownedRowIdx.has(ok))state.data.ownedRowIdx.set(ok,[]);state.data.ownedRowIdx.get(ok).push(r);}
  }
}
// Persist the chosen case across page refreshes (state.data.caseId is otherwise in-memory only,
// so a refresh would reset to whichever case the API returns first).
function setActiveCase(id){
  state.data.caseId=(id!=null&&id!=='')?String(id):null;
  try{if(state.data.caseId)localStorage.setItem('state.data.caseId',state.data.caseId);else localStorage.removeItem('state.data.caseId');}catch(e){}
}
async function loadCaseData(){
  // Bump render generation: tabs will know their cached render is stale.
  state.render.gen++;Object.keys(state.render.rendered).forEach(k=>delete state.render.rendered[k]);
  state._cd=null;  // chart data needs re-fetch
  invalidateAiCache();state.data.geoRecords=null;INF.report=null;INF.cache=null;meetingsCache.v=null;resetStory();
  try{
    const qp=new URLSearchParams({limit:500});
    if(state.data.caseId)qp.set('case_id',state.data.caseId);
    const caseParam=state.data.caseId?'?case_id='+encodeURIComponent(state.data.caseId):'';
    // Fetch sample records + stats + subjects + towers in parallel
    const[page1,towers,cdrStats,ipdrStats,ownedSubjects]=await Promise.all([
      API.get('/records/page?'+qp.toString()),
      API.get('/towers/'),
      API.get('/stats/cdr'+caseParam),
      API.get('/stats/ipdr'+caseParam),
      API.get('/analytics/subjects'+caseParam),  // {cdr:a-parties, ipdr:source-ips} = real subjects
    ]);
    state.towers=towers;
    state._cdrStats=cdrStats;
    state._ipdrStats=ipdrStats;
    state._totalCdr=cdrStats.total_records||0;
    state._totalIpdr=ipdrStats.total_records||0;
    // Real, analyzable subjects only (CDR a-parties + IPDR source IPs) — NOT the tens of
    // thousands of counterparts/destination IPs, which would flood the subject pickers.
    {const _os=ownedSubjects||{};
     state._ownedSubjects=Array.isArray(_os)?_os
       :[...new Set([...(_os.cdr||[]),...(_os.ipdr||[])])].sort();}
    // state.data.records = bounded 500-record sample for timeline, comparison, mini-graph, map, geofence
    const rows=page1.rows||[];
    const cdrRows=rows.filter(r=>r.rtype==='CDR');
    const ipdrRows=rows.filter(r=>r.rtype==='IPDR');
    state.cdr=cdrRows;state.ipdr=ipdrRows;
    state.data.records=rows.map(r=>r.rtype==='CDR'?nCdr(r):nIpdr(r)).sort((a,b)=>b.tsMs-a.tsMs);
    _rebuildRowIdx();
    // state.subjects = all parties from sample (for timeline, graph, comparison dropdowns)
    const subs=new Set();
    state.data.records.forEach(r=>{if(r.sub)subs.add(r.sub);if(r.cnt)subs.add(r.cnt)});
    state.subjects=[...subs].sort();
    if(page1.total>500){
      // Also seed subjects with the owned subjects list so analysis tabs work on large cases
      state._ownedSubjects.forEach(s=>subs.add(s));
      state.subjects=[...subs].sort();
    }
    await ensureMeetingsLoaded(true);
    renderDashboard();
    renderRecords();
    // Kick off background full-load BEFORE rendering charts so all features get complete data
    const curGen=state.render.gen;
    _bgLoadGen=curGen;
    if(page1.total>state.data.records.length)_bgLoadAll(page1.total,state.data.caseId||'',curGen);
    renderCharts();    // async, server-side; will retry on tab switch if it fails
    initGraphSubjects();
    if(state.tab&&!['dashboard','charts','records'].includes(state.tab))switchTab(state.tab);
    if(state.data.caseId){const cn=(state.cases||[]).find(c=>String(c.id)===String(state.data.caseId));auditView('view_case',{case_id:state.data.caseId,case_name:cn?cn.name:null});}
    try{updateEvidenceCount();}catch(e){}
  }catch(e){console.error(e)}
}
// nCdr/nIpdr (record normalizers) now in data/records.js (imported above)
// -- Case Management --
async function loadCases(){
  try{let cases=await API.get('/cases/');
    state.cases=cases;
    if(!cases.length){
      const c=await API.post('/cases/',{name:'Default Case'});
      cases=[c];setActiveCase(c.id);
    }else{
      // Keep the current selection; else restore the saved one; else fall back to first.
      const has=id=>cases.some(c=>String(c.id)===String(id));
      const saved=(()=>{try{return localStorage.getItem('state.data.caseId')}catch(e){return null}})();
      if(state.data.caseId&&has(state.data.caseId)){/* keep */}
      else if(saved&&has(saved))setActiveCase(saved);
      else setActiveCase(cases[0].id);
    }
    const sel=D.caseSelector;
    sel.innerHTML=cases.map(c=>`<option value="${c.id}"${state.data.caseId==c.id?' selected':''}>${esc(c.name)} (${c.record_count})</option>`).join('')+
      '<option value="__new__">+ New Case</option><option value="__manage__">Manage Cases...</option>';
  }catch(e){} 
}
D.caseSelector.addEventListener('change',async function(){
  const v=this.value;
  if(v==='__new__'){const n=prompt('Case name:');if(n&&n.trim()){try{const c=await API.post('/cases/',{name:n.trim()});setActiveCase(c.id);await loadCaseData();await loadCases();}catch(e){alert('Failed: '+e.message)}}this.value=state.data.caseId||'';return}
  if(v==='__manage__'){showCaseManager();this.value=state.data.caseId||'';return}
  setActiveCase(v||null);await loadCaseData();
});
async function showCaseManager(){
  const cases=await API.get('/cases/');
  let h='<h3 style="margin:0 0 12px">Manage Cases</h3>';
  h+='<div class="cm-list" style="max-height:300px;overflow:auto">';
  cases.forEach((c,i)=>{
    h+=`<div class="cm-row" style="display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid var(--line)" data-idx="${i}">
      <strong style="flex:1">${esc(c.name)}</strong>
      <span style="font-size:0.75rem;color:var(--muted)">${c.record_count} records</span>
      <button class="btn-sm cm-switch">Switch</button>
      <button class="btn-sm cm-delete" style="border-color:var(--danger);color:var(--danger)">Delete</button>
    </div>`;
  });
  h+='</div><div style="margin-top:10px"><button class="btn-sm cm-close">Close</button></div>';
  let m=document.getElementById('caseManagerModal');
  if(!m){
    m=document.createElement('div');m.id='caseManagerModal';m.className='modal-overlay';
    m.style.cssText='position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.55);z-index:999;display:flex;align-items:center;justify-content:center';
    const box=document.createElement('div');box.className='modal';box.style.cssText='background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:20px;max-width:500px;width:90%';
    m.appendChild(box);document.body.appendChild(m);
    m.addEventListener('click',e=>{if(e.target===m)m.style.display='none'});
  }
  m.querySelector('.modal').innerHTML=h;
  // Wire up events
  const rows=m.querySelectorAll('.cm-row');
  rows.forEach((row,i)=>{
    const c=cases[i];
    if(!c)return;
    row.querySelector('.cm-switch').addEventListener('click',()=>{
      setActiveCase(c.id);m.style.display='none';loadCaseData();loadCases();
    });
    row.querySelector('.cm-delete').addEventListener('click',async()=>{
      if(!confirm('Delete case "'+c.name+'" and all its records?'))return;
      await API.del('/cases/'+c.id);
      if(String(state.data.caseId)===String(c.id))setActiveCase(null);
      loadCases();m.style.display='none';loadCaseData();
    });
  });
  m.querySelector('.cm-close').addEventListener('click',()=>{m.style.display='none'});
  m.style.display='flex';
}
// ip helpers (isIspProvider/ipInRange/ipKind/ipHint) -> services/attribution.js (imported)
// Identity resolution (buildIdentityProfile) -> services/identity.js
// -- Dataset Quality Metrics --
// Dataset quality metrics (computeQualityMetrics) -> dashboard/dashboard.js
// -- Tower Analytics --
// towerAnalytics (profile tower stats) -> records/profile.js
// Evidence integrity hash (evidenceHash) -> core/utils.js
// -- View Supporting Records --
// Record/meeting/subject modal overlays (showSessionRecords/showMeetingOverlay/showSubjectRecords) -> records/overlays.js
// -- Quality Dashboard Integration --
// Data-quality card (renderQualityCard) -> dashboard/dashboard.js
// -- Port?Description map --
// portSvc now in data/records.js (imported above)
// service-attribution engine (trafficPattern/scoreProvider/pickBest/recordSvcAttr/matchService) -> services/attribution.js (imported)
// -- Session-level classification (behavioral fingerprinting) --
// IPDR session engine (classifySession + recPortFamily + reconstructSessions) -> services/sessions.js
// -- Timeline Narrative Engine --
// buildNarrative (profile timeline narrative) -> records/profile.js



// ====== TAB SWITCHING ======
// Register each tab's render fn with the router (switchTab dispatches through this). As features
// move to their own modules, each registration moves with them. Function decls are hoisted, so
// referencing them here (before their definitions below) is fine.
// dashboard tab registered in dashboard/dashboard.js (self-registers via registerTab)
// graph tab registered in graph/network.js (self-registers via registerTab)
// map tab registered in maps/map.js (self-registers via registerTab)
// timeline tab registered in timeline/timeline.js (self-registers via registerTab)
// services tab registered in analytics/services.js (self-registers)
// correlation tab registered in analytics/correlation.js (self-registers)
// story tab registered in story/story.js (self-registers via registerTab)
// evidence tab registered in workspace/evidence.js (self-registers via registerTab)
// crosscase tab registered in analytics/crosscase.js (self-registers via registerTab)
// inferences tab registered in analytics/inferences.js (self-registers via registerTab)
// analysisreports tab registered in analytics/reports.js (self-registers)
// groupcompare tab registered in analytics/reports.js (self-registers)
// towerdump tab registered in towers/dump.js (self-registers via registerTab)
// towerrepo tab registered in towers/repo.js (self-registers via registerTab)
// ai tab registered in analytics/ai.js (self-registers via registerTab)
// admin tab registered in ui/admin.js (self-registers via registerTab)
document.querySelectorAll('.topbar-tab').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)));

// Topbar dropdown menus (grouped nav + user menu): click to toggle, click-out to close.
(function initTopbarMenus(){
  const toggle=(el)=>{const wasOpen=el.classList.contains('open');document.querySelectorAll('.nav-group.open,.user-menu.open').forEach(x=>x.classList.remove('open'));if(!wasOpen)el.classList.add('open');};
  document.querySelectorAll('.nav-group-btn').forEach(btn=>btn.addEventListener('click',e=>{e.stopPropagation();toggle(btn.parentNode);}));
  const ub=document.querySelector('.user-btn');if(ub)ub.addEventListener('click',e=>{e.stopPropagation();toggle(ub.parentNode);});
  document.addEventListener('click',()=>document.querySelectorAll('.nav-group.open,.user-menu.open').forEach(x=>x.classList.remove('open')));
})();

// ====== UPLOAD ======
function parseCsvPreview(text){
  const lines=text.split('\n').map(l=>l.trim()).filter(Boolean);
  if(!lines.length)return null;
  const sep=lines[0].includes('\t')?'\t':',';
  const header=lines[0].split(sep).map(h=>h.replace(/^"|"$/g,'').trim());
  const rows=lines.slice(1,21).map(l=>{
    const vals=[];
    let cur='',inQ=false;
    for(let i=0;i<l.length;i++){
      const c=l[i];
      if(c==='"'){inQ=!inQ;continue}
      if(c===sep&&!inQ){vals.push(cur.replace(/^"|"$/g,''));cur='';continue}
      cur+=c;
    }
    vals.push(cur.replace(/^"|"$/g,''));
    return vals;
  });
  return {header,rows,total:lines.length-1,sep};
}
function showUploadPreview(kind,file){
  const reader=new FileReader();
  reader.onload=function(e){
    const text=e.target.result;
    const preview=parseCsvPreview(text);
    if(!preview){D.importStatus.textContent='Could not parse CSV.';return}
    const routes={cdr:'/upload/cdr',ipdr:'/upload/ipdr',towers:'/upload/towers',sdr:'/upload/sdr'};
    const kindLabel={cdr:'CDR',ipdr:'IPDR',towers:'Towers',sdr:'SDR'};
    let modal=document.getElementById('uploadPreviewModal');
    if(!modal){
      modal=document.createElement('div');modal.id='uploadPreviewModal';modal.className='modal-overlay';
      modal.style.cssText='position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.55);z-index:999;display:flex;align-items:center;justify-content:center';
      const box=document.createElement('div');box.className='modal';box.style.cssText='background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:20px;max-width:700px;width:92%;max-height:80vh;overflow:auto;box-shadow:0 8px 32px rgba(0,0,0,0.3)';
      box.innerHTML='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><h3 id="upTitle" style="margin:0;font-size:1rem"></h3><button id="upClose" class="btn-sm" style="font-size:1.2rem;background:none;border:none;cursor:pointer;color:var(--fg)">&times;</button></div><div id="upBody"></div><div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px"><button id="upCancel" class="btn-sm">Cancel</button><button id="upConfirm" class="btn">Upload</button></div>';
      modal.appendChild(box);document.body.appendChild(modal);
      modal.addEventListener('click',e=>{if(e.target===modal)modal.style.display='none'});
    }
    modal.querySelector('#upTitle').textContent='Preview: '+kindLabel[kind]+' ('+preview.total+' rows)';
    let html='<div style="font-size:0.78rem;color:var(--muted);margin-bottom:8px">Columns: '+preview.header.join(', ')+'</div>';
    // CDR/IPDR: let the investigator add to an existing case instead of replacing it.
    if(kind==='cdr'||kind==='ipdr'){
      const existing=kind==='cdr'?(state.cdr?state.cdr.length:0):(state.ipdr?state.ipdr.length:0);
      html+='<div id="upModeBox" style="margin-bottom:10px;padding:8px 10px;border:1px solid var(--line);border-radius:6px;font-size:0.8rem">'
        +'<div style="font-weight:600;margin-bottom:4px">This case already has '+n(existing)+' '+kindLabel[kind]+' record'+(existing===1?'':'s')+'</div>'
        +'<label style="display:block;cursor:pointer;padding:1px 0"><input type="radio" name="upMode" value="append" checked> Add to existing (keep current records)</label>'
        +'<label style="display:block;cursor:pointer;padding:1px 0;color:var(--danger)"><input type="radio" name="upMode" value="replace"> Replace existing (delete the '+n(existing)+' current '+kindLabel[kind]+' record'+(existing===1?'':'s')+' first)</label>'
        +'</div>';
      // Operator-aware column mapping; populated async from /upload/preview.
      html+='<div id="upMapBox" style="margin-bottom:10px;font-size:0.8rem;color:var(--muted)">Detecting column mapping…</div>';
    }
    html+='<div style="overflow:auto;max-height:350px;border:1px solid var(--line);border-radius:6px">';
    html+='<table class="data-table" style="min-width:400px;font-size:0.72rem"><thead><tr>'+preview.header.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr></thead><tbody>';
    preview.rows.forEach(r=>{html+='<tr>'+r.map(v=>'<td style="max-width:150px;overflow:hidden;text-overflow:ellipsis">'+esc(v||'')+'</td>').join('')+'</tr>'});
    html+='</tbody></table></div>';
    modal.querySelector('#upBody').innerHTML=html;
    modal.style.display='flex';
    if(kind==='cdr'||kind==='ipdr')populateMapping(modal,kind,file);
    const upConfirm=modal.querySelector('#upConfirm');
    const upCancel=modal.querySelector('#upCancel');
    const upClose=modal.querySelector('#upClose');
    const hide=()=>{modal.style.display='none'};
    const newUpConfirm=upConfirm.cloneNode(true);
    upConfirm.parentNode.replaceChild(newUpConfirm,upConfirm);
    const newUpCancel=upCancel.cloneNode(true);
    upCancel.parentNode.replaceChild(newUpCancel,upCancel);
    const newUpClose=upClose.cloneNode(true);
    upClose.parentNode.replaceChild(newUpClose,upClose);
    newUpClose.addEventListener('click',hide);
    newUpCancel.addEventListener('click',hide);
    newUpConfirm.addEventListener('click',async()=>{
      const sel=modal.querySelector('input[name="upMode"]:checked');
      const mode=sel?sel.value:'append';
      const mapping=(kind==='cdr'||kind==='ipdr')?collectMapping(modal):null;
      hide();await handleUploadConfirmed(kind,file,routes[kind],mode,mapping);
    });
  };
  reader.readAsText(file.slice(0,1024*512));
}

// Ask the backend how this file's headers map onto canonical fields, then render an editable
// mapping (a <select> of headers per canonical field) so the investigator can correct a
// mis-detected column before committing. Required fields are flagged when unmapped.
async function populateMapping(modal,kind,file){
  const box=modal.querySelector('#upMapBox');if(!box)return;
  try{
    const fd=new FormData();fd.append('file',file);fd.append('kind',kind);
    const r=await fetch('/upload/preview',{credentials:'same-origin',method:'POST',body:fd});
    if(!r.ok)throw new Error(await r.text()||'preview failed');
    const res=await r.json();
    const headers=res.headers||[];const required=res.required||[];const mapping=res.mapping||{};
    const opt=(canon,muted)=>{
      const cur=mapping[canon]||'';
      const opts=['<option value=""'+(cur?'':' selected')+'>— none —</option>']
        .concat(headers.map(h=>'<option value="'+esc(h)+'"'+(h===cur?' selected':'')+'>'+esc(h)+'</option>'));
      const miss=required.indexOf(canon)>=0&&!cur;
      return '<div style="display:flex;align-items:center;gap:8px;padding:2px 0">'
        +'<span style="width:140px;'+(muted?'color:var(--muted)':'font-weight:600')+(miss?';color:var(--danger)':'')+'">'+esc(canon)+(required.indexOf(canon)>=0?' *':'')+'</span>'
        +'<select data-canon="'+esc(canon)+'" class="input-sm upmap" style="flex:1">'+opts.join('')+'</select>'
        +(miss?'<span style="color:var(--danger);font-size:.72rem">required</span>':'')+'</div>';
    };
    const optionalMapped=(res.canonical||[]).filter(c=>required.indexOf(c)<0&&mapping[c]);
    let h='<div style="border:1px solid var(--line);border-radius:6px;padding:8px 10px">'
      +'<div style="font-weight:600;margin-bottom:4px;color:var(--fg)">Column mapping'
      +(res.detected_operator?' <span style="font-weight:400;color:var(--muted)">— detected: '+esc(res.detected_operator)+'</span>':'')+'</div>';
    h+=required.map(c=>opt(c,false)).join('');
    if(optionalMapped.length){
      h+='<details style="margin-top:6px"><summary style="cursor:pointer;color:var(--muted)">'+optionalMapped.length+' optional column'+(optionalMapped.length===1?'':'s')+' mapped</summary>'
        +optionalMapped.map(c=>opt(c,true)).join('')+'</details>';
    }
    h+='</div>';
    box.innerHTML=h;box.style.color='';
  }catch(e){box.innerHTML='<span style="color:var(--muted)">Auto-mapping unavailable; default column names will be used.</span>';console.error(e)}
}

// Read the mapping selects back into a {canonical: header} override object (only non-empty).
function collectMapping(modal){
  const sels=modal.querySelectorAll('select.upmap');if(!sels.length)return null;
  const m={};sels.forEach(s=>{if(s.value)m[s.dataset.canon]=s.value});
  return Object.keys(m).length?m:null;
}
async function handleUploadConfirmed(kind,file,route,mode,mapping){
  const verb=mode==='append'?'Adding':'Uploading';
  D.importStatus.textContent=verb+' '+kind+'...';
  try{const fd=new FormData();fd.append('file',file);if(state.data.caseId)fd.append('case_id',state.data.caseId);if(mode)fd.append('mode',mode);
    if(mapping)fd.append('mapping_json',JSON.stringify(mapping));
    const r=await fetch(route,{credentials:'same-origin',method:'POST',body:fd});
    if(r.status===401){const e=new Error(await r.text()||'Auth required');e.name='AuthError';throw e}
    if(!r.ok)throw new Error(await r.text()||'Upload failed');
    const res=await r.json().catch(()=>({}));
    {const fi=document.getElementById(kind==='towers'?'towerFile':kind+'File');if(fi)fi.value='';}
    let msg=kind.toUpperCase()+(mode==='append'?' added':' uploaded')+(res&&res.records_imported!=null?' ('+n(res.records_imported)+' rows)':'');
    const v=res&&res.validation;
    if(v){
      const bits=[];
      if(v.rows_total!=null)bits.push('imported '+n(v.rows_imported)+' of '+n(v.rows_total));
      if(v.date_failures)bits.push(n(v.date_failures)+' date coercion'+(v.date_failures===1?'':'s'));
      if(v.rows_dropped)bits.push(n(v.rows_dropped)+' dropped');
      if(bits.length)msg+=' — '+bits.join(' · ');
    }
    D.importStatus.textContent=msg;
    try{toast('✓ '+msg);}catch(e){}
    if(v&&(v.rows_dropped||v.date_failures))showValidationReport(kind,v);
    await loadCaseData();
    if(kind==='cdr'||kind==='ipdr'){setTimeout(()=>{try{toast('⚙ Computing analytics in background — charts & reports will be instant on next open.');}catch(e){}},800);}
  }catch(e){D.importStatus.textContent='Upload failed: '+(e.message||'error');try{toast('Upload failed: '+(e.message||'error'));}catch(_){}console.error(e)}
}

// Surface what the ingest coerced or dropped so silent misparsing becomes visible.
function showValidationReport(kind,v){
  let modal=document.getElementById('valReportModal');
  if(!modal){
    modal=document.createElement('div');modal.id='valReportModal';modal.className='modal-overlay';
    modal.style.cssText='position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.55);z-index:1000;display:flex;align-items:center;justify-content:center';
    const box=document.createElement('div');box.className='modal';box.style.cssText='background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:20px;max-width:680px;width:92%;max-height:80vh;overflow:auto;box-shadow:0 8px 32px rgba(0,0,0,0.3)';
    box.innerHTML='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><h3 id="vrTitle" style="margin:0;font-size:1rem"></h3><button id="vrClose" class="btn-sm" style="font-size:1.2rem;background:none;border:none;cursor:pointer;color:var(--fg)">&times;</button></div><div id="vrBody"></div><div style="display:flex;justify-content:flex-end;margin-top:12px"><button id="vrOk" class="btn">OK</button></div>';
    modal.appendChild(box);document.body.appendChild(modal);
    modal.addEventListener('click',e=>{if(e.target===modal)modal.style.display='none'});
    box.querySelector('#vrClose').addEventListener('click',()=>modal.style.display='none');
    box.querySelector('#vrOk').addEventListener('click',()=>modal.style.display='none');
  }
  modal.querySelector('#vrTitle').textContent=kind.toUpperCase()+' import report';
  let h='<div style="font-size:0.85rem;line-height:1.7">'
    +'<div>Total rows in file: <b>'+n(v.rows_total)+'</b></div>'
    +'<div>Imported: <b style="color:#3a7d5a">'+n(v.rows_imported)+'</b></div>'
    +'<div>Dropped (no parseable start time): <b style="color:var(--danger)">'+n(v.rows_dropped)+'</b></div>'
    +'<div>Date values coerced: <b>'+n(v.date_failures)+'</b></div>';
  if(v.dropped_examples&&v.dropped_examples.length){
    const cols=Object.keys(v.dropped_examples[0]);
    h+='<div style="margin-top:10px;font-weight:600">Examples of dropped rows</div>';
    h+='<div style="overflow:auto;max-height:240px;border:1px solid var(--line);border-radius:6px;margin-top:4px"><table class="data-table" style="font-size:0.72rem"><thead><tr>'
      +cols.map(c=>'<th>'+esc(c)+'</th>').join('')+'</tr></thead><tbody>'
      +v.dropped_examples.map(r=>'<tr>'+cols.map(c=>'<td style="max-width:140px;overflow:hidden;text-overflow:ellipsis">'+esc(r[c]==null?'':r[c])+'</td>').join('')+'</tr>').join('')
      +'</tbody></table></div>';
  }
  h+='</div>';
  modal.querySelector('#vrBody').innerHTML=h;
  modal.style.display='flex';
}
// Replace the direct upload listeners with preview triggers
// NB: the towers input id is 'towerFile' (singular), so map kinds to ids explicitly rather than
// k+'File' — otherwise the towers tile silently gets no change handler.
[['cdr','cdrFile'],['ipdr','ipdrFile'],['towers','towerFile'],['sdr','sdrFile']].forEach(([k,id])=>{
  const el=document.getElementById(id);
  if(el)el.addEventListener('change',function(){const f=this.files&&this.files[0];if(f)showUploadPreview(k,f)});
});
D.resetCaseBtn.addEventListener('click',resetCase);

// ====== 1. DASHBOARD ======
// Dashboard tab + Investigation Summary + Compare Periods (renderDashboard + charts + quality) -> dashboard/dashboard.js

// Network Graph tab (renderGraph + renderNetworkIntel + canvas force-layout + initGraphSubjects) -> graph/network.js

// Tower Map tab (initMap / towerLocate / showTower) -> maps/map.js

// Cross-Case Linking (hits panel + profile panel + tab: list/graph views) -> analytics/crosscase.js

// Story / Narrative tab (buildCaseEvents + narrative + timeline + filters) -> story/story.js

// ---- Evidence folder (per-case, localStorage) ----
// Evidence board + snapshot capture (pin/unpin/capture/refreshCapButtons) -> workspace/evidence.js

// Story listeners moved into story/story.js
if(D.evidenceToggleBtn)D.evidenceToggleBtn.addEventListener('click',()=>{const p=D.evidencePanel;p.style.display=p.style.display==='none'?'':'none';renderEvidence();});
if(D.evidenceClearBtn)D.evidenceClearBtn.addEventListener('click',()=>{if(confirm('Remove all '+evLoad().length+' evidence item(s)?')){evSave([]);updateEvidenceCount();renderEvidence();refreshCapButtons();renderStoryTimeline();renderEvidenceTab();}});

// ---- Dedicated Evidence tab (full view of everything saved) ----
// Evidence tab: Hypotheses + Relationships + renderEvidenceTab -> workspace/evidence.js

// Tower Repository tab (renderTowerRepo + stats/listing + rebuild/geocode/import) -> towers/repo.js

// Tower Map tab (loadGeoData + runMapMode + all showMap* modes + geofence + time scrubber) -> maps/map.js

// Entity Timeline tab (renderTimeline + lazy entity cards + Gantt + compare) -> timeline/timeline.js

// Charts tab (renderCharts + ~20 Chart.js renderers) -> charts/charts.js

// ====== 6. RECORDS TABLE ======
// loadAnnotations -> records/table.js
// Records-table flag/annotation toggle (toggleAnnot + _recordEvidence) -> records/annotations.js
// Records tab (table/pagination/export/annotations load) -> records/table.js

// Subject Profile modal (showProfile + fillProfileSubscriber + towerAnalytics + buildNarrative) -> records/profile.js

// Gantt session tooltip (showGanttTip + position/hide) -> ui/gantt_tooltip.js

// AI Insights tab + AI chat/report + analytics cache (getAiCache) -> analytics/ai.js

// Navbar Export button (full case evidence report .md) -> workspace/evidence_export.js

// Court-Ready Dossier (renderDossier + agency letterhead + cross-case fill) -> analytics/dossier.js

// Service Attribution tab (renderServicesTab + bursts + service cards) -> analytics/services.js

// Cross-Subject Correlation tab (renderCorrelationTab + runCorrelation) -> analytics/correlation.js
// Services + Correlation tab listeners moved into analytics/services.js + analytics/correlation.js

// ====== BOOTSTRAP ======
// Laws / legal-reference tab (LAW_CATS/LAW_REFERENCE + renderLaws) -> reference/laws.js

// CSV / XLSX export (downloadCsv/downloadXlsx/_wireExports) -> services/export.js
// Shared report-table renderers (_repCard + virtual tables) -> ui/report_table.js
const _hm=v=>{try{return new Date(v).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}catch(e){return ''}};
const _durStr=s=>{s=+s||0;return s>=60?Math.floor(s/60)+'m '+(s%60)+'s':s+'s'};

// Phase B/C server-side report tabs (renderAnalysisReports + renderGroupCompare) -> analytics/reports.js

// Tower Dump Analysis tab (Phase D: import + common/uncommon/multiplicity/under-tower) -> towers/dump.js

async function bootstrap(){
  await loadCases();
  try{await loadSubjectTags();}catch(e){}
  try{await loadReference();}catch(e){}
  try{await loadSuspects();}catch(e){}
  try{await loadCaseData();}catch(e){console.error(e)}
  D.loginPass.value='';
  resetIdle();
  D.importStatus.textContent='Data loaded from previous session. Use Reset Case to start fresh.';
  startHealthCheck();
}

async function resetCase(){
  const caseName=(D.caseSelector&&D.caseSelector.options[D.caseSelector.selectedIndex]?.text)||'';
  const msg=state.data.caseId
    ? 'Reset case "'+caseName+'"? This deletes its CDR & IPDR records. Shared tower locations are kept.'
    : 'Reset ALL data? This deletes every CDR & IPDR record across all cases. Tower locations are kept.';
  if(!confirm(msg))return;
  D.importStatus.textContent='Resetting case data...';
  const q=state.data.caseId?'?case_id='+state.data.caseId:'';
  try{await API.del('/records/reset'+q);D.importStatus.textContent='Case reset. Reloading...';await loadCaseData();D.importStatus.textContent='Case reset. Upload files to begin.'}catch(e){D.importStatus.textContent='Reset failed: '+e.message;console.error(e)}
}
// The transitional ESM->window bridge is gone: every inline on*= handler now resolves against a name
// self-bridged from its own feature module (switchTab -> core/router.js; showProfile -> records/
// profile.js; wl*/suspect-group/AI/story/etc from their modules). app.js only wires the cross-module
// injection hooks below.

provideWorkspaceHooks({renderStoryTimeline, renderDossier});  // evidence -> story/dossier refreshers
onChartsRendered(installChartCaptureButtons);  // charts pin-to-evidence buttons (injected; avoids charts->workspace import)
provideInfReport(getInfReport);  // map inference overlays reach getInfReport (inferences layer still in app.js)
provideDetectMeetings(detectMeetings);  // correlation meeting detection (dashboard engine still in app.js)
provideLoadSuspects(loadSuspects);  // inferences watchlist ops reach the suspect-group loader
wireDelegation();  // central data-act delegation (dormant until features register actions)
if(!D.loginUser.value)D.loginUser.value='admin';
checkAuth();
