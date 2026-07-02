// analytics/ai.js — the AI Insights tab + AI-analyst chat/report. Two parts: (1) the analytics cache
// (getAiCache: pair counts, per-subject day histograms, service counts, all-meetings, identity-change
// cache — pre-warmed off-thread by the AI worker, with an inline fallback), and (2) the tab UI — case
// summary/overview, AI findings (with feedback), investigation leads, timeline narrative, subject
// summaries + questions, and the local-LLM (Ollama) chat + report generation over a compiled data
// package. Extracted from app.js (feature layer). Pulls the shared engines (sessions, meetings,
// identity) + the web-worker layer. showProfile in onclick strings resolves via the window bridge; the
// eight interactive handlers are re-exposed on window. Self-registers the AI tab. No behavior change.

import { esc, n } from '../core/utils.js';
import { D } from '../core/dom.js';
import { state } from '../core/state.js';
import { API } from '../core/api.js';
import { _W } from '../data/workers.js';
import { rowsFor } from '../data/records.js';
import { recordSvcAttr } from '../services/attribution.js';
import { reconstructSessions } from '../services/sessions.js';
import { detectMeetings, meetingTotals } from '../services/meetings.js';
import { buildIdentityProfile } from '../services/identity.js';
import { registerTab, tabNeedsRender, tabMarkRendered } from '../core/router.js';

window._aiCache=null;
window._aiCachePartial=null;  // pre-warmed by web worker; consumed by getAiCache()
window._aiCachePromise=null;

/**
 * Kick off the AI worker pre-warm.  Called after background load completes.
 * Result lands in _aiCachePartial; getAiCache() picks it up synchronously.
 */
export function _prefetchAiCache(){
  if(window._aiCachePartial||window._aiCachePromise||!state.data.records.length)return;
  window._aiCachePromise=_W.computeAi(state.data.records,state.watchlist||[]).then(result=>{
    window._aiCachePartial=result;
    window._aiCachePromise=null;
  }).catch(()=>{window._aiCachePromise=null;});
}

function getAiCache(){
  if(window._aiCache)return window._aiCache;
  const c={};
  c.subCount=state.subjects.length;
  c.totalRows=state.data.records.length;

  // Use pre-warmed worker result when available (avoids blocking the main thread)
  const partial=window._aiCachePartial;
  if(partial){
    c.pairCounts=partial.pairCounts||{};
    // Convert sub_days plain object -> Map<sub, Map<date, n>>
    c.subDays=new Map();
    Object.entries(partial.subDays||{}).forEach(([sub,days])=>{
      c.subDays.set(sub,new Map(Object.entries(days)));
    });
    c.svcCounts=partial.svcCounts||{};
    c.allMeetings=partial.allMeetings||[];
  }else{
    // Inline fallback (worker not ready or not supported)
    c.pairCounts={};state.data.records.forEach(r=>{if(r.sub&&r.cnt){const k=[r.sub,r.cnt].sort().join('|');c.pairCounts[k]=(c.pairCounts[k]||0)+1}});
    c.subDays=new Map();state.data.records.forEach(r=>{if(!r.tsMs||!r.sub)return;const d=new Date(r.tsMs).toLocaleDateString();if(!c.subDays.has(r.sub))c.subDays.set(r.sub,new Map());c.subDays.get(r.sub).set(d,(c.subDays.get(r.sub).get(d)||0)+1)});
    c.svcCounts={};state.data.records.forEach(r=>{const s=r.svc||'Unknown';c.svcCounts[s]=(c.svcCounts[s]||0)+1});
    c.allMeetings=detectMeetings({allPairs:true});
  }

  c.changeCache={};
  state.subjects.slice(0,30).forEach(s=>{c.changeCache[s]=buildIdentityProfile(s).changes});
  window._aiCache=c;
  return c;
}
export function invalidateAiCache(){window._aiCache=null;window._aiCachePartial=null;window._aiCachePromise=null;}

// AI inline-compute fallback (_aiComputeInline) -> data/workers.js

// -- Z-score spike detection --
// Requires: minimum 5-day baseline, minimum 20 records on spike day, z-score > 2.5
function findSpikes(subDays){
  const spikes=[];
  subDays.forEach((days,sub)=>{
    const entries=[...days.entries()].sort((a,b)=>new Date(a[0])-new Date(b[0]));
    if(entries.length<5)return; // need minimum baseline
    const values=entries.map(([,c])=>c);
    const avg=values.reduce((a,v)=>a+v,0)/values.length;
    const std=Math.sqrt(values.reduce((s,v)=>s+(v-avg)**2,0)/values.length)||1;
    entries.forEach(([d,c])=>{
      if(c<20)return; // minimum volume threshold
      const z=(c-avg)/std;
      if(z>2.5)spikes.push({sub,day:d,count:c,zScore:z,pct:avg?Math.round((c/avg-1)*100):0,avg});
    });
  });
  return spikes.sort((a,b)=>b.zScore-a.zScore);
}
// -- Confidence Breakdown Generator --
function confidenceBreakdown(baseScore,components){
  const total=components.reduce((s,c)=>s+c.value,baseScore);
  return{baseScore,components,total:Math.min(100,Math.max(0,total))};
}


