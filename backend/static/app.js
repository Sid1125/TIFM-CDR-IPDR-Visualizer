import { esc, fmt, fmts, fmtd, fmtBytes, colWidth, n, debounce, renderMd, _fmtDT } from './core/utils.js';
import { SERVICE_DB, IP_RANGES, ISP_PROVIDERS, KNOWN_IP_HINTS, HOSTING_PROVIDERS, PRIVATE_LABEL, DISTINCTIVE_INDICATORS, EPHEMERAL_MIN, PORT_SVC, PORT_FAMILY, FAMILY_GAP, svcColor } from './core/constants.js';
import { $, D } from './core/dom.js';
import { state } from './core/state.js';
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
import { provideExports } from './towers/dump.js';  // self-registers the Tower Dump tab
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

// ====== WEB WORKERS ======
// Lazy-create workers once — reuse across calls.  Falls back to inline execution
// (same thread) when Workers are not supported (e.g. file:// origin).
const _W = {
  _ai: null,
  _export: null,
  _aiPending: [],   // queue of {resolve, reject} waiting for the AI result
  _aiRunning: false,
  _exportQueue: [], // FIFO of {resolve, reject} — worker answers postMessages in order

  ai() {
    if (!this._ai && typeof Worker !== 'undefined') {
      try {
        this._ai = new Worker('/static/workers/ai-worker.js');
        this._ai.onmessage = (e) => {
          const msg = e.data;
          if (msg.type === 'done') {
            this._aiRunning = false;
            this._aiPending.forEach(({resolve}) => resolve(msg.result));
            this._aiPending = [];
          } else if (msg.type === 'error') {
            this._aiRunning = false;
            this._aiPending.forEach(({reject}) => reject(new Error(msg.message)));
            this._aiPending = [];
          }
          // 'progress' messages are ignored for now
        };
        this._ai.onerror = (err) => {
          this._aiRunning = false;
          this._aiPending.forEach(({reject}) => reject(err));
          this._aiPending = [];
          this._ai = null;  // recreate on next call
        };
      } catch (_) {}
    }
    return this._ai;
  },

  // Returns a Promise that resolves with the AI result object.
  // If state.data.records is large, this runs in the worker; otherwise inline.
  computeAi(rows, wl) {
    const worker = this.ai();
    if (!worker) return Promise.resolve(_aiComputeInline(rows, wl));
    return new Promise((resolve, reject) => {
      this._aiPending.push({resolve, reject});
      if (!this._aiRunning) {
        this._aiRunning = true;
        worker.postMessage({type: 'compute', rows, watchlist: wl});
      }
    });
  },

  // Export to CSV off-main-thread. Handlers are attached once and a FIFO queue
  // pairs each worker reply with its caller, so overlapping exports don't clobber
  // each other's onmessage/onerror.
  export(format, headers, rows, filename) {
    if (typeof Worker === 'undefined') {
      return Promise.resolve(null);  // caller falls back to sync export
    }
    try {
      if (!this._export) {
        this._export = new Worker('/static/workers/export-worker.js');
        this._export.onmessage = (e) => {
          const job = this._exportQueue.shift();
          if (!job) return;
          if (e.data.type === 'done') job.resolve(e.data);
          else job.reject(new Error(e.data.message || 'export failed'));
        };
        this._export.onerror = (err) => {
          const pending = this._exportQueue; this._exportQueue = [];
          this._export = null;  // recreate on next call
          pending.forEach(({reject}) => reject(err));
        };
      }
      return new Promise((resolve, reject) => {
        this._exportQueue.push({resolve, reject});
        this._export.postMessage({type: format, headers, rows, filename});
      });
    } catch (err) {
      return Promise.reject(err);
    }
  },
};

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
async function loadSubjectTags(){
  try{const rows=await API.get('/subject-tags/');const m={};(rows||[]).forEach(r=>{if(r.subject)m[r.subject]=r.tag});state.subjectTags=m;}
  catch(e){state.subjectTags=state.subjectTags||{};}
}
// ====== TELECOM REFERENCE (offline number->operator/circle, ISD, IMEI TAC) ======
// Telecom reference (loadReference + refLookup/refOperator/refCircle/refImei/…) -> reference/telecom.js

// ====== SUSPECT GROUPS (named watchlist groups + cross-UI highlight) ======
async function loadSuspects(){
  try{const [v,g]=await Promise.all([API.get('/watchlist/values'),API.get('/watchlist/groups')]);
    state.suspects=v||[];state.suspectSet=new Set((v||[]).map(x=>String(x.value)));state.suspectGroups=g||[];}
  catch(e){state.suspects=[];state.suspectSet=new Set();state.suspectGroups=[];}
}
window.addToSuspectGroup=async function(value,kind){
  value=String(value==null?'':value).trim();if(!value)return;
  const def=state._lastGroup||((state.suspectGroups||[])[0]||{}).group_name||'Default';
  const group=prompt('Add "'+value+'" to which suspect group?',def);
  if(group===null)return;
  state._lastGroup=(group||'').trim()||'Default';
  try{await API.post('/watchlist',{value:value,kind:kind||undefined,group_name:state._lastGroup,case_id:state.data.caseId||null});
    await loadSuspects();try{toast('Added “'+value+'” to suspect group “'+state._lastGroup+'”.');}catch(e){}
    if(state.tab==='records')renderRecTable();
    if(state.tab==='graph')renderGraph();
    if(state.tab==='inferences'){INF.cache=null;renderInferences(true);}
  }catch(e){try{toast('Could not add to suspect group');}catch(_){}}
};

async function saveSubjectTag(sub,tag){
  const r=await API.put('/subject-tags/',{subject:sub,tag:tag});
  const t=(tag||'').trim();
  if(t)state.subjectTags[sub]=t;else delete state.subjectTags[sub];
  return r;
}
function saveProfileTag(sub){
  const inp=document.getElementById('profileTagInput');if(!inp)return;
  const val=inp.value.trim();
  saveSubjectTag(sub,val).then(()=>{
    try{toast(val?'Intel tag saved':'Intel tag cleared');}catch(e){}
    if(D.profileTitle)D.profileTitle.textContent='Subject: '+subjLabelTxt(sub);
  }).catch(e=>{try{toast('Could not save tag');}catch(_){} });
}
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
function computeQualityMetrics(){
  if(!state.data.records.length)return{score:100,missingTower:0,missingCoord:0,missingDur:0,badTs:0,unknownProto:0,total:0,penalties:[]};
  let missingTower=0,missingCoord=0,missingDur=0,badTs=0,unknownProto=0;
  state.data.records.forEach(r=>{
    if(!r.tow)missingTower++;
    if(r.lat==null||r.lng==null)missingCoord++;
    if(!r.dur&&r.dur!==0)missingDur++;
    if(r.ts){const d=new Date(r.ts);if(isNaN(d.getTime()))badTs++}else badTs++;
    if(r.type==='IPDR'&&(!r.prot||r.prot==='Unknown'))unknownProto++;
  });
  const total=state.data.records.length;
  const pcts={};const penalties=[];
  const addPenalty=(label,count,perRecord)=>{
    const pct=total?Math.round(count/total*100):0;
    const pen=Math.round(count*perRecord);
    pcts[label]={count,pct,pen};
    if(pen)penalties.push({label,count,pct,pen,weight:perRecord});
  };
  addPenalty('Missing tower',missingTower,5);
  addPenalty('Missing coordinates',missingCoord,8);
  addPenalty('Missing duration',missingDur,10);
  addPenalty('Invalid timestamps',badTs,15);
  addPenalty('Unknown protocol',unknownProto,3);
  const totalPenalty=penalties.reduce((s,p)=>s+p.pen,0);
  const score=Math.max(0,Math.min(100,100-totalPenalty));
  return{score,missingTower,missingCoord,missingDur,badTs,unknownProto,total,penalties};
}
// -- Tower Analytics --
// towerAnalytics (profile tower stats) -> records/profile.js
// -- Evidence Integrity Hash --
function evidenceHash(sessionData){
  const str=sessionData.serviceLabel+'|'+sessionData.evidence.sort().join(',')+'|'+sessionData.duration+'|'+(sessionData.records||0);
  let hash=0;for(let i=0;i<str.length;i++){const c=str.charCodeAt(i);hash=((hash<<5)-hash)+c;hash|=0}
  return 'EVID-'+Math.abs(hash).toString(16).toUpperCase().padStart(8,'0');
}
// -- View Supporting Records --
function showSessionRecords(sessionData){
  const overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center';
  overlay.onclick=e=>{if(e.target===overlay)overlay.remove()};
  const box=document.createElement('div');
  box.style.cssText='background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:20px;max-width:700px;max-height:80vh;overflow-y:auto;font-size:0.78rem';
  box.innerHTML=`
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h3 style="margin:0">Session: ${esc(sessionData.serviceLabel||'Unknown')}</h3>
      <span style="color:var(--muted);font-size:0.7rem">${evidenceHash(sessionData)}</span>
    </div>
    <div style="background:var(--accent-light);padding:8px;border-radius:4px;margin-bottom:10px">
      <strong>Evidence Chain:</strong>
      <div style="margin-top:4px">${sessionData.evidence?sessionData.evidence.map(e=>'<div style="padding:1px 0">&#x2022; '+esc(e)+'</div>').join(''):'No evidence'}</div>
    </div>
    <table style="width:100%;border-collapse:collapse">
      <thead><tr style="border-bottom:1px solid var(--line)"><th style="text-align:left;padding:4px">Time</th><th style="text-align:left;padding:4px">Type</th><th style="text-align:left;padding:4px">Counterpart</th><th style="text-align:left;padding:4px">Tower</th></tr></thead>
      <tbody>${(sessionData.recordsData||[]).map(r=>'<tr style="border-bottom:1px solid var(--line)"><td style="padding:3px">'+fmt(r.ts)+'</td><td style="padding:3px">'+esc(r.type||'')+'</td><td style="padding:3px">'+esc(r.cnt||'')+'</td><td style="padding:3px">'+esc(r.tow||'')+'</td></tr>').join('')}</tbody>
    </table>`;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}
function showMeetingOverlay(key,idx){
  const meetings=window.meetingStore&&window.meetingStore[key];
  if(!meetings||!meetings[idx])return;
  const m=meetings[idx];
  const overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center';
  overlay.onclick=e=>{if(e.target===overlay)overlay.remove()};
  const box=document.createElement('div');
  box.style.cssText='background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:20px;max-width:500px;max-height:60vh;overflow-y:auto;font-size:0.78rem';
  box.innerHTML=`
    <h3 style="margin:0 0 10px">Meeting: ${esc(m.subA)} & ${esc(m.subB)}</h3>
    <div style="margin-bottom:10px">
      <div><strong>Time:</strong> ${m.time?new Date(m.time).toLocaleString():'?'}</div>
      <div><strong>Tower:</strong> ${esc(m.tow)}</div>
      <div><strong>Gap:</strong> ${m.gap}m (${m.gapLevel})</div>
      <div><strong>Score:</strong> ${m.score} (${m.encounterCount} encounters)</div>
    </div>
    <div style="background:var(--accent-light);padding:8px;border-radius:4px;margin-bottom:10px">
      <strong>Evidence:</strong>
      <div style="margin-top:4px">${m.evidence?m.evidence.map(e=>'<div style="padding:1px 0">&#x2022; '+esc(e)+'</div>').join(''):'No evidence'}</div>
    </div>
    <table style="width:100%;border-collapse:collapse">
      <thead><tr style="border-bottom:1px solid var(--line)"><th style="text-align:left;padding:4px">Subject</th><th style="text-align:left;padding:4px">Event</th></tr></thead>
      <tbody>
        <tr style="border-bottom:1px solid var(--line)"><td style="padding:3px">${esc(m.subA)}</td><td style="padding:3px">${esc(m.subAEvent)}</td></tr>
        <tr><td style="padding:3px">${esc(m.subB)}</td><td style="padding:3px">${esc(m.subBEvent)}</td></tr>
      </tbody>
    </table>`;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}
