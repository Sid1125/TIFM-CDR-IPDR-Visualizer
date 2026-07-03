// services/export.js — client-side data export: CSV (large exports go off-thread via the export
// worker, with a sync fallback) and XLSX (server-rendered via /export/xlsx). _wireExports binds the
// CSV/XLSX buttons in a report container against a {id:{headers,rows}} map and windows any large
// tables. Extracted from app.js (frontend services layer). No behavior change.

import { _W } from '../data/workers.js';
import { _wireVirtualTables } from '../ui/report_table.js';
import { toast } from '../ui/toast.js';

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
export function _wireExports(box,reps,csvClass,fileBase){
  box.querySelectorAll('.'+csvClass).forEach(b=>b.onclick=()=>{const rep=reps[b.dataset.rep];if(rep)downloadCsv(fileBase+'_'+b.dataset.rep+'.csv',rep.headers,rep.rows);});
  box.querySelectorAll('.'+csvClass+'-x').forEach(b=>b.onclick=()=>{const rep=reps[b.dataset.rep];if(rep)downloadXlsx(fileBase+'_'+b.dataset.rep+'.xlsx',b.dataset.rep,rep.headers,rep.rows);});
  try{_wireVirtualTables(box,reps);}catch(e){console.warn('vtable wiring',e);}  // Phase 2b: window large report tables
}