function buildDataPackage(){
  if(!state.data.records.length)return'No records loaded.';
  const lines=[];
  const subs=new Set();state.data.records.forEach(r=>{if(r.sub)subs.add(r.sub);if(r.cnt)subs.add(r.cnt)});
  const ts=state.data.records.filter(r=>r.ts).map(r=>+new Date(r.ts));
  lines.push('Records: '+(_totalCdrFn()+_totalIpdrFn())+' ('+_totalCdrFn()+' CDR, '+_totalIpdrFn()+' IPDR)');
  lines.push('Period: '+(ts.length?new Date(Math.min(...ts)).toISOString().slice(0,10)+' -> '+new Date(Math.max(...ts)).toISOString().slice(0,10):'?'));
  lines.push('Entities: '+subs.size);
  const svcC={};state.data.records.forEach(r=>{const s=r.svc||'?';svcC[s]=(svcC[s]||0)+1});
  lines.push('Services: '+Object.entries(svcC).sort((a,b)=>b[1]-a[1]).slice(0,8).map(s=>s[0]+'('+s[1]+')').join(', '));
  const cntC={};state.data.records.forEach(r=>{if(r.cnt)cntC[r.cnt]=(cntC[r.cnt]||0)+1});
  lines.push('Top contacts: '+Object.entries(cntC).sort((a,b)=>b[1]-a[1]).slice(0,8).map(c=>c[0]+'('+c[1]+')').join(', '));
  const towC={};state.data.records.forEach(r=>{if(r.tow)towC[r.tow]=(towC[r.tow]||0)+1});
  lines.push('Top towers: '+Object.entries(towC).sort((a,b)=>b[1]-a[1]).slice(0,6).map(t=>t[0]+'('+t[1]+')').join(', '));
  const edg={};state.data.records.forEach(r=>{if(r.sub&&r.cnt){const k=[r.sub,r.cnt].sort().join('|');edg[k]=(edg[k]||0)+1}});
  lines.push('Top links: '+Object.entries(edg).sort((a,b)=>b[1]-a[1]).slice(0,6).map(e=>e[0].replace('|','<->')+'x'+e[1]).join(', '));
  const dirs={i:0,o:0};state.data.records.forEach(r=>{if(r.dir==='MT')dirs.i++;else if(r.dir==='MO')dirs.o++});
  const dTot=dirs.i+dirs.o||1;lines.push('Direction: '+Math.round(dirs.i/dTot*100)+'% in / '+Math.round(dirs.o/dTot*100)+'% out');
  const durs=state.data.records.filter(r=>r.dur!=null).map(r=>r.dur);
  if(durs.length)lines.push('Duration: avg '+Math.round(durs.reduce((s,v)=>s+v,0)/durs.length)+'s, max '+Math.max(...durs)+'s');
  const hrs=Array(24).fill(0);state.data.records.forEach(r=>{if(r.ts)hrs[new Date(r.ts).getHours()]++});
  const peakIdx=hrs.indexOf(Math.max(...hrs));lines.push('Peak hour: '+peakIdx+':00 ('+Math.max(...hrs)+' records)');
  const night=hrs.slice(0,6).concat(hrs.slice(20)).reduce((s,v)=>s+v,0);
  const day=hrs.slice(6,20).reduce((s,v)=>s+v,0);const tot=night+day||1;
  lines.push('Night activity: '+Math.round(night/tot*100)+'%');
  const protC={};state.data.records.filter(r=>r.type==='IPDR'&&r.prot).forEach(r=>{protC[r.prot]=(protC[r.prot]||0)+1});
  const p=Object.entries(protC).sort((a,b)=>b[1]-a[1]);if(p.length)lines.push('Protocols: '+p.slice(0,5).map(x=>x[0]+'('+x[1]+')').join(', '));

  // Sessions
  const sLines=[];
  const entList=[...subs].slice(0,20);
  entList.forEach(e=>{
    reconstructSessions(e).forEach(s=>{
      sLines.push(e+'|'+(s.serviceLabel||s.primary?.service||s.service||'')+'|'+(s.activityLabel||s.primary?.activity||s.activity||'')+'|'+Math.round(s.serviceConfidence)+'%|'+s.duration+'s');
    });
  });
  if(sLines.length)lines.push('Sessions ('+sLines.length+'): '+sLines.join('; '));

  return lines.join('\n');
}

function buildCsvDump(){
  if(!state.data.records.length)return '';
  const cdr=state.data.records.filter(r=>r.type==='CDR').slice(-500);
  const ipdr=state.data.records.filter(r=>r.type==='IPDR').slice(-500);
  const ts=(r)=>r.ts?Math.round(new Date(r.ts).getTime()/1000):'';
  const lines=['=== CDR ('+cdr.length+') ==='];
  lines.push('ts|sub|cnt|tow|dur|dir|svc');
  cdr.forEach(r=>lines.push([ts(r),r.sub,r.cnt,r.tow,r.dur,r.dir,r.svc].join('|')));
  lines.push('=== IPDR ('+ipdr.length+') ===');
  lines.push('ts|sub|cnt|prot|sport|dport|svc|tow|cell|up|dn');
  ipdr.forEach(r=>lines.push([ts(r),r.sub,r.cnt,r.prot,r.sport,r.dport,r.svc,r.tow,r.cell,r.bytesUp,r.bytesDn].join('|')));
  return lines.join('\n');
}

