// workspace/report.js — the selective report builder. Not "export everything": the investigator
// picks exactly which reviewed findings go in (whole kinds or single items), and gets a clean,
// printable case report — items grouped by kind, each with its review status, investigator note,
// reviewer identity, and snapshot image. Confirmed items are pre-selected; rejected ones are
// excluded by default but can be pulled in deliberately (e.g. to document a ruled-out lead).
// Lazily imported from the Evidence tab's "Build report" button.

import { esc, _fmtDT } from '../core/utils.js';
import { state } from '../core/state.js';
import { EVK, evLoad } from './evidence.js';

const _ST_LABEL={system:'System finding (unreviewed)',confirmed:'CONFIRMED',rejected:'REJECTED — false positive'};
const _ST_COLOR={system:'#8a7a6a',confirmed:'#2e7d32',rejected:'#b3261e'};

export function openReportBuilder(){
  const items=evLoad();
  if(!items.length){alert('Nothing on the evidence board yet — pin findings first.');return;}
  _showPicker(items);
}

function _showPicker(items){
  document.getElementById('rbOverlay')?.remove();
  const byKind={};
  items.forEach(it=>{(byKind[it.kind]=byKind[it.kind]||[]).push(it)});
  const ov=document.createElement('div');
  ov.id='rbOverlay';ov.className='rb-overlay';
  ov.innerHTML='<div class="rb-panel">'
    +'<div class="rb-head"><b>Build report</b><span class="story-muted" style="margin-left:8px">select what goes in</span>'
    +'<div style="flex:1"></div>'
    +'<button class="btn-sm" id="rbAllConfirmed">Select confirmed</button>'
    +'<button class="btn-sm" id="rbAll">Select all</button>'
    +'<button class="btn-sm" id="rbNone">Clear</button></div>'
    +'<div class="rb-body">'
    +Object.entries(byKind).map(([kind,list])=>{
      const m=EVK[kind]||{c:'#888',g:'●',l:kind};
      return '<div class="rb-kind"><label class="rb-kind-h"><input type="checkbox" class="rb-kind-cb" data-kind="'+esc(kind)+'"> '
        +'<span class="story-ev-dot" style="--ec:'+m.c+';background:'+m.c+'">'+m.g+'</span> <b>'+esc(m.l)+'</b> <span class="story-muted">('+list.length+')</span></label>'
        +'<div class="rb-items">'+list.map(it=>{
          const checked=it.status==='confirmed'?' checked':'';
          return '<label class="rb-item'+(it.status==='rejected'?' rb-rejected':'')+'"><input type="checkbox" class="rb-item-cb" data-id="'+it.id+'" data-kind="'+esc(kind)+'"'+checked+'>'
            +'<span class="rb-item-label">'+esc(it.label||'')+'</span>'
            +'<span class="rb-item-status" style="color:'+_ST_COLOR[it.status||'system']+'">'+(it.status||'system')+'</span></label>';
        }).join('')+'</div></div>';
    }).join('')
    +'</div>'
    +'<div class="rb-foot"><span class="story-muted" id="rbCount"></span><div style="flex:1"></div>'
    +'<button class="btn-sm" id="rbCancel">Cancel</button>'
    +'<button class="btn-sm" id="rbGenerate"><b>Generate report</b></button></div>'
    +'</div>';
  document.body.appendChild(ov);
  const count=()=>{const c=ov.querySelectorAll('.rb-item-cb:checked').length;ov.querySelector('#rbCount').textContent=c+' item'+(c===1?'':'s')+' selected';};
  const syncKindBoxes=()=>{ov.querySelectorAll('.rb-kind-cb').forEach(kb=>{const cbs=[...ov.querySelectorAll('.rb-item-cb[data-kind="'+kb.dataset.kind+'"]')];kb.checked=cbs.length>0&&cbs.every(c=>c.checked);kb.indeterminate=cbs.some(c=>c.checked)&&!kb.checked;});count();};
  ov.querySelectorAll('.rb-kind-cb').forEach(kb=>kb.onchange=()=>{ov.querySelectorAll('.rb-item-cb[data-kind="'+kb.dataset.kind+'"]').forEach(c=>c.checked=kb.checked);syncKindBoxes();});
  ov.querySelectorAll('.rb-item-cb').forEach(c=>c.onchange=syncKindBoxes);
  ov.querySelector('#rbAllConfirmed').onclick=()=>{ov.querySelectorAll('.rb-item-cb').forEach(c=>{const it=items.find(x=>x.id===c.dataset.id);c.checked=it&&it.status==='confirmed';});syncKindBoxes();};
  ov.querySelector('#rbAll').onclick=()=>{ov.querySelectorAll('.rb-item-cb').forEach(c=>c.checked=true);syncKindBoxes();};
  ov.querySelector('#rbNone').onclick=()=>{ov.querySelectorAll('.rb-item-cb').forEach(c=>c.checked=false);syncKindBoxes();};
  ov.querySelector('#rbCancel').onclick=()=>ov.remove();
  ov.onclick=e=>{if(e.target===ov)ov.remove();};
  ov.querySelector('#rbGenerate').onclick=()=>{
    const ids=new Set([...ov.querySelectorAll('.rb-item-cb:checked')].map(c=>c.dataset.id));
    if(!ids.size){alert('Select at least one item.');return;}
    _generate(items.filter(it=>ids.has(it.id)));
    ov.remove();
  };
  syncKindBoxes();
}

