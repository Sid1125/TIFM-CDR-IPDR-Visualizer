// charts/charts.js — the Charts tab: ~20 Chart.js visualizations built from server analytics
// (state._cd). Extracted from app.js (feature layer). Chart instances are cached on window.chart*
// (unchanged for now). Evidence "pin" buttons are wired via an injected hook (onChartsRendered) so
// this module doesn't import the workspace feature. No behavior change.

import { n } from '../core/utils.js';
import { D } from '../core/dom.js';
import { state } from '../core/state.js';
import { API } from '../core/api.js';
import { subjLabelTxt } from '../core/subjects.js';
import { registerTab, tabNeedsRender, tabMarkRendered } from '../core/router.js';
import { showProfile } from '../records/profile.js';

// app.js injects installChartCaptureButtons here (called after a successful render).
let _afterRender=()=>{};
export function onChartsRendered(fn){ _afterRender=fn; }

// ====== 5. CHARTS ======
async function renderCharts(){
  if(!tabNeedsRender('charts'))return;
  const qp=state.data.caseId?'?case_id='+encodeURIComponent(state.data.caseId):'';
  try{
    const mat=await API.get('/analytics/dashboard'+qp).catch(()=>null);
    state._cd=(mat&&Object.keys(mat).length)?mat:await API.get('/analysis/chart-data'+qp);
  }catch(e){console.error('chart-data fetch:',e);return;} // don't mark rendered — tab switch will retry
  renderChartServicePie();
  renderChartHourly();
  renderChartTopContacts();
  renderChartServiceTimeline();
  renderChartContactDirection();
  renderChartContactDuration();
  renderChartDayOfWeek();
  renderChartDurationDist();
  renderChartProtocolDist();
  renderChartTopPorts();
  renderChartDataVolume();
  renderChartTowerActivity();
  try{renderChartDailyTrend()}catch(e){console.error('dailyTrend',e)}
  try{renderChartPatternHeat()}catch(e){console.error('patternHeat',e)}
  try{renderChartCdrIpdrTime()}catch(e){console.error('cdrIpdrTime',e)}
  try{renderChartCumulative()}catch(e){console.error('cumulative',e)}
  try{renderChartActiveSubjects()}catch(e){console.error('activeSubjects',e)}
  try{renderChartNewReturning()}catch(e){console.error('newReturning',e)}
  try{renderChartGeoState()}catch(e){console.error('geoState',e)}
  try{renderChartTowerDiversity()}catch(e){console.error('towerDiversity',e)}
  try{_afterRender()}catch(e){}
  tabMarkRendered('charts');  // only reached on success — failed renders stay retryable
}

