// records/table.js — the Records tab: server-paginated table, row rendering, pagination,
// client/server export, and annotation loading. Extracted from app.js (feature layer). The
// evidence-coupled annotation toggle (toggleAnnot/_recordEvidence) stays in app.js and is reached
// from the row's inline onclick via the window bridge, as are showProfile/showTower. No behavior change.

import { esc, fmt, colWidth, n, debounce } from '../core/utils.js';
import { $, D } from '../core/dom.js';
import { state } from '../core/state.js';
import { API } from '../core/api.js';
import { subjLabel, subjLabelTxt, isSuspect } from '../core/subjects.js';
import { nCdr, nIpdr, portSvc, twr } from '../data/records.js';
import { recordSvcAttr } from '../services/attribution.js';
import { toast } from '../ui/toast.js';
import { registerTab } from '../core/router.js';

function loadAnnotations(){
  API.get('/annotations/').then(list=>{
    state.data.annotations={};
    list.forEach(a=>{state.data.annotations[a.record_type+'_'+a.record_id]=a});
    renderRecTable();
  }).catch(()=>{});
}
// Pagination state for the Records tab
let _recPage={total:0,limit:60,offset:0};
let _recRows=[];   // current visible page rows (for export / annotation paint)

function renderRecords(){
  loadAnnotations();      // triggers first renderRecTable() as callback
  // Service dropdown from server
  const caseParam=state.data.caseId?'?case_id='+encodeURIComponent(state.data.caseId):'';
  API.get('/records/services'+caseParam).then(svcs=>{
    const cur=D.recService.value;
    D.recService.innerHTML='<option value="all">All services</option>'+(svcs||[]).sort().map(s=>`<option value="${esc(s)}">${esc(s)}</option>`).join('');
    if([...D.recService.options].some(o=>o.value===cur))D.recService.value=cur;
  }).catch(()=>{});
}
function recRowHtml(r){
  const cdr=r.type==='CDR';
  const wSub=colWidth(r.sub),wCnt=colWidth(r.cnt);
  const svcAttr=cdr?'':esc(recordSvcAttr(r));
  return `<tr onclick="showProfile('${esc(r.sub)}')" style="cursor:pointer">
      <td class="annot-cell" data-annot="${r.type+'_'+parseInt(r.id.slice(1))}" style="text-align:center;cursor:pointer;font-size:0.85rem" onclick="event.stopPropagation();toggleAnnot({id:'${r.id}',type:'${r.type}'})">${state.data.annotations[r.type+'_'+parseInt(r.id.slice(1))]?'&#9733;':'&#9734;'}</td>
      <td>${fmt(r.ts)}</td>
      <td><span class="tag${cdr?'':' tag-alt'}">${r.type}</span></td>
      <td style="min-width:${wSub}px;max-width:${wSub}px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(subjLabelTxt(r.sub))}">${isSuspect(r.sub)?'<span class="susp-dot" title="In a suspect group">&#9678;</span> ':''}${r.sub?subjLabel(r.sub):''}</td>
      <td style="min-width:${wCnt}px;max-width:${wCnt}px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(subjLabelTxt(r.cnt))}">${isSuspect(r.cnt)?'<span class="susp-dot" title="In a suspect group">&#9678;</span> ':''}${r.cnt?subjLabel(r.cnt):''}</td>
      <td>${r.dur!=null?r.dur+'s':''}</td>
      <td>${esc(cdr?r.cll||'':r.prot||'')}</td>
      <td>${esc(cdr?r.dir||'':r.apn||'')}</td>
      <td>${esc(r.svc||'')}</td>
      <td>${cdr?'':r.sport!=null?r.sport:''}</td>
      <td>${cdr?'':r.dport!=null?r.dport:''}</td>
      <td style="font-size:0.7rem">${cdr?'':r.dport?portSvc(r.dport):r.sport?portSvc(r.sport):''}</td>
      <td style="font-size:0.7rem;min-width:300px;white-space:normal;word-break:break-word;line-height:1.3" title="${svcAttr}">${svcAttr}</td>
      <td>${r.tow?twr(r.tow):''}</td>
      <td>${esc(r.cell||'')}</td>
      <td>${esc(r.lac||'')}</td>
      <td>${esc(r.imsi||'')}</td>
      <td>${esc(r.imei||'')}</td>
      <td>${esc(r.msisdn||'')}</td>
      <td style="font-size:0.7rem">${esc(cdr?r.tec||'':r.rat||'')}</td>
      <td style="font-size:0.7rem">${cdr?'':r.bytesUp!=null?r.bytesUp:''}</td>
      <td style="font-size:0.7rem">${cdr?'':r.bytesDn!=null?r.bytesDn:''}</td>
      <td style="font-size:0.7rem">${r.lat!=null?Number(r.lat).toFixed(4):''}</td>
      <td style="font-size:0.7rem">${r.lng!=null?Number(r.lng).toFixed(4):''}</td>
      <td style="font-size:0.7rem">${esc(r.case_id||'')}</td>
    </tr>`;
}
// Server-side paginated records table
async function renderRecTable(){
  const qp=new URLSearchParams({limit:_recPage.limit,offset:_recPage.offset});
  if(state.data.caseId)qp.set('case_id',state.data.caseId);
  if(D.recType.value!=='all')qp.set('type',D.recType.value);
  if(D.recService.value!=='all')qp.set('service',D.recService.value);
  const q=D.recSearch.value.trim();
  if(q)qp.set('search',q);
  try{
    const page=await API.get('/records/page?'+qp.toString());
    _recPage.total=page.total||0;
    const rows=(page.rows||[]).map(r=>r.rtype==='CDR'?nCdr(r):nIpdr(r));
    _recRows=rows;
    D.recCount.textContent=n(_recPage.total)+' records (page '+(Math.floor(_recPage.offset/_recPage.limit)+1)+' of '+Math.max(1,Math.ceil(_recPage.total/_recPage.limit))+')';
    D.recBody.innerHTML=rows.map(recRowHtml).join('');
    _renderRecPagination();
    if(D.recLoadMore)D.recLoadMore.style.display='none';
  }catch(e){console.error('renderRecTable:',e);}
}
function _recPrev(){if(_recPage.offset>0){_recPage.offset=Math.max(0,_recPage.offset-_recPage.limit);renderRecTable();}}
function _recNext(){if(_recPage.offset+_recPage.limit<_recPage.total){_recPage.offset+=_recPage.limit;renderRecTable();}}
// Jump straight to a page number (1-based, clamped) — no linear Prev/Next traversal.
function _recGoto(p){
  const total=Math.max(1,Math.ceil(_recPage.total/_recPage.limit));
  let page=parseInt(p,10);
  if(!page||page<1)page=1; else if(page>total)page=total;
  const off=(page-1)*_recPage.limit;
  if(off!==_recPage.offset){_recPage.offset=off;renderRecTable();}
}
function _renderRecPagination(){
  const el=$('recPagination');if(!el)return;
  const cur=Math.floor(_recPage.offset/_recPage.limit)+1;
  const total=Math.max(1,Math.ceil(_recPage.total/_recPage.limit));
  el.innerHTML=`<button class="btn-sm" onclick="_recPrev()" ${_recPage.offset===0?'disabled':''}>&#8592; Prev</button>
    <span style="font-size:0.8rem;opacity:0.7">Page
      <input type="number" min="1" max="${total}" value="${cur}" title="Type a page number and press Enter"
        style="width:58px;padding:2px 4px;font-size:0.8rem;border:1px solid var(--line);border-radius:5px;background:var(--surface);color:var(--text);text-align:center"
        onkeydown="if(event.key==='Enter'){event.preventDefault();_recGoto(this.value);}" onchange="_recGoto(this.value)">
      of ${n(total)} &middot; ${n(_recPage.total)} records</span>
    <button class="btn-sm" onclick="_recNext()" ${cur>=total?'disabled':''}>Next &#8594;</button>`;
}
function _recExport(){
  // Export all matching records (from state.data.records, not just the current page).
  // Apply the same search/type/service filters the table is currently showing.
  const q=(D.recSearch.value||'').trim().toLowerCase();
  const t=D.recType.value;
  const svc=D.recService.value;
  let src=state.data.records;
  if(state.data.caseId)src=src.filter(r=>!r.case_id||r.case_id===state.data.caseId);
  if(t)src=src.filter(r=>r.type===t);
  if(svc)src=src.filter(r=>(r.svc||'')===svc);
  if(q)src=src.filter(r=>(r.sub||'').toLowerCase().includes(q)||(r.cnt||'').toLowerCase().includes(q));
  const headers=['Time','Type','Subject','Counterpart','Dur(s)','Cell/Detail','Dir/APN','Service','SrcPort','DstPort','Tower','CellID','LAC','IMSI','IMEI','MSISDN','Lat','Lng','Case'];
  const data=src.map(r=>{const cdr=r.type==='CDR';return [fmt(r.ts),r.type,subjLabelTxt(r.sub||''),subjLabelTxt(r.cnt||''),r.dur!=null?r.dur:'',cdr?(r.cll||''):(r.prot||''),cdr?(r.dir||''):(r.apn||''),r.svc||'',cdr?'':(r.sport!=null?r.sport:''),cdr?'':(r.dport!=null?r.dport:''),r.tow||'',r.cell||'',r.lac||'',r.imsi||'',r.imei||'',r.msisdn||'',r.lat||'',r.lng||'',r.case_id||''];});
  return {headers,rows:data};
}
// Server-side export: pulls all matching rows from the DB (not state.data.records) so the download
// always matches every page of the paginated table, regardless of background load state.
async function _recServerExport(fmt){
  const q=(D.recSearch.value||'').trim();
  const t=D.recType.value;
  const svc=D.recService.value;
  const p=new URLSearchParams({format:fmt});
  if(state.data.caseId)p.set('case_id',state.data.caseId);
  if(t&&t!=='all')p.set('type',t);
  if(svc&&svc!=='all')p.set('service',svc);
  if(q)p.set('search',q);
  try{
    const r=await fetch('/export/records?'+p.toString(),{credentials:'same-origin'});
    if(!r.ok)throw new Error(await r.text()||r.status);
    const blob=await r.blob();
    const cd=r.headers.get('Content-Disposition')||'';
    const fname=cd.match(/filename="([^"]+)"/)?.[1]||('ARGUS_records.'+fmt);
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=fname;a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),2000);
  }catch(e){toast('Export failed: '+(e.message||e));}
}
D.recSearch.addEventListener('input',debounce(()=>{_recPage.offset=0;renderRecTable();}));
D.recType.addEventListener('change',()=>{_recPage.offset=0;renderRecTable();});
D.recService.addEventListener('change',()=>{_recPage.offset=0;renderRecTable();});
{const a=$('recExportCsv'),b=$('recExportXlsx');
 if(a)a.addEventListener('click',()=>_recServerExport('csv'));
 if(b)b.addEventListener('click',()=>_recServerExport('xlsx'));}

// This tab owns its rendering; register it with the router.
registerTab('records', renderRecords);
// Pagination controls are invoked from inline onclick in the generated HTML — expose them on window
// (transitional, until these convert to data-act delegation).
Object.assign(window, { _recPrev, _recNext, _recGoto });

export { renderRecords, renderRecTable };
