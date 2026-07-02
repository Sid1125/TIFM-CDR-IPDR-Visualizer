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
  invalidateAiCache();state.data.geoRecords=null;INF.report=null;INF.cache=null;meetingsCache.v=null;_storyXcaseCache={};_storyEvents=[];
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
registerTab('story',renderStory);
// evidence tab registered in workspace/evidence.js (self-registers via registerTab)
// crosscase tab registered in analytics/crosscase.js (self-registers via registerTab)
registerTab('inferences',renderInferences);
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

// ====== STORY / NARRATIVE TAB (unified investigation timeline + auto narrative + evidence) ======
// EVK (event-kind styling) -> workspace/evidence.js
let _storyEvents=[],_storyKinds=null,_storyXcaseCache={};

function _evSig(e){return e.kind+'|'+(e.ts?new Date(e.ts).getTime():'')+'|'+e.title}

// Assemble a meaningful, bounded chronological event feed for one subject (or '__all__').
async function buildCaseEvents(subject){
  const ev=[];
  const xrep=await getStoryXcase();
  if(subject&&subject!=='__all__'){
    const owned=state.data.records.filter(r=>r.ts&&(r.sub===subject||r.msisdn===subject));
    const any=rowsFor(subject).filter(r=>r.ts).sort((a,b)=>new Date(a.ts)-new Date(b.ts));
    if(any.length){const f=any[0];ev.push({ts:new Date(f.ts),kind:'first',title:subject+' first appears in this case',detail:'via '+(f.type==='IPDR'?'data session':(f.cll||'call'))+(f.tow?' at tower '+f.tow:''),sub:subject});}
    // First contact with each top contact (CDR)
    const contactFirst={},contactCount={};
    owned.filter(r=>r.type==='CDR'&&r.cnt&&r.cnt!==subject).forEach(r=>{const t=new Date(r.ts);contactCount[r.cnt]=(contactCount[r.cnt]||0)+1;if(!contactFirst[r.cnt]||t<contactFirst[r.cnt])contactFirst[r.cnt]=t;});
    Object.entries(contactCount).sort((a,b)=>b[1]-a[1]).slice(0,8).forEach(([c,k])=>{
      ev.push({ts:contactFirst[c],kind:'call',title:'Began contact with '+c,detail:k+' interaction'+(k===1?'':'s')+' over the case window',sub:subject,cnt:c});
    });
    // Data activity onset
    const ipr=owned.filter(r=>r.type==='IPDR').sort((a,b)=>new Date(a.ts)-new Date(b.ts));
    if(ipr.length){const svcCount={};ipr.forEach(r=>{const s=recordSvcAttr(r)||r.svc||'Unknown';svcCount[s]=(svcCount[s]||0)+1;});const top=Object.entries(svcCount).sort((a,b)=>b[1]-a[1])[0];
      ev.push({ts:new Date(ipr[0].ts),kind:'data',title:'Internet activity begins',detail:ipr.length+' data session'+(ipr.length===1?'':'s')+(top?'; dominant: '+top[0]:''),sub:subject});}
    // Distinct-tower first visits (bounded)
    const towFirst={};owned.filter(r=>r.tow).forEach(r=>{const t=new Date(r.ts);if(!towFirst[r.tow]||t<towFirst[r.tow])towFirst[r.tow]=t;});
    const tm=towerMeta?towerMeta():{};
    Object.entries(towFirst).sort((a,b)=>a[1]-b[1]).slice(0,8).forEach(([tw,t])=>{const m=tm[tw]||{};ev.push({ts:t,kind:'move',title:'First seen at tower '+tw,detail:[m.city,m.state].filter(Boolean).join(', ')||'location unresolved',sub:subject,tow:tw});});
    // Identity changes
    try{(buildIdentityProfile(subject).changes||[]).forEach(c=>ev.push({ts:new Date(c.time),kind:'identity',title:c.detail,detail:(c.from?('was '+c.from):'')+(c.to?(' → '+c.to):'')+' ('+c.confidence+' confidence)',sub:subject}));}catch(e){}
    // Meetings involving subject
    ((meetingsCache.v&&meetingsCache.v.list)||[]).filter(m=>m.subA===subject||m.subB===subject).forEach(m=>{const other=m.subA===subject?m.subB:m.subA;ev.push({ts:new Date(m.time),kind:'meeting',title:'Co-located with '+other,detail:'tower '+(m.tow||'?')+' · '+Math.round(m.gap)+'m gap · '+m.gapLevel+' confidence'+(m.encounterCount>1?' · '+m.encounterCount+' encounters':''),sub:subject,cnt:other,tow:m.tow});});
    // Cross-case
    const xs=((xrep&&xrep.subjects)||[]).find(s=>s.subject===subject);
    if(xs){(xs.matches||[]).forEach(mm=>{const when=mm.first_seen?new Date(mm.first_seen):(any.length?new Date(any[0].ts):new Date());ev.push({ts:when,kind:'crosscase',title:'Also appears in case "'+(mm.case_name||mm.case_id)+'"',detail:'matched by '+((mm.match_types||[mm.match_type]).join(', '))+' · '+mm.confidence+' confidence · '+(mm.record_count||0)+' records',sub:subject});});}
    // AI findings
    addAiEvents(ev,subject,any.length?new Date(any[any.length-1].ts):new Date());
  }else{
    // Case-wide overview: meetings, identity changes, cross-case, AI (bounded).
    ((meetingsCache.v&&meetingsCache.v.list)||[]).forEach(m=>ev.push({ts:new Date(m.time),kind:'meeting',title:m.subA+' ↔ '+m.subB,detail:'tower '+(m.tow||'?')+' · '+Math.round(m.gap)+'m · '+m.gapLevel,sub:m.subA,cnt:m.subB,tow:m.tow}));
    (state.subjects||[]).slice(0,200).forEach(s=>{try{(buildIdentityProfile(s).changes||[]).forEach(c=>ev.push({ts:new Date(c.time),kind:'identity',title:s+': '+c.detail,detail:(c.from||'')+(c.to?(' → '+c.to):'')+' ('+c.confidence+')',sub:s}));}catch(e){}});
    ((xrep&&xrep.subjects)||[]).forEach(xs=>{(xs.matches||[]).forEach(mm=>ev.push({ts:mm.first_seen?new Date(mm.first_seen):new Date(),kind:'crosscase',title:xs.subject+' ↔ case "'+(mm.case_name||mm.case_id)+'"',detail:'matched by '+((mm.match_types||[mm.match_type]).join(', '))+' · '+mm.confidence,sub:xs.subject}));});
    addAiEvents(ev,null,new Date());
  }
  return ev.filter(e=>e.ts&&!isNaN(e.ts)).sort((a,b)=>a.ts-b.ts);
}

function addAiEvents(ev,subject,fallbackTs){
  const rep=INF.report;if(!rep)return;
  const cdr=rep.cdr||{},ipdr=rep.ipdr||{};
  const match=s=>!subject||s===subject;
  (cdr.risk||[]).filter(r=>match(r.subject)).forEach(r=>{if((r.score||0)>=50||r.band==='Critical'||r.band==='High')ev.push({ts:fallbackTs,kind:'ai',title:(subject?'':r.subject+': ')+'Risk assessment — '+(r.band||'')+' (score '+(r.score||0)+')',detail:'composite spatiotemporal risk',sub:r.subject});});
  (ipdr.risk||[]).filter(r=>match(r.subject)).forEach(r=>{if((r.score||0)>=50||r.band==='Critical'||r.band==='High')ev.push({ts:fallbackTs,kind:'ai',title:(subject?'':r.subject+': ')+'Flagged IP — '+(r.band||'')+' (score '+(r.score||0)+')',detail:'IPDR risk',sub:r.subject});});
  (cdr.impossible_travel||[]).filter(r=>match(r.subject)).forEach(r=>{ev.push({ts:r.to_time?new Date(r.to_time):fallbackTs,kind:'ai',title:(subject?'':r.subject+': ')+'Impossible travel flagged',detail:Math.round(r.distance_km||0)+'km in '+Math.round(r.dt_minutes||0)+'m ('+Math.round(r.speed_kmh||0)+' km/h) — possible clone/spoof',sub:r.subject});});
  (cdr.co_presence||[]).filter(p=>(p.hidden_link||p.convoy)&&(!subject||p.subject_a===subject||p.subject_b===subject)).slice(0,40).forEach(p=>{ev.push({ts:fallbackTs,kind:'ai',title:(p.hidden_link?'Hidden link':'Convoy')+': '+p.subject_a+' ↔ '+p.subject_b,detail:(p.occurrences||0)+' co-locations over '+(p.distinct_days||0)+' day(s)'+(p.ever_called?'':'; never called each other'),sub:p.subject_a,cnt:p.subject_b});});
  (ipdr.beaconing||[]).filter(b=>match(b.subject)).slice(0,20).forEach(b=>{ev.push({ts:fallbackTs,kind:'ai',title:(subject?'':b.subject+': ')+'Beaconing pattern',detail:'periodic data sessions — possible C2/automated traffic',sub:b.subject});});
}

async function getStoryXcase(){
  const k=state.data.caseId||'none';if(_storyXcaseCache[k])return _storyXcaseCache[k];
  try{_storyXcaseCache[k]=await API.get('/cross-case/report?case_id='+encodeURIComponent(state.data.caseId||''));}catch(e){_storyXcaseCache[k]={subjects:[]};}
  return _storyXcaseCache[k];
}