function renderAiInsights(){
  if(!state.data.records.length){
    document.getElementById('aiBody')&&(document.getElementById('aiBody').innerHTML='<p style="color:var(--muted);text-align:center;padding:20px">No data loaded. Upload CDR/IPDR files first.</p>');
    return;
  }
  if(!tabNeedsRender('ai'))return;
  state.scenario=document.getElementById('scenarioTag')?.value||'adhoc';
  // Do NOT call invalidateAiCache() here — cache is populated lazily and only cleared on
  // case load (state.render.gen change). Clearing on every tab switch re-scans 50k rows each time.
  buildCaseSummary(); // SECTION A: Why This Case Matters
  buildCaseOverview();
  buildAIFindings();
  buildInvestigationLeads();
  buildTimelineNarrative();
  buildSubjectSummaries();
  buildInvestigationQuestions();
  initContextChips();
  switchAiTab('overview');
  initAiTabs();
  tabMarkRendered('ai');
}
function switchAiTab(tab){
  document.querySelectorAll('.ai-tab-panel').forEach(p=>p.classList.toggle('active',p.dataset.aiPanel===tab));
  document.querySelectorAll('.ai-subtab').forEach(b=>b.classList.toggle('active',b.dataset.aiTab===tab));
}
function initAiTabs(){
  document.querySelectorAll('.ai-subtab').forEach(b=>{
    b.onclick=()=>switchAiTab(b.dataset.aiTab);
  });
}
function buildCaseSummary(){
  const container=document.getElementById('aiCaseOverview');if(!container)return;
  const c=getAiCache();
  const topPair=Object.entries(c.pairCounts).sort((a,b)=>b[1]-a[1])[0];
  const highMeets=c.allMeetings.filter(m=>m.gapLevel==='high');
  let hubSub=null,maxDeg=0;
  const degMap={};state.data.records.forEach(r=>{if(r.sub)degMap[r.sub]=(degMap[r.sub]||0)+1;if(r.cnt)degMap[r.cnt]=(degMap[r.cnt]||0)+1});
  Object.entries(degMap).forEach(([s,d])=>{if(d>maxDeg){maxDeg=d;hubSub=s}});
  const topPairParts=topPair?topPair[0].split('|'):null;
  let html='<h3 class="ai-section-title">Case Overview</h3><div class="ai-summary">';
  html+='<div><strong>Scope:</strong> '+c.subCount+' subjects, '+c.totalRows+' records across observation period.</div>';
  if(topPair)html+='<div><strong>Key Link:</strong> <span style="color:var(--accent);cursor:pointer" onclick="showProfile(\''+esc(topPairParts[0])+'\')">'+esc(topPairParts[0])+'</span> ? <span style="color:var(--accent);cursor:pointer" onclick="showProfile(\''+esc(topPairParts[1])+'\')">'+esc(topPairParts[1])+'</span> — '+topPair[1]+' interactions (highest volume).</div>';
  if(highMeets.length)html+='<div><strong>Meetings:</strong> '+highMeets.length+' high-confidence co-location events detected.</div>';
  if(hubSub)html+='<div><strong>Central Hub:</strong> <span style="color:var(--accent);cursor:pointer" onclick="showProfile(\''+esc(hubSub)+'\')">'+esc(hubSub)+'</span> appears to coordinate activity across '+maxDeg+' interactions.</div>';
  if(topPair&&highMeets.length){html+='<div class="ai-summary-bottom">Most significant finding: <strong>'+esc(topPairParts[0])+'</strong> and <strong>'+esc(topPairParts[1])+'</strong> show the highest communication volume'+(hubSub&&hubSub!==topPairParts[0]&&hubSub!==topPairParts[1]?', while <strong>'+esc(hubSub)+'</strong> acts as a hub bridging otherwise separate groups':'')+'.</div>';}
  html+='</div><div class="ai-overview-grid" id="aiOverviewGrid"></div><div id="fbExportArea" style="margin-top:8px;display:none;gap:6px;align-items:center;font-size:0.68rem"><span id="fbCount" style="color:var(--muted)"></span><button class="btn btn-sm" onclick="exportFeedback()" style="font-size:0.62rem;padding:2px 8px">Export Feedback</button></div>';
  container.innerHTML=html;
}
function buildCaseOverview(){
  const g=document.getElementById('aiOverviewGrid');if(!g)return;
  const total=_totalCdrFn()+_totalIpdrFn(),totalCdr=_totalCdrFn(),totalIpdr=_totalIpdrFn();
  const subs=new Set();state.data.records.forEach(r=>{if(r.sub)subs.add(r.sub);if(r.cnt)subs.add(r.cnt)});
  const ts=state.data.records.filter(r=>r.ts).map(r=>+new Date(r.ts));
  const span=ts.length?Math.round((ts.reduce((a,b)=>a>b?a:b,-Infinity)-ts.reduce((a,b)=>a<b?a:b,Infinity))/86400000):0;
  let meetings=0;try{meetings=meetingTotals().total}catch(e){}
  const sessions=state.subjects.reduce((sum,s)=>sum+reconstructSessions(s).length,0);
  let simSwaps=0,deviceChanges=0;
  state.subjects.slice(0,20).forEach(s=>{const c=buildIdentityProfile(s).changes;simSwaps+=c.filter(x=>x.type==='sim_swap').length;deviceChanges+=c.filter(x=>x.type==='device_change').length});
  const highRisk=Math.min(meetings+simSwaps+deviceChanges+Math.round(subs.size/10),99);
  const cards=[
    {v:subs.size,l:'Subjects',cls:''},{v:total,l:'Records',cls:''},
    {v:sessions,l:'Sessions',cls:''},{v:meetings,l:'Meetings',cls:meetings>5?'ai-ov-warn':''},
    {v:simSwaps,l:'SIM Swaps',cls:simSwaps?'ai-ov-warn':''},{v:deviceChanges,l:'Device Changes',cls:deviceChanges?'ai-ov-warn':''},
    {v:span+'d',l:'Observation Period',cls:''},{v:highRisk,l:'High-Risk Findings',cls:highRisk>5?'ai-ov-warn':'ai-ov-ok'}
  ];
  g.innerHTML=cards.map(c=>`<div class="ai-ov-card ${c.cls}"><div class="ai-ov-val">${c.v}</div><div class="ai-ov-label">${c.l}</div></div>`).join('');
}
function buildAIFindings(){
  const body=document.getElementById('aiFindingsBody');if(!body)return;
  const c=getAiCache();
  const findings=[];
  // HIGH: most contacted pairs
  const topPair=Object.entries(c.pairCounts).sort((a,b)=>b[1]-a[1])[0];
  if(topPair&&topPair[1]>10){
    const cb=confidenceBreakdown(50,[{label:'Volume > 10 interactions',value:20},{label:'Highest in dataset',value:15},{label:'Direct communication link',value:10}]);
    findings.push({level:'high',icon:'',title:topPair[0].split('|').join(' ↔ ')+' — '+topPair[1]+' interactions',desc:'Highest communication volume in the dataset',ev:'Volume: '+topPair[1]+' records',components:cb});
  }
  // HIGH: meetings
  const highMeets=c.allMeetings.filter(m=>m.gapLevel==='high');
  if(highMeets.length){
    const topM=highMeets[0];
    const cb=confidenceBreakdown(40,[{label:'Same tower',value:20},{label:'Tight time window ('+topM.gap+'m)',value:15},{label:'Repeated '+topM.encounterCount+' times',value:10},{label:'Movement similarity',value:topM.evidence.some(e=>e.includes('Movement similarity'))?10:0}]);
    findings.push({level:'high',icon:'',title:highMeets.length+' probable meeting'+(highMeets.length>1?'s':'')+' detected',desc:'Co-location events with tight time windows',ev:'Base: 40 + Same tower: 20 + Time window: 15 + Repeated: '+(topM.encounterCount>1?'15':'0')+' = '+cb.total+'%',components:cb});
  }
  // HIGH: activity spikes (z-score based)
  const spikes=findSpikes(c.subDays);
  const topSpike=spikes[0];
  if(topSpike){
    const cb=confidenceBreakdown(30,[{label:'Z-score: '+topSpike.zScore.toFixed(1)+' (>2.5 threshold)',value:25},{label:'Volume: '+topSpike.count+' records (=20 min)',value:20},{label:'Baseline: '+Math.round(topSpike.avg)+' avg/day',value:15},{label:'Anomaly: +'+topSpike.pct+'%',value:10}]);
    findings.push({level:'high',icon:'',title:'Activity spike on '+esc(topSpike.day)+' (+'+topSpike.pct+'%)',desc:esc(topSpike.sub)+' had '+topSpike.count+' records (z='+topSpike.zScore.toFixed(1)+', baseline '+Math.round(topSpike.avg)+'/day)',ev:'Z-score: '+topSpike.zScore.toFixed(1)+' (threshold 2.5); Baseline: '+Math.round(topSpike.avg)+' records/day; Spike: '+topSpike.count+' records',components:cb});
  }
  // MEDIUM: night activity
  const nightSubs=[];state.subjects.forEach(s=>{const rows=rowsFor(s).filter(r=>r.ts);const night=rows.filter(r=>{const h=new Date(r.ts).getHours();return h>=23||h<5});if(rows.length>5&&night.length/rows.length>0.5)nightSubs.push({sub:s,pct:Math.round(night.length/rows.length*100),nightCount:night.length,total:rows.length})});
  nightSubs.sort((a,b)=>b.pct-a.pct).slice(0,3).forEach(ns=>{
    const cb=confidenceBreakdown(30,[{label:'Night records: '+ns.nightCount+' ('+ns.pct+'%)',value:20},{label:'Total records: '+ns.total,value:15}]);
    findings.push({level:'med',icon:'',title:esc(ns.sub)+' — '+ns.pct+'% night activity',desc:ns.nightCount+' of '+ns.total+' records during 23:00-05:00',ev:'Base: 30 + Night proportion: 20 + Volume: 15 = '+cb.total+'%',components:cb});
  });
  // MEDIUM: top services
  const topSvcs=Object.entries(c.svcCounts).sort((a,b)=>b[1]-a[1]).slice(0,3);
  topSvcs.forEach(([s,vol])=>{
    const cb=confidenceBreakdown(25,[{label:'Volume: '+vol+' records',value:20},{label:'Share: '+Math.round(vol/c.totalRows*100)+'% of total',value:10}]);
    findings.push({level:'med',icon:'',title:'Heavy '+esc(s)+' usage — '+vol+' records',desc:esc(s)+' accounts for '+Math.round(vol/c.totalRows*100)+'% of all traffic',ev:'Base: 25 + Volume: 20 + Share: 10 = '+cb.total+'%',components:cb});
  });
  // LOW: tower transitions
  const towerMovements={};state.subjects.forEach(s=>{const rows=rowsFor(s).filter(r=>r.ts&&r.tow).sort((a,b)=>new Date(a.ts)-new Date(b.ts));let moves=0;for(let i=1;i<rows.length;i++){if(rows[i].tow!==rows[i-1].tow)moves++}if(moves>10)towerMovements[s]=moves});
  Object.entries(towerMovements).sort((a,b)=>b[1]-a[1]).slice(0,3).forEach(([s,m])=>{
    findings.push({level:'low',icon:'',title:esc(s)+' — '+m+' tower transitions',desc:'Frequent movement across '+new Set(rowsFor(s).filter(r=>r.tow).map(r=>r.tow)).size+' towers',ev:'Tower changes: '+m});
  });
  // LOW: dormant subjects
  state.subjects.forEach(s=>{const times=rowsFor(s).filter(r=>r.ts).map(r=>new Date(r.ts)).sort((a,b)=>a-b);if(times.length<5)return;let maxGap=0;for(let i=1;i<times.length;i++){const g=(times[i]-times[i-1])/3600000;if(g>maxGap)maxGap=g}if(maxGap>168)findings.push({level:'low',icon:'',title:esc(s)+' has '+Math.round(maxGap/24)+'d dormant period',desc:'No activity for over '+(maxGap>336?'2 weeks':'1 week'),ev:'Max inactivity gap: '+Math.round(maxGap/24)+' days'});});
  if(!findings.length){body.innerHTML='<p style="color:var(--muted);font-size:0.75rem">Insufficient data to generate findings.</p>';return}
  findings.forEach(f=>f._hash=findingHash(f));
  body.innerHTML='<div class="ai-findings-list">'+findings.map((f,i)=>`<div class="ai-finding ai-finding-${f.level}" onclick="toggleFindingDetail(${i})">
    <div class="ai-finding-body">
      <div class="ai-finding-title">${f.title}</div>
      <div class="ai-finding-desc">${f.desc}</div>
      <div class="ai-finding-ev" id="aiFindEv${i}" style="display:none">
        ${f.components?`<div style="margin-bottom:4px;padding-bottom:4px;border-bottom:1px solid var(--line)"><strong>Confidence: ${f.components.total}%</strong></div>
        <div>Base: ${f.components.baseScore}</div>
        ${f.components && f.components.components ? f.components.components.map(c=>`<div>+ ${c.label}: ${c.value>0?'+'+c.value:c.value}</div>`).join('') : ''}
        <div style="margin-top:2px;padding-top:2px;border-top:1px solid var(--line)"><strong>= ${f.components.total}%</strong></div><br>`:''}
        &#x2713; ${f.ev}
        <div style="margin-top:4px;display:flex;gap:4px;font-size:0.65rem">
          <span style="color:var(--muted);font-size:0.6rem;flex:1">Is this finding useful?</span>
          <button data-fbh="${f._hash}" data-v="useful" class="btn btn-sm" onclick="event.stopPropagation();markFinding('${esc(state.scenario||'unknown')}','${f._hash}','useful')" style="padding:1px 5px;font-size:0.6rem">&#x2713; Useful</button>
          <button data-fbh="${f._hash}" data-v="noise" class="btn btn-sm" onclick="event.stopPropagation();markFinding('${esc(state.scenario||'unknown')}','${f._hash}','noise')" style="padding:1px 5px;font-size:0.6rem">&#x2717; False Positive</button>
        </div>
      </div>
    </div>
  </div>`).join('')+'</div>';
  window._aiFindings=findings;
  // Restore persisted FP feedback for these findings
  findings.forEach((f,i)=>{
    const hash=f._hash;
    const saved=localStorage.getItem('fp_'+hash);
    if(saved){
      const fb=JSON.parse(saved);
      document.querySelectorAll(`[data-fbh="${hash}"]`).forEach(b=>{
        b.style.opacity=b.dataset.v===fb.verdict?'1':'0.3';
        b.style.background=b.dataset.v===fb.verdict?'var(--accent)':'';
      });
    }
  });
}
// -- False-Positive Tracking --
function findingHash(f){
  const str =
    (f.title || '') +
    '|' +
    (f.ev || '');

  let hash = 0;

  for(let i = 0; i < str.length; i++){
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }

  return 'F' + Math.abs(hash).toString(36);
}
function markFinding(scenario,hash,verdict){
  const fb={verdict,time:new Date().toISOString()};
  localStorage.setItem('fp_'+hash,JSON.stringify(fb));
  document.querySelectorAll(`[data-fbh="${hash}"]`).forEach(b=>{
    b.style.opacity=b.dataset.v===verdict?'1':'0.3';
    b.style.background=b.dataset.v===verdict?'var(--accent)':'';
  });
  const total=document.querySelectorAll('[data-fbh]').length;
  const marked=Object.keys(localStorage).filter(k=>k.startsWith('fp_')).length;
  const fbExport=document.getElementById('fbExportArea');const fbCount=document.getElementById('fbCount');
  if(fbExport)fbExport.style.display='flex';
  if(fbCount)fbCount.textContent='Feedback recorded: '+marked+' findings marked';
  console.log('[FP-TRACK]',scenario,hash,verdict);
}
function exportFeedback(){
  const data={};
  Object.keys(localStorage).filter(k=>k.startsWith('fp_')).forEach(k=>{data[k]=JSON.parse(localStorage.getItem(k))});
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='finding_feedback.json';a.click();
}
function toggleFindingDetail(i){
  const el=document.getElementById('aiFindEv'+i);
  if(el)el.style.display=el.style.display==='none'?'block':'none';
}
// Spatiotemporal Inferences tab (renderInferences + watchlist bar + buildInferenceHtml) -> analytics/inferences.js