// ===== Behavioural & investigative charts (server-side data from state._cd) =====
// _cd.daily: {buckets, unit, cdr[], ipdr[]}  _cd.hourly[]  _cd.dow[]  _cd.pattern_heat[][]
// _cd.top_contacts  _cd.active_subjects  _cd.top_towers  _cd.call_types  _cd.directions
// _cd.dur_dist[]  _cd.protocols  _cd.top_ports  _cd.top_vol  _cd.geo_state
// _cd.tower_diversity  _cd.new_returning  _cd.contact_dir  _cd.contact_avg_dur
// _cd.service_timeline: {buckets[], services[], series[][]}
function _dayKey(ts){const d=new Date(ts);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function _cdBuckets(){return state._cd&&state._cd.daily?{buckets:state._cd.daily.buckets,unit:state._cd.daily.unit}:{buckets:[],unit:'day'};}
function _destroy(name){if(window[name]){try{window[name].destroy()}catch(e){}window[name]=null}}

function renderChartDailyTrend(){
  if(typeof Chart==='undefined'||!D.chartDailyTrend||!state._cd)return;
  const {buckets,unit}=_cdBuckets();
  const counts=(state._cd.daily.cdr||[]).map((c,i)=>c+(state._cd.daily.ipdr[i]||0));
  const total=counts.reduce((s,v)=>s+v,0);const avg=buckets.length?Math.round(total/buckets.length):0;
  const mx=Math.max(...counts,0);const peak=buckets[counts.indexOf(mx)]||'n/a';
  _destroy('chartDailyTrendC');
  const ci=document.getElementById('ciDailyTrend');
  if(ci)ci.innerHTML=buckets.length+' '+unit+'s &middot; '+total+' records &middot; avg '+avg+'/'+unit+' &middot; peak '+peak+' ('+mx+')';
  window.chartDailyTrendC=new Chart(D.chartDailyTrend,{type:'line',data:{labels:buckets,datasets:[{label:'Records',data:counts,borderColor:'#2c6f79',backgroundColor:'#2c6f7922',fill:true,tension:0.25,pointRadius:buckets.length>60?0:2,pointHoverRadius:5}]},options:{plugins:{legend:{display:false},tooltip:{mode:'index',intersect:false}},scales:{y:{beginAtZero:true,title:{display:true,text:'Records',font:{size:9}}},x:{grid:{display:false},ticks:{maxTicksLimit:14,font:{size:8}}}},responsive:true,maintainAspectRatio:false}});
}

function renderChartPatternHeat(){
  const el=D.chartPatternHeat;if(!el||!state._cd)return;
  const grid=state._cd.pattern_heat||Array.from({length:7},()=>Array(24).fill(0));
  const flat=grid.flat();const max=Math.max(...flat,1);const total=flat.reduce((s,v)=>s+v,0);
  const dows=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const ci=document.getElementById('ciPatternHeat');
  if(ci)ci.innerHTML=total+' records mapped &middot; darker = busier (peak '+max+' in one cell)';
  const color=v=>{if(!v)return'var(--surface)';const t=v/max;const a=0.12+t*0.85;return'rgba(43,111,121,'+a.toFixed(2)+')';};
  let h='<div class="pol-row pol-head"><span class="pol-day"></span>'+Array.from({length:24},(_,i)=>'<span class="pol-h">'+(i%3===0?String(i).padStart(2,'0'):'')+'</span>').join('')+'</div>';
  for(let d=0;d<7;d++){
    h+='<div class="pol-row"><span class="pol-day">'+dows[d]+'</span>'+grid[d].map((v,hh)=>'<span class="pol-cell" style="background:'+color(v)+'" title="'+dows[d]+' '+String(hh).padStart(2,'0')+':00 — '+v+' records"></span>').join('')+'</div>';
  }
  el.innerHTML=h;
}

function renderChartCdrIpdrTime(){
  if(typeof Chart==='undefined'||!D.chartCdrIpdrTime||!state._cd)return;
  const {buckets,unit}=_cdBuckets();
  const cdr=state._cd.daily.cdr||[];const ipdr=state._cd.daily.ipdr||[];
  const tc=cdr.reduce((s,v)=>s+v,0),ti=ipdr.reduce((s,v)=>s+v,0);
  _destroy('chartCdrIpdrTimeC');
  const ci=document.getElementById('ciCdrIpdrTime');
  if(ci)ci.innerHTML=n(tc)+' CDR &middot; '+n(ti)+' IPDR across '+buckets.length+' '+unit+'s';
  window.chartCdrIpdrTimeC=new Chart(D.chartCdrIpdrTime,{type:'bar',data:{labels:buckets,datasets:[{label:'CDR (voice/SMS)',data:cdr,backgroundColor:'#2c6f79'},{label:'IPDR (data)',data:ipdr,backgroundColor:'#d4a017'}]},options:{plugins:{legend:{position:'top',labels:{boxWidth:12,font:{size:9}}},tooltip:{mode:'index',intersect:false}},scales:{x:{stacked:true,grid:{display:false},ticks:{maxTicksLimit:14,font:{size:8}}},y:{stacked:true,beginAtZero:true,title:{display:true,text:'Records',font:{size:9}}}},responsive:true,maintainAspectRatio:false}});
}

function renderChartCumulative(){
  if(typeof Chart==='undefined'||!D.chartCumulative||!state._cd)return;
  const {buckets}=_cdBuckets();
  const per=(state._cd.daily.cdr||[]).map((c,i)=>c+(state._cd.daily.ipdr[i]||0));
  let run=0;const cum=per.map(v=>(run+=v));
  _destroy('chartCumulativeC');
  const ci=document.getElementById('ciCumulative');
  if(ci)ci.innerHTML='Total '+n(run)+' records, cumulative';
  window.chartCumulativeC=new Chart(D.chartCumulative,{type:'line',data:{labels:buckets,datasets:[{label:'Cumulative',data:cum,borderColor:'#8b5cf6',backgroundColor:'#8b5cf622',fill:true,tension:0.2,pointRadius:0}]},options:{plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,title:{display:true,text:'Cumulative records',font:{size:9}}},x:{grid:{display:false},ticks:{maxTicksLimit:12,font:{size:8}}}},responsive:true,maintainAspectRatio:false}});
}

