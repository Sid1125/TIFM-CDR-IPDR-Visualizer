// workspace/evidence.js — the evidence board + snapshot-capture subsystem (localStorage-backed,
// per case). Pin/unpin findings, capture chart canvases and SVG graphs to PNG evidence, the ☆/★
// capture-button state, the dedicated Evidence tab (with Hypotheses + Relationship-label panels), and
// EVK (the event-kind styling map shared with the Story tab + dossier). Extracted from app.js
// (workspace layer). renderStoryTimeline + renderDossier live in app.js still and are injected via
// provideWorkspaceHooks(). Self-registers the Evidence tab. No behavior change.

import { esc, n, _fmtDT } from '../core/utils.js';
import { D } from '../core/dom.js';
import { state } from '../core/state.js';
import { API } from '../core/api.js';
import { toast } from '../ui/toast.js';
import { registerTab } from '../core/router.js';

// Story-timeline + dossier refreshers live in app.js; injected at boot so evidence can trigger them
// without importing those (not-yet-extracted) features.
let _renderStoryTimeline=()=>{}, _renderDossier=()=>{};
export function provideWorkspaceHooks(h){ if(h.renderStoryTimeline)_renderStoryTimeline=h.renderStoryTimeline; if(h.renderDossier)_renderDossier=h.renderDossier; }

// Event-kind styling (colour / glyph / label) — shared by evidence, the Story timeline, and dossier.
export const EVK={
  first:{c:'#2c6f79',g:'◉',l:'First activity'},
  call:{c:'#3a7d5a',g:'☎',l:'Call'},
  sms:{c:'#4a929c',g:'✉',l:'SMS'},
  data:{c:'#7b4f9c',g:'⇄',l:'Data'},
  move:{c:'#b07d2b',g:'▲',l:'Movement'},
  meeting:{c:'#b94a48',g:'⚑',l:'Meeting'},
  identity:{c:'#8b5cf6',g:'↻',l:'Identity change'},
  crosscase:{c:'#d4a017',g:'⇌',l:'Cross-case'},
  ai:{c:'#c0392b',g:'⚠',l:'AI finding'},
  chart:{c:'#2c6f79',g:'▦',l:'Chart snapshot'},
  graph:{c:'#7b4f9c',g:'◈',l:'Graph snapshot'},
  note:{c:'#888',g:'●',l:'Note'},
  record:{c:'#b94a48',g:'★',l:'Flagged record'},
};

export function evKey(){return 'argus_evidence_'+(state.data.caseId||'none')}
export function evLoad(){try{return JSON.parse(localStorage.getItem(evKey())||'[]')}catch(e){return[]}}
export function evSave(list){try{localStorage.setItem(evKey(),JSON.stringify(list))}catch(e){}}
export function updateEvidenceCount(){const c=evLoad().length;if(D.evidenceCount)D.evidenceCount.textContent=c;if(D.evidenceTabCount){D.evidenceTabCount.textContent=c;D.evidenceTabCount.style.display=c?'':'none';}}
export function pinEvidence(item){
  const list=evLoad();const sig=item.sig||(item.kind+'|'+item.label);
  if(list.some(x=>x.sig===sig))return false;
  list.push({id:'ev_'+Date.now()+'_'+Math.random().toString(36).slice(2,6),sig,addedAt:new Date().toISOString(),kind:item.kind||'note',label:item.label||'',detail:item.detail||'',ts:item.ts?new Date(item.ts).toISOString():null,subject:item.subject||null,image:item.image||null});
  evSave(list);updateEvidenceCount();renderEvidence();refreshCapButtons();if(state.tab==='evidence')renderEvidenceTab();return true;
}
export function unpinEvidence(id){evSave(evLoad().filter(x=>x.id!==id));updateEvidenceCount();renderEvidence();refreshCapButtons();if(typeof _renderStoryTimeline==='function')_renderStoryTimeline();}
export function unpinEvidenceBySig(sig){evSave(evLoad().filter(x=>x.sig!==sig));updateEvidenceCount();renderEvidence();refreshCapButtons();}
export function renderEvidence(){
  if(!D.evidenceList)return;updateEvidenceCount();
  const list=evLoad();
  if(!list.length){D.evidenceList.innerHTML='<div class="story-muted" style="padding:16px">Pin findings (☆) from the timeline, or capture chart/graph snapshots, to build an evidence folder. It feeds the Evidence tab and the dossier.</div>';return;}
  D.evidenceList.innerHTML=list.slice().reverse().map(it=>{const m=EVK[it.kind]||{c:'#888',g:'●',l:it.kind};
    return '<div class="evidence-item" style="--ec:'+m.c+'"><div class="evidence-item-h"><span class="story-ev-dot">'+m.g+'</span><b>'+esc(it.label)+'</b>'
      +'<button class="evidence-rm" data-id="'+it.id+'" title="Remove">&times;</button></div>'
      +(it.detail?'<div class="story-ev-detail">'+esc(it.detail)+'</div>':'')
      +(it.image?'<img class="evidence-thumb" src="'+it.image+'">':'')
      +'<div class="evidence-meta">'+(it.ts?_fmtDT(it.ts)+' · ':'')+(it.subject?esc(it.subject)+' · ':'')+'pinned '+_fmtDT(it.addedAt)+'</div></div>';
  }).join('');
  D.evidenceList.querySelectorAll('.evidence-rm').forEach(b=>b.onclick=()=>unpinEvidence(b.dataset.id));
}