function buildInvestigationLeads(){
  const g=document.getElementById('aiLeadsGrid');if(!g)return;
  const c=getAiCache();
  const leads=[];
  // Lead: most contacted subject (score: pair volume / max * 100)
  const topPair=Object.entries(c.pairCounts).sort((a,b)=>b[1]-a[1])[0];
  if(topPair){const maxV=topPair[1];const [a,b]=topPair[0].split('|');leads.push({score:Math.min(95,60+Math.round(topPair[1]/Math.max(...Object.values(c.pairCounts),1)*30)),title:'Investigate '+esc(b),reason:'Highest communication centrality ('+topPair[1]+' interactions)',action:'Show Profile',onclick:'showProfile(\''+esc(b)+'\')'})}
  // Lead: meeting cluster (score: based on count and confidence)
  const highMeets=c.allMeetings.filter(m=>m.gapLevel==='high');
  if(highMeets.length){const m=highMeets[0];leads.push({score:Math.min(90,50+m.score/2),title:'Review Meeting Cluster',reason:m.encounterCount+' co-location events between '+esc(m.subA)+' & '+esc(m.subB),action:'Switch to Timeline',onclick:"switchTab('timeline')"})}
  // Lead: SIM swap (score: 70-85 based on confidence)
  let leadSwap=null;state.subjects.slice(0,20).forEach(s=>{const ch=c.changeCache[s]||[];const sw=ch.filter(x=>x.type==='sim_swap');if(sw.length&&!leadSwap)leadSwap={sub:s,count:sw.length,conf:sw[0].confidence}});
  if(leadSwap)leads.push({score:leadSwap.conf==='high'?82:65,title:'Examine New SIM on '+esc(leadSwap.sub),reason:leadSwap.count+' SIM swap'+(leadSwap.count>1?'s':'')+' detected',action:'View Profile',onclick:'showProfile(\''+esc(leadSwap.sub)+'\')'});
  // Lead: device change
  let leadDev=null;state.subjects.slice(0,20).forEach(s=>{const ch=c.changeCache[s]||[];const dc=ch.filter(x=>x.type==='device_change');if(dc.length&&!leadDev)leadDev={sub:s,count:dc.length,conf:dc[0].confidence}});
  if(leadDev)leads.push({score:leadDev.conf==='high'?78:60,title:'Review Device Change on '+esc(leadDev.sub),reason:leadDev.count+' IMEI change'+(leadDev.count>1?'s':'')+' detected',action:'View Profile',onclick:'showProfile(\''+esc(leadDev.sub)+'\')'});
  // Lead: heavy night activity
  const nightSubs=[];state.subjects.forEach(s=>{const rows=rowsFor(s).filter(r=>r.ts);const night=rows.filter(r=>{const h=new Date(r.ts).getHours();return h>=23||h<5});if(rows.length>5&&night.length/rows.length>0.6)nightSubs.push({sub:s,pct:Math.round(night.length/rows.length*100)})});
  nightSubs.sort((a,b)=>b.pct-a.pct).slice(0,2).forEach(ns=>{leads.push({score:40+ns.pct/2,title:'Investigate Night Activity of '+esc(ns.sub),reason:ns.pct+'% of activity during late-night hours',action:'View Profile',onclick:'showProfile(\''+esc(ns.sub)+'\')'})});
  if(!leads.length){g.innerHTML='<p style="color:var(--muted);font-size:0.75rem;grid-column:1/-1">No leads generated yet.</p>';return}
  leads.sort((a,b)=>b.score-a.score);
  g.innerHTML=leads.slice(0,8).map(l=>`<div class="ai-lead" onclick="${l.onclick}">
    <div class="ai-lead-title" style="display:flex;gap:4px"><span class="ai-lead-score" style="font-size:0.62rem;color:${l.score>=80?'var(--danger)':l.score>=60?'var(--warn)':'var(--muted)'};font-weight:700">[${l.score}]</span> ${l.title}</div>
    <div class="ai-lead-reason">${l.reason}</div>
    <div class="ai-lead-action">${l.action} ?</div>
  </div>`).join('');
}
function buildTimelineNarrative(){
  const body=document.getElementById('aiNarrativeBody');if(!body)return;
  const subRank=state.subjects.map(s=>[s,state.data.records.filter(r=>r.sub===s||r.cnt===s).length]).sort((a,b)=>b[1]-a[1]);
  if(!subRank.length){body.innerHTML='<p style="color:var(--muted);font-size:0.75rem">No subjects with activity data.</p>';return}
  const selected=state._aiNarrativeSub||subRank[0][0];
  const topSub=state.subjects.includes(selected)?selected:subRank[0][0];
  const rows=rowsFor(topSub).filter(r=>r.ts).sort((a,b)=>new Date(a.ts)-new Date(b.ts));
  if(rows.length<3){body.innerHTML='<p style="color:var(--muted);font-size:0.75rem">Insufficient activity data for narrative.</p>';return}
  const sessions=reconstructSessions(topSub);
  const meetings=detectMeetings({subject:topSub,maxResults:10});
  // Build compressed day-grouped narrative (group consecutive same-type events into blocks)
  const dayGroups={};let lastTow=null,lastType=null,blockStart=null,blockEnd=null,blockCount=0,blockText=[];
  const flushBlock=(day)=>{
    if(!blockStart||!blockCount)return;
    const range=blockStart===blockEnd?blockStart:'<span style="color:var(--muted)">'+blockStart+'</span>—<span style="color:var(--muted)">'+blockEnd+'</span>';
    const summary=blockCount>1?` (—${blockCount})`:'';
    dayGroups[day].push({time:range,text:blockText.join('; ')+summary,dot:'var(--accent)',type:lastType});
    blockStart=null;blockEnd=null;blockCount=0;blockText=[];lastType=null;
  };
  rows.forEach(r=>{
    const t=new Date(r.ts);const day=t.toLocaleDateString();const time=t.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    if(!dayGroups[day])dayGroups[day]=[];
    let type='';
    if(r.type==='CDR')type='call';
    else if(r.svc)type=r.svc;
    else type='ipdr';
    // If same type and close in time, group into block
    if(type===lastType&&blockCount>0){blockEnd=time;blockCount++}
    else{
      flushBlock(day);
      blockStart=time;blockEnd=time;blockCount=1;lastType=type;
      if(r.type==='CDR')blockText=[(r.dir||'')+' call with '+(r.cnt||'unknown')];
      else if(r.svc)blockText=[esc(r.svc)+' session'];
      else blockText=['IPDR activity'];
    }
    if(r.tow&&r.tow!==lastTow&&lastTow){
      flushBlock(day);
      dayGroups[day].push({time,text:'Tower change ? '+esc(r.tow),dot:'var(--warn)',type:'tower'});
    }
    if(r.tow)lastTow=r.tow;
  });
  // Flush remaining block
  const lastDay=Object.keys(dayGroups).pop();
  if(lastDay)flushBlock(lastDay);
  // Add sessions and meetings
  sessions.forEach(s=>{if(s.start&&s.duration){
    const t=new Date(s.start);const day=t.toLocaleDateString();const time=t.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    const svc=s.primary?s.primary.service:(s.service||'');
    if(svc&&dayGroups[day]){const dur=s.duration>=3600?Math.round(s.duration/60)+'m':s.duration+'s';dayGroups[day].push({time,text:'Long session: '+esc(svc)+' ('+dur+')',dot:'var(--success)',type:'session'})}
  }});
  meetings.forEach(m=>{if(!m.time)return;
    const t=new Date(m.time);const day=t.toLocaleDateString();const time=t.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    if(dayGroups[day])dayGroups[day].push({time,text:'Meeting: '+esc(m.subB)+' at '+esc(m.tow),dot:'var(--danger)',type:'meeting'});
  });
  // Sort each day's events by time
  Object.keys(dayGroups).forEach(d=>dayGroups[d].sort((a,b)=>a.time.localeCompare(b.time)));
  const days=Object.keys(dayGroups).sort((a,b)=>new Date(a)-new Date(b));
  const baseDate=days.length?new Date(days[0]):null;
  // Subject selector + narrative header
  let html='<div class="ai-narr-head"><select class="ai-narr-select" onchange="switchNarrativeSubject(this.value)">'+subRank.slice(0,30).map(([s])=>'<option value="'+esc(s)+'"'+(s===topSub?' selected':'')+'>'+esc(s)+' ('+state.data.records.filter(r=>r.sub===s||r.cnt===s).length+' records)</option>').join('')+'</select></div>';
  html+='<div class="ai-narrative">'+days.slice(0,7).map(d=>{
    const dt=new Date(d);const rel=baseDate?'Day '+Math.round((dt-baseDate)/86400000+1):d;
    return `<div class="ai-narr-day">${rel} — ${d}</div>
      ${dayGroups[d].slice(0,12).map(e=>`<div class="ai-narr-event"><span class="ai-narr-time">${e.time}</span><span class="ai-narr-dot" style="background:${e.dot}"></span><span class="ai-narr-text" title="${esc(e.text)}">${esc(e.text)}</span></div>`).join('')}`;
  }).join('')+'</div>';
  body.innerHTML=html;
}
function switchNarrativeSubject(sub){
  state._aiNarrativeSub=sub;
  buildTimelineNarrative();
}
function buildSubjectSummaries(){
  const g=document.getElementById('aiSubjGrid');if(!g)return;
  const c=getAiCache();
  const sorted=state.subjects.map(s=>{
    const rows=rowsFor(s);const contacts=new Set();let towerCount=0,nightCount=0,dayCount=0;
    rows.forEach(r=>{if(r.cnt&&r.cnt!==s)contacts.add(r.cnt);if(r.tow)towerCount++;if(r.ts){const h=new Date(r.ts).getHours();if(h>=23||h<5)nightCount++;else dayCount++}});
    const topSvc=Object.entries(rows.reduce((a,r)=>{const sv=r.svc||'Unknown';a[sv]=(a[sv]||0)+1;return a},{}),).sort((a,b)=>b[1]-a[1])[0];
    const meetings=detectMeetings({subject:s,maxResults:50});
    const changes=c.changeCache[s]||[];
    const nightPct=nightCount+dayCount?Math.round(nightCount/(nightCount+dayCount)*100):0;
    // Build descriptive characteristics (not risk labels)
    const chars=[];
    if(meetings.length>3)chars.push('Multiple co-location events ('+meetings.length+')');
    if(nightPct>60)chars.push('Night-dominant activity ('+nightPct+'%)');
    if(contacts.size>15)chars.push('High communication volume ('+contacts.size+' contacts)');
    if(changes.filter(x=>x.type==='sim_swap').length)chars.push('SIM change detected');
    if(changes.filter(x=>x.type==='device_change').length)chars.push('Device change detected');
    if(towerCount>20)chars.push('High mobility ('+towerCount+' tower visits)');
    const topSvcName=topSvc?topSvc[0]:'n/a';
    if(topSvcName!=='n/a'&&topSvc&&topSvc[1]>10)chars.push('Primary service: '+topSvcName);
    const assessment=chars.length?chars.join(' — '):'Limited data available';
    return{s,contacts:contacts.size,tower:towerCount,nightPct,topSvc:topSvcName,meetings:meetings.length,simSwaps:changes.filter(c=>c.type==='sim_swap').length,deviceChanges:changes.filter(c=>c.type==='device_change').length,assessment,contactCount:contacts.size};
  }).sort((a,b)=>b.meetings*3+b.nightPct-(a.meetings*3+a.nightPct));
  if(!sorted.length){g.innerHTML='<p style="color:var(--muted);font-size:0.75rem;grid-column:1/-1">No subjects loaded.</p>';return}
  g.innerHTML=sorted.slice(0,12).map(s=>`<div class="ai-subj-card" onclick="showProfile('${esc(s.s)}')">
    <div class="ai-subj-name" onclick="event.stopPropagation();showProfile('${esc(s.s)}')">${esc(s.s)}</div>
    <div class="ai-subj-row"><span class="ai-subj-label">Contacts</span><span class="ai-subj-val">${s.contacts}</span></div>
    <div class="ai-subj-row"><span class="ai-subj-label">Top Service</span><span class="ai-subj-val">${esc(s.topSvc)}</span></div>
    <div class="ai-subj-row"><span class="ai-subj-label">Night Activity</span><span class="ai-subj-val">${s.nightPct}%</span></div>
    <div class="ai-subj-row"><span class="ai-subj-label">Meetings</span><span class="ai-subj-val">${s.meetings}</span></div>
    <div class="ai-subj-row"><span class="ai-subj-label">SIM Swaps</span><span class="ai-subj-val" style="color:${s.simSwaps?'var(--warn)':''}">${s.simSwaps}</span></div>
    <div class="ai-subj-row"><span class="ai-subj-label">Device Changes</span><span class="ai-subj-val" style="color:${s.deviceChanges?'var(--warn)':''}">${s.deviceChanges}</span></div>
    <div class="ai-subj-assessment">${s.assessment}</div>
  </div>`).join('');
}
function buildInvestigationQuestions(){
  const body=document.getElementById('aiQuestionsBody');if(!body)return;
  const c=getAiCache();
  const questions=[];
  // Q1: Activity spikes (using z-score)
  const spikes=findSpikes(c.subDays);
  const topSpike=spikes[0];
  if(topSpike)questions.push({q:'Why did activity spike on '+esc(topSpike.day)+' for '+esc(topSpike.sub)+' (z='+topSpike.zScore.toFixed(1)+', +'+topSpike.pct+'%)?',ctx:'activity spike'});
  // Q2: IMEI/IMSI changes
  const allChanges=[];state.subjects.forEach(s=>{(c.changeCache[s]||[]).forEach(ch=>allChanges.push({...ch,sub:s}))});
  const lastChange=allChanges.sort((a,b)=>b.time-a.time)[0];
  if(lastChange)questions.push({q:'Why did '+esc(lastChange.sub)+' '+(lastChange.type==='sim_swap'?'change SIM':'switch device')+' '+esc(lastChange.from)+' — '+esc(lastChange.to)+' on '+lastChange.time.toLocaleDateString()+'?',ctx:'identity change'});
  // Q3: Shared contacts without direct communication
  const contactOverlaps=[];const subs=state.subjects.slice(0,20);
  for(let i=0;i<subs.length;i++){for(let j=i+1;j<subs.length;j++){
    const a=rowsFor(subs[i]),b=rowsFor(subs[j]);
    const cntsA=new Set(a.map(r=>r.cnt).filter(Boolean));
    const cntsB=new Set(b.map(r=>r.cnt).filter(Boolean));
    const common=[...cntsA].filter(x=>cntsB.has(x)).filter(x=>x!==subs[i]&&x!==subs[j]);
    if(common.length>=5&&!a.some(r=>r.cnt===subs[j])&&!b.some(r=>r.cnt===subs[i]))contactOverlaps.push({a:subs[i],b:subs[j],count:common.length})}}
  contactOverlaps.sort((a,b)=>b.count-a.count).slice(0,2).forEach(co=>{questions.push({q:'Why do '+esc(co.a)+' and '+esc(co.b)+' share '+co.count+' contacts but never communicate directly?',ctx:'hidden link'})});
  // Q4: New service
  if(state.subjects.length){const sub=state.subjects[0];const rows=rowsFor(sub).filter(r=>r.svc).sort((a,b)=>new Date(a.ts)-new Date(b.ts));if(rows.length>10){const svcDays={};rows.forEach(r=>{const svc=r.svc;const d=new Date(r.ts);if(!svcDays[svc])svcDays[svc]={first:d,last:d};if(d<svcDays[svc].first)svcDays[svc].first=d;if(d>svcDays[svc].last)svcDays[svc].last=d});const newestSvc=Object.entries(svcDays).sort((a,b)=>b[1].first-a[1].first)[0];if(newestSvc){const daysSince=Math.round((new Date()-newestSvc[1].first)/86400000);if(daysSince<30)questions.push({q:'Why did '+esc(sub)+' start using '+esc(newestSvc[0])+' on '+newestSvc[1].first.toLocaleDateString()+'?',ctx:'new service'})}}}
  // Q5: Night activity
  const nightSubs=[];state.subjects.forEach(s=>{const rows=rowsFor(s).filter(r=>r.ts);const night=rows.filter(r=>{const h=new Date(r.ts).getHours();return h>=23||h<5});if(rows.length>10&&night.length/rows.length>0.5)nightSubs.push({sub:s,pct:Math.round(night.length/rows.length*100)})});
  nightSubs.sort((a,b)=>b.pct-a.pct).slice(0,1).forEach(ns=>{questions.push({q:'Why is '+esc(ns.sub)+' predominantly active at night ('+ns.pct+'%)?',ctx:'night pattern'})});
  if(!questions.length){body.innerHTML='<p style="color:var(--muted);font-size:0.75rem">Insufficient data to generate investigation questions.</p>';return}
  body.innerHTML='<div class="ai-questions-list">'+questions.slice(0,8).map((q,i)=>`<div class="ai-question">
    <span class="ai-q-icon"></span>
    <span class="ai-q-text">${q.q}</span>
    <button class="ai-q-btn" onclick="chatWithContext('question_${i}')">Ask AI</button>
  </div>`).join('')+'</div>';
  window._aiQuestions=questions;
}
function initContextChips(){
  document.querySelectorAll('.ai-chip').forEach(chip=>{
    chip.onclick=()=>{chip.classList.toggle('active')};
  });
}
function getActiveContexts(){
  return[...document.querySelectorAll('.ai-chip.active')].map(c=>c.dataset.ctx);
}
async function chatWithContext(action){
  switchAiTab('chat');
  const input=document.getElementById('aiInvestigatorInput');if(!input)return;
  const actions={};
  if(action&&action.startsWith('question_')){const idx=parseInt(action.split('_')[1]);const q=window._aiQuestions&&window._aiQuestions[idx];if(q){input.value=q.q}}
  else if(action==='explain-subject'){const topSub=state.subjects[0];if(topSub)input.value='Explain what we know about subject '+esc(topSub)+' and assess their role in the network.'}
  else if(action==='explain-meeting'){const allMeets=detectMeetings({allPairs:true});if(allMeets.length){const m=allMeets[0];input.value='Explain the meeting between '+esc(m.subA)+' and '+esc(m.subB)+' on '+m.time.toLocaleString()+'. What does the evidence show?'}}
  else if(action==='explain-tower'){const sub=state.subjects[0];if(sub){const rows=rowsFor(sub).filter(r=>r.tow&&r.ts).sort((a,b)=>new Date(a.ts)-new Date(b.ts));if(rows.length>2)input.value='Explain the tower movement pattern of '+esc(sub)+'. They visited '+esc(new Set(rows.map(r=>r.tow)).size)+' towers during the observation period.'}}
  else if(action==='explain-cluster'){input.value='Analyze the communication clusters in this network. Are there distinct groups or isolated subjects?'}
  else if(action==='explain-session'){const topSub=state.subjects[0];if(topSub){const s=reconstructSessions(topSub);if(s.length){const topSvc=s[0].primary?s[0].primary.service:(s[0].service||'');input.value='Explain the '+esc(topSvc)+' session detected for '+esc(topSub)+'. How confident is the attribution?'}}}
  if(action&&!input.value)return;
  analyzeWithAI();
}
async function generateAiReport(type){
  if(!state.data.records.length)return;
  const reportContent=document.getElementById('aiReportContent');
  if(!reportContent)return;
  reportContent.innerHTML='<em>Generating report...</em>';

  // TIFM Backend mode
  if(D.aiMode && D.aiMode.value==='tifm'){
    D.aiStatus.textContent='Generating via backend TIFM...';
    try{
      const r=await API.post('/ai/generate-report?report_type='+encodeURIComponent(type)+(state.data.caseId?'&case_id='+encodeURIComponent(state.data.caseId):''),{});
      reportContent.innerHTML=renderMd(r.report)||'[Empty]';
      D.aiStatus.textContent='Done.';
    }catch(e){
      console.error('TIFM error:',e);
      reportContent.innerHTML='<p style="color:var(--danger)">Error: '+esc(e.message)+'</p>';
      D.aiStatus.textContent='Error.';
    }
    return;
  }

  // Legacy Ollama mode
  const endpoint=D.aiEndpoint.value.trim()||'http://localhost:11434/api/generate';
  const model=D.aiModel.value.trim()||'gemma4:e4b';
  const pk=buildDataPackage();
  const csv=buildCsvDump();
  const prompts={
    executive:'Write an executive summary of this digital forensics investigation. Focus on: scope, key findings, risk assessment, and recommended next actions. Keep it concise (3-4 paragraphs).',
    subject:'Write a detailed subject-centric investigation report. For each subject, describe their role, communication patterns, service usage, mobility, and notable behaviors. Focus on actionable intelligence.',
    communication:'Write a communication analysis report. Describe the network structure, key communicators, communication patterns (time-of-day, frequency), and any hidden relationships detected.',
    location:'Write a location and mobility analysis report. Discuss tower usage patterns, movement paths, meeting point clusters, and temporal-spatial correlations between subjects.',
    full:'Write a comprehensive digital forensics investigation report covering: scope, entity analysis, communication patterns, service attribution breakdown, mobility analysis, meeting detection findings, timeline of key events, anomalies, conclusions, and recommendations.'
  };
  const prompt='Today is '+new Date().toLocaleString()+'. '+(prompts[type]||prompts.full)+'\n\n=== SUMMARY ===\n'+pk+'\n\n'+csv+'\n\nThis is metadata, not message content. Focus on patterns, not content.';
  try{
    const body=JSON.stringify({model,stream:false,prompt,system:'You are an expert digital forensics investigator writing official reports.',options:{temperature:0.2,num_predict:8192,num_ctx:131072}});
    D.aiStatus.textContent='Generating...';
    const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body});
    if(!r.ok){const t=await r.text();throw new Error(t||r.statusText)}
    const j=await r.json();
    const txt=(j.response||j.message?.content||j.choices?.[0]?.message?.content||'').trim();
    reportContent.innerHTML=renderMd(txt)||'[Empty]';
    D.aiStatus.textContent='Done.';
  }catch(e){
    console.error('AI error:',e);
    reportContent.innerHTML='<p style="color:var(--danger)">Error: '+esc(e.message)+'</p>';
    D.aiStatus.textContent='Error.';
  }
}
async function analyzeWithAI(){
  if(!state.data.records.length)return;

  // TIFM Backend mode
  if(D.aiMode && D.aiMode.value==='tifm'){
    D.aiAnalyzeBtn.disabled=true;
    D.aiStatus.textContent='Connecting to backend TIFM...';
    D.aiResponse.innerHTML='<em>Waiting for analysis...</em>';
    try{
      const r=await API.post('/ai/analyze'+(state.data.caseId?'?case_id='+encodeURIComponent(state.data.caseId):''),{});
      const analytics=r.analytics;
      const investigatorNotes=D.aiInvestigatorInput.value.trim();
      if(investigatorNotes){
        D.aiStatus.textContent='LLM processing with TIFM analytics context...';
        const endpoint=D.aiEndpoint.value.trim()||'http://localhost:11434/api/generate';
        const model=D.aiModel.value.trim()||'llama3.2';
        const contexts=getActiveContexts().join(', ');
        const prompt='You are an expert digital forensics investigator. Use the TIFM telecom analytics below to answer the investigator\'s question.\n\nTIFM Analytics:\n'+JSON.stringify(analytics,null,2)+'\n\nActive context: '+contexts+'\n\nInvestigator question: '+investigatorNotes;
        const body=JSON.stringify({model,stream:false,prompt,system:'You are an expert digital forensics investigator.',options:{temperature:0.3,num_predict:4096,num_ctx:131072}});
        D.aiStatus.textContent='LLM processing...';
        const llmR=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body});
        if(!llmR.ok){const t=await llmR.text();throw new Error(t||llmR.statusText)}
        const j=await llmR.json();
        const reply=(j.response||j.message?.content||JSON.stringify(j)).trim();
        D.aiResponse.innerHTML=renderMd(reply);
        D.aiStatus.textContent='Done.';
      }else{
        D.aiResponse.innerHTML='<strong>Analytics complete.</strong><pre style="font-size:0.7rem;white-space:pre-wrap;margin-top:8px">'+esc(JSON.stringify(analytics,null,2))+'</pre>';
        D.aiStatus.textContent='Done.';
      }
    }catch(e){
      D.aiResponse.innerHTML='<p style="color:var(--danger)">Error: '+esc(e.message)+'</p>';
      D.aiStatus.textContent='Error.';
    }
    D.aiAnalyzeBtn.disabled=false;
    return;
  }

  // Fine-Tuned TIFM mode
  if(D.aiMode && D.aiMode.value==='finetuned'){
    D.aiAnalyzeBtn.disabled=true;
    D.aiStatus.textContent='Connecting to fine-tuned TIFM model...';
    D.aiResponse.innerHTML='<em>Waiting for response...</em>';
    try{
      const investigatorNotes=D.aiInvestigatorInput.value.trim();
      const q=investigatorNotes||'Analyze this case and provide key insights.';
      const contexts=getActiveContexts();
      let url='/ai/chat?query='+encodeURIComponent(q)+(state.data.caseId?'&case_id='+encodeURIComponent(state.data.caseId):'');
      if(contexts.length)url+='&context='+encodeURIComponent(contexts.join(','));
      const r=await API.post(url,{});
      D.aiResponse.innerHTML=renderMd(r.answer||'[No response]');
      D.aiStatus.textContent='Done.';
    }catch(e){
      D.aiResponse.innerHTML='<p style="color:var(--danger)">Error: '+esc(e.message)+'</p>';
      D.aiStatus.textContent='Error.';
    }
    D.aiAnalyzeBtn.disabled=false;
    return;
  }

  // Legacy Ollama mode
  const endpoint=D.aiEndpoint.value.trim()||'http://localhost:11434/api/generate';
  const model=D.aiModel.value.trim()||'llama3.2';
  const investigatorNotes=D.aiInvestigatorInput.value.trim();
  D.aiAnalyzeBtn.disabled=true;
  D.aiStatus.textContent='Connecting to LLM...';
  D.aiResponse.innerHTML='<em>Waiting for response...</em>';
  const pk=buildDataPackage();
  const contexts=getActiveContexts().join(', ');
  let prompt='';
  if(investigatorNotes)prompt='The investigator asks: '+investigatorNotes+'\n\nBased on this data:\n'+pk+'\n\nActive context: '+contexts;
  else prompt='Analyze this telecommunications data and provide key insights, anomalies, and recommendations:\n\n'+pk;
  try{
    const body=JSON.stringify({model,stream:false,prompt,system:'You are an expert digital forensics investigator.',options:{temperature:0.3,num_predict:4096,num_ctx:131072}});
    D.aiStatus.textContent='LLM processing...';
    const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body});
    if(!r.ok){const t=await r.text();throw new Error(t||r.statusText)}
    const j=await r.json();
    const reply=(j.response||j.message?.content||JSON.stringify(j)).trim();
    D.aiResponse.innerHTML=renderMd(reply);
    D.aiStatus.textContent='Done.';
  }catch(e){
    D.aiResponse.innerHTML='<p style="color:var(--danger)">Error: '+esc(e.message)+'<br><br>Make sure Ollama is running at <code>'+esc(endpoint)+'</code> and the model <code>'+esc(model)+'</code> is pulled.</p>';
    D.aiStatus.textContent='Error.';
  }
  D.aiAnalyzeBtn.disabled=false;
}
function clearAiConversation(){
  D.aiResponse.innerHTML='<p style="color:var(--muted)">Ask a question about this case.</p>';
  D.aiInvestigatorInput.value='';
  D.aiStatus.textContent='Cleared.';
}

