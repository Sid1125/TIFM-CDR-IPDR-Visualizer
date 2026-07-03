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
  activity:{c:'#1f7a8c',g:'▶',l:'Activity event'},
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

// ── Server sync ──
// The board is server-persisted (shared across investigators/browsers, every review in the
// chain of custody); localStorage stays the synchronous working cache so all existing render
// paths keep working. Server wins for review state (status/note/reviewer); the union of items
// is kept and local-only pins are pushed up. Best-effort: offline, everything still works
// locally and syncs on the next load.
let _evSyncedCase=null;
export async function syncEvidence(force){
  const cid=state.data.caseId||'';
  if(!force&&_evSyncedCase===cid)return;
  let server;
  try{server=await API.get('/evidence/'+(cid?'?case_id='+encodeURIComponent(cid):''));}catch(e){return}
  _evSyncedCase=cid;
  const local=evLoad();
  const bySig={};local.forEach(it=>bySig[it.sig]=it);
  for(const s of server){
    const it=bySig[s.sig];
    if(it){ // server owns review state + identity
      it.srvId=s.id;it.status=s.status;it.note=s.note;it.reviewedBy=s.reviewed_by;it.reviewedAt=s.reviewed_at;
      if(!it.image&&s.image)it.image=s.image;
    }else{
      local.push({id:'ev_'+s.id,sig:s.sig,srvId:s.id,addedAt:s.created_at||new Date().toISOString(),kind:s.kind,label:s.label,detail:s.detail||'',ts:s.ts,subject:s.subject,image:s.image,status:s.status,note:s.note,reviewedBy:s.reviewed_by,reviewedAt:s.reviewed_at});
    }
  }
  // Push local-only pins up (sequentially; images can be large).
  const serverSigs=new Set(server.map(s=>s.sig));
  for(const it of local){
    if(serverSigs.has(it.sig))continue;
    try{const saved=await API.post('/evidence/',{case_id:cid||null,sig:it.sig,kind:it.kind,label:it.label,detail:it.detail,subject:it.subject,ts:it.ts,image:it.image});
      it.srvId=saved.id;it.status=saved.status;}catch(e){}
  }
  evSave(local);updateEvidenceCount();
}
function _evPush(item){ // fire-and-forget server pin; stores the server id back into the cache
  API.post('/evidence/',{case_id:state.data.caseId||null,sig:item.sig,kind:item.kind,label:item.label,detail:item.detail,subject:item.subject,ts:item.ts,image:item.image})
    .then(saved=>{const list=evLoad();const it=list.find(x=>x.sig===item.sig);if(it){it.srvId=saved.id;it.status=it.status||saved.status;evSave(list);}})
    .catch(()=>{});
}
export function pinEvidence(item){
  const list=evLoad();const sig=item.sig||(item.kind+'|'+item.label);
  if(list.some(x=>x.sig===sig))return false;
  const entry={id:'ev_'+Date.now()+'_'+Math.random().toString(36).slice(2,6),sig,addedAt:new Date().toISOString(),kind:item.kind||'note',label:item.label||'',detail:item.detail||'',ts:item.ts?new Date(item.ts).toISOString():null,subject:item.subject||null,image:item.image||null,status:'system',note:null};
  list.push(entry);
  evSave(list);_evPush(entry);updateEvidenceCount();renderEvidence();refreshCapButtons();if(state.tab==='evidence')renderEvidenceTab();return true;
}
export function unpinEvidence(id){
  const it=evLoad().find(x=>x.id===id);
  if(it&&it.srvId)API.del('/evidence/'+it.srvId).catch(()=>{});
  evSave(evLoad().filter(x=>x.id!==id));updateEvidenceCount();renderEvidence();refreshCapButtons();if(typeof _renderStoryTimeline==='function')_renderStoryTimeline();
}
export function unpinEvidenceBySig(sig){
  const it=evLoad().find(x=>x.sig===sig);
  if(it&&it.srvId)API.del('/evidence/'+it.srvId).catch(()=>{});
  evSave(evLoad().filter(x=>x.sig!==sig));updateEvidenceCount();renderEvidence();refreshCapButtons();
}
// ── Review lifecycle: system -> confirmed / rejected (+ note). Human judgement on machine
// findings — recorded locally at once, persisted to the server + chain of custody behind it.
export function reviewEvidence(id,changes){
  const list=evLoad();const it=list.find(x=>x.id===id);if(!it)return;
  if(changes.status!==undefined)it.status=changes.status;
  if(changes.note!==undefined)it.note=changes.note;
  it.reviewedBy=(state.auth.user&&state.auth.user.username)||it.reviewedBy||null;
  it.reviewedAt=new Date().toISOString();
  evSave(list);
  const send=()=>{if(it.srvId)API.put('/evidence/'+it.srvId,{status:changes.status,note:changes.note}).catch(()=>{});};
  if(it.srvId)send();else{_evPush(it);setTimeout(send,800);} // pin first if the item never synced
  renderEvidenceTab();renderEvidence();
}
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
// Lifecycle presentation: badge colour/label per review status.
const _EVST={system:{c:'var(--muted)',l:'System finding'},confirmed:{c:'var(--success)',l:'Confirmed evidence'},rejected:{c:'var(--danger)',l:'Rejected — false positive'}};
let _evFilter='all';