function buildStoryNarrative(subject,events){
  if(subject==='__all__'){
    const meetings=events.filter(e=>e.kind==='meeting').length,ids=events.filter(e=>e.kind==='identity').length,xc=events.filter(e=>e.kind==='crosscase').length,ai=events.filter(e=>e.kind==='ai').length;
    let p='This case spans <b>'+n(state.subjects.length)+'</b> subjects and <b>'+n(state.data.records.length)+'</b> records. ';
    if(events.length){const f=events[0],l=events[events.length-1];p+='Notable activity runs from <b>'+_fmtDT(f.ts)+'</b> to <b>'+_fmtDT(l.ts)+'</b>. ';}
    p+='The engine surfaced '+meetings+' co-location meeting'+(meetings===1?'':'s')+', '+ids+' identity change'+(ids===1?'':'s')+', '+xc+' cross-case link'+(xc===1?'':'s')+', and '+ai+' AI finding'+(ai===1?'':'s')+'. ';
    p+='Select a subject above to read their individual story.';
    return '<p>'+p+'</p>';
  }
  const lines=[];
  const first=events.find(e=>e.kind==='first');
  if(first)lines.push('<b>'+subjLabel(subject)+'</b> first appears in this case on <b>'+_fmtDT(first.ts)+'</b> ('+esc(first.detail)+').');
  const ids=events.filter(e=>e.kind==='identity');
  ids.forEach(c=>lines.push('On <b>'+_fmtDT(c.ts)+'</b>, '+esc(c.title.toLowerCase())+' &mdash; '+esc(c.detail)+'.'));
  const contacts=events.filter(e=>e.kind==='call');
  if(contacts.length){const top=contacts[0];lines.push('Communication with <b>'+esc(top.cnt)+'</b> began on <b>'+_fmtDT(top.ts)+'</b>'+(contacts.length>1?', among '+contacts.length+' principal contacts':'')+'.');}
  const data=events.find(e=>e.kind==='data');
  if(data)lines.push('Internet activity '+(first&&data.ts-first.ts>3600000?'shifted online':'is present')+' from <b>'+_fmtDT(data.ts)+'</b> ('+esc(data.detail)+').');
  const moves=events.filter(e=>e.kind==='move');
  if(moves.length)lines.push('The subject was active across <b>'+moves.length+(moves.length>=8?'+':'')+'</b> distinct towers'+(moves[0]?', first at '+esc(moves[0].title.replace('First seen at tower ',''))+' on '+_fmtDT(moves[0].ts):'')+'.');
  const meets=events.filter(e=>e.kind==='meeting');
  if(meets.length){const m=meets[0];lines.push('A co-location was detected with <b>'+esc(m.cnt)+'</b> on <b>'+_fmtDT(m.ts)+'</b> ('+esc(m.detail)+')'+(meets.length>1?', one of '+meets.length+' meetings':'')+'.');}
  const xcs=events.filter(e=>e.kind==='crosscase');
  if(xcs.length)lines.push('<b>Cross-case:</b> this subject also appears in '+xcs.length+' other case'+(xcs.length===1?'':'s')+' &mdash; '+xcs.map(x=>esc(x.title.replace('Also appears in case ',''))).slice(0,4).join(', ')+'.');
  const ais=events.filter(e=>e.kind==='ai');
  ais.forEach(a=>lines.push('<b>AI:</b> '+esc(a.title)+' ('+esc(a.detail)+').'));
  if(!lines.length)return '<p class="story-muted">Not enough data to reconstruct a narrative for this subject.</p>';
  return '<ol class="story-narr-list">'+lines.map(l=>'<li>'+l+'</li>').join('')+'</ol>';
}

async function renderStory(){
  if(!D.storyTimeline)return;
  if(!state.data.records.length){D.storyNarrative.innerHTML='';D.storyTimeline.innerHTML='<div class="story-muted" style="padding:40px;text-align:center">Load a case to reconstruct its story.</div>';populateStorySubjects();updateEvidenceCount();return;}
  populateStorySubjects();
  const subject=D.storySubject.value||'__all__';
  D.storyTimeline.innerHTML='<div class="story-muted" style="padding:30px;text-align:center">Reconstructing the investigation…</div>';
  await ensureMeetingsLoaded();
  try{await getInfReport();}catch(e){}
  _storyEvents=await buildCaseEvents(subject);
  D.storyNarrative.innerHTML='<h4 class="story-narr-h">Case Narrative</h4>'+buildStoryNarrative(subject,_storyEvents);
  renderStoryFilters();
  renderStoryTimeline();
  renderEvidence();
}

function populateStorySubjects(){
  const sel=D.storySubject;if(!sel)return;const cur=sel.value;
  // Count once (O(records)) instead of re-filtering per comparison.
  const cnt={};state.data.records.forEach(r=>{if(r.sub)cnt[r.sub]=(cnt[r.sub]||0)+1;});
  const subs=(state.subjects||[]).slice().sort((a,b)=>(cnt[b]||0)-(cnt[a]||0));
  sel.innerHTML='<option value="__all__">All subjects (case overview)</option>'+subs.slice(0,500).map(s=>'<option value="'+esc(s)+'">'+esc(subjLabelTxt(s))+'</option>').join('');
  if(cur&&[...sel.options].some(o=>o.value===cur))sel.value=cur;else if(subs.length)sel.value=subs[0];
}

function renderStoryFilters(){
  if(!D.storyFilters)return;
  const present=[...new Set(_storyEvents.map(e=>e.kind))];
  if(_storyKinds===null)_storyKinds=new Set(present);
  D.storyFilters.innerHTML=present.map(k=>{const m=EVK[k];const on=_storyKinds.has(k);return '<button class="story-chip'+(on?' on':'')+'" data-k="'+k+'" style="--ec:'+m.c+'">'+m.g+' '+m.l+'</button>';}).join('');
  D.storyFilters.querySelectorAll('.story-chip').forEach(b=>b.onclick=()=>{const k=b.dataset.k;if(_storyKinds.has(k))_storyKinds.delete(k);else _storyKinds.add(k);renderStoryFilters();renderStoryTimeline();});
}

function renderStoryTimeline(){
  const box=D.storyTimeline;if(!box)return;
  const events=_storyEvents.filter(e=>!_storyKinds||_storyKinds.has(e.kind));
  if(!events.length){box.innerHTML='<div class="story-muted" style="padding:30px;text-align:center">No events for the current filter.</div>';return;}
  const pinned=new Set(evLoad().map(x=>x.sig));
  let lastDay='';let h='<div class="story-tl">';
  events.forEach(e=>{
    const day=new Date(e.ts).toLocaleDateString([], {year:'numeric',month:'long',day:'numeric'});
    if(day!==lastDay){h+='<div class="story-day">'+esc(day)+'</div>';lastDay=day;}
    const m=EVK[e.kind];const sig=_evSig(e);const isP=pinned.has(sig);
    h+='<div class="story-ev" style="--ec:'+m.c+'">'
      +'<span class="story-ev-dot" title="'+m.l+'">'+m.g+'</span>'
      +'<div class="story-ev-body"><div class="story-ev-top"><span class="story-ev-time">'+new Date(e.ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})+'</span>'
      +'<span class="story-ev-title">'+esc(e.title)+'</span>'
      +'<button class="story-pin'+(isP?' pinned':'')+'" data-sig="'+esc(sig)+'" title="'+(isP?'In evidence folder':'Add to evidence folder')+'">'+(isP?'★':'☆')+'</button></div>'
      +(e.detail?'<div class="story-ev-detail">'+esc(e.detail)+'</div>':'')
      +(e.sub?'<span class="story-ev-sub" onclick="showProfile(\''+esc(e.sub)+'\')">'+subjLabel(e.sub)+'</span>':'')
      +(e.cnt?' <span class="story-ev-sub" onclick="showProfile(\''+esc(e.cnt)+'\')">'+subjLabel(e.cnt)+'</span>':'')
      +'</div></div>';
  });
  h+='</div>';box.innerHTML=h;
  box.querySelectorAll('.story-pin').forEach(b=>b.onclick=()=>{
    const sig=b.dataset.sig;const e=_storyEvents.find(x=>_evSig(x)===sig);if(!e)return;
    if(evLoad().some(x=>x.sig===sig)){unpinEvidenceBySig(sig);}else{pinEvidence({sig,kind:e.kind,label:e.title,detail:e.detail,ts:e.ts,subject:e.sub||(D.storySubject.value)});}
    renderStoryTimeline();
  });
}

// ---- Evidence folder (per-case, localStorage) ----
// Evidence board + snapshot capture (pin/unpin/capture/refreshCapButtons) -> workspace/evidence.js

if(D.storySubject)D.storySubject.addEventListener('change',renderStory);
if(D.storyRefreshBtn)D.storyRefreshBtn.addEventListener('click',()=>{_storyXcaseCache={};INF.report=null;renderStory();});
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