function showSubjectRecords(sub){
  const rows=rowsFor(sub).slice(-50).reverse();
  if(!rows.length)return;
  const overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center';
  overlay.onclick=e=>{if(e.target===overlay)overlay.remove()};
  const box=document.createElement('div');
  box.style.cssText='background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:16px;max-width:700px;max-height:80vh;overflow-y:auto;font-size:0.75rem';
  box.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
    <h3 style="margin:0">Subject: ${subjLabel(sub)}</h3>
    <span style="color:var(--muted);font-size:0.7rem">${rows.length} records shown</span></div>
    <table style="width:100%;border-collapse:collapse">
      <thead><tr style="border-bottom:1px solid var(--line)"><th style="text-align:left;padding:3px">Time</th><th style="text-align:left;padding:3px">Type</th><th style="text-align:left;padding:3px">Counterpart</th><th style="text-align:left;padding:3px">Service</th><th style="text-align:left;padding:3px">Tower</th></tr></thead>
      <tbody>${rows.map(r=>'<tr style="border-bottom:1px solid var(--line)"><td style="padding:2px">'+fmt(r.ts)+'</td><td style="padding:2px">'+esc(r.type||'')+'</td><td style="padding:2px">'+esc(r.cnt||'')+'</td><td style="padding:2px">'+esc(r.svc||'')+'</td><td style="padding:2px">'+esc(r.tow||'')+'</td></tr>').join('')}</tbody>
    </table>`;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}
// -- Quality Dashboard Integration --
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
      ${q.penalties.map(p=>`<div><span style="color:${p.pen>5?'var(--warn)':''}">-${p.pen}</span> ${p.label}: ${p.count} (${p.pct}%)</div>`).join('')}
    </div>
    <div style="font-size:0.65rem;color:var(--muted);margin-top:4px;padding-top:4px;border-top:1px solid var(--line)">
      Score = 100 ${q.penalties.map(p=>`- ${p.pen}`).join(' ')} = ${q.score}% (${q.total} records)
    </div>`;
  cards.parentNode.insertBefore(div,cards.nextSibling);
}
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
registerTab('dashboard',renderDashboard);
// graph tab registered in graph/network.js (self-registers via registerTab)
// map tab registered in maps/map.js (self-registers via registerTab)
// timeline tab registered in timeline/timeline.js (self-registers via registerTab)
// services tab registered in analytics/services.js (self-registers)
// correlation tab registered in analytics/correlation.js (self-registers)
// story tab registered in story/story.js (self-registers via registerTab)
// evidence tab registered in workspace/evidence.js (self-registers via registerTab)
// crosscase tab registered in analytics/crosscase.js (self-registers via registerTab)
// inferences tab registered in analytics/inferences.js (self-registers via registerTab)
registerTab('analysisreports',renderAnalysisReports);
registerTab('groupcompare',renderGroupCompare);
// towerdump tab registered in towers/dump.js (self-registers via registerTab)
// towerrepo tab registered in towers/repo.js (self-registers via registerTab)
registerTab('ai',renderAiInsights);
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
function renderDashboard(){
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

// -- Analytics Cache --
window._aiCache=null;
window._aiCachePartial=null;  // pre-warmed by web worker; consumed by getAiCache()
window._aiCachePromise=null;

/**
 * Kick off the AI worker pre-warm.  Called after background load completes.
 * Result lands in _aiCachePartial; getAiCache() picks it up synchronously.
 */
function _prefetchAiCache(){
  if(window._aiCachePartial||window._aiCachePromise||!state.data.records.length)return;
  window._aiCachePromise=_W.computeAi(state.data.records,state.watchlist||[]).then(result=>{
    window._aiCachePartial=result;
    window._aiCachePromise=null;
  }).catch(()=>{window._aiCachePromise=null;});
}

function getAiCache(){
  if(window._aiCache)return window._aiCache;
  const c={};
  c.subCount=state.subjects.length;
  c.totalRows=state.data.records.length;

  // Use pre-warmed worker result when available (avoids blocking the main thread)
  const partial=window._aiCachePartial;
  if(partial){
    c.pairCounts=partial.pairCounts||{};
    // Convert sub_days plain object -> Map<sub, Map<date, n>>
    c.subDays=new Map();
    Object.entries(partial.subDays||{}).forEach(([sub,days])=>{
      c.subDays.set(sub,new Map(Object.entries(days)));
    });
    c.svcCounts=partial.svcCounts||{};
    c.allMeetings=partial.allMeetings||[];
  }else{
    // Inline fallback (worker not ready or not supported)
    c.pairCounts={};state.data.records.forEach(r=>{if(r.sub&&r.cnt){const k=[r.sub,r.cnt].sort().join('|');c.pairCounts[k]=(c.pairCounts[k]||0)+1}});
    c.subDays=new Map();state.data.records.forEach(r=>{if(!r.tsMs||!r.sub)return;const d=new Date(r.tsMs).toLocaleDateString();if(!c.subDays.has(r.sub))c.subDays.set(r.sub,new Map());c.subDays.get(r.sub).set(d,(c.subDays.get(r.sub).get(d)||0)+1)});
    c.svcCounts={};state.data.records.forEach(r=>{const s=r.svc||'Unknown';c.svcCounts[s]=(c.svcCounts[s]||0)+1});
    c.allMeetings=detectMeetings({allPairs:true});
  }

  c.changeCache={};
  state.subjects.slice(0,30).forEach(s=>{c.changeCache[s]=buildIdentityProfile(s).changes});
  window._aiCache=c;
  return c;
}
function invalidateAiCache(){window._aiCache=null;window._aiCachePartial=null;window._aiCachePromise=null;}

// Inline fallback — same logic as ai-worker.js for environments without Worker support.
function _aiComputeInline(rows,wl){
  const pairCounts={};const subDays={};const svcCounts={};const towerHour=new Map();
  rows.forEach(r=>{
    if(r.type==='CDR'&&r.sub&&r.cnt){const k=r.sub+'|'+r.cnt;pairCounts[k]=(pairCounts[k]||0)+1;}
    if(r.sub&&r.tsMs){const d=new Date(r.tsMs).toISOString().slice(0,10);if(!subDays[r.sub])subDays[r.sub]={};subDays[r.sub][d]=(subDays[r.sub][d]||0)+1;}
    if(r.type==='CDR'&&r.sub){if(!svcCounts[r.sub])svcCounts[r.sub]={CALL:0,SMS:0,DATA:0};const ct=(r.callType||'').toUpperCase();if(ct.includes('CALL')||ct.includes('VOICE'))svcCounts[r.sub].CALL++;else if(ct.includes('SMS')||ct.includes('TEXT'))svcCounts[r.sub].SMS++;else svcCounts[r.sub].DATA++;}
    if(r.type==='CDR'&&r.sub&&r.tower&&r.tsMs){const dt=new Date(r.tsMs);const thKey=r.tower+'|'+dt.toISOString().slice(0,10)+'|'+dt.getUTCHours();if(!towerHour.has(thKey))towerHour.set(thKey,[]);towerHour.get(thKey).push({sub:r.sub,ts:r.tsMs,lat:r.lat,lon:r.lon});}
  });
  const allMeetings=[];
  for(const[thKey,entries]of towerHour){if(entries.length<2)continue;const tower=thKey.split('|')[0];const bySub=new Map();entries.forEach(e=>{if(!bySub.has(e.sub))bySub.set(e.sub,e);});const subs=[...bySub.keys()];for(let a=0;a<subs.length&&allMeetings.length<5000;a++){for(let b=a+1;b<subs.length&&allMeetings.length<5000;b++){const ea=bySub.get(subs[a]);allMeetings.push({a:subs[a],b:subs[b],ts:ea.ts,tower,lat:ea.lat,lon:ea.lon});}}}
  return {pairCounts,subDays,svcCounts,allMeetings};
}

// -- Z-score spike detection --
// Requires: minimum 5-day baseline, minimum 20 records on spike day, z-score > 2.5
function findSpikes(subDays){
  const spikes=[];
  subDays.forEach((days,sub)=>{
    const entries=[...days.entries()].sort((a,b)=>new Date(a[0])-new Date(b[0]));
    if(entries.length<5)return; // need minimum baseline
    const values=entries.map(([,c])=>c);
    const avg=values.reduce((a,v)=>a+v,0)/values.length;
    const std=Math.sqrt(values.reduce((s,v)=>s+(v-avg)**2,0)/values.length)||1;
    entries.forEach(([d,c])=>{
      if(c<20)return; // minimum volume threshold
      const z=(c-avg)/std;
      if(z>2.5)spikes.push({sub,day:d,count:c,zScore:z,pct:avg?Math.round((c/avg-1)*100):0,avg});
    });
  });
  return spikes.sort((a,b)=>b.zScore-a.zScore);
}
// -- Confidence Breakdown Generator --
function confidenceBreakdown(baseScore,components){
  const total=components.reduce((s,c)=>s+c.value,baseScore);
  return{baseScore,components,total:Math.min(100,Math.max(0,total))};
}
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
// Build an evidence item mirroring a flagged record, looked up from state.data.records for a meaningful blurb.
function _recordEvidence(r,numId){
  const row=state.data.records.find(x=>x.id===r.id)||{};
  const parts=[];
  if(row.ts)parts.push(fmt(row.ts));
  if(row.cnt)parts.push((r.type==='CDR'?'with ':'→ ')+row.cnt);
  if(row.dur!=null&&row.dur!=='')parts.push(row.dur+'s');
  if(row.svc)parts.push(row.svc);
  if(row.tow)parts.push('tower '+row.tow);
  return {kind:'record',sig:'record|'+r.type+'|'+numId,
    label:subjLabelTxt(row.sub||'?')+' — '+r.type,
    detail:'Flagged record · '+(parts.join(' · ')||(r.type+' #'+numId)),
    ts:row.ts||null,subject:row.sub||null};
}
function toggleAnnot(r){
  const numId=parseInt(r.id.slice(1));
  const key=r.type+'_'+numId;
  // Repaint just this row's star in place — re-rendering the whole table here would reset
  // the paged view back to the first page.
  const paint=()=>{const cell=D.recBody.querySelector('.annot-cell[data-annot="'+key+'"]');if(cell)cell.innerHTML=state.data.annotations[key]?'&#9733;':'&#9734;';};
  if(state.data.annotations[key]){
    API.del('/annotations/'+state.data.annotations[key].id).then(()=>{
      delete state.data.annotations[key];paint();
      unpinEvidenceBySig('record|'+r.type+'|'+numId);
    }).catch(()=>{});
  }else{
    API.post('/annotations/',{record_type:r.type,record_id:numId,tag:'flagged',note:''}).then(a=>{
      state.data.annotations[key]=a;paint();
      pinEvidence(_recordEvidence(r,numId));
      try{toast('Record added to evidence.');}catch(e){}
    }).catch(e=>{console.error('annotation failed',e);});
  }
}
// Records tab (table/pagination/export/annotations load) -> records/table.js

// Subject Profile modal (showProfile + fillProfileSubscriber + towerAnalytics + buildNarrative) -> records/profile.js

// ====== GANTT TOOLTIP ======
function showGanttTip(el,e){
  const tip=document.getElementById('ganttTooltip');
  if(!tip)return;
  clearTimeout(tip._hideTimer);
  tip._hovering=true;
  const d=el.dataset;
  const svc=d.svc||'';
  const c=svcColor(svc);
  const start=d.start?new Date(d.start).toLocaleString():'—';
  const end=d.end?new Date(d.end).toLocaleString():'—';
  const dur=d.dur||'—';
  const conf=d.conf?d.conf+'%':'—';
  const ev=d.ev?d.ev.split(',').map(s=>s.trim()).filter(Boolean):[];
  const alts=d.alts?JSON.parse(d.alts):[];
  const tree={infrastructure:[],ports:[],behavior:[],signals:[]};
  ev.forEach(e=>{
    if(e.includes('IP range')||e.includes('Infrastructure')||e.includes('DNS')||e.includes('ASN'))tree.infrastructure.push(e);
    else if(e.includes('Port')||e.includes('port'))tree.ports.push(e);
    else if(e.includes('Behavior')||e.includes('pattern')||e.includes('Session')||e.includes('Traffic')||e.includes('UDP')||e.includes('TCP'))tree.behavior.push(e);
    else tree.signals.push(e);
  });
  tip.innerHTML=`
    <div class="tt-row"><span class="tt-svc" style="background:${c}">${esc(svc)}</span><span class="tt-val">${esc(d.attr||'')}</span></div>
    <hr>
    <div class="tt-row"><span class="tt-label">Start</span><span class="tt-val">${start}</span></div>
    <div class="tt-row"><span class="tt-label">End</span><span class="tt-val">${end}</span></div>
    <div class="tt-row"><span class="tt-label">Duration</span><span class="tt-val">${dur}s</span></div>
    <div class="tt-row"><span class="tt-label">Confidence</span><span class="tt-val">${conf}</span></div>
    ${(tree.infrastructure.length||tree.ports.length||tree.behavior.length||tree.signals.length)?`<hr><div class="tt-tree">
      ${tree.infrastructure.length?`<div class="tt-tree-node"><span class="tt-tree-label">&#x2514; Infrastructure</span>${tree.infrastructure.map(e=>`<div class="tt-tree-leaf">${esc(e)}</div>`).join('')}</div>`:''}
      ${tree.ports.length?`<div class="tt-tree-node"><span class="tt-tree-label">&#x2514; Ports</span>${tree.ports.map(e=>`<div class="tt-tree-leaf">${esc(e)}</div>`).join('')}</div>`:''}
      ${tree.behavior.length?`<div class="tt-tree-node"><span class="tt-tree-label">&#x2514; Behavior</span>${tree.behavior.map(e=>`<div class="tt-tree-leaf">${esc(e)}</div>`).join('')}</div>`:''}
      ${tree.signals.length?`<div class="tt-tree-node"><span class="tt-tree-label">&#x2514; Signals</span>${tree.signals.map(e=>`<div class="tt-tree-leaf">${esc(e)}</div>`).join('')}</div>`:''}
    </div>`:''}
    ${alts.length?`<hr><div style="font-size:0.68rem;color:var(--muted);margin-bottom:3px">Alternative Services</div><ul style="margin:0;padding-left:14px;font-size:0.7rem;line-height:1.5">${alts.map(a=>`<li>${esc(a.service+' ('+Math.round(a.score)+'%)')}</li>`).join('')}</ul>`:''}
    ${d.sid?`<hr><button class="ev-rec-btn" onclick="showSessionRecords(evSessions['${d.sid}'])"> View Records (${d.recs||'?'})</button><span style="float:right;font-size:0.6rem;color:var(--muted);padding-top:6px">${evidenceHash({serviceLabel:d.svc||'',evidence:d.ev?d.ev.split(','):[],duration:d.dur||0,records:d.recs||0})}</span>`:''}
  `;
  tip.onmouseenter=()=>{clearTimeout(tip._hideTimer);tip._hovering=true;tip.style.display='block'};
  tip.onmouseleave=()=>{tip._hovering=false;tip.style.display='none'};
  tip.style.display='block';
  positionGanttTip(el);
}
function scheduleHideGanttTip(){
  const tip=document.getElementById('ganttTooltip');
  if(!tip)return;
  tip._hovering=false;
  clearTimeout(tip._hideTimer);
  tip._hideTimer=setTimeout(()=>{
    if(!tip._hovering)tip.style.display='none';
  },200);
}
function hideGanttTip(){
  const tip=document.getElementById('ganttTooltip');
  if(tip){clearTimeout(tip._hideTimer);tip.style.display='none'}
}
function positionGanttTip(el){
  const tip=document.getElementById('ganttTooltip');
  if(!tip||tip.style.display==='none')return;
  const rect=el.getBoundingClientRect();
  const tr=tip.getBoundingClientRect();
  const gap=2;
  let left=rect.right+gap;
  let top=rect.top;
  // Flip to left side if tooltip overflows right edge
  if(left+tr.width>window.innerWidth-5)left=rect.left-tr.width-gap;
  // Flip below if overflows bottom
  if(top+tr.height>window.innerHeight-5)top=window.innerHeight-tr.height-5;
  if(top<0)top=rect.bottom+gap;
  tip.style.left=Math.round(left)+'px';
  tip.style.top=Math.round(top)+'px';
}

// ====== AI INSIGHTS ======

function buildDataPackage(){
  if(!state.data.records.length)return'No records loaded.';
  const lines=[];
  const subs=new Set();state.data.records.forEach(r=>{if(r.sub)subs.add(r.sub);if(r.cnt)subs.add(r.cnt)});
  const ts=state.data.records.filter(r=>r.ts).map(r=>+new Date(r.ts));
  lines.push('Records: '+(_totalCdrFn()+_totalIpdrFn())+' ('+_totalCdrFn()+' CDR, '+_totalIpdrFn()+' IPDR)');
  lines.push('Period: '+(ts.length?new Date(Math.min(...ts)).toISOString().slice(0,10)+' -> '+new Date(Math.max(...ts)).toISOString().slice(0,10):'?'));
  lines.push('Entities: '+subs.size);
  const svcC={};state.data.records.forEach(r=>{const s=r.svc||'?';svcC[s]=(svcC[s]||0)+1});
  lines.push('Services: '+Object.entries(svcC).sort((a,b)=>b[1]-a[1]).slice(0,8).map(s=>s[0]+'('+s[1]+')').join(', '));
  const cntC={};state.data.records.forEach(r=>{if(r.cnt)cntC[r.cnt]=(cntC[r.cnt]||0)+1});
  lines.push('Top contacts: '+Object.entries(cntC).sort((a,b)=>b[1]-a[1]).slice(0,8).map(c=>c[0]+'('+c[1]+')').join(', '));
  const towC={};state.data.records.forEach(r=>{if(r.tow)towC[r.tow]=(towC[r.tow]||0)+1});
  lines.push('Top towers: '+Object.entries(towC).sort((a,b)=>b[1]-a[1]).slice(0,6).map(t=>t[0]+'('+t[1]+')').join(', '));
  const edg={};state.data.records.forEach(r=>{if(r.sub&&r.cnt){const k=[r.sub,r.cnt].sort().join('|');edg[k]=(edg[k]||0)+1}});
  lines.push('Top links: '+Object.entries(edg).sort((a,b)=>b[1]-a[1]).slice(0,6).map(e=>e[0].replace('|','<->')+'x'+e[1]).join(', '));
  const dirs={i:0,o:0};state.data.records.forEach(r=>{if(r.dir==='MT')dirs.i++;else if(r.dir==='MO')dirs.o++});
  const dTot=dirs.i+dirs.o||1;lines.push('Direction: '+Math.round(dirs.i/dTot*100)+'% in / '+Math.round(dirs.o/dTot*100)+'% out');
  const durs=state.data.records.filter(r=>r.dur!=null).map(r=>r.dur);
  if(durs.length)lines.push('Duration: avg '+Math.round(durs.reduce((s,v)=>s+v,0)/durs.length)+'s, max '+Math.max(...durs)+'s');
  const hrs=Array(24).fill(0);state.data.records.forEach(r=>{if(r.ts)hrs[new Date(r.ts).getHours()]++});
  const peakIdx=hrs.indexOf(Math.max(...hrs));lines.push('Peak hour: '+peakIdx+':00 ('+Math.max(...hrs)+' records)');
  const night=hrs.slice(0,6).concat(hrs.slice(20)).reduce((s,v)=>s+v,0);
  const day=hrs.slice(6,20).reduce((s,v)=>s+v,0);const tot=night+day||1;
  lines.push('Night activity: '+Math.round(night/tot*100)+'%');
  const protC={};state.data.records.filter(r=>r.type==='IPDR'&&r.prot).forEach(r=>{protC[r.prot]=(protC[r.prot]||0)+1});
  const p=Object.entries(protC).sort((a,b)=>b[1]-a[1]);if(p.length)lines.push('Protocols: '+p.slice(0,5).map(x=>x[0]+'('+x[1]+')').join(', '));

  // Sessions
  const sLines=[];
  const entList=[...subs].slice(0,20);
  entList.forEach(e=>{
    reconstructSessions(e).forEach(s=>{
      sLines.push(e+'|'+(s.serviceLabel||s.primary?.service||s.service||'')+'|'+(s.activityLabel||s.primary?.activity||s.activity||'')+'|'+Math.round(s.serviceConfidence)+'%|'+s.duration+'s');
    });
  });
  if(sLines.length)lines.push('Sessions ('+sLines.length+'): '+sLines.join('; '));

  return lines.join('\n');
}

function buildCsvDump(){
  if(!state.data.records.length)return '';
  const cdr=state.data.records.filter(r=>r.type==='CDR').slice(-500);
  const ipdr=state.data.records.filter(r=>r.type==='IPDR').slice(-500);
  const ts=(r)=>r.ts?Math.round(new Date(r.ts).getTime()/1000):'';
  const lines=['=== CDR ('+cdr.length+') ==='];
  lines.push('ts|sub|cnt|tow|dur|dir|svc');
  cdr.forEach(r=>lines.push([ts(r),r.sub,r.cnt,r.tow,r.dur,r.dir,r.svc].join('|')));
  lines.push('=== IPDR ('+ipdr.length+') ===');
  lines.push('ts|sub|cnt|prot|sport|dport|svc|tow|cell|up|dn');
  ipdr.forEach(r=>lines.push([ts(r),r.sub,r.cnt,r.prot,r.sport,r.dport,r.svc,r.tow,r.cell,r.bytesUp,r.bytesDn].join('|')));
  return lines.join('\n');
}

function renderAiInsights(){
  if(!state.data.records.length){
    document.getElementById('aiBody')&&(document.getElementById('aiBody').innerHTML='<p style="color:var(--muted);text-align:center;padding:20px">No data loaded. Upload CDR/IPDR files first.</p>');
    return;
  }
  if(!tabNeedsRender('ai'))return;
  state.scenario=document.getElementById('scenarioTag')?.value||'adhoc';
  // Do NOT call invalidateAiCache() here — cache is populated lazily and only cleared on
  // case load (state.render.gen change). Clearing on every tab switch re-scans 50k rows each time.
  buildCaseSummary(); // SECTION A: Why This Case Matters
  buildCaseOverview();
  buildAIFindings();
  buildInvestigationLeads();
  buildTimelineNarrative();
  buildSubjectSummaries();
  buildInvestigationQuestions();
  initContextChips();
  switchAiTab('overview');
  initAiTabs();
  tabMarkRendered('ai');
}
function switchAiTab(tab){
  document.querySelectorAll('.ai-tab-panel').forEach(p=>p.classList.toggle('active',p.dataset.aiPanel===tab));
  document.querySelectorAll('.ai-subtab').forEach(b=>b.classList.toggle('active',b.dataset.aiTab===tab));
}
function initAiTabs(){
  document.querySelectorAll('.ai-subtab').forEach(b=>{
    b.onclick=()=>switchAiTab(b.dataset.aiTab);
  });
}
function buildCaseSummary(){
  const container=document.getElementById('aiCaseOverview');if(!container)return;
  const c=getAiCache();
  const topPair=Object.entries(c.pairCounts).sort((a,b)=>b[1]-a[1])[0];
  const highMeets=c.allMeetings.filter(m=>m.gapLevel==='high');
  let hubSub=null,maxDeg=0;
  const degMap={};state.data.records.forEach(r=>{if(r.sub)degMap[r.sub]=(degMap[r.sub]||0)+1;if(r.cnt)degMap[r.cnt]=(degMap[r.cnt]||0)+1});
  Object.entries(degMap).forEach(([s,d])=>{if(d>maxDeg){maxDeg=d;hubSub=s}});
  const topPairParts=topPair?topPair[0].split('|'):null;
  let html='<h3 class="ai-section-title">Case Overview</h3><div class="ai-summary">';
  html+='<div><strong>Scope:</strong> '+c.subCount+' subjects, '+c.totalRows+' records across observation period.</div>';
  if(topPair)html+='<div><strong>Key Link:</strong> <span style="color:var(--accent);cursor:pointer" onclick="showProfile(\''+esc(topPairParts[0])+'\')">'+esc(topPairParts[0])+'</span> ? <span style="color:var(--accent);cursor:pointer" onclick="showProfile(\''+esc(topPairParts[1])+'\')">'+esc(topPairParts[1])+'</span> — '+topPair[1]+' interactions (highest volume).</div>';
  if(highMeets.length)html+='<div><strong>Meetings:</strong> '+highMeets.length+' high-confidence co-location events detected.</div>';
  if(hubSub)html+='<div><strong>Central Hub:</strong> <span style="color:var(--accent);cursor:pointer" onclick="showProfile(\''+esc(hubSub)+'\')">'+esc(hubSub)+'</span> appears to coordinate activity across '+maxDeg+' interactions.</div>';
  if(topPair&&highMeets.length){html+='<div class="ai-summary-bottom">Most significant finding: <strong>'+esc(topPairParts[0])+'</strong> and <strong>'+esc(topPairParts[1])+'</strong> show the highest communication volume'+(hubSub&&hubSub!==topPairParts[0]&&hubSub!==topPairParts[1]?', while <strong>'+esc(hubSub)+'</strong> acts as a hub bridging otherwise separate groups':'')+'.</div>';}
  html+='</div><div class="ai-overview-grid" id="aiOverviewGrid"></div><div id="fbExportArea" style="margin-top:8px;display:none;gap:6px;align-items:center;font-size:0.68rem"><span id="fbCount" style="color:var(--muted)"></span><button class="btn btn-sm" onclick="exportFeedback()" style="font-size:0.62rem;padding:2px 8px">Export Feedback</button></div>';
  container.innerHTML=html;
}
function buildCaseOverview(){
  const g=document.getElementById('aiOverviewGrid');if(!g)return;
  const total=_totalCdrFn()+_totalIpdrFn(),totalCdr=_totalCdrFn(),totalIpdr=_totalIpdrFn();
  const subs=new Set();state.data.records.forEach(r=>{if(r.sub)subs.add(r.sub);if(r.cnt)subs.add(r.cnt)});
  const ts=state.data.records.filter(r=>r.ts).map(r=>+new Date(r.ts));
  const span=ts.length?Math.round((ts.reduce((a,b)=>a>b?a:b,-Infinity)-ts.reduce((a,b)=>a<b?a:b,Infinity))/86400000):0;
  let meetings=0;try{meetings=meetingTotals().total}catch(e){}
  const sessions=state.subjects.reduce((sum,s)=>sum+reconstructSessions(s).length,0);
  let simSwaps=0,deviceChanges=0;
  state.subjects.slice(0,20).forEach(s=>{const c=buildIdentityProfile(s).changes;simSwaps+=c.filter(x=>x.type==='sim_swap').length;deviceChanges+=c.filter(x=>x.type==='device_change').length});
  const highRisk=Math.min(meetings+simSwaps+deviceChanges+Math.round(subs.size/10),99);
  const cards=[
    {v:subs.size,l:'Subjects',cls:''},{v:total,l:'Records',cls:''},
    {v:sessions,l:'Sessions',cls:''},{v:meetings,l:'Meetings',cls:meetings>5?'ai-ov-warn':''},
    {v:simSwaps,l:'SIM Swaps',cls:simSwaps?'ai-ov-warn':''},{v:deviceChanges,l:'Device Changes',cls:deviceChanges?'ai-ov-warn':''},
    {v:span+'d',l:'Observation Period',cls:''},{v:highRisk,l:'High-Risk Findings',cls:highRisk>5?'ai-ov-warn':'ai-ov-ok'}
  ];
  g.innerHTML=cards.map(c=>`<div class="ai-ov-card ${c.cls}"><div class="ai-ov-val">${c.v}</div><div class="ai-ov-label">${c.l}</div></div>`).join('');
}
function buildAIFindings(){
  const body=document.getElementById('aiFindingsBody');if(!body)return;
  const c=getAiCache();
  const findings=[];
  // HIGH: most contacted pairs
  const topPair=Object.entries(c.pairCounts).sort((a,b)=>b[1]-a[1])[0];
  if(topPair&&topPair[1]>10){
    const cb=confidenceBreakdown(50,[{label:'Volume > 10 interactions',value:20},{label:'Highest in dataset',value:15},{label:'Direct communication link',value:10}]);
    findings.push({level:'high',icon:'',title:topPair[0].split('|').join(' ↔ ')+' — '+topPair[1]+' interactions',desc:'Highest communication volume in the dataset',ev:'Volume: '+topPair[1]+' records',components:cb});
  }
  // HIGH: meetings
  const highMeets=c.allMeetings.filter(m=>m.gapLevel==='high');
  if(highMeets.length){
    const topM=highMeets[0];
    const cb=confidenceBreakdown(40,[{label:'Same tower',value:20},{label:'Tight time window ('+topM.gap+'m)',value:15},{label:'Repeated '+topM.encounterCount+' times',value:10},{label:'Movement similarity',value:topM.evidence.some(e=>e.includes('Movement similarity'))?10:0}]);
    findings.push({level:'high',icon:'',title:highMeets.length+' probable meeting'+(highMeets.length>1?'s':'')+' detected',desc:'Co-location events with tight time windows',ev:'Base: 40 + Same tower: 20 + Time window: 15 + Repeated: '+(topM.encounterCount>1?'15':'0')+' = '+cb.total+'%',components:cb});
  }
  // HIGH: activity spikes (z-score based)
  const spikes=findSpikes(c.subDays);
  const topSpike=spikes[0];
  if(topSpike){
    const cb=confidenceBreakdown(30,[{label:'Z-score: '+topSpike.zScore.toFixed(1)+' (>2.5 threshold)',value:25},{label:'Volume: '+topSpike.count+' records (=20 min)',value:20},{label:'Baseline: '+Math.round(topSpike.avg)+' avg/day',value:15},{label:'Anomaly: +'+topSpike.pct+'%',value:10}]);
    findings.push({level:'high',icon:'',title:'Activity spike on '+esc(topSpike.day)+' (+'+topSpike.pct+'%)',desc:esc(topSpike.sub)+' had '+topSpike.count+' records (z='+topSpike.zScore.toFixed(1)+', baseline '+Math.round(topSpike.avg)+'/day)',ev:'Z-score: '+topSpike.zScore.toFixed(1)+' (threshold 2.5); Baseline: '+Math.round(topSpike.avg)+' records/day; Spike: '+topSpike.count+' records',components:cb});
  }
  // MEDIUM: night activity
  const nightSubs=[];state.subjects.forEach(s=>{const rows=rowsFor(s).filter(r=>r.ts);const night=rows.filter(r=>{const h=new Date(r.ts).getHours();return h>=23||h<5});if(rows.length>5&&night.length/rows.length>0.5)nightSubs.push({sub:s,pct:Math.round(night.length/rows.length*100),nightCount:night.length,total:rows.length})});
  nightSubs.sort((a,b)=>b.pct-a.pct).slice(0,3).forEach(ns=>{
    const cb=confidenceBreakdown(30,[{label:'Night records: '+ns.nightCount+' ('+ns.pct+'%)',value:20},{label:'Total records: '+ns.total,value:15}]);
    findings.push({level:'med',icon:'',title:esc(ns.sub)+' — '+ns.pct+'% night activity',desc:ns.nightCount+' of '+ns.total+' records during 23:00-05:00',ev:'Base: 30 + Night proportion: 20 + Volume: 15 = '+cb.total+'%',components:cb});
  });
  // MEDIUM: top services
  const topSvcs=Object.entries(c.svcCounts).sort((a,b)=>b[1]-a[1]).slice(0,3);
  topSvcs.forEach(([s,vol])=>{
    const cb=confidenceBreakdown(25,[{label:'Volume: '+vol+' records',value:20},{label:'Share: '+Math.round(vol/c.totalRows*100)+'% of total',value:10}]);
    findings.push({level:'med',icon:'',title:'Heavy '+esc(s)+' usage — '+vol+' records',desc:esc(s)+' accounts for '+Math.round(vol/c.totalRows*100)+'% of all traffic',ev:'Base: 25 + Volume: 20 + Share: 10 = '+cb.total+'%',components:cb});
  });
  // LOW: tower transitions
  const towerMovements={};state.subjects.forEach(s=>{const rows=rowsFor(s).filter(r=>r.ts&&r.tow).sort((a,b)=>new Date(a.ts)-new Date(b.ts));let moves=0;for(let i=1;i<rows.length;i++){if(rows[i].tow!==rows[i-1].tow)moves++}if(moves>10)towerMovements[s]=moves});
  Object.entries(towerMovements).sort((a,b)=>b[1]-a[1]).slice(0,3).forEach(([s,m])=>{
    findings.push({level:'low',icon:'',title:esc(s)+' — '+m+' tower transitions',desc:'Frequent movement across '+new Set(rowsFor(s).filter(r=>r.tow).map(r=>r.tow)).size+' towers',ev:'Tower changes: '+m});
  });
  // LOW: dormant subjects
  state.subjects.forEach(s=>{const times=rowsFor(s).filter(r=>r.ts).map(r=>new Date(r.ts)).sort((a,b)=>a-b);if(times.length<5)return;let maxGap=0;for(let i=1;i<times.length;i++){const g=(times[i]-times[i-1])/3600000;if(g>maxGap)maxGap=g}if(maxGap>168)findings.push({level:'low',icon:'',title:esc(s)+' has '+Math.round(maxGap/24)+'d dormant period',desc:'No activity for over '+(maxGap>336?'2 weeks':'1 week'),ev:'Max inactivity gap: '+Math.round(maxGap/24)+' days'});});
  if(!findings.length){body.innerHTML='<p style="color:var(--muted);font-size:0.75rem">Insufficient data to generate findings.</p>';return}
  findings.forEach(f=>f._hash=findingHash(f));
  body.innerHTML='<div class="ai-findings-list">'+findings.map((f,i)=>`<div class="ai-finding ai-finding-${f.level}" onclick="toggleFindingDetail(${i})">
    <div class="ai-finding-body">
      <div class="ai-finding-title">${f.title}</div>
      <div class="ai-finding-desc">${f.desc}</div>
      <div class="ai-finding-ev" id="aiFindEv${i}" style="display:none">
        ${f.components?`<div style="margin-bottom:4px;padding-bottom:4px;border-bottom:1px solid var(--line)"><strong>Confidence: ${f.components.total}%</strong></div>
        <div>Base: ${f.components.baseScore}</div>
        ${f.components && f.components.components ? f.components.components.map(c=>`<div>+ ${c.label}: ${c.value>0?'+'+c.value:c.value}</div>`).join('') : ''}
        <div style="margin-top:2px;padding-top:2px;border-top:1px solid var(--line)"><strong>= ${f.components.total}%</strong></div><br>`:''}
        &#x2713; ${f.ev}
        <div style="margin-top:4px;display:flex;gap:4px;font-size:0.65rem">
          <span style="color:var(--muted);font-size:0.6rem;flex:1">Is this finding useful?</span>
          <button data-fbh="${f._hash}" data-v="useful" class="btn btn-sm" onclick="event.stopPropagation();markFinding('${esc(state.scenario||'unknown')}','${f._hash}','useful')" style="padding:1px 5px;font-size:0.6rem">&#x2713; Useful</button>
          <button data-fbh="${f._hash}" data-v="noise" class="btn btn-sm" onclick="event.stopPropagation();markFinding('${esc(state.scenario||'unknown')}','${f._hash}','noise')" style="padding:1px 5px;font-size:0.6rem">&#x2717; False Positive</button>
        </div>
      </div>
    </div>
  </div>`).join('')+'</div>';
  window._aiFindings=findings;
  // Restore persisted FP feedback for these findings
  findings.forEach((f,i)=>{
    const hash=f._hash;
    const saved=localStorage.getItem('fp_'+hash);
    if(saved){
      const fb=JSON.parse(saved);
      document.querySelectorAll(`[data-fbh="${hash}"]`).forEach(b=>{
        b.style.opacity=b.dataset.v===fb.verdict?'1':'0.3';
        b.style.background=b.dataset.v===fb.verdict?'var(--accent)':'';
      });
    }
  });
}
// -- False-Positive Tracking --
function findingHash(f){
  const str =
    (f.title || '') +
    '|' +
    (f.ev || '');

  let hash = 0;

  for(let i = 0; i < str.length; i++){
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }

  return 'F' + Math.abs(hash).toString(36);
}
function markFinding(scenario,hash,verdict){
  const fb={verdict,time:new Date().toISOString()};
  localStorage.setItem('fp_'+hash,JSON.stringify(fb));
  document.querySelectorAll(`[data-fbh="${hash}"]`).forEach(b=>{
    b.style.opacity=b.dataset.v===verdict?'1':'0.3';
    b.style.background=b.dataset.v===verdict?'var(--accent)':'';
  });
  const total=document.querySelectorAll('[data-fbh]').length;
  const marked=Object.keys(localStorage).filter(k=>k.startsWith('fp_')).length;
  const fbExport=document.getElementById('fbExportArea');const fbCount=document.getElementById('fbCount');
  if(fbExport)fbExport.style.display='flex';
  if(fbCount)fbCount.textContent='Feedback recorded: '+marked+' findings marked';
  console.log('[FP-TRACK]',scenario,hash,verdict);
}
function exportFeedback(){
  const data={};
  Object.keys(localStorage).filter(k=>k.startsWith('fp_')).forEach(k=>{data[k]=JSON.parse(localStorage.getItem(k))});
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='finding_feedback.json';a.click();
}
function toggleFindingDetail(i){
  const el=document.getElementById('aiFindEv'+i);
  if(el)el.style.display=el.style.display==='none'?'block':'none';
}
// Spatiotemporal Inferences tab (renderInferences + watchlist bar + buildInferenceHtml) -> analytics/inferences.js

function buildInvestigationLeads(){
  const g=document.getElementById('aiLeadsGrid');if(!g)return;
  const c=getAiCache();
  const leads=[];
  // Lead: most contacted subject (score: pair volume / max * 100)
  const topPair=Object.entries(c.pairCounts).sort((a,b)=>b[1]-a[1])[0];
  if(topPair){const maxV=topPair[1];const [a,b]=topPair[0].split('|');leads.push({score:Math.min(95,60+Math.round(topPair[1]/Math.max(...Object.values(c.pairCounts),1)*30)),title:'Investigate '+esc(b),reason:'Highest communication centrality ('+topPair[1]+' interactions)',action:'Show Profile',onclick:'showProfile(\''+esc(b)+'\')'})}
  // Lead: meeting cluster (score: based on count and confidence)
  const highMeets=c.allMeetings.filter(m=>m.gapLevel==='high');
  if(highMeets.length){const m=highMeets[0];leads.push({score:Math.min(90,50+m.score/2),title:'Review Meeting Cluster',reason:m.encounterCount+' co-location events between '+esc(m.subA)+' & '+esc(m.subB),action:'Switch to Timeline',onclick:"switchTab('timeline')"})}
  // Lead: SIM swap (score: 70-85 based on confidence)
  let leadSwap=null;state.subjects.slice(0,20).forEach(s=>{const ch=c.changeCache[s]||[];const sw=ch.filter(x=>x.type==='sim_swap');if(sw.length&&!leadSwap)leadSwap={sub:s,count:sw.length,conf:sw[0].confidence}});
  if(leadSwap)leads.push({score:leadSwap.conf==='high'?82:65,title:'Examine New SIM on '+esc(leadSwap.sub),reason:leadSwap.count+' SIM swap'+(leadSwap.count>1?'s':'')+' detected',action:'View Profile',onclick:'showProfile(\''+esc(leadSwap.sub)+'\')'});
  // Lead: device change
  let leadDev=null;state.subjects.slice(0,20).forEach(s=>{const ch=c.changeCache[s]||[];const dc=ch.filter(x=>x.type==='device_change');if(dc.length&&!leadDev)leadDev={sub:s,count:dc.length,conf:dc[0].confidence}});
  if(leadDev)leads.push({score:leadDev.conf==='high'?78:60,title:'Review Device Change on '+esc(leadDev.sub),reason:leadDev.count+' IMEI change'+(leadDev.count>1?'s':'')+' detected',action:'View Profile',onclick:'showProfile(\''+esc(leadDev.sub)+'\')'});
  // Lead: heavy night activity
  const nightSubs=[];state.subjects.forEach(s=>{const rows=rowsFor(s).filter(r=>r.ts);const night=rows.filter(r=>{const h=new Date(r.ts).getHours();return h>=23||h<5});if(rows.length>5&&night.length/rows.length>0.6)nightSubs.push({sub:s,pct:Math.round(night.length/rows.length*100)})});
  nightSubs.sort((a,b)=>b.pct-a.pct).slice(0,2).forEach(ns=>{leads.push({score:40+ns.pct/2,title:'Investigate Night Activity of '+esc(ns.sub),reason:ns.pct+'% of activity during late-night hours',action:'View Profile',onclick:'showProfile(\''+esc(ns.sub)+'\')'})});
  if(!leads.length){g.innerHTML='<p style="color:var(--muted);font-size:0.75rem;grid-column:1/-1">No leads generated yet.</p>';return}
  leads.sort((a,b)=>b.score-a.score);
  g.innerHTML=leads.slice(0,8).map(l=>`<div class="ai-lead" onclick="${l.onclick}">
    <div class="ai-lead-title" style="display:flex;gap:4px"><span class="ai-lead-score" style="font-size:0.62rem;color:${l.score>=80?'var(--danger)':l.score>=60?'var(--warn)':'var(--muted)'};font-weight:700">[${l.score}]</span> ${l.title}</div>
    <div class="ai-lead-reason">${l.reason}</div>
    <div class="ai-lead-action">${l.action} ?</div>
  </div>`).join('');
}
function buildTimelineNarrative(){
  const body=document.getElementById('aiNarrativeBody');if(!body)return;
  const subRank=state.subjects.map(s=>[s,state.data.records.filter(r=>r.sub===s||r.cnt===s).length]).sort((a,b)=>b[1]-a[1]);
  if(!subRank.length){body.innerHTML='<p style="color:var(--muted);font-size:0.75rem">No subjects with activity data.</p>';return}
  const selected=state._aiNarrativeSub||subRank[0][0];
  const topSub=state.subjects.includes(selected)?selected:subRank[0][0];
  const rows=rowsFor(topSub).filter(r=>r.ts).sort((a,b)=>new Date(a.ts)-new Date(b.ts));
  if(rows.length<3){body.innerHTML='<p style="color:var(--muted);font-size:0.75rem">Insufficient activity data for narrative.</p>';return}
  const sessions=reconstructSessions(topSub);
  const meetings=detectMeetings({subject:topSub,maxResults:10});
  // Build compressed day-grouped narrative (group consecutive same-type events into blocks)
  const dayGroups={};let lastTow=null,lastType=null,blockStart=null,blockEnd=null,blockCount=0,blockText=[];
  const flushBlock=(day)=>{
    if(!blockStart||!blockCount)return;
    const range=blockStart===blockEnd?blockStart:'<span style="color:var(--muted)">'+blockStart+'</span>—<span style="color:var(--muted)">'+blockEnd+'</span>';
    const summary=blockCount>1?` (—${blockCount})`:'';
    dayGroups[day].push({time:range,text:blockText.join('; ')+summary,dot:'var(--accent)',type:lastType});
    blockStart=null;blockEnd=null;blockCount=0;blockText=[];lastType=null;
  };
  rows.forEach(r=>{
    const t=new Date(r.ts);const day=t.toLocaleDateString();const time=t.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    if(!dayGroups[day])dayGroups[day]=[];
    let type='';
    if(r.type==='CDR')type='call';
    else if(r.svc)type=r.svc;
    else type='ipdr';
    // If same type and close in time, group into block
    if(type===lastType&&blockCount>0){blockEnd=time;blockCount++}
    else{
      flushBlock(day);
      blockStart=time;blockEnd=time;blockCount=1;lastType=type;
      if(r.type==='CDR')blockText=[(r.dir||'')+' call with '+(r.cnt||'unknown')];
      else if(r.svc)blockText=[esc(r.svc)+' session'];
      else blockText=['IPDR activity'];
    }
    if(r.tow&&r.tow!==lastTow&&lastTow){
      flushBlock(day);
      dayGroups[day].push({time,text:'Tower change ? '+esc(r.tow),dot:'var(--warn)',type:'tower'});
    }
    if(r.tow)lastTow=r.tow;
  });
  // Flush remaining block
  const lastDay=Object.keys(dayGroups).pop();
  if(lastDay)flushBlock(lastDay);
  // Add sessions and meetings
  sessions.forEach(s=>{if(s.start&&s.duration){
    const t=new Date(s.start);const day=t.toLocaleDateString();const time=t.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    const svc=s.primary?s.primary.service:(s.service||'');
    if(svc&&dayGroups[day]){const dur=s.duration>=3600?Math.round(s.duration/60)+'m':s.duration+'s';dayGroups[day].push({time,text:'Long session: '+esc(svc)+' ('+dur+')',dot:'var(--success)',type:'session'})}
  }});
  meetings.forEach(m=>{if(!m.time)return;
    const t=new Date(m.time);const day=t.toLocaleDateString();const time=t.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    if(dayGroups[day])dayGroups[day].push({time,text:'Meeting: '+esc(m.subB)+' at '+esc(m.tow),dot:'var(--danger)',type:'meeting'});
  });
  // Sort each day's events by time
  Object.keys(dayGroups).forEach(d=>dayGroups[d].sort((a,b)=>a.time.localeCompare(b.time)));
  const days=Object.keys(dayGroups).sort((a,b)=>new Date(a)-new Date(b));
  const baseDate=days.length?new Date(days[0]):null;
  // Subject selector + narrative header
  let html='<div class="ai-narr-head"><select class="ai-narr-select" onchange="switchNarrativeSubject(this.value)">'+subRank.slice(0,30).map(([s])=>'<option value="'+esc(s)+'"'+(s===topSub?' selected':'')+'>'+esc(s)+' ('+state.data.records.filter(r=>r.sub===s||r.cnt===s).length+' records)</option>').join('')+'</select></div>';
  html+='<div class="ai-narrative">'+days.slice(0,7).map(d=>{
    const dt=new Date(d);const rel=baseDate?'Day '+Math.round((dt-baseDate)/86400000+1):d;
    return `<div class="ai-narr-day">${rel} — ${d}</div>
      ${dayGroups[d].slice(0,12).map(e=>`<div class="ai-narr-event"><span class="ai-narr-time">${e.time}</span><span class="ai-narr-dot" style="background:${e.dot}"></span><span class="ai-narr-text" title="${esc(e.text)}">${esc(e.text)}</span></div>`).join('')}`;
  }).join('')+'</div>';
  body.innerHTML=html;
}
function switchNarrativeSubject(sub){
  state._aiNarrativeSub=sub;
  buildTimelineNarrative();
}
function buildSubjectSummaries(){
  const g=document.getElementById('aiSubjGrid');if(!g)return;
  const c=getAiCache();
  const sorted=state.subjects.map(s=>{
    const rows=rowsFor(s);const contacts=new Set();let towerCount=0,nightCount=0,dayCount=0;
    rows.forEach(r=>{if(r.cnt&&r.cnt!==s)contacts.add(r.cnt);if(r.tow)towerCount++;if(r.ts){const h=new Date(r.ts).getHours();if(h>=23||h<5)nightCount++;else dayCount++}});
    const topSvc=Object.entries(rows.reduce((a,r)=>{const sv=r.svc||'Unknown';a[sv]=(a[sv]||0)+1;return a},{}),).sort((a,b)=>b[1]-a[1])[0];
    const meetings=detectMeetings({subject:s,maxResults:50});
    const changes=c.changeCache[s]||[];
    const nightPct=nightCount+dayCount?Math.round(nightCount/(nightCount+dayCount)*100):0;
    // Build descriptive characteristics (not risk labels)
    const chars=[];
    if(meetings.length>3)chars.push('Multiple co-location events ('+meetings.length+')');
    if(nightPct>60)chars.push('Night-dominant activity ('+nightPct+'%)');
    if(contacts.size>15)chars.push('High communication volume ('+contacts.size+' contacts)');
    if(changes.filter(x=>x.type==='sim_swap').length)chars.push('SIM change detected');
    if(changes.filter(x=>x.type==='device_change').length)chars.push('Device change detected');
    if(towerCount>20)chars.push('High mobility ('+towerCount+' tower visits)');
    const topSvcName=topSvc?topSvc[0]:'n/a';
    if(topSvcName!=='n/a'&&topSvc&&topSvc[1]>10)chars.push('Primary service: '+topSvcName);
    const assessment=chars.length?chars.join(' — '):'Limited data available';
    return{s,contacts:contacts.size,tower:towerCount,nightPct,topSvc:topSvcName,meetings:meetings.length,simSwaps:changes.filter(c=>c.type==='sim_swap').length,deviceChanges:changes.filter(c=>c.type==='device_change').length,assessment,contactCount:contacts.size};
  }).sort((a,b)=>b.meetings*3+b.nightPct-(a.meetings*3+a.nightPct));
  if(!sorted.length){g.innerHTML='<p style="color:var(--muted);font-size:0.75rem;grid-column:1/-1">No subjects loaded.</p>';return}
  g.innerHTML=sorted.slice(0,12).map(s=>`<div class="ai-subj-card" onclick="showProfile('${esc(s.s)}')">
    <div class="ai-subj-name" onclick="event.stopPropagation();showProfile('${esc(s.s)}')">${esc(s.s)}</div>
    <div class="ai-subj-row"><span class="ai-subj-label">Contacts</span><span class="ai-subj-val">${s.contacts}</span></div>
    <div class="ai-subj-row"><span class="ai-subj-label">Top Service</span><span class="ai-subj-val">${esc(s.topSvc)}</span></div>
    <div class="ai-subj-row"><span class="ai-subj-label">Night Activity</span><span class="ai-subj-val">${s.nightPct}%</span></div>
    <div class="ai-subj-row"><span class="ai-subj-label">Meetings</span><span class="ai-subj-val">${s.meetings}</span></div>
    <div class="ai-subj-row"><span class="ai-subj-label">SIM Swaps</span><span class="ai-subj-val" style="color:${s.simSwaps?'var(--warn)':''}">${s.simSwaps}</span></div>
    <div class="ai-subj-row"><span class="ai-subj-label">Device Changes</span><span class="ai-subj-val" style="color:${s.deviceChanges?'var(--warn)':''}">${s.deviceChanges}</span></div>
    <div class="ai-subj-assessment">${s.assessment}</div>
  </div>`).join('');
}
function buildInvestigationQuestions(){
  const body=document.getElementById('aiQuestionsBody');if(!body)return;
  const c=getAiCache();
  const questions=[];
  // Q1: Activity spikes (using z-score)
  const spikes=findSpikes(c.subDays);
  const topSpike=spikes[0];
  if(topSpike)questions.push({q:'Why did activity spike on '+esc(topSpike.day)+' for '+esc(topSpike.sub)+' (z='+topSpike.zScore.toFixed(1)+', +'+topSpike.pct+'%)?',ctx:'activity spike'});
  // Q2: IMEI/IMSI changes
  const allChanges=[];state.subjects.forEach(s=>{(c.changeCache[s]||[]).forEach(ch=>allChanges.push({...ch,sub:s}))});
  const lastChange=allChanges.sort((a,b)=>b.time-a.time)[0];
  if(lastChange)questions.push({q:'Why did '+esc(lastChange.sub)+' '+(lastChange.type==='sim_swap'?'change SIM':'switch device')+' '+esc(lastChange.from)+' — '+esc(lastChange.to)+' on '+lastChange.time.toLocaleDateString()+'?',ctx:'identity change'});
  // Q3: Shared contacts without direct communication
  const contactOverlaps=[];const subs=state.subjects.slice(0,20);
  for(let i=0;i<subs.length;i++){for(let j=i+1;j<subs.length;j++){
    const a=rowsFor(subs[i]),b=rowsFor(subs[j]);
    const cntsA=new Set(a.map(r=>r.cnt).filter(Boolean));
    const cntsB=new Set(b.map(r=>r.cnt).filter(Boolean));
    const common=[...cntsA].filter(x=>cntsB.has(x)).filter(x=>x!==subs[i]&&x!==subs[j]);
    if(common.length>=5&&!a.some(r=>r.cnt===subs[j])&&!b.some(r=>r.cnt===subs[i]))contactOverlaps.push({a:subs[i],b:subs[j],count:common.length})}}
  contactOverlaps.sort((a,b)=>b.count-a.count).slice(0,2).forEach(co=>{questions.push({q:'Why do '+esc(co.a)+' and '+esc(co.b)+' share '+co.count+' contacts but never communicate directly?',ctx:'hidden link'})});
  // Q4: New service
  if(state.subjects.length){const sub=state.subjects[0];const rows=rowsFor(sub).filter(r=>r.svc).sort((a,b)=>new Date(a.ts)-new Date(b.ts));if(rows.length>10){const svcDays={};rows.forEach(r=>{const svc=r.svc;const d=new Date(r.ts);if(!svcDays[svc])svcDays[svc]={first:d,last:d};if(d<svcDays[svc].first)svcDays[svc].first=d;if(d>svcDays[svc].last)svcDays[svc].last=d});const newestSvc=Object.entries(svcDays).sort((a,b)=>b[1].first-a[1].first)[0];if(newestSvc){const daysSince=Math.round((new Date()-newestSvc[1].first)/86400000);if(daysSince<30)questions.push({q:'Why did '+esc(sub)+' start using '+esc(newestSvc[0])+' on '+newestSvc[1].first.toLocaleDateString()+'?',ctx:'new service'})}}}
  // Q5: Night activity
  const nightSubs=[];state.subjects.forEach(s=>{const rows=rowsFor(s).filter(r=>r.ts);const night=rows.filter(r=>{const h=new Date(r.ts).getHours();return h>=23||h<5});if(rows.length>10&&night.length/rows.length>0.5)nightSubs.push({sub:s,pct:Math.round(night.length/rows.length*100)})});
  nightSubs.sort((a,b)=>b.pct-a.pct).slice(0,1).forEach(ns=>{questions.push({q:'Why is '+esc(ns.sub)+' predominantly active at night ('+ns.pct+'%)?',ctx:'night pattern'})});
  if(!questions.length){body.innerHTML='<p style="color:var(--muted);font-size:0.75rem">Insufficient data to generate investigation questions.</p>';return}
  body.innerHTML='<div class="ai-questions-list">'+questions.slice(0,8).map((q,i)=>`<div class="ai-question">
    <span class="ai-q-icon"></span>
    <span class="ai-q-text">${q.q}</span>
    <button class="ai-q-btn" onclick="chatWithContext('question_${i}')">Ask AI</button>
  </div>`).join('')+'</div>';
  window._aiQuestions=questions;
}
function initContextChips(){
  document.querySelectorAll('.ai-chip').forEach(chip=>{
    chip.onclick=()=>{chip.classList.toggle('active')};
  });
}
function getActiveContexts(){
  return[...document.querySelectorAll('.ai-chip.active')].map(c=>c.dataset.ctx);
}
async function chatWithContext(action){
  switchAiTab('chat');
  const input=document.getElementById('aiInvestigatorInput');if(!input)return;
  const actions={};
  if(action&&action.startsWith('question_')){const idx=parseInt(action.split('_')[1]);const q=window._aiQuestions&&window._aiQuestions[idx];if(q){input.value=q.q}}
  else if(action==='explain-subject'){const topSub=state.subjects[0];if(topSub)input.value='Explain what we know about subject '+esc(topSub)+' and assess their role in the network.'}
  else if(action==='explain-meeting'){const allMeets=detectMeetings({allPairs:true});if(allMeets.length){const m=allMeets[0];input.value='Explain the meeting between '+esc(m.subA)+' and '+esc(m.subB)+' on '+m.time.toLocaleString()+'. What does the evidence show?'}}
  else if(action==='explain-tower'){const sub=state.subjects[0];if(sub){const rows=rowsFor(sub).filter(r=>r.tow&&r.ts).sort((a,b)=>new Date(a.ts)-new Date(b.ts));if(rows.length>2)input.value='Explain the tower movement pattern of '+esc(sub)+'. They visited '+esc(new Set(rows.map(r=>r.tow)).size)+' towers during the observation period.'}}
  else if(action==='explain-cluster'){input.value='Analyze the communication clusters in this network. Are there distinct groups or isolated subjects?'}
  else if(action==='explain-session'){const topSub=state.subjects[0];if(topSub){const s=reconstructSessions(topSub);if(s.length){const topSvc=s[0].primary?s[0].primary.service:(s[0].service||'');input.value='Explain the '+esc(topSvc)+' session detected for '+esc(topSub)+'. How confident is the attribution?'}}}
  if(action&&!input.value)return;
  analyzeWithAI();
}
async function generateAiReport(type){
  if(!state.data.records.length)return;
  const reportContent=document.getElementById('aiReportContent');
  if(!reportContent)return;
  reportContent.innerHTML='<em>Generating report...</em>';

  // TIFM Backend mode
  if(D.aiMode && D.aiMode.value==='tifm'){
    D.aiStatus.textContent='Generating via backend TIFM...';
    try{
      const r=await API.post('/ai/generate-report?report_type='+encodeURIComponent(type)+(state.data.caseId?'&case_id='+encodeURIComponent(state.data.caseId):''),{});
      reportContent.innerHTML=renderMd(r.report)||'[Empty]';
      D.aiStatus.textContent='Done.';
    }catch(e){
      console.error('TIFM error:',e);
      reportContent.innerHTML='<p style="color:var(--danger)">Error: '+esc(e.message)+'</p>';
      D.aiStatus.textContent='Error.';
    }
    return;
  }

  // Legacy Ollama mode
  const endpoint=D.aiEndpoint.value.trim()||'http://localhost:11434/api/generate';
  const model=D.aiModel.value.trim()||'gemma4:e4b';
  const pk=buildDataPackage();
  const csv=buildCsvDump();
  const prompts={
    executive:'Write an executive summary of this digital forensics investigation. Focus on: scope, key findings, risk assessment, and recommended next actions. Keep it concise (3-4 paragraphs).',
    subject:'Write a detailed subject-centric investigation report. For each subject, describe their role, communication patterns, service usage, mobility, and notable behaviors. Focus on actionable intelligence.',
    communication:'Write a communication analysis report. Describe the network structure, key communicators, communication patterns (time-of-day, frequency), and any hidden relationships detected.',
    location:'Write a location and mobility analysis report. Discuss tower usage patterns, movement paths, meeting point clusters, and temporal-spatial correlations between subjects.',
    full:'Write a comprehensive digital forensics investigation report covering: scope, entity analysis, communication patterns, service attribution breakdown, mobility analysis, meeting detection findings, timeline of key events, anomalies, conclusions, and recommendations.'
  };
  const prompt='Today is '+new Date().toLocaleString()+'. '+(prompts[type]||prompts.full)+'\n\n=== SUMMARY ===\n'+pk+'\n\n'+csv+'\n\nThis is metadata, not message content. Focus on patterns, not content.';
  try{
    const body=JSON.stringify({model,stream:false,prompt,system:'You are an expert digital forensics investigator writing official reports.',options:{temperature:0.2,num_predict:8192,num_ctx:131072}});
    D.aiStatus.textContent='Generating...';
    const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body});
    if(!r.ok){const t=await r.text();throw new Error(t||r.statusText)}
    const j=await r.json();
    const txt=(j.response||j.message?.content||j.choices?.[0]?.message?.content||'').trim();
    reportContent.innerHTML=renderMd(txt)||'[Empty]';
    D.aiStatus.textContent='Done.';
  }catch(e){
    console.error('AI error:',e);
    reportContent.innerHTML='<p style="color:var(--danger)">Error: '+esc(e.message)+'</p>';
    D.aiStatus.textContent='Error.';
  }
}
async function analyzeWithAI(){
  if(!state.data.records.length)return;

  // TIFM Backend mode
  if(D.aiMode && D.aiMode.value==='tifm'){
    D.aiAnalyzeBtn.disabled=true;
    D.aiStatus.textContent='Connecting to backend TIFM...';
    D.aiResponse.innerHTML='<em>Waiting for analysis...</em>';
    try{
      const r=await API.post('/ai/analyze'+(state.data.caseId?'?case_id='+encodeURIComponent(state.data.caseId):''),{});
      const analytics=r.analytics;
      const investigatorNotes=D.aiInvestigatorInput.value.trim();
      if(investigatorNotes){
        D.aiStatus.textContent='LLM processing with TIFM analytics context...';
        const endpoint=D.aiEndpoint.value.trim()||'http://localhost:11434/api/generate';
        const model=D.aiModel.value.trim()||'llama3.2';
        const contexts=getActiveContexts().join(', ');
        const prompt='You are an expert digital forensics investigator. Use the TIFM telecom analytics below to answer the investigator\'s question.\n\nTIFM Analytics:\n'+JSON.stringify(analytics,null,2)+'\n\nActive context: '+contexts+'\n\nInvestigator question: '+investigatorNotes;
        const body=JSON.stringify({model,stream:false,prompt,system:'You are an expert digital forensics investigator.',options:{temperature:0.3,num_predict:4096,num_ctx:131072}});
        D.aiStatus.textContent='LLM processing...';
        const llmR=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body});
        if(!llmR.ok){const t=await llmR.text();throw new Error(t||llmR.statusText)}
        const j=await llmR.json();
        const reply=(j.response||j.message?.content||JSON.stringify(j)).trim();
        D.aiResponse.innerHTML=renderMd(reply);
        D.aiStatus.textContent='Done.';
      }else{
        D.aiResponse.innerHTML='<strong>Analytics complete.</strong><pre style="font-size:0.7rem;white-space:pre-wrap;margin-top:8px">'+esc(JSON.stringify(analytics,null,2))+'</pre>';
        D.aiStatus.textContent='Done.';
      }
    }catch(e){
      D.aiResponse.innerHTML='<p style="color:var(--danger)">Error: '+esc(e.message)+'</p>';
      D.aiStatus.textContent='Error.';
    }
    D.aiAnalyzeBtn.disabled=false;
    return;
  }

  // Fine-Tuned TIFM mode
  if(D.aiMode && D.aiMode.value==='finetuned'){
    D.aiAnalyzeBtn.disabled=true;
    D.aiStatus.textContent='Connecting to fine-tuned TIFM model...';
    D.aiResponse.innerHTML='<em>Waiting for response...</em>';
    try{
      const investigatorNotes=D.aiInvestigatorInput.value.trim();
      const q=investigatorNotes||'Analyze this case and provide key insights.';
      const contexts=getActiveContexts();
      let url='/ai/chat?query='+encodeURIComponent(q)+(state.data.caseId?'&case_id='+encodeURIComponent(state.data.caseId):'');
      if(contexts.length)url+='&context='+encodeURIComponent(contexts.join(','));
      const r=await API.post(url,{});
      D.aiResponse.innerHTML=renderMd(r.answer||'[No response]');
      D.aiStatus.textContent='Done.';
    }catch(e){
      D.aiResponse.innerHTML='<p style="color:var(--danger)">Error: '+esc(e.message)+'</p>';
      D.aiStatus.textContent='Error.';
    }
    D.aiAnalyzeBtn.disabled=false;
    return;
  }

  // Legacy Ollama mode
  const endpoint=D.aiEndpoint.value.trim()||'http://localhost:11434/api/generate';
  const model=D.aiModel.value.trim()||'llama3.2';
  const investigatorNotes=D.aiInvestigatorInput.value.trim();
  D.aiAnalyzeBtn.disabled=true;
  D.aiStatus.textContent='Connecting to LLM...';
  D.aiResponse.innerHTML='<em>Waiting for response...</em>';
  const pk=buildDataPackage();
  const contexts=getActiveContexts().join(', ');
  let prompt='';
  if(investigatorNotes)prompt='The investigator asks: '+investigatorNotes+'\n\nBased on this data:\n'+pk+'\n\nActive context: '+contexts;
  else prompt='Analyze this telecommunications data and provide key insights, anomalies, and recommendations:\n\n'+pk;
  try{
    const body=JSON.stringify({model,stream:false,prompt,system:'You are an expert digital forensics investigator.',options:{temperature:0.3,num_predict:4096,num_ctx:131072}});
    D.aiStatus.textContent='LLM processing...';
    const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body});
    if(!r.ok){const t=await r.text();throw new Error(t||r.statusText)}
    const j=await r.json();
    const reply=(j.response||j.message?.content||JSON.stringify(j)).trim();
    D.aiResponse.innerHTML=renderMd(reply);
    D.aiStatus.textContent='Done.';
  }catch(e){
    D.aiResponse.innerHTML='<p style="color:var(--danger)">Error: '+esc(e.message)+'<br><br>Make sure Ollama is running at <code>'+esc(endpoint)+'</code> and the model <code>'+esc(model)+'</code> is pulled.</p>';
    D.aiStatus.textContent='Error.';
  }
  D.aiAnalyzeBtn.disabled=false;
}
function clearAiConversation(){
  D.aiResponse.innerHTML='<p style="color:var(--muted)">Ask a question about this case.</p>';
  D.aiInvestigatorInput.value='';
  D.aiStatus.textContent='Cleared.';
}

