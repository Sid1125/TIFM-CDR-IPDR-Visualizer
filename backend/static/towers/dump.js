// towers/dump.js — the Tower Dump Analysis tab (Phase D): import tower-dump CSVs, then run
// common / uncommon / multiplicity / under-tower cross-scene queries and render them as report cards.
// Extracted from app.js (feature layer). Imports the shared report renderer + telecom reference +
// the CSV/XLSX export wiring (_wireExports from services/export.js). Self-registers with the router.
// No behavior change.

import { esc } from '../core/utils.js';
import { state } from '../core/state.js';
import { API } from '../core/api.js';
import { _repCard } from '../ui/report_table.js';
import { refOperator, refCircle } from '../reference/telecom.js';
import { registerTab } from '../core/router.js';

import { _wireExports } from '../services/export.js';

let _tdReports={};
function renderTowerDump(){
  const file=document.getElementById('tdFile'),lbl=document.getElementById('tdLabel'),imp=document.getElementById('tdImportBtn'),st=document.getElementById('tdImportStatus');
  const list=document.getElementById('tdDumpList'),body=document.getElementById('tdBody');
  if(!list||!body)return;
  if(!document.getElementById('tdImportBtn')._wired){
    imp._wired=true;
    imp.onclick=async()=>{
      if(!file.files[0]){st.textContent='Choose a file first.';return;}
      const fd=new FormData();fd.append('file',file.files[0]);fd.append('case_id',state.data.caseId||'');fd.append('dump_label',(lbl.value||'').trim());fd.append('mode','replace');
      st.textContent='Importing…';
      try{const r=await fetch('/upload/tower-dump',{method:'POST',credentials:'same-origin',body:fd});if(!r.ok)throw new Error(await r.text());const j=await r.json();st.textContent='Imported '+j.records_imported+' rows into "'+(j.validation&&j.validation.dump_label||'dump')+'".';file.value='';lbl.value='';_tdLoadDumps();}
      catch(e){st.textContent='Import failed: '+(e.message||e);}
    };
    document.getElementById('tdCommonBtn').onclick=()=>_tdRun('common');
    document.getElementById('tdUncommonBtn').onclick=()=>_tdRun('uncommon');
    document.getElementById('tdMultBtn').onclick=()=>_tdRun('multiplicity');
  }
  _tdLoadDumps();
}
function _tdSelectedLabels(){return [...document.querySelectorAll('#tdDumpList input:checked')].map(c=>c.value);}
async function _tdLoadDumps(){
  const list=document.getElementById('tdDumpList');if(!list)return;
  try{
    const dumps=await API.get('/tower-dump/dumps?case_id='+encodeURIComponent(state.data.caseId||''));
    if(!dumps.length){list.innerHTML='<div class="ar-empty"><span class="ar-empty-ico">◌</span><span class="ar-empty-txt">No dumps imported for this case yet.</span></div>';return;}
    list.innerHTML=dumps.map(d=>'<label class="gc-chk"><input type="checkbox" value="'+esc(d.dump_label)+'" checked> '+esc(d.dump_label)+' <span class="gc-cn">'+d.distinct_numbers+'&thinsp;nos</span> <button class="td-ut" data-label="'+esc(d.dump_label)+'" title="List all numbers under this dump">under-tower</button></label>').join('');
    list.querySelectorAll('.td-ut').forEach(b=>b.onclick=ev=>{ev.preventDefault();_tdUnderTower(b.dataset.label);});
  }catch(e){list.innerHTML='<div class="ar-empty"><span class="ar-empty-ico">⚠</span><span class="ar-empty-txt">Could not load dumps.</span></div>';}
}
async function _tdRun(kind){
  const body=document.getElementById('tdBody');const labels=_tdSelectedLabels();
  if(labels.length<2&&kind!=='multiplicity'){body.innerHTML='<div class="ar-empty"><span class="ar-empty-ico">◎</span><span class="ar-empty-txt">Select at least 2 dumps first.</span></div>';return;}
  if(!labels.length){body.innerHTML='<div class="ar-empty"><span class="ar-empty-ico">◎</span><span class="ar-empty-txt">Select at least 1 dump first.</span></div>';return;}
  const cid=encodeURIComponent(state.data.caseId||''),ls=encodeURIComponent(labels.join(','));
  body.innerHTML='<div class="ar-empty"><span class="ar-empty-ico" style="animation:spin 1s linear infinite">◌</span><span class="ar-empty-txt">Running…</span></div>';
  try{
    if(kind==='common'){
      const min=Math.max(2,parseInt(document.getElementById('tdMin').value)||2);
      const j=await API.get('/tower-dump/common?case_id='+cid+'&labels='+ls+'&min='+min);
      const rows=j.rows.map(r=>[r.msisdn,refOperator(r.msisdn),refCircle(r.msisdn),r.dump_count,r.dumps.join(' | '),r.imeis.join(' | ')]);
      _tdReports.common={headers:['Number','Operator','Circle','# dumps','Dumps','IMEIs'],rows};
      body.innerHTML=_repCard('td-exp','common','Common numbers — present in ≥ '+min+' of '+labels.length+' dumps',_tdReports.common.headers,rows,j.total+' numbers across the selected scenes.');
    }else if(kind==='uncommon'){
      const j=await API.get('/tower-dump/uncommon?case_id='+cid+'&labels='+ls);
      const rows=j.rows.map(r=>[r.msisdn,r.dump]);
      _tdReports.uncommon={headers:['Number','Only in dump'],rows};
      body.innerHTML=_repCard('td-exp','uncommon','Un-common numbers (in exactly one dump — elimination)',_tdReports.uncommon.headers,rows);
    }else if(kind==='multiplicity'){
      const j=await API.get('/tower-dump/multiplicity?case_id='+cid+'&labels='+ls);
      const r1=j.imeis_per_sim.map(x=>[x.msisdn,x.imeis.length,x.imeis.join(' | ')]);
      const r2=j.sims_per_imei.map(x=>[x.imei,x.msisdns.length,x.msisdns.join(' | ')]);
      _tdReports.imeispersim={headers:['SIM (MSISDN)','# IMEIs','IMEIs'],rows:r1};
      _tdReports.simsperimei={headers:['IMEI','# SIMs','MSISDNs'],rows:r2};
      body.innerHTML=_repCard('td-exp','imeispersim','SIMs used with more than one IMEI',_tdReports.imeispersim.headers,r1)
        +_repCard('td-exp','simsperimei','IMEIs used with more than one SIM',_tdReports.simsperimei.headers,r2);
    }
    _wireExports(body,_tdReports,'td-exp','ARGUS_towerdump');
  }catch(e){body.innerHTML='<div class="ar-empty"><span class="ar-empty-ico">⚠</span><span class="ar-empty-txt">Failed: '+esc(e.message||String(e))+'</span></div>';}
}
async function _tdUnderTower(label){
  const body=document.getElementById('tdBody');body.innerHTML='<div class="ar-empty"><span class="ar-empty-ico">◌</span><span class="ar-empty-txt">Loading…</span></div>';
  try{
    const j=await API.get('/tower-dump/under-tower?case_id='+encodeURIComponent(state.data.caseId||'')+'&label='+encodeURIComponent(label));
    const rows=j.rows.map(r=>[r.msisdn,refOperator(r.msisdn),refCircle(r.msisdn),r.appearances,r.imeis.join(' | ')]);
    _tdReports.undertower={headers:['Number','Operator','Circle','Appearances','IMEIs'],rows};
    body.innerHTML=_repCard('td-exp','undertower','Under tower — '+esc(label),_tdReports.undertower.headers,rows,j.total+' distinct numbers.');
    _wireExports(body,_tdReports,'td-exp','ARGUS_towerdump');
  }catch(e){body.innerHTML='<div class="ar-empty">Failed: '+esc(e.message||String(e))+'</div>';}
}

// This tab owns its rendering; register with the router.
registerTab('towerdump', renderTowerDump);