function renderChartActiveSubjects(){
  if(typeof Chart==='undefined'||!D.chartActiveSubjects||!state._cd)return;
  const sorted=(state._cd.active_subjects||[]).map(x=>[x.sub,x.n]);
  _destroy('chartActiveSubjectsC');
  const ci=document.getElementById('ciActiveSubjects');
  if(ci)ci.innerHTML=sorted.length+' subjects &middot; top '+sorted.length+' by owned records';
  if(!sorted.length)return;
  window.chartActiveSubjectsC=new Chart(D.chartActiveSubjects,{type:'bar',data:{labels:sorted.map(s=>{const t=subjLabelTxt(s[0]);return t.length>16?t.slice(0,16)+'…':t;}),datasets:[{data:sorted.map(s=>s[1]),backgroundColor:sorted.map((s,i)=>i===0?'#b94a48':i<3?'#d4a017':'#2c6f79'),borderRadius:4}]},options:{onClick:(e,els)=>{if(els.length){const f=sorted[els[0].index];if(f)showProfile(f[0])}},plugins:{legend:{display:false},tooltip:{callbacks:{title:c=>subjLabelTxt(sorted[c[0].dataIndex][0]),label:c=>c.parsed.x+' records (click to open profile)'}}},indexAxis:'y',scales:{x:{beginAtZero:true,title:{display:true,text:'Records',font:{size:9}}},y:{grid:{display:false}}},responsive:true,maintainAspectRatio:false}});
}

function renderChartNewReturning(){
  if(typeof Chart==='undefined'||!D.chartNewReturning||!state._cd)return;
  const nr=state._cd.new_returning||{buckets:[],fresh:[],repeat:[]};
  const {unit}=_cdBuckets();
  _destroy('chartNewReturningC');
  const ci=document.getElementById('ciNewReturning');
  if(ci)ci.innerHTML='New vs returning contacts per '+unit;
  window.chartNewReturningC=new Chart(D.chartNewReturning,{type:'bar',data:{labels:nr.buckets,datasets:[{label:'New contacts',data:nr.fresh,backgroundColor:'#b94a48'},{label:'Returning',data:nr.repeat,backgroundColor:'#2c6f79'}]},options:{plugins:{legend:{position:'top',labels:{boxWidth:12,font:{size:9}}},tooltip:{mode:'index',intersect:false}},scales:{x:{stacked:true,grid:{display:false},ticks:{maxTicksLimit:12,font:{size:8}}},y:{stacked:true,beginAtZero:true,title:{display:true,text:'Contacts',font:{size:9}}}},responsive:true,maintainAspectRatio:false}});
}

