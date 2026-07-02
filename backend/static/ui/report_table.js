// ui/report_table.js — the shared report-table renderer used by every server-side report tab
// (Phase B CDR analysis, Phase C group-compare, Phase D tower-dump, …). _repCard builds a titled
// card with CSV/XLSX buttons + a table; large tables are virtualized (_wireVirtualTables renders only
// the visible window on scroll). Pure: depends only on esc + n. Export wiring (_wireExports / CSV /
// XLSX) stays in app.js for now (it is coupled to the export web worker). No behavior change.

import { esc, n } from '../core/utils.js';

const _AR_COLOR={
  imei_summary:'var(--warn)',imsi_summary:'var(--warn)',
  isd_calls:'var(--success)',other_state:'var(--success)',
  latlng:'var(--success)',towers:'var(--success)',undertower:'var(--success)',
  matrix:'#7356bf',contacts:'#7356bf',cells:'var(--success)',
};
const _AR_ICON={
  day_first_last:'DAY',single_call_days:'1×',weekday_weekend:'WK',longest_calls:'DUR',
  day_night:'D/N',isd_calls:'ISD',other_state:'OOS',off_periods:'OFF',
  imei_summary:'IMEI',imsi_summary:'SIM',bank_sms:'OTP',
  contacts:'COM',towers:'TWR',cells:'CEL',latlng:'LOC',imeis:'DEV',matrix:'MAP',
  common:'COM',uncommon:'UNQ',imeispersim:'DEV',simsperimei:'SIM',undertower:'TWR',
};
// ── Virtual table (Phase 2b) — render only the visible rows of a large report table, so a
// 50k-row report stays a few dozen <tr> in the DOM instead of 50k. Tables larger than _VCAP are
// virtualized; on scroll only the window (+buffer) is re-rendered, with sized spacer rows above
// and below to preserve scroll height. _wireVirtualTables() measures the real row height and
// attaches the scroll handler after the table is in the DOM.
const _VCAP=150;      // virtualize tables larger than this
const _VROW_H=31;     // initial row-height estimate (remeasured live)
const _VBUF=8;        // extra rows above/below the viewport
const _VVIS=12;       // visible rows in the bounded scroller

function _vTbody(rows,start,win,rowH,ncol){
  const total=rows.length;
  const s=Math.max(0,start);
  const end=Math.min(total,s+win);
  let h='';
  if(s>0)h+='<tr class="vspacer"><td colspan="'+ncol+'" style="height:'+(s*rowH)+'px;padding:0;border:0"></td></tr>';
  for(let i=s;i<end;i++)h+='<tr>'+rows[i].map(c=>'<td>'+esc(c==null?'':c)+'</td>').join('')+'</tr>';
  if(end<total)h+='<tr class="vspacer"><td colspan="'+ncol+'" style="height:'+((total-end)*rowH)+'px;padding:0;border:0"></td></tr>';
  return h;
}

export function _wireVirtualTables(box,reps){
  if(!box||!reps)return;
  box.querySelectorAll('.ar-tablewrap.vtable[data-rep]').forEach(wrap=>{
    const id=wrap.dataset.rep, rep=reps[id];
    if(!rep||!rep.rows||!rep.rows.length)return;
    const tbody=wrap.querySelector('tbody');
    const fr=tbody&&tbody.querySelector('tr:not(.vspacer)');
    const rowH=fr?Math.max(16,Math.round(fr.getBoundingClientRect().height)):_VROW_H;
    const ncol=(rep.headers&&rep.headers.length)||1;
    const win=Math.ceil(wrap.clientHeight/rowH)+2*_VBUF;
    let last=-1;
    const render=()=>{
      const start=Math.floor(wrap.scrollTop/rowH)-_VBUF;
      if(start===last)return; last=start;
      tbody.innerHTML=_vTbody(rep.rows,start,win,rowH,ncol);
    };
    wrap.addEventListener('scroll',render,{passive:true});
  });
}

function _repTableHtml(headers,rows,id){
  if(!rows.length)return '<div class="ar-empty"><span class="ar-empty-ico">◌</span><span class="ar-empty-txt">No data for this report.</span></div>';
  const thead='<thead><tr>'+headers.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr></thead>';
  if(rows.length<=_VCAP){
    return '<div class="ar-tablewrap"><table class="data-table ar-table">'+thead+'<tbody>'
      +rows.map(r=>'<tr>'+r.map(c=>'<td>'+esc(c==null?'':c)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
  }
  // Virtualized: bounded-height scroller, only the first window rendered up front; the rest fill in
  // on scroll (wired by _wireVirtualTables once it's in the DOM).
  const win=_VVIS+2*_VBUF;
  return '<div class="ar-tablewrap vtable" data-rep="'+esc(id||'')+'" style="max-height:'+(_VROW_H*_VVIS)+'px;overflow:auto">'
    +'<table class="data-table ar-table">'+thead+'<tbody>'+_vTbody(rows,0,win,_VROW_H,headers.length)+'</tbody></table></div>'
    +'<div class="ar-note">'+n(rows.length)+' rows (scroll to browse all) — export for the file.</div>';
}
export function _repCard(expClass,id,title,headers,rows,note){
  const dis=rows.length?'':' disabled';
  const col=_AR_COLOR[id]||'var(--accent)';
  const ico=_AR_ICON[id]||'';
  const iconHtml=ico?'<span class="ar-card-icon">'+ico+'</span>':'';
  const badgeCls='ar-count'+(rows.length===0?' zero':'');
  return '<div class="card ar-card" style="--ar-c:'+col+'">'+
    '<h3>'+iconHtml+esc(title)+' <span class="'+badgeCls+'">'+rows.length+'</span>'+
    '<span class="ar-exp-grp"><button class="cap-btn '+expClass+'" data-rep="'+id+'"'+dis+'>CSV</button>'+
    '<button class="cap-btn '+expClass+'-x" data-rep="'+id+'"'+dis+'>XLSX</button></span></h3>'+
    (note?'<div class="ar-note">'+esc(note)+'</div>':'')+_repTableHtml(headers,rows,id)+'</div>';
}