function _generate(selected){
  const caseId=state.data.caseId||'(no case)';
  const investigator=(state.auth.user&&state.auth.user.username)||'unknown';
  const now=new Date();
  const byKind={};
  selected.forEach(it=>{(byKind[it.kind]=byKind[it.kind]||[]).push(it)});
  // Stable section order: human-reviewed narrative material first, snapshots last.
  const order=['meeting','activity','identity','move','call','sms','data','crosscase','ai','record','note','chart','graph'];
  const kinds=Object.keys(byKind).sort((a,b)=>{const ia=order.indexOf(a),ib=order.indexOf(b);return (ia<0?99:ia)-(ib<0?99:ib);});
  const counts={confirmed:0,system:0,rejected:0};
  selected.forEach(it=>counts[it.status||'system']++);
  const sections=kinds.map(kind=>{
    const m=EVK[kind]||{l:kind};
    const rows=byKind[kind].slice().sort((a,b)=>new Date(a.ts||a.addedAt)-new Date(b.ts||b.addedAt)).map(it=>{
      const st=it.status||'system';
      return '<div class="rp-item">'
        +'<div class="rp-item-h"><b>'+esc(it.label||'')+'</b>'
        +'<span class="rp-status" style="color:'+_ST_COLOR[st]+';border-color:'+_ST_COLOR[st]+'">'+_ST_LABEL[st]+'</span></div>'
        +(it.ts?'<div class="rp-meta">Event time: '+_fmtDT(it.ts)+(it.subject?' · Subject: '+esc(it.subject):'')+'</div>':(it.subject?'<div class="rp-meta">Subject: '+esc(it.subject)+'</div>':''))
        +(it.detail?'<div class="rp-detail">'+esc(it.detail)+'</div>':'')
        +(it.note?'<div class="rp-note"><b>Investigator note:</b> '+esc(it.note)+'</div>':'')
        +(it.reviewedBy?'<div class="rp-meta">Reviewed by '+esc(it.reviewedBy)+(it.reviewedAt?' on '+_fmtDT(it.reviewedAt):'')+'</div>':'')
        +(it.image?'<img class="rp-img" src="'+it.image+'">':'')
        +'</div>';
    }).join('');
    return '<section class="rp-section"><h2>'+esc(m.l)+' <span class="rp-count">('+byKind[kind].length+')</span></h2>'+rows+'</section>';
  }).join('');
  const html='<!DOCTYPE html><html><head><meta charset="utf-8"><title>ARGUS Report — '+esc(caseId)+'</title><style>'
    +'body{font-family:Georgia,serif;color:#1c1c1c;max-width:820px;margin:32px auto;padding:0 24px;line-height:1.55}'
    +'header{border-bottom:3px double #333;padding-bottom:14px;margin-bottom:22px}'
    +'h1{font-size:1.5rem;margin:0 0 6px}.rp-sub{color:#555;font-size:.9rem}'
    +'.rp-summary{background:#f6f4ef;border:1px solid #ddd;padding:10px 14px;font-size:.9rem;margin:16px 0}'
    +'h2{font-size:1.05rem;border-bottom:1px solid #bbb;padding-bottom:4px;margin:26px 0 10px}'
    +'.rp-count{color:#888;font-weight:normal;font-size:.85rem}'
    +'.rp-item{margin:0 0 16px;padding:10px 14px;border:1px solid #ddd;page-break-inside:avoid}'
    +'.rp-item-h{display:flex;justify-content:space-between;gap:10px;align-items:baseline}'
    +'.rp-status{font-size:.68rem;letter-spacing:.5px;border:1px solid;padding:1px 7px;border-radius:3px;white-space:nowrap}'
    +'.rp-meta{color:#666;font-size:.78rem;margin-top:3px}'
    +'.rp-detail{font-size:.88rem;margin-top:5px}'
    +'.rp-note{font-size:.86rem;margin-top:6px;background:#fbf7e8;border-left:3px solid #c9a227;padding:5px 9px}'
    +'.rp-img{max-width:100%;margin-top:8px;border:1px solid #ccc}'
    +'.rp-print{position:fixed;top:14px;right:14px;padding:8px 16px;font-size:.85rem;cursor:pointer}'
    +'@media print{.rp-print{display:none}}'
    +'footer{margin-top:30px;border-top:1px solid #bbb;padding-top:10px;color:#777;font-size:.75rem}'
    +'</style></head><body>'
    +'<button class="rp-print" onclick="window.print()">Print / Save PDF</button>'
    +'<header><h1>Investigation Report</h1>'
    +'<div class="rp-sub">Case: <b>'+esc(caseId)+'</b> · Prepared by: <b>'+esc(investigator)+'</b> · Generated: '+esc(now.toLocaleString())+'</div></header>'
    +'<div class="rp-summary"><b>'+selected.length+'</b> selected finding'+(selected.length===1?'':'s')+': '
    +counts.confirmed+' confirmed, '+counts.system+' unreviewed, '+counts.rejected+' rejected (included deliberately). '
    +'Review decisions and notes are recorded in the ARGUS chain of custody.</div>'
    +sections
    +'<footer>Generated by ARGUS. Confidence figures are analytical inferences from CDR/IPDR metadata, not intercepted content; "Probable" classifications are behavioral/infrastructure inferences and should be corroborated.</footer>'
    +'</body></html>';
  const w=window.open('','_blank');
  if(!w){alert('Popup blocked — allow popups for this site to generate reports.');return;}
  w.document.write(html);w.document.close();
}