// ---- Event listeners for AI section ----
if(D.aiMode)D.aiMode.addEventListener('change',()=>{
  const isBackend=D.aiMode.value==='tifm'||D.aiMode.value==='finetuned';
  D.aiEndpoint.style.display=isBackend?'none':'';
  D.aiModel.style.display=isBackend?'none':'';
  const labels={tifm:'Backend TIFM mode active',finetuned:'Fine-tuned TIFM model active',ollama:'Local Ollama mode'};
  D.aiStatus.textContent=labels[D.aiMode.value]||'';
  setTimeout(()=>{D.aiStatus.textContent=''},2000);
});
// Init default visibility
if(D.aiMode&&(D.aiMode.value==='tifm'||D.aiMode.value==='finetuned')){D.aiEndpoint.style.display='none';D.aiModel.style.display='none'}
if(D.aiConfigSave)D.aiConfigSave.addEventListener('click',()=>{D.aiStatus.textContent='Settings saved.';setTimeout(()=>{D.aiStatus.textContent=''},2000)});
if(D.aiSeedBtn)D.aiSeedBtn.addEventListener('click',async()=>{
  const scenario=prompt('Enter scenario: criminal, drug, scam, human_trafficking, financial_fraud','criminal');
  if(!scenario)return;
  D.aiStatus.textContent='Seeding synthetic case...';
  D.aiSeedBtn.disabled=true;
  try{
    const r=await API.post('/ai/generate-synthetic?scenario='+encodeURIComponent(scenario),{});
    D.aiStatus.textContent='Created case "'+r.case_name+'" ('+r.cdr_inserted+' CDR, '+r.ipdr_inserted+' IPDR)';
    // Reload to show new case
    loadCases();
  }catch(e){
    D.aiStatus.textContent='Error: '+e.message;
  }
  D.aiSeedBtn.disabled=false;
});
if(D.aiCopyReportBtn)D.aiCopyReportBtn.addEventListener('click',()=>{const c=document.getElementById('aiReportContent');navigator.clipboard.writeText(c?c.textContent:'').catch(()=>{});D.aiStatus.textContent='Copied report.';setTimeout(()=>{D.aiStatus.textContent=''},2000)});
if(D.aiCopyPackageBtn)D.aiCopyPackageBtn.addEventListener('click',()=>{navigator.clipboard.writeText(buildDataPackage()).catch(()=>{});D.aiStatus.textContent='Copied data package.';setTimeout(()=>{D.aiStatus.textContent=''},2000)});
// Full Investigation Command Center (runFullInvestigation + module renderers) -> analytics/investigation.js
// Admin tab (users + audit log + modal) & auditView beacon -> ui/admin.js

// Register the AI tab and re-expose its inline-handler names on window (they moved out of app.js).
registerTab('ai', renderAiInsights);
Object.assign(window,{markFinding,exportFeedback,toggleFindingDetail,generateAiReport,chatWithContext,analyzeWithAI,clearAiConversation,switchNarrativeSubject});
