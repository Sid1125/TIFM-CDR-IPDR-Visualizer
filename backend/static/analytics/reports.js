// analytics/reports.js — the server-side report tabs: Phase B (per-subject CDR/IPDR analysis
// reports) and Phase C (group compare across selected subjects). Both build report cards via the
// shared renderer and wire CSV/XLSX export. Extracted from app.js (feature layer). Self-registers
// both tabs. No behavior change.

import { esc, n } from '../core/utils.js';
import { D } from '../core/dom.js';
import { state } from '../core/state.js';
import { API } from '../core/api.js';
import { subjLabelTxt } from '../core/subjects.js';
import { _repCard } from '../ui/report_table.js';
import { _wireExports } from '../services/export.js';
import { registerTab, tabNeedsRender, tabMarkRendered } from '../core/router.js';

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

// Register both report tabs with the router.
registerTab('analysisreports', renderAnalysisReports);
registerTab('groupcompare', renderGroupCompare);