function _evCardHtml(it){
  const m=EVK[it.kind]||{c:'#888',g:'●',l:it.kind};
  const st=_EVST[it.status||'system']||_EVST.system;
  const badge='<span class="evt-status" style="--sc:'+st.c+'">'+st.l+'</span>';
  const conf=it.status==='confirmed',rej=it.status==='rejected';
  const actions='<div class="evt-actions">'
    +'<button class="btn-sm evt-act" data-act="confirm" data-id="'+it.id+'"'+(conf?' disabled':'')+'>&#x2713; Confirm</button>'
    +'<button class="btn-sm evt-act" data-act="reject" data-id="'+it.id+'"'+(rej?' disabled':'')+'>&#x2717; False positive</button>'
    +((conf||rej)?'<button class="btn-sm evt-act" data-act="reset" data-id="'+it.id+'">&#x21a9; Un-review</button>':'')
    +'<button class="btn-sm evt-act" data-act="note" data-id="'+it.id+'">&#x270E; '+(it.note?'Edit note':'Add note')+'</button>'
    +'</div>';
  return '<div class="evt-card evt-'+(it.status||'system')+'" style="--ec:'+m.c+'"><div class="evt-card-h"><span class="story-ev-dot">'+m.g+'</span><b>'+esc(it.label||'')+'</b><span class="evt-kind">'+esc(m.l)+'</span>'
    +'<button class="evidence-rm" data-id="'+it.id+'" title="Remove">&times;</button></div>'
    +badge
    +(it.image?'<img class="evt-img" src="'+it.image+'">':'')
    +(it.detail?'<div class="evt-detail">'+esc(it.detail)+'</div>':'')
    +(it.note?'<div class="evt-note">&#x270E; '+esc(it.note)+'</div>':'')
    +'<div class="evidence-meta">'+(it.subject?'Subject '+esc(it.subject)+' · ':'')+(it.ts?_fmtDT(it.ts)+' · ':'')+'pinned '+_fmtDT(it.addedAt)
    +(it.reviewedBy?' · reviewed by '+esc(it.reviewedBy)+(it.reviewedAt?' '+_fmtDT(it.reviewedAt):''):'')+'</div>'
    +actions+'</div>';
}

