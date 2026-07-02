// story/story.js — the Story / Narrative tab: reconstructs a per-subject (or case-wide) investigation
// timeline from records, meetings, identity changes, cross-case links and AI findings, writes an
// auto-narrative, and lets the analyst pin story events into the evidence folder. Extracted from app.js
// (feature layer). Pulls the shared engines (identity, inference, meetings) + evidence board; showProfile
// in onclick strings resolves via the window bridge. Self-registers the story tab. No behavior change.

import { esc, fmt, n, _fmtDT } from '../core/utils.js';
import { D } from '../core/dom.js';
import { state } from '../core/state.js';
import { subjLabel, subjLabelTxt } from '../core/subjects.js';
import { rowsFor, towerMeta } from '../data/records.js';
import { recordSvcAttr } from '../services/attribution.js';
import { buildIdentityProfile } from '../services/identity.js';
import { getInfReport, INF } from '../services/inference.js';
import { ensureMeetingsLoaded, meetingsCache } from '../services/meetings.js';
import { EVK, evLoad, pinEvidence, unpinEvidenceBySig, renderEvidence, updateEvidenceCount } from '../workspace/evidence.js';
import { registerTab } from '../core/router.js';

let _storyEvents=[],_storyKinds=null,_storyXcaseCache={};

function _evSig(e){return e.kind+'|'+(e.ts?new Date(e.ts).getTime():'')+'|'+e.title}

// Assemble a meaningful, bounded chronological event feed for one subject (or '__all__').
export async function buildCaseEvents(subject){
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

export async function getStoryXcase(){
  const k=state.data.caseId||'none';if(_storyXcaseCache[k])return _storyXcaseCache[k];
  try{_storyXcaseCache[k]=await API.get('/cross-case/report?case_id='+encodeURIComponent(state.data.caseId||''));}catch(e){_storyXcaseCache[k]={subjects:[]};}
  return _storyXcaseCache[k];
}

export function buildStoryNarrative(subject,events){
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

export function renderStoryTimeline(){
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

// Reset the story caches — called from app.js on case reset and dossier regeneration (those live
// outside this module, so they can't touch the module-local caches directly).
export function resetStory(){ _storyEvents=[]; _storyKinds=null; _storyXcaseCache={}; }

// Story listeners + tab registration (story-refresh also drops the inference cache).
if(D.storySubject)D.storySubject.addEventListener('change',renderStory);
if(D.storyRefreshBtn)D.storyRefreshBtn.addEventListener('click',()=>{_storyXcaseCache={};INF.report=null;renderStory();});
registerTab('story', renderStory);