function renderChartGeoState(){
  if(typeof Chart==='undefined'||!D.chartGeoState||!state._cd)return;
  const sorted=(state._cd.geo_state||[]).map(x=>[x.state,x.n]);
  _destroy('chartGeoStateC');
  const ci=document.getElementById('ciGeoState');
  if(ci)ci.innerHTML=sorted.length?(sorted.length+' states/UTs ('+sorted.reduce((s,x)=>s+x[1],0)+' located records)'):'No tower location data yet — use Tower Repo → “Fill place names”.';
  if(!sorted.length)return;
  window.chartGeoStateC=new Chart(D.chartGeoState,{type:'bar',data:{labels:sorted.map(s=>s[0]),datasets:[{data:sorted.map(s=>s[1]),backgroundColor:'#3a7d5a',borderRadius:4}]},options:{plugins:{legend:{display:false}},indexAxis:'y',scales:{x:{beginAtZero:true,title:{display:true,text:'Records',font:{size:9}}},y:{grid:{display:false},ticks:{font:{size:9}}}},responsive:true,maintainAspectRatio:false}});
}

function renderChartTowerDiversity(){
  if(typeof Chart==='undefined'||!D.chartTowerDiversity||!state._cd)return;
  const td=state._cd.tower_diversity||{buckets:[],counts:[]};
  const {unit}=_cdBuckets();
  _destroy('chartTowerDiversityC');
  const ci=document.getElementById('ciTowerDiversity');
  if(ci)ci.innerHTML='Distinct towers per '+unit;
  window.chartTowerDiversityC=new Chart(D.chartTowerDiversity,{type:'line',data:{labels:td.buckets,datasets:[{label:'Distinct towers',data:td.counts,borderColor:'#ec4899',backgroundColor:'#ec489922',fill:true,tension:0.25,pointRadius:td.buckets.length>60?0:2}]},options:{plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,title:{display:true,text:'Towers',font:{size:9}}},x:{grid:{display:false},ticks:{maxTicksLimit:12,font:{size:8}}}},responsive:true,maintainAspectRatio:false}});
}
function renderChartServicePie(){
  if(typeof Chart==='undefined'||!state._cd)return;
  const ctMap=state._cd.call_types||{};
  const sorted=Object.entries(ctMap).sort((a,b)=>b[1]-a[1]);
  const total=sorted.reduce((s,v)=>s+v[1],0);
  const top10=sorted.slice(0,10);const otherCount=sorted.slice(10).reduce((s,v)=>s+v[1],0);
  const colors=['#2c6f79','#b94a48','#d4a017','#3a7d5a','#8b5cf6','#ec4899','#f97316','#6b7280','#14b8a6','#78716c'];
  const labels=top10.map(s=>s[0]);const data=top10.map(s=>s[1]);
  if(otherCount>0){labels.push('Other ('+(sorted.length-10)+' more)');data.push(otherCount)}
  const fullColors=[...colors];if(otherCount>0)fullColors.push('#d1c8bd');
  if(window.chartSvcPie){try{window.chartSvcPie.destroy()}catch(e){}window.chartSvcPie=null}
  if(!D.chartServPie)return;
  const ci=document.getElementById('ciServicePie');
  if(ci)ci.innerHTML=sorted.length+' call types &middot; '+total+' total records';
  window.chartSvcPie=new Chart(D.chartServPie,{type:'doughnut',data:{labels,datasets:[{data,backgroundColor:fullColors,borderWidth:0}]},options:{plugins:{legend:{position:'right',labels:{boxWidth:12,font:{size:9},padding:8,generateLabels:function(chart){const ds=chart.data.datasets[0];return chart.data.labels.map((l,i)=>({text:l+' ('+Math.round(ds.data[i]/total*100)+'%)',fillStyle:ds.backgroundColor[i],strokeStyle:'transparent',pointStyle:'circle',boxWidth:10,boxHeight:10,fontSize:9}))}}},tooltip:{callbacks:{label:function(ctx){const v=ctx.parsed;const pct=Math.round(v/total*100);return ctx.label+': '+v+' ('+pct+'%)'}}}},responsive:true,maintainAspectRatio:false}});
}
function renderChartHourly(){
  if(typeof Chart==='undefined'||!state._cd)return;
  const hours=state._cd.hourly||Array(24).fill(0);
  const labels=Array.from({length:24},(_,i)=>`${i.toString().padStart(2,'0')}:00`);
  const maxH=Math.max(...hours);const peakIdx=hours.indexOf(maxH);
  const totalH=hours.reduce((s,v)=>s+v,0);const avgH=Math.round(totalH/24);
  const bg=hours.map(h=>h>=maxH?'#b94a48':h>avgH?'#d4a017':'#2c6f79');
  if(window.chartHourly){try{window.chartHourly.destroy()}catch(e){}window.chartHourly=null}
  if(!D.chartHourly)return;
  const ci=document.getElementById('ciHourly');
  if(ci)ci.innerHTML=totalH+' records &middot; Peak: '+peakIdx.toString().padStart(2,'0')+':00 ('+maxH+') &middot; Avg: '+avgH+'/hr';
  window.chartHourly=new Chart(D.chartHourly,{type:'bar',data:{labels,datasets:[{data:hours,backgroundColor:bg,borderRadius:2}]},options:{plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){const v=ctx.parsed.y;const pct=Math.round(v/totalH*100);return v+' records ('+pct+'% of day)'}}}},scales:{y:{beginAtZero:true,grid:{},title:{display:true,text:'Records',font:{size:9}}},x:{grid:{display:false},title:{display:true,text:'Hour of Day',font:{size:9}}}},responsive:true,maintainAspectRatio:false}});
}
function renderChartTopContacts(){
  if(typeof Chart==='undefined'||!state._cd)return;
  const sorted=(state._cd.top_contacts||[]).map(x=>[x.c,x.n]);
  const totalC=sorted.reduce((s,v)=>s+v[1],0);
  if(window.chartTopC){try{window.chartTopC.destroy()}catch(e){}window.chartTopC=null}
  if(!D.chartTopContacts)return;
  const ci=document.getElementById('ciTopContacts');
  if(ci)ci.innerHTML=sorted.length+' top contacts';
  if(!sorted.length)return;
  window.chartTopC=new Chart(D.chartTopContacts,{type:'bar',data:{labels:sorted.map(s=>{const t=subjLabelTxt(s[0]);return t.length>15?t.slice(0,15)+'...':t;}),datasets:[{data:sorted.map(s=>s[1]),backgroundColor:sorted.map((s,i)=>i===0?'#b94a48':i<3?'#d4a017':'#2c6f79'),borderRadius:4}]},options:{plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){const v=ctx.parsed.x;const pct=Math.round(v/totalC*100);const full=sorted[ctx.dataIndex]?subjLabelTxt(sorted[ctx.dataIndex][0]):'';return full+': '+v+' ('+pct+'% of top 10)'}}}},indexAxis:'y',scales:{x:{beginAtZero:true,grid:{},title:{display:true,text:'Records',font:{size:9}}},y:{grid:{display:false}}},responsive:true,maintainAspectRatio:false}});
}
function renderChartServiceTimeline(){
  if(typeof Chart==='undefined'||!state._cd)return;
  const st=state._cd.service_timeline||{buckets:[],services:[],series:[]};
  const colors=['#2c6f79','#b94a48','#d4a017','#3a7d5a','#8b5cf6','#ec4899'];
  const totalsByDay=st.buckets.map((_,di)=>st.series.reduce((s,ser)=>s+(ser[di]||0),0));
  const totalPeriod=totalsByDay.reduce((s,v)=>s+v,0);
  const avgDaily=st.buckets.length?Math.round(totalPeriod/st.buckets.length):0;
  if(window.chartSvcTime){try{window.chartSvcTime.destroy()}catch(e){}window.chartSvcTime=null}
  if(!D.chartServTimeline)return;
  const ci=document.getElementById('ciServiceTimeline');
  if(ci)ci.innerHTML=st.buckets.length+' days shown &middot; '+totalPeriod+' records &middot; Avg '+avgDaily+'/day &middot; '+st.services.length+' services plotted';
  window.chartSvcTime=new Chart(D.chartServTimeline,{type:'line',data:{labels:st.buckets,datasets:st.services.map((s,i)=>({label:s,data:st.series[i]||[],borderColor:colors[i%colors.length],backgroundColor:colors[i%colors.length]+'20',fill:true,tension:0.3,pointRadius:2,pointHoverRadius:5}))},options:{plugins:{legend:{position:'top',labels:{boxWidth:12,font:{size:9},padding:8}},tooltip:{mode:'index',intersect:false,callbacks:{title:function(ctx){return ctx[0].label+' (Total: '+totalsByDay[st.buckets.indexOf(ctx[0].label)]+' records)'}}}},scales:{y:{beginAtZero:true,grid:{},title:{display:true,text:'Records',font:{size:9}}},x:{grid:{display:false},title:{display:true,text:'Date',font:{size:9}}}},responsive:true,maintainAspectRatio:false}});
}
function renderChartContactDirection(){
  if(typeof Chart==='undefined'||!state._cd)return;
  const sorted=(state._cd.contact_dir||[]).map(x=>[x.c,{mo:x.mo,mt:x.mt}]);
  if(window.chartContactDir){try{window.chartContactDir.destroy()}catch(e){}window.chartContactDir=null}
  if(!D.chartContactDir)return;
  const ci=document.getElementById('ciContactDir');
  const totalD=sorted.reduce((s,v)=>s+v[1].mo+v[1].mt,0);
  if(ci)ci.innerHTML=sorted.length+' contacts with direction data &middot; '+totalD+' total';
  if(!sorted.length)return;
  window.chartContactDir=new Chart(D.chartContactDir,{type:'bar',data:{labels:sorted.map(s=>{const t=subjLabelTxt(s[0]);return t.length>12?t.slice(0,12)+'...':t;}),datasets:[{label:'Outgoing (MO)',data:sorted.map(s=>s[1].mo),backgroundColor:'#2c6f79',borderRadius:2},{label:'Incoming (MT)',data:sorted.map(s=>s[1].mt),backgroundColor:'#d4a017',borderRadius:2}]},options:{plugins:{legend:{position:'top',labels:{boxWidth:12,font:{size:8},padding:6}},tooltip:{mode:'index',callbacks:{label:function(ctx){return ctx.dataset.label+': '+ctx.parsed.y}}}},scales:{x:{stacked:true,grid:{display:false}},y:{stacked:true,beginAtZero:true,grid:{}}},responsive:true,maintainAspectRatio:false}});
}
function renderChartDurationDist(){
  if(typeof Chart==='undefined'||!state._cd)return;
  const labels=['<10s','10-30s','30-60s','1-5m','5-15m','15-60m','>60m'];
  const counts=state._cd.dur_dist||Array(7).fill(0);
  const totalC=counts.reduce((s,v)=>s+v,0);const peakB=counts.indexOf(Math.max(...counts));
  if(window.chartDurDist){try{window.chartDurDist.destroy()}catch(e){}window.chartDurDist=null}
  if(!D.chartDurDist)return;
  const ci=document.getElementById('ciDurDist');
  if(ci)ci.innerHTML=totalC+' CDR records &middot; Most calls '+labels[peakB];
  if(!totalC)return;
  window.chartDurDist=new Chart(D.chartDurDist,{type:'bar',data:{labels,datasets:[{data:counts,backgroundColor:counts.map((v,i)=>i===peakB?'#b94a48':'#2c6f79'),borderRadius:3}]},options:{plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){return ctx.parsed.y+' calls ('+Math.round(ctx.parsed.y/totalC*100)+'%)'}}}},scales:{y:{beginAtZero:true,grid:{}},x:{grid:{display:false}}},responsive:true,maintainAspectRatio:false}});
}
function renderChartProtocolDist(){
  if(typeof Chart==='undefined'||!state._cd)return;
  const protMap=state._cd.protocols||{};
  const sorted=Object.entries(protMap).sort((a,b)=>b[1]-a[1]);const totalP=sorted.reduce((s,v)=>s+v[1],0);
  if(window.chartProtDist){try{window.chartProtDist.destroy()}catch(e){}window.chartProtDist=null}
  if(!D.chartProtDist)return;
  const ci=document.getElementById('ciProtDist');
  if(ci)ci.innerHTML=sorted.length+' protocols &middot; '+totalP+' IPDR records';
  if(!sorted.length)return;
  const colors=['#2c6f79','#b94a48','#d4a017','#3a7d5a','#8b5cf6','#78716c'];
  window.chartProtDist=new Chart(D.chartProtDist,{type:'doughnut',data:{labels:sorted.slice(0,8).map(s=>s[0]+' ('+Math.round(s[1]/totalP*100)+'%)'),datasets:[{data:sorted.slice(0,8).map(s=>s[1]),backgroundColor:colors,borderWidth:0}]},options:{plugins:{legend:{position:'right',labels:{boxWidth:10,font:{size:9},padding:6}},tooltip:{callbacks:{label:function(ctx){return ctx.label+': '+ctx.parsed+' records'}}}},responsive:true,maintainAspectRatio:false}});
}
function renderChartTopPorts(){
  if(typeof Chart==='undefined'||!state._cd)return;
  const sorted=(state._cd.top_ports||[]).map(x=>['Port '+x.port,x.n]);
  const totalP=sorted.reduce((s,v)=>s+v[1],0);
  if(window.chartTopPorts){try{window.chartTopPorts.destroy()}catch(e){}window.chartTopPorts=null}
  if(!D.chartTopPorts)return;
  const ci=document.getElementById('ciTopPorts');
  if(ci)ci.innerHTML=sorted.length+' ports shown &middot; '+totalP+' total hits';
  if(!sorted.length)return;
  window.chartTopPorts=new Chart(D.chartTopPorts,{type:'bar',data:{labels:sorted.map(s=>s[0]),datasets:[{data:sorted.map(s=>s[1]),backgroundColor:sorted.map((s,i)=>i===0?'#b94a48':i<3?'#d4a017':'#2c6f79'),borderRadius:4}]},options:{plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){return ctx.parsed.x+' connections'}}}},indexAxis:'y',scales:{x:{beginAtZero:true,grid:{}},y:{grid:{display:false}}},responsive:true,maintainAspectRatio:false}});
}
function renderChartDataVolume(){
  if(typeof Chart==='undefined'||!state._cd)return;
  const sorted=(state._cd.top_vol||[]).map(x=>[x.c,x.bytes]);
  const totalV=sorted.reduce((s,v)=>s+v[1],0);
  function fmtB(b){return b>1e9?(b/1e9).toFixed(1)+'GB':b>1e6?(b/1e6).toFixed(1)+'MB':b>1e3?(b/1e3).toFixed(1)+'KB':b+'B'}
  if(window.chartDataVol){try{window.chartDataVol.destroy()}catch(e){}window.chartDataVol=null}
  if(!D.chartDataVol)return;
  const ci=document.getElementById('ciDataVol');
  if(ci)ci.innerHTML=sorted.length+' contacts &middot; '+fmtB(totalV)+' total volume';
  if(!sorted.length)return;
  window.chartDataVol=new Chart(D.chartDataVol,{type:'bar',data:{labels:sorted.map(s=>s[0].length>12?s[0].slice(0,12)+'...':s[0]),datasets:[{data:sorted.map(s=>s[1]),backgroundColor:sorted.map((s,i)=>i===0?'#b94a48':i<3?'#d4a017':'#3a7d5a'),borderRadius:4}]},options:{plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){const v=ctx.parsed.x;const full=sorted[ctx.dataIndex]?sorted[ctx.dataIndex][0]:'';return full+': '+fmtB(v)}}}},indexAxis:'y',scales:{x:{beginAtZero:true,grid:{},title:{display:true,text:'Bytes transferred',font:{size:9}}},y:{grid:{display:false}}},responsive:true,maintainAspectRatio:false}});
}
function renderChartTowerActivity(){
  if(typeof Chart==='undefined'||!state._cd)return;
  const sorted=(state._cd.top_towers||[]).map(x=>[x.tower_id,x.n]);
  const totalT=sorted.reduce((s,v)=>s+v[1],0);
  if(window.chartTowerAct){try{window.chartTowerAct.destroy()}catch(e){}window.chartTowerAct=null}
  if(!D.chartTowerAct)return;
  const ci=document.getElementById('ciTowerAct');
  if(ci)ci.innerHTML=sorted.length+' top towers';
  if(!sorted.length)return;
  window.chartTowerAct=new Chart(D.chartTowerAct,{type:'bar',data:{labels:sorted.map(s=>s[0].length>12?s[0].slice(0,12)+'...':s[0]),datasets:[{data:sorted.map(s=>s[1]),backgroundColor:sorted.map((s,i)=>i===0?'#b94a48':i<3?'#d4a017':'#2c6f79'),borderRadius:4}]},options:{plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){const v=ctx.parsed.x;const pct=Math.round(v/totalT*100);return (sorted[ctx.dataIndex]?sorted[ctx.dataIndex][0]:'')+': '+v+' ('+pct+'%)'}}}},indexAxis:'y',scales:{x:{beginAtZero:true,grid:{}},y:{grid:{display:false}}},responsive:true,maintainAspectRatio:false}});
}
function renderChartContactDuration(){
  if(typeof Chart==='undefined'||!state._cd)return;
  const avg=(state._cd.contact_avg_dur||[]).map(x=>[x.c,x.avg]);
  if(window.chartContactDur){try{window.chartContactDur.destroy()}catch(e){}window.chartContactDur=null}
  if(!D.chartContactDur)return;
  const ci=document.getElementById('ciContactDur');
  if(ci)ci.innerHTML=avg.length+' contacts with duration data &middot; longest avg '+((avg[0]||[])[1]||0)+'s';
  if(!avg.length)return;
  window.chartContactDur=new Chart(D.chartContactDur,{type:'bar',data:{labels:avg.map(s=>s[0].length>14?s[0].slice(0,14)+'...':s[0]),datasets:[{data:avg.map(s=>s[1]),backgroundColor:'#3a7d5a',borderRadius:4}]},options:{plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){const v=ctx.parsed.x;const full=avg[ctx.dataIndex]?avg[ctx.dataIndex][0]:'';return full+': avg '+v+'s'}}}},indexAxis:'y',scales:{x:{beginAtZero:true,grid:{},title:{display:true,text:'Avg Duration (s)',font:{size:9}}},y:{grid:{display:false}}},responsive:true,maintainAspectRatio:false}});
}
function renderChartDayOfWeek(){
  if(typeof Chart==='undefined'||!state._cd)return;
  const names=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const dow=state._cd.dow||Array(7).fill(0);  // JS getDay() order: Sun=0
  const totalD=dow.reduce((s,v)=>s+v,0);const peakD=dow.indexOf(Math.max(...dow));
  if(window.chartDow){try{window.chartDow.destroy()}catch(e){}window.chartDow=null}
  if(!D.chartDayOfWeek)return;
  const ci=document.getElementById('ciDayOfWeek');
  if(ci)ci.innerHTML=names[peakD]+' busiest &middot; '+totalD+' total records';
  window.chartDow=new Chart(D.chartDayOfWeek,{type:'bar',data:{labels:names,datasets:[{data:dow,backgroundColor:dow.map((v,i)=>i===peakD?'#b94a48':v>0?'#2c6f79':'#d1c8bd'),borderRadius:3}]},options:{plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){return ctx.parsed.y+' records ('+Math.round(ctx.parsed.y/totalD*100)+'%)'}}}},scales:{y:{beginAtZero:true,grid:{}},x:{grid:{display:false}}},responsive:true,maintainAspectRatio:false}});
}

registerTab('charts', renderCharts);
export { renderCharts };