// ====== 7. SUBJECT PROFILE ======
function showProfile(sub){
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
      ${rows.slice(-10).reverse().map(r=>`<div class="evt" onclick="state.map.instance&&state.map.instance.setView([${r.lat||0},${r.lng||0}],13)"><span class="evt-time">${fmt(r.ts)}</span> <span class="evt-loc">${esc(r.type)} ${esc(r.cnt||'')} ${r.cll||''}</span></div>`).join('')}</div>
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
// ====== SPATIOTEMPORAL INFERENCES ======
// Inference report fetch/cache (getInfReport + INF) -> services/inference.js
// watchlist/exports caches now live in core/state.js (state.watchlist / state.exports)
async function loadWatchlist(){try{const cq=state.data.caseId?'?case_id='+encodeURIComponent(state.data.caseId):'';state.watchlist=await API.get('/watchlist'+cq);}catch(e){state.watchlist=[];}}
async function loadExports(){try{const cq=state.data.caseId?'?case_id='+encodeURIComponent(state.data.caseId):'';state.exports=await API.get('/inference/exports'+cq);}catch(e){state.exports=[];}}
function _exportsHtml(){
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
window.wlAdd=async function(){const i=$('wlInput');const v=(i&&i.value||'').trim();if(!v)return;const g=($('wlGroup')&&$('wlGroup').value||'Default').trim()||'Default';state._lastGroup=g;try{await API.post('/watchlist',{value:v,group_name:g,case_id:state.data.caseId||null});await loadWatchlist();await loadSuspects();INF.cache=null;INF.report=null;renderInferences(true);}catch(e){alert('Failed: '+e.message);}};
window.wlRemove=async function(id){try{await API.del('/watchlist/'+id);await loadWatchlist();await loadSuspects();INF.cache=null;INF.report=null;renderInferences(true);}catch(e){alert('Failed: '+e.message);}};
window.removeFromSuspectGroup=async function(value){
  // Use /watchlist/by-value so removal works regardless of which case the entry was
  // created in — state.watchlist is case-scoped and would miss cross-case suspect entries.
  try{await API.del('/watchlist/by-value?value='+encodeURIComponent(value));}catch(e){toast('Remove failed: '+e.message);return;}
  await loadWatchlist();await loadSuspects();INF.cache=null;INF.report=null;
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
async function renderInferences(force){
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
// ====== FULL INVESTIGATION COMMAND CENTER ======
function toggleInvestModule(headerEl){
  const mod=headerEl.parentElement;
  if(mod)mod.classList.toggle('open');
}
async function runFullInvestigation(){
  const statusEl=document.getElementById('investStatus');
  const summaryEl=document.getElementById('investSummary');
  const modulesEl=document.getElementById('investModules');
  if(!modulesEl)return;
  statusEl.textContent='Running full investigation...';
  modulesEl.style.display='none';
  summaryEl.style.display='none';
  try{
    const r=await API.post('/ai/investigate'+(state.data.caseId?'?case_id='+encodeURIComponent(state.data.caseId):''),{});
    const inv=r.investigation;
    if(!inv){statusEl.textContent='Empty response';return}
    
    // Summary cards
    const s=inv.summary;
    summaryEl.style.display='grid';
    summaryEl.innerHTML=
      '<div class="is-card"><span class="is-label">Records</span><span class="is-value">'+n(s.total_records_analyzed)+'</span></div>'+
      '<div class="is-card"><span class="is-label">CDR/IPDR</span><span class="is-value">'+n(s.cdr_count)+' / '+n(s.ipdr_count)+'</span></div>'+
      '<div class="is-card"><span class="is-label">Subjects</span><span class="is-value">'+n(s.total_subjects)+'</span></div>'+
      '<div class="is-card"><span class="is-label">Towers</span><span class="is-value">'+n(s.total_towers)+'</span></div>'+
      '<div class="is-card"><span class="is-label">Findings</span><span class="is-value '+(s.high_priority_findings>0?'is-warn':'is-success')+'">'+n(s.total_findings)+' <span style="font-size:0.7rem;font-weight:400">('+n(s.high_priority_findings)+' high)</span></span></div>'+
      '<div class="is-card"><span class="is-label">Date Range</span><span class="is-value" style="font-size:0.78rem">'+(s.date_range?.start?fmts(s.date_range.start):'N/A')+'</span></div>'+
      '<div class="is-card"><span class="is-label">Modules</span><span class="is-value">'+n(s.modules_executed)+'</span></div>';
    
    // Render modules
    modulesEl.style.display='flex';
    
    // Findings
    renderFindings(inv.findings);
    renderIdentity(inv.identity_analysis);
    renderAnomalies(inv.anomaly_detection);
    renderSessions(inv.sessions, inv.gap_analysis);
    renderNetwork(inv.social_network, inv.hierarchical_analysis);
    renderLocation(inv.location_intelligence);
    renderCallDetails(inv.call_detail_analysis, inv.communication_patterns);
    renderTemporal(inv.temporal_analysis);
    
    statusEl.textContent='Investigation complete. '+n(s.total_findings)+' findings generated.';
    statusEl.style.color='var(--success)';
  }catch(e){
    console.error('Investigation error:',e);
    statusEl.textContent='Error: '+e.message;
    statusEl.style.color='var(--danger)';
  }
}
function _badge(s,c){return '<span class="if-badge '+c+'">'+esc(s)+'</span>'}
function _sevBadge(s){return _badge(s,s.toLowerCase())}
function _showMoreBtn(id,count,label){
  return '<div class="invest-toggle-row"><button class="invest-toggle-btn" onclick="investToggleMore(\''+id+'\')">Show all '+count+' '+label+' \u25BC</button></div>'+
    '<div id="investMore_'+id+'" style="display:none"></div>';
}
function _investMoreHtml(id,items,fn){
  return '<div style="display:none" id="investMore_'+id+'">'+items.map(fn).join('')+'</div>';
}
var _investMoreData={};
function investToggleMore(id){
  const btn=event.target;
  const container=document.getElementById('investMore_'+id);
  if(!container)return;
  const showing=container.style.display!=='none';
  container.style.display=showing?'none':'block';
  btn.innerHTML=(showing?'Show all ':_investMoreData[id]?.count||'')+' '+(showing?_investMoreData[id]?.label||'':_investMoreData[id]?.label||'')+(showing?' \u25BC':' \u25B2');
  if(!showing && _investMoreData[id] && !container.children.length){
    container.innerHTML=_investMoreData[id].items.map(_investMoreData[id].fn).join('');
  }
}

function renderFindings(f){
  const body=document.getElementById('investFindingsBody');
  const cnt=document.getElementById('investFindingsCount');
  if(!body)return;
  const all=f?.findings||[];
  cnt.textContent=all.length;
  const bySev=f?.by_severity||{};
  const byCat=f?.by_category||{};
  
  // Severity badges row
  let html='<div class="inv-sev-row">'+
    ['Critical','High','Medium','Low'].map(s=>'<span class="inv-sev-badge '+s.toLowerCase()+'">'+s+': '+(bySev[s]||0)+'</span>').join('')+
  '</div>';
  
  // Category summary
  const cats=Object.entries(byCat).sort((a,b)=>b[1]-a[1]);
  if(cats.length){
    html+='<div class="inv-cat-row">'+cats.slice(0,6).map(([c,v])=>_badge(c+': '+v,'medium')).join(' ')+'</div>';
  }
  
  // Top 10 high-severity findings
  const high=all.filter(f=>f.severity==='Critical'||f.severity==='High');
  const top=high.slice(0,10);
  if(top.length){
    html+='<div class="inv-section-label">Top High-Severity Findings</div>';
    html+=top.map(f=>'<div class="invest-finding '+f.severity.toLowerCase()+'">'+
      '<div class="if-title">'+_sevBadge(f.severity)+' '+esc(f.title)+'</div>'+
      '<div class="if-detail">'+
        (f.subject?'<strong>'+esc(f.subject)+'</strong> &middot; ':'')+
        '<em>'+esc(f.category)+'</em> &middot; '+esc(f.detail)+
      '</div></div>').join('');
    if(high.length>10){
      _investMoreData['findings']={count:high.length-10,label:'more high-severity',items:high.slice(10),fn:f=>'<div class="invest-finding '+f.severity.toLowerCase()+'">'+
        '<div class="if-title">'+_sevBadge(f.severity)+' '+esc(f.title)+'</div>'+
        '<div class="if-detail">'+
          (f.subject?'<strong>'+esc(f.subject)+'</strong> &middot; ':'')+
          '<em>'+esc(f.category)+'</em> &middot; '+esc(f.detail)+
        '</div></div>'};
      html+=_showMoreBtn('findings',high.length-10,'more high-severity');
    }
  }
  
  // All findings count note
  if(all.length>10){
    html+='<div style="margin-top:6px;font-size:0.72rem;color:var(--muted);text-align:center">'+all.length+' total findings across '+(cats.length)+' categories. '+
      (f?.executive_summary?esc(f.executive_summary):'')+'</div>';
  }
  body.innerHTML=html||'<div class="invest-msg">No findings.</div>';
}

function renderIdentity(id){
  const body=document.getElementById('investIdentityBody');
  const cnt=document.getElementById('investIdentityCount');
  if(!body)return;
  const subs=id?.by_subject||{};
  const keys=Object.keys(subs);
  cnt.textContent=keys.length;
  const burners=Object.entries(subs).filter(([,d])=>d.is_suspected_burner);
  const swaps=Object.entries(subs).filter(([,d])=>d.sim_swaps?.length);
  const devices=Object.entries(subs).filter(([,d])=>d.device_changes?.length);
  const totalSimSwaps=id?.total_sim_swaps||0;
  const totalDeviceChanges=id?.total_device_changes||0;
  
  let html='<div class="inv-sev-row">'+
    '<span class="inv-sev-badge high">Burners: '+burners.length+'</span>'+
    '<span class="inv-sev-badge high">SIM Swaps: '+totalSimSwaps+'</span>'+
    '<span class="inv-sev-badge medium">Device Changes: '+totalDeviceChanges+'</span>'+
    '<span class="inv-sev-badge low">Analyzed: '+keys.length+'</span>'+
  '</div>';
  
  // Top 15 most suspicious subjects (sorted by burner score desc)
  const sorted=Object.entries(subs).sort((a,b)=>b[1].burner_score-a[1].burner_score);
  const top=sorted.slice(0,15);
  html+='<div class="inv-section-label">Most Suspicious Subjects</div>';
  html+=top.map(([sub,d])=>{
    const isBurner=d.is_suspected_burner;
    return '<div class="invest-finding '+(isBurner?'high':'low')+'">'+
      '<div class="if-title">'+
        _badge(isBurner?'BURNER':'Normal',isBurner?'high':'low')+' '+esc(sub)+
        ' <span class="if-detail" style="font-weight:400">Score: '+d.burner_score+'% | '+d.unique_imei+' IMEI | '+d.unique_imsi+' IMSI | '+d.total_transitions+' changes</span>'+
      '</div>'+
      (d.findings?.length?'<div class="if-detail">'+d.findings.slice(0,3).map(f=>'<span style="color:var(--warn)">&#9656; '+esc(f)+'</span><br>').join('')+'</div>':'')+
      (d.sim_swaps?.length?'<div class="if-detail" style="margin-top:2px"><strong style="color:var(--danger);font-size:0.7rem">SIM Swaps:</strong> '+d.sim_swaps.map(s=>'<span class="inv-tag inv-tag-danger">'+fmts(s.timestamp)+'</span>').join('')+'</div>':'')+
      (d.device_changes?.length?'<div class="if-detail" style="margin-top:2px"><strong style="color:var(--warn);font-size:0.7rem">Device Changes:</strong> '+d.device_changes.slice(0,3).map(s=>'<span class="inv-tag inv-tag-warn">'+fmts(s.timestamp)+'</span>').join('')+'</div>':'')+
    '</div>';
  }).join('');
  
  if(sorted.length>15){
    _investMoreData['identity']={count:sorted.length-15,label:'subjects',items:sorted.slice(15),fn:([sub,d])=>{
      const isBurner=d.is_suspected_burner;
      return '<div class="invest-finding '+(isBurner?'high':'low')+'">'+
        '<div class="if-title">'+
          _badge(isBurner?'BURNER':'Normal',isBurner?'high':'low')+' '+esc(sub)+
          ' <span class="if-detail" style="font-weight:400">Score: '+d.burner_score+'% | '+d.unique_imei+' IMEI | '+d.unique_imsi+' IMSI | '+d.total_transitions+' changes</span>'+
        '</div></div>';
    }};
    html+=_showMoreBtn('identity',sorted.length-15,'subjects');
  }
  body.innerHTML=html||'<div class="invest-msg">No identity data.</div>';
}

function renderAnomalies(an){
  const body=document.getElementById('investAnomalyBody');
  const cnt=document.getElementById('investAnomalyCount');
  if(!body)return;
  const list=an?.anomalies||[];
  cnt.textContent=list.length;
  
  let html='<div class="inv-sev-row">'+
    '<span class="inv-sev-badge high">High: '+(an?.high_severity_count||0)+'</span>'+
    '<span class="inv-sev-badge medium">Medium: '+(an?.medium_severity_count||0)+'</span>'+
    '<span class="inv-sev-badge low">Total: '+list.length+'</span>'+
  '</div>';
  
  // Group by type
  const grouped={};
  list.forEach(a=>{if(!grouped[a.type])grouped[a.type]=[];grouped[a.type].push(a);});
  
  Object.entries(grouped).forEach(([type,items],idx)=>{
    const highCount=items.filter(a=>a.severity==='High').length;
    html+='<div class="inv-section-label">'+esc(type)+' <span class="if-detail">('+items.length+' total'+(highCount?', '+highCount+' high':'')+')</span></div>';
    const show=items.slice(0,8);
    html+=show.map(a=>'<div class="invest-anom '+a.severity.toLowerCase()+'">'+
      '<span class="anom-subj">'+esc(a.subject)+'</span> '+
      '<span class="anom-detail">'+esc(a.detail)+'</span>'+
    '</div>').join('');
    if(items.length>8){
      _investMoreData['anom_'+idx]={count:items.length-8,label:'anomalies',items:items.slice(8),fn:a=>'<div class="invest-anom '+a.severity.toLowerCase()+'">'+
        '<span class="anom-subj">'+esc(a.subject)+'</span> <span class="anom-detail">'+esc(a.detail)+'</span></div>'};
      html+=_showMoreBtn('anom_'+idx,items.length-8,'anomalies');
    }
  });
  body.innerHTML=html||'<div class="invest-msg">No anomalies detected.</div>';
}

function renderSessions(sess, gap){
  const body=document.getElementById('investSessionsBody');
  const cnt=document.getElementById('investSessionsCount');
  if(!body)return;
  const subs=sess?.by_subject||{};
  const keys=Object.keys(subs);
  cnt.textContent=keys.length;
  const gapsBySubject=gap?.by_subject||{};
  
  if(!keys.length){body.innerHTML='<div class="invest-msg">No session data.</div>';return;}
  
  // Aggregate stats
  let totalSessions=0,totalGaps24h=0,subsWithGaps24h=0;
  keys.forEach(k=>{
    totalSessions+=subs[k].total_sessions;
    if(subs[k].gaps_above_24h>0)subsWithGaps24h++;
    totalGaps24h+=subs[k].gaps_above_24h||0;
  });
  
  let html='<div class="inv-sev-row">'+
    '<span class="inv-sev-badge low">Subjects: '+keys.length+'</span>'+
    '<span class="inv-sev-badge low">Sessions: '+totalSessions+'</span>'+
    '<span class="inv-sev-badge '+(totalGaps24h>0?'warn':'low')+'">Gaps >24h: '+totalGaps24h+'</span>'+
    '<span class="inv-sev-badge '+(subsWithGaps24h>0?'warn':'low')+'">Affected Subjects: '+subsWithGaps24h+'</span>'+
  '</div>';
  
  // Top subjects by gaps >24h
  const sorted=keys.filter(k=>subs[k].gaps_above_24h>0).sort((a,b)=>subs[b].gaps_above_24h-subs[a].gaps_above_24h);
  if(sorted.length){
    html+='<div class="inv-section-label">Subjects with Notable Gaps (sorted by gaps >24h)</div>';
    html+='<table class="inv-compact-table"><tr><th>Subject</th><th>Sessions</th><th>Avg Gap</th><th>Gaps &gt;24h</th><th>Max Gap</th></tr>';
    const show=sorted.slice(0,15);
    show.forEach(k=>{
      const s=subs[k];
      html+='<tr'+(s.gaps_above_24h>3?' class="inv-row-warn"':'')+'>'+
        '<td><strong>'+esc(k)+'</strong></td>'+
        '<td>'+n(s.total_sessions)+'</td>'+
        '<td>'+(s.avg_gap_between_sessions_minutes?Math.round(s.avg_gap_between_sessions_minutes)+'m':'—')+'</td>'+
        '<td>'+(s.gaps_above_24h||0)+'</td>'+
        '<td>'+(s.max_gap_minutes?Math.round(s.max_gap_minutes/60)+'h':'—')+'</td></tr>';
    });
    html+='</table>';
    if(sorted.length>15){
      _investMoreData['sessions']={count:sorted.length-15,label:'subjects',items:sorted.slice(15),fn:k=>{
        const s=subs[k];
        return '<tr'+(s.gaps_above_24h>3?' class="inv-row-warn"':'')+'>'+
          '<td><strong>'+esc(k)+'</strong></td>'+
          '<td>'+n(s.total_sessions)+'</td>'+
          '<td>'+(s.avg_gap_between_sessions_minutes?Math.round(s.avg_gap_between_sessions_minutes)+'m':'—')+'</td>'+
          '<td>'+(s.gaps_above_24h||0)+'</td>'+
          '<td>'+(s.max_gap_minutes?Math.round(s.max_gap_minutes/60)+'h':'—')+'</td></tr>';
      }};
      html+=_showMoreBtn('sessions',sorted.length-15,'subjects');
    }
  }
  
  if(gap?.subjects_with_gaps){
    html+='<div style="margin-top:6px;font-size:0.72rem;color:var(--muted)">'+n(gap.subjects_with_gaps)+' subject(s) with network gaps detected.'+(gap.global_finding?.length?' '+esc(gap.global_finding.join(' ')):'')+'</div>';
  }
  body.innerHTML=html;
}

function renderNetwork(net, hier){
  const body=document.getElementById('investNetworkBody');
  const cnt=document.getElementById('investNetworkCount');
  if(!body)return;
  cnt.textContent=net?.nodes||0;
  
  if(!net?.nodes){body.innerHTML='<div class="invest-msg">No network data.</div>';return;}
  
  // Role distribution
  const roles=net.structural_roles||{};
  const roleCounts={};
  Object.values(roles).forEach(r=>{roleCounts[r.inferred_role]=(roleCounts[r.inferred_role]||0)+1;});
  
  let html='<div class="inv-sev-row">'+
    '<span class="inv-sev-badge low">Nodes: '+n(net.nodes)+'</span>'+
    '<span class="inv-sev-badge low">Edges: '+n(net.edges)+'</span>'+
    '<span class="inv-sev-badge low">Density: '+net.density+'</span>'+
    '<span class="inv-sev-badge low">Reciprocity: '+net.reciprocity+'</span>'+
    '<span class="inv-sev-badge '+(net.total_bridges>0?'warn':'low')+'">Bridges: '+n(net.total_bridges)+'</span>'+
  '</div>';
  
  // Role distribution
  html+='<div class="inv-role-dist">'+Object.entries(roleCounts).map(([role,count])=>{
    const cls=role.includes('Broker')||role.includes('Hub')?'warn':role.includes('Core')?'medium':'low';
    return _badge(role+': '+count,cls);
  }).join(' ')+'</div>';
  
  // Centrality table (top 15)
  html+='<div class="inv-section-label">Top Nodes by Degree Centrality</div>';
  html+='<table class="inv-compact-table"><tr><th>Node</th><th>Role</th><th>Degree</th><th>Betweenness</th><th>k-Core</th></tr>';
  const sorted=Object.entries(roles).sort((a,b)=>b[1].degree_centrality-a[1].degree_centrality);
  sorted.slice(0,15).forEach(([node,r])=>{
    const cls=r.inferred_role.includes('Broker')||r.inferred_role.includes('Hub')?'inv-row-warn':'';
    html+='<tr class="'+cls+'"><td><strong>'+esc(node)+'</strong></td><td>'+r.inferred_role+'</td><td>'+r.degree_centrality+'</td><td>'+r.betweenness_centrality+'</td><td>'+r.k_core+'</td></tr>';
  });
  html+='</table>';
  
  // Critical bridges as compact cards
  if(net.critical_bridges?.length){
    html+='<div class="inv-section-label">Critical Bridges ('+net.critical_bridges.length+')</div>';
    html+='<div class="inv-bridge-row">';
    net.critical_bridges.slice(0,5).forEach(b=>{
      html+='<div class="inv-bridge-card"><strong>'+esc(b.from)+'</strong> &#8596; <strong>'+esc(b.to)+'</strong><br><span class="if-detail">'+n(b.weight)+' interactions</span></div>';
    });
    html+='</div>';
  }
  
  // Hierarchy summary
  if(hier?.command_chain_summary){
    html+='<div class="inv-section-label">Organization</div>';
    html+='<div style="font-size:0.78rem;padding:4px 0">'+esc(hier.command_chain_summary);
    if(hier.checkin_patterns?.length){
      html+='<br><span class="if-detail">'+hier.checkin_patterns.length+' check-in patterns detected</span>';
    }
    html+='</div>';
  }
  body.innerHTML=html;
}

function renderLocation(loc){
  const body=document.getElementById('investLocationBody');
  const cnt=document.getElementById('investLocationCount');
  if(!body)return;
  const subs=loc?.by_subject||{};
  const keys=Object.keys(subs);
  cnt.textContent=keys.length;
  const hotspots=loc?.geo_hotspots||[];
  
  if(!keys.length){body.innerHTML='<div class="invest-msg">No location data.</div>';return;}
  
  let html='<div class="inv-sev-row">'+
    '<span class="inv-sev-badge low">Subjects: '+keys.length+'</span>'+
    '<span class="inv-sev-badge low">Hotspots: '+hotspots.length+'</span>'+
  '</div>';
  
  // Hotspots table
  if(hotspots.length){
    html+='<div class="inv-section-label">Top Activity Hotspots</div>';
    html+='<table class="inv-compact-table"><tr><th>Tower</th><th>Visits</th><th>Subjects</th></tr>';
    hotspots.slice(0,10).forEach(h=>{
      html+='<tr><td><strong>'+esc(h.tower_id)+'</strong></td><td>'+n(h.total_visits)+'</td><td>'+n(h.unique_subjects)+'</td></tr>';
    });
    html+='</table>';
  }
  
  // Subjects with widest range
  const withRadius=Object.entries(subs).filter(([,d])=>d.radius_of_operation_km).sort((a,b)=>b[1].radius_of_operation_km-a[1].radius_of_operation_km);
  if(withRadius.length){
    html+='<div class="inv-section-label">Widest Operational Range</div>';
    withRadius.slice(0,10).forEach(([sub,d])=>{
      html+='<div class="invest-finding low"><div class="if-title">'+esc(sub)+'</div><div class="if-detail">'+
        d.radius_of_operation_km+'km radius &middot; '+d.total_locations+' towers &middot; Entropy: '+d.location_entropy+' ('+d.location_predictability+')'+
      '</div></div>';
    });
  }
  body.innerHTML=html;
}

function renderCallDetails(call, comm){
  const body=document.getElementById('investCallBody');
  const cnt=document.getElementById('investCallCount');
  if(!body)return;
  const subs=call?.by_subject||{};
  const keys=Object.keys(subs);
  cnt.textContent=keys.length;
  const circles=comm?.calling_circles||[];
  
  if(!keys.length){body.innerHTML='<div class="invest-msg">No call data.</div>';return;}
  
  // Aggregate suspicious counts
  let shortCalls=0, oddCalls=0, bursts=0;
  Object.values(subs).forEach(d=>{shortCalls+=d.short_signal_calls||0; oddCalls+=d.odd_hour_calls||0; bursts+=d.call_bursts||0;});
  
  let html='<div class="inv-sev-row">'+
    '<span class="inv-sev-badge low">Pairs: '+n(comm?.total_pairs_analyzed||0)+'</span>'+
    '<span class="inv-sev-badge '+(shortCalls>0?'warn':'low')+'">Signal Calls: '+shortCalls+'</span>'+
    '<span class="inv-sev-badge '+(oddCalls>0?'warn':'low')+'">Odd-Hour: '+oddCalls+'</span>'+
    '<span class="inv-sev-badge '+(bursts>0?'warn':'low')+'">Bursts: '+bursts+'</span>'+
    '<span class="inv-sev-badge low">Circles: '+circles.length+'</span>'+
  '</div>';
  
  // Calling circles
  if(circles.length){
    html+='<div class="inv-section-label">Calling Circles (3-way mutual communication)</div>';
    html+='<div class="inv-circle-row">';
    circles.slice(0,10).forEach(c=>{
      html+='<div class="inv-circle-card">'+
        c.members.map(m=>esc(m)).join(' &#8644; ')+
        '<br><span class="if-detail">'+n(c.total_calls_between)+' calls</span></div>';
    });
    html+='</div>';
  }
  
  // Top suspicious subjects
  const suspicious=Object.entries(subs).filter(([,d])=>d.short_signal_calls>0||d.odd_hour_calls>0||d.call_bursts>0)
    .sort((a,b)=>(b.short_signal_calls+b.odd_hour_calls+b.call_bursts)-(a.short_signal_calls+a.odd_hour_calls+a.call_bursts));
  if(suspicious.length){
    html+='<div class="inv-section-label">Suspicious Calling Patterns</div>';
    suspicious.slice(0,12).forEach(([sub,d])=>{
      const cp=comm?.by_subject?.[sub]||{};
      html+='<div class="invest-anom high">'+
        '<span class="anom-subj">'+esc(sub)+'</span> '+
        '<span class="anom-detail">In:'+n(cp.incoming||0)+' Out:'+n(cp.outgoing||0)+' Avg:'+(cp.avg_duration_seconds?Math.round(cp.avg_duration_seconds)+'s':'—')+'</span>'+
        (d.short_signal_calls?' <span class="inv-tag inv-tag-warn">'+d.short_signal_calls+' short</span>':'')+
        (d.odd_hour_calls?' <span class="inv-tag inv-tag-warn">'+d.odd_hour_calls+' odd-hr</span>':'')+
        (d.call_bursts?' <span class="inv-tag inv-tag-danger">'+d.call_bursts+' bursts</span>':'')+
      '</div>';
    });
  }
  body.innerHTML=html;
}

function renderTemporal(temp){
  const body=document.getElementById('investTemporalBody');
  const cnt=document.getElementById('investTemporalCount');
  if(!body)return;
  const profiles=temp?.subject_profiles||{};
  const pkeys=Object.keys(profiles);
  cnt.textContent=pkeys.length;
  
  if(!temp?.total_records){body.innerHTML='<div class="invest-msg">No temporal data.</div>';return;}
  
  const dr=temp.date_range||{};
  let html='<div class="inv-sev-row">'+
    '<span class="inv-sev-badge low">Records: '+n(temp.total_records)+'</span>'+
    '<span class="inv-sev-badge low">Span: '+(dr.span_days?n(dr.span_days)+'d':'—')+'</span>'+
    '<span class="inv-sev-badge '+(temp.night_activity_ratio>0.3?'warn':'low')+'">Night: '+Math.round((temp.night_activity_ratio||0)*100)+'%</span>'+
    '<span class="inv-sev-badge '+(temp.activity_trend==='increasing'?'warn':temp.activity_trend==='decreasing'?'success':'low')+'">Trend: '+temp.activity_trend+'</span>'+
    '<span class="inv-sev-badge low">Peak: '+(temp.most_active_hour!=null?temp.most_active_hour+':00':'—')+'</span>'+
  '</div>';
  
  // Day-of-week
  if(temp.day_of_week){
    html+='<div class="inv-section-label">Activity by Day</div><div class="inv-dow-row">';
    Object.entries(temp.day_of_week).forEach(([d,c])=>{
      const pct=Math.round(c/temp.total_records*100);
      html+='<span class="inv-dow-badge">'+d.substring(0,3)+': '+n(c)+' ('+pct+'%)</span>';
    });
    html+='</div>';
  }
  
  // Night owls
  const nightOwls=Object.entries(profiles).filter(([,p])=>p.is_night_owl).sort((a,b)=>b[1].night_activity_pct-a[1].night_activity_pct);
  if(nightOwls.length){
    html+='<div class="inv-section-label">Night-Dominant Subjects ('+nightOwls.length+')</div>';
    nightOwls.slice(0,15).forEach(([sub,p])=>{
      html+='<div class="invest-anom warn"><span class="anom-subj">'+esc(sub)+'</span> <span class="anom-detail">'+p.night_activity_pct+'% night &middot; Profile: '+p.profile+' &middot; Peak: '+(p.peak_hour>=0?p.peak_hour+':00':'—')+'</span></div>';
    });
    if(nightOwls.length>15){
      _investMoreData['temporal']={count:nightOwls.length-15,label:'night-dominant subjects',items:nightOwls.slice(15),fn:([sub,p])=>
        '<div class="invest-anom warn"><span class="anom-subj">'+esc(sub)+'</span> <span class="anom-detail">'+p.night_activity_pct+'% night &middot; Profile: '+p.profile+'</span></div>'
      };
      html+=_showMoreBtn('temporal',nightOwls.length-15,'night-dominant subjects');
    }
  }
  body.innerHTML=html;
}
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

// ====== COURT-READY DOSSIER ======
// Compose a styled, print-optimized case dossier from data already loaded in `state`, then let the
// investigator Print → Save as PDF. Air-gapped/offline: no PDF library, no external calls beyond
// our own endpoints. Generating a dossier is logged (ExportLog + AuditLog) with an official ref.
if(D.dossierBtn)D.dossierBtn.addEventListener('click',renderDossier);
if(D.dossierCloseBtn)D.dossierCloseBtn.addEventListener('click',()=>{D.dossier.style.display='none'});
if(D.dossierPrintBtn)D.dossierPrintBtn.addEventListener('click',()=>window.print());
{const ab=document.getElementById('dossierAgencyBtn');if(ab)ab.addEventListener('click',setAgencyDetails);}
{const rb=document.getElementById('dossierRegenBtn');if(rb)rb.addEventListener('click',()=>{_storyXcaseCache={};INF.report=null;meetingsCache.v=null;renderDossier();});}

// All-seeing-eye seal (Argus Panoptes) rendered in monochrome navy so it prints cleanly.
const ARGUS_EMBLEM='<svg class="dc-emblem" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-label="ARGUS emblem">'
  +'<circle cx="50" cy="50" r="47" fill="#fff" stroke="#16284a" stroke-width="2"/>'
  +'<circle cx="50" cy="50" r="41" fill="none" stroke="#16284a" stroke-width="0.9"/>'
  +'<path d="M16 50 Q50 26 84 50 Q50 74 16 50 Z" fill="none" stroke="#16284a" stroke-width="2.6"/>'
  +'<circle cx="50" cy="50" r="11" fill="#16284a"/><circle cx="50" cy="50" r="4.2" fill="#fff"/>'
  +'<g stroke="#16284a" stroke-width="1.7" stroke-linecap="round">'
  +'<path d="M50 16 V7"/><path d="M50 84 V93"/><path d="M16 50 H7"/><path d="M84 50 H93"/>'
  +'<path d="M27 27 L21 21"/><path d="M73 27 L79 21"/><path d="M27 73 L21 79"/><path d="M73 73 L79 79"/></g></svg>';

function getAgency(){try{return JSON.parse(localStorage.getItem('argus_agency')||'{}')||{}}catch(e){return{}}}
function setAgencyDetails(){
  const a=getAgency();
  const name=prompt('Agency / unit name for the dossier letterhead:',a.name||'');if(name===null)return;
  const sub=prompt('Sub-line (e.g. "Telecom Forensics Unit · Cyber Crime Cell"):',a.sub||'');if(sub===null)return;
  const logo=prompt('Optional logo image URL or /static path (blank = ARGUS emblem):',a.logo||'');if(logo===null)return;
  localStorage.setItem('argus_agency',JSON.stringify({name:name.trim(),sub:(sub||'').trim(),logo:(logo||'').trim()}));
  alert('Saved. Regenerate the dossier to apply.');
}

async function renderDossier(){
  if(!state.data.records.length){alert('Load a case first — there is nothing to put in a dossier yet.');return}
  const prev=D.dossierBtn.textContent;D.dossierBtn.textContent='Building…';D.dossierBtn.disabled=true;
  try{
    const caseName=(D.caseSelector.options[D.caseSelector.selectedIndex]?.text||'None').replace(/\s*\(\d+\)\s*$/,'');
    const officer=state.auth&&state.auth.user?state.auth.user.username:'Unknown';
    const role=state.auth&&state.auth.user?state.auth.user.role:'';
    const now=new Date();
    const ag=getAgency();
    const agencyName=(ag.name||'LAW ENFORCEMENT AGENCY').toUpperCase();
    const agencySub=ag.sub||'Telecom Forensics Unit';
    const CLASS='RESTRICTED — FOR OFFICIAL USE ONLY';
    // Official reference id + chain-of-custody log (best-effort; dossier still renders if it fails).
    let ref='';let serverCase=caseName;
    try{const r=await API.post('/inference/dossier'+(state.data.caseId?'?case_id='+encodeURIComponent(state.data.caseId):''),{});if(r){ref=r.ref||'';if(r.case_name)serverCase=r.case_name;}}catch(e){}
    if(!ref)ref='ARGUS-EVD-'+now.toISOString().slice(0,10).replace(/-/g,'')+'-LOCAL';

    // Ensure analytical inputs are loaded for the narrative / summary.
    try{await ensureMeetingsLoaded();}catch(e){}
    try{await getInfReport();}catch(e){}
    const xrep=await getStoryXcase();

    const ts=state.data.records.filter(r=>r.ts).map(r=>new Date(r.ts).getTime()).filter(t=>!isNaN(t));
    const minD=ts.length?new Date(Math.min(...ts)):null,maxD=ts.length?new Date(Math.max(...ts)):null;
    const dr=ts.length?(minD.toLocaleString()+'  —  '+maxD.toLocaleString()):'—';
    const spanDays=ts.length?Math.max(1,Math.round((Math.max(...ts)-Math.min(...ts))/86400000)):0;

    // Per-subject rollup.
    const subStat={};
    state.data.records.forEach(r=>{const s=r.sub;if(!s)return;const o=subStat[s]||(subStat[s]={n:0,c:new Set(),t:new Set(),type:r.type});o.n++;if(r.cnt&&r.cnt!==s)o.c.add(r.cnt);if(r.tow)o.t.add(r.tow);});
    const subjects=Object.entries(subStat).map(([s,o])=>({s,n:o.n,c:o.c.size,t:o.t.size,type:o.type})).sort((a,b)=>b.n-a.n);
    const topSub=subjects.length?subjects[0].s:null;
    const caseTowerN=new Set(state.data.records.filter(r=>r.tow).map(r=>r.tow)).size; // towers in THIS case (not the global repo)
    const topCnt=Object.entries(state.data.records.reduce((a,r)=>{if(r.cnt&&r.cnt!==r.sub){a[r.cnt]=(a[r.cnt]||0)+1}return a},{})).sort((a,b)=>b[1]-a[1]).slice(0,15);

    const mt=(typeof meetingTotals==='function')?meetingTotals():{total:0};
    const xcount=(xrep&&xrep.subjects)?xrep.subjects.length:0;
    const rep=INF.report||{};const poi=((rep.cdr&&rep.cdr.risk)||[]).filter(r=>r.band==='Critical'||r.band==='High').length;
    const imposs=((rep.cdr&&rep.cdr.impossible_travel)||[]).length;
    const ev=evLoad();

    let h='';
    // ── Cover / letterhead ──
    const logoHtml=ag.logo?('<img class="dc-emblem" src="'+esc(ag.logo)+'" alt="agency logo">'):ARGUS_EMBLEM;
    h+='<section class="dossier-cover">'
      +'<div class="dc-class-top">'+CLASS+'</div>'
      +'<div class="dc-letterhead">'+logoHtml
        +'<div class="dc-agency"><div class="dc-agency-name">'+esc(agencyName)+'</div><div class="dc-agency-sub">'+esc(agencySub)+'</div>'
        +'<div class="dc-agency-tool">Project ARGUS · CDR / IPDR Forensic Analysis Platform</div></div></div>'
      +'<div class="dc-rule"></div>'
      +'<div class="dc-doctype">CASE ANALYSIS DOSSIER</div>'
      +'<h1 class="dc-title">'+esc(serverCase)+'</h1>'
      +'<table class="dc-meta">'
      +'<tr><td>Document reference</td><td><b>'+esc(ref)+'</b></td></tr>'
      +'<tr><td>Case</td><td>'+esc(serverCase)+(state.data.caseId?' (ID '+esc(state.data.caseId)+')':'')+'</td></tr>'
      +'<tr><td>Prepared by</td><td>'+esc(officer)+(role?' ('+esc(role)+')':'')+'</td></tr>'
      +'<tr><td>Date / time generated</td><td>'+esc(now.toLocaleString())+'</td></tr>'
      +'<tr><td>Evidence window</td><td>'+esc(dr)+'</td></tr>'
      +'<tr><td>Records examined</td><td>'+n(_totalCdrFn()+_totalIpdrFn())+' ('+n(_totalCdrFn())+' CDR, '+n(_totalIpdrFn())+' IPDR)</td></tr>'
      +'<tr><td>Subjects / towers</td><td>'+n(state.subjects.length)+' subjects · '+n(caseTowerN)+' towers in this case</td></tr>'
      +'<tr><td>Classification</td><td>'+CLASS+'</td></tr>'
      +'</table>'
      +'<div class="dc-control"><b>Document control.</b> This dossier was generated programmatically by Project ARGUS from the telecom records loaded into the named case under reference <b>'+esc(ref)+'</b>, which is recorded in the system audit log (chain of custody). It is an investigative aid and does not by itself constitute proof; all findings should be corroborated with the underlying CDR/IPDR records and primary evidence before being relied upon in proceedings.</div>'
      +'<div class="dc-class-bottom">'+CLASS+'</div>'
      +'</section>';

    // ── Analytical inputs (case-specific) ──
    const repC=(rep.cdr)||{},repI=(rep.ipdr)||{};
    const riskMap={};(repC.risk||[]).forEach(r=>{riskMap[r.subject]={score:r.score,band:r.band,kind:'phone'}});(repI.risk||[]).forEach(r=>{if(!riskMap[r.subject])riskMap[r.subject]={score:r.score,band:r.band,kind:'ip'}});
    // Persons of interest: risk-ranked, falling back to activity.
    const poiList=subjects.slice().sort((a,b)=>((riskMap[b.s]?riskMap[b.s].score:0)-(riskMap[a.s]?riskMap[a.s].score:0))||(b.n-a.n)).slice(0,8);
    // Case-only towers (distinct tower_ids appearing in THIS case's records) with activity counts.
    const tm=towerMeta();const towCount={};state.data.records.forEach(r=>{if(r.tow)towCount[r.tow]=(towCount[r.tow]||0)+1;});
    const caseTowers=Object.entries(towCount).map(([tw,c])=>({tw,c,city:(tm[tw]||{}).city,state:(tm[tw]||{}).state})).sort((a,b)=>b.c-a.c);
    // Identity changes across subjects (SIM / handset swaps).
    const idChanges=[];(state.subjects||[]).slice(0,400).forEach(s=>{try{(buildIdentityProfile(s).changes||[]).forEach(c=>idChanges.push({sub:s,time:c.time,detail:c.detail,from:c.from,to:c.to,confidence:c.confidence}))}catch(e){}});
    idChanges.sort((a,b)=>new Date(a.time)-new Date(b.time));
    const meetingsList=((meetingsCache.v&&meetingsCache.v.list)||[]).slice().sort((a,b)=>b.score-a.score);
    const impossible=(repC.impossible_travel||[]);
    const hidden=(repC.co_presence||[]).filter(p=>p.hidden_link||p.convoy);

    // ── Table of contents ──
    h+='<section class="dossier-section"><h2>Contents</h2><ol class="dossier-toc">'
      +'<li>Executive Summary</li><li>Case Narrative</li><li>Persons of Interest</li>'
      +'<li>Key Findings</li><li>Communication Analysis</li><li>Cross-Case Links</li>'
      +'<li>Bookmarked Evidence</li><li>Analytical Charts</li><li>Towers in this Case</li>'
      +'<li>Appendix A — Methodology &amp; Limitations</li></ol></section>';

    // ── 1. Executive summary ──
    const headline=[];
    if(poi)headline.push(n(poi)+' person(s) of interest at High/Critical risk');
    if(mt.total)headline.push(n(mt.total)+' co-location meeting(s)');
    if(imposs)headline.push(n(imposs)+' impossible-travel flag(s)');
    if(idChanges.length)headline.push(n(idChanges.length)+' identity change(s)');
    if(xcount)headline.push(n(xcount)+' subject(s) linked to other cases');
    if(hidden.length)headline.push(n(hidden.length)+' hidden link/convoy pattern(s)');
    h+='<section class="dossier-section"><h2>1. Executive Summary</h2>'
      +'<p class="d-app">This case comprises <b>'+n(_totalCdrFn()+_totalIpdrFn())+'</b> telecom records ('+n(_totalCdrFn())+' CDR, '+n(_totalIpdrFn())+' IPDR) across <b>'+n(state.subjects.length)+'</b> subjects over <b>'+n(spanDays)+'</b> day(s) ('+esc(dr)+'). '
      +(headline.length?'Automated analysis surfaced: '+headline.join('; ')+'.':'No high-severity anomalies were automatically flagged.')+'</p>'
      +'<table class="d-kv">'
      +'<tr><td>Evidence window</td><td>'+esc(dr)+' ('+n(spanDays)+' day'+(spanDays===1?'':'s')+')</td></tr>'
      +'<tr><td>Records examined</td><td>'+n(_totalCdrFn()+_totalIpdrFn())+' — '+n(_totalCdrFn())+' CDR, '+n(_totalIpdrFn())+' IPDR</td></tr>'
      +'<tr><td>Distinct subjects / case towers</td><td>'+n(state.subjects.length)+' subjects · '+n(caseTowers.length)+' towers touched</td></tr>'
      +'<tr><td>Persons of interest (High/Critical)</td><td>'+n(poi)+'</td></tr>'
      +'<tr><td>Co-location meetings</td><td>'+n(mt.total||0)+'</td></tr>'
      +'<tr><td>Impossible-travel flags</td><td>'+n(imposs)+'</td></tr>'
      +'<tr><td>Identity changes (SIM/handset)</td><td>'+n(idChanges.length)+'</td></tr>'
      +'<tr><td>Subjects linked to other cases</td><td>'+n(xcount)+'</td></tr>'
      +'<tr><td>Bookmarked evidence items</td><td>'+n(ev.length)+'</td></tr>'
      +'</table></section>';

    // ── 2. Case narrative ──
    let narr='';
    try{if(topSub){const evs=await buildCaseEvents(topSub);narr='<p class="d-narr-lead">Principal subject (by activity): <b>'+esc(topSub)+'</b>.</p>'+buildStoryNarrative(topSub,evs);}else{narr=buildStoryNarrative('__all__',[]);}}catch(e){narr='<div class="d-note">Narrative unavailable.</div>';}
    h+='<section class="dossier-section"><h2>2. Case Narrative</h2><div class="d-narr">'+narr+'</div>'
      +'<div class="d-note">Auto-reconstructed from the chronological record. See the Story tab for the full timeline and other subjects.</div></section>';

    // ── 3. Persons of interest (detailed) ──
    h+='<section class="dossier-section"><h2>3. Persons of Interest</h2>';
    // Prefetch subscriber (SDR) identities for the profiled POIs.
    let _sdrMap={};
    try{const fs2=await Promise.all(poiList.map(p=>API.get('/subscribers/'+encodeURIComponent(p.s)).catch(()=>null)));poiList.forEach((p,idx)=>{const f=fs2[idx];if(f&&f.found)_sdrMap[p.s]=f;});}catch(e){}
    if(poiList.length){
      poiList.forEach((p,i)=>{
        const sub=p.s;const rk=riskMap[sub];
        const owned=state.data.records.filter(r=>r.ts&&(r.sub===sub||r.msisdn===sub));
        const tms=rowsFor(sub).filter(r=>r.ts).map(r=>new Date(r.ts).getTime());
        const fs=tms.length?new Date(Math.min(...tms)):null,ls=tms.length?new Date(Math.max(...tms)):null;
        let idents=[],changes=[];try{const ip=buildIdentityProfile(sub);idents=ip.identities||[];changes=ip.changes||[];}catch(e){}
        const cc={};owned.filter(r=>r.cnt&&r.cnt!==sub).forEach(r=>cc[r.cnt]=(cc[r.cnt]||0)+1);
        const topc=Object.entries(cc).sort((a,b)=>b[1]-a[1]).slice(0,5);
        const tc={};owned.forEach(r=>{if(r.tow)tc[r.tow]=(tc[r.tow]||0)+1});
        const topt=Object.entries(tc).sort((a,b)=>b[1]-a[1]).slice(0,5);
        const mts=meetingsList.filter(m=>m.subA===sub||m.subB===sub);
        const xs=((xrep&&xrep.subjects)||[]).find(x=>x.subject===sub);
        h+='<div class="d-poi"><div class="d-poi-h"><span class="d-poi-n">POI '+(i+1)+'</span> <b>'+subjLabel(sub)+'</b> <span class="d-poi-type">'+esc(p.type)+'</span>'
          +(rk?' <span class="d-poi-risk d-risk-'+esc((rk.band||'').toLowerCase())+'">Risk: '+esc(rk.band||'')+' ('+n(rk.score||0)+')</span>':'')+'</div>';
        h+='<table class="d-kv">'
          +'<tr><td>Activity</td><td>'+n(p.n)+' records · '+n(p.c)+' contacts · '+n(p.t)+' towers</td></tr>'
          +'<tr><td>First / last seen</td><td>'+(fs?esc(_fmtDT(fs)):'—')+'  →  '+(ls?esc(_fmtDT(ls)):'—')+'</td></tr>';
        {const sdr=_sdrMap[sub];if(sdr)h+='<tr><td>Subscriber (SDR)</td><td>'+[sdr.name,sdr.address,sdr.alt_number?('Alt: '+sdr.alt_number):'',sdr.id_proof,sdr.operator].filter(Boolean).map(esc).join(' &middot; ')+'</td></tr>';}
        if(idents.length)h+='<tr><td>Devices / SIMs</td><td>'+idents.slice(0,4).map(d=>'IMEI '+esc(d.imei||'—')+' / IMSI '+esc(d.imsi||'—')).join('<br>')+'</td></tr>';
        if(topc.length)h+='<tr><td>Top contacts</td><td>'+topc.map(([c,k])=>esc(c)+' ('+n(k)+')').join(', ')+'</td></tr>';
        if(topt.length)h+='<tr><td>Top towers</td><td>'+topt.map(([t,k])=>{const m=tm[t]||{};return esc(t)+(m.city?' — '+esc(m.city):'')+' ('+n(k)+')';}).join('<br>')+'</td></tr>';
        if(changes.length)h+='<tr><td>Identity changes</td><td>'+changes.map(c=>esc(c.detail)+' on '+esc(_fmtDT(c.time))).join('<br>')+'</td></tr>';
        if(mts.length)h+='<tr><td>Meetings</td><td>'+mts.slice(0,5).map(m=>{const o=m.subA===sub?m.subB:m.subA;return 'with '+esc(o)+' @ tower '+esc(m.tow||'?')+' ('+esc(_fmtDT(m.time))+', '+esc(m.gapLevel)+')';}).join('<br>')+(mts.length>5?'<br>… +'+(mts.length-5)+' more':'')+'</td></tr>';
        if(xs)h+='<tr><td>Cross-case</td><td>also in '+(xs.matches||[]).map(mm=>esc(mm.case_name||mm.case_id)+' ('+((mm.match_types||[mm.match_type]).join('/'))+', '+esc(mm.confidence)+')').join('; ')+'</td></tr>';
        h+='</table></div>';
      });
      if(subjects.length>poiList.length)h+='<div class="d-note">'+n(poiList.length)+' of '+n(subjects.length)+' subjects profiled (risk-ranked). Full subject list available in the platform.</div>';
    }else h+='<div class="d-note">No subjects.</div>';
    h+='</section>';

    // ── 4. Key findings ──
    h+='<section class="dossier-section"><h2>4. Key Findings</h2>';
    // Only emit subsections that actually have findings, numbered 4.1, 4.2 … in sequence.
    let kf=0;const kn=()=>'4.'+(++kf);
    if(meetingsList.length){
      h+='<h3 class="d-h3">'+kn()+' Co-location meetings ('+n(mt.total||meetingsList.length)+')</h3>'
        +'<table class="d-table"><thead><tr><th>Subject A</th><th>Subject B</th><th>Tower</th><th>Place</th><th>Time</th><th>Gap</th><th>Confidence</th></tr></thead><tbody>'
        +meetingsList.slice(0,25).map(m=>{const pl=tm[m.tow]||{};return '<tr><td>'+esc(m.subA)+'</td><td>'+esc(m.subB)+'</td><td>'+esc(m.tow||'?')+'</td><td>'+esc([pl.city,pl.state].filter(Boolean).join(', ')||'—')+'</td><td>'+esc(_fmtDT(m.time))+'</td><td>'+Math.round(m.gap)+'m</td><td>'+esc(m.gapLevel)+'</td></tr>';}).join('')
        +'</tbody></table>'+(meetingsList.length>25?'<div class="d-note">Showing top 25 by confidence of '+n(mt.total||meetingsList.length)+'.</div>':'');
    }
    if(impossible.length){
      h+='<h3 class="d-h3">'+kn()+' Impossible travel / possible cloning ('+n(impossible.length)+')</h3>'
        +'<table class="d-table"><thead><tr><th>Subject</th><th>From → To tower</th><th>Distance</th><th>Elapsed</th><th>Implied speed</th></tr></thead><tbody>'
        +impossible.slice(0,20).map(r=>'<tr><td>'+esc(r.subject||'—')+'</td><td>'+esc(r.from_tower||'?')+' → '+esc(r.to_tower||'?')+'</td><td>'+Math.round(r.distance_km||0)+' km</td><td>'+Math.round(r.dt_minutes||0)+' min</td><td>'+Math.round(r.speed_kmh||0)+' km/h</td></tr>').join('')
        +'</tbody></table>';
    }
    if(idChanges.length){
      h+='<h3 class="d-h3">'+kn()+' Identity changes — SIM / handset swaps ('+n(idChanges.length)+')</h3>'
        +'<table class="d-table"><thead><tr><th>Subject</th><th>Change</th><th>From → To</th><th>When</th><th>Confidence</th></tr></thead><tbody>'
        +idChanges.slice(0,25).map(c=>'<tr><td>'+esc(c.sub)+'</td><td>'+esc(c.detail)+'</td><td>'+esc(c.from||'—')+' → '+esc(c.to||'—')+'</td><td>'+esc(_fmtDT(c.time))+'</td><td>'+esc(c.confidence||'')+'</td></tr>').join('')
        +'</tbody></table>'+(idChanges.length>25?'<div class="d-note">Showing 25 of '+n(idChanges.length)+'.</div>':'');
    }
    if(hidden.length){
      h+='<h3 class="d-h3">'+kn()+' Hidden links &amp; convoys ('+n(hidden.length)+')</h3>'
        +'<table class="d-table"><thead><tr><th>Subject A</th><th>Subject B</th><th>Pattern</th><th>Co-locations</th><th>Days</th><th>Towers</th><th>Ever called</th></tr></thead><tbody>'
        +hidden.slice(0,20).map(p=>{const pat=[p.hidden_link?'Hidden link':null,p.convoy?'Convoy':null].filter(Boolean).join(' / ')||'Co-presence';
          return '<tr><td>'+esc(p.subject_a||'—')+'</td><td>'+esc(p.subject_b||'—')+'</td><td>'+esc(pat)+'</td><td>'+n(p.occurrences||0)+'</td><td>'+n(p.distinct_days||0)+'</td><td>'+esc((p.towers||[]).join(', ')||'—')+'</td><td>'+(p.ever_called?'yes':'no')+'</td></tr>';}).join('')
        +'</tbody></table>';
    }
    if(!kf)h+='<div class="d-note">Automated analysis flagged no co-location meetings, impossible-travel legs, identity changes or hidden-link/convoy patterns in this case.</div>';
    h+='</section>';

    // ── 5. Communication analysis ──
    h+='<section class="dossier-section"><h2>5. Communication Analysis</h2><h3 class="d-h3">Most frequent contacts in this case</h3>';
    if(topCnt.length){
      h+='<table class="d-table"><thead><tr><th>#</th><th>Contact</th><th>Interactions</th></tr></thead><tbody>'
        +topCnt.map(([c,k],i)=>'<tr><td>'+(i+1)+'</td><td>'+esc(c)+'</td><td>'+n(k)+'</td></tr>').join('')+'</tbody></table>';
    }else h+='<div class="d-note">None.</div>';
    h+='</section>';

    // ── 6. Cross-case links ──
    h+='<section class="dossier-section"><h2>6. Cross-Case Links</h2><div id="dossierXcase" class="d-note">Loading…</div></section>';

    // ── 7. Bookmarked evidence (with screenshots) ──
    h+='<section class="dossier-section"><h2>7. Bookmarked Evidence ('+n(ev.length)+')</h2>';
    if(ev.length){
      h+=ev.map((it,i)=>{const m=EVK[it.kind]||{l:it.kind};
        return '<div class="d-ev"><div class="d-ev-h"><span class="d-poi-n">E'+(i+1)+'</span> <b>'+esc(it.label||'')+'</b> <span class="d-poi-type">'+esc(m.l)+'</span></div>'
        +(it.detail?'<div class="d-ev-d">'+esc(it.detail)+'</div>':'')
        +'<div class="d-note">'+(it.subject?'Subject '+esc(it.subject)+' · ':'')+(it.ts?esc(_fmtDT(it.ts))+' · ':'')+'pinned '+esc(_fmtDT(it.addedAt))+'</div>'
        +(it.image?'<figure class="d-fig"><img src="'+it.image+'"></figure>':'')+'</div>';
      }).join('');
    }else h+='<div class="d-note">No items bookmarked. Pin findings (☆) on the Story tab, or capture chart/graph snapshots, to include them here.</div>';
    h+='</section>';

    // ── 8. Charts ──
    const chartList=[['chartDailyTrend','Daily activity trend'],['chartCdrIpdrTime','CDR vs IPDR over time'],['chartActiveSubjects','Most active subjects'],['chartNewReturning','New vs returning contacts'],['chartGeoState','Geographic spread by state'],['chartTowerDiversity','Tower diversity']];
    let chartsHtml='';
    chartList.forEach(([id,title])=>{
      const cv=document.getElementById(id);
      if(cv&&cv.tagName==='CANVAS'&&cv.width>0){
        try{const url=cv.toDataURL('image/png');if(url&&url.length>2000)chartsHtml+='<figure class="d-fig"><img src="'+url+'"><figcaption>'+esc(title)+'</figcaption></figure>';}catch(e){}
      }
    });
    h+='<section class="dossier-section"><h2>8. Analytical Charts</h2>'+(chartsHtml||'<div class="d-note">No chart snapshots available — open the Charts tab once, then regenerate the dossier.</div>')+'</section>';

    // ── 9. Towers in this case (case-specific, with activity) ──
    h+='<section class="dossier-section"><h2>9. Towers in this Case</h2>';
    if(caseTowers.length){
      h+='<table class="d-table"><thead><tr><th>#</th><th>Tower ID</th><th>City</th><th>State</th><th>Records at tower</th></tr></thead><tbody>'
        +caseTowers.slice(0,80).map((t,i)=>'<tr><td>'+(i+1)+'</td><td>'+esc(t.tw)+'</td><td>'+esc(t.city||'—')+'</td><td>'+esc(t.state||'—')+'</td><td>'+n(t.c)+'</td></tr>').join('')
        +'</tbody></table>'+(caseTowers.length>80?'<div class="d-note">Showing top 80 of '+n(caseTowers.length)+' towers touched by this case.</div>':'<div class="d-note">'+n(caseTowers.length)+' distinct tower(s) appear in this case&rsquo;s records.</div>');
    }else h+='<div class="d-note">No tower references in this case&rsquo;s records.</div>';
    h+='</section>';

    // ── Appendix ──
    h+='<section class="dossier-section"><h2>Appendix A — Methodology &amp; Limitations</h2>'
      +'<p class="d-app">Findings are derived from Call Detail Records (CDR) and Internet Protocol Detail Records (IPDR) loaded into the named case. CDR and IPDR are analysed under strict separation — a phone-number subject is never merged with an IP subject. Co-location ("meeting") detection infers proximity from same-tower activity within a short time window and is probabilistic, not positional proof. "Impossible travel" flags legs whose implied speed exceeds human possibility and may indicate a cloned SIM or a spoofed record. Cross-case links are an identity/intelligence lookup (number, IMEI handset, IMSI SIM, or IP); IP-only matches are low-confidence because operators reassign addresses. Tower place-names may be approximate where derived by offline reverse-geocoding. All times are shown in the analyst workstation\'s local timezone. This dossier is an investigative aid; corroborate every finding against the primary records before relying on it in proceedings.</p></section>';

    h+='<div class="dossier-end">— End of dossier · '+esc(ref)+' · '+CLASS+' —</div>';
    D.dossierBody.innerHTML=h;
    D.dossier.style.display='block';D.dossier.scrollTop=0;

    // Fill cross-case section async (non-blocking).
    fillDossierXcase();
  }catch(e){console.error(e);alert('Could not build the dossier: '+(e.message||'error'))}
  finally{D.dossierBtn.textContent=prev;D.dossierBtn.disabled=false;}
}

async function fillDossierXcase(){
  const box=document.getElementById('dossierXcase');if(!box)return;
  try{
    const rep=await API.get('/cross-case/report?case_id='+encodeURIComponent(state.data.caseId||''));
    const subs=(rep&&rep.subjects)||[];
    if(!subs.length){box.className='d-note';box.textContent='No subjects from this case were found in any other case.';return}
    let h='<div class="d-note">'+n(subs.length)+' subject(s) from this case also appear in other cases.</div>';
    h+='<table class="d-table"><thead><tr><th>Subject</th><th>Linked cases</th><th>Match types</th><th>Confidence</th></tr></thead><tbody>';
    subs.slice(0,40).forEach(s=>{
      const matches=s.matches||[];
      const cases=[...new Set(matches.map(m=>m.case_name||m.case_id))];
      const types=[...new Set(matches.flatMap(m=>m.match_types||[m.match_type]).filter(Boolean))];
      const conf=matches.some(m=>m.confidence==='high')?'high':'low';
      h+='<tr><td>'+esc(s.subject)+'</td><td>'+esc(cases.join(', '))+'</td><td>'+esc(types.join(', '))+'</td><td>'+esc(conf)+'</td></tr>';
    });
    h+='</tbody></table>';
    box.className='';box.innerHTML=h;
  }catch(e){box.className='d-note';box.textContent='Cross-case links unavailable.';console.error(e)}
}

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
  switchTab, showProfile, showSubjectRecords, showMeetingOverlay,
  showSessionRecords, saveProfileTag, exportFeedback, toggleFindingDetail, investToggleMore,
  toggleInvestModule, runFullInvestigation, generateAiReport, chatWithContext, analyzeWithAI,
  clearAiConversation, switchNarrativeSubject,
  showGanttTip, scheduleHideGanttTip, toggleAnnot, markFinding,
});

provideWorkspaceHooks({renderStoryTimeline, renderDossier});  // evidence -> story/dossier refreshers
onChartsRendered(installChartCaptureButtons);  // charts pin-to-evidence buttons (injected; avoids charts->workspace import)
provideInfReport(getInfReport);  // map inference overlays reach getInfReport (inferences layer still in app.js)
provideExports(_wireExports);  // tower-dump report cards reach the CSV/XLSX export wiring
provideDetectMeetings(detectMeetings);  // correlation meeting detection (dashboard engine still in app.js)
wireDelegation();  // central data-act delegation (dormant until features register actions)
if(!D.loginUser.value)D.loginUser.value='admin';
checkAuth();
