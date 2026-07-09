// upload/upload.js — the CSV upload flow: parse a preview, show a preview modal with operator-aware
// column mapping (CDR/IPDR) and append-vs-replace mode, POST the file, then surface an import
// validation report (coerced / dropped rows). Attaches the file-input change listeners on import.
// Extracted from app.js. loadCaseData (the post-import reload) lives in app.js's data layer and is
// injected via provideCaseReload(). No behavior change.

import { D } from '../core/dom.js';
import { state } from '../core/state.js';
import { API } from '../core/api.js';
import { esc, n } from '../core/utils.js';
import { toast } from '../ui/toast.js';

// app.js injects loadCaseData (reload the case after a successful import).
let _reloadCase=async()=>{};
export function provideCaseReload(fn){ _reloadCase=fn; }

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
// mis-detected column before committing. Required fields are flagged when unmapped. When the
// header signature matches a stored format profile, that's announced and profile-sourced fields
// are tagged; a corrected mapping can be saved back as a (new or updated) format profile so the
// next file in the same format maps automatically.
async function populateMapping(modal,kind,file){
  const box=modal.querySelector('#upMapBox');if(!box)return;
  try{
    const fd=new FormData();fd.append('file',file);fd.append('kind',kind);
    const r=await fetch('/upload/preview',{credentials:'same-origin',method:'POST',body:fd});
    if(!r.ok)throw new Error(await r.text()||'preview failed');
    const res=await r.json();
    const headers=res.headers||[];const required=res.required||[];const mapping=res.mapping||{};
    const sources=res.sources||{};const mp=res.matched_profile;
    const srcTag=canon=>{
      const s=sources[canon];
      if(s==='profile')return '<span style="color:#3a7d5a;font-size:.68rem;white-space:nowrap" title="From saved format profile">format</span>';
      if(s==='alias')return '<span style="color:var(--muted);font-size:.68rem;white-space:nowrap" title="Auto-detected from known header aliases">auto</span>';
      return '';
    };
    const opt=(canon,muted)=>{
      const cur=mapping[canon]||'';
      // Array value = combined columns from a format profile (e.g. Call Date + Call Time).
      // Shown as one locked choice; collectMapping skips it so the profile keeps supplying it.
      const combo=Array.isArray(cur);
      const opts=(combo?['<option value="__combo__" selected>'+esc(cur.join(' + '))+' (combined)</option>']:[])
        .concat(['<option value=""'+((cur&&!combo)?'':combo?'':' selected')+'>— none —</option>'])
        .concat(headers.map(h=>'<option value="'+esc(h)+'"'+(!combo&&h===cur?' selected':'')+'>'+esc(h)+'</option>'));
      const miss=required.indexOf(canon)>=0&&!cur;
      return '<div style="display:flex;align-items:center;gap:8px;padding:2px 0">'
        +'<span style="width:140px;'+(muted?'color:var(--muted)':'font-weight:600')+(miss?';color:var(--danger)':'')+'">'+esc(canon)+(required.indexOf(canon)>=0?' *':'')+'</span>'
        +'<select data-canon="'+esc(canon)+'" class="input-sm upmap" style="flex:1">'+opts.join('')+'</select>'
        +srcTag(canon)
        +(miss?'<span style="color:var(--danger);font-size:.72rem">required</span>':'')+'</div>';
    };
    const optionalMapped=(res.canonical||[]).filter(c=>required.indexOf(c)<0&&mapping[c]);
    let h='<div style="border:1px solid var(--line);border-radius:6px;padding:8px 10px">'
      +'<div style="font-weight:600;margin-bottom:4px;color:var(--fg)">Column mapping'
      +(res.detected_operator?' <span style="font-weight:400;color:var(--muted)">— detected: '+esc(res.detected_operator)+'</span>':'')+'</div>';
    if(mp){
      h+='<div style="margin-bottom:6px;padding:4px 8px;border-radius:5px;font-size:.76rem;'
        +(mp.match==='exact'?'background:rgba(58,125,90,.12);color:#3a7d5a':'background:rgba(200,150,40,.12);color:#a07a20')+'">'
        +(mp.match==='exact'?'✓ Format recognized: ':'≈ Closest known format: ')+'<b>'+esc(mp.name)+'</b>'
        +(mp.match==='partial'?' ('+mp.overlap+'/'+mp.total+' headers match — review below)':'')+'</div>';
    }
    h+=required.map(c=>opt(c,false)).join('');
    if(optionalMapped.length){
      h+='<details style="margin-top:6px"><summary style="cursor:pointer;color:var(--muted)">'+optionalMapped.length+' optional column'+(optionalMapped.length===1?'':'s')+' mapped</summary>'
        +optionalMapped.map(c=>opt(c,true)).join('')+'</details>';
    }
    // Save this (possibly corrected) mapping as a reusable format profile — the "learn a new ISP
    // format once, auto-map it forever" path.
    const defName=mp?mp.name:(res.detected_operator?res.detected_operator+' '+kind.toUpperCase():(file.name||'').replace(/\.[^.]+$/,''));
    h+='<div style="display:flex;gap:6px;align-items:center;margin-top:8px">'
      +'<input id="upProfName" class="input-sm" placeholder="Format name (e.g. Airtel IPDR)" style="flex:1" value="'+esc(defName)+'">'
      +'<button id="upProfSave" class="btn-sm" title="Save this column mapping so files with these headers auto-map next time">Save as format</button></div>'
      +'<div id="upProfMsg" style="font-size:.72rem;color:var(--muted);margin-top:2px"></div>';
    h+='</div>';
    box.innerHTML=h;box.style.color='';
    const saveBtn=box.querySelector('#upProfSave');
    if(saveBtn)saveBtn.addEventListener('click',async()=>{
      const msgEl=box.querySelector('#upProfMsg');
      const name=(box.querySelector('#upProfName').value||'').trim();
      if(!name){msgEl.textContent='Give the format a name first.';return}
      const m=collectMapping(modal)||{};
      // Untouched combined entries ('__combo__') aren't in the override — carry them into the
      // saved profile from the preview mapping so e.g. Call Date + Call Time survives a re-save.
      modal.querySelectorAll('select.upmap').forEach(s=>{
        if(s.value==='__combo__'&&Array.isArray(mapping[s.dataset.canon]))m[s.dataset.canon]=mapping[s.dataset.canon];
      });
      if(!Object.keys(m).length){msgEl.textContent='Nothing mapped yet — map at least one column.';return}
      try{
        await API.post('/format-profiles/',{kind,name,headers,mapping:m});
        msgEl.innerHTML='<span style="color:#3a7d5a">✓ Saved — files with these headers will auto-map as “'+esc(name)+'”.</span>';
        try{toast('✓ Format profile saved: '+name);}catch(_){}
      }catch(e){msgEl.textContent='Save failed: '+(e.message||'error');}
    });
  }catch(e){box.innerHTML='<span style="color:var(--muted)">Auto-mapping unavailable; default column names will be used.</span>';console.error(e)}
}

// Read the mapping selects back into a {canonical: header} override object (only non-empty).
// '__combo__' = an untouched profile-supplied combined mapping — leave it out so the matched
// profile keeps supplying it at upload time.
function collectMapping(modal){
  const sels=modal.querySelectorAll('select.upmap');if(!sels.length)return null;
  const m={};sels.forEach(s=>{if(s.value&&s.value!=='__combo__')m[s.dataset.canon]=s.value});
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
    await _reloadCase();
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
