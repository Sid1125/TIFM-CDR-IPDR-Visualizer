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
import { reconstructSessions } from '../services/sessions.js';
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
    // Activity events: the synthesized per-session reads ("Probable WhatsApp Voice Call · 86%").
    // Bounded to the notable ones — confident enough AND long/heavy enough to narrate.
    try{
      reconstructSessions(subject)
        .filter(s=>s.eventTitle&&(s.eventConfidence||0)>=55&&((s.duration||0)>=60||(s.records||0)>=5))
        .slice(0,120)
        .forEach(s=>{
          const durTxt=s.duration>=3600?(s.duration/3600).toFixed(1)+' h':s.duration>=60?Math.round(s.duration/60)+' min':(s.duration||0)+' s';
          ev.push({ts:new Date(s.start),kind:'activity',title:s.eventTitle,
            detail:durTxt+' · '+(s.eventActivity||'')+' · '+(s.eventConfidence||0)+'% confidence'+(s.provider?' · '+s.provider:''),
            sub:subject,end:s.end,conf:s.eventConfidence,dur:s.duration});
        });
    }catch(e){}
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

// ── Narrative synthesis: events -> day-grouped prose paragraphs ──
const _dayKey=ts=>{const d=new Date(ts);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')};
const _dayLabel=ts=>new Date(ts).toLocaleDateString([], {year:'numeric',month:'long',day:'numeric'});
const _hm=ts=>new Date(ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
const _durTxt=s=>s>=3600?(s/3600).toFixed(1)+' h':s>=60?Math.round(s/60)+' min':s+' s';
const _list=(items,max)=>{const shown=items.slice(0,max);return shown.join(', ')+(items.length>max?' and '+(items.length-max)+' more':'')};

// One prose paragraph for one day of one subject's life in the case.
function _dayParagraph(dayEvents,dayRecords){
  const parts=[];
  // Voice/SMS from the raw CDR rows of that day (the milestone feed only marks FIRST contact).
  const cdr=dayRecords.filter(r=>r.type==='CDR');
  if(cdr.length){
    const isSms=r=>((r.cll||'')+'').toUpperCase().includes('SMS');
    const calls=cdr.filter(r=>!isSms(r)),sms=cdr.filter(isSms);
    if(calls.length){
      const byPeer={};calls.forEach(r=>{if(r.cnt)byPeer[r.cnt]=(byPeer[r.cnt]||0)+1});
      const peers=Object.entries(byPeer).sort((a,b)=>b[1]-a[1]);
      const totalMin=Math.round(calls.reduce((s,r)=>s+(r.dur||0),0)/60);
      let s='made or received <b>'+calls.length+'</b> call'+(calls.length===1?'':'s')
        +(totalMin?' ('+totalMin+' min total)':'');
      if(peers.length)s+=', most frequently with <b>'+esc(peers[0][0])+'</b>'+(peers[0][1]>1?' ('+peers[0][1]+' calls)':'');
      parts.push(s);
    }
    if(sms.length)parts.push('exchanged <b>'+sms.length+'</b> SMS message'+(sms.length===1?'':'s'));
  }
  // Activity events: group identical titles into one clause each.
  const acts=dayEvents.filter(e=>e.kind==='activity');
  if(acts.length){
    const byTitle={};
    acts.forEach(e=>{(byTitle[e.title]=byTitle[e.title]||[]).push(e)});
    Object.entries(byTitle).forEach(([title,list])=>{
      const lower=title.charAt(0).toLowerCase()+title.slice(1);
      const best=list.reduce((a,b)=>(b.conf||0)>(a.conf||0)?b:a,list[0]);
      const longest=list.reduce((m,e)=>Math.max(m,e.dur||0),0);
      if(list.length===1){
        const e=list[0];
        parts.push('at <b>'+_hm(e.ts)+'</b>'+(e.end?'–'+_hm(e.end):'')+', a <b>'+esc(lower)+'</b>'
          +(e.dur?' ('+_durTxt(e.dur)+', '+(e.conf||0)+'% confidence)':' ('+(e.conf||0)+'% confidence)'));
      }else{
        parts.push('<b>'+list.length+'</b> sessions read as <b>'+esc(lower)+'</b> between <b>'+_hm(list[0].ts)+'</b> and <b>'+_hm(list[list.length-1].ts)+'</b>'
          +(longest?' (longest '+_durTxt(longest)+', up to '+(best.conf||0)+'% confidence)':''));
      }
    });
  }
  // Meetings, movement, identity changes of that day.
  dayEvents.filter(e=>e.kind==='meeting').slice(0,3).forEach(m=>parts.push('was <b>co-located with '+esc(m.cnt||'?')+'</b> at '+_hm(m.ts)+' ('+esc(m.detail||'')+')'));
  const moves=dayEvents.filter(e=>e.kind==='move');
  if(moves.length)parts.push('appeared at '+(moves.length===1?'a new tower':moves.length+' new towers')+': '+_list(moves.map(m=>esc(m.title.replace('First seen at tower ',''))),3));
  dayEvents.filter(e=>e.kind==='identity').forEach(c=>parts.push('<b>'+esc(c.title.toLowerCase())+'</b> ('+esc(c.detail||'')+')'));
  if(!parts.length)return null;
  // Assemble: "The subject <part>; <part>; and <part>."
  let body=parts.length===1?parts[0]:parts.slice(0,-1).join('; ')+'; and '+parts[parts.length-1];
  return 'The subject '+body+'.';
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
  const paras=[];
  // Intro paragraph: who, when, principal contacts, footprint, cross-case.
  const first=events.find(e=>e.kind==='first');
  const contacts=events.filter(e=>e.kind==='call');
  const moves=events.filter(e=>e.kind==='move');
  const xcs=events.filter(e=>e.kind==='crosscase');
  let intro='';
  if(first)intro+='<b>'+subjLabel(subject)+'</b> first appears in this case on <b>'+_fmtDT(first.ts)+'</b> ('+esc(first.detail)+'). ';
  if(contacts.length)intro+='Principal contacts: '+_list(contacts.map(c=>'<b>'+esc(c.cnt)+'</b>'),4)+'. ';
  if(moves.length)intro+='Their movement footprint covers <b>'+moves.length+(moves.length>=8?'+':'')+'</b> distinct towers. ';
  if(xcs.length)intro+='<b>Cross-case:</b> the subject also appears in '+xcs.length+' other case'+(xcs.length===1?'':'s')+' ('+_list(xcs.map(x=>esc(x.title.replace('Also appears in case ',''))),3)+'). ';
  if(intro)paras.push('<p class="story-para-intro">'+intro+'</p>');
  // Day paragraphs: every day that has narratable events or records, busiest days kept
  // when there are too many to read.
  const owned=state.data.records.filter(r=>r.ts&&(r.sub===subject||r.msisdn===subject));
  const recsByDay={};owned.forEach(r=>{(recsByDay[_dayKey(r.ts)]=recsByDay[_dayKey(r.ts)]||[]).push(r)});
  const evByDay={};events.filter(e=>['activity','meeting','move','identity'].includes(e.kind)).forEach(e=>{(evByDay[_dayKey(e.ts)]=evByDay[_dayKey(e.ts)]||[]).push(e)});
  const allDays=[...new Set([...Object.keys(recsByDay),...Object.keys(evByDay)])].sort();
  let days=allDays;
  const MAX_DAYS=10;
  if(allDays.length>MAX_DAYS){
    // Keep the busiest days, in chronological order, plus first + last for the arc.
    const weight=d=>((recsByDay[d]||[]).length)+((evByDay[d]||[]).length)*5;
    const busiest=allDays.slice().sort((a,b)=>weight(b)-weight(a)).slice(0,MAX_DAYS-2);
    days=[...new Set([allDays[0],...busiest,allDays[allDays.length-1]])].sort();
  }
  let skipped=0;
  days.forEach(d=>{
    const para=_dayParagraph(evByDay[d]||[],recsByDay[d]||[]);
    if(!para){skipped++;return}
    paras.push('<div class="story-para-day"><h5>'+esc(_dayLabel((evByDay[d]||recsByDay[d])[0].ts))+'</h5><p>'+para+'</p></div>');
  });
  if(allDays.length>days.length)paras.push('<p class="story-para-more">'+(allDays.length-days.length+skipped)+' further active day'+((allDays.length-days.length+skipped)===1?'':'s')+' omitted for brevity — the full detail is in the timeline below.</p>');
  // Flags paragraph: AI findings summarized last.
  const ais=events.filter(e=>e.kind==='ai');
  if(ais.length)paras.push('<p class="story-para-flags"><b>Flags:</b> '+_list(ais.map(a=>esc(a.title)),5)+'.</p>');
  if(!paras.length)return '<p class="story-muted">Not enough data to reconstruct a narrative for this subject.</p>';
  return '<div class="story-narr-paras">'+paras.join('')+'</div>';
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