// ---- Event listeners for AI section ----
if(D.aiMode)D.aiMode.addEventListener('change',()=>{
  const isBackend=D.aiMode.value==='tifm'||D.aiMode.value==='finetuned';
  D.aiEndpoint.style.display=isBackend?'none':'';
  D.aiModel.style.display=isBackend?'none':'';
  const labels={tifm:'Backend TIFM mode active',finetuned:'Fine-tuned TIFM model active',ollama:'Local Ollama mode'};
  D.aiStatus.textContent=labels[D.aiMode.value]||'';
  setTimeout(()=>{D.aiStatus.textContent=''},2000);
});
// Init default visibility
if(D.aiMode&&(D.aiMode.value==='tifm'||D.aiMode.value==='finetuned')){D.aiEndpoint.style.display='none';D.aiModel.style.display='none'}
if(D.aiConfigSave)D.aiConfigSave.addEventListener('click',()=>{D.aiStatus.textContent='Settings saved.';setTimeout(()=>{D.aiStatus.textContent=''},2000)});
if(D.aiSeedBtn)D.aiSeedBtn.addEventListener('click',async()=>{
  const scenario=prompt('Enter scenario: criminal, drug, scam, human_trafficking, financial_fraud','criminal');
  if(!scenario)return;
  D.aiStatus.textContent='Seeding synthetic case...';
  D.aiSeedBtn.disabled=true;
  try{
    const r=await API.post('/ai/generate-synthetic?scenario='+encodeURIComponent(scenario),{});
    D.aiStatus.textContent='Created case "'+r.case_name+'" ('+r.cdr_inserted+' CDR, '+r.ipdr_inserted+' IPDR)';
    // Reload to show new case
    loadCases();
  }catch(e){
    D.aiStatus.textContent='Error: '+e.message;
  }
  D.aiSeedBtn.disabled=false;
});
if(D.aiCopyReportBtn)D.aiCopyReportBtn.addEventListener('click',()=>{const c=document.getElementById('aiReportContent');navigator.clipboard.writeText(c?c.textContent:'').catch(()=>{});D.aiStatus.textContent='Copied report.';setTimeout(()=>{D.aiStatus.textContent=''},2000)});
if(D.aiCopyPackageBtn)D.aiCopyPackageBtn.addEventListener('click',()=>{navigator.clipboard.writeText(buildDataPackage()).catch(()=>{});D.aiStatus.textContent='Copied data package.';setTimeout(()=>{D.aiStatus.textContent=''},2000)});
// Full Investigation Command Center (runFullInvestigation + module renderers) -> analytics/investigation.js
// Admin tab (users + audit log + modal) & auditView beacon -> ui/admin.js