// ---- Snapshot capture → evidence ----
// toast now in ui/toast.js (imported above)
export function _flashPinned(msg){updateEvidenceCount();renderEvidence();toast(msg||'Pinned to evidence.');}
export function captureCanvasToEvidence(cv,title){
  try{if(!cv||cv.tagName!=='CANVAS'){alert('No chart to capture.');return;}
    const url=cv.toDataURL('image/png');if(!url||url.length<2000){alert('Nothing to capture yet — render the chart first.');return;}
    pinEvidence({kind:'chart',label:title||'Chart',detail:'Chart snapshot · '+(state.data.caseId?'case '+state.data.caseId:'')+' · '+new Date().toLocaleString(),ts:new Date(),image:url,sig:'chart|'+title});
    _flashPinned('Pinned “'+title+'” to evidence.');
  }catch(e){alert('Capture failed: '+(e.message||e));}
}
export function captureSvgToEvidence(host,title){
  const svg=host&&host.querySelector?host.querySelector('svg'):null;if(!svg){alert('No graph to capture — switch to the graph view first.');return;}
  const w=Math.round(svg.clientWidth||host.clientWidth||800),hh=Math.round(svg.clientHeight||host.clientHeight||520);
  const clone=svg.cloneNode(true);clone.setAttribute('width',w);clone.setAttribute('height',hh);clone.setAttribute('xmlns','http://www.w3.org/2000/svg');
  const xml=new XMLSerializer().serializeToString(clone);
  const img=new Image();
  img.onload=function(){try{const c=document.createElement('canvas');c.width=w;c.height=hh;const ctx=c.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,w,hh);ctx.drawImage(img,0,0);const url=c.toDataURL('image/png');
      pinEvidence({kind:'graph',label:title||'Graph',detail:'Graph snapshot · '+(state.data.caseId?'case '+state.data.caseId:'')+' · '+new Date().toLocaleString(),ts:new Date(),image:url,sig:'graph|'+title});
      _flashPinned('Pinned “'+title+'” to evidence.');
    }catch(e){alert('Capture failed: '+(e.message||e));}};
  img.onerror=function(){alert('Capture failed (could not rasterize the graph).');};
  img.src='data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent(xml)));
}
// Stateful capture control on each chart card: ☆ Pin when absent, ★ Pinned when in the folder.
// Clicking toggles, and removing the item from the Evidence tab flips it back (refreshCapButtons).
export function _capBtnState(b){
  const sig=b.dataset.sig;if(!sig)return;
  const pinned=evLoad().some(x=>x.sig===sig);
  b.classList.toggle('pinned',pinned);
  b.textContent=pinned?'★ Pinned':'☆ Pin';
  b.title=pinned?'Remove this chart from the evidence folder':'Capture this chart into the evidence folder';
}
export function refreshCapButtons(){
  document.querySelectorAll('.cap-btn[data-sig]').forEach(_capBtnState);
  const xb=D.xcGraphCaptureBtn;
  if(xb){const pinned=evLoad().some(x=>x.sig==='graph|Cross-case link graph');xb.classList.toggle('pinned',pinned);xb.innerHTML=pinned?'&#9733; Pinned':'&#9733; Pin graph';}
}
export function installChartCaptureButtons(){
  document.querySelectorAll('#tab-charts .card').forEach(card=>{
    const h=card.querySelector('h3');const cv=card.querySelector('canvas');
    if(!h||!cv||h.querySelector('.cap-btn'))return;
    const title=h.textContent.trim();
    const b=document.createElement('button');b.className='cap-btn';b.dataset.sig='chart|'+title;
    b.onclick=()=>{const sig=b.dataset.sig;if(evLoad().some(x=>x.sig===sig)){unpinEvidenceBySig(sig);toast('Removed “'+title+'” from evidence.');}else{captureCanvasToEvidence(cv,title);}_capBtnState(b);};
    h.appendChild(b);_capBtnState(b);
  });
}