export function renderEvidenceTab(){
  const box=D.evidenceTab;if(!box)return;updateEvidenceCount();
  // Pull the shared board once per case (async; re-renders when it lands).
  syncEvidence().then(()=>{if(state.tab==='evidence'&&_evSyncedCase===(state.data.caseId||''))_evRepaint();});
  _evRepaint();
  function _evRepaint(){
  const all=evLoad();
  const counts={all:all.length,system:0,confirmed:0,rejected:0};
  all.forEach(it=>{counts[it.status||'system']=(counts[it.status||'system']||0)+1});
  const list=_evFilter==='all'?all:all.filter(it=>(it.status||'system')===_evFilter);
  const chips=['all','system','confirmed','rejected'].map(f=>
    '<button class="story-chip evt-chip'+(f===_evFilter?' on':'')+'" data-f="'+f+'">'
    +(f==='all'?'All':f==='system'?'Unreviewed':f.charAt(0).toUpperCase()+f.slice(1))+' ('+(counts[f]||0)+')</button>').join('');
  const head='<div id="hypPanel" style="margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--line)"></div>'
    +'<div id="relPanel" style="margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--line)"></div>'
    +'<div class="evt-bar"><div><b>'+n(all.length)+'</b> saved item'+(all.length===1?'':'s')+(state.data.caseId?' · case '+esc(state.data.caseId):'')+'</div>'
    +'<div class="evt-chips">'+chips+'</div>'
    +'<div style="flex:1"></div>'
    +'<button class="btn-sm" id="evtReportBtn"><b>Build report</b></button>'
    +'<button class="btn-sm" id="evtDossierBtn">Open dossier</button>'
    +'<button class="btn-sm" id="evtExportBtn">Export (.json)</button>'
    +'<button class="btn-sm btn-danger" id="evtClearBtn">Clear all</button></div>';
  if(!list.length){box.innerHTML=head+'<div class="evt-empty">'+(all.length?'No items match this filter.':'No evidence saved for this case yet.<br><span class="story-muted">Pin findings (☆) on the <b>Story</b> tab, or use <b>★ Pin</b> on any chart, or capture the <b>Cross-Case</b> graph — they all collect here and flow into the court dossier.</span>')+'</div>';}
  else{
    box.innerHTML=head+'<div class="evt-grid">'+list.slice().reverse().map(_evCardHtml).join('')+'</div>';
  }
  box.querySelectorAll('.evt-chip').forEach(b=>b.onclick=()=>{_evFilter=b.dataset.f;renderEvidenceTab();});
  box.querySelectorAll('.evidence-rm').forEach(b=>b.onclick=()=>{unpinEvidence(b.dataset.id);renderEvidenceTab();});
  box.querySelectorAll('.evt-act').forEach(b=>b.onclick=()=>{
    const id=b.dataset.id,act=b.dataset.act;
    if(act==='confirm')reviewEvidence(id,{status:'confirmed'});
    else if(act==='reject')reviewEvidence(id,{status:'rejected'});
    else if(act==='reset')reviewEvidence(id,{status:'system'});
    else if(act==='note'){
      const it=evLoad().find(x=>x.id===id);
      const txt=prompt('Investigator note for “'+(it?it.label:'')+'”:',(it&&it.note)||'');
      if(txt!==null)reviewEvidence(id,{note:txt});
    }
  });
  const cb=box.querySelector('#evtClearBtn');if(cb)cb.onclick=()=>{if(confirm('Remove all '+evLoad().length+' evidence item(s)?')){evLoad().forEach(it=>{if(it.srvId)API.del('/evidence/'+it.srvId).catch(()=>{});});evSave([]);updateEvidenceCount();renderEvidence();refreshCapButtons();renderEvidenceTab();_renderStoryTimeline&&_renderStoryTimeline();}};
  const db=box.querySelector('#evtDossierBtn');if(db)db.onclick=()=>_renderDossier();
  const xb=box.querySelector('#evtExportBtn');if(xb)xb.onclick=()=>{const blob=new Blob([JSON.stringify(evLoad(),null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='ARGUS_evidence_'+(state.data.caseId||'case')+'.json';a.click();URL.revokeObjectURL(a.href);};
  const rb=box.querySelector('#evtReportBtn');if(rb)rb.onclick=()=>import('./report.js').then(m=>m.openReportBuilder()).catch(e=>{try{toast('Report builder failed to load')}catch(_){}});
  renderHypotheses(document.getElementById('hypPanel'));   // investigation workspace: theory of the case
  renderRelationships(document.getElementById('relPanel')); // + labelled links between subjects
  }
}

// This tab owns its rendering; register with the router.
registerTab('evidence', renderEvidenceTab);