// ====== EVIDENCE EXPORT ======
D.exportBtn.addEventListener('click',async ()=>{
  const prevTxt=D.exportBtn.textContent;D.exportBtn.textContent='Exporting…';D.exportBtn.disabled=true;
  const now=new Date().toISOString().slice(0,19).replace('T',' ');
  const caseName=(D.caseSelector.options[D.caseSelector.selectedIndex]?.text||'None');
  // Pull the full analytics report (risk leaderboards + all inferences) to lead the file.
  let analytics='',ref='';
  try{const base=state.data.caseId?'?case_id='+encodeURIComponent(state.data.caseId)+'&':'?';const ar=await fetch('/inference/report.md'+base+'source=evidence',{credentials:'same-origin'});if(ar.ok){analytics=await ar.text();ref=ar.headers.get('X-Export-Ref')||'';}}catch(e){}
  let report='';
  report+='# ARGUS — Case Evidence Report\n\n';
  if(ref)report+='**Reference:** `'+ref+'`  \n';
  report+='**Generated:** '+now+'  \n**User:** '+(state.auth.user?state.auth.user.username:'Unknown')+'  \n**Case:** '+caseName+'\n';
  if(analytics){report+='\n'+analytics+'\n\n---\n\n# Raw evidence & sessions\n';}
  report+='\n## Summary\n';
  report+='Total Records: '+state.data.records.length+'\n';
  report+='CDR: '+_totalCdrFn()+', IPDR: '+_totalIpdrFn()+'\n';
  report+='Towers: '+state.towers.length+'\n';
  report+='Subjects: '+state.subjects.length+'\n';

  const timeSorted=state.data.records.filter(r=>r.ts).map(r=>new Date(r.ts).getTime());
  if(timeSorted.length){
    report+='Date Range: '+new Date(Math.min(...timeSorted)).toLocaleString()+' to '+new Date(Math.max(...timeSorted)).toLocaleString()+'\n';
    const spanMs=Math.max(...timeSorted)-Math.min(...timeSorted);
    report+='Span: '+Math.round(spanMs/3600000)+' hours\n';
  }

  const allSvc=[],allProt=[],allCnter=[];
  state.data.records.forEach(r=>{
    if(r.svc)allSvc.push(r.svc);
    if(r.prot)allProt.push(r.prot);
    if(r.cnt)allCnter.push(r.cnt);
  });
  const topSvc=Object.entries(state.data.records.reduce((a,r)=>{const s=recordSvcAttr(r)||r.svc||'Unknown';a[s]=(a[s]||0)+1;return a},{}))
    .sort((a,b)=>b[1]-a[1]).slice(0,10);
  if(topSvc.length){
    report+='\nTop Attributed Services:\n';
    topSvc.forEach(([s,c])=>report+='  '+s+': '+c+'\n');
  }
  const topCnt=Object.entries(allCnter.reduce((a,c)=>{a[c]=(a[c]||0)+1;return a},{})).sort((a,b)=>b[1]-a[1]).slice(0,10);
  if(topCnt.length){
    report+='\nTop Contacts:\n';topCnt.forEach(([c,n])=>report+='  '+c+': '+n+' interactions\n');
  }

  // Geofence
  if(state.map.fenceDrawn&&state.map.fenceLayer){
    const fencePts=state.map.fenceLayer.getLatLngs();const coords=Array.isArray(fencePts[0])?fencePts[0]:fencePts;
    report+='\n--- Geofence ---\n';
    coords.forEach(p=>report+='  '+p.lat.toFixed(4)+', '+p.lng.toFixed(4)+'\n');
  }

  // ===== SUBJECT PROFILES =====
  report+='\n--- Subject Profiles ---\n';
  const subData=state.subjects.slice(0,50).map(sub=>{
    const rows=state.data.records.filter(r=>r.sub===sub);
    const contacts=[...new Set(rows.map(r=>r.cnt).filter(Boolean))];
    const svcs={};rows.forEach(r=>{const a=recordSvcAttr(r)||r.svc||'Unknown';svcs[a]=(svcs[a]||0)+1});
    const topS=Object.entries(svcs).sort((a,b)=>b[1]-a[1]).slice(0,5);
    const first=rows.find(r=>r.ts);const last=rows.slice().reverse().find(r=>r.ts);
    const tows=[...new Set(rows.map(r=>r.tow).filter(Boolean))];
    const apns=[...new Set(rows.map(r=>r.apn).filter(Boolean))];
    const rats=[...new Set(rows.map(r=>r.rat).filter(Boolean))];
    const sessionCount=reconstructSessions(sub).length;
    const meetingsSub=detectMeetings({subject:sub});
    return{name:sub,count:rows.length,contacts:contacts.length,topSvc:topS,first,last,tows,apns,rats,sessionCount,meetings:meetingsSub.length,meetingsHigh:meetingsSub.filter(m=>m.gapLevel==='high').length};
  }).sort((a,b)=>b.count-a.count);

  subData.forEach(p=>{
    report+='\nSubject: '+p.name+'\n';
    report+='  Records: '+p.count+' | Sessions: '+p.sessionCount+' | Contacts: '+p.contacts;
    if(p.meetings)report+=' | Meetings: '+p.meetings+' ('+p.meetingsHigh+' high conf)';
    report+='\n';
    if(p.topSvc.length)report+='  Top Services: '+p.topSvc.map(([s,c])=>s+' ('+c+')').join(', ')+'\n';
    if(p.tows.length)report+='  Towers: '+p.tows.join(', ')+'\n';
    if(p.apns.length)report+='  APNs: '+p.apns.join(', ')+'\n';
    if(p.rats.length)report+='  RATs: '+p.rats.join(', ')+'\n';
    if(p.meetings&&p.meetingsHigh){
      const topMeetings=detectMeetings({subject:p.name}).filter(m=>m.gapLevel==='high').slice(0,5);
      topMeetings.forEach(m=>report+='  + Meeting: '+m.time.toLocaleString()+' with '+m.subB+' at '+m.tow+' (gap:'+m.gap+'m)\n');
    }
    if(p.first)report+='  First seen: '+new Date(p.first).toLocaleString()+'\n';
    if(p.last)report+='  Last seen: '+new Date(p.last).toLocaleString()+'\n';
    // Sessions for this subject
    const sessions=reconstructSessions(p.name);
    if(sessions.length){
      sessions.slice(0,5).forEach(s=>{
        const svcName=s.primary?s.primary.service:(s.service||'Unknown');
        const disLabel=s.activityLabel||s.activity||'';
        report+='    + Session: '+svcName+(s.serviceConfidence?' ('+Math.round(s.serviceConfidence)+'%)':'')+' '+disLabel+
          (s.start?' ['+new Date(s.start).toLocaleString()+']':'')+
          (s.duration?' dur:'+s.duration+'s':'')+'\n';
      });
      if(sessions.length>5)report+='    + ... and '+(sessions.length-5)+' more sessions\n';
    }
  });
  if(state.subjects.length>50)report+='\n... and '+(state.subjects.length-50)+' more subjects\n';

  // ===== SESSIONS (full) =====
  report+='\n--- All Reconstructed Sessions ---\n';
  let sessionCount=0;
  state.subjects.forEach(entity=>{
    const sessions=reconstructSessions(entity);
    sessions.forEach(s=>{
      if(++sessionCount>200)return;
      const svcName=s.primary?s.primary.service:(s.service||'Unknown');
      const disLabel=s.activityLabel||s.activity||'';
      report+='Subject: '+entity+' | '+svcName+(s.serviceConfidence?' ('+Math.round(s.serviceConfidence)+'%)':'')+' '+disLabel+'\n';
      if(s.start||s.end)report+='  Time: '+(s.start?new Date(s.start).toLocaleString():'?')+' — '+(s.end?new Date(s.end).toLocaleString():'?')+'\n';
      if(s.duration)report+='  Duration: '+s.duration+'s\n';
      if(s.cnt)report+='  Counterpart: '+s.cnt+'\n';
      if(s.tow)report+='  Tower: '+s.tow+'\n';
      if(s.evidence&&s.evidence.length)report+='  Evidence: '+s.evidence.join('; ')+'\n';
      if(s.candidates&&s.candidates.length){
        report+='  Candidates:\n';
        s.candidates.slice(0,5).forEach((ca,i)=>{
          report+='    '+(i+1)+'. '+ca.service+(ca.activity?' - '+ca.activity:'')+(ca.score?' ['+Math.round(ca.score)+'%]':'')+'\n';
        });
      }
    });
  });
  if(sessionCount>200)report+='\n... and '+(sessionCount-200)+' more sessions\n';

  // ===== RAW RECORDS (only non-empty fields per record) =====
  if(_totalCdrFn()){
    const cdrKeys=['ts','sub','cnt','dur','dir','tow','cll','svc','tec','car','imei','imsi','roam','lac','lat','lng','cell','msisdn'];
    report+='\n--- CDR Records ---\n';
    state.cdr.slice(0,200).forEach((r,i)=>{
      const vals=cdrKeys.filter(k=>r[k]).map(k=>k+'='+r[k]).join(' ');
      if(vals)report+='  #'+(i+1)+': '+vals+'\n';
    });
    if(_totalCdrFn()>200)report+='  ... and '+(_totalCdrFn()-200)+' more\n';
  }

  if(_totalIpdrFn()){
    const ipdrKeys=['ts','sub','cnt','prot','sport','dport','svc','tow','bytesUp','bytesDn','dur','rat','apn','lac','lat','lng'];
    report+='\n--- IPDR Records ---\n';
    state.ipdr.slice(0,200).forEach((r,i)=>{
      const vals=ipdrKeys.filter(k=>r[k]).map(k=>k+'='+r[k]).join(' ');
      if(vals)report+='  #'+(i+1)+': '+vals+'\n';
    });
    if(_totalIpdrFn()>200)report+='  ... and '+(_totalIpdrFn()-200)+' more\n';
  }

  // ===== TOWERS =====
  if(state.towers.length){
    report+='\n--- Towers ---\n';
    state.towers.forEach(t=>{
      const parts=[t.tower_id||t.id||'?'];
      if(t.name)parts.push(t.name);
      if(t.lat)parts.push('Lat:'+t.lat);
      if(t.lng)parts.push('Lng:'+t.lng);
      if(t.tech)parts.push(t.tech);
      if(t.range)parts.push(t.range+'m');
      report+='  '+parts.join(' | ')+'\n';
    });
  }

  // ===== MEETING EVIDENCE =====
  const allMeetingsReport=detectMeetings({allPairs:true});
  const meetTot=meetingTotals();
  if(meetTot.total){
    report+='\n--- Meeting Evidence ---\n';
    report+='Total meetings detected: '+meetTot.total+'\n';
    report+='High confidence: '+meetTot.high+' | Medium: '+meetTot.medium+' | Low: '+meetTot.low+'\n';
    allMeetingsReport.sort((a,b)=>b.score-a.score).slice(0,30).forEach(mt=>{
      report+='  '+mt.time.toLocaleString()+' | '+mt.subA+' & '+mt.subB+' | '+mt.tow+' | gap:'+mt.gap+'m | '+mt.gapLevel.toUpperCase()+' | score:'+mt.score+'\n';
      if(mt.subAEvent||mt.subBEvent)report+='    Events: ['+mt.subA+'] '+mt.subAEvent+' | ['+mt.subB+'] '+mt.subBEvent+'\n';
      if(mt.evidence&&mt.evidence.length)report+='    Why: '+mt.evidence.join('; ')+'\n';
      report+='    Encounters: '+mt.encounterCount+' same-tower events\n';
    });
    if(meetTot.total>allMeetingsReport.length)report+='  ... and '+(meetTot.total-allMeetingsReport.length)+' more\n';
  }

  report+='\n_End of report._\n';

  const safe=(caseName||'case').replace(/[^a-z0-9]+/gi,'_').replace(/^_|_$/g,'')||'case';
  const blob=new Blob([report],{type:'text/markdown;charset=utf-8'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);
  a.download=(ref||('ARGUS-EVD-'+now.slice(0,10).replace(/-/g,'')))+'_'+safe+'.md';
  a.click();URL.revokeObjectURL(a.href);
  try{await loadExports();const list=$('wlExportsList');if(list)list.innerHTML=_exportsHtml();const note=$('wlExportNote');if(note&&ref)note.textContent='Saved '+ref;}catch(e){}
  D.exportBtn.textContent=prevTxt;D.exportBtn.disabled=false;
});

// Court-Ready Dossier (renderDossier + agency letterhead + cross-case fill) -> analytics/dossier.js

// Service Attribution tab (renderServicesTab + bursts + service cards) -> analytics/services.js

// Cross-Subject Correlation tab (renderCorrelationTab + runCorrelation) -> analytics/correlation.js
// Services + Correlation tab listeners moved into analytics/services.js + analytics/correlation.js

// ====== BOOTSTRAP ======
// Laws / legal-reference tab (LAW_CATS/LAW_REFERENCE + renderLaws) -> reference/laws.js

// ====== CSV EXPORT ======
function _csvCell(v){v=v==null?'':String(v);return /[",\n\r]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v;}
function _csvSync(filename,headers,rows){
  const lines=[headers.map(_csvCell).join(',')].concat((rows||[]).map(r=>r.map(_csvCell).join(',')));
  const blob=new Blob(['﻿'+lines.join('\r\n')],{type:'text/csv;charset=utf-8'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
function downloadCsv(filename,headers,rows){
  // Use worker for large exports to keep main thread free; fall back to sync for small ones
  if(rows&&rows.length>5000){
    _W.export('csv',headers,rows,filename).then(res=>{
      if(!res)return _csvSync(filename,headers,rows);
      const a=document.createElement('a');a.href=res.blobUrl;a.download=res.filename;a.click();
      setTimeout(()=>URL.revokeObjectURL(res.blobUrl),2000);
    }).catch(()=>_csvSync(filename,headers,rows));
  }else{
    _csvSync(filename,headers,rows);
  }
}
async function downloadXlsx(filename,sheet,headers,rows){
  try{
    const r=await fetch('/export/xlsx',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({sheet_name:sheet,filename:filename,headers:headers,rows:rows})});
    if(!r.ok)throw new Error(await r.text());
    const blob=await r.blob();const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  }catch(e){try{toast('XLSX export failed: '+(e.message||e));}catch(_){}}
}
// Wire both CSV and XLSX export buttons in a container against a {id:{headers,rows}} report map.
function _wireExports(box,reps,csvClass,fileBase){
  box.querySelectorAll('.'+csvClass).forEach(b=>b.onclick=()=>{const rep=reps[b.dataset.rep];if(rep)downloadCsv(fileBase+'_'+b.dataset.rep+'.csv',rep.headers,rep.rows);});
  box.querySelectorAll('.'+csvClass+'-x').forEach(b=>b.onclick=()=>{const rep=reps[b.dataset.rep];if(rep)downloadXlsx(fileBase+'_'+b.dataset.rep+'.xlsx',b.dataset.rep,rep.headers,rep.rows);});
  try{_wireVirtualTables(box,reps);}catch(e){console.warn('vtable wiring',e);}  // Phase 2b: window large report tables
}
// Shared report-table renderers (_repCard + virtual tables) -> ui/report_table.js
const _hm=v=>{try{return new Date(v).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}catch(e){return ''}};
const _durStr=s=>{s=+s||0;return s>=60?Math.floor(s/60)+'m '+(s%60)+'s':s+'s'};

// ====== PHASE B — CDR ANALYSIS REPORTS (server-side) ======
let _arReports={};
// Render the data-session (IPDR) report cards for a subject — used both when the materialised
// report is IPDR-shaped and when a CDR lookup falls back to IPDR.
function _arRenderIpdr(ir,total,sub){
  const body=document.getElementById('arBody'),meta=document.getElementById('arMeta');
  _arReports={};
  Object.entries(ir||{}).forEach(([id,r])=>{_arReports[id]={headers:r.headers||[],rows:r.rows||[]};});
  body.innerHTML='<div class="ar-empty" style="margin-bottom:10px;border-color:var(--accent)"><span class="ar-empty-ico">📡</span><span class="ar-empty-txt">IPDR subject — data-session analytics (no CDR records for this subject).</span></div>'+[
    _repCard('ar-exp','daily_volume','Daily session volume',ir.daily_volume?.headers||[],ir.daily_volume?.rows||[]),
    _repCard('ar-exp','protocol_breakdown','Protocol breakdown',ir.protocol_breakdown?.headers||[],ir.protocol_breakdown?.rows||[]),
    _repCard('ar-exp','top_destinations','Top destination IPs (top 30)',ir.top_destinations?.headers||[],ir.top_destinations?.rows||[]),
    _repCard('ar-exp','hourly_pattern','Hourly activity pattern',ir.hourly_pattern?.headers||[],ir.hourly_pattern?.rows||[]),
    _repCard('ar-exp','data_throughput','Data throughput by day',ir.data_throughput?.headers||[],ir.data_throughput?.rows||[]),
    _repCard('ar-exp','off_periods','OFF / unused periods (gap ≥ 3 days)',ir.off_periods?.headers||[],ir.off_periods?.rows||[]),
    _repCard('ar-exp','port_usage','Port usage (top 30)',ir.port_usage?.headers||[],ir.port_usage?.rows||[]),
    _repCard('ar-exp','tower_footprint','Tower footprint',ir.tower_footprint?.headers||[],ir.tower_footprint?.rows||[]),
    _repCard('ar-exp','apn_breakdown','APN breakdown',ir.apn_breakdown?.headers||[],ir.apn_breakdown?.rows||[]),
    _repCard('ar-exp','rat_breakdown','RAT / network technology',ir.rat_breakdown?.headers||[],ir.rat_breakdown?.rows||[]),
  ].join('');
  if(meta)meta.textContent=(total||0)+' IPDR records for this subject';
  _wireExports(body,_arReports,'ar-exp','ARGUS_'+sub);
  tabMarkRendered('analysisreports');
}

async function renderAnalysisReports(){
  if(!tabNeedsRender('analysisreports'))return;
  const sel=document.getElementById('arSubject'),body=document.getElementById('arBody'),meta=document.getElementById('arMeta');
  if(!sel||!body)return;
  const subs=state._ownedSubjects.length?state._ownedSubjects:(state.subjects.filter(Boolean));
  if(!subs.length){body.innerHTML='<div class="ar-empty"><span class="ar-empty-ico">◌</span><span class="ar-empty-txt">Load a case to run analysis reports.</span></div>';sel.innerHTML='';if(meta)meta.textContent='';return;}
  if(!sel._wired){sel._wired=true;sel.addEventListener('change',()=>{delete state.render.rendered['analysisreports'];renderAnalysisReports();});}
  // Build the (potentially huge) subject <select> ONCE per dataset, not on every render/change —
  // rebuilding it each time (with a tag lookup per option) was a big part of this tab's lag.
  const sig=subs.length+'|'+(subs[0]||'')+'|'+(subs[subs.length-1]||'');
  if(sel.dataset.sig!==sig){
    const cur=sel.value;
    sel.innerHTML=subs.map(s=>'<option value="'+esc(s)+'">'+esc(subjLabelTxt(s))+'</option>').join('');
    sel.dataset.sig=sig;
    if(cur&&subs.includes(cur))sel.value=cur;else if(subs.length)sel.value=subs[0];
  }
  const sub=sel.value;
  if(!sub){body.innerHTML='<div class="ar-empty"><span class="ar-empty-ico">◌</span><span class="ar-empty-txt">No CDR subjects in this case.</span></div>';return;}
  body.innerHTML='<div class="ar-empty"><span class="ar-empty-ico">⋯</span><span class="ar-empty-txt">Loading analysis reports…</span></div>';
  _arReports={};
  const qp=new URLSearchParams({sub});
  if(state.data.caseId)qp.set('case_id',state.data.caseId);
  try{
    // Try materialised cache first; fall back to live CDR endpoint on miss
    const matData=await API.get('/analytics/reports?'+qp.toString()).catch(()=>null);
    const data=matData&&(matData.total_records!==undefined)?matData:await API.get('/analysis/cdr-reports?'+qp.toString());
    // IPDR subject: the report is data-session-shaped (daily_volume etc.), not CDR — render the
    // IPDR cards directly rather than empty CDR cards.
    const _reps=data.reports||{};
    if((data.subject_type==='ipdr'||(_reps.daily_volume&&!_reps.day_first_last))&&data.total_records){
      _arRenderIpdr(_reps,data.total_records,sub);
      return;
    }
    if(!data.total_records){
      // Try IPDR-native reports for this subject before declaring "no data"
      const iqp=new URLSearchParams({sub});
      if(state.data.caseId)iqp.set('case_id',state.data.caseId);
      let idata;
      try{idata=await API.get('/analysis/ipdr-reports?'+iqp.toString());}catch(_){idata=null;}
      if(idata&&idata.total_records){
        _arRenderIpdr(idata.reports||{},idata.total_records,sub);
        return;
      }
      body.innerHTML='<div class="ar-empty"><span class="ar-empty-ico">◌</span><span class="ar-empty-txt">No CDR or IPDR records found for <b>'+esc(sub)+'</b>.</span></div>';
      if(meta)meta.textContent='0 records';
      tabMarkRendered('analysisreports');
      return;
    }
    const reps=data.reports||{};
    Object.entries(reps).forEach(([id,r])=>{_arReports[id]={headers:r.headers||[],rows:r.rows||[]};});
    const ostate=reps.other_state||{};
    body.innerHTML=[
      _repCard('ar-exp','day_first_last','Day — first & last call',reps.day_first_last?.headers||[],reps.day_first_last?.rows||[]),
      _repCard('ar-exp','single_call_days','Single-call days',reps.single_call_days?.headers||[],reps.single_call_days?.rows||[]),
      _repCard('ar-exp','weekday_weekend','Weekday vs weekend',reps.weekday_weekend?.headers||[],reps.weekday_weekend?.rows||[]),
      _repCard('ar-exp','longest_calls','Longest-duration calls (top 30)',reps.longest_calls?.headers||[],reps.longest_calls?.rows||[]),
      _repCard('ar-exp','day_night','Day vs night summary',reps.day_night?.headers||[],reps.day_night?.rows||[]),
      _repCard('ar-exp','isd_calls','ISD / international calls',reps.isd_calls?.headers||[],reps.isd_calls?.rows||[]),
      _repCard('ar-exp','other_state','Other-state calls',reps.other_state?.headers||[],reps.other_state?.rows||[],ostate.note||''),
      _repCard('ar-exp','off_periods','OFF / unused periods (gap ≥ 3 days)',reps.off_periods?.headers||[],reps.off_periods?.rows||[]),
      _repCard('ar-exp','imei_summary','IMEI summary',reps.imei_summary?.headers||[],reps.imei_summary?.rows||[]),
      _repCard('ar-exp','imsi_summary','SIM / IMSI summary',reps.imsi_summary?.headers||[],reps.imsi_summary?.rows||[]),
      _repCard('ar-exp','bank_sms','Bank / OTP-sender SMS',reps.bank_sms?.headers||[],reps.bank_sms?.rows||[],'Alphanumeric sender IDs (e.g. VM-HDFCBK).'),
    ].join('');
    if(meta)meta.textContent=(data.total_records||0)+' records for this subject';
    _wireExports(body,_arReports,'ar-exp','ARGUS_'+sub);
    tabMarkRendered('analysisreports');  // only on success; subject change clears this
  }catch(e){
    console.error('renderAnalysisReports:',e);
    body.innerHTML='<div class="ar-empty"><span class="ar-empty-ico">✖</span><span class="ar-empty-txt">Failed to load analysis reports.</span></div>';
  }
}

// ====== PHASE C — GROUP COMPARE (server-side) ======
let _gcReports={};
function renderGroupCompare(){
  const picker=document.getElementById('gcPicker'),body=document.getElementById('gcBody'),meta=document.getElementById('gcMeta');
  if(!picker||!body)return;
  const subs=state._ownedSubjects.length?state._ownedSubjects:state.subjects.filter(Boolean);
  if(!subs.length){picker.innerHTML='';body.innerHTML='<div class="ar-empty">Load a case to compare subjects.</div>';if(meta)meta.textContent='';return;}
  if(!picker._wired){picker._wired=true;
    const rb=document.getElementById('gcRunBtn');if(rb)rb.onclick=_gcRun;
    const cb=document.getElementById('gcClearBtn');if(cb)cb.onclick=()=>{picker.querySelectorAll('input').forEach(c=>c.checked=false);body.innerHTML='';};
  }
  picker.innerHTML='<div class="gc-picker-h">Select 2+ subjects</div>'+subs.slice(0,300).map(s=>'<label class="gc-chk"><input type="checkbox" value="'+esc(s)+'"> '+esc(subjLabelTxt(s))+'</label>').join('');
  if(meta)meta.textContent=subs.length+' subjects';
}
async function _gcRun(){
  const picker=document.getElementById('gcPicker'),body=document.getElementById('gcBody');
  const sel=[...picker.querySelectorAll('input:checked')].map(c=>c.value);
  if(sel.length<2){body.innerHTML='<div class="ar-empty"><span class="ar-empty-ico">◎</span><span class="ar-empty-txt">Select at least 2 subjects, then click Compare.</span></div>';return;}
  body.innerHTML='<div class="ar-empty"><span class="ar-empty-ico">⋯</span><span class="ar-empty-txt">Running comparison…</span></div>';
  const qp=new URLSearchParams({subjects:sel.join(',')});
  if(state.data.caseId)qp.set('case_id',state.data.caseId);
  try{
    const data=await API.get('/analysis/group-compare?'+qp.toString());
    if(data.error){body.innerHTML='<div class="ar-empty">'+esc(data.error)+'</div>';return;}
    // Detect IPDR-only: all CDR sections empty
    const hasCdrData=!!(data.contacts?.rows?.length||data.towers?.rows?.length||data.matrix?.rows?.length);
    if(!hasCdrData){
      body.innerHTML='<div class="ar-empty"><span class="ar-empty-ico">◌</span><span class="ar-empty-txt">No CDR records found for the selected subjects.<br>Group Compare is CDR-based (common contacts, towers, call matrix).<br>These subjects appear in IPDR data only.</span></div>';
      return;
    }
    _gcReports={};
    Object.entries(data).forEach(([id,r])=>{_gcReports[id]={headers:r.headers||[],rows:r.rows||[]};});
    body.innerHTML='<div class="gc-sel">Comparing <b>'+sel.length+'</b> subjects: '+sel.map(s=>esc(subjLabelTxt(s))).join(', ')+'</div>'+[
      _repCard('gc-exp','contacts','Common contacts (contacted by all '+sel.length+')',data.contacts?.headers||[],data.contacts?.rows||[]),
      _repCard('gc-exp','towers','Common towers',data.towers?.headers||[],data.towers?.rows||[]),
      _repCard('gc-exp','cells','Common cell IDs',data.cells?.headers||[],data.cells?.rows||[]),
      _repCard('gc-exp','latlng','Common locations',data.latlng?.headers||[],data.latlng?.rows||[]),
      _repCard('gc-exp','imeis','Common IMEIs',data.imeis?.headers||[],data.imeis?.rows||[]),
      _repCard('gc-exp','matrix','Who called whom (direct calls within the group)',data.matrix?.headers||[],data.matrix?.rows||[]),
    ].join('');
    _wireExports(body,_gcReports,'gc-exp','ARGUS_group');
  }catch(e){
    console.error('_gcRun:',e);
    body.innerHTML='<div class="ar-empty"><span class="ar-empty-ico">✖</span><span class="ar-empty-txt">Comparison failed.</span></div>';
  }
}

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
// ── ESM window bridge (TRANSITIONAL) ─────────────────────────────────────────────────────────
// app.js is now an ES module, so its top-level `function` declarations are module-scoped, not
// global. Inline on*= handlers (in index.html and in generated HTML strings) resolve their names
// on `window`, so we re-expose exactly the handlers they reference here. Functions already assigned
// via `window.x = ...` (addToSuspectGroup, removeFromSuspectGroup, wlAdd, wlRemove, wlExport) don't
// need bridging. This shim is TEMPORARY: as each feature migrates to event delegation (data-act),
// its entries are dropped, and the whole block is deleted in the final cleanup step.
Object.assign(window, {
  switchTab, showSubjectRecords, showMeetingOverlay,
  showSessionRecords, saveProfileTag, exportFeedback, toggleFindingDetail,
  generateAiReport, chatWithContext, analyzeWithAI,
  clearAiConversation, switchNarrativeSubject,
  showGanttTip, scheduleHideGanttTip, toggleAnnot, markFinding,
});

provideWorkspaceHooks({renderStoryTimeline, renderDossier});  // evidence -> story/dossier refreshers
onChartsRendered(installChartCaptureButtons);  // charts pin-to-evidence buttons (injected; avoids charts->workspace import)
provideInfReport(getInfReport);  // map inference overlays reach getInfReport (inferences layer still in app.js)
provideExports(_wireExports);  // tower-dump report cards reach the CSV/XLSX export wiring
provideDetectMeetings(detectMeetings);  // correlation meeting detection (dashboard engine still in app.js)
provideLoadSuspects(loadSuspects);  // inferences watchlist ops reach the suspect-group loader
wireDelegation();  // central data-act delegation (dormant until features register actions)
if(!D.loginUser.value)D.loginUser.value='admin';
checkAuth();