export async function renderHypotheses(el){
  if(!el)return;
  let list=[];
  try{list=await API.get('/hypotheses/'+(state.data.caseId?'?case_id='+encodeURIComponent(state.data.caseId):''));}
  catch(e){el.innerHTML='';return;}
  const col=s=>s==='supported'?'var(--success)':s==='refuted'?'var(--danger)':'var(--accent)';
  const badge=s=>'<span style="font-size:0.6rem;padding:1px 6px;border-radius:8px;background:'+col(s)+';color:#fff">'+esc(s)+'</span>';
  const inS='padding:5px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--text);font-size:0.8rem';
  let h='<div class="evt-bar"><b>Hypotheses</b> <span style="opacity:0.6;font-size:0.75rem">theory of the case</span><div style="flex:1"></div>'
    +'<input id="hypNew" placeholder="New hypothesis title…" style="'+inS+';flex:0 0 260px" onkeydown="if(event.key===\'Enter\')_hypAdd()">'
    +'<button class="btn-sm" id="hypAddBtn">+ Add</button></div>';
  if(!list.length)h+='<div class="evt-empty" style="padding:10px">No hypotheses yet — capture your working theory of the case.</div>';
  else h+='<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px">'+list.map(hy=>
    '<div class="evt-card" style="--ec:'+col(hy.status)+'"><div class="evt-card-h"><b>'+esc(hy.title)+'</b> '+badge(hy.status)+'<div style="flex:1"></div>'
    +'<select class="hypStatus" data-id="'+hy.id+'" style="font-size:0.7rem;padding:2px 4px;border:1px solid var(--line);border-radius:5px;background:var(--surface);color:var(--text)">'
    +['open','supported','refuted'].map(s=>'<option value="'+s+'"'+(s===hy.status?' selected':'')+'>'+s+'</option>').join('')+'</select>'
    +'<button class="evidence-rm hypDel" data-id="'+hy.id+'" title="Delete">&times;</button></div>'
    +(hy.body?'<div class="evt-detail">'+esc(hy.body)+'</div>':'')
    +(hy.subjects&&hy.subjects.length?'<div class="evidence-meta">Subjects: '+hy.subjects.map(s=>esc(s)).join(', ')+'</div>':'')
    +'<div class="evidence-meta">'+(hy.created_by?esc(hy.created_by)+' · ':'')+(hy.updated_at?_fmtDT(hy.updated_at):'')+'</div></div>').join('')+'</div>';
  el.innerHTML=h;
  el.querySelectorAll('.hypStatus').forEach(s=>s.onchange=async()=>{try{await API.put('/hypotheses/'+s.dataset.id,{status:s.value});renderHypotheses(el);}catch(e){try{toast('Update failed')}catch(_){}}});
  el.querySelectorAll('.hypDel').forEach(b=>b.onclick=async()=>{if(!confirm('Delete this hypothesis?'))return;try{await API.del('/hypotheses/'+b.dataset.id);renderHypotheses(el);}catch(e){}});
  const ab=el.querySelector('#hypAddBtn');if(ab)ab.onclick=_hypAdd;
}
export async function _hypAdd(){
  const inp=document.getElementById('hypNew');if(!inp)return;const t=(inp.value||'').trim();if(!t)return;
  try{await API.post('/hypotheses/',{case_id:state.data.caseId||null,title:t});inp.value='';renderHypotheses(document.getElementById('hypPanel'));}
  catch(e){try{toast('Add failed: '+e.message)}catch(_){}}
}
export async function renderRelationships(el){
  if(!el)return;
  let list=[];try{list=await API.get('/relationships/');}catch(e){el.innerHTML='';return;}
  const inS='padding:5px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--text);font-size:0.8rem';
  let h='<div class="evt-bar"><b>Relationship labels</b> <span style="opacity:0.6;font-size:0.75rem">links between subjects</span><div style="flex:1"></div>'
    +'<input id="relA" placeholder="Subject A" style="'+inS+';flex:0 0 130px"><input id="relB" placeholder="Subject B" style="'+inS+';flex:0 0 130px">'
    +'<input id="relL" placeholder="label (e.g. brothers)" style="'+inS+';flex:0 0 150px"><button class="btn-sm" id="relAddBtn">+ Add</button></div>';
  if(list.length)h+='<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px">'+list.map(r=>
    '<span style="display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border:1px solid var(--line);border-radius:14px;font-size:0.74rem">'
    +esc(r.subject_a)+' — <b>'+esc(r.label)+'</b> — '+esc(r.subject_b)
    +' <button class="relDel" data-a="'+esc(r.subject_a)+'" data-b="'+esc(r.subject_b)+'" title="Remove" style="border:0;background:none;cursor:pointer;color:var(--danger)">&times;</button></span>').join('')+'</div>';
  else h+='<div class="evt-empty" style="padding:8px">No relationship labels yet.</div>';
  el.innerHTML=h;
  const add=el.querySelector('#relAddBtn');
  if(add)add.onclick=async()=>{const a=el.querySelector('#relA').value.trim(),b=el.querySelector('#relB').value.trim(),l=el.querySelector('#relL').value.trim();if(!a||!b||!l)return;try{await API.put('/relationships/',{subject_a:a,subject_b:b,label:l});renderRelationships(el);}catch(e){try{toast('Add failed: '+e.message)}catch(_){}}};
  el.querySelectorAll('.relDel').forEach(bn=>bn.onclick=async()=>{try{await API.put('/relationships/',{subject_a:bn.dataset.a,subject_b:bn.dataset.b,label:''});renderRelationships(el);}catch(e){}});
}
export function renderEvidenceTab(){
  const box=D.evidenceTab;if(!box)return;updateEvidenceCount();
  const list=evLoad();
  const head='<div id="hypPanel" style="margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--line)"></div>'
    +'<div id="relPanel" style="margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--line)"></div>'
    +'<div class="evt-bar"><div><b>'+n(list.length)+'</b> saved item'+(list.length===1?'':'s')+(state.data.caseId?' · case '+esc(state.data.caseId):'')+'</div>'
    +'<div style="flex:1"></div>'
    +'<button class="btn-sm" id="evtDossierBtn">Open dossier</button>'
    +'<button class="btn-sm" id="evtExportBtn">Export (.json)</button>'
    +'<button class="btn-sm btn-danger" id="evtClearBtn">Clear all</button></div>';
  if(!list.length){box.innerHTML=head+'<div class="evt-empty">No evidence saved for this case yet.<br><span class="story-muted">Pin findings (☆) on the <b>Story</b> tab, or use <b>★ Pin</b> on any chart, or capture the <b>Cross-Case</b> graph — they all collect here and flow into the court dossier.</span></div>';}
  else{
    box.innerHTML=head+'<div class="evt-grid">'+list.slice().reverse().map(it=>{const m=EVK[it.kind]||{c:'#888',g:'●',l:it.kind};
      return '<div class="evt-card" style="--ec:'+m.c+'"><div class="evt-card-h"><span class="story-ev-dot">'+m.g+'</span><b>'+esc(it.label||'')+'</b><span class="evt-kind">'+esc(m.l)+'</span>'
        +'<button class="evidence-rm" data-id="'+it.id+'" title="Remove">&times;</button></div>'
        +(it.image?'<img class="evt-img" src="'+it.image+'">':'')
        +(it.detail?'<div class="evt-detail">'+esc(it.detail)+'</div>':'')
        +'<div class="evidence-meta">'+(it.subject?'Subject '+esc(it.subject)+' · ':'')+(it.ts?_fmtDT(it.ts)+' · ':'')+'pinned '+_fmtDT(it.addedAt)+'</div></div>';
    }).join('')+'</div>';
  }
  box.querySelectorAll('.evidence-rm').forEach(b=>b.onclick=()=>{unpinEvidence(b.dataset.id);renderEvidenceTab();});
  const cb=box.querySelector('#evtClearBtn');if(cb)cb.onclick=()=>{if(confirm('Remove all '+evLoad().length+' evidence item(s)?')){evSave([]);updateEvidenceCount();renderEvidence();refreshCapButtons();renderEvidenceTab();_renderStoryTimeline&&_renderStoryTimeline();}};
  const db=box.querySelector('#evtDossierBtn');if(db)db.onclick=()=>_renderDossier();
  const xb=box.querySelector('#evtExportBtn');if(xb)xb.onclick=()=>{const blob=new Blob([JSON.stringify(evLoad(),null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='ARGUS_evidence_'+(state.data.caseId||'case')+'.json';a.click();URL.revokeObjectURL(a.href);};
  renderHypotheses(document.getElementById('hypPanel'));   // investigation workspace: theory of the case
  renderRelationships(document.getElementById('relPanel')); // + labelled links between subjects
}

// This tab owns its rendering; register with the router.
registerTab('evidence', renderEvidenceTab);
