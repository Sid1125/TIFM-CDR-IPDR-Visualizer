// ====== STATE ======
const state={auth:{status:'checking',user:null,session:null},cdr:[],ipdr:[],towers:[],tab:'dashboard',subjects:[],graphData:null,timeline:[],charts:{}};
const API={async req(p,o){const r=await fetch(p,{credentials:'same-origin',...o,headers:{...((o&&o.headers)||{})}});if(r.status===401){const e=new Error(await r.text()||'Auth required');e.name='AuthError';throw e}if(!r.ok)throw new Error(await r.text()||r.status);return r.status===204?null:r.json()},get(p){return this.req(p)},post(p,b){return this.req(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)})},del(p){return this.req(p,{method:'DELETE'})},async upload(p,f){const fd=new FormData();fd.append('file',f);const r=await fetch(p,{credentials:'same-origin',method:'POST',body:fd});if(r.status===401){const e=new Error(await r.text()||'Auth required');e.name='AuthError';throw e}if(!r.ok)throw new Error(await r.text()||'Upload failed');return r.json()}};

// ====== DOM REFS ======
const $=id=>document.getElementById(id);
const D={
  shell:$('shell'),auth:$('authOverlay'),loginForm:$('loginForm'),loginUser:$('loginUsername'),loginPass:$('loginPassword'),loginStatus:$('loginStatus'),
  sessionUser:$('sessionUser'),sessionStatus:$('sessionStatus'),logoutBtn:$('logoutBtn'),
  importStatus:$('importStatus'),cdrFile:$('cdrFile'),ipdrFile:$('ipdrFile'),towerFile:$('towerFile'),
  dashCards:$('dashCards'),dashGraph:$('dashGraph'),dashPie:$('dashPieChart'),dashHeat:$('dashHeatmap'),dashBar:$('dashBarChart'),dashMatrix:$('dashMatrix'),
  graphSubject:$('graphSubject'),graphSearch:$('graphSearchInput'),graphReset:$('graphResetZoom'),graphCenter:$('graphCenterBtn'),graphStats:$('graphStats'),graphSvg:$('graphSvgContainer'),graphSidebar:$('graphSidebar'),graphDetails:$('graphNodeDetails'),
  mapSubject:$('mapSubject'),mapMode:$('mapMode'),mapGo:$('mapGoBtn'),mapFit:$('mapFitBtn'),geoFenceBtn:$('geoFenceBtn'),mapStage:$('mapStage'),mapSidebar:$('mapSidebar'),mapAnalysis:$('mapAnalysis'),mapTimeBar:$('mapTimelineBar'),mapTimeLabel:$('mapTimeLabel'),mapTimeSlider:$('mapTimeSlider'),mapTimePlay:$('mapTimePlay'),
  tlSearch:$('tlSearch'),tlType:$('tlType'),tlPlayBtn:$('tlPlayBtn'),tlCompare:$('tlCompare'),tlCount:$('tlCount'),tlContainer:$('tlContainer'),
  chartServPie:$('chartServicePie'),chartHourly:$('chartHourlyBar'),chartTopContacts:$('chartTopContacts'),chartServTimeline:$('chartServiceTimeline'),
  chartContactDir:$('chartContactDir'),chartContactDur:$('chartContactDur'),chartDayOfWeek:$('chartDayOfWeek'),
  chartDurDist:$('chartDurDist'),chartProtDist:$('chartProtDist'),chartTopPorts:$('chartTopPorts'),chartDataVol:$('chartDataVol'),chartTowerAct:$('chartTowerAct'),
  recSearch:$('recSearch'),recType:$('recType'),recService:$('recService'),recCount:$('recCount'),recBody:$('recBody'),recLoadMore:$('recLoadMore'),
  profile:$('profileModal'),profileTitle:$('profileTitle'),profileBody:$('profileBody'),profileClose:$('profileClose'),
  aiEndpoint:$('aiEndpoint'),aiModel:$('aiModel'),aiConfigSave:$('aiConfigSave'),aiStatus:$('aiStatus'),aiMode:$('aiMode'),aiSeedBtn:$('aiSeedBtn'),
  aiInvestigatorInput:$('aiInvestigatorInput'),aiAnalyzeBtn:$('aiAnalyzeBtn'),aiClearBtn:$('aiClearBtn'),aiResponse:$('aiResponse'),
  resetCaseBtn:$('resetCaseBtn'),
  aiGenerateReportBtn:null,aiReportContent:$('aiReportContent'),aiCopyReportBtn:$('aiCopyReportBtn'),aiCopyPackageBtn:$('aiCopyPackageBtn'),
  adminTabBtn:$('adminTabBtn'),adminBody:$('adminBody'),adminEmpty:$('adminEmpty'),adminTable:$('adminTable'),adminCreateBtn:$('adminCreateBtn'),
  darkModeBtn:$('darkModeBtn'),exportBtn:$('exportBtn'),caseSelector:$('caseSelector'),
  svcSearchInput:$('svcSearchInput'),svcMinConf:$('svcMinConf'),svcCount:$('svcCount'),svcBursts:$('svcBursts'),svcCardGrid:$('svcCardGrid'),
  corrSubA:$('corrSubA'),corrSubB:$('corrSubB'),corrGoBtn:$('corrGoBtn'),corrSwapBtn:$('corrSwapBtn'),corrResults:$('corrResults'),
  csGrid:$('csGrid'),csMeta:$('csMeta'),csBody:$('csBody'),
  cpStartA:$('cpStartA'),cpEndA:$('cpEndA'),cpStartB:$('cpStartB'),cpEndB:$('cpEndB'),cpGoBtn:$('cpGoBtn'),cpCloseBtn:$('cpCloseBtn'),cpStatus:$('cpStatus'),cpResults:$('cpResults'),compareBar:$('compareBar'),
};

// ====== DARK MODE ======
(function(){
  const saved=localStorage.getItem('darkMode');
  if(saved==='1'||saved==='true')document.body.classList.add('dark');
  updateChartTheme();
  D.darkModeBtn.addEventListener('click',()=>{
    document.body.classList.toggle('dark');
    localStorage.setItem('darkMode',document.body.classList.contains('dark')?'1':'0');
    updateChartTheme();
  });
})();

// ====== AUTH ======
async function checkAuth(){
  try{const me=await API.get('/auth/me');state.auth.user=me.user;state.auth.session=me.session;state.auth.status='authenticated';renderAuth();bootstrap()}catch(e){state.auth.status='anonymous';renderAuth()}
}
function renderAuth(){
  const ok=state.auth.status==='authenticated';
  D.shell.style.display=ok?'block':'none';D.auth.style.display=ok?'none':'flex';
  D.sessionUser.textContent=ok?state.auth.user.username+` (${state.auth.user.role})`:'Signed out';
  D.adminTabBtn.style.display=ok&&state.auth.user.role==='admin'?'':'none';
  if(ok){resetIdle();D.sessionStatus.style.display=''}else{D.sessionStatus.style.display='none';idleTimer&&clearTimeout(idleTimer);idleWarnTimer&&clearTimeout(idleWarnTimer);healthTimer&&clearInterval(healthTimer)}
}
D.loginForm.addEventListener('submit',async e=>{e.preventDefault();try{const r=await API.post('/auth/login',{username:D.loginUser.value.trim(),password:D.loginPass.value});state.auth.user=r.user;state.auth.session=r.session;state.auth.status='authenticated';renderAuth();bootstrap()}catch(err){D.loginStatus.textContent='Invalid credentials'}});
D.logoutBtn.addEventListener('click',async()=>{await doLogout()});

// ====== SESSION & AFK MANAGEMENT ======
let idleTimer=null,idleWarnTimer=null,idleWarnTimer2=null,healthTimer=null;
const AFK_MS=10*60*1000,IDLE_MS=2*60*1000,WARN_MS=60*1000,HEALTH_MS=5*60*1000;

function resetIdle(){
  if(state.auth.status!=='authenticated')return;
  if(idleTimer)clearTimeout(idleTimer);
  if(idleWarnTimer)clearTimeout(idleWarnTimer);
  if(idleWarnTimer2)clearTimeout(idleWarnTimer2);
  D.sessionStatus.textContent='Active';D.sessionStatus.className='sess-active';
  idleWarnTimer=setTimeout(()=>{if(state.auth.status==='authenticated'){D.sessionStatus.textContent='Idle';D.sessionStatus.className='sess-idle'}},IDLE_MS);
  idleWarnTimer2=setTimeout(()=>{if(state.auth.status==='authenticated'){D.sessionStatus.textContent='Expiring soon';D.sessionStatus.className='sess-warn'}},AFK_MS-WARN_MS);
  idleTimer=setTimeout(doLogout,AFK_MS);
}

async function doLogout(){
  idleTimer&&clearTimeout(idleTimer);idleWarnTimer&&clearTimeout(idleWarnTimer);idleWarnTimer2&&clearTimeout(idleWarnTimer2);healthTimer&&clearInterval(healthTimer);
  D.sessionStatus.textContent='Expired';D.sessionStatus.className='sess-expired';
  try{await fetch('/auth/logout',{method:'POST',credentials:'same-origin'})}catch(e){}
  state.auth={status:'anonymous',user:null,session:null};renderAuth();
}

['mousemove','mousedown','click','keydown','scroll','touchstart','touchmove','wheel'].forEach(e=>document.addEventListener(e,resetIdle,{passive:true}));

// ====== HELPERS ======
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function fmt(v){if(!v)return'';try{return new Date(v).toLocaleString()}catch(e){return v}}
function fmts(v){if(!v)return'';try{const d=new Date(v);return d.toLocaleDateString()+' '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}catch{return v}}
function fmtd(v){if(!v)return'';try{return new Date(v).toLocaleDateString()}catch{return v}}
function fmtBytes(b){if(!b||b<0)return'0B';if(b<1024)return b+'B';if(b<1048576)return(b/1024).toFixed(1)+'KB';if(b<1073741824)return(b/1048576).toFixed(1)+'MB';return(b/1073741824).toFixed(2)+'GB'}
function updateChartTheme(){
  try{
    const isDark=document.body.classList.contains('dark');
    const textColor=isDark?'#e0ddd8':'#2c2418';
    Chart.defaults.color=textColor;
  }catch(e){}
}
function colWidth(v){if(!v)return 120;if(v.includes(':'))return 280;if(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v)||/^\+?\d{7,15}$/.test(v))return 150;return 200}
function n(v){return v!=null?Number(v).toLocaleString():'0'}
function renderMd(t){
  if(!t)return'';
  let s=esc(t);
  // code blocks
  s=s.replace(/```(\w*)\n?([\s\S]*?)```/g,'<pre><code>$2</code></pre>');
  // horizontal rules
  s=s.replace(/^---+$/gm,'<hr>');
  // blockquotes
  s=s.replace(/^&gt;\s?(.*)$/gm,'<blockquote>$1</blockquote>');
  // headings
  s=s.replace(/^######\s+(.*)$/gm,'<h6>$1</h6>');
  s=s.replace(/^#####\s+(.*)$/gm,'<h5>$1</h5>');
  s=s.replace(/^####\s+(.*)$/gm,'<h4>$1</h4>');
  s=s.replace(/^###\s+(.*)$/gm,'<h3>$1</h3>');
  s=s.replace(/^##\s+(.*)$/gm,'<h2>$1</h2>');
  s=s.replace(/^#\s+(.*)$/gm,'<h1>$1</h1>');
  // bold & italic
  s=s.replace(/\*\*\*(.+?)\*\*\*/g,'<strong><em>$1</em></strong>');
  s=s.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  s=s.replace(/\*(.+?)\*/g,'<em>$1</em>');
  // inline code
  s=s.replace(/`([^`]+)`/g,'<code>$1</code>');
  // links
  s=s.replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank">$1</a>');
  // tables (basic)
  s=s.replace(/^(\|.+\|)$/gm,function(m){return m.includes('---')?'':m.replace(/\|/g,'').trim()?'<tr><td>'+m.replace(/^\||\|$/g,'').split('|').map(c=>c.trim()).join('</td><td>')+'</td></tr>':''});
  s=s.replace(/<tr><td>.*?<\/td><\/tr>/g,function(m,i,t){const p=t.substring(0,i).lastIndexOf('<table>');const n=t.substring(i+3).indexOf('<tr');const prev=t.substring(0,i);const prevLine=prev.split('\n').pop();return prevLine.includes('<table>')||(p>=0&&n===0)?m:'<table>'+m+'</table>'});
  // bullet lists
  s=s.replace(/^\s*[-*]\s+(.*)$/gm,'<li>$1</li>');
  s=s.replace(/(<li>.*<\/li>)\n<li>/g,'$1\n<li>');
  s=s.replace(/(<li>[\s\S]*?<\/li>)/g,'<ul>$1</ul>');
  s=s.replace(/<\/ul>\n<ul>/g,'\n');
  // paragraphs
  s=s.replace(/\n\n/g,'</p><p>');
  s=s.replace(/^<p>|<\/p>$/g,'');
  s='<p>'+s+'</p>';
  // clean empty paragraphs
  s=s.replace(/<p>\s*<\/p>/g,'');
  // consolidate adjacent blockquotes
  s=s.replace(/<\/blockquote>\n<blockquote>/g,'\n');
  return s;
}

// ====== DATA LOADING ======
let allRows=[];
let activeCaseId=null;
// Persist the chosen case across page refreshes (activeCaseId is otherwise in-memory only,
// so a refresh would reset to whichever case the API returns first).
function setActiveCase(id){
  activeCaseId=(id!=null&&id!=='')?String(id):null;
  try{if(activeCaseId)localStorage.setItem('activeCaseId',activeCaseId);else localStorage.removeItem('activeCaseId');}catch(e){}
}
async function loadCaseData(){
  invalidateAiCache();state.geoRecords=null;_infReport=null;_infCache=null;
  try{
    const caseParam=activeCaseId?'?case_id='+activeCaseId:'';
    const[cdr,ipdr,towers]=await Promise.all([API.get('/records/cdr'+caseParam),API.get('/records/ipdr'+caseParam),API.get('/towers/')]);
    state.cdr=cdr;state.ipdr=ipdr;state.towers=towers;
    allRows=[...cdr.map(nCdr),...ipdr.map(nIpdr)].sort((a,b)=>new Date(b.ts)-new Date(a.ts));
    const subs=new Set();allRows.forEach(r=>{if(r.sub)subs.add(r.sub);if(r.cnt)subs.add(r.cnt)});
    state.subjects=[...subs].sort();
    renderDashboard();
    renderRecords();
    renderCharts();
    initGraphSubjects();
  }catch(e){console.error(e)}
}
function nCdr(r){
  const s=r.a_party_number||'',c=r.b_party_number||'';
  return{type:'CDR',id:'c'+r.id,ts:r.start_time,sub:s,cnt:c,tow:r.tower_id||'',dur:r.duration_seconds,svc:s?'Voice':'Unknown',raw:r,
    msisdn:r.msisdn,imsi:r.imsi,imei:r.imei,lat:r.latitude,lng:r.longitude,
    cll:r.call_type,dir:r.direction,cell:r.cell_id,tec:r.technology,end:r.end_time,
    case_id:r.case_id,lac:r.lac};
}
function nIpdr(r){
  const s=r.source_ip||'',c=r.destination_ip||'';
  return{type:'IPDR',id:'i'+r.id,ts:r.start_time,sub:s,cnt:c,tow:r.tower_id||'',dur:r.duration_seconds,svc:r.protocol||'Unknown',raw:r,
    msisdn:r.msisdn,imsi:r.imsi,imei:r.imei,lat:r.latitude,lng:r.longitude,
    bytesUp:r.bytes_uploaded,bytesDn:r.bytes_downloaded,sport:r.source_port,dport:r.destination_port,prot:r.protocol,apn:r.apn,rat:r.rat,end:r.end_time,
    case_id:r.case_id,lac:r.lac,cell:r.cell_id};
}
// -- Case Management --
async function loadCases(){
  try{let cases=await API.get('/cases/');
    if(!cases.length){
      const c=await API.post('/cases/',{name:'Default Case'});
      cases=[c];setActiveCase(c.id);
    }else{
      // Keep the current selection; else restore the saved one; else fall back to first.
      const has=id=>cases.some(c=>String(c.id)===String(id));
      const saved=(()=>{try{return localStorage.getItem('activeCaseId')}catch(e){return null}})();
      if(activeCaseId&&has(activeCaseId)){/* keep */}
      else if(saved&&has(saved))setActiveCase(saved);
      else setActiveCase(cases[0].id);
    }
    const sel=D.caseSelector;
    sel.innerHTML=cases.map(c=>`<option value="${c.id}"${activeCaseId==c.id?' selected':''}>${esc(c.name)} (${c.record_count})</option>`).join('')+
      '<option value="__new__">+ New Case</option><option value="__manage__">Manage Cases...</option>';
  }catch(e){} 
}
D.caseSelector.addEventListener('change',async function(){
  const v=this.value;
  if(v==='__new__'){const n=prompt('Case name:');if(n&&n.trim()){try{const c=await API.post('/cases/',{name:n.trim()});setActiveCase(c.id);await loadCaseData();await loadCases();}catch(e){alert('Failed: '+e.message)}}this.value=activeCaseId||'';return}
  if(v==='__manage__'){showCaseManager();this.value=activeCaseId||'';return}
  setActiveCase(v||null);await loadCaseData();
});
async function showCaseManager(){
  const cases=await API.get('/cases/');
  let h='<h3 style="margin:0 0 12px">Manage Cases</h3>';
  h+='<div class="cm-list" style="max-height:300px;overflow:auto">';
  cases.forEach((c,i)=>{
    h+=`<div class="cm-row" style="display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid var(--line)" data-idx="${i}">
      <strong style="flex:1">${esc(c.name)}</strong>
      <span style="font-size:0.75rem;color:var(--muted)">${c.record_count} records</span>
      <button class="btn-sm cm-switch">Switch</button>
      <button class="btn-sm cm-delete" style="border-color:var(--danger);color:var(--danger)">Delete</button>
    </div>`;
  });
  h+='</div><div style="margin-top:10px"><button class="btn-sm cm-close">Close</button></div>';
  let m=document.getElementById('caseManagerModal');
  if(!m){
    m=document.createElement('div');m.id='caseManagerModal';m.className='modal-overlay';
    m.style.cssText='position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.55);z-index:999;display:flex;align-items:center;justify-content:center';
    const box=document.createElement('div');box.className='modal';box.style.cssText='background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:20px;max-width:500px;width:90%';
    m.appendChild(box);document.body.appendChild(m);
    m.addEventListener('click',e=>{if(e.target===m)m.style.display='none'});
  }
  m.querySelector('.modal').innerHTML=h;
  // Wire up events
  const rows=m.querySelectorAll('.cm-row');
  rows.forEach((row,i)=>{
    const c=cases[i];
    if(!c)return;
    row.querySelector('.cm-switch').addEventListener('click',()=>{
      setActiveCase(c.id);m.style.display='none';loadCaseData();loadCases();
    });
    row.querySelector('.cm-delete').addEventListener('click',async()=>{
      if(!confirm('Delete case "'+c.name+'" and all its records?'))return;
      await API.del('/cases/'+c.id);
      if(String(activeCaseId)===String(c.id))setActiveCase(null);
      loadCases();m.style.display='none';loadCaseData();
    });
  });
  m.querySelector('.cm-close').addEventListener('click',()=>{m.style.display='none'});
  m.style.display='flex';
}
// -- Service Provider Database --
// Format: { provider, asn, domains, ranges, services: [{name, activities, ports:{tcp,udp}, proto}] }
const SERVICE_DB=ATTR_DATA.providers;
// -- IP Range Lookup --
const IP_RANGES=SERVICE_DB.flatMap(p=>(p.ranges||[]).map(c=>{const[r,bits]=c.split('/');const m=~(2**(32-parseInt(bits))-1)>>>0;const rn=r.split('.').reduce((s,o)=>(s*256+parseInt(o))>>>0,0);const pfx=parseInt(bits);return{mask:m,range:rn,provider:p.pr,raw:c,isp:!!p.isp,specificity:pfx>=24?1:pfx>=20?0.8:pfx>=16?0.6:0.4}}));
// Providers that are access networks (telecom/ISP), not content services. A match on
// these identifies the carrier, and must never override a real content-provider match.
const ISP_PROVIDERS=new Set(SERVICE_DB.filter(p=>p.isp).map(p=>p.pr));
function isIspProvider(name){return ISP_PROVIDERS.has(name)}
const KNOWN_IP_HINTS=[{cidr:'8.8.8.0/24',prov:'Google',svc:'Google DNS',act:'DNS Resolution'},{cidr:'8.8.4.0/24',prov:'Google',svc:'Google DNS',act:'DNS Resolution'},{cidr:'1.1.1.0/24',prov:'Cloudflare',svc:'Cloudflare DNS',act:'DNS Resolution'},{cidr:'1.0.0.0/24',prov:'Cloudflare',svc:'Cloudflare DNS',act:'DNS Resolution'}].map(h=>{const[r,bits]=h.cidr.split('/');const m=~(2**(32-parseInt(bits))-1)>>>0;const rn=r.split('.').reduce((s,o)=>(s*256+parseInt(o))>>>0,0);return{mask:m,range:rn,...h}});
// Longest-prefix match: among all CIDRs containing the IP, return the most specific
// (largest mask = most 1-bits), so a tight block beats a broad one.
function ipInRange(ip,range){if(!ip||!ip.includes('.'))return null;const n=ip.split('.').reduce((s,o)=>(s*256+parseInt(o))>>>0,0);let best=null;for(const r of range){if((n&r.mask)===(r.range&r.mask)&&(!best||(r.mask>>>0)>(best.mask>>>0)))best=r}return best}
// Non-public address classification (CGNAT / private / loopback / link-local).
function ipKind(ip){if(!ip||!ip.includes('.'))return null;const o=ip.split('.').map(x=>parseInt(x));if(o.length!==4||o.some(isNaN))return null;const n=((o[0]*256+o[1])*256+o[2])*256+o[3];const in_=(a,bits)=>{const m=~(2**(32-bits)-1)>>>0;const r=a.split('.').reduce((s,x)=>(s*256+parseInt(x))>>>0,0);return (n&m)===(r&m)};if(in_('100.64.0.0',10))return'cgnat';if(in_('127.0.0.0',8))return'loopback';if(in_('169.254.0.0',16))return'link_local';if(in_('10.0.0.0',8)||in_('172.16.0.0',12)||in_('192.168.0.0',16))return'private';return null}
const HOSTING_PROVIDERS=new Set(ATTR_DATA.constants.hosting_providers);
const PRIVATE_LABEL={cgnat:'Carrier NAT (CGNAT)',private:'Private / Internal Network',loopback:'Loopback',link_local:'Link-Local'};
function ipHint(ip){if(!ip||!ip.includes('.'))return null;const n=ip.split('.').reduce((s,o)=>(s*256+parseInt(o))>>>0,0);const h=KNOWN_IP_HINTS.find(r=>(n&r.mask)===(r.range&r.mask));return h?{provider:h.prov,service:h.svc,activity:h.act}:null}
// -- Distinctive Indicators --
// Strong multi-factor signatures that add +30 to service score
const DISTINCTIVE_INDICATORS=[
  {svc:'WhatsApp',check:(p,pr,pt,ps)=>p==='Meta'&&pr==='UDP'&&([3478,3479,3480].some(po=>ps.has(po)))},
  {svc:'Telegram',check:(p,pr,pt,ps)=>p==='Telegram'},
  {svc:'Google Meet',check:(p,pr,pt,ps)=>p==='Google'&&pr==='UDP'&&[19302,19303,19304,19305].some(po=>ps.has(po))},
  {svc:'MS Teams',check:(p,pr,pt,ps)=>p==='Microsoft'&&pr==='UDP'&&[3478,3479,3480,3481].some(po=>ps.has(po))},
  {svc:'Zoom',check:(p,pr,pt,ps)=>p==='Zoom'&&pr==='UDP'&&[8801,8810].some(po=>ps.has(po))},
  {svc:'FaceTime',check:(p,pr,pt,ps)=>p==='Apple'&&pr==='UDP'&&[16384,16387,3497].some(po=>ps.has(po))},
  {svc:'Steam',check:(p,pr,pt,ps)=>p==='Valve'&&([27000,27100,27015,27050].some(po=>ps.has(po)))},
  {svc:'NordVPN',check:(p,pr,pt,ps)=>p==='NordVPN'&&pr==='UDP'&&ps.has(1194)},
  {svc:'Mullvad',check:(p,pr,pt,ps)=>p==='Mullvad'&&pr==='UDP'&&ps.has(51820)},
];
// -- Identity Resolution --
// Builds per-subject identity profiles linking MSISDN, IMEI, IMSI
function buildIdentityProfile(sub){
  // Only records the subject OWNS (their own device/SIM) describe their identity. A
  // record where the subject is merely the counterpart (callee) carries the *other*
  // party's imei/imsi/msisdn — including those produced bogus "SIM swaps".
  const rows=rowsFor(sub).filter(r=>(r.msisdn===sub||r.sub===sub)&&r.ts&&(r.imei||r.imsi||r.msisdn)).sort((a,b)=>new Date(a.ts)-new Date(b.ts));
  const timeline=[]; // chronological (imei,imsi) state sequence (no dedup)
  const imeiHistory=[],imsiHistory=[];
  rows.forEach(r=>{
    const imei=r.imei||null,imsi=r.imsi||null,t=new Date(r.ts);
    if(!imei&&!imsi)return;
    const last=timeline.length?timeline[timeline.length-1]:null;
    if(!last||last.imei!==imei||last.imsi!==imsi)
      timeline.push({imei,imsi,firstSeen:t,lastSeen:t,records:1,msisdns:new Set(r.msisdn?[r.msisdn]:[])});
    else{last.lastSeen=t;last.records++;if(r.msisdn)last.msisdns.add(r.msisdn)}
    if(imei)imeiHistory.push({imei,imsi,time:t});
    if(imsi)imsiHistory.push({imsi,imei,time:t});
  });
  const changes=[];
  for(let i=1;i<timeline.length;i++){
    const p=timeline[i-1],c=timeline[i];
    if(p.imei!==null&&c.imei!==null&&p.imei===c.imei&&p.imsi!==null&&c.imsi!==null&&p.imsi!==c.imsi)
      changes.push({time:c.firstSeen,type:'sim_swap',from:p.imsi,to:c.imsi,detail:'SIM swap on '+p.imei,confidence:'high'});
    else if(p.imsi!==null&&c.imsi!==null&&p.imsi===c.imsi&&p.imei!==null&&c.imei!==null&&p.imei!==c.imei)
      changes.push({time:c.firstSeen,type:'device_change',from:p.imei,to:c.imei,detail:'Device change on '+p.imsi,confidence:'high'});
    else if(p.imei!==null&&c.imei!==null&&p.imsi!==null&&c.imsi!==null&&p.imei!==c.imei&&p.imsi!==c.imsi)
      changes.push({time:c.firstSeen,type:'combined_change',from:p.imei+'/'+p.imsi,to:c.imei+'/'+c.imsi,detail:'SIM+Device change',confidence:'high'});
    else if(p.imei!==null&&c.imei!==null&&p.imei!==c.imei)
      changes.push({time:c.firstSeen,type:'partial_device_change',from:p.imei,to:c.imei,detail:'IMEI change (no IMSI context)',confidence:'medium'});
    else if(p.imsi!==null&&c.imsi!==null&&p.imsi!==c.imsi)
      changes.push({time:c.firstSeen,type:'partial_sim_swap',from:p.imsi,to:c.imsi,detail:'IMSI change (no IMEI context)',confidence:'medium'});
  }
  // Build deduplicated identities for public API (same semantics as before)
  const seen=new Map(),identities=[];
  timeline.forEach(s=>{
    const k=s.imei+'|'+s.imsi;
    if(!seen.has(k)){
      seen.set(k,identities.length);
      identities.push({imei:s.imei,imsi:s.imsi,firstSeen:s.firstSeen,lastSeen:s.lastSeen,records:s.records,msisdns:[...s.msisdns]});
    }else{
      const idx=seen.get(k),id=identities[idx];
      if(s.lastSeen>id.lastSeen)id.lastSeen=s.lastSeen;
      if(s.firstSeen<id.firstSeen)id.firstSeen=s.firstSeen;
      id.records+=s.records;
      s.msisdns.forEach(m=>{if(!id.msisdns.includes(m))id.msisdns.push(m)});
    }
  });
  return{identities,changes};
}
// -- Dataset Quality Metrics --
function computeQualityMetrics(){
  if(!allRows.length)return{score:100,missingTower:0,missingCoord:0,missingDur:0,badTs:0,unknownProto:0,total:0,penalties:[]};
  let missingTower=0,missingCoord=0,missingDur=0,badTs=0,unknownProto=0;
  allRows.forEach(r=>{
    if(!r.tow)missingTower++;
    if(r.lat==null||r.lng==null)missingCoord++;
    if(!r.dur&&r.dur!==0)missingDur++;
    if(r.ts){const d=new Date(r.ts);if(isNaN(d.getTime()))badTs++}else badTs++;
    if(r.type==='IPDR'&&(!r.prot||r.prot==='Unknown'))unknownProto++;
  });
  const total=allRows.length;
  const pcts={};const penalties=[];
  const addPenalty=(label,count,perRecord)=>{
    const pct=total?Math.round(count/total*100):0;
    const pen=Math.round(count*perRecord);
    pcts[label]={count,pct,pen};
    if(pen)penalties.push({label,count,pct,pen,weight:perRecord});
  };
  addPenalty('Missing tower',missingTower,5);
  addPenalty('Missing coordinates',missingCoord,8);
  addPenalty('Missing duration',missingDur,10);
  addPenalty('Invalid timestamps',badTs,15);
  addPenalty('Unknown protocol',unknownProto,3);
  const totalPenalty=penalties.reduce((s,p)=>s+p.pen,0);
  const score=Math.max(0,Math.min(100,100-totalPenalty));
  return{score,missingTower,missingCoord,missingDur,badTs,unknownProto,total,penalties};
}
// -- Tower Analytics --
function towerAnalytics(sub){
  const rows=ownedRowsFor(sub).filter(r=>r.ts&&r.tow).sort((a,b)=>new Date(a.ts)-new Date(b.ts));
  if(!rows.length)return{};
  const towerCounts={};let nightTower=null,weekendTower=null;
  const nightCounts={},weekendCounts={};
  rows.forEach(r=>{
    const d=new Date(r.ts);const h=d.getHours();const day=d.getDay();
    const isNight=h>=23||h<5;const isWeekend=day===0||day===6;
    towerCounts[r.tow]=(towerCounts[r.tow]||0)+1;
    if(isNight){nightCounts[r.tow]=(nightCounts[r.tow]||0)+1}
    if(isWeekend){weekendCounts[r.tow]=(weekendCounts[r.tow]||0)+1}
  });
  const sorted=Object.entries(towerCounts).sort((a,b)=>b[1]-a[1]);
  const nightSorted=Object.entries(nightCounts).sort((a,b)=>b[1]-a[1]);
  const weekendSorted=Object.entries(weekendCounts).sort((a,b)=>b[1]-a[1]);
  return{
    towerCounts:towerCounts,
    topTowers:sorted.slice(0,5),
    nightTower:nightSorted[0]?nightSorted[0][0]:null,
    weekendTower:weekendSorted[0]?weekendSorted[0][0]:null,
    totalTowers:sorted.length
  };
}
// -- Evidence Integrity Hash --
function evidenceHash(sessionData){
  const str=sessionData.serviceLabel+'|'+sessionData.evidence.sort().join(',')+'|'+sessionData.duration+'|'+(sessionData.records||0);
  let hash=0;for(let i=0;i<str.length;i++){const c=str.charCodeAt(i);hash=((hash<<5)-hash)+c;hash|=0}
  return 'EVID-'+Math.abs(hash).toString(16).toUpperCase().padStart(8,'0');
}
// -- View Supporting Records --
function showSessionRecords(sessionData){
  const overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center';
  overlay.onclick=e=>{if(e.target===overlay)overlay.remove()};
  const box=document.createElement('div');
  box.style.cssText='background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:20px;max-width:700px;max-height:80vh;overflow-y:auto;font-size:0.78rem';
  box.innerHTML=`
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h3 style="margin:0">Session: ${esc(sessionData.serviceLabel||'Unknown')}</h3>
      <span style="color:var(--muted);font-size:0.7rem">${evidenceHash(sessionData)}</span>
    </div>
    <div style="background:var(--accent-light);padding:8px;border-radius:4px;margin-bottom:10px">
      <strong>Evidence Chain:</strong>
      <div style="margin-top:4px">${sessionData.evidence?sessionData.evidence.map(e=>'<div style="padding:1px 0">&#x2022; '+esc(e)+'</div>').join(''):'No evidence'}</div>
    </div>
    <table style="width:100%;border-collapse:collapse">
      <thead><tr style="border-bottom:1px solid var(--line)"><th style="text-align:left;padding:4px">Time</th><th style="text-align:left;padding:4px">Type</th><th style="text-align:left;padding:4px">Counterpart</th><th style="text-align:left;padding:4px">Tower</th></tr></thead>
      <tbody>${(sessionData.recordsData||[]).map(r=>'<tr style="border-bottom:1px solid var(--line)"><td style="padding:3px">'+fmt(r.ts)+'</td><td style="padding:3px">'+esc(r.type||'')+'</td><td style="padding:3px">'+esc(r.cnt||'')+'</td><td style="padding:3px">'+esc(r.tow||'')+'</td></tr>').join('')}</tbody>
    </table>`;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}
function showMeetingOverlay(key,idx){
  const meetings=window.meetingStore&&window.meetingStore[key];
  if(!meetings||!meetings[idx])return;
  const m=meetings[idx];
  const overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center';
  overlay.onclick=e=>{if(e.target===overlay)overlay.remove()};
  const box=document.createElement('div');
  box.style.cssText='background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:20px;max-width:500px;max-height:60vh;overflow-y:auto;font-size:0.78rem';
  box.innerHTML=`
    <h3 style="margin:0 0 10px">Meeting: ${esc(m.subA)} & ${esc(m.subB)}</h3>
    <div style="margin-bottom:10px">
      <div><strong>Time:</strong> ${m.time?new Date(m.time).toLocaleString():'?'}</div>
      <div><strong>Tower:</strong> ${esc(m.tow)}</div>
      <div><strong>Gap:</strong> ${m.gap}m (${m.gapLevel})</div>
      <div><strong>Score:</strong> ${m.score} (${m.encounterCount} encounters)</div>
    </div>
    <div style="background:var(--accent-light);padding:8px;border-radius:4px;margin-bottom:10px">
      <strong>Evidence:</strong>
      <div style="margin-top:4px">${m.evidence?m.evidence.map(e=>'<div style="padding:1px 0">&#x2022; '+esc(e)+'</div>').join(''):'No evidence'}</div>
    </div>
    <table style="width:100%;border-collapse:collapse">
      <thead><tr style="border-bottom:1px solid var(--line)"><th style="text-align:left;padding:4px">Subject</th><th style="text-align:left;padding:4px">Event</th></tr></thead>
      <tbody>
        <tr style="border-bottom:1px solid var(--line)"><td style="padding:3px">${esc(m.subA)}</td><td style="padding:3px">${esc(m.subAEvent)}</td></tr>
        <tr><td style="padding:3px">${esc(m.subB)}</td><td style="padding:3px">${esc(m.subBEvent)}</td></tr>
      </tbody>
    </table>`;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}
function showSubjectRecords(sub){
  const rows=rowsFor(sub).slice(-50).reverse();
  if(!rows.length)return;
  const overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center';
  overlay.onclick=e=>{if(e.target===overlay)overlay.remove()};
  const box=document.createElement('div');
  box.style.cssText='background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:16px;max-width:700px;max-height:80vh;overflow-y:auto;font-size:0.75rem';
  box.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
    <h3 style="margin:0">Subject: ${esc(sub)}</h3>
    <span style="color:var(--muted);font-size:0.7rem">${rows.length} records shown</span></div>
    <table style="width:100%;border-collapse:collapse">
      <thead><tr style="border-bottom:1px solid var(--line)"><th style="text-align:left;padding:3px">Time</th><th style="text-align:left;padding:3px">Type</th><th style="text-align:left;padding:3px">Counterpart</th><th style="text-align:left;padding:3px">Service</th><th style="text-align:left;padding:3px">Tower</th></tr></thead>
      <tbody>${rows.map(r=>'<tr style="border-bottom:1px solid var(--line)"><td style="padding:2px">'+fmt(r.ts)+'</td><td style="padding:2px">'+esc(r.type||'')+'</td><td style="padding:2px">'+esc(r.cnt||'')+'</td><td style="padding:2px">'+esc(r.svc||'')+'</td><td style="padding:2px">'+esc(r.tow||'')+'</td></tr>').join('')}</tbody>
    </table>`;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}
// -- Quality Dashboard Integration --
function renderQualityCard(){
  const q=computeQualityMetrics();
  const cards=document.getElementById('dashCards');
  if(!cards)return;
  const existing=document.querySelector('.dq-card');
  if(existing)existing.remove();
  const div=document.createElement('div');
  div.className='dq-card';
  div.style.cssText='background:var(--bg);border-radius:8px;padding:12px;margin-bottom:10px;border:1px solid var(--line)';
  div.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:center"><h4 style="margin:0;font-size:0.85rem">Data Quality</h4>
    <span style="font-size:1.2rem;font-weight:700;color:${q.score>80?'var(--success)':q.score>50?'var(--warn)':'var(--danger)'}">${q.score}%</span></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:8px;font-size:0.72rem;color:var(--muted)">
      ${q.penalties.map(p=>`<div><span style="color:${p.pen>5?'var(--warn)':''}">-${p.pen}</span> ${p.label}: ${p.count} (${p.pct}%)</div>`).join('')}
    </div>
    <div style="font-size:0.65rem;color:var(--muted);margin-top:4px;padding-top:4px;border-top:1px solid var(--line)">
      Score = 100 ${q.penalties.map(p=>`- ${p.pen}`).join(' ')} = ${q.score}% (${q.total} records)
    </div>`;
  cards.parentNode.insertBefore(div,cards.nextSibling);
}
// -- Port?Description map --
// IANA dynamic/ephemeral port range. A connection's own source port is usually
// drawn from here, so a match on it is likely coincidental, not the real service.
const EPHEMERAL_MIN=ATTR_DATA.constants.ephemeral_min;
const PORT_SVC=ATTR_DATA.port_svc;
function portSvc(p){return p?PORT_SVC[parseInt(p)]||'':''}
// -- Behavioral Patterns (bytes / duration / time-of-day analysis) --
function trafficPattern(dur,up,dwn,protocol,portSet,recCount,hour){
  // Returns {category, activity, confidenceDelta, evidence}
  if(!dur&&!up&&!dwn)return null;
  const totalBytes=(up||0)+(dwn||0);
  const isUDP=protocol==='UDP';
  const isTCP=protocol==='TCP';
  const ratio=up>0&&dwn>0?up/dwn:(up>0?999:0);
  const symmetric=ratio>0.3&&ratio<3;
  const uploadHeavy=ratio>5;
  const downloadHeavy=dwn>0&&ratio<0.2;
  const hasVoipPort=portSet&&([...portSet].some(p=>[3478,3479,3480,3481,16384,16387,19302,19303,19304,19305,8801,8810,5004].includes(p)));
  const hasStreamPort=portSet&&([...portSet].some(p=>[80,443,8080].includes(p)));
  const hasVpnPort=portSet&&([...portSet].some(p=>[1194,1195,1701,1723,4500,500,51820,51821].includes(p)));
  const hasRemoteDesktopPort=portSet&&([...portSet].some(p=>[3389,5900,5901,5902,5938,7070].includes(p)));
  const hasFileTransferPort=portSet&&([...portSet].some(p=>[20,21,989,990,445,2049].includes(p)));
  const evidence=[];
  let category='',activity='',confDelta=0;

  // VPN / Tunnel: UDP, persistent, moderate data, VPN ports
  if(hasVpnPort&&dur>=30&&(isUDP||isTCP)){
    category='VPN';activity='Encrypted Tunnel';confDelta=15;
    evidence.push('VPN port(s): '+[...portSet].filter(p=>[1194,1195,1701,1723,4500,500,51820,51821].includes(p)).join(','));
    if(dur>=600){confDelta+=5;evidence.push('Persistent tunnel ('+dur+'s)')}
  }
  // Remote Desktop: TCP, interactive, screen-sharing ports
  else if(hasRemoteDesktopPort&&isTCP&&dur>10){
    category='Remote Desktop';activity='Remote Access';confDelta=15;
    evidence.push('Remote desktop port(s): '+[...portSet].filter(p=>[3389,5900,5901,5902,5938,7070].includes(p)).join(','));
    if(dur>=300){confDelta+=5;evidence.push('Extended remote session')}
    if(totalBytes>1e6){confDelta+=5;evidence.push('Data: '+fmtBytes(totalBytes))}
  }
  // File Transfer / SMB: TCP, upload+download, file-transfer ports
  else if(hasFileTransferPort&&isTCP&&totalBytes>500000){
    category='File Transfer';activity='File Transfer';confDelta=12;
    evidence.push('File transfer port(s): '+[...portSet].filter(p=>[20,21,989,990,445,2049].includes(p)).join(','));
    if(uploadHeavy)evidence.push('Upload: '+fmtBytes(up));
    if(downloadHeavy)evidence.push('Download: '+fmtBytes(dwn));
  }
  // Cloud Sync: moderate data, TCP, persistent, bidirectional
  else if(isTCP&&dur>60&&totalBytes>100000&&symmetric&&!hasVoipPort){
    category='Cloud Sync';activity='Sync / Backup';confDelta=8;
    evidence.push('Bidirectional sync: '+fmtBytes(up)+' — '+fmtBytes(dwn)+' ?');
    if(dur>=600){confDelta+=5;evidence.push('Extended sync session ('+dur+'s)')}
  }
  // Screen Sharing: UDP, sustained, moderate data, screen-share ports
  else if(isUDP&&dur>=30&&totalBytes>200000&&totalBytes<5e6&&hasStreamPort){
    category='Screen Sharing';activity='Screen Share';confDelta=10;
    evidence.push('UDP screen sharing pattern, '+fmtBytes(totalBytes));
  }
  // Video Call: UDP + more data + longer duration (check before Voice for specificity)
  else if(isUDP&&dur>=60&&totalBytes>1e6&&symmetric){
    category='Video Call';activity='Video Session';confDelta=15;
    evidence.push('UDP '+dur+'s session');
    evidence.push('High data volume: '+fmtBytes(totalBytes));
    if(hasVoipPort){confDelta+=10;evidence.push('VoIP port(s)')}
  }
  // Voice Call: UDP + symmetric + moderate-long duration + VoIP ports
  else if(isUDP&&dur>=30&&symmetric&&totalBytes>50000&&totalBytes<2e7){
    category='Voice Call';activity='Voice Session';confDelta=15;
    evidence.push('UDP '+dur+'s session');
    evidence.push('Symmetric traffic (ratio '+(ratio.toFixed(1))+')');
    if(hasVoipPort){confDelta+=10;evidence.push('VoIP port(s): '+[...portSet].filter(p=>[3478,3479,3480,3481,8801,8810,16384,19302].includes(p)).join(','))}
    if(dur>=300){confDelta+=5;evidence.push('Extended call >5min')}
  }
  // Streaming: TCP + high download + long duration + download-heavy
  else if(isTCP&&dur>=120&&downloadHeavy&&dwn>5000000){
    category='Streaming';activity='Content Stream';confDelta=12;
    evidence.push('Download: '+fmtBytes(dwn));
    evidence.push('Duration: '+dur+'s');
    if(dwn>5e7){confDelta+=5;evidence.push('HD stream quality (>50MB)')}
  }
  // Conference: UDP + multiple concurrent streams or long duration
  else if(isUDP&&dur>=120&&totalBytes>500000){
    category='Conference';activity='Conference Call';confDelta=10;
    evidence.push('UDP '+dur+'s session, '+fmtBytes(totalBytes));
  }
  // Media Upload: upload-heavy
  else if(up>500000&&uploadHeavy&&dur>5){
    category='Media Upload';activity='Upload';confDelta=8;
    evidence.push('Upload: '+fmtBytes(up)+' (ratio '+ratio.toFixed(1)+')');
  }
  // Messaging: short burst, small data
  else if(recCount>1&&dur<=30&&totalBytes<100000&&isUDP){
    category='Messaging';activity='Chat / Status Update';confDelta=8;
    evidence.push('Short burst: '+recCount+' records in '+dur+'s');
  }
  else if(recCount>1&&dur<=30&&totalBytes<200000&&isTCP){
    category='Messaging';activity='Interactive Messaging';confDelta=5;
    evidence.push('Brief TCP exchange: '+recCount+' records');
  }
  // Browsing / Interactive: TCP, moderate data, mix
  else if(isTCP&&dur<120&&totalBytes<5e6){
    category='Browsing';activity='Web / Interactive';confDelta=3;
    evidence.push('Brief TCP session');
  }
  // Keep-alive / Presence
  else if(dur<5&&recCount<=2&&totalBytes<5000){
    category='Presence';activity='Keep-alive / Ping';confDelta=5;
    evidence.push('Minimal traffic: '+fmtBytes(totalBytes));
  }
  // Default to network traffic
  else{
    category='Network Traffic';activity='Data Transfer';
    evidence.push('Traffic: '+fmtBytes(totalBytes)+' over '+dur+'s');
  }
  // Time-of-day enhancement (bonus evidence for regular patterns)
  if(hour!==undefined){
    if(hour>=23||hour<4){evidence.push('Late night activity ('+hour+':00) — off-peak pattern')}
    else if(hour>=9&&hour<=17){evidence.push('Business hours ('+hour+':00) — work pattern')}
  }
  return{category,activity,confDelta,evidence};
}
// -- Multi-level service attribution engine --
// Level 1: Infrastructure (provider IP) ? 95-99%
// Level 2: Session behavioral fingerprint ? +5-25%
// Level 3: Port + Protocol match ? +10-30%
// Level 4: Activity taxonomy
// Output: {provider, tier, primary:{service,activity}, confidence, evidence[], candidates[]}
function scoreProvider(servs,ports,proto,dur,dir,bytesUp,bytesDn,recCount,provName){
  const scored=[];
  const tp=trafficPattern(dur,bytesUp,bytesDn,proto,ports,recCount);
  servs.forEach(svc=>{
    const allPorts=[...(svc.ports.tcp||[]),...(svc.ports.udp||[])];
    const portMatch=ports.size>0?[...ports].some(p=>allPorts.includes(p)):false;
    const protoMatch=proto&&svc.proto.includes(proto);
    const actMatch=tp?svc.acts.some(a=>a.toLowerCase().includes(tp.category.toLowerCase().split(' ')[0].toLowerCase())||tp.category.toLowerCase().includes(a.toLowerCase().split(' ')[0].toLowerCase())):false;
    let score=60; // provider base
    if(portMatch)score+=15;
    if(protoMatch)score+=10;
    if(actMatch)score+=10;
    // Duration signals
    if(dur>=300)score+=5;
    else if(dur>=30)score+=2;
    // Data volume signals
    if((bytesUp||0)>1e6||(bytesDn||0)>1e6)score+=3;
    // Category-based scoring with penalties
    if(tp&&svc.cats){
      if(svc.cats.includes(tp.category)){
        score+=15; // matching behavior category
      }else if(svc.cats.length>0&&tp.category!=='Network Traffic'&&tp.category!=='Presence'){
        score-=10; // non-matching specific activity
      }
    }
    // VPN services: penalize heavily for non-VPN traffic patterns
    if(svc.cats&&svc.cats.length===1&&svc.cats[0]==='VPN'&&tp&&tp.category!=='VPN'){
      score-=25;
    }
    // Infrastructure-only services (empty cats): reduce score for specific activities
    if(svc.cats&&svc.cats.length===0&&tp&&tp.category!=='Network Traffic'){
      score=Math.round(score*0.6);
    }
    // Distinctive indicators: strong multi-factor signatures
    const di=DISTINCTIVE_INDICATORS.find(d=>d.svc===svc.n);
    const diHit=di&&provName&&di.check(provName,proto,ports,new Set(ports));
    if(diHit){score+=15}
    scored.push({svc:svc.n,act:svc.acts[0],score,portMatch,protoMatch,actMatch,dur,trafficCat:tp?tp.category:null,diHit});
  });
  scored.sort((a,b)=>b.score-a.score);
  return scored;
}
function pickBest(scored,duration,trafficCat,trafficEvidence){
  if(!scored||!scored.length)return{tier:4,providerConfidence:10,serviceConfidence:5,primary:{service:'Unknown',activity:'Traffic'},serviceLabel:'Unknown',activityLabel:'Traffic',candidates:[],evidence:['No matching services'],hasPortProto:false,strongCount:0};
  const top=scored[0];
  const strong=scored.filter(s=>s.score>=top.score*0.85);
  const hasPortProto=scored.some(s=>s.portMatch||s.protoMatch);
  const hasBoth=top.portMatch&&top.protoMatch;
  const hasAct=scored.some(s=>s.actMatch);
  let tier,serviceConfidence,providerConfidence,serviceLabel,activityLabel;
  const evidence=[...trafficEvidence];
  // Provider confidence: based on specificity and consensus
  providerConfidence=hasPortProto?75:hasAct?68:60;
  // Service confidence: based on match strength
  if(hasBoth&&hasAct&&duration>=60&&top.score>=100){tier=3;serviceConfidence=73;serviceLabel='Possible '+top.svc;activityLabel=top.act}
  else if(strong.length===1&&top.portMatch&&hasAct){tier=2;serviceConfidence=84;providerConfidence=82;serviceLabel='Likely '+top.svc;activityLabel=top.act}
  else if(strong.length===1&&hasAct){tier=2;serviceConfidence=80;serviceLabel='Likely '+top.svc;activityLabel=top.act}
  else if(strong.length===1&&top.portMatch){tier=2;serviceConfidence=82;serviceLabel='Likely '+top.svc;activityLabel=top.act}
  else if(strong.length===1&&hasPortProto){tier=2;serviceConfidence=78;serviceLabel='Likely '+top.svc;activityLabel=top.act}
  else if(hasPortProto&&strong.length>1){tier=4;serviceConfidence=50;providerConfidence=70;serviceLabel='__MULTI__';activityLabel=strong.map(s=>s.svc).join('/')}
  else if(!hasPortProto&&!hasAct){tier=1;serviceConfidence=30;providerConfidence=92;serviceLabel='__PROV__';activityLabel='Network Traffic'}
  else if(!hasPortProto&&hasAct){tier=1;serviceConfidence=45;providerConfidence=90;serviceLabel='__PROV__';activityLabel=trafficCat||'Activity'}
  else{tier=4;serviceConfidence=41;providerConfidence=35;serviceLabel='Unknown';activityLabel='Traffic'}
  const alts=scored.slice(1,5).filter(s=>s.score>=top.score-20).map(s=>({service:s.svc,activity:s.act,score:s.score}));
  if(top.portMatch){const mp=scored.filter(s=>s.portMatch).map(s=>s.svc);if(mp.length)evidence.push('Port match: '+[...new Set(mp)].join(', '))}
  if(top.protoMatch)evidence.push(scored[0].trafficCat?'Behavioral: '+scored[0].trafficCat:'Protocol match');
  if(duration>=60)evidence.push('Session duration: '+duration+'s');
  if(strong.length>1)evidence.push('Candidates: '+strong.map(s=>s.svc+' ('+s.score+'%)').join(', '));
  return{tier,providerConfidence,serviceConfidence,primary:{service:top.svc,activity:top.act},serviceLabel,activityLabel,candidates:alts,evidence,hasPortProto,strongCount:strong.length,trafficCat:top.trafficCat};
}
function recordSvcAttr(r){
  if(r.type!=='IPDR')return'';
  const m=matchService(r);
  const conf=m.serviceConfidence||0;
  if(m.tier===4&&conf<15)return'';
  const actStr=m.activityLabel?': '+m.activityLabel:'';
  const confStr=conf?' ['+conf+'%]':'';
  return m.serviceLabel+actStr+confStr;
}
function matchService(rec){
  const sp=parseInt(rec.sport),dp=parseInt(rec.dport);
  // Drop an ephemeral source port when a destination port exists — it's the
  // connection's own short-lived port, not the service being contacted.
  const ports=new Set();
  if(dp)ports.add(dp);
  if(sp&&!(dp&&sp>=EPHEMERAL_MIN))ports.add(sp);
  const proto=rec.prot?rec.prot.toUpperCase():'';
  const dur=rec.dur||0;const dir=rec.dir||'';const up=rec.bytesUp||0;const dn=rec.bytesDn||0;
  // Deterministic: a private/CGNAT/loopback destination is internal, not an internet service.
  const dkind=ipKind(rec.cnt);
  if(dkind){
    const label=PRIVATE_LABEL[dkind]||'Private';
    const portName=dp&&PORT_SVC[dp]?' ('+PORT_SVC[dp]+')':'';
    return{provider:'',tier:1,primary:{service:label,activity:'Internal'},serviceLabel:label,activityLabel:'Internal / non-routable',serviceConfidence:70,category:'internal',candidates:[],evidence:[label+' destination IP'+portName].concat(proto?[proto+' protocol']:[])};
  }
  // Prefer a content-provider match (a real service) over an access-network/ISP match,
  // checking the counterpart IP before the subject's own (often carrier) IP.
  const cntM=ipInRange(rec.cnt,IP_RANGES),subM=ipInRange(rec.sub,IP_RANGES);
  const ipRes=(cntM&&!cntM.isp?cntM:null)||(subM&&!subM.isp?subM:null)||cntM||subM;
  const provName=ipRes?ipRes.provider:null;
  const evidence=[];
  // An ISP-only match identifies the carrier; fall through to port classification and only
  // label it an access network if no specific service is found (Phase 2 fallbacks below).
  const ispCarrier=(ipRes&&ipRes.isp)?provName:null;
  const accessNet=()=>({provider:provName,providerConfidence:55,tier:1,primary:{service:provName,activity:'Access Network'},serviceLabel:provName+' (Access Network)',activityLabel:'Carrier / ISP traffic',serviceConfidence:30,candidates:[],evidence:[provName+' access network ('+ipRes.raw+')'].concat(proto?[proto+' protocol']:[])});
  // Phase 1: known content provider from IP (Level 1 — Infrastructure)
  if(provName&&!ispCarrier){
    evidence.push(provName+' IP range ('+ipRes.raw+')');
    const hint=ipHint(rec.cnt)||ipHint(rec.sub);
    if(hint){
      evidence.push(hint.provider+' '+hint.service+' ('+hint.activity+')');
      return{provider:hint.provider,providerConfidence:96,tier:1,primary:{service:hint.service,activity:hint.activity},serviceLabel:hint.service,activityLabel:hint.activity,serviceConfidence:95,candidates:[],evidence};
    }
    const prov=SERVICE_DB.find(p=>p.pr===provName);
    if(prov){
      const tp=trafficPattern(dur,up,dn,proto,ports,1,rec.ts?new Date(rec.ts).getHours():undefined);
      const scored=scoreProvider(prov.services,ports,proto,dur,dir,up,dn,1,provName);
      const best=pickBest(scored,dur,tp?tp.category:null,tp?tp.evidence:[]);
      best.provider=provName;
      if(HOSTING_PROVIDERS.has(provName)){best.category='hosting';best.evidence.push('Cloud/VPS host — possible VPN, proxy, or self-hosted endpoint')}
      // Resolve placeholders
      if(best.serviceLabel==='__PROV__'){best.serviceLabel=provName+' '+best.primary.service;best.primary={service:provName,activity:best.activityLabel||'Network Traffic'}}
      else if(best.serviceLabel==='__MULTI__'){best.serviceLabel=provName+' ('+best.activityLabel+')';best.primary={service:provName,activity:'Multiple'};best.activityLabel='Multiple: '+scored.filter(s=>s.score>=scored[0].score-3).map(s=>s.svc).join('/')}
      // Build evidence for display
      if(ports.size){const mp=[...ports].join(',');best.evidence.unshift(ports.size>1?'Ports: '+mp:'Port: '+mp+(PORT_SVC[parseInt(mp)]?' ('+PORT_SVC[parseInt(mp)]+')':''))}
      if(proto)best.evidence.unshift(proto+' protocol');
      if(tp&&best.trafficCat)best.evidence.unshift('Behavior: '+best.trafficCat);
      best.candidates=scored.map(s=>({service:s.svc,activity:s.act,score:s.score,portMatch:s.portMatch,protoMatch:s.protoMatch,trafficCat:s.trafficCat}));
      best.evidence=best.evidence.filter((v,i,a)=>a.indexOf(v)===i);
      return best;
    }
  }
  // Phase 2: no provider — fallback to port-based classification
  const genericPorts=[80,443,8080,8443,9443,10443];
  if(ports.size===0||[...ports].every(p=>genericPorts.includes(p)))return ispCarrier?accessNet():{provider:'',tier:4,primary:{service:'Unknown',activity:'Encrypted Traffic'},serviceLabel:'Unknown',activityLabel:'Encrypted Traffic',serviceConfidence:5,candidates:[],evidence:['No matching provider IP — generic HTTPS/encrypted']};
  // Generic port-to-service mapping (covers common IANA ports not in provider DB)
  const GENERIC_SVC={25:'SMTP Mail',53:'DNS',110:'POP3 Mail',123:'NTP',135:'RPC',137:'NetBIOS',138:'NetBIOS',139:'NetBIOS',143:'IMAP Mail',161:'SNMP',162:'SNMP-Trap',389:'LDAP',445:'SMB',465:'SMTPS Mail',514:'Syslog',587:'SMTP-Sub Mail',636:'LDAPS',853:'DNS-over-TLS',993:'IMAPS Mail',995:'POP3S Mail',1433:'MSSQL',1521:'Oracle DB',2049:'NFS',3306:'MySQL',3389:'RDP',5432:'PostgreSQL',6379:'Redis',8080:'HTTP-Alt',8443:'HTTPS-Alt',9090:'WebUI',27017:'MongoDB'};
  const matchedPort=[...ports].find(p=>GENERIC_SVC[p]);
  if(matchedPort){
    const svcLabel=GENERIC_SVC[matchedPort];
    let conf=60;
    if((proto==='TCP'&&[25,110,143,465,587,853,993,995,1433,3306,5432,3389,6379,27017].includes(matchedPort))||(proto==='UDP'&&[53,123,137,138,161,162,514,636].includes(matchedPort)))conf=76;
    evidence.push('Port '+matchedPort+' ('+svcLabel+')'+(proto?' — '+proto+' protocol':''));
    if(ispCarrier)evidence.push(ispCarrier+' access network ('+ipRes.raw+')');
    return{provider:ispCarrier||'',tier:4,primary:{service:svcLabel,activity:'Data Transfer'},serviceLabel:'Likely '+svcLabel,activityLabel:'Data Session',serviceConfidence:conf,candidates:[],evidence};
  }
  // Try known provider DB for less common ports
  const fallbackCandidates=[];
  SERVICE_DB.forEach(prov=>{
    prov.services.forEach(svc=>{
      const allPorts=[...(svc.ports.tcp||[]),...(svc.ports.udp||[])];
      if([...ports].some(p=>allPorts.includes(p)))fallbackCandidates.push({provider:prov.pr,service:svc.n,activity:svc.acts[0],port:[...ports].find(p=>allPorts.includes(p))});
    });
  });
  if(fallbackCandidates.length){
    const best=fallbackCandidates[0];
    evidence.push('Port '+best.port+' ('+(PORT_SVC[best.port]||'')+') — candidate: '+best.provider+' '+best.service);
    if(proto)evidence.push(proto+' protocol');
    if(ispCarrier)evidence.push(ispCarrier+' access network ('+ipRes.raw+')');
    return{provider:best.provider,providerConfidence:25,tier:4,primary:{service:best.service,activity:best.activity},serviceLabel:'Unknown',activityLabel:'Possible '+best.activity,serviceConfidence:12,candidates:fallbackCandidates.map(c=>({service:c.service,activity:c.activity,score:10})),evidence};
  }
  return ispCarrier?accessNet():{provider:'',tier:4,primary:{service:'Unknown',activity:'Traffic'},serviceLabel:'Unknown',activityLabel:'Traffic',serviceConfidence:8,candidates:[],evidence:['No matching provider or service signature']};
}
// -- Session-level classification (behavioral fingerprinting) --
function classifySession(recs){
  if(!recs.length)return null;
  const start=recs.reduce((e,r)=>!e||r.ts<e?r.ts:e,null);
  const end=recs.reduce((e,r)=>!e||r.ts>e?r.ts:e,null);
  const S=start?new Date(start):null,E=end?new Date(end):null;
  const durSec=S&&E?Math.round((E-S)/1000):recs.reduce((s,r)=>s+(r.dur||0),0);
  const ips=new Set(recs.map(r=>r.cnt).filter(i=>i&&i.includes('.')));
  const ipRanges=[...ips].map(ip=>ipInRange(ip,IP_RANGES)).filter(Boolean);
  const portSet=new Set();recs.forEach(r=>{const sp=parseInt(r.sport),dp=parseInt(r.dport);if(dp)portSet.add(dp);if(sp&&!(dp&&sp>=EPHEMERAL_MIN))portSet.add(sp)});
  const protos=new Set(recs.filter(r=>r.prot).map(r=>r.prot.toUpperCase()));
  const dur=recs.reduce((m,r)=>Math.max(m,r.dur||0),0);
  const totalDur=recs.reduce((s,r)=>s+(r.dur||0),0);
  const continuous=recs.length>3&&dur>10;
  const shortBurst=recs.length<=3&&totalDur<5;
  const dataVol=recs.some(r=>(r.bytesUp||0)+(r.bytesDn||0)>5e6);
  const upSum=recs.reduce((s,r)=>s+(r.bytesUp||0),0);
  const dnSum=recs.reduce((s,r)=>s+(r.bytesDn||0),0);
  const evidence=[];
  // Provider consensus
  const provCounts={},provSpec={};ipRanges.forEach(ir=>{provCounts[ir.provider]=(provCounts[ir.provider]||0)+1;if(!provSpec[ir.provider]||ir.specificity>provSpec[ir.provider])provSpec[ir.provider]=ir.specificity});
  // Sort by count, but always rank content providers ahead of access-network/ISP matches.
  const provEntries=Object.entries(provCounts).sort((a,b)=>{const ai=isIspProvider(a[0])?1:0,bi=isIspProvider(b[0])?1:0;if(ai!==bi)return ai-bi;return b[1]-a[1]});
  const primaryProv=provEntries.length?provEntries[0][0]:null;
  const mixedProv=provEntries.length>1;
  // Known IP hint check
  const hint=[...ips].map(ip=>ipHint(ip)).filter(Boolean);
  if(hint.length){
    const h=hint[0];
    evidence.push(h.provider+' '+h.service+' IP ('+h.activity+')');
    // Check behavioral consistency
    const tp=trafficPattern(durSec,upSum,dnSum,protos.size===1?[...protos][0]:null,portSet,recs.length,start?new Date(start).getHours():undefined);
    const actLabel=tp?tp.category:'Activity';
    evidence.push('Session: '+durSec+'s, '+recs.length+' records'+(tp?', pattern: '+tp.category:''));
    return{provider:h.provider,providerConfidence:96,tier:1,primary:{service:h.service,activity:h.activity+' '+actLabel},serviceLabel:h.service,activityLabel:h.activity+' — '+actLabel,serviceConfidence:95,candidates:[],evidence,start,end,duration:durSec,records:recs.length};
  }
  // Provider-specific session matching (Level 2 — Behavioral Fingerprinting)
  if(primaryProv){
    evidence.push(primaryProv+' IP range ('+ipRanges.length+' IPs, '+recs.length+' records, '+durSec+'s)');
    const prov=SERVICE_DB.find(p=>p.pr===primaryProv);
    if(prov){
      const tp=trafficPattern(durSec,upSum,dnSum,protos.size===1?[...protos][0]:null,portSet,recs.length,start?new Date(start).getHours():undefined);
      if(tp){tp.evidence.forEach(e=>evidence.push(e));evidence.unshift('Behavior: '+tp.category)}
      const scored=prov.services.map(svc=>{
        const allPorts=[...(svc.ports.tcp||[]),...(svc.ports.udp||[])];
        const pMatch=portSet.size>0&&[...portSet].some(p=>allPorts.includes(p));
        const protoMatch=protos.size>0&&[...protos].some(p=>svc.proto.includes(p));
        let score=75;
        if(pMatch)score+=15;
        if(protoMatch)score+=10;
        if(continuous)score+=4;
        if(dataVol)score+=5;
        if(shortBurst)score+=4;
        if(mixedProv)score=Math.round(score*0.7);
        // IP range specificity factor (tighter CIDR = more confidence)
        const specFactor=provSpec[primaryProv]||0.6;
        if(specFactor<0.8)score=Math.round(score*specFactor);
        // Category-based scoring with penalties
        if(tp&&svc.cats){
          if(svc.cats.includes(tp.category)){
            score+=15; // matching behavior category
          }else if(svc.cats.length>0&&tp.category!=='Network Traffic'&&tp.category!=='Presence'){
            score-=10; // penalty for non-matching specific activity
          }
        }
        // VPN services: penalize heavily for non-VPN traffic
        if(svc.cats&&svc.cats.length===1&&svc.cats[0]==='VPN'&&tp&&tp.category!=='VPN'){
          score-=25;
        }
        // Infrastructure-only services (empty cats): reduce for specific activities
        if(svc.cats&&svc.cats.length===0&&tp&&tp.category!=='Network Traffic'){
          score=Math.round(score*0.6);
        }
        // Distinctive indicators: strong multi-factor signatures
        const di=DISTINCTIVE_INDICATORS.find(d=>d.svc===svc.n);
        const diHit=di&&primaryProv&&di.check(primaryProv,protos.size===1?[...protos][0]:null,portSet,new Set(portSet));
        if(diHit){
          score+=15; // moderate service confidence boost
          evidence.push('Distinctive signature: '+svc.n+' ('+di.svc+')');
        }
        return{svc:svc.n,act:svc.acts[0],score,pMatch,protoMatch,behavior:tp?tp.activity:null,diHit};
      });
      scored.sort((a,b)=>b.score-a.score);
      const top=scored[0];
      const strong=scored.filter(s=>s.score>=top.score*0.85);
      let tier,serviceConfidence,providerConfidence,label,actLabel;
      const hasPortProto=scored.some(s=>s.pMatch||s.protoMatch);
      const hasBehavior=tp!==null;
      // Provider confidence: based on IP range specificity, consensus, ASN, distinctive indicators
      const specFactor=provSpec[primaryProv]||0.6;
      providerConfidence=Math.round(70+specFactor*25);
      if(provEntries.length===1)providerConfidence+=5;
      if(mixedProv)providerConfidence=Math.round(providerConfidence*0.85);
      // Distinctive indicator bonus for provider confidence (stronger than service)
      const hasDI=scored.some(s=>s.diHit);
      if(hasDI)providerConfidence+=10;
      providerConfidence=Math.min(95,Math.max(20,providerConfidence));
      // Service confidence: based on ports, protocol, behavior, indicators
      if(hasPortProto&&hasBehavior&&strong.length===1&&top.score>=100){tier=2;serviceConfidence=top.score;label='Likely '+top.svc;actLabel=top.act+' — '+(tp?tp.activity:'')}
      else if(hasPortProto&&strong.length===1){tier=2;serviceConfidence=Math.min(top.score,88);label='Likely '+top.svc;actLabel=top.act}
      else if(hasBehavior&&strong.length===1){tier=2;serviceConfidence=Math.min(top.score,82);label='Likely '+top.svc;actLabel=top.act+' Activity'}
      else if(hasPortProto&&strong.length>1){tier=4;serviceConfidence=Math.min(top.score,55);label=primaryProv+' ('+strong.map(s=>s.svc).join('/')+')';actLabel='Multiple: '+strong.map(s=>s.svc).join('/');top.svc=primaryProv;top.act='Multiple'}
      else if(hasBehavior&&!hasPortProto){tier=1;serviceConfidence=50;label=primaryProv+' Infrastructure';actLabel=tp?tp.activity:'Network Traffic';top.svc=primaryProv;top.act=tp?tp.activity:'Network Traffic'}
      else if(!hasPortProto&&!hasBehavior){tier=1;serviceConfidence=30;label=primaryProv+' Infrastructure';actLabel='Network Traffic';top.svc=primaryProv;top.act='Network Traffic'}
      else{tier=4;serviceConfidence=40;label='Unknown - '+primaryProv;actLabel='Possible Service'}
      // Cap service confidence at 95, floor at 5
      serviceConfidence=Math.min(95,Math.max(5,serviceConfidence));
      // Build evidence
      if(scored.some(s=>s.pMatch)){evidence.push('Port match: '+[...portSet].filter(p=>strong.some(s=>{const ap=[...(prov.services.find(x=>x.n===s.svc)?.ports.tcp||[]),...(prov.services.find(x=>x.n===s.svc)?.ports.udp||[])];return ap.includes(p)})).join(','))}
      if(scored.some(s=>s.protoMatch))evidence.push(protos.size?[...protos].join('/')+' protocol':'');
      if(portSet.size)evidence.push('Ports: '+[...portSet].join(','));
      if(tp)evidence.push('Pattern: '+tp.category+', '+tp.activity);
      if(continuous)evidence.push('Continuous session ('+durSec+'s)');
      if(dataVol)evidence.push('Data volume: '+fmtBytes(upSum+dnSum));
      if(!hasBehavior)evidence.push('Behavioral: no distinct activity pattern');
      if(strong.length>1)evidence.push('Candidates: '+strong.map(s=>s.svc+' ('+s.score+'%)').join(', '));
      const candidates=scored.map(s=>({service:s.svc,activity:s.act,score:s.score,behavior:s.behavior}));
      const dedupedEv=evidence.filter((v,i,a)=>a.indexOf(v)===i);
      return{provider:primaryProv,providerConfidence,tier,primary:{service:top.svc,activity:top.act},serviceLabel:label,activityLabel:actLabel,serviceConfidence,candidates,evidence:dedupedEv,start,end,duration:durSec,records:recs.length,recordsData:recs.map(r=>({ts:r.ts,type:r.type,cnt:r.cnt,tow:r.tow,lat:r.lat,lng:r.lng}))};
    }
  }
  // Fallback: port-only session attribution
  const genericPorts=[80,443,8080,8443,9443,10443];
  const hasOnlyGeneric=portSet.size>0&&[...portSet].every(p=>genericPorts.includes(p));
  if(hasOnlyGeneric||portSet.size===0)return{provider:'',providerConfidence:15,tier:4,primary:{service:'Unknown',activity:'Encrypted Traffic'},serviceLabel:'Unknown',activityLabel:'Encrypted Session',serviceConfidence:10,candidates:[],evidence:['No provider match — generic HTTPS session'],start,end,duration:durSec,records:recs.length};
  evidence.push('Distinctive port: '+[...portSet].join(','));
  if(continuous)evidence.push('Continuous traffic');
  return{provider:'',providerConfidence:10,tier:4,primary:{service:'Unknown',activity:'Unclassified'},serviceLabel:'Unknown',activityLabel:'Unclassified Session',serviceConfidence:8,candidates:[],evidence,start,end,duration:durSec,records:recs.length};
}
// Coarse activity family per port, used to pick session idle thresholds and to keep
// distinct activities to the same peer in separate sessions.
const PORT_FAMILY=ATTR_DATA.port_families;
// Idle gap (seconds) that ends a session, tuned per activity: chatty/streaming flows
// tolerate long pauses; lookups/browsing are bursty.
const FAMILY_GAP=ATTR_DATA.family_gaps;
function recPortFamily(r){
  const dp=parseInt(r.dport),sp=parseInt(r.sport);
  return PORT_FAMILY[dp]||PORT_FAMILY[sp]||'Other';
}
// Reconstruct IPDR sessions for an entity. Records are bucketed into concurrent tracks
// keyed by (counterpart, activity family) so interleaved conversations form coherent
// parallel sessions instead of fragmenting, and each track splits on a family-adaptive
// idle gap rather than one fixed threshold.
function reconstructSessions(entity){
  // IPDR rows identify the subject by msisdn; sub/cnt hold the source/destination IPs.
  // Matching on msisdn (or an IP entity) is required — filtering by sub/cnt alone never
  // matches a phone-number subject, which silently produced zero sessions.
  const ipdrs=allRows.filter(r=>r.type==='IPDR'&&(r.msisdn===entity||r.sub===entity||r.cnt===entity)).sort((a,b)=>new Date(a.ts)-new Date(b.ts));
  if(!ipdrs.length)return[];
  const open={};const sessions=[];
  const flush=k=>{const o=open[k];if(o&&o.recs.length){const cls=classifySession(o.recs);if(cls)sessions.push(cls)}delete open[k]};
  for(const r of ipdrs){
    // Peer = the destination service IP for the subject's own sessions; if the entity is
    // itself the destination IP, the peer is the source.
    const peer=(r.cnt===entity)?(r.sub||'?'):(r.cnt||'?');
    const fam=recPortFamily(r);
    const key=peer+'|'+fam;
    const ts=new Date(r.ts).getTime();
    const o=open[key];
    if(o&&ts-o.lastTs>(FAMILY_GAP[fam]||300)*1000){flush(key);open[key]={recs:[r],lastTs:ts}}
    else if(o){o.recs.push(r);o.lastTs=ts}
    else{open[key]={recs:[r],lastTs:ts}}
  }
  Object.keys(open).forEach(flush);
  sessions.sort((a,b)=>new Date(a.start)-new Date(b.start));
  return sessions;
}
// -- Timeline Narrative Engine --
// Builds a chronological narrative: Communication ? Movement ? Meetings ? Service Usage
function buildNarrative(subject){
  if(!subject)return[];
  const narrative=[];
  const rows=rowsFor(subject).filter(r=>r.ts).sort((a,b)=>new Date(a.ts)-new Date(b.ts));
  const sessions=reconstructSessions(subject);
  const meetings=detectMeetings({subject,maxResults:20});
  // Track last tower for movement detection
  let lastTow=null;
  rows.forEach(r=>{
    const t=new Date(r.ts);
    const timeStr=t.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    // Service/communication events
    if(r.type==='CDR'){
      narrative.push({time:t,text:timeStr+' — '+(r.dir||'')+' call '+(r.cnt?'with '+r.cnt:'')+(r.dur?' ('+r.dur+'s)':''),type:'call'});
    }else if(r.type==='IPDR'){
      const svc=recordSvcAttr(r)||r.svc||'';
      if(svc)narrative.push({time:t,text:timeStr+' — '+svc,type:'service'});
    }
    // Movement detection (tower change)
    if(r.tow&&r.tow!==lastTow&&lastTow){
      narrative.push({time:t,text:timeStr+' — Tower change: '+lastTow+' — '+r.tow,type:'movement'});
    }
    if(r.tow)lastTow=r.tow;
  });
  // Add reconstructed sessions
  sessions.forEach(s=>{
    if(s.start&&s.end){
      const startT=new Date(s.start);
      const endT=new Date(s.end);
      const durMin=Math.round((endT-startT)/60000);
      const svcName=s.primary?s.primary.service:(s.service||'');
      const label=s.activityLabel||s.activity||'';
      if(svcName){
        narrative.push({time:startT,text:startT.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+' — Session: '+svcName+(label?' ('+label+')':'')+(durMin?' '+durMin+'m':''),type:'session'});
      }
    }
  });
  // Add meeting events
  meetings.forEach(m=>{
    narrative.push({time:m.time,text:m.time.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+' — Meeting: with '+(m.subB||'another subject')+' at '+m.tow+' (gap:'+m.gap+'m, score:'+m.score+')',type:'meeting'});
  });
  narrative.sort((a,b)=>a.time-b.time);
  return narrative.slice(0,50);
}
function rowsFor(sub){if(!sub)return allRows;return allRows.filter(r=>r.sub===sub||r.cnt===sub||r.msisdn===sub)}
// Records the subject OWNS (their own device / a-party). A CDR geolocates only the
// caller, so tower/location and identity stats must use these, not records where the
// subject is merely the called counterpart (whose tower belongs to the other party).
function ownedRowsFor(sub){if(!sub)return allRows;return allRows.filter(r=>r.msisdn===sub||r.sub===sub)}

// ====== TAB SWITCHING ======
function switchTab(tab){
  state.tab=tab;
  document.querySelectorAll('.topbar-tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  document.querySelectorAll('.tab-content').forEach(s=>s.classList.toggle('active',s.id==='tab-'+tab));
  if(tab==='dashboard')renderDashboard();
  if(tab==='graph')renderGraph();
  if(tab==='map')initMap();
  if(tab==='timeline')renderTimeline();
  if(tab==='charts')renderCharts();
  if(tab==='services')renderServicesTab();
  if(tab==='correlation')renderCorrelationTab();
  if(tab==='inferences')renderInferences();
  if(tab==='records')renderRecords();
  if(tab==='ai')renderAiInsights();
  if(tab==='admin')renderAdmin();
}
document.querySelectorAll('.topbar-tab').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)));

// ====== UPLOAD ======
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
    const routes={cdr:'/upload/cdr',ipdr:'/upload/ipdr',towers:'/upload/towers'};
    const kindLabel={cdr:'CDR',ipdr:'IPDR',towers:'Towers'};
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
    html+='<div style="overflow:auto;max-height:350px;border:1px solid var(--line);border-radius:6px">';
    html+='<table class="data-table" style="min-width:400px;font-size:0.72rem"><thead><tr>'+preview.header.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr></thead><tbody>';
    preview.rows.forEach(r=>{html+='<tr>'+r.map(v=>'<td style="max-width:150px;overflow:hidden;text-overflow:ellipsis">'+esc(v||'')+'</td>').join('')+'</tr>'});
    html+='</tbody></table></div>';
    modal.querySelector('#upBody').innerHTML=html;
    modal.style.display='flex';
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
    newUpConfirm.addEventListener('click',async()=>{hide();await handleUploadConfirmed(kind,file,routes[kind]);});
  };
  reader.readAsText(file.slice(0,1024*512));
}
async function handleUploadConfirmed(kind,file,route){
  D.importStatus.textContent='Uploading '+kind+'...';
  try{const fd=new FormData();fd.append('file',file);if(activeCaseId)fd.append('case_id',activeCaseId);
    const r=await fetch(route,{credentials:'same-origin',method:'POST',body:fd});
    if(r.status===401){const e=new Error(await r.text()||'Auth required');e.name='AuthError';throw e}
    if(!r.ok)throw new Error(await r.text()||'Upload failed');
    document.getElementById(kind+'File').value='';D.importStatus.textContent=kind.toUpperCase()+' uploaded';await loadCaseData()}catch(e){D.importStatus.textContent='Upload failed';console.error(e)}
}
// Replace the direct upload listeners with preview triggers
['cdr','ipdr','towers'].forEach(k=>{
  const el=document.getElementById(k+'File');
  if(el)el.addEventListener('change',function(){const f=this.files&&this.files[0];if(f)showUploadPreview(k,f)});
});
D.resetCaseBtn.addEventListener('click',resetCase);

// ====== 1. DASHBOARD ======
function renderDashboard(){
  const _ht=$('dashHeroTitle'),_hs=$('dashHeroSub');
  if(!allRows.length){
    if(_ht)_ht.textContent='Dashboard';
    if(_hs)_hs.textContent='Upload CDR, IPDR and Tower CSVs to begin building the case.';
    D.dashCards.innerHTML='<div class="dash-card" style="grid-column:1/-1;text-align:center;padding:36px;color:var(--muted)">No data yet — use the upload cards above to add CDR / IPDR records and begin analysis.</div>';
    D.dashGraph.innerHTML='<p style="color:var(--muted);text-align:center;padding:40px 0;font-size:0.85rem">No data to display</p>';
    ['dashPie','dashHeat','dashBar'].forEach(k=>{if(D[k])D[k].innerHTML=''});
    try{window.dashPieChart&&(window.dashPieChart.destroy(),window.dashPieChart=null)}catch(e){}
    try{window.dashHeatChart&&(window.dashHeatChart.destroy(),window.dashHeatChart=null)}catch(e){}
    try{window.dashBarChart&&(window.dashBarChart.destroy(),window.dashBarChart=null)}catch(e){}
    return;
  }
  const total=allRows.length;
  const totalCdr=state.cdr.length,totalIpdr=state.ipdr.length;
  // Compute sessions and events separately
  const sessionCounts=new Map();allRows.forEach(r=>{const k=r.sub;if(k){sessionCounts.set(k,(sessionCounts.get(k)||0)+1)}});
  const totalSessions=state.subjects.reduce((sum,s)=>sum+reconstructSessions(s).length,0);
  const totalEvents=allRows.filter(r=>r.type==='CDR'||(r.type==='IPDR'&&r.svc)).length;
  const contactCounts={};allRows.forEach(r=>{if(r.cnt)contactCounts[r.cnt]=(contactCounts[r.cnt]||0)+1});
  const topContact=Object.entries(contactCounts).sort((a,b)=>b[1]-a[1])[0];
  const towerCounts={};allRows.forEach(r=>{if(r.tow)towerCounts[r.tow]=(towerCounts[r.tow]||0)+1});
  const topTower=Object.entries(towerCounts).sort((a,b)=>b[1]-a[1])[0];
  const svcCounts={};allRows.forEach(r=>{const s=r.svc||'Unknown';svcCounts[s]=(svcCounts[s]||0)+1});
  const topSvc=Object.entries(svcCounts).sort((a,b)=>b[1]-a[1])[0];
  const uniqueContacts=new Set(allRows.map(r=>r.cnt).filter(Boolean));
  const uniqueSubjects=new Set(allRows.map(r=>r.sub).filter(Boolean));

  // Hero: case name + live one-line summary
  if(_ht){const opt=D.caseSelector&&D.caseSelector.options[D.caseSelector.selectedIndex];
    const cn=opt?opt.text.replace(/\s*\(\d+\)\s*$/,'').trim():'';_ht.textContent=cn||'Investigation overview';}
  if(_hs){const ts=allRows.filter(r=>r.ts).map(r=>new Date(r.ts)).sort((a,b)=>a-b);
    const span=ts.length?ts[0].toLocaleDateString()+' – '+ts[ts.length-1].toLocaleDateString():'';
    _hs.textContent=n(total)+' records · '+n(uniqueSubjects.size)+' subjects · '+n(uniqueContacts.size)+' contacts'+(span?' · '+span:'');}

  D.dashCards.innerHTML=[
    {l:'Total Records',v:n(total),d:`${n(totalCdr)} CDR + ${n(totalIpdr)} IPDR`},
    {l:'Reconstructed Sessions',v:n(totalSessions),d:'From session reconstruction engine'},
    {l:'Call/Service Events',v:n(totalEvents),d:'CDR calls + attributed IPDR'},
    {l:'Top Contact',v:topContact?esc(topContact[0]):'n/a',d:topContact?topContact[1]+' interactions':'No data'},
    {l:'Top Service',v:topSvc?esc(topSvc[0]):'n/a',d:topSvc?topSvc[1]+' sessions':'No data'},
    {l:'Most Active Tower',v:topTower?esc(topTower[0]):'n/a',d:topTower?topTower[1]+' visits':'No data'},
    {l:'Unique Contacts',v:n(uniqueContacts.size),d:n(uniqueSubjects.size)+' unique subjects'},
    {l:'Unique Subjects',v:n(uniqueSubjects.size),d:'Network of '+n(uniqueContacts.size)+' contacts'},
    geoFenceDrawn&&geoFenceLayer?(()=>{
      const fencePts=geoFenceLayer.getLatLngs();
      const coords=Array.isArray(fencePts[0])?fencePts[0].map(p=>[p.lng,p.lat]):fencePts.map(p=>[p.lng,p.lat]);
      if(!coords.length)return null;
      const poly=turf.polygon([coords]);
      let inside=0;
      (geoRecords||[]).forEach(r=>{
        if(r.latitude!=null&&r.longitude!=null&&turf.booleanPointInPolygon(turf.point([r.longitude,r.latitude]),poly))inside++;
      });
      return {l:'Geo-fenced Records',v:n(inside),d:'Within drawn geofence',cat:'warn'};
    })():null,
    (()=>{
      // Burst detection for dashboard
      const subDays=new Map();
      allRows.forEach(r=>{if(!r.ts||!r.sub)return;const d=new Date(r.ts).toLocaleDateString();if(!subDays.has(r.sub))subDays.set(r.sub,new Map());subDays.get(r.sub).set(d,(subDays.get(r.sub).get(d)||0)+1)});
      let totalBursts=0;
      subDays.forEach((days,sub)=>{
        const counts=[...days.values()];if(counts.length<3)return;
        const avg=counts.reduce((a,c)=>a+c,0)/counts.length;const thr=Math.max(avg*3,20);
        days.forEach((c,d)=>{if(c>=thr)totalBursts++});
      });
      return totalBursts?{l:'Activity Spikes',v:n(totalBursts),d:'Days with anomalous volume',cat:'alert'}:null;
    })(),
  ].filter(Boolean).map(c=>`<div class="dash-card ${c.cat||''}"><div class="dash-label">${c.l}</div><div class="dash-value">${c.v}</div><div class="dash-detail">${c.d}</div></div>`).join('');

  renderCaseSummary();
  renderQualityCard();
  if(D.compareBar)D.compareBar.style.display='flex';
  // Pre-fill date inputs with data range
  if(!D.cpStartA.value||!D.cpStartB.value){
    const times=allRows.filter(r=>r.ts).map(r=>new Date(r.ts));
    if(times.length>1){
      const minT=new Date(Math.min(...times)),maxT=new Date(Math.max(...times));
      const mid=new Date((minT.getTime()+maxT.getTime())/2);
      if(!D.cpStartA.value){D.cpStartA.value=minT.toISOString().slice(0,10);D.cpEndA.value=mid.toISOString().slice(0,10)}
      if(!D.cpStartB.value){D.cpStartB.value=mid.toISOString().slice(0,10);D.cpEndB.value=maxT.toISOString().slice(0,10)}
    }
  }

  try{renderDashGraph()}catch(e){console.error('dashGraph:',e);if(D.dashGraph)D.dashGraph.innerHTML='<p style="color:var(--danger);font-size:0.75rem">'+e.message+'</p>'}
  D.dashGraph.onclick=()=>switchTab('graph');
  try{renderDashPie(svcCounts)}catch(e){console.error('dashPie:',e)}
  try{renderDashHeatmap()}catch(e){console.error('dashHeat:',e)}
  try{renderDashBar(contactCounts)}catch(e){console.error('dashBar:',e)}
}

// ---- Dashboard Graph (mini D3) ----
function renderDashGraph(){
  if(typeof d3==='undefined'){D.dashGraph.innerHTML='<p style="color:var(--danger);font-size:0.75rem">D3.js not loaded</p>';return}
  const sampled=allRows.filter(r=>r.sub&&r.cnt).slice(0,200);
  if(!sampled.length){D.dashGraph.innerHTML='<p style="color:var(--muted);font-size:0.82rem;text-align:center;padding:40px 0">No connections to display</p>';return}
  const rect=D.dashGraph.getBoundingClientRect();
  const w=rect.width||D.dashGraph.clientWidth||400,h=rect.height||D.dashGraph.clientHeight||240;
  D.dashGraph.innerHTML=`<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"></svg>`;
  const svg=d3.select(D.dashGraph).select('svg');
  const linkMap=new Map(),nodeW=new Map();
  sampled.forEach(r=>{const k=[r.sub,r.cnt].join('|');linkMap.set(k,(linkMap.get(k)||0)+1);nodeW.set(r.sub,(nodeW.get(r.sub)||0)+1);nodeW.set(r.cnt,(nodeW.get(r.cnt)||0)+1)});
  const links=[...linkMap.entries()].map(([k,w])=>{const [s,t]=k.split('|');return{source:s,target:t,weight:w}});
  const nodes=[...nodeW.entries()].map(([id,w])=>({id,weight:w}));
  const sim=d3.forceSimulation(nodes).force('link',d3.forceLink(links).id(d=>d.id).distance(60)).force('charge',d3.forceManyBody().strength(-80)).force('center',d3.forceCenter(w/2,h/2)).force('collision',d3.forceCollide(8));
  const link=svg.append('g').selectAll('line').data(links).join('line').attr('stroke','#dccfc0').attr('stroke-width',1);
  const node=svg.append('g').selectAll('circle').data(nodes).join('circle').attr('r',d=>Math.max(3,Math.min(10,d.weight*0.8))).style('fill','var(--accent)').attr('stroke','#fff').attr('stroke-width',1).style('cursor','pointer')
    .on('click',(e,d)=>showProfile(d.id));
  sim.on('tick',()=>{link.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y).attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);node.attr('cx',d=>d.x).attr('cy',d=>d.y)});
}

// ---- Dashboard Pie ----
function renderDashPie(svcCounts){
  if(typeof Chart==='undefined')return;
  const sorted=Object.entries(svcCounts).sort((a,b)=>b[1]-a[1]);
  const labels=sorted.slice(0,8).map(s=>s[0]),data=sorted.slice(0,8).map(s=>s[1]);
  const colors=['#2c6f79','#b94a48','#d4a017','#3a7d5a','#8b5cf6','#ec4899','#f97316','#6b7280'];
  if(window.dashPieChart){try{window.dashPieChart.destroy()}catch(e){}window.dashPieChart=null}
  if(!D.dashPie)return;
  window.dashPieChart=new Chart(D.dashPie,{type:'doughnut',data:{labels,datasets:[{data,backgroundColor:colors,borderWidth:0}]},options:{plugins:{legend:{display:true,position:'right',labels:{boxWidth:12,font:{size:10}}}},responsive:true,maintainAspectRatio:false}});
}

// ---- Dashboard Heatmap ----
function renderDashHeatmap(){
  if(typeof Chart==='undefined')return;
  const hours=Array(24).fill(0);const days=Array(7).fill(0);
  const dayNames=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  allRows.forEach(r=>{if(r.ts){const d=new Date(r.ts);hours[d.getHours()]++;days[d.getDay()]++}});
  if(window.dashHeatChart){try{window.dashHeatChart.destroy()}catch(e){}window.dashHeatChart=null}
  if(!D.dashHeat)return;
  window.dashHeatChart=new Chart(D.dashHeat,{type:'bar',data:{labels:dayNames,datasets:[{label:'Activity',data:days,backgroundColor:days.map(d=>d>Math.max(...days)*0.7?'#b94a48':d>Math.max(...days)*0.4?'#d4a017':'#3a7d5a'),borderRadius:4}]},options:{plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,grid:{}},x:{grid:{display:false}}},responsive:true,maintainAspectRatio:false}});
}

// ---- Dashboard Bar ----
function renderDashBar(contactCounts){
  if(typeof Chart==='undefined')return;
  const sorted=Object.entries(contactCounts).sort((a,b)=>b[1]-a[1]).slice(0,10);
  if(window.dashBarChart){try{window.dashBarChart.destroy()}catch(e){}window.dashBarChart=null}
  if(!D.dashBar)return;
  window.dashBarChart=new Chart(D.dashBar,{type:'bar',data:{labels:sorted.map(s=>s[0].length>12?s[0].slice(0,12)+'...':s[0]),datasets:[{label:'Interactions',data:sorted.map(s=>s[1]),backgroundColor:'#2c6f79',borderRadius:4}]},options:{plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,grid:{}},x:{grid:{display:false}}},responsive:true,maintainAspectRatio:false,onClick:(e,el)=>{if(el.length){const idx=el[0].datasetIndex;const sub=state.subjects.find(s=>sorted[idx]&&s.includes(sorted[idx][0].slice(0,8)));if(sub)showProfile(sub)}}}});
}

// -- Tower Sequence Similarity (Movement Pattern Analysis) --
// Compares the time-ordered tower visits of two subjects using
// a greedy longest-common-subsequence ratio. Returns 0..1.
function towerSequenceSimilarity(subA,subB){
  const rowsA=allRows.filter(r=>(r.sub===subA||r.cnt===subA)&&r.tow&&r.ts).sort((a,b)=>new Date(a.ts)-new Date(b.ts));
  const rowsB=allRows.filter(r=>(r.sub===subB||r.cnt===subB)&&r.tow&&r.ts).sort((a,b)=>new Date(a.ts)-new Date(b.ts));
  if(!rowsA.length||!rowsB.length)return 0;
  const seqA=rowsA.map(r=>r.tow),seqB=rowsB.map(r=>r.tow);
  const m=seqA.length,n=seqB.length;
  // Space-optimized LCS (two rows, O(n) memory)
  let prev=new Uint16Array(n+1),curr=new Uint16Array(n+1);
  for(let i=1;i<=m;i++){
    for(let j=1;j<=n;j++)
      curr[j]=seqA[i-1]===seqB[j-1]?prev[j-1]+1:Math.max(prev[j],curr[j-1]);
    [prev,curr]=[curr,prev];
  }
  return prev[n]/Math.max(m,n,1);
}

// -- Analytics Cache --
window._aiCache=null;
function getAiCache(){
  if(window._aiCache)return window._aiCache;
  const c={};
  // Precompute once, consumed by all AI sections
  c.subCount=state.subjects.length;
  c.totalRows=allRows.length;
  c.pairCounts={};allRows.forEach(r=>{if(r.sub&&r.cnt){const k=[r.sub,r.cnt].sort().join('|');c.pairCounts[k]=(c.pairCounts[k]||0)+1}});
  c.subDays=new Map();allRows.forEach(r=>{if(!r.ts||!r.sub)return;const d=new Date(r.ts).toLocaleDateString();if(!c.subDays.has(r.sub))c.subDays.set(r.sub,new Map());c.subDays.get(r.sub).set(d,(c.subDays.get(r.sub).get(d)||0)+1)});
  c.svcCounts={};allRows.forEach(r=>{const s=r.svc||'Unknown';c.svcCounts[s]=(c.svcCounts[s]||0)+1});
  c.allMeetings=detectMeetings({allPairs:true});
  c.changeCache={};
  state.subjects.slice(0,30).forEach(s=>{c.changeCache[s]=buildIdentityProfile(s).changes});
  window._aiCache=c;
  return c;
}
function invalidateAiCache(){window._aiCache=null}
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
// Scores co-location by: time proximity (primary), repeated encounters (multiplier), service overlap (bonus), movement similarity (bonus)
// Returns {subA, subB, tow, time, gap, gapLevel, score, encounterCount, evidence[]}
const MEET_THRESHOLDS={high:5,medium:15,low:60}; // minutes
function detectMeetings(opts){
  const {subject,rowsA,rowsB,allPairs,maxResults}=opts||{};
  const meetings=[], seen=new Set(), encounterMap=new Map();
  const gapHigh=MEET_THRESHOLDS.high*60000,gapMed=MEET_THRESHOLDS.medium*60000,gapMax=MEET_THRESHOLDS.low*60000;
  const pairSets=[];
  if(allPairs){
    let subList=state.subjects.filter(s=>allRows.some(r=>r.sub===s&&r.ts&&r.tow));
    if(subList.length>30){
      const subRank=subList.map(s=>[s,allRows.filter(r=>r.sub===s&&r.ts&&r.tow).length]).sort((a,b)=>b[1]-a[1]).slice(0,30);
      subList=subRank.map(s=>s[0]);
    }
    for(let i=0;i<subList.length;i++){
      for(let j=i+1;j<subList.length;j++){
        const a=subList[i],b=subList[j];
        const rowsA=allRows.filter(r=>r.sub===a&&r.ts&&r.tow);
        const rowsB=allRows.filter(r=>r.sub===b&&r.ts&&r.tow);
        pairSets.push({a,b,rowsA,rowsB});
      }
    }
  }else if(subject){
    const rowsA=allRows.filter(r=>r.sub===subject&&r.ts&&r.tow);
    const others=new Set(allRows.filter(r=>r.sub!==subject&&r.ts&&r.tow).map(r=>r.sub));
    others.forEach(b=>{
      const rowsB=allRows.filter(r=>r.sub===b&&r.ts&&r.tow);
      pairSets.push({a:subject,b,rowsA,rowsB});
    });
  }else if(rowsA&&rowsB){
    pairSets.push({a:'Subject A',b:'Subject B',rowsA,rowsB});
  }
  pairSets.forEach(({a,b,rowsA,rowsB})=>{
    const pairKey=[a,b].sort().join('::');
    let encCount=0;
    rowsA.forEach(r1=>{
      if(!r1.ts||!r1.tow)return;
      const t1=new Date(r1.ts).getTime();
      rowsB.forEach(r2=>{
        if(r2.tow!==r1.tow||!r2.ts)return;
        const t2=new Date(r2.ts).getTime();
        const gap=Math.abs(t2-t1);
        if(gap>=gapMax)return;
        const key=[a,b,r1.tow,Math.min(t1,t2)].sort().join('|');
        if(seen.has(key))return;seen.add(key);
        encCount++;
        const gapMin=Math.round(gap/60000);
        const gapLevel=gap<=gapHigh?'high':gap<=gapMed?'medium':'low';
        // Score: base from gap, multiplied by encounter count, plus service bonus for same svc
        let baseScore=gap<=gapHigh?80:gap<=gapMed?50:20;
        const sameService=r1.svc&&r2.svc&&r1.svc===r2.svc;
        if(sameService)baseScore+=10;
        const evidence=[];
        evidence.push('Time gap: '+gapMin+'m ('+gapLevel+')');
        if(sameService)evidence.push('Same service: '+r1.svc);
        meetings.push({subA:a,subB:b,tow:r1.tow,time:new Date(Math.min(t1,t2)),gap:gapMin,gapLevel,
          score:baseScore,encounterCount:0,
          subAEvent:(r1.type||'')+(r1.svc?' '+r1.svc:''),
          subBEvent:(r2.type||'')+(r2.svc?' '+r2.svc:''),
          evidence
        });
      });
    });
    encounterMap.set(pairKey,encCount);
  });
  // Apply encounter multiplier: more encounters = higher confidence
  meetings.forEach(m=>{
    const pk=[m.subA,m.subB].sort().join('::');
    m.encounterCount=encounterMap.get(pk)||1;
    m.score=Math.min(100,m.score+Math.min(encounterMap.get(pk)||1,10)*2);
  });
  // Apply movement similarity bonus: similar tower paths ? higher confidence
  const movSimCache=new Map();
  meetings.forEach(m=>{
    const key=[m.subA,m.subB].sort().join('|');
    if(!movSimCache.has(key)){
      movSimCache.set(key,towerSequenceSimilarity(m.subA,m.subB));
    }
    const sim=movSimCache.get(key);
    if(sim>0.3){m.score+=Math.round(sim*15);m.evidence.push('Movement similarity: '+(sim*100).toFixed(0)+'% tower path overlap')}
  });
  meetings.sort((a,b)=>b.score-a.score);
  return maxResults?meetings.slice(0,maxResults):meetings;
}

// ====== INVESTIGATION SUMMARY ======
function renderCaseSummary(){
  if(!allRows.length){D.csGrid.innerHTML='<div style="font-size:0.75rem;color:var(--muted);grid-column:1/-1">Load data to generate case summary.</div>';D.csMeta.textContent='';return}
  // Gather stats
  const totalSubjects=state.subjects.length;
  const totalCdr=state.cdr.length,totalIpdr=state.ipdr.length;
  const towerCount=state.towers.length;
  // Most active subject
  const subCounts={};allRows.forEach(r=>{if(r.sub)subCounts[r.sub]=(subCounts[r.sub]||0)+1});
  const topSub=Object.entries(subCounts).sort((a,b)=>b[1]-a[1])[0];
  // Most used service (attributed)
  const svcCounts={};allRows.forEach(r=>{const s=recordSvcAttr(r)||r.svc||'Unknown';svcCounts[s]=(svcCounts[s]||0)+1});
  const topSvc=Object.entries(svcCounts).sort((a,b)=>b[1]-a[1])[0];
  // Most common tower
  const towCounts={};allRows.forEach(r=>{if(r.tow)towCounts[r.tow]=(towCounts[r.tow]||0)+1});
  const topTow=Object.entries(towCounts).sort((a,b)=>b[1]-a[1])[0];
  // Contacts
  const allCnts=new Set(allRows.map(r=>r.cnt).filter(Boolean));
  // Time span
  const times=allRows.filter(r=>r.ts).map(r=>new Date(r.ts));
  const span=times.length?Math.round((Math.max(...times)-Math.min(...times))/86400000)+' days':'n/a';
  // Meetings via unified engine
  const allMeetings=detectMeetings({allPairs:true});
  const meetingsHigh=allMeetings.filter(m=>m.gapLevel==='high').length;
  const meetingsMed=allMeetings.filter(m=>m.gapLevel==='medium').length;
  const meetingsLow=allMeetings.filter(m=>m.gapLevel==='low').length;
  const meetingsTotal=allMeetings.length;
  // Communication direction
  const dirCounts={mo:0,mt:0};allRows.forEach(r=>{if(r.dir==='MO'||r.dir==='mo')dirCounts.mo++;else if(r.dir==='MT'||r.dir==='mt')dirCounts.mt++});
  // Burst count
  const subDays=new Map();
  allRows.forEach(r=>{if(!r.ts||!r.sub)return;const d=new Date(r.ts).toLocaleDateString();if(!subDays.has(r.sub))subDays.set(r.sub,new Map());subDays.get(r.sub).set(d,(subDays.get(r.sub).get(d)||0)+1)});
  let bursts=0;
  subDays.forEach((days,sub)=>{const counts=[...days.values()];if(counts.length<3)return;const avg=counts.reduce((a,c)=>a+c,0)/counts.length;days.forEach((c,d)=>{if(c>=Math.max(avg*3,10))bursts++})});

  D.csGrid.innerHTML=[
    {l:'Subjects',v:n(totalSubjects),sub:''},
    {l:'Records',v:n(totalCdr+totalIpdr),sub:n(totalCdr)+' CDR & '+n(totalIpdr)+' IPDR'},
    {l:'Towers',v:n(towerCount),sub:''},
    {l:'Contacts',v:n(allCnts.size),sub:span},
    {l:'Most Active',v:topSub?esc(topSub[0]):'n/a',sub:topSub?topSub[1]+' records':''},
    {l:'Top Service',v:topSvc?esc(topSvc[0]):'n/a',sub:topSvc?topSvc[1]+' records':''},
    {l:'Top Tower',v:topTow?esc(topTow[0]):'n/a',sub:topTow?topTow[1]+' visits':''},
    {l:'Meetings',v:n(meetingsTotal),sub:meetingsTotal?'<span style="color:var(--success)">'+n(meetingsHigh)+' high</span> — <span style="color:var(--warn)">'+n(meetingsMed)+' med</span> — <span style="color:var(--muted)">'+n(meetingsLow)+' low</span> confidence':'Potential co-locations'},
    {l:'Comm. Direction',v:dirCounts.mo||dirCounts.mt?n(dirCounts.mo)+'MO / '+n(dirCounts.mt)+'MT':'n/a',sub:''},
    {l:'Activity Spikes',v:n(bursts),sub:'Anomalous days'},
    {l:'Case Span',v:span,sub:times.length?new Date(Math.min(...times)).toLocaleDateString()+' — '+new Date(Math.max(...times)).toLocaleDateString():''},
  ].map(c=>`<div class="cs-item"><div class="cs-label">${c.l}</div><div class="cs-value">${c.v}</div>${c.sub?'<div class="cs-sub">'+c.sub+'</div>':''}</div>`).join('');
  D.csMeta.textContent=`${totalSubjects} subjects — ${totalCdr+totalIpdr} records — ${allCnts.size} contacts — ${span}`;
}

// ====== COMPARE PERIODS ======
function runComparePeriods(){
  const sA=D.cpStartA.value,eA=D.cpEndA.value,sB=D.cpStartB.value,eB=D.cpEndB.value;
  if(!sA||!eA||!sB||!eB){D.cpStatus.textContent='Select both date ranges.';return}
  const tMinA=new Date(sA).getTime(),tMaxA=new Date(eA).getTime()+86400000;
  const tMinB=new Date(sB).getTime(),tMaxB=new Date(eB).getTime()+86400000;
  const rowsA=allRows.filter(r=>r.ts&&new Date(r.ts).getTime()>=tMinA&&new Date(r.ts).getTime()<tMaxA);
  const rowsB=allRows.filter(r=>r.ts&&new Date(r.ts).getTime()>=tMinB&&new Date(r.ts).getTime()<tMaxB);
  if(!rowsA.length&&!rowsB.length){D.cpResults.innerHTML='<div style="color:var(--muted)">No records in either selected range.</div>';D.cpResults.style.display='block';return}
  // Contacts per period
  const cntsA=new Set(rowsA.map(r=>r.cnt).filter(Boolean));
  const cntsB=new Set(rowsB.map(r=>r.cnt).filter(Boolean));
  const sharedCnts=[...cntsA].filter(c=>cntsB.has(c));
  const newCnts=[...cntsB].filter(c=>!cntsA.has(c));
  const lostCnts=[...cntsA].filter(c=>!cntsB.has(c));
  // Towers per period
  const towsA=new Set(rowsA.map(r=>r.tow).filter(Boolean));
  const towsB=new Set(rowsB.map(r=>r.tow).filter(Boolean));
  const newTows=[...towsB].filter(t=>!towsA.has(t));
  // Service usage per period
  const svcA={};rowsA.forEach(r=>{const s=recordSvcAttr(r)||r.svc||'Unknown';svcA[s]=(svcA[s]||0)+1});
  const svcB={};rowsB.forEach(r=>{const s=recordSvcAttr(r)||r.svc||'Unknown';svcB[s]=(svcB[s]||0)+1});
  const allSvcs=new Set([...Object.keys(svcA),...Object.keys(svcB)]);
  const svcDeltas=[...allSvcs].map(s=>{
    const vA=svcA[s]||0,vB=svcB[s]||0;
    return {name:s,from:vA,to:vB,delta:vB-vA,pct:vA?Math.round((vB-vA)/vA*100):(vB?100:0)};
  }).sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta)).slice(0,8);
  // Volume
  const volPct=rowsA.length?Math.round((rowsB.length-rowsA.length)/rowsA.length*100):(rowsB.length?100:0);
  // Subjects
  const subsA=new Set(rowsA.map(r=>r.sub).filter(Boolean));
  const subsB=new Set(rowsB.map(r=>r.sub).filter(Boolean));
  const newSubs=[...subsB].filter(s=>!subsA.has(s));

  let html='<div style="font-weight:600;margin-bottom:8px">Period A: '+sA+' — '+eA+' ('+rowsA.length+' records) &nbsp;?&nbsp; Period B: '+sB+' — '+eB+' ('+rowsB.length+' records)</div>';
  html+=`<div class="cp-delta-grid">
    <div class="cp-delta-card"><div class="cp-label">Volume Change</div><div class="cp-val ${volPct>0?'pos':'neg'}">${volPct>0?'+':''}${volPct}%</div><div class="cp-detail">${rowsA.length} ? ${rowsB.length} records</div></div>
    <div class="cp-delta-card"><div class="cp-label">New Contacts</div><div class="cp-val pos">+${newCnts.length}</div><div class="cp-detail">${lostCnts.length} lost, ${sharedCnts.length} shared</div></div>
    <div class="cp-delta-card"><div class="cp-label">New Subjects</div><div class="cp-val pos">+${newSubs.length}</div><div class="cp-detail">Period B has ${subsB.size} subjects</div></div>
    <div class="cp-delta-card"><div class="cp-label">New Towers</div><div class="cp-val pos">+${newTows.length}</div><div class="cp-detail">${newTows.slice(0,5).join(', ')}${newTows.length>5?'...':''}</div></div>
  </div>`;
  if(svcDeltas.length){
    html+='<div style="font-weight:600;margin:10px 0 6px">Service Usage Change</div><div class="cp-delta-grid">';
    svcDeltas.forEach(s=>{
      const c=svcColor(s.name);
      html+=`<div class="cp-delta-card"><div class="cp-label"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c};margin-right:4px"></span>${esc(s.name)}</div>
        <div class="cp-val ${s.delta>0?'pos':'neg'}">${s.delta>0?'+':''}${s.delta} (${s.pct>0?'+':''}${s.pct}%)</div>
        <div class="cp-detail">${s.from} ? ${s.to}</div></div>`;
    });
    html+='</div>';
  }
  D.cpResults.innerHTML=html;D.cpResults.style.display='block';
  D.cpStatus.textContent='Compared '+sA+'—'+eA+' vs '+sB+'—'+eB;
}
// Wire up Compare Periods
D.cpGoBtn.addEventListener('click',runComparePeriods);
D.cpCloseBtn.addEventListener('click',()=>{D.cpResults.style.display='none';D.cpStatus.textContent=''});

// ====== 2. NETWORK GRAPH (D3) ======
let curGraphNodes=null,curGraphLinks=null,curGraphSim=null,curCentrality=null;
function renderGraph(){
  if(!allRows.length)return;
  D.graphSvg.innerHTML='<svg width="100%" height="100%"></svg>';
  const svg=d3.select(D.graphSvg).select('svg'),w=D.graphSvg.clientWidth||800,h=D.graphSvg.clientHeight||500;
  const links=[],nodesMap=new Map();
  const subject=D.graphSubject.value;
  const rows=subject?rowsFor(subject):allRows.filter(r=>r.sub&&r.cnt);
  const linkMap=new Map();
  rows.forEach(r=>{const k=[r.sub,r.cnt].sort().join('|');linkMap.set(k,(linkMap.get(k)||0)+1)});
  const sorted=[...linkMap.entries()].sort((a,b)=>b[1]-a[1]);
  const top=sorted.slice(0,subject?500:150);
  top.forEach(([k,w])=>{const [s,t]=k.split('|');links.push({key:k,source:s,target:t,weight:w});nodesMap.set(s,(nodesMap.get(s)||0)+w);nodesMap.set(t,(nodesMap.get(t)||0)+w)});
  const nodes=[...nodesMap.entries()].map(([id,w])=>({id,weight:w}));
  D.graphStats.textContent=`${nodes.length} nodes, ${links.length} links (top ${subject?'all':'150'})`;

  // -- Centrality (Degree only — real betweenness/closeness requires shortest-path traversal) --
  const degree=new Map();nodes.forEach(n=>degree.set(n.id,0));
  links.forEach(l=>{degree.set(l.source.id||l.source,(degree.get(l.source.id||l.source)||0)+1);degree.set(l.target.id||l.target,(degree.get(l.target.id||l.target)||0)+1)});
  const sortedDeg=[...degree.entries()].sort((a,b)=>b[1]-a[1]);
  curCentrality={degree:sortedDeg.slice(0,10)};

  const zoom=d3.zoom().scaleExtent([0.2,8]).on('zoom',e=>g.attr('transform',e.transform));
  svg.call(zoom);

  const g=svg.append('g');
  const sim=d3.forceSimulation(nodes).force('link',d3.forceLink(links).id(d=>d.id).distance(80)).force('charge',d3.forceManyBody().strength(-150)).force('center',d3.forceCenter(w/2,h/2)).force('collision',d3.forceCollide(12));
  curGraphNodes=nodes;curGraphLinks=links;curGraphSim=sim;

  const link=g.append('g').selectAll('line').data(links).join('line').attr('stroke','#dccfc0').attr('stroke-width',d=>Math.max(0.5,Math.min(6,d.weight*0.5))).attr('stroke-opacity',0.6);
  const node=g.append('g').selectAll('circle').data(nodes).join('circle').attr('r',d=>Math.max(4,Math.min(16,d.weight*0.2))).style('fill',d=>d.id===subject?'#b94a48':'var(--accent)').attr('stroke','#fff').attr('stroke-width',1.5).style('cursor','pointer')
    .on('click',(e,d)=>{showProfile(d.id)})
    .on('mouseover',(e,d)=>{
      const deg=curCentrality?curCentrality.degree.find(x=>x[0]===d.id):null;
      D.graphDetails.innerHTML=`<strong>${esc(d.id)}</strong><br>
        Connections: ${links.filter(l=>(l.source.id||l.source)===d.id||(l.target.id||l.target)===d.id).length}<br>
        ${deg?`Degree: ${deg[1]}<br>`:''}<button class="btn btn-sm" onclick="showSubjectRecords('${esc(d.id)}')" style="font-size:0.65rem;margin-top:4px">View Records</button>`
    })
    .call(d3.drag().on('start',(e,d)=>{if(!e.active)sim.alphaTarget(0.3).restart();d.fx=d.x;d.fy=d.y}).on('drag',(e,d)=>{d.fx=e.x;d.fy=e.y}).on('end',(e,d)=>{if(!e.active)sim.alphaTarget(0);d.fx=null;d.fy=null}));

  const label=g.append('g').selectAll('text').data(nodes).join('text').text(d=>d.id.length>12?d.id.slice(0,12)+'...':d.id).attr('font-size','9').attr('dx',d=>Math.max(5,d.weight*0.2+5))   .attr('dy',3).attr('class','graph-label').style('pointer-events','none');

  sim.on('tick',()=>{link.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y).attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);node.attr('cx',d=>d.x).attr('cy',d=>d.y);label.attr('x',d=>d.x).attr('y',d=>d.y)});

  // Search
  D.graphSearch._handler&&D.graphSearch.removeEventListener('input',D.graphSearch._handler);
  D.graphSearch._handler=()=>{
    const q=D.graphSearch.value.trim().toLowerCase();
    node.attr('opacity',d=>!q||d.id.toLowerCase().includes(q)?1:0.1);
    link.attr('opacity',d=>!q||(d.source.id||d.source).toLowerCase().includes(q)||(d.target.id||d.target).toLowerCase().includes(q)?0.4:0.05);
  };
  D.graphSearch.addEventListener('input',D.graphSearch._handler);
}
D.graphReset.addEventListener('click',()=>location.reload());
D.graphCenter.addEventListener('click',()=>{const svg=d3.select(D.graphSvg).select('svg');svg.transition().duration(500).call(d3.zoom().transform,d3.zoomIdentity)});

function initGraphSubjects(){
  D.graphSubject.innerHTML='<option value="">All subjects</option>'+state.subjects.map(s=>`<option value="${esc(s)}">${esc(s)}</option>`).join('');
  if(D.graphSubject._handler)D.graphSubject.removeEventListener('change',D.graphSubject._handler);
  D.graphSubject._handler=renderGraph;
  D.graphSubject.addEventListener('change',D.graphSubject._handler);
}

// ====== 3. TOWER MAP (Leaflet) ======
let mapInstance=null,mapLayers=[],mapMarkers=[],mapPolyline=null,mapCircles=[],mapTimeData=[],mapTimePlaying=false,geofenceDrawn=null;
async function initMap(){
  if(!state.geoRecords)await loadGeoData();
  if(!mapInstance){
    mapInstance=L.map(D.mapStage,{zoomControl:true}).setView([20.5937,78.9629],5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'&copy; OpenStreetMap',maxZoom:18}).addTo(mapInstance);
    setTimeout(()=>mapInstance.invalidateSize(),100);
    initGeofenceListeners();
  }
  runMapMode();
}
let geoRecords=[],geoSubjects=[];
async function loadGeoData(){
  const cq=activeCaseId?'?case_id='+activeCaseId:'';
  try{const[recs,subs]=await Promise.all([API.get('/geo/records'+cq),API.get('/geo/subjects'+cq)]);geoRecords=recs;geoSubjects=subs;state.geoRecords=recs;populateMapSubjects()}catch(e){console.error(e)}
}
function populateMapSubjects(){
  const dl=document.getElementById('mapSubjectList');
  if(dl)dl.innerHTML=geoSubjects.map(s=>`<option value="${esc(s)}"></option>`).join('');
}
function clearMap(){
  mapLayers.forEach(l=>mapInstance.removeLayer(l));mapMarkers.forEach(m=>mapInstance.removeLayer(m));mapCircles.forEach(c=>mapInstance.removeLayer(c));
  if(mapPolyline){mapInstance.removeLayer(mapPolyline);mapPolyline=null}
  mapLayers=[];mapMarkers=[];mapCircles=[];
}
function geoSub(sub){if(!sub)return geoRecords;return geoRecords.filter(r=>r.subject===sub||r.counterpart===sub||r.msisdn===sub)}
function popupHtml(r){
  let h='<div style="min-width:140px;line-height:1.5;font-size:0.8rem">';
  h+=`<b>${esc(r.type)}</b><br>`;if(r.subject)h+=`<b>Subject:</b> ${esc(r.subject)}<br>`;if(r.counterpart)h+=`<b>Counterpart:</b> ${esc(r.counterpart)}<br>`;
  h+=`<b>Time:</b> ${fmt(r.start_time)}<br>`;if(r.duration_seconds!=null)h+=`<b>Duration:</b> ${r.duration_seconds}s<br>`;
  if(r.call_type)h+=`<b>Type:</b> ${esc(r.call_type)}<br>`;if(r.direction)h+=`<b>Direction:</b> ${esc(r.direction)}<br>`;
  if(r.protocol)h+=`<b>Protocol:</b> ${esc(r.protocol)}<br>`;if(r.msisdn)h+=`<b>MSISDN:</b> ${esc(r.msisdn)}<br>`;
  if(r.tower_id)h+=`<b>Tower:</b> ${esc(r.tower_id)}<br>`;if(r.tower&&r.tower.city)h+=`<b>Location:</b> ${esc(r.tower.city)}<br>`;
  if(r.bytes_uploaded!=null)h+=`<b>Up:</b> ${n(r.bytes_uploaded)} bytes<br>`;if(r.bytes_downloaded!=null)h+=`<b>Down:</b> ${n(r.bytes_downloaded)} bytes<br>`;
  h+='</div>';return h;
}
function runMapMode(){
  const sub=D.mapSubject.value,mode=D.mapMode.value;
  D.mapTimeBar.style.display='none';
  // Inference overlays: impossible-travel and co-presence are network-wide (work with
  // no subject selected, or filtered to one); anchors need a subject.
  if(mode==='inf_impossible')return showMapImpossible(sub);
  if(mode==='inf_copresence')return showMapCopresence(sub);
  if(mode==='inf_anchors'){
    if(!sub){D.mapAnalysis.innerHTML='<p style="color:var(--muted);font-size:0.85rem">Select a subject to see their home/work anchors.</p>';return}
    return showMapAnchors(sub);
  }
  if(!sub){D.mapAnalysis.innerHTML='<p style="color:var(--muted);font-size:0.85rem">Select a subject.</p>';return}
  if(mode==='path')showMapPath(sub);
  else if(mode==='heat')showMapHeat(sub);
  else if(mode==='zones')showMapZones(sub);
  else if(mode==='colocation')showMapColocation(sub);
  else if(mode==='triangulation')showMapTriangulation(sub);
  else if(mode==='meetings')showMapMeetings(sub);
}
// Tower id -> coordinates, derived from the loaded geo records (inferences reference
// towers by id; this resolves them to points to draw).
function towerCoords(){
  const m={};
  geoRecords.forEach(r=>{if(r.tower_id&&r.latitude!=null&&r.longitude!=null&&!m[r.tower_id])m[r.tower_id]={lat:r.latitude,lng:r.longitude};});
  return m;
}
async function showMapImpossible(sub){
  clearMap();
  let rep;try{rep=await getInfReport();}catch(e){D.mapAnalysis.innerHTML='<p style="color:var(--danger)">Failed to load inferences.</p>';return;}
  const tc=towerCoords();
  let legs=(rep.cdr&&rep.cdr.impossible_travel)||[];
  if(sub)legs=legs.filter(l=>l.subject===sub);
  const cloneBy={};((rep.cdr&&rep.cdr.clone_corroboration)||[]).forEach(c=>cloneBy[c.subject]=c);
  if(!legs.length){D.mapAnalysis.innerHTML='<p style="color:var(--muted)">No impossible-travel legs'+(sub?' for this subject':'')+'.</p>';return;}
  const bounds=[];
  legs.forEach(l=>{
    const a=tc[l.from_tower],b=tc[l.to_tower];if(!a||!b)return;
    const line=L.polyline([[a.lat,a.lng],[b.lat,b.lng]],{color:'#b94a48',weight:3,opacity:0.85,dashArray:'7,6'}).addTo(mapInstance);
    line.bindPopup('<b>Impossible travel</b><br>'+esc(l.subject)+'<br><b>'+(l.speed_kmh!=null?Math.round(l.speed_kmh)+' km/h':'same minute (∞)')+'</b><br>'+l.distance_km+' km in '+l.dt_minutes+' min'+(l.from_imei!==l.to_imei?'<br>IMEI changed':'')+(cloneBy[l.subject]?'<br>⚠ '+esc(cloneBy[l.subject].verdict):''));
    mapLayers.push(line);
    [[a,l.from_tower],[b,l.to_tower]].forEach(p=>{const mk=L.circleMarker([p[0].lat,p[0].lng],{radius:7,color:'#fff',weight:2,fillColor:'#b94a48',fillOpacity:0.9}).addTo(mapInstance);mk.bindTooltip(esc(p[1]),{direction:'top'});mapMarkers.push(mk);bounds.push([p[0].lat,p[0].lng]);});
  });
  if(bounds.length)mapInstance.fitBounds(bounds,{padding:[60,60]});
  let h='<h4 style="margin:0 0 6px;color:var(--danger)">Impossible Travel</h4><div style="font-size:0.7rem;color:var(--muted);margin-bottom:6px">Red dashed legs exceed human travel speed (likely clone / spoofed record).</div>';
  legs.forEach(l=>{h+='<div class="evt" onclick="showProfile(\''+esc(l.subject)+'\')"><span class="evt-time">'+esc(l.subject)+'</span><span class="evt-loc" style="color:var(--danger)">'+(l.speed_kmh!=null?Math.round(l.speed_kmh)+' km/h':'∞')+'</span></div>';});
  D.mapAnalysis.innerHTML=h;
}
async function showMapCopresence(sub){
  clearMap();
  let rep;try{rep=await getInfReport();}catch(e){D.mapAnalysis.innerHTML='<p style="color:var(--danger)">Failed to load inferences.</p>';return;}
  const tc=towerCoords();
  let pairs=((rep.cdr&&rep.cdr.co_presence)||[]).filter(c=>c.convoy||c.hidden_link);
  if(sub)pairs=pairs.filter(c=>c.subject_a===sub||c.subject_b===sub);
  if(!pairs.length){D.mapAnalysis.innerHTML='<p style="color:var(--muted)">No convoy / hidden-link pairs'+(sub?' for this subject':'')+'.</p>';return;}
  const bounds=[];
  pairs.forEach(c=>{
    const col=c.hidden_link?'#b94a48':'#d4a017';
    (c.towers||[]).forEach(tw=>{
      const base=String(tw).split('~')[0];const pt=tc[base];if(!pt)return;
      const mk=L.circleMarker([pt.lat,pt.lng],{radius:9,color:'#fff',weight:2,fillColor:col,fillOpacity:0.85}).addTo(mapInstance);
      mk.bindPopup('<b>'+(c.hidden_link?'Hidden link (met, never called)':'Convoy')+'</b><br>'+esc(c.subject_a)+' &amp; '+esc(c.subject_b)+'<br>'+c.occurrences+'× over '+c.distinct_days+' day(s)<br>'+(c.ever_called?'they also call each other':'never call each other')+'<br>Tower '+esc(base));
      mapMarkers.push(mk);bounds.push([pt.lat,pt.lng]);
    });
  });
  if(bounds.length)mapInstance.fitBounds(bounds,{padding:[60,60]});
  let h='<h4 style="margin:0 0 6px;color:var(--warn)">Co-presence</h4><div style="font-size:0.7rem;color:var(--muted);margin-bottom:6px">Amber = convoy (repeated co-location). Red = hidden link (co-located but never call).</div>';
  pairs.forEach(c=>{h+='<div class="evt"><span class="evt-time">'+esc(c.subject_a)+' &amp; '+esc(c.subject_b)+'</span><span class="evt-loc" style="color:'+(c.hidden_link?'var(--danger)':'var(--warn)')+'">'+(c.hidden_link?'hidden':'convoy')+' ('+c.distinct_days+'d)</span></div>';});
  D.mapAnalysis.innerHTML=h;
}
async function showMapAnchors(sub){
  clearMap();
  let rep;try{rep=await getInfReport();}catch(e){D.mapAnalysis.innerHTML='<p style="color:var(--danger)">Failed to load inferences.</p>';return;}
  const mv=((rep.cdr&&rep.cdr.movement)||{})[sub];
  if(!mv||!mv.anchors){D.mapAnalysis.innerHTML='<p style="color:var(--muted)">No anchors for this subject.</p>';return;}
  const bounds=[];
  geoSub(sub).filter(r=>r.latitude!=null&&r.longitude!=null).forEach(r=>{const mk=L.circleMarker([r.latitude,r.longitude],{radius:3,color:'#888',weight:1,fillColor:'#888',fillOpacity:0.35}).addTo(mapInstance);mapMarkers.push(mk);bounds.push([r.latitude,r.longitude]);});
  const place=(anchor,label,color)=>{
    if(!anchor||anchor.latitude==null)return;
    const mk=L.circleMarker([anchor.latitude,anchor.longitude],{radius:12,color:'#fff',weight:3,fillColor:color,fillOpacity:0.92}).addTo(mapInstance);
    mk.bindPopup('<b>'+label+'</b><br>'+esc(sub)+'<br>Tower '+esc(anchor.tower_id)+'<br>'+anchor.events+' events');
    mk.bindTooltip(label,{permanent:true,direction:'top'});mapMarkers.push(mk);bounds.push([anchor.latitude,anchor.longitude]);
  };
  place(mv.anchors.home,'Home','#2c6f79');
  place(mv.anchors.work,'Work','#2d7d46');
  if(bounds.length)mapInstance.fitBounds(bounds,{padding:[50,50]});
  let h='<h4 style="margin:0 0 6px">Anchors — '+esc(sub)+'</h4>';
  h+='<div class="stat-row"><span class="label">Home tower</span><span class="value">'+esc(mv.anchors.home?mv.anchors.home.tower_id:'?')+'</span></div>';
  h+='<div class="stat-row"><span class="label">Work tower</span><span class="value">'+esc(mv.anchors.work?mv.anchors.work.tower_id:'?')+'</span></div>';
  h+='<div class="stat-row"><span class="label">Distinct towers</span><span class="value">'+mv.distinct_towers+'</span></div>';
  h+='<div class="stat-row"><span class="label">Max leg</span><span class="value">'+mv.max_leg_km+' km</span></div>';
  if(mv.impossible_travel&&mv.impossible_travel.length)h+='<div class="stat-row"><span class="label" style="color:var(--danger)">Impossible legs</span><span class="value" style="color:var(--danger)">'+mv.impossible_travel.length+'</span></div>';
  D.mapAnalysis.innerHTML=h;
}
D.mapGo.addEventListener('click',runMapMode);
D.mapMode.addEventListener('change',runMapMode);
D.mapSubject.addEventListener('change',()=>{if(D.mapSubject.value)runMapMode()});
// Run immediately when a complete subject is typed or picked from the suggestions.
D.mapSubject.addEventListener('input',()=>{if(geoSubjects.includes(D.mapSubject.value))runMapMode()});
D.mapFit.addEventListener('click',()=>{const pts=[];geoRecords.forEach(r=>{if(r.latitude!=null&&r.longitude!=null)pts.push([r.latitude,r.longitude])});if(pts.length)mapInstance.fitBounds(pts,{padding:[30,30]})});

// -- Geofence --
let geoFenceLayer=null,geoFenceDrawn=false,geoFenceDrawing=false,geoFenceDrawHandler=null,geoFenceMarkers=[];
D.geoFenceBtn.addEventListener('click',()=>{
  if(!mapInstance)return;
  if(geoFenceDrawn){
    mapInstance.removeLayer(geoFenceLayer);geoFenceLayer=null;geoFenceDrawn=false;
    clearGeofenceHighlights();
    D.mapAnalysis.innerHTML='<p style="color:var(--muted);font-size:0.85rem">Geofence cleared.</p>';
    D.geoFenceBtn.textContent='Geofence';D.geoFenceBtn.style.borderColor='var(--danger)';D.geoFenceBtn.style.color='var(--danger)';
    return;
  }
  if(geoFenceDrawing){
    if(geoFenceDrawHandler)geoFenceDrawHandler.disable();
    geoFenceDrawing=false;
    D.geoFenceBtn.textContent='Geofence';D.geoFenceBtn.style.borderColor='var(--danger)';D.geoFenceBtn.style.color='var(--danger)';
    return;
  }
  geoFenceDrawHandler=new L.Draw.Polygon(mapInstance,{shapeOptions:{color:'#b94a48',weight:2},allowIntersection:false,showArea:true,metric:true});
  geoFenceDrawHandler.enable();
  geoFenceDrawing=true;
  D.geoFenceBtn.textContent='Cancel';D.geoFenceBtn.style.borderColor='var(--warn)';D.geoFenceBtn.style.color='var(--warn)';
});
function initGeofenceListeners(){
  mapInstance.off('draw:created');
  mapInstance.on('draw:created',function(e){
    if(geoFenceDrawing){
      if(geoFenceDrawHandler)geoFenceDrawHandler.disable();
      geoFenceDrawing=false;
    }
    if(geoFenceLayer)mapInstance.removeLayer(geoFenceLayer);
    geoFenceLayer=e.layer;geoFenceDrawn=true;
    mapInstance.addLayer(geoFenceLayer);
    D.geoFenceBtn.textContent='Clear Fence';D.geoFenceBtn.style.borderColor='var(--success)';D.geoFenceBtn.style.color='var(--success)';
    analyzeGeofence();
  });
}
function clearGeofenceHighlights(){
  geoFenceMarkers.forEach(m=>{try{mapInstance.removeLayer(m)}catch(e){}});
  geoFenceMarkers=[];
}
// Find every loaded geo record inside the drawn polygon, summarise the subjects/towers
// present, and highlight the points on the map.
function analyzeGeofence(){
  if(!geoFenceLayer){return;}
  clearGeofenceHighlights();
  const fencePts=geoFenceLayer.getLatLngs();
  const ring=Array.isArray(fencePts[0])?fencePts[0]:fencePts;
  if(!ring||ring.length<3){D.mapAnalysis.innerHTML='<p style="color:var(--muted)">Draw a closed area.</p>';return;}
  const coords=ring.map(p=>[p.lng,p.lat]);
  coords.push(coords[0]); // close the ring for turf
  const poly=turf.polygon([coords]);
  const inside=(geoRecords||[]).filter(r=>r.latitude!=null&&r.longitude!=null&&turf.booleanPointInPolygon(turf.point([r.longitude,r.latitude]),poly));
  if(!inside.length){D.mapAnalysis.innerHTML='<h4 style="margin:0 0 6px">Geofence</h4><p style="color:var(--muted)">No records inside the drawn area.</p>';return;}
  // Group by subject (phone number where available), collect towers + time span.
  const bySub={},towers=new Set();let tMin=null,tMax=null;
  inside.forEach(r=>{
    const key=r.msisdn||r.subject||'unknown';
    if(!bySub[key])bySub[key]={count:0,cdr:0,ipdr:0,towers:new Set()};
    const g=bySub[key];g.count++;g[r.type==='IPDR'?'ipdr':'cdr']++;
    if(r.tower_id)g.towers.add(r.tower_id);
    if(r.tower_id)towers.add(r.tower_id);
    if(r.start_time){if(!tMin||r.start_time<tMin)tMin=r.start_time;if(!tMax||r.start_time>tMax)tMax=r.start_time;}
    const col=r.type==='IPDR'?'#2d7d46':'#b94a48';
    const mk=L.circleMarker([r.latitude,r.longitude],{radius:5,color:'#fff',weight:1,fillColor:col,fillOpacity:0.85}).addTo(mapInstance);
    mk.bindPopup(popupHtml(r));geoFenceMarkers.push(mk);
  });
  const subs=Object.entries(bySub).sort((a,b)=>b[1].count-a[1].count);
  let h='<h4 style="margin:0 0 6px">Geofence — '+subs.length+' subject'+(subs.length>1?'s':'')+'</h4>';
  h+='<div class="stat-row"><span class="label">Records inside</span><span class="value">'+n(inside.length)+'</span></div>';
  h+='<div class="stat-row"><span class="label">Distinct towers</span><span class="value">'+towers.size+'</span></div>';
  if(tMin)h+='<div class="stat-row"><span class="label">Time span</span><span class="value" style="font-size:0.7rem">'+fmt(tMin)+' → '+fmt(tMax)+'</span></div>';
  h+='<h4 style="margin:10px 0 4px">Subjects in area</h4>';
  subs.forEach(e=>{
    const g=e[1];
    h+='<div class="evt" onclick="showProfile(\''+esc(e[0])+'\')"><span class="evt-time">'+esc(e[0])+'</span>'
      +'<span class="evt-loc">'+g.count+' ('+g.cdr+'C/'+g.ipdr+'I) · '+g.towers.size+' twr</span></div>';
  });
  D.mapAnalysis.innerHTML=h;
}

// Travel mode -> colour/label, used to grade each path leg by estimated speed.
const MODE_STYLE={
  'stationary':{color:'#9aa0a6',dash:'1,6',label:'Stationary / dwell'},
  'walking':{color:'#2d7d46',label:'Walking'},
  'local road':{color:'#1f9d8f',label:'Local road'},
  'road / highway':{color:'#2563eb',label:'Road / highway'},
  'rail / expressway':{color:'#7c3aed',label:'Rail / expressway'},
  'air':{color:'#d4a017',label:'Air'},
  'impossible':{color:'#b94a48',label:'Impossible'},
  'unknown':{color:'#9aa0a6',dash:'3,5',label:'Unknown gap'}
};
// Speed (km/h) -> plausible travel mode, mirroring the backend geo.classify_speed bands.
function travelMode(kmh){
  if(kmh==null)return null;
  if(kmh<=3)return 'stationary';if(kmh<=12)return 'walking';if(kmh<=45)return 'local road';
  if(kmh<=120)return 'road / highway';if(kmh<=250)return 'rail / expressway';if(kmh<=900)return 'air';
  return 'impossible';
}
function fmtGap(sec){
  if(sec==null)return '?';const s=Math.abs(sec);
  if(s<60)return Math.round(s)+'s';if(s<3600)return Math.round(s/60)+' min';
  if(s<86400)return (s/3600).toFixed(1)+' h';return (s/86400).toFixed(1)+' d';
}
// Initial compass bearing a->b, for rotating direction arrows.
function bearing(la1,lo1,la2,lo2){
  const tR=d=>d*Math.PI/180;const y=Math.sin(tR(lo2-lo1))*Math.cos(tR(la2));
  const x=Math.cos(tR(la1))*Math.sin(tR(la2))-Math.sin(tR(la1))*Math.cos(tR(la2))*Math.cos(tR(lo2-lo1));
  return (Math.atan2(y,x)*180/Math.PI+360)%360;
}
// Metrics + styling + hover tooltip for one path leg (a -> b).
function segMetrics(a,b,km){
  let dtSec=null,kmh=null;
  if(a.start_time&&b.start_time){dtSec=(new Date(b.start_time)-new Date(a.start_time))/1000;if(dtSec>0)kmh=km/(dtSec/3600);}
  // Same tower (jitter aside) or sub-200m apart => effectively the same place, a stay.
  const dwell=(a.tower_id&&a.tower_id===b.tower_id)||km<0.2;
  const impossible=kmh!=null&&kmh>900&&km>=5;
  let mode=dwell?'stationary':(kmh!=null?travelMode(kmh):'unknown');
  if(impossible)mode='impossible';
  const st=MODE_STYLE[mode]||MODE_STYLE.unknown;
  const head='<div style="border-left:3px solid '+st.color+';padding:1px 0 1px 6px;line-height:1.45;min-width:150px">'
    +'<b style="color:'+st.color+'">'+st.label+'</b>';
  const body=dwell
    ? '<br>Stayed '+fmtGap(dtSec)+(a.tower_id?' near '+esc(a.tower_id):'')
    : '<br><b>'+km.toFixed(2)+' km</b> in '+fmtGap(dtSec)
      +(kmh!=null?'<br><b>'+Math.round(kmh)+' km/h</b>':'<br>same-minute — speed n/a')
      +(impossible?' <span style="color:#ffb3b3">⚠</span>':'');
  const ctx='<br><span style="opacity:0.7;font-size:0.92em">'+fmt(a.start_time)+' → '+fmt(b.start_time)+'</span>'
    +'<br><span style="opacity:0.7;font-size:0.92em">'+esc(a.tower_id||'?')+' → '+esc(b.tower_id||'?')+'</span></div>';
  return {tip:head+body+ctx,color:st.color,dash:st.dash,weight:impossible?5:(dwell?2:3.5),
          dwell,impossible,kmh,km,mode,dtSec,label:st.label};
}
function showMapPath(sub){
  // Owned records only: a CDR locates the caller, so plotting records where the subject
  // is the called counterpart would place them at the other party's tower (and can
  // fabricate impossible "jumps"). Mirrors the backend, which keys movement by msisdn.
  clearMap();const rows=geoRecords.filter(r=>(r.msisdn===sub||r.subject===sub)&&r.latitude!=null&&r.longitude!=null);
  rows.sort((a,b)=>(a.start_time||'').localeCompare(b.start_time||''));
  if(!rows.length){D.mapAnalysis.innerHTML='No geo records.';return}
  const coords=rows.map(r=>[r.latitude,r.longitude]);
  // One polyline per leg, graded by travel mode; a rotated arrow shows direction.
  let dist=0,flagged=0,fastest=0;const usedModes=new Set();const legs=[];
  for(let i=1;i<rows.length;i++){
    const a=rows[i-1],b=rows[i];
    const km=mapInstance.distance([a.latitude,a.longitude],[b.latitude,b.longitude])/1000;
    dist+=km;
    const seg=segMetrics(a,b,km);usedModes.add(seg.mode);legs.push({a,b,seg,i});
    if(seg.impossible)flagged++;
    if(seg.kmh&&!seg.dwell&&seg.kmh>fastest)fastest=seg.kmh;
    const opts={color:seg.color,weight:seg.weight,opacity:0.85};if(seg.dash)opts.dashArray=seg.dash;
    const line=L.polyline([[a.latitude,a.longitude],[b.latitude,b.longitude]],opts);
    line.bindTooltip(seg.tip,{sticky:true,direction:'top',opacity:0.97});
    line.on('mouseover',function(){this.setStyle({weight:seg.weight+3,opacity:1})});
    line.on('mouseout',function(){this.setStyle({weight:seg.weight,opacity:0.85})});
    line.addTo(mapInstance);mapLayers.push(line);
    if(!seg.dwell&&km>=0.25){ // direction arrow at the leg midpoint (real moves only)
      const ang=bearing(a.latitude,a.longitude,b.latitude,b.longitude);
      const arrow=L.marker([(a.latitude+b.latitude)/2,(a.longitude+b.longitude)/2],{interactive:false,
        icon:L.divIcon({className:'',html:'<div style="transform:rotate('+ang+'deg);color:'+seg.color+';font-size:13px;line-height:1;text-shadow:0 0 2px #fff">&#9650;</div>',iconSize:[13,13],iconAnchor:[7,7]})});
      arrow.addTo(mapInstance);mapMarkers.push(arrow);
    }
  }
  // Stop markers; first = start (green), last = end (red), with sequence numbers.
  rows.forEach((r,i)=>{
    const isStart=i===0,isEnd=i===rows.length-1;
    const col=isStart?'#2d7d46':isEnd?'#b94a48':'#2c6f79';
    const lbl=isStart?'S':isEnd?'E':String(i+1);
    const m=L.marker([r.latitude,r.longitude],{icon:L.divIcon({className:'',
      html:'<div style="background:'+col+';color:#fff;border:2px solid #fff;border-radius:50%;width:'+((isStart||isEnd)?20:16)+'px;height:'+((isStart||isEnd)?20:16)+'px;display:flex;align-items:center;justify-content:center;font-size:'+((isStart||isEnd)?10:8)+'px;font-weight:700;box-shadow:0 0 3px rgba(0,0,0,.4)">'+lbl+'</div>',
      iconSize:[(isStart||isEnd)?20:16,(isStart||isEnd)?20:16],iconAnchor:[(isStart||isEnd)?10:8,(isStart||isEnd)?10:8]})});
    m.bindPopup(popupHtml(r));m.bindTooltip('#'+(i+1)+' · '+fmt(r.start_time),{direction:'top'});
    m.addTo(mapInstance);mapMarkers.push(m);
  });
  if(coords.length>1)mapInstance.fitBounds(L.latLngBounds(coords),{padding:[40,40]});else mapInstance.setView(coords[0],14);
  // Sidebar
  let h='<h4 style="margin:0 0 4px">Movement Path <span style="font-size:0.66rem;font-weight:400;color:var(--warn)">(tower-based estimate)</span></h4>';
  h+='<div style="font-size:0.7rem;color:var(--muted);margin-bottom:6px">Legs graded by speed; arrows show direction. Hover a leg for distance, time gap, speed &amp; mode.</div>';
  // legend (only modes actually present)
  h+='<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px">'+Object.keys(MODE_STYLE).filter(m=>usedModes.has(m)).map(m=>'<span style="display:inline-flex;align-items:center;gap:4px;font-size:0.64rem;color:var(--muted)"><span style="width:14px;height:3px;background:'+MODE_STYLE[m].color+';display:inline-block;border-radius:2px"></span>'+MODE_STYLE[m].label+'</span>').join('')+'</div>';
  h+=`<div class="stat-row"><span class="label">Records / Stops</span><span class="value">${rows.length}</span></div>`;
  h+=`<div class="stat-row"><span class="label">Linear Distance</span><span class="value">${Math.round(dist)} km</span></div>`;
  h+=`<div class="stat-row"><span class="label">Distinct Towers</span><span class="value">${new Set(rows.map(r=>r.tower_id).filter(Boolean)).size}</span></div>`;
  h+=`<div class="stat-row"><span class="label">Fastest Leg</span><span class="value">${Math.round(fastest)} km/h</span></div>`;
  if(flagged)h+=`<div class="stat-row"><span class="label" style="color:var(--danger)">Impossible Legs</span><span class="value" style="color:var(--danger)">${flagged}</span></div>`;
  h+='<h4 style="margin:10px 0 4px">Travel Legs (latest first)</h4>';
  legs.slice(-20).reverse().forEach(L2=>{
    const s=L2.seg;const speed=s.kmh!=null?Math.round(s.kmh)+' km/h':(s.dwell?'dwell':'n/a');
    h+='<div class="evt" title="Zoom to this leg" onclick="mapInstance.fitBounds([['+L2.a.latitude+','+L2.a.longitude+'],['+L2.b.latitude+','+L2.b.longitude+']],{padding:[80,80]})">'
      +'<span class="evt-time"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:'+s.color+';margin-right:5px"></span>'+fmt(L2.b.start_time)+'</span>'
      +'<span class="evt-loc" style="color:'+(s.impossible?'var(--danger)':'inherit')+'">'+s.km.toFixed(1)+' km · '+speed+'</span></div>';
  });
  D.mapAnalysis.innerHTML=h;
  D.mapTimeBar.style.display='flex';setupMapTime(rows);
}
function showMapHeat(sub){
  clearMap();const rows=geoSub(sub).filter(r=>r.latitude!=null&&r.longitude!=null);
  if(!rows.length){D.mapAnalysis.innerHTML='No records.';return}
  const locs={};
  rows.forEach(r=>{
    const k=r.tower_id||`${+r.latitude.toFixed(4)},${+r.longitude.toFixed(4)}`;
    if(!locs[k])locs[k]={lat:r.latitude,lng:r.longitude,count:0};
    locs[k].count++;
  });
  const towers=Object.values(locs);
  const maxC=Math.max(1,...towers.map(t=>t.count));
  towers.forEach(t=>{
    const p=t.count/maxC;
    const c=p>0.7?'#b94a48':p>0.4?'#d4a017':'#2d7d46';
    mapCircles.push(L.circleMarker([t.lat,t.lng],{radius:5+15*p,color:c,fillColor:c,fillOpacity:0.25+0.55*p,weight:1,opacity:0.6}).addTo(mapInstance));
    mapMarkers.push(L.marker([t.lat,t.lng],{icon:L.divIcon({className:'',html:`<div style="width:10px;height:10px;border-radius:50%;background:${c};opacity:0.8"></div>`,iconSize:[10,10],iconAnchor:[5,5]})}).bindPopup(`<strong>${esc(t.lat.toFixed(4))}, ${esc(t.lng.toFixed(4))}</strong><br>${t.count} visits`).addTo(mapInstance));
  });
  fitAllGeo();
  const sorted=towers.sort((a,b)=>b.count-a.count);
  let h='<h4 style="margin:0 0 6px">Activity Heatmap</h4>'+`<div class="stat-row"><span class="label">Records</span><span class="value">${rows.length}</span></div>`+`<div class="stat-row"><span class="label">Locations</span><span class="value">${sorted.length}</span></div><h4 style="margin:8px 0 4px">Hotspots</h4>`;
  sorted.slice(0,8).forEach(t=>{
    const p=t.count/maxC;
    const c=p>0.7?'#b94a48':p>0.4?'#d4a017':'#2d7d46';
    const loc=t.lat.toFixed(4)+','+t.lng.toFixed(4);
    h+=`<div class="evt" style="border-left-color:${c}"><span class="evt-loc">${esc(loc)}</span><span class="evt-time">${t.count} visits</span></div>`;
  });
  D.mapAnalysis.innerHTML=h;
}
function showMapZones(sub){
  clearMap();const rows=geoSub(sub).filter(r=>r.latitude!=null&&r.longitude!=null);
  if(!rows.length){D.mapAnalysis.innerHTML='No data.';return}
  const t={};rows.forEach(r=>{const k=r.tower_id||('p-'+r.latitude);if(!t[k])t[k]={lat:r.latitude,lng:r.longitude,count:0};t[k].count++});
  const sorted=Object.entries(t).sort((a,b)=>b[1].count-a[1].count);
  sorted.forEach(([id,td])=>{const rad=Math.min(60,10+Math.sqrt(td.count)*4);mapCircles.push(L.circle([td.lat,td.lng],{radius:rad*1000,color:'#2c6f79',fillColor:'#2c6f79',fillOpacity:0.1+Math.min(0.4,td.count/100),weight:2}).addTo(mapInstance));mapMarkers.push(L.marker([td.lat,td.lng]).bindPopup(`<strong>${esc(id)}</strong><br>${td.count} visits`).addTo(mapInstance))});
  fitAllGeo();
  let h='<h4>Operational Zones</h4>'+`<div class="stat-row"><span class="label">Zones</span><span class="value">${sorted.length}</span></div>`+`<div class="stat-row"><span class="label">Primary</span><span class="value">${esc(sorted[0][0])} (${((sorted[0][1].count/rows.length)*100).toFixed(0)}%)</span></div>`;
  h+='<h4 style="margin:8px 0 4px">Breakdown</h4>';sorted.slice(0,8).forEach(([id,td])=>{h+=`<div class="evt"><span class="evt-loc">${esc(id)}</span><span class="evt-time">${td.count} (${((td.count/rows.length)*100).toFixed(0)}%)</span></div>`});
  D.mapAnalysis.innerHTML=h;
}
function showMapColocation(sub){
  clearMap();const rows=geoRecords.filter(r=>r.latitude!=null&&r.longitude!=null);
  if(!rows.length){D.mapAnalysis.innerHTML='No data.';return}
  const twrs={};rows.forEach(r=>{const k=r.tower_id||('p-'+r.latitude);if(!twrs[k])twrs[k]={lat:r.latitude,lng:r.longitude,subjects:new Set(),records:[]};twrs[k].subjects.add(r.subject);twrs[k].records.push(r)});
  const shared=Object.entries(twrs).filter(([k,v])=>v.subjects.size>1&&v.records.some(r=>r.subject===sub)).sort((a,b)=>b[1].records.length-a[1].records.length);
  shared.slice(0,20).forEach(([id,td])=>{mapMarkers.push(L.marker([td.lat,td.lng]).bindPopup(`<strong>${esc(id)}</strong><br>Subjects: ${[...td.subjects].slice(0,5).join(', ')}`).addTo(mapInstance));td.records.filter(r=>r.subject===sub).forEach(r=>{const cm=L.circleMarker([r.latitude,r.longitude],{radius:5,color:'#b94a48',fillColor:'#b94a48',fillOpacity:0.6}).bindPopup(popupHtml(r));cm.addTo(mapInstance);mapMarkers.push(cm)})});
  const locs=mapMarkers.filter(m=>m.getLatLng).map(m=>m.getLatLng());if(locs.length)mapInstance.fitBounds(locs,{padding:[40,40]});else fitAllGeo();
  let h='<h4>Co-location</h4>'+`<div class="stat-row"><span class="label">Shared Towers</span><span class="value">${shared.length}</span></div>`+`<div class="stat-row"><span class="label">Co-located With</span><span class="value">${new Set(shared.flatMap(([k,v])=>[...v.subjects].filter(s=>s!==sub))).size}</span></div>`;
  h+='<h4 style="margin:8px 0 4px">Details</h4>';shared.slice(0,8).forEach(([id,td])=>{const others=[...td.subjects].filter(s=>s!==sub).join(', ');h+=`<div class="evt"><span class="evt-loc">${esc(id)}</span><span class="evt-time">With: ${esc(others)}</span></div>`});
  D.mapAnalysis.innerHTML=h;
}
function showMapTriangulation(sub){
  clearMap();
  const rows=geoSub(sub).filter(r=>r.latitude!=null&&r.longitude!=null&&r.tower_id);
  if(!rows.length){D.mapAnalysis.innerHTML='No geo records with tower data.';return}
  rows.sort((a,b)=>(a.start_time||'').localeCompare(b.start_time||''));
  const techRadius={'5G':1,'NR':1,'5G NSA':1,'LTE':3,'4G':3,'4G LTE':3,'UMTS':5,'3G':5,'HSPA':5,'HSPA+':5,'GSM':15,'2G':15,'GPRS':15,'EDGE':15,'CDMA':10,'1xRTT':10,'EVDO':10,'UNKNOWN':5};
  function covRadius(r){const t=(r.technology||r.rat||'UNKNOWN').toUpperCase();for(const[k,v]of Object.entries(techRadius)){if(t.includes(k.toUpperCase()))return v*1000}return 5000}
  function timeKey(r){return r.start_time?new Date(r.start_time).getTime():0}
  const clusters=[];let cur=[];
  for(let i=0;i<rows.length;i++){
    if(!cur.length||timeKey(rows[i])-timeKey(cur[0])<=30*60*1000)cur.push(rows[i]);
    else{clusters.push(cur);cur=[rows[i]]}
  }
  if(cur.length)clusters.push(cur);
  const usedClusters=clusters.filter(c=>new Set(c.map(r=>r.tower_id)).size>=2).slice(0,10);
  let towerTotals={};
  usedClusters.forEach(c=>{c.forEach(r=>{if(r.tower_id)towerTotals[r.tower_id]=(towerTotals[r.tower_id]||0)+1})});
  const towerLocs={};
  usedClusters.forEach(c=>{c.forEach(r=>{if(r.tower_id&&!towerLocs[r.tower_id]){const t=r.tower;towerLocs[r.tower_id]={lat:r.latitude,lng:r.longitude};if(t&&t.latitude!=null&&t.longitude!=null)towerLocs[r.tower_id]={lat:t.latitude,lng:t.longitude}}})});
  const maxTowerCount=Math.max(1,...Object.values(towerTotals));
  const densityColors=['#3a7d5a','#6a9e4f','#9abf3a','#c4d420','#e8c41a','#d99b0a','#c46e05','#b94403','#a82c02','#8b0000'];
  function densColor(n){const i=Math.min(densityColors.length-1,Math.floor((n/maxTowerCount)*densityColors.length));return densityColors[i]||densityColors[0]}
  const towerIds=Object.keys(towerLocs);
  towerIds.forEach(id=>{
    const loc=towerLocs[id];const cnt=towerTotals[id]||0;
    const rad=covRadius(rows.find(r=>r.tower_id===id)||{});
    const c=L.circle([loc.lat,loc.lng],{radius:rad,color:densColor(cnt),fillColor:densColor(cnt),fillOpacity:0.12,weight:1.5,opacity:0.5}).addTo(mapInstance);
    mapCircles.push(c);
    const m=L.circleMarker([loc.lat,loc.lng],{radius:6,color:'#fff',weight:2,fillColor:densColor(cnt),fillOpacity:0.9});
    m.bindTooltip(id,{direction:'top'});
    m.bindPopup(`<strong>${esc(id)}</strong><br>Records: ${cnt}<br>Coverage: ${(rad/1000).toFixed(1)} km`);
    m.addTo(mapInstance);mapMarkers.push(m);
  });
  usedClusters.forEach(c=>{
    const ids=[...new Set(c.map(r=>r.tower_id))];
    if(ids.length<2)return;
    const centers=ids.map(id=>{
      const loc=towerLocs[id];
      if(!loc)return null;
      const rad=covRadius(c.find(r=>r.tower_id===id)||{});
      if(rad<=0)return null;
      return{center:[loc.lng,loc.lat],radius:rad/1000};
    }).filter(Boolean);
    if(centers.length<2)return;
    try{
      let overlap=turf.circle(centers[0].center,centers[0].radius,{steps:48,units:'kilometers'});
      for(let j=1;j<centers.length;j++){
        const next=turf.circle(centers[j].center,centers[j].radius,{steps:48,units:'kilometers'});
        const inter=turf.intersect(overlap,next);
        if(!inter){overlap=null;break}
        overlap=inter;
      }
      if(overlap){
        const coords=overlap.geometry.coordinates[0].map(c=>[c[1],c[0]]);
        const poly=L.polygon(coords,{color:'#b94a48',fillColor:'#b94a48',fillOpacity:0.25,weight:2,dashArray:'4 4'}).addTo(mapInstance);
        mapLayers.push(poly);
      }
    }catch(e){/* skip cluster if intersection fails */}
  });
  if(towerIds.length){const pts=towerIds.map(id=>[towerLocs[id].lat,towerLocs[id].lng]);mapInstance.fitBounds(pts,{padding:[40,40]})}
  let h='<h4 style="margin:0 0 6px">Triangulation</h4>';
  h+=`<div class="stat-row"><span class="label">Towers</span><span class="value">${towerIds.length}</span></div>`;
  h+=`<div class="stat-row"><span class="label">Clusters</span><span class="value">${usedClusters.length}</span></div>`;
  h+=`<div class="stat-row"><span class="label">Overlaps</span><span class="value">${usedClusters.filter(c=>new Set(c.map(r=>r.tower_id)).size>=2).length}</span></div>`;
  h+='<h4 style="margin:8px 0 4px">Tower Usage</h4>';
  const sortedTowers=Object.entries(towerTotals).sort((a,b)=>b[1]-a[1]);
  sortedTowers.slice(0,8).forEach(([id,cnt])=>{const loc=towerLocs[id]||{};h+=`<div class="evt" onclick="mapInstance.setView([${loc.lat},${loc.lng}],14)"><span class="evt-loc">${esc(id)}</span><span class="evt-time">${cnt} records</span></div>`});
  h+='<div style="margin-top:10px;padding:8px;background:var(--card-bg);border-radius:6px;font-size:0.72rem;color:var(--muted)"><b>How it works:</b> Circles show estimated coverage by technology (1-15km radius). Overlapping zones (red dashed) indicate possible locations from consecutive tower handoffs within 30 min windows.</div>';
  D.mapAnalysis.innerHTML=h;
}
function showMapMeetings(sub){
  clearMap();const rows=geoRecords.filter(r=>r.latitude!=null&&r.longitude!=null);
  if(!rows.length){D.mapAnalysis.innerHTML='No data.';return}
  const sr=rows.filter(r=>r.subject===sub),or=rows.filter(r=>r.subject!==sub&&r.counterpart===sub);
  const ms=[];sr.forEach(a=>{or.forEach(b=>{if(a.tower_id&&a.tower_id===b.tower_id){const at=new Date(a.start_time||0).getTime(),bt=new Date(b.start_time||0).getTime();if(Math.abs(at-bt)<3600000)ms.push({s1:sub,s2:b.subject,tower:a.tower_id,lat:a.latitude,lng:a.longitude,t1:a.start_time,t2:b.start_time,gap:Math.abs(at-bt)/60000})}})});
  ms.sort((a,b)=>a.gap-b.gap);
  ms.slice(0,20).forEach(m=>{const col=m.gap<5?'#b94a48':m.gap<15?'#d4a017':'#2c6f79';mapMarkers.push(L.circleMarker([m.lat,m.lng],{radius:8,color:col,fillColor:col,fillOpacity:0.4,weight:2}).bindPopup(`<strong>Possible Meeting</strong><br>${esc(m.s1)} & ${esc(m.s2)}<br>Gap: ${m.gap.toFixed(0)} min`).addTo(mapInstance))});
  if(ms.length){const pts=mapMarkers.filter(m=>m.getLatLng).map(m=>m.getLatLng());if(pts.length)mapInstance.fitBounds(pts,{padding:[40,40]})}else fitAllGeo();
  let h='<h4>Meeting Detection</h4>'+`<div class="stat-row"><span class="label">Meetings</span><span class="value">${ms.length}</span></div>`+`<div class="stat-row"><span class="label">With</span><span class="value">${new Set(ms.map(m=>m.s2)).size}</span></div>`;
  if(!ms.length)h+='<p style="color:var(--muted);font-size:0.8rem">No meetings detected.</p>';
  else{h+='<h4 style="margin:8px 0 4px">Meetings</h4>';ms.slice(0,10).forEach(m=>{const conf=m.gap<5?'High':m.gap<15?'Medium':'Low';h+=`<div class="evt" style="border-left-color:${m.gap<5?'#b94a48':m.gap<15?'#d4a017':'#2c6f79'}"><span class="evt-time">${fmt(m.t1)}</span><span class="evt-loc">${esc(m.s1)} & ${esc(m.s2)} (${conf})</span></div>`})}
  D.mapAnalysis.innerHTML=h;
}
function fitAllGeo(){const pts=[];geoRecords.forEach(r=>{if(r.latitude!=null&&r.longitude!=null)pts.push([r.latitude,r.longitude])});if(pts.length)mapInstance.fitBounds(pts,{padding:[30,30]})}
function setupMapTime(rows){mapTimeData=rows;D.mapTimeSlider.max=Math.max(0,rows.length-1);D.mapTimeSlider.value=0;updateMapTime()}
function updateMapTime(){if(!mapTimeData.length)return;const idx=Math.min(parseInt(D.mapTimeSlider.value),mapTimeData.length-1);const r=mapTimeData[idx];if(!r)return;D.mapTimeLabel.textContent=fmt(r.start_time);mapInstance.setView([r.latitude,r.longitude],15);mapMarkers.forEach(m=>{if(m.setStyle)m.setStyle({radius:5,opacity:0.4})});if(mapMarkers[idx]&&mapMarkers[idx].setStyle)mapMarkers[idx].setStyle({radius:10,color:'#b94a48',weight:3})}
D.mapTimeSlider.addEventListener('input',updateMapTime);
D.mapTimePlay.addEventListener('click',()=>{mapTimePlaying=!mapTimePlaying;D.mapTimePlay.textContent=mapTimePlaying?'Stop':'Play';if(mapTimePlaying)playMapTimeFn()});
function playMapTimeFn(){if(!mapTimePlaying||!mapTimeData.length)return;D.mapTimeSlider.value=Math.min(parseInt(D.mapTimeSlider.value)+1,mapTimeData.length-1);updateMapTime();if(parseInt(D.mapTimeSlider.value)<mapTimeData.length-1)setTimeout(playMapTimeFn,1000);else{mapTimePlaying=false;D.mapTimePlay.textContent='Play'}}

// ====== 4. ENTITY TIMELINE ======
const SVC_COLORS={WhatsApp:'#25D366',Telegram:'#0088cc',Signal:'#3A76F0',Instagram:'#E4405F','Facebook/Messenger':'#1877F2',Threads:'#000000',Discord:'#5865F2',YouTube:'#FF0000',Zoom:'#2D8CFF','MS Teams':'#6264A7',Skype:'#00AFF0',Outlook:'#0078D4',OneDrive:'#0078D4','Xbox Live':'#107C10',LinkedIn:'#0A66C2',Webex:'#00BFFF',Slack:'#4A154B',Snapchat:'#FFFC00','X (Twitter)':'#1DA1F2',Reddit:'#FF4500',Netflix:'#E50914',Spotify:'#1DB954',Steam:'#171A21','Riot Games':'#EB0029','Epic Games':'#313131','Battle.net':'#148EFF','PlayStation Network':'#003087',GitHub:'#181717',GitLab:'#FCA121','Docker Hub':'#2496ED',ChatGPT:'#10A37F','OpenAI API':'#10A37F',Claude:'#D97757',Perplexity:'#1F8EF1',ProtonVPN:'#8B5CF6','Proton Mail':'#8B5CF6',NordVPN:'#4687FF',ExpressVPN:'#DA2020',Mullvad:'#1E1E1E',Surfshark:'#00AC4E','Quad9 DNS':'#F8C630',OpenDNS:'#FF6B00','Yahoo Mail':'#6001D1',Dropbox:'#0061FF',Mega:'#D90007',PayPal:'#00457C',PhonePe:'#5F259F',Paytm:'#00BAF2',Flipkart:'#2874F0',Myntra:'#E50046','Disney+':'#113CCF',Tor:'#7B4F9C','Google Search':'#4285F4',Gmail:'#4285F4','Google Meet':'#4285F4','Google Drive':'#4285F4','Google DNS':'#4285F4','Google Pay':'#4285F4',Gemini:'#4285F4',iMessage:'#34C759',FaceTime:'#34C759',iCloud:'#A2AAAD','Apple Push':'#A2AAAD','Amazon AWS':'#FF9900','Amazon.com':'#FF9900','Prime Video':'#FF9900','Amazon Pay':'#FF9900','Cloudflare CDN':'#F38040','Akamai CDN':'#0099CC','Fastly CDN':'#FF282D','Oracle Cloud':'#F80000',DigitalOcean:'#0080FF',OVH:'#1230F0',CDR:'#2c6f79',IPDR:'#b94a48'};
function svcColor(s){return SVC_COLORS[s]||'#8a7a6a'}
function renderTimeline(){
  if(!allRows.length)return;
  // Populate compare dropdown
  const curVal=D.tlCompare.value;
  D.tlCompare.innerHTML='<option value="">Compare with...</option>'+state.subjects.map(s=>`<option value="${esc(s)}"${s===curVal?' selected':''}>${esc(s)}</option>`).join('');
  const compare=D.tlCompare.value;
  const type=D.tlType.value;
  const q=D.tlSearch.value.trim().toLowerCase();
  let rows=allRows;
  if(type)rows=rows.filter(r=>r.type===type);
  const entityMap={};
  rows.forEach(r=>{
    const entities=[];
    if(r.sub)entities.push(r.sub);
    if(r.cnt&&r.cnt!==r.sub)entities.push(r.cnt);
    entities.forEach(e=>{
      if(!entityMap[e])entityMap[e]={entity:e,events:[],types:new Set(),contacts:new Set(),first:r.ts,last:r.ts,count:0};
      entityMap[e].events.push(r);
      entityMap[e].types.add(r.type);
      if(r.cnt&&r.cnt!==e)entityMap[e].contacts.add(r.cnt);
      if(r.sub&&r.sub!==e)entityMap[e].contacts.add(r.sub);
      if(r.ts){if(!entityMap[e].first||r.ts<entityMap[e].first)entityMap[e].first=r.ts;if(!entityMap[e].last||r.ts>entityMap[e].last)entityMap[e].last=r.ts}
      entityMap[e].count++;
    });
  });
  let entities=Object.values(entityMap).sort((a,b)=>b.count-a.count);
  if(q)entities=entities.filter(e=>e.entity.toLowerCase().includes(q));
  const acts=['Chat','Call','Video','Data','Voice','Conf','Stream','Msg'];
  D.tlCount.textContent=`${entities.length} entities`;
  if(compare&&compare!==entities[0]?.entity){
    const e1=entities.find(e=>e.entity===compare);
    const e2=entities.find(e=>e.entity!==compare);
    D.tlContainer.innerHTML='<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">'+
      [e1,e2].filter(Boolean).map(ent=>'<div><h4 style="font-size:0.85rem;margin:0 0 8px;color:var(--muted)">'+esc(ent.entity)+'</h4>'+
        renderEntityTimeline(ent)+'</div>'
      ).join('')+'</div>';
  }else{
    D.tlContainer.innerHTML=entities.map(e=>renderEntityTimeline(e)).join('');
  }
  // Attach toggle + restore open entities after render
  D.tlContainer.querySelectorAll('.tl-entity').forEach(el=>{
      const nm=el.querySelector('.tl-entity-name');
      const body=el.querySelector('.tl-entity-body');
      const arrow=el.querySelector('.tl-entity-arrow');
      if(nm){
        nm.style.cursor='pointer';
        nm.onclick=()=>{
          const isOpen=el.classList.toggle('open');
          if(body)body.style.display=isOpen?'block':'none';
          if(arrow)arrow.textContent=isOpen?'\u25BC':'\u25B6';
          if(isOpen)tlOpenEntities.add(nm.textContent);
          else tlOpenEntities.delete(nm.textContent);
};
const tlOpenEntities=new Set();
        if(tlOpenEntities.has(nm.textContent)){
          if(body)body.style.display='block';
          el.classList.add('open');
          if(arrow)arrow.textContent='\u25BC';
        }
      }
    });
}
function renderEntityTimeline(e){
  const sessions=reconstructSessions(e.entity);
  const sCnt=sessions.length;
    // Build a compact activity density strip from events
    const evSorted=e.events.sort((a,b)=>new Date(a.ts)-new Date(b.ts));
    const firstT=evSorted.length?new Date(evSorted[0].ts).getTime():0;
    const lastT=evSorted.length?new Date(evSorted[evSorted.length-1].ts).getTime():0;
    const span=Math.max(lastT-firstT,1);
    // Sample 50 buckets for density
    const density=Array(50).fill(0);
    evSorted.forEach(r=>{if(r.ts){const idx=Math.min(49,Math.floor((new Date(r.ts).getTime()-firstT)/span*49));density[idx]++}});
    const maxD=Math.max(...density,1);
    return `
    <div class="tl-entity">
      <div class="tl-entity-head" onclick="toggleEntity(this)">
        <span class="tl-entity-name">${esc(e.entity)}</span>
        <span class="tl-entity-meta">${e.count} events${sCnt?` &middot; ${sCnt} sessions`:''} &middot; ${e.contacts.size} contacts</span>
        <div class="tl-density">${density.map(d=>`<i style="height:${Math.max(2,(d/maxD)*14)}px"></i>`).join('')}</div>
        <span class="tl-entity-arrow">&#9654;</span>
      </div>
      <div class="tl-entity-body" style="display:none">
        ${sCnt?`<div class="tl-gantt">${sessions.map(s=>{
          const svcName=s.primary?s.primary.service:(s.service||'');
          const c=svcColor(svcName);
          const st=s.start?new Date(s.start).getTime():firstT;
          const et=s.end?new Date(s.end).getTime():lastT;
          const left=Math.max(0,((st-firstT)/span)*100);
          const w=Math.max(2,((et-st)/span)*100);
          const evText=Array.isArray(s.evidence)?s.evidence.join(', '):(s.evidence||'');
          const disLabel=s.activityLabel||s.activity||'';
          const attr=esc(disLabel)+(s.serviceConfidence?` (${Math.round(s.serviceConfidence)}%)`:'');
          const badgeLabel=s.serviceLabel||s.service||svcName;
          const alts=s.candidates&&s.candidates.length?JSON.stringify(s.candidates.slice(0,4)):'';
          const sid='sess_'+s.start+'_'+Math.random().toString(36).slice(2,6);
          window.evSessions=window.evSessions||{};window.evSessions[sid]=s;
          return `<div class="tl-gantt-bar" style="margin-left:${left}%;width:${w}%;background:${c}18;border-left:2px solid ${c}"
            data-svc="${esc(svcName)}" data-attr="${attr}" data-start="${s.start||''}" data-end="${s.end||''}" data-dur="${s.duration}" data-conf="${s.serviceConfidence?Math.round(s.serviceConfidence):''}" data-ev="${esc(evText)}" data-alts="${esc(alts)}" data-sid="${sid}" data-recs="${s.records||0}"
            onmouseover="showGanttTip(this,event)" onmouseout="scheduleHideGanttTip()">
            <span style="background:${c}">${esc(badgeLabel)}</span> ${esc(disLabel)} <em>${s.duration>=60?Math.floor(s.duration/60)+'m':s.duration+'s'}</em>
          </div>`;
        }).join('')}</div>`:''}
        <div class="tl-events">${evSorted.slice(-50).reverse().map(r=>`
          <div class="tl-ev" onclick="event.stopPropagation();showProfile('${esc(r.sub||r.cnt||'')}')">
            <span class="tl-ev-time">${fmts(r.ts)}</span>
            <span class="tl-ev-dot" style="background:${r.type==='IPDR'?'#b94a48':'var(--accent)'}"></span>
            <span class="tl-ev-type${r.type==='IPDR'?' ipdr':''}">${r.type}</span>
            <span class="tl-ev-peer">${esc(r.cnt||r.sub||'')}</span>
            <span class="tl-ev-meta">${r.dur?r.dur+'s':''} ${esc(r.cll||r.prot||'')}</span>
            <span class="tl-ev-svc">${r.type==='IPDR'?esc(recordSvcAttr(r)||r.svc||''):esc(r.svc||'')}</span>
          </div>
        `).join('')}</div>
      </div>
    </div>`;
}
function toggleEntity(el){
  const card=el.closest('.tl-entity');
  const body=card.querySelector('.tl-entity-body');
  const arrow=card.querySelector('.tl-entity-arrow');
  const open=body.style.display!=='none';
  body.style.display=open?'none':'block';
  card.classList.toggle('open',!open);
  arrow.textContent=open?'\u25B6':'\u25BC';
}
D.tlSearch.addEventListener('input',renderTimeline);
D.tlType.addEventListener('change',renderTimeline);
D.tlCompare.addEventListener('change',renderTimeline);

// ====== 5. CHARTS ======
function renderCharts(){
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
}
function renderChartServicePie(){
  if(typeof Chart==='undefined')return;
  const svc={};allRows.forEach(r=>{const s=r.svc||'Unknown';svc[s]=(svc[s]||0)+1});
  const sorted=Object.entries(svc).sort((a,b)=>b[1]-a[1]);
  const total=sorted.reduce((s,v)=>s+v[1],0);
  const top10=sorted.slice(0,10);
  const otherCount=sorted.slice(10).reduce((s,v)=>s+v[1],0);
  const colors=['#2c6f79','#b94a48','#d4a017','#3a7d5a','#8b5cf6','#ec4899','#f97316','#6b7280','#14b8a6','#78716c'];
  const labels=top10.map(s=>s[0]);
  const data=top10.map(s=>s[1]);
  if(otherCount>0){labels.push('Other ('+(sorted.length-10)+' more)');data.push(otherCount)}
  const fullColors=[...colors];if(otherCount>0)fullColors.push('#d1c8bd');
  if(window.chartSvcPie){try{window.chartSvcPie.destroy()}catch(e){}window.chartSvcPie=null}
  if(!D.chartServPie)return;
  const ci=document.getElementById('ciServicePie');
  if(ci)ci.innerHTML=sorted.length+' services &middot; '+total+' total records';
  window.chartSvcPie=new Chart(D.chartServPie,{type:'doughnut',data:{labels,datasets:[{data,backgroundColor:fullColors,borderWidth:0}]},options:{plugins:{legend:{position:'right',labels:{boxWidth:12,font:{size:9},padding:8,generateLabels:function(chart){const ds=chart.data.datasets[0];return chart.data.labels.map((l,i)=>({text:l+' ('+Math.round(ds.data[i]/total*100)+'%)',fillStyle:ds.backgroundColor[i],strokeStyle:'transparent',pointStyle:'circle',boxWidth:10,boxHeight:10,fontSize:9}))}}},tooltip:{callbacks:{label:function(ctx){const v=ctx.parsed;const pct=Math.round(v/total*100);return ctx.label+': '+v+' ('+pct+'%)'}}}},responsive:true,maintainAspectRatio:false}});
}
function renderChartHourly(){
  if(typeof Chart==='undefined')return;
  const hours=Array(24).fill(0);allRows.forEach(r=>{if(r.ts){const d=new Date(r.ts);hours[d.getHours()]++}});
  const labels=Array.from({length:24},(_,i)=>`${i.toString().padStart(2,'0')}:00`);
  const maxH=Math.max(...hours);
  const peakIdx=hours.indexOf(maxH);
  const totalH=hours.reduce((s,v)=>s+v,0);
  const avgH=Math.round(totalH/24);
  const bg=hours.map(h=>h>=maxH?'#b94a48':h>avgH?'#d4a017':'#2c6f79');
  if(window.chartHourly){try{window.chartHourly.destroy()}catch(e){}window.chartHourly=null}
  if(!D.chartHourly)return;
  const ci=document.getElementById('ciHourly');
  if(ci)ci.innerHTML=totalH+' records &middot; Peak: '+peakIdx.toString().padStart(2,'0')+':00 ('+maxH+') &middot; Avg: '+avgH+'/hr';
  window.chartHourly=new Chart(D.chartHourly,{type:'bar',data:{labels,datasets:[{data:hours,backgroundColor:bg,borderRadius:2}]},options:{plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){const v=ctx.parsed.y;const pct=Math.round(v/totalH*100);return v+' records ('+pct+'% of day)'}}}},scales:{y:{beginAtZero:true,grid:{},title:{display:true,text:'Records',font:{size:9}}},x:{grid:{display:false},title:{display:true,text:'Hour of Day',font:{size:9}}}},responsive:true,maintainAspectRatio:false}});
}
function renderChartTopContacts(){
  if(typeof Chart==='undefined')return;
  const cnt={};allRows.forEach(r=>{if(r.cnt)cnt[r.cnt]=(cnt[r.cnt]||0)+1});
  const sorted=Object.entries(cnt).sort((a,b)=>b[1]-a[1]).slice(0,10);
  const totalC=sorted.reduce((s,v)=>s+v[1],0);
  const grandTotal=allRows.filter(r=>r.cnt).length;
  if(window.chartTopC){try{window.chartTopC.destroy()}catch(e){}window.chartTopC=null}
  if(!D.chartTopContacts)return;
  const ci=document.getElementById('ciTopContacts');
  if(ci)ci.innerHTML=sorted.length+' shown &middot; '+grandTotal+' unique contacts total';
  window.chartTopC=new Chart(D.chartTopContacts,{type:'bar',data:{labels:sorted.map(s=>s[0].length>15?s[0].slice(0,15)+'...':s[0]),datasets:[{data:sorted.map(s=>s[1]),backgroundColor:sorted.map((s,i)=>i===0?'#b94a48':i<3?'#d4a017':'#2c6f79'),borderRadius:4}]},options:{plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){const v=ctx.parsed.x;const pct=Math.round(v/totalC*100);const full=sorted[ctx.dataIndex]?sorted[ctx.dataIndex][0]:'';return full+': '+v+' ('+pct+'% of top 10)'}}}},indexAxis:'y',scales:{x:{beginAtZero:true,grid:{},title:{display:true,text:'Records',font:{size:9}}},y:{grid:{display:false}}},responsive:true,maintainAspectRatio:false}});
}
function renderChartServiceTimeline(){
  if(typeof Chart==='undefined')return;
  const days={};allRows.forEach(r=>{if(r.ts&&r.svc){const d=fmtd(r.ts);if(!days[d])days[d]={};days[d][r.svc]=(days[d][r.svc]||0)+1}});
  const sortedDays=Object.keys(days).sort();
  const svcs=[...new Set(allRows.map(r=>r.svc).filter(Boolean))].slice(0,6);
  const colors=['#2c6f79','#b94a48','#d4a017','#3a7d5a','#8b5cf6','#ec4899'];
  const last14=sortedDays.slice(-14);
  const totalsByDay=last14.map(d=>Object.values(days[d]||{}).reduce((s,v)=>s+v,0));
  const totalPeriod=totalsByDay.reduce((s,v)=>s+v,0);
  const avgDaily=last14.length?Math.round(totalPeriod/last14.length):0;
  if(window.chartSvcTime){try{window.chartSvcTime.destroy()}catch(e){}window.chartSvcTime=null}
  if(!D.chartServTimeline)return;
  const ci=document.getElementById('ciServiceTimeline');
  if(ci)ci.innerHTML=last14.length+' days shown &middot; '+totalPeriod+' records &middot; Avg '+avgDaily+'/day &middot; '+svcs.length+' services plotted';
  window.chartSvcTime=new Chart(D.chartServTimeline,{type:'line',data:{labels:last14,datasets:svcs.map((s,i)=>({label:s,data:last14.map(d=>days[d]?.[s]||0),borderColor:colors[i%colors.length],backgroundColor:colors[i%colors.length]+'20',fill:true,tension:0.3,pointRadius:2,pointHoverRadius:5}))},options:{plugins:{legend:{position:'top',labels:{boxWidth:12,font:{size:9},padding:8}},tooltip:{mode:'index',intersect:false,callbacks:{title:function(ctx){return ctx[0].label+' (Total: '+totalsByDay[last14.indexOf(ctx[0].label)]+' records)'}}}},scales:{y:{beginAtZero:true,grid:{},title:{display:true,text:'Records',font:{size:9}}},x:{grid:{display:false},title:{display:true,text:'Date',font:{size:9}}}},responsive:true,maintainAspectRatio:false}});
}
function renderChartContactDirection(){
  if(typeof Chart==='undefined')return;
  const dirs={};allRows.forEach(r=>{if(r.cnt&&r.dir){if(!dirs[r.cnt])dirs[r.cnt]={mo:0,mt:0};if(r.dir==='MO')dirs[r.cnt].mo++;else if(r.dir==='MT')dirs[r.cnt].mt++}});
  const sorted=Object.entries(dirs).sort((a,b)=>(b[1].mo+b[1].mt)-(a[1].mo+a[1].mt)).slice(0,8);
  if(window.chartContactDir){try{window.chartContactDir.destroy()}catch(e){}window.chartContactDir=null}
  if(!D.chartContactDir)return;
  const ci=document.getElementById('ciContactDir');
  const totalD=sorted.reduce((s,v)=>s+v[1].mo+v[1].mt,0);
  if(ci)ci.innerHTML=sorted.length+' contacts with direction data &middot; '+totalD+' total';
  if(!sorted.length)return;
  window.chartContactDir=new Chart(D.chartContactDir,{type:'bar',data:{labels:sorted.map(s=>s[0].length>12?s[0].slice(0,12)+'...':s[0]),datasets:[{label:'Outgoing (MO)',data:sorted.map(s=>s[1].mo),backgroundColor:'#2c6f79',borderRadius:2},{label:'Incoming (MT)',data:sorted.map(s=>s[1].mt),backgroundColor:'#d4a017',borderRadius:2}]},options:{plugins:{legend:{position:'top',labels:{boxWidth:12,font:{size:8},padding:6}},tooltip:{mode:'index',callbacks:{label:function(ctx){return ctx.dataset.label+': '+ctx.parsed.y}}}},scales:{x:{stacked:true,grid:{display:false}},y:{stacked:true,beginAtZero:true,grid:{}}},responsive:true,maintainAspectRatio:false}});
}
function renderChartDurationDist(){
  if(typeof Chart==='undefined')return;
  const bins=[0,10,30,60,300,900,3600,Infinity];const labels=['<10s','10-30s','30-60s','1-5m','5-15m','15-60m','>60m'];
  const counts=Array(7).fill(0);allRows.filter(r=>r.type==='CDR').forEach(r=>{if(r.dur!=null){for(let i=0;i<bins.length-1;i++){if(r.dur>=bins[i]&&r.dur<bins[i+1]){counts[i]++;break}}}});
  const totalC=counts.reduce((s,v)=>s+v,0);const peakB=counts.indexOf(Math.max(...counts));
  if(window.chartDurDist){try{window.chartDurDist.destroy()}catch(e){}window.chartDurDist=null}
  if(!D.chartDurDist)return;
  const ci=document.getElementById('ciDurDist');
  if(ci)ci.innerHTML=totalC+' CDR records &middot; Most calls '+labels[peakB];
  if(!totalC)return;
  window.chartDurDist=new Chart(D.chartDurDist,{type:'bar',data:{labels,datasets:[{data:counts,backgroundColor:counts.map((v,i)=>i===peakB?'#b94a48':'#2c6f79'),borderRadius:3}]},options:{plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){return ctx.parsed.y+' calls ('+Math.round(ctx.parsed.y/totalC*100)+'%)'}}}},scales:{y:{beginAtZero:true,grid:{}},x:{grid:{display:false}}},responsive:true,maintainAspectRatio:false}});
}
function renderChartProtocolDist(){
  if(typeof Chart==='undefined')return;
  const prots={};allRows.filter(r=>r.type==='IPDR').forEach(r=>{if(r.prot){const p=r.prot.toUpperCase();prots[p]=(prots[p]||0)+1}});
  const sorted=Object.entries(prots).sort((a,b)=>b[1]-a[1]);const totalP=sorted.reduce((s,v)=>s+v[1],0);
  if(window.chartProtDist){try{window.chartProtDist.destroy()}catch(e){}window.chartProtDist=null}
  if(!D.chartProtDist)return;
  const ci=document.getElementById('ciProtDist');
  if(ci)ci.innerHTML=sorted.length+' protocols &middot; '+totalP+' IPDR records';
  if(!sorted.length)return;
  const colors=['#2c6f79','#b94a48','#d4a017','#3a7d5a','#8b5cf6','#78716c'];
  window.chartProtDist=new Chart(D.chartProtDist,{type:'doughnut',data:{labels:sorted.slice(0,8).map(s=>s[0]+' ('+Math.round(s[1]/totalP*100)+'%)'),datasets:[{data:sorted.slice(0,8).map(s=>s[1]),backgroundColor:colors,borderWidth:0}]},options:{plugins:{legend:{position:'right',labels:{boxWidth:10,font:{size:9},padding:6}},tooltip:{callbacks:{label:function(ctx){return ctx.label+': '+ctx.parsed+' records'}}}},responsive:true,maintainAspectRatio:false}});
}
function renderChartTopPorts(){
  if(typeof Chart==='undefined')return;
  const ports={};allRows.filter(r=>r.type==='IPDR').forEach(r=>{const p=r.dport||r.sport;if(p)ports[p]=(ports[p]||0)+1});
  const sorted=Object.entries(ports).sort((a,b)=>b[1]-a[1]).slice(0,10);
  const totalP=sorted.reduce((s,v)=>s+v[1],0);
  if(window.chartTopPorts){try{window.chartTopPorts.destroy()}catch(e){}window.chartTopPorts=null}
  if(!D.chartTopPorts)return;
  const ci=document.getElementById('ciTopPorts');
  if(ci)ci.innerHTML=sorted.length+' ports shown &middot; '+totalP+' total hits';
  if(!sorted.length)return;
  window.chartTopPorts=new Chart(D.chartTopPorts,{type:'bar',data:{labels:sorted.map(s=>'Port '+s[0]),datasets:[{data:sorted.map(s=>s[1]),backgroundColor:sorted.map((s,i)=>i===0?'#b94a48':i<3?'#d4a017':'#2c6f79'),borderRadius:4}]},options:{plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){return ctx.parsed.x+' connections'}}}},indexAxis:'y',scales:{x:{beginAtZero:true,grid:{}},y:{grid:{display:false}}},responsive:true,maintainAspectRatio:false}});
}
function renderChartDataVolume(){
  if(typeof Chart==='undefined')return;
  const vols={};allRows.filter(r=>r.type==='IPDR').forEach(r=>{if(r.cnt&&(r.bytesUp||r.bytesDn)){const b=(r.bytesUp||0)+(r.bytesDn||0);vols[r.cnt]=(vols[r.cnt]||0)+b}});
  const sorted=Object.entries(vols).sort((a,b)=>b[1]-a[1]).slice(0,10);
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
  if(typeof Chart==='undefined')return;
  const tow={};allRows.forEach(r=>{if(r.tow)tow[r.tow]=(tow[r.tow]||0)+1});
  const sorted=Object.entries(tow).sort((a,b)=>b[1]-a[1]).slice(0,10);
  const totalT=sorted.reduce((s,v)=>s+v[1],0);const allTow=Object.keys(tow).length;
  if(window.chartTowerAct){try{window.chartTowerAct.destroy()}catch(e){}window.chartTowerAct=null}
  if(!D.chartTowerAct)return;
  const ci=document.getElementById('ciTowerAct');
  if(ci)ci.innerHTML=sorted.length+' shown &middot; '+allTow+' unique towers total';
  if(!sorted.length)return;
  window.chartTowerAct=new Chart(D.chartTowerAct,{type:'bar',data:{labels:sorted.map(s=>s[0].length>12?s[0].slice(0,12)+'...':s[0]),datasets:[{data:sorted.map(s=>s[1]),backgroundColor:sorted.map((s,i)=>i===0?'#b94a48':i<3?'#d4a017':'#2c6f79'),borderRadius:4}]},options:{plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){const v=ctx.parsed.x;const pct=Math.round(v/totalT*100);return (sorted[ctx.dataIndex]?sorted[ctx.dataIndex][0]:'')+': '+v+' ('+pct+'%)'}}}},indexAxis:'y',scales:{x:{beginAtZero:true,grid:{}},y:{grid:{display:false}}},responsive:true,maintainAspectRatio:false}});
}
function renderChartContactDuration(){
  if(typeof Chart==='undefined')return;
  const durs={};allRows.filter(r=>r.type==='CDR').forEach(r=>{if(r.cnt&&r.dur!=null){if(!durs[r.cnt])durs[r.cnt]={sum:0,n:0};durs[r.cnt].sum+=r.dur;durs[r.cnt].n++}});
  const avg=Object.entries(durs).map(([c,v])=>[c,Math.round(v.sum/v.n)]).sort((a,b)=>b[1]-a[1]).slice(0,10);
  if(window.chartContactDur){try{window.chartContactDur.destroy()}catch(e){}window.chartContactDur=null}
  if(!D.chartContactDur)return;
  const ci=document.getElementById('ciContactDur');
  if(ci)ci.innerHTML=avg.length+' contacts with duration data &middot; longest avg '+((avg[0]||[])[1]||0)+'s';
  if(!avg.length)return;
  window.chartContactDur=new Chart(D.chartContactDur,{type:'bar',data:{labels:avg.map(s=>s[0].length>14?s[0].slice(0,14)+'...':s[0]),datasets:[{data:avg.map(s=>s[1]),backgroundColor:'#3a7d5a',borderRadius:4}]},options:{plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){const v=ctx.parsed.x;const full=avg[ctx.dataIndex]?avg[ctx.dataIndex][0]:'';return full+': avg '+v+'s'}}}},indexAxis:'y',scales:{x:{beginAtZero:true,grid:{},title:{display:true,text:'Avg Duration (s)',font:{size:9}}},y:{grid:{display:false}}},responsive:true,maintainAspectRatio:false}});
}
function renderChartDayOfWeek(){
  if(typeof Chart==='undefined')return;
  const dow=Array(7).fill(0);const names=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  allRows.forEach(r=>{if(r.ts)dow[new Date(r.ts).getDay()]++});
  const totalD=dow.reduce((s,v)=>s+v,0);
  const peakD=dow.indexOf(Math.max(...dow));
  if(window.chartDow){try{window.chartDow.destroy()}catch(e){}window.chartDow=null}
  if(!D.chartDayOfWeek)return;
  const ci=document.getElementById('ciDayOfWeek');
  if(ci)ci.innerHTML=names[peakD]+' busiest &middot; '+names[0]+' slowest';
  window.chartDow=new Chart(D.chartDayOfWeek,{type:'bar',data:{labels:names,datasets:[{data:dow,backgroundColor:dow.map((v,i)=>i===peakD?'#b94a48':v>0?'#2c6f79':'#d1c8bd'),borderRadius:3}]},options:{plugins:{legend:{display:false},tooltip:{callbacks:{label:function(ctx){return ctx.parsed.y+' records ('+Math.round(ctx.parsed.y/totalD*100)+'%)'}}}},scales:{y:{beginAtZero:true,grid:{}},x:{grid:{display:false}}},responsive:true,maintainAspectRatio:false}});
}

// ====== 6. RECORDS TABLE ======
let annotationsMap={};
function loadAnnotations(){
  API.get('/annotations').then(list=>{
    annotationsMap={};
    list.forEach(a=>{annotationsMap[a.record_type+'_'+a.record_id]=a});
    renderRecTable();
  }).catch(()=>{});
}
function toggleAnnot(r){
  const numId=parseInt(r.id.slice(1));
  const key=r.type+'_'+numId;
  if(annotationsMap[key]){
    API.del('/annotations/'+annotationsMap[key].id).then(()=>{
      delete annotationsMap[key];renderRecTable();
    }).catch(()=>{});
  }else{
    API.post('/annotations',{record_type:r.type,record_id:r.id,tag:'flagged',note:''}).then(a=>{
      annotationsMap[key]=a;renderRecTable();
    }).catch(()=>{});
  }
}
function renderRecords(){
  recPage=0;
  loadAnnotations();
  const svcs=new Set(allRows.map(r=>r.svc).filter(Boolean));
  D.recService.innerHTML='<option value="all">All services</option>'+[...svcs].map(s=>`<option value="${esc(s)}">${esc(s)}</option>`).join('');
  renderRecTable();
}
let recPage=0;
function renderRecTable(){
  let rows=[...allRows];
  if(D.recType.value!=='all')rows=rows.filter(r=>r.type===D.recType.value);
  if(D.recService.value!=='all')rows=rows.filter(r=>r.svc===D.recService.value);
  const q=D.recSearch.value.trim().toLowerCase();
  if(q)rows=rows.filter(r=>`${r.sub} ${r.cnt} ${r.tow} ${r.cll||''} ${r.prot||''} ${r.imsi||''} ${r.imei||''}`.toLowerCase().includes(q));
  D.recCount.textContent=`${rows.length} records`;
  const page=rows.slice(0,recPage+60);
  D.recBody.innerHTML=page.map(r=>{
    const cdr=r.type==='CDR';
    return `<tr onclick="showProfile('${esc(r.sub)}')" style="cursor:pointer">
      <td style="text-align:center;cursor:pointer;font-size:0.85rem" onclick="event.stopPropagation();toggleAnnot({id:'${r.id}',type:'${r.type}'})">${annotationsMap[r.type+'_'+parseInt(r.id.slice(1))]?'&#9733;':'&#9734;'}</td>
      <td>${fmt(r.ts)}</td>
      <td><span class="tag${cdr?'':' tag-alt'}">${r.type}</span></td>
      <td style="min-width:${colWidth(r.sub)}px;max-width:${colWidth(r.sub)}px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.sub)}">${esc(r.sub||'')}</td>
      <td style="min-width:${colWidth(r.cnt)}px;max-width:${colWidth(r.cnt)}px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.cnt)}">${esc(r.cnt||'')}</td>
      <td>${r.dur!=null?r.dur+'s':''}</td>
      <td>${esc(cdr?r.cll||'':r.prot||'')}</td>
      <td>${esc(cdr?r.dir||'':r.apn||'')}</td>
      <td>${esc(r.svc||'')}</td>
      <td>${cdr?'':r.sport!=null?r.sport:''}</td>
      <td>${cdr?'':r.dport!=null?r.dport:''}</td>
      <td style="font-size:0.7rem">${cdr?'':r.dport?portSvc(r.dport):r.sport?portSvc(r.sport):''}</td>
      <td style="font-size:0.7rem;min-width:300px;white-space:normal;word-break:break-word;line-height:1.3" title="${cdr?'':esc(recordSvcAttr(r))}">${cdr?'':esc(recordSvcAttr(r))}</td>
      <td>${esc(r.tow||'')}</td>
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
  }).join('');
  D.recLoadMore.style.display=rows.length>page.length?'block':'none';
  D.recLoadMore.onclick=()=>{recPage+=60;renderRecTable()};
}
D.recSearch.addEventListener('input',()=>{recPage=0;renderRecTable()});
D.recType.addEventListener('change',()=>{recPage=0;renderRecTable()});
D.recService.addEventListener('change',()=>{recPage=0;renderRecTable()});

// ====== 7. SUBJECT PROFILE ======
function showProfile(sub){
  if(!sub){D.profile.style.display='none';return}
  const rows=rowsFor(sub);
  const contacts=new Set();const towers=new Set();const svcCounts={};const hours=Array(24).fill(0);const dailyMap={};
  rows.forEach(r=>{
    if(r.cnt&&r.cnt!==sub)contacts.add(r.cnt);if(r.sub&&r.sub!==sub)contacts.add(r.sub);
    const s=r.svc||'Unknown';svcCounts[s]=(svcCounts[s]||0)+1;
    if(r.ts){hours[new Date(r.ts).getHours()]++;const d=new Date(r.ts).toLocaleDateString();dailyMap[d]=(dailyMap[d]||0)+1}
  });
  // Towers must be the subject's OWN serving cells (a CDR locates the caller only).
  ownedRowsFor(sub).forEach(r=>{if(r.tow)towers.add(r.tow)});
  const topSvc=Object.entries(svcCounts).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const topHourIdx=hours.indexOf(Math.max(...hours));
  const dayNight=hours.slice(6,18).reduce((s,v)=>s+v,0)>hours.slice(18,24).concat(hours.slice(0,6)).reduce((s,v)=>s+v,0)?'Day (6-18)':'Night (18-6)';
  // Frequency: avg records/day
  const days=Object.keys(dailyMap);const avgDay=days.length?Math.round(rows.length/days.length):0;
  // First seen / Last seen
  const times=rows.filter(r=>r.ts).map(r=>new Date(r.ts)).sort((a,b)=>a-b);
  const firstSeen=times.length?times[0]:null;
  const lastSeen=times.length?times[times.length-1]:null;
  // Dormancy: gaps > 24h between consecutive records
  let maxDormancy=0, dormantPeriods=0;
  for(let i=1;i<times.length;i++){
    const gapH=(times[i]-times[i-1])/3600000;
    if(gapH>24){dormantPeriods++;if(gapH>maxDormancy)maxDormancy=gapH}
  }
  // Activity spike detection: days with >3x average daily count
  const dayEntries=Object.entries(dailyMap);
  const avgDaily=dayEntries.length?dayEntries.reduce((s,[,c])=>s+c,0)/dayEntries.length:0;
  const spikeDays=dayEntries.filter(([,c])=>c>avgDaily*3&&c>=20).length;
  // Meetings via unified engine
  const meetings=detectMeetings({subject:sub,maxResults:20});
  window.meetingStore=window.meetingStore||{};window.meetingStore[sub+'|'+sub]=meetings;
  // Identity profile
  const identity=buildIdentityProfile(sub);
  const changes=identity.changes;
  // Collect the subject's OWN MSISDNs and IMEIs/IMSIs (identity is already owned-only).
  const allMsisdns=new Set();const allImeis=new Set();const allImsis=new Set();
  identity.identities.forEach(id=>{id.msisdns.forEach(m=>allMsisdns.add(m));if(id.imei)allImeis.add(id.imei);if(id.imsi)allImsis.add(id.imsi)});
  // Tower analytics
  const towerAn=towerAnalytics(sub);
  // Sessions
  const sessions=reconstructSessions(sub);
  const svcFromSessions={};sessions.forEach(s=>{const n=s.primary?s.primary.service:(s.service||'Unknown');svcFromSessions[n]=(svcFromSessions[n]||0)+1});
  const topSessionSvcs=Object.entries(svcFromSessions).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const maxDorm=maxDormancy>24?Math.round(maxDormancy/24)+'d':Math.round(maxDormancy)+'h';
  D.profileTitle.textContent=`Subject: ${esc(sub)}`;
  D.profileBody.innerHTML=`
    <div class="prof-grid">
      <div class="prof-card"><div class="prof-label">Records</div><div class="prof-value">${rows.length}</div></div>
      <div class="prof-card"><div class="prof-label">Contacts</div><div class="prof-value">${contacts.size}</div></div>
      <div class="prof-card"><div class="prof-label">Towers</div><div class="prof-value">${towers.size}</div></div>
      <div class="prof-card"><div class="prof-label">Sessions</div><div class="prof-value">${sessions.length}</div></div>
      <div class="prof-card"><div class="prof-label">Meetings</div><div class="prof-value">${meetings.length}</div></div>
      <div class="prof-card"><div class="prof-label">Avg / Day</div><div class="prof-value">${avgDay}</div></div>
    </div>
    <div class="prof-sub">
      <b>${firstSeen?firstSeen.toLocaleDateString():'n/a'}</b> → <b>${lastSeen?lastSeen.toLocaleDateString():'n/a'}</b> &middot; ${days.length} day span &middot;
      peak <b>${String(topHourIdx).padStart(2,'0')}:00</b> &middot; ${dayNight} &middot; top service <b>${esc(topSvc[0]?topSvc[0][0]:'n/a')}</b>
      <br>Dormancy: ${dormantPeriods} period${dormantPeriods===1?'':'s'} (max ${maxDorm}) &middot; activity spikes: ${spikeDays}
    </div>
    <div class="prof-two">
      <div class="prof-section">
        <h4>Identity</h4>
        <div class="prof-id">
          ${allMsisdns.size?`<div><strong>MSISDN</strong> ${[...allMsisdns].join(', ')}</div>`:''}
          ${allImeis.size?`<div><strong>IMEI</strong> ${[...allImeis].join(', ')}</div>`:''}
          ${allImsis.size?`<div><strong>IMSI</strong> ${[...allImsis].join(', ')}</div>`:''}
          ${identity.identities.length>1?`<div style="margin-top:5px">${identity.identities.map(id=>`<div class="tl">${id.imei||'?'} / ${id.imsi||'?'} — ${id.firstSeen.toLocaleDateString()}→${id.lastSeen.toLocaleDateString()} (${id.records})</div>`).join('')}</div>`:''}
        </div>
        ${changes.length?`<h4 class="alert" style="margin-top:8px">Identity changes (${changes.length})</h4>
          <div class="prof-list">${changes.slice(-5).map(c=>`<div style="padding:1px 0"><span style="color:${c.type==='sim_swap'?'var(--danger)':'var(--warn)'}">&#9654;</span> ${esc(c.detail)} <span style="color:var(--muted)">${c.time.toLocaleDateString()}</span></div>`).join('')}</div>`:''}
      </div>
      <div class="prof-section">
        <h4>Tower analytics</h4>
        <div class="prof-id">
          <div>${towerAn.totalTowers||towers.size} towers${towerAn.nightTower?` &middot; night <strong>${esc(towerAn.nightTower)}</strong>`:''}${towerAn.weekendTower?` &middot; weekend <strong>${esc(towerAn.weekendTower)}</strong>`:''}</div>
          ${towerAn.topTowers?`<div style="color:var(--muted);font-size:0.7rem;margin-top:2px">Top: ${towerAn.topTowers.map(([t,c])=>esc(t)+' ('+c+')').join(', ')}</div>`:''}
        </div>
        <h4 style="margin-top:8px">Attributed services</h4>
        ${topSessionSvcs.length?'<div class="prof-id">'+topSessionSvcs.map(([nm,c])=>'<div style="display:flex;gap:6px;align-items:center;padding:1px 0"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:'+svcColor(nm)+';flex-shrink:0"></span><span style="flex:1">'+esc(nm)+'</span><span style="color:var(--muted)">'+c+'</span></div>').join('')+'</div>':'<div style="font-size:0.74rem;color:var(--muted)">No session data</div>'}
      </div>
    </div>
    ${towers.size?`<div class="prof-section"><h4>Towers (${towers.size})</h4>
      <div class="prof-tags">${[...towers].slice(0,15).map(t=>'<span class="prof-tag" onclick="switchTab(\'map\')">'+esc(t)+'</span>').join('')}</div></div>`:''}
    ${meetings.length?`<div class="prof-section"><h4 class="alert">Detected co-locations (${meetings.length})</h4>
      <div class="prof-list">${meetings.slice(0,8).map((m,mi)=>{
        const confColor=m.gapLevel==='high'?'var(--success)':m.gapLevel==='medium'?'var(--warn)':'var(--muted)';
        const confLabel=m.gapLevel==='high'?'High':m.gapLevel==='medium'?'Med':'Low';
        return '<div style="padding:2px 0;display:flex;align-items:center;gap:4px"><span style="color:'+confColor+'">&#9679;</span> '+esc(m.time.toLocaleString())+' with <strong style="cursor:pointer;color:var(--accent)" onclick="showProfile(\''+esc(m.subB)+'\')">'+esc(m.subB)+'</strong> at '+esc(m.tow)+' <span style="color:'+confColor+';font-weight:600;font-size:0.68rem">['+confLabel+' '+m.score+']</span><button onclick="showMeetingOverlay(\''+esc(sub+'|'+sub)+'\','+mi+')" style="background:none;border:1px solid var(--line);color:var(--accent);padding:1px 6px;border-radius:3px;cursor:pointer;font-size:0.6rem">View</button></div>';
      }).join('')}</div></div>`:''}
    <div class="prof-section"><h4>Hourly activity</h4>
      <div class="prof-hours">${hours.map((h,i)=>`<div class="prof-hour" style="background:${h>Math.max(...hours)*0.7?'#b94a48':h>Math.max(...hours)*0.4?'#d4a017':'var(--accent)'};height:${Math.max(4,(h/Math.max(...hours||1))*40)}px" title="${i}:00 - ${h}"></div>`).join('')}</div></div>
    <div class="prof-section"><h4>Timeline narrative</h4>
      <div class="prof-list" style="border-left:2px solid var(--line);padding-left:8px">${(()=>{
      const narr=buildNarrative(sub);
      return narr.length?narr.map(nn=>`<div style="padding:1px 0;display:flex;gap:4px"><span style="color:${nn.type==='call'?'var(--danger)':nn.type==='movement'?'var(--warn)':nn.type==='meeting'?'var(--accent)':'var(--muted)'};flex-shrink:0">&#x2022;</span><span>${esc(nn.text)}</span></div>`).join(''):'<span style="color:var(--muted)">Insufficient data for narrative</span>';
    })()}</div></div>
    <div class="prof-section"><h4>Recent activity</h4>
      ${rows.slice(-10).reverse().map(r=>`<div class="evt" onclick="mapInstance&&mapInstance.setView([${r.lat||0},${r.lng||0}],13)"><span class="evt-time">${fmt(r.ts)}</span> <span class="evt-loc">${esc(r.type)} ${esc(r.cnt||'')} ${r.cll||''}</span></div>`).join('')}</div>
  `;
  D.profile.style.display='flex';
}
D.profileClose.addEventListener('click',()=>D.profile.style.display='none');
D.profile.addEventListener('click',e=>{if(e.target===D.profile)D.profile.style.display='none'});

// ====== GANTT TOOLTIP ======
function showGanttTip(el,e){
  const tip=document.getElementById('ganttTooltip');
  if(!tip)return;
  clearTimeout(tip._hideTimer);
  tip._hovering=true;
  const d=el.dataset;
  const svc=d.svc||'';
  const c=svcColor(svc);
  const start=d.start?new Date(d.start).toLocaleString():'—';
  const end=d.end?new Date(d.end).toLocaleString():'—';
  const dur=d.dur||'—';
  const conf=d.conf?d.conf+'%':'—';
  const ev=d.ev?d.ev.split(',').map(s=>s.trim()).filter(Boolean):[];
  const alts=d.alts?JSON.parse(d.alts):[];
  const tree={infrastructure:[],ports:[],behavior:[],signals:[]};
  ev.forEach(e=>{
    if(e.includes('IP range')||e.includes('Infrastructure')||e.includes('DNS')||e.includes('ASN'))tree.infrastructure.push(e);
    else if(e.includes('Port')||e.includes('port'))tree.ports.push(e);
    else if(e.includes('Behavior')||e.includes('pattern')||e.includes('Session')||e.includes('Traffic')||e.includes('UDP')||e.includes('TCP'))tree.behavior.push(e);
    else tree.signals.push(e);
  });
  tip.innerHTML=`
    <div class="tt-row"><span class="tt-svc" style="background:${c}">${esc(svc)}</span><span class="tt-val">${esc(d.attr||'')}</span></div>
    <hr>
    <div class="tt-row"><span class="tt-label">Start</span><span class="tt-val">${start}</span></div>
    <div class="tt-row"><span class="tt-label">End</span><span class="tt-val">${end}</span></div>
    <div class="tt-row"><span class="tt-label">Duration</span><span class="tt-val">${dur}s</span></div>
    <div class="tt-row"><span class="tt-label">Confidence</span><span class="tt-val">${conf}</span></div>
    ${(tree.infrastructure.length||tree.ports.length||tree.behavior.length||tree.signals.length)?`<hr><div class="tt-tree">
      ${tree.infrastructure.length?`<div class="tt-tree-node"><span class="tt-tree-label">&#x2514; Infrastructure</span>${tree.infrastructure.map(e=>`<div class="tt-tree-leaf">${esc(e)}</div>`).join('')}</div>`:''}
      ${tree.ports.length?`<div class="tt-tree-node"><span class="tt-tree-label">&#x2514; Ports</span>${tree.ports.map(e=>`<div class="tt-tree-leaf">${esc(e)}</div>`).join('')}</div>`:''}
      ${tree.behavior.length?`<div class="tt-tree-node"><span class="tt-tree-label">&#x2514; Behavior</span>${tree.behavior.map(e=>`<div class="tt-tree-leaf">${esc(e)}</div>`).join('')}</div>`:''}
      ${tree.signals.length?`<div class="tt-tree-node"><span class="tt-tree-label">&#x2514; Signals</span>${tree.signals.map(e=>`<div class="tt-tree-leaf">${esc(e)}</div>`).join('')}</div>`:''}
    </div>`:''}
    ${alts.length?`<hr><div style="font-size:0.68rem;color:var(--muted);margin-bottom:3px">Alternative Services</div><ul style="margin:0;padding-left:14px;font-size:0.7rem;line-height:1.5">${alts.map(a=>`<li>${esc(a.service+' ('+Math.round(a.score)+'%)')}</li>`).join('')}</ul>`:''}
    ${d.sid?`<hr><button class="ev-rec-btn" onclick="showSessionRecords(evSessions['${d.sid}'])"> View Records (${d.recs||'?'})</button><span style="float:right;font-size:0.6rem;color:var(--muted);padding-top:6px">${evidenceHash({serviceLabel:d.svc||'',evidence:d.ev?d.ev.split(','):[],duration:d.dur||0,records:d.recs||0})}</span>`:''}
  `;
  tip.onmouseenter=()=>{clearTimeout(tip._hideTimer);tip._hovering=true;tip.style.display='block'};
  tip.onmouseleave=()=>{tip._hovering=false;tip.style.display='none'};
  tip.style.display='block';
  positionGanttTip(el);
}
function scheduleHideGanttTip(){
  const tip=document.getElementById('ganttTooltip');
  if(!tip)return;
  tip._hovering=false;
  clearTimeout(tip._hideTimer);
  tip._hideTimer=setTimeout(()=>{
    if(!tip._hovering)tip.style.display='none';
  },200);
}
function hideGanttTip(){
  const tip=document.getElementById('ganttTooltip');
  if(tip){clearTimeout(tip._hideTimer);tip.style.display='none'}
}
function positionGanttTip(el){
  const tip=document.getElementById('ganttTooltip');
  if(!tip||tip.style.display==='none')return;
  const rect=el.getBoundingClientRect();
  const tr=tip.getBoundingClientRect();
  const gap=2;
  let left=rect.right+gap;
  let top=rect.top;
  // Flip to left side if tooltip overflows right edge
  if(left+tr.width>window.innerWidth-5)left=rect.left-tr.width-gap;
  // Flip below if overflows bottom
  if(top+tr.height>window.innerHeight-5)top=window.innerHeight-tr.height-5;
  if(top<0)top=rect.bottom+gap;
  tip.style.left=Math.round(left)+'px';
  tip.style.top=Math.round(top)+'px';
}

// ====== AI INSIGHTS ======

function buildDataPackage(){
  if(!allRows.length)return'No records loaded.';
  const lines=[];
  const subs=new Set();allRows.forEach(r=>{if(r.sub)subs.add(r.sub);if(r.cnt)subs.add(r.cnt)});
  const ts=allRows.filter(r=>r.ts).map(r=>+new Date(r.ts));
  lines.push('Records: '+allRows.length+' ('+state.cdr.length+' CDR, '+state.ipdr.length+' IPDR)');
  lines.push('Period: '+(ts.length?new Date(Math.min(...ts)).toISOString().slice(0,10)+' -> '+new Date(Math.max(...ts)).toISOString().slice(0,10):'?'));
  lines.push('Entities: '+subs.size);
  const svcC={};allRows.forEach(r=>{const s=r.svc||'?';svcC[s]=(svcC[s]||0)+1});
  lines.push('Services: '+Object.entries(svcC).sort((a,b)=>b[1]-a[1]).slice(0,8).map(s=>s[0]+'('+s[1]+')').join(', '));
  const cntC={};allRows.forEach(r=>{if(r.cnt)cntC[r.cnt]=(cntC[r.cnt]||0)+1});
  lines.push('Top contacts: '+Object.entries(cntC).sort((a,b)=>b[1]-a[1]).slice(0,8).map(c=>c[0]+'('+c[1]+')').join(', '));
  const towC={};allRows.forEach(r=>{if(r.tow)towC[r.tow]=(towC[r.tow]||0)+1});
  lines.push('Top towers: '+Object.entries(towC).sort((a,b)=>b[1]-a[1]).slice(0,6).map(t=>t[0]+'('+t[1]+')').join(', '));
  const edg={};allRows.forEach(r=>{if(r.sub&&r.cnt){const k=[r.sub,r.cnt].sort().join('|');edg[k]=(edg[k]||0)+1}});
  lines.push('Top links: '+Object.entries(edg).sort((a,b)=>b[1]-a[1]).slice(0,6).map(e=>e[0].replace('|','<->')+'x'+e[1]).join(', '));
  const dirs={i:0,o:0};allRows.forEach(r=>{if(r.dir==='MT')dirs.i++;else if(r.dir==='MO')dirs.o++});
  const dTot=dirs.i+dirs.o||1;lines.push('Direction: '+Math.round(dirs.i/dTot*100)+'% in / '+Math.round(dirs.o/dTot*100)+'% out');
  const durs=allRows.filter(r=>r.dur!=null).map(r=>r.dur);
  if(durs.length)lines.push('Duration: avg '+Math.round(durs.reduce((s,v)=>s+v,0)/durs.length)+'s, max '+Math.max(...durs)+'s');
  const hrs=Array(24).fill(0);allRows.forEach(r=>{if(r.ts)hrs[new Date(r.ts).getHours()]++});
  const peakIdx=hrs.indexOf(Math.max(...hrs));lines.push('Peak hour: '+peakIdx+':00 ('+Math.max(...hrs)+' records)');
  const night=hrs.slice(0,6).concat(hrs.slice(20)).reduce((s,v)=>s+v,0);
  const day=hrs.slice(6,20).reduce((s,v)=>s+v,0);const tot=night+day||1;
  lines.push('Night activity: '+Math.round(night/tot*100)+'%');
  const protC={};allRows.filter(r=>r.type==='IPDR'&&r.prot).forEach(r=>{protC[r.prot]=(protC[r.prot]||0)+1});
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
  if(!allRows.length)return '';
  const cdr=allRows.filter(r=>r.type==='CDR').slice(-500);
  const ipdr=allRows.filter(r=>r.type==='IPDR').slice(-500);
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
  if(!allRows.length){
    document.getElementById('aiBody')&&(document.getElementById('aiBody').innerHTML='<p style="color:var(--muted);text-align:center;padding:20px">No data loaded. Upload CDR/IPDR files first.</p>');
    return;
  }
  state.scenario=document.getElementById('scenarioTag')?.value||'adhoc';
  invalidateAiCache(); // fresh cache on each render
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
  const degMap={};allRows.forEach(r=>{if(r.sub)degMap[r.sub]=(degMap[r.sub]||0)+1;if(r.cnt)degMap[r.cnt]=(degMap[r.cnt]||0)+1});
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
  const total=allRows.length,totalCdr=state.cdr.length,totalIpdr=state.ipdr.length;
  const subs=new Set();allRows.forEach(r=>{if(r.sub)subs.add(r.sub);if(r.cnt)subs.add(r.cnt)});
  const ts=allRows.filter(r=>r.ts).map(r=>+new Date(r.ts));
  const span=ts.length?Math.round((Math.max(...ts)-Math.min(...ts))/86400000):0;
  let meetings=0;try{meetings=detectMeetings({allPairs:true}).length}catch(e){}
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
// ====== SPATIOTEMPORAL INFERENCES ======
let _infCache=null,_infReport=null;
// Shared fetch+cache of the inference report, reused by the Inferences tab and the map.
async function getInfReport(force){
  if(_infReport&&!force)return _infReport;
  const cq=activeCaseId?'?case_id='+encodeURIComponent(activeCaseId):'';
  _infReport=await API.get('/inference/report'+cq);
  return _infReport;
}
async function renderInferences(force){
  const box=$('infResults'),status=$('infStatus'),btn=$('infRefreshBtn');
  if(!box)return;
  if(btn&&!btn._bound){btn._bound=true;btn.onclick=()=>{_infCache=null;_infReport=null;renderInferences(true);};}
  if(_infCache&&!force){box.innerHTML=_infCache;return;}
  status.textContent='Analyzing...';
  box.innerHTML='<div style="padding:40px;text-align:center;color:var(--muted)">Running inference engine...</div>';
  let rep;
  try{rep=await getInfReport(force);}
  catch(e){status.textContent='Error';box.innerHTML='<div style="padding:40px;text-align:center;color:var(--danger)">Failed: '+esc(e.message)+'</div>';return;}
  _infCache=buildInferenceHtml(rep);
  box.innerHTML=_infCache;
  status.textContent=n((rep.cdr&&rep.cdr.subjects)||0)+' phone subjects · '+n((rep.ipdr&&rep.ipdr.sessions)||0)+' IPDR sessions';
}
function _infCard(title,count,color,body){
  return '<div class="inf-card"><div class="inf-card-head">'
    +'<span class="dot" style="background:'+color+'"></span><strong>'+title+'</strong>'
    +(count!=null?'<span class="count">'+count+'</span>':'')
    +'</div>'+(body||'')+'</div>';
}
function _infChip(t,c,title){return '<span class="inf-chip"'+(c?' style="color:'+c+'"':'')+(title?' title="'+esc(title)+'"':'')+'>'+esc(t)+'</span>';}
function _infSubj(s){return '<a class="inf-link" onclick="showProfile(\''+esc(s)+'\')">'+esc(s)+'</a>';}
function buildInferenceHtml(rep){
  const C=rep.cdr||{}, I=rep.ipdr||{};
  const subjects=C.subjects||0, sessions=I.sessions||0;
  if(!subjects && !sessions){
    return '<div class="inf-empty">No records in this case yet.<br>Upload CDR/IPDR data to run the analysis.</div>';
  }
  const cps=C.co_presence||[];
  const convoys=cps.filter(c=>c.convoy&&!c.hidden_link);
  const hidden=cps.filter(c=>c.hidden_link);
  const beh=Object.entries(C.behavioral||{});
  const odd=beh.filter(e=>e[1].odd_hours&&e[1].odd_hours.flag);
  const swaps=(C.devices&&C.devices.sim_swaps)||[];
  const burners=(C.devices&&C.devices.burner_handsets)||[];
  const imp=C.impossible_travel||[];
  const periodic=C.periodic_contacts||[];
  const vp=I.vpn_proxy||[];

  // ----- Persons of interest: the engine's composite risk leaderboard (CDR phone subjects) -----
  const cdrRisk=C.risk||[];
  const bandStyle=b=>({
    critical:{l:'Critical',c:'var(--danger)',s:'crit'},
    high:    {l:'High',    c:'var(--warn)',  s:'high'},
    elevated:{l:'Elevated',c:'var(--accent)',s:'info'},
    low:     {l:'Low',     c:'var(--muted)', s:'info'},
  }[b]||{l:b||'—',c:'var(--muted)',s:'info'});

  const critN=imp.length+swaps.length+burners.length+hidden.length;
  const highN=convoys.length;
  const vpIps=vp.length;

  let h='<div class="inf-wrap">';
  h+='<div class="inf-intro"><h3>Automated case analysis</h3>'
    +'<p>Two <b>separate</b> data sources, analysed independently and never cross-linked: '
    +'<b>CDR</b> (calls/SMS &mdash; subjects are <b>phone numbers</b>) and <b>IPDR</b> '
    +'(internet sessions &mdash; subjects are <b>IP addresses</b>). Every item is a lead to verify; '
    +'distances and times are tower-based estimates.</p></div>';

  h+='<div class="inf-summary">'
    +'<div class="inf-stat"><div class="n">'+n(subjects)+'</div><div class="t">CDR subjects (phone)</div></div>'
    +'<div class="inf-stat crit"><div class="n" style="color:'+(critN?'var(--danger)':'var(--muted)')+'">'+n(critN)+'</div><div class="t">Critical leads</div></div>'
    +'<div class="inf-stat high"><div class="n" style="color:'+(highN?'var(--warn)':'var(--muted)')+'">'+n(highN)+'</div><div class="t">Notable leads</div></div>'
    +'<div class="inf-stat info"><div class="n">'+n(sessions)+'</div><div class="t">IPDR sessions (IP)</div></div>'
    +'</div>';

  // ===================== CDR ANALYSIS (phone numbers) =====================
  if(cdrRisk.length){
    let rows='';
    cdrRisk.slice(0,12).forEach(r=>{
      const bs=bandStyle(r.band);
      rows+='<div class="inf-poi-row">'
        +'<span class="inf-sev '+bs.s+'" title="composite risk score '+r.score+'/100, from '+r.events+' event(s)">'+bs.l+' &middot; '+r.score+'</span>'
        +'<span class="who">'+_infSubj(r.subject)+'</span>'
        +'<span class="flags">'+(r.factors||[]).map(f=>_infChip(f.name,bs.c,f.detail+(f.weight?' (+'+f.weight+')':''))).join('')+'</span></div>';
    });
    h+=_infCard('Persons of interest','phone subjects, risk-ranked','var(--danger)',
      '<div class="inf-blurb">CDR phone-number subjects ranked by a composite <b>0&ndash;100 risk score</b>. Each chip is a contributing factor (hover to see why and its weight); correlated signals are de-duplicated and thin-evidence subjects are capped. The score is a triage aid, not proof. Click a number to open its profile.</div>'+rows);
  }

  const card=(title,count,color,sev,blurb,rows)=>_infCard(
     title+' <span class="inf-sev '+sev+'" style="margin-left:6px">'+(sev==='crit'?'Critical':sev==='high'?'Notable':'Context')+'</span>',
     count,color,'<div class="inf-blurb">'+blurb+'</div>'+rows);

  // -- Identity & device fraud --
  let theme='';
  const cloneBy={};(C.clone_corroboration||[]).forEach(c=>cloneBy[c.subject]=c);
  if(imp.length){
    const rows=imp.map(x=>{const cl=cloneBy[x.subject];
      return '<div class="inf-row"><div class="top"><strong>'+_infSubj(x.subject)+'</strong>'
        +'<span style="color:var(--danger);font-weight:700">'+(x.speed_kmh!=null?n(Math.round(x.speed_kmh))+' km/h':'same minute (∞)')+'</span>'
        +'<span style="font-size:0.7rem;color:var(--muted)">'+esc(x.from_tower)+' → '+esc(x.to_tower)+'</span></div>'
        +'<div class="meta">'+x.distance_km+' km in '+x.dt_minutes+' min'+(x.from_imei!==x.to_imei?' · IMEI changed':'')+(cl?' · '+esc(cl.verdict):'')+'</div></div>';
    }).join('');
    theme+=card('Impossible travel &amp; cloning',imp.length+' flagged','var(--danger)','crit',
      'The same number registered in two places too far apart for the time between them &mdash; physically impossible. Almost always a <b>cloned/duplicated SIM</b> or a spoofed record.',rows);
  }
  if(swaps.length||burners.length){
    let rows='';
    swaps.forEach(s=>{rows+='<div class="inf-row"><div class="top"><strong>'+_infSubj(s.msisdn)+'</strong>'+_infChip('on '+s.imeis.length+' handsets','var(--danger)')+'</div><div class="meta">IMEIs: '+esc(s.imeis.join(', '))+'</div></div>';});
    burners.forEach(b=>{rows+='<div class="inf-row"><div class="top"><strong>'+esc(b.imei)+'</strong>'+_infChip(b.msisdns.length+' numbers','var(--warn)')+'</div><div class="meta">Numbers: '+b.msisdns.map(_infSubj).join(', ')+'</div></div>';});
    theme+=card('SIM swaps &amp; burner handsets',swaps.length+burners.length,'var(--danger)','crit',
      'One number seen on several handsets (possible <b>SIM swap/clone</b>), or one handset cycling several numbers (a <b>burner</b>).',rows);
  }
  if(theme){h+='<div class="inf-theme">CDR · Identity &amp; device fraud</div>'+theme;}

  // -- Covert & structured coordination --
  theme='';
  if(hidden.length){
    const rows=hidden.map(c=>'<div class="inf-row"><div class="top">'+_infSubj(c.subject_a)+'<span style="color:var(--muted)">&amp;</span>'+_infSubj(c.subject_b)+_infChip('never call','var(--danger)')+'</div>'
      +'<div class="meta">Together '+c.occurrences+'× over '+c.distinct_days+' day(s) at '+esc((c.towers||[]).slice(0,3).join(', '))+'</div></div>').join('');
    theme+=card('Hidden links',hidden.length,'var(--danger)','crit',
      'Pairs repeatedly in the <b>same place at the same time</b> who <b>never call each other</b> &mdash; meeting in person while avoiding a phone trail.',rows);
  }
  if(convoys.length){
    const rows=convoys.map(c=>'<div class="inf-row"><div class="top">'+_infSubj(c.subject_a)+'<span style="color:var(--muted)">&amp;</span>'+_infSubj(c.subject_b)+_infChip(c.distinct_days+' days','var(--warn)')+'</div>'
      +'<div class="meta">Co-located '+c.occurrences+'× · '+(c.ever_called?'also call each other':'no calls between them')+'</div></div>').join('');
    theme+=card('Convoys / co-movement',convoys.length,'var(--warn)','high',
      'Subjects repeatedly together across <b>different days</b> &mdash; they travel together or meet regularly. Likely close associates.',rows);
  }
  if(periodic.length){
    const rows=periodic.slice(0,12).map(p=>'<div class="inf-row" style="padding:5px 0;font-size:0.74rem">'+_infSubj(p.subject)+' → '+esc(p.peer)+' · '+p.calls+' calls every ~'+p.mean_gap_hours+'h <span style="color:var(--muted)">(very regular)</span></div>').join('');
    theme+=card('Scheduled contact',periodic.length,'var(--accent)','info',
      'Pairs who call on a <b>regular cadence</b> &mdash; a structured, recurring relationship rather than ad-hoc contact.',rows);
  }
  if(theme){h+='<div class="inf-theme">CDR · Covert &amp; structured coordination</div>'+theme;}

  // -- Network structure --
  const net=C.network||{};
  if((net.brokers||[]).length||(net.articulation_points||[]).length||(net.reciprocity||[]).length||(net.relay_chains||[]).length||(net.predicted_links||[]).length){
    let rows='';
    if((net.brokers||[]).length)
      rows+='<div class="inf-row"><div class="top"><strong>Brokers</strong>'+_infChip('connect separate groups','var(--warn)')+'</div><div class="meta">'
        +net.brokers.map(b=>_infSubj(b.subject)+' <span style="color:var(--muted)">(betw '+b.betweenness+')</span>').join(' · ')+'</div></div>';
    if((net.articulation_points||[]).length)
      rows+='<div class="inf-row"><div class="top"><strong>Cut-points</strong>'+_infChip('removal splits network','var(--warn)')+'</div><div class="meta">'
        +net.articulation_points.map(a=>_infSubj(a.subject)+' <span style="color:var(--muted)">(deg '+a.degree+')</span>').join(' · ')+'</div></div>';
    if((net.reciprocity||[]).length)
      rows+='<div class="inf-row"><div class="top"><strong>One-way ties</strong>'+_infChip('caller never called back','var(--accent)')+'</div><div class="meta">'
        +net.reciprocity.slice(0,8).map(r=>_infSubj(r.caller)+' &rarr; '+esc(r.callee)+' ('+r.calls+')').join(' · ')+'</div></div>';
    if((net.relay_chains||[]).length)
      rows+='<div class="inf-row"><div class="top"><strong>Relay chains</strong>'+_infChip('A&rarr;B&rarr;C','var(--accent)')+'</div><div class="meta">'
        +net.relay_chains.slice(0,8).map(c=>_infSubj(c.a)+'&rarr;'+esc(c.b)+'&rarr;'+esc(c.c)+' <span style="color:var(--muted)">('+c.gap_min+'m)</span>').join(' · ')+'</div></div>';
    if((net.predicted_links||[]).length)
      rows+='<div class="inf-row"><div class="top"><strong>Likely hidden links</strong>'+_infChip('shared contacts, no call','var(--accent)')+'</div><div class="meta">'
        +net.predicted_links.slice(0,8).map(p=>_infSubj(p.subject_a)+' ~ '+esc(p.subject_b)+' <span style="color:var(--muted)">('+p.common_contacts+' shared)</span>').join(' · ')+'</div></div>';
    h+='<div class="inf-theme">CDR · Network structure</div>';
    h+=card('Call-graph roles',(net.brokers||[]).length+' broker(s)','var(--accent)','high',
      '<b>Brokers</b> sit between groups (high betweenness) and <b>cut-points</b> hold the network together &mdash; both are often coordinators. <b>One-way ties</b>, <b>relay chains</b> (A calls B, B calls C shortly after) and <b>likely hidden links</b> (shared contacts but no call) round out the structure.',rows);
  }

  // -- Movement & behaviour --
  theme='';
  if(odd.length){
    const rows=odd.map(e=>'<div class="inf-row" style="padding:5px 0;font-size:0.74rem">'+_infSubj(e[0])+' · '+Math.round(e[1].odd_hours.share*100)+'% of activity between 01:00–05:00</div>').join('');
    theme+=card('Odd-hours activity',odd.length,'var(--accent)','info',
      'Subjects unusually active in the <b>dead of night</b>.',rows);
  }
  const movers=Object.entries(C.movement||{}).map(e=>Object.assign({s:e[0]},e[1])).filter(m=>m.distinct_towers>1).sort((a,b)=>b.distinct_towers-a.distinct_towers).slice(0,8);
  if(movers.length){
    const rows=movers.map(m=>{const home=m.anchors&&m.anchors.home?m.anchors.home.tower_id:'?';const work=m.anchors&&m.anchors.work?m.anchors.work.tower_id:'?';
      const mob=m.mobility?m.mobility.class:'';const dwell=(m.dwell&&m.dwell.length)?' · longest dwell '+esc(m.dwell[0].tower_id)+' ('+m.dwell[0].dwell_hours+'h)':'';
      return '<div class="inf-row" style="padding:5px 0"><div class="top"><strong>'+_infSubj(m.s)+'</strong>'+(mob?_infChip(mob,'var(--accent)'):'')+'<span style="font-size:0.7rem;color:var(--muted)">'+m.distinct_towers+' towers · home '+esc(home)+' / work '+esc(work)+dwell+'</span></div></div>';}).join('');
    theme+=card('Movement &amp; anchors','top '+movers.length,'var(--accent)','info',
      'Each subject&rsquo;s likely <b>home and work cells</b>, how mobile they are (stationary&rarr;highly&nbsp;mobile) and where they <b>dwell longest</b> &mdash; context for the flags above.',rows);
  }
  const routes=C.shared_routes||[];
  if(routes.length){
    const rows=routes.slice(0,10).map(r=>'<div class="inf-row" style="padding:5px 0"><div class="top">'+_infSubj(r.subject_a)+'<span style="color:var(--muted)">&amp;</span>'+_infSubj(r.subject_b)+_infChip(r.shared_segments+' shared segments','var(--warn)')+'</div></div>').join('');
    theme+=card('Shared travel routes',routes.length,'var(--warn)','high',
      'Pairs who repeatedly travel the <b>same ordered sequence of towers</b> &mdash; the path version of co-location (they move together, not just meet at a point). Common corridors everyone uses are filtered out.',rows);
  }
  const temp=C.temporal||{};
  const escE=Object.entries(temp.escalation||{}), dormE=Object.entries(temp.dormancy||{}), fc=temp.first_contacts||[];
  if(escE.length||dormE.length||fc.length){
    let rows='';
    if(escE.length)
      rows+='<div class="inf-row"><div class="top"><strong>Escalating activity</strong>'+_infChip('vs own baseline','var(--warn)')+'</div><div class="meta">'
        +escE.slice(0,8).map(([s,e])=>_infSubj(s)+' <span style="color:var(--muted)">('+e.factor+'&times;, '+e.baseline+'&rarr;'+e.recent+'/day)</span>').join(' · ')+'</div></div>';
    if(dormE.length)
      rows+='<div class="inf-row"><div class="top"><strong>Dormant &rarr; reactivated</strong>'+_infChip('went quiet, resurfaced','var(--accent)')+'</div><div class="meta">'
        +dormE.slice(0,8).map(([s,d])=>_infSubj(s)+' <span style="color:var(--muted)">('+d.dormant_days+'d silent, resumed '+esc(d.resumed)+')</span>').join(' · ')+'</div></div>';
    if(fc.length)
      rows+='<div class="inf-row"><div class="top"><strong>Newest first-contacts</strong>'+_infChip('new ties forming','var(--accent)')+'</div><div class="meta">'
        +fc.slice(0,8).map(p=>_infSubj(p.subject_a)+' ~ '+esc(p.subject_b)+' <span style="color:var(--muted)">('+esc((p.first_contact||'').slice(0,10))+')</span>').join(' · ')+'</div></div>';
    theme+=card('Behavioural shifts',(escE.length+dormE.length)+' flagged','var(--accent)','info',
      '<b>Escalation</b> is a sustained surge in a subject&rsquo;s activity vs their own baseline (not a one-day spike). <b>Dormant&rarr;reactivated</b> is a long silence then renewed activity. <b>First-contacts</b> are the most recently-formed ties &mdash; new numbers entering the network.',rows);
  }
  if(theme){h+='<div class="inf-theme">CDR · Movement &amp; behaviour</div>'+theme;}

  if(critN+highN+odd.length+periodic.length+movers.length+escE.length+dormE.length+routes.length+(net.brokers||[]).length+(net.articulation_points||[]).length===0){
    h+='<div class="inf-blurb" style="padding:8px 0">No CDR (call) patterns flagged for the '+n(subjects)+' phone subjects.</div>';
  }

  // ===================== IPDR ANALYSIS (IP addresses) =====================
  const ipdrRisk=I.risk||[], vol=(I.volume&&I.volume.subjects)||[], beac=I.beaconing||[], dests=I.destinations||[];
  const volCov=I.volume?I.volume.byte_coverage:null;
  if(ipdrRisk.length||vp.length||vol.length||beac.length||dests.length)
    h+='<div class="inf-theme">IPDR · Internet sessions (IP subjects)</div>';

  // Flagged IPs — risk leaderboard (mirrors the CDR persons-of-interest, IP subjects only)
  if(ipdrRisk.length){
    let rows='';
    ipdrRisk.slice(0,12).forEach(r=>{
      const bs=bandStyle(r.band);
      rows+='<div class="inf-poi-row">'
        +'<span class="inf-sev '+bs.s+'" title="composite risk score '+r.score+'/100">'+bs.l+' &middot; '+r.score+'</span>'
        +'<span class="who" style="font-family:monospace">'+esc(r.subject)+'</span>'
        +'<span class="flags">'+(r.factors||[]).map(f=>_infChip(f.name,bs.c,f.detail+(f.weight?' (+'+f.weight+')':''))).join('')+'</span></div>';
    });
    h+=_infCard('Flagged IP addresses','IP subjects, risk-ranked','var(--accent)',
      '<div class="inf-blurb"><b>IP addresses</b> (never phone numbers) ranked by a composite risk score over anonymisation, exfiltration and beaconing. Hover a chip for the reason.</div>'+rows);
  }

  if(vp.length){
    const rows=vp.slice(0,30).map(v=>{
      return '<div class="inf-row"><div class="top"><strong style="font-family:monospace">'+esc(v.source_ip)+'</strong>'
        +'<span style="font-size:0.66rem;color:var(--muted)">source IP</span>'
        +(v.vpn_sessions?_infChip(v.vpn_sessions+' VPN','var(--danger)'):'')
        +(v.proxy_tor_sessions?_infChip(v.proxy_tor_sessions+' proxy/Tor','var(--warn)'):'')+'</div>'
        +'<div class="meta">'+v.evidence.map(esc).join(' · ')
        +(v.servers&&v.servers.length?'<br>Servers: '+esc(v.servers.join(', ')):'')
        +' · ports '+esc((v.ports||[]).join(', '))+'</div></div>';
    }).join('');
    h+=card('VPN / proxy connections',vp.length+' source IP'+(vp.length===1?'':'s'),'var(--warn)','high',
      'IPDR <b>data sessions</b> opened to VPN/Tor tunnel ports. Subjects here are <b>source IP addresses</b> &mdash; not linked to any phone number. The destination is the server reached.',rows);
  }

  // Data volume / exfiltration
  const exf=vol.filter(v=>v.exfil_suspected);
  if(vol.length){
    const rows=vol.slice(0,12).map(v=>'<div class="inf-row"><div class="top"><strong style="font-family:monospace">'+esc(v.source_ip)+'</strong>'
      +(v.exfil_suspected?_infChip('asymmetric upload','var(--danger)'):'')+'</div>'
      +'<div class="meta">&uarr; '+n(v.up_mb)+' MB up &middot; &darr; '+n(v.down_mb)+' MB down &middot; '+v.sessions+' session(s)</div></div>').join('');
    h+=card('Data volume &amp; exfiltration',exf.length+' flagged','var(--danger)',exf.length?'crit':'info',
      'Per source IP, bytes uploaded vs downloaded. A large, <b>upload-heavy asymmetry</b> is exfiltration-shaped &mdash; a lead to review (cloud backup/video can look similar)'+(volCov!=null?'. Byte coverage: '+Math.round(volCov*100)+'% of sessions':'')+'.',rows);
  }

  // Beaconing
  if(beac.length){
    const rows=beac.slice(0,12).map(b=>'<div class="inf-row"><div class="top"><strong style="font-family:monospace">'+esc(b.source_ip)+'</strong> &rarr; <span style="font-family:monospace">'+esc(b.destination_ip)+'</span>'
      +(b.non_web_port?_infChip('port '+b.port,'var(--warn)'):(b.port!=null?_infChip('port '+b.port,'var(--muted)'):''))+'</div>'
      +'<div class="meta">'+b.sessions+' sessions every ~'+b.mean_interval_hours+'h (very regular, cv '+b.regularity_cv+')</div></div>').join('');
    h+=card('Beaconing (automated check-ins)',beac.length,'var(--warn)','high',
      'A source IP connecting to the <b>same destination on a regular, low-jitter cadence</b> &mdash; automated rather than human (agent/C2-shaped). Non-web destination ports raise confidence.',rows);
  }

  // Rare destinations
  if(dests.length){
    const rows=dests.slice(0,10).map(d=>'<div class="inf-row"><div class="top"><strong style="font-family:monospace">'+esc(d.source_ip)+'</strong>'
      +_infChip(d.rare.length+' rare dest','var(--accent)')+'<span style="font-size:0.66rem;color:var(--muted)">of '+d.distinct_destinations+' total</span></div>'
      +'<div class="meta">'+d.rare.slice(0,4).map(x=>esc(x.destination_ip)+(x.provider?' ('+esc(x.provider)+')':'')+' ×'+x.sessions).join(' · ')+'</div></div>').join('');
    h+=card('Rare destinations',dests.length,'var(--accent)','info',
      'Destinations reached from <b>very few source IPs</b> &mdash; uncommon endpoints worth a look (labelled with the destination provider where known).',rows);
  }

  h+='</div>';
  return h;
}

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
  const subRank=state.subjects.map(s=>[s,allRows.filter(r=>r.sub===s||r.cnt===s).length]).sort((a,b)=>b[1]-a[1]);
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
  let html='<div class="ai-narr-head"><select class="ai-narr-select" onchange="switchNarrativeSubject(this.value)">'+subRank.slice(0,30).map(([s])=>'<option value="'+esc(s)+'"'+(s===topSub?' selected':'')+'>'+esc(s)+' ('+allRows.filter(r=>r.sub===s||r.cnt===s).length+' records)</option>').join('')+'</select></div>';
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
  if(!allRows.length)return;
  const reportContent=document.getElementById('aiReportContent');
  if(!reportContent)return;
  reportContent.innerHTML='<em>Generating report...</em>';

  // TIFM Backend mode
  if(D.aiMode && D.aiMode.value==='tifm'){
    D.aiStatus.textContent='Generating via backend TIFM...';
    try{
      const r=await API.post('/ai/generate-report?report_type='+encodeURIComponent(type),{});
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
  if(!allRows.length)return;

  // TIFM Backend mode
  if(D.aiMode && D.aiMode.value==='tifm'){
    D.aiAnalyzeBtn.disabled=true;
    D.aiStatus.textContent='Connecting to backend TIFM...';
    D.aiResponse.innerHTML='<em>Waiting for analysis...</em>';
    try{
      const r=await API.post('/ai/analyze',{});
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
      let url='/ai/chat?query='+encodeURIComponent(q);
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
// ====== FULL INVESTIGATION COMMAND CENTER ======
function toggleInvestModule(headerEl){
  const mod=headerEl.parentElement;
  if(mod)mod.classList.toggle('open');
}
async function runFullInvestigation(){
  const statusEl=document.getElementById('investStatus');
  const summaryEl=document.getElementById('investSummary');
  const modulesEl=document.getElementById('investModules');
  if(!modulesEl)return;
  statusEl.textContent='Running full investigation...';
  modulesEl.style.display='none';
  summaryEl.style.display='none';
  try{
    const r=await API.post('/ai/investigate',{});
    const inv=r.investigation;
    if(!inv){statusEl.textContent='Empty response';return}
    
    // Summary cards
    const s=inv.summary;
    summaryEl.style.display='grid';
    summaryEl.innerHTML=
      '<div class="is-card"><span class="is-label">Records</span><span class="is-value">'+n(s.total_records_analyzed)+'</span></div>'+
      '<div class="is-card"><span class="is-label">CDR/IPDR</span><span class="is-value">'+n(s.cdr_count)+' / '+n(s.ipdr_count)+'</span></div>'+
      '<div class="is-card"><span class="is-label">Subjects</span><span class="is-value">'+n(s.total_subjects)+'</span></div>'+
      '<div class="is-card"><span class="is-label">Towers</span><span class="is-value">'+n(s.total_towers)+'</span></div>'+
      '<div class="is-card"><span class="is-label">Findings</span><span class="is-value '+(s.high_priority_findings>0?'is-warn':'is-success')+'">'+n(s.total_findings)+' <span style="font-size:0.7rem;font-weight:400">('+n(s.high_priority_findings)+' high)</span></span></div>'+
      '<div class="is-card"><span class="is-label">Date Range</span><span class="is-value" style="font-size:0.78rem">'+(s.date_range?.start?fmts(s.date_range.start):'N/A')+'</span></div>'+
      '<div class="is-card"><span class="is-label">Modules</span><span class="is-value">'+n(s.modules_executed)+'</span></div>';
    
    // Render modules
    modulesEl.style.display='flex';
    
    // Findings
    renderFindings(inv.findings);
    renderIdentity(inv.identity_analysis);
    renderAnomalies(inv.anomaly_detection);
    renderSessions(inv.sessions, inv.gap_analysis);
    renderNetwork(inv.social_network, inv.hierarchical_analysis);
    renderLocation(inv.location_intelligence);
    renderCallDetails(inv.call_detail_analysis, inv.communication_patterns);
    renderTemporal(inv.temporal_analysis);
    
    statusEl.textContent='Investigation complete. '+n(s.total_findings)+' findings generated.';
    statusEl.style.color='var(--success)';
  }catch(e){
    console.error('Investigation error:',e);
    statusEl.textContent='Error: '+e.message;
    statusEl.style.color='var(--danger)';
  }
}
function _badge(s,c){return '<span class="if-badge '+c+'">'+esc(s)+'</span>'}
function _sevBadge(s){return _badge(s,s.toLowerCase())}
function _showMoreBtn(id,count,label){
  return '<div class="invest-toggle-row"><button class="invest-toggle-btn" onclick="investToggleMore(\''+id+'\')">Show all '+count+' '+label+' \u25BC</button></div>'+
    '<div id="investMore_'+id+'" style="display:none"></div>';
}
function _investMoreHtml(id,items,fn){
  return '<div style="display:none" id="investMore_'+id+'">'+items.map(fn).join('')+'</div>';
}
var _investMoreData={};
function investToggleMore(id){
  const btn=event.target;
  const container=document.getElementById('investMore_'+id);
  if(!container)return;
  const showing=container.style.display!=='none';
  container.style.display=showing?'none':'block';
  btn.innerHTML=(showing?'Show all ':_investMoreData[id]?.count||'')+' '+(showing?_investMoreData[id]?.label||'':_investMoreData[id]?.label||'')+(showing?' \u25BC':' \u25B2');
  if(!showing && _investMoreData[id] && !container.children.length){
    container.innerHTML=_investMoreData[id].items.map(_investMoreData[id].fn).join('');
  }
}

function renderFindings(f){
  const body=document.getElementById('investFindingsBody');
  const cnt=document.getElementById('investFindingsCount');
  if(!body)return;
  const all=f?.findings||[];
  cnt.textContent=all.length;
  const bySev=f?.by_severity||{};
  const byCat=f?.by_category||{};
  
  // Severity badges row
  let html='<div class="inv-sev-row">'+
    ['Critical','High','Medium','Low'].map(s=>'<span class="inv-sev-badge '+s.toLowerCase()+'">'+s+': '+(bySev[s]||0)+'</span>').join('')+
  '</div>';
  
  // Category summary
  const cats=Object.entries(byCat).sort((a,b)=>b[1]-a[1]);
  if(cats.length){
    html+='<div class="inv-cat-row">'+cats.slice(0,6).map(([c,v])=>_badge(c+': '+v,'medium')).join(' ')+'</div>';
  }
  
  // Top 10 high-severity findings
  const high=all.filter(f=>f.severity==='Critical'||f.severity==='High');
  const top=high.slice(0,10);
  if(top.length){
    html+='<div class="inv-section-label">Top High-Severity Findings</div>';
    html+=top.map(f=>'<div class="invest-finding '+f.severity.toLowerCase()+'">'+
      '<div class="if-title">'+_sevBadge(f.severity)+' '+esc(f.title)+'</div>'+
      '<div class="if-detail">'+
        (f.subject?'<strong>'+esc(f.subject)+'</strong> &middot; ':'')+
        '<em>'+esc(f.category)+'</em> &middot; '+esc(f.detail)+
      '</div></div>').join('');
    if(high.length>10){
      _investMoreData['findings']={count:high.length-10,label:'more high-severity',items:high.slice(10),fn:f=>'<div class="invest-finding '+f.severity.toLowerCase()+'">'+
        '<div class="if-title">'+_sevBadge(f.severity)+' '+esc(f.title)+'</div>'+
        '<div class="if-detail">'+
          (f.subject?'<strong>'+esc(f.subject)+'</strong> &middot; ':'')+
          '<em>'+esc(f.category)+'</em> &middot; '+esc(f.detail)+
        '</div></div>'};
      html+=_showMoreBtn('findings',high.length-10,'more high-severity');
    }
  }
  
  // All findings count note
  if(all.length>10){
    html+='<div style="margin-top:6px;font-size:0.72rem;color:var(--muted);text-align:center">'+all.length+' total findings across '+(cats.length)+' categories. '+
      (f?.executive_summary?esc(f.executive_summary):'')+'</div>';
  }
  body.innerHTML=html||'<div class="invest-msg">No findings.</div>';
}

function renderIdentity(id){
  const body=document.getElementById('investIdentityBody');
  const cnt=document.getElementById('investIdentityCount');
  if(!body)return;
  const subs=id?.by_subject||{};
  const keys=Object.keys(subs);
  cnt.textContent=keys.length;
  const burners=Object.entries(subs).filter(([,d])=>d.is_suspected_burner);
  const swaps=Object.entries(subs).filter(([,d])=>d.sim_swaps?.length);
  const devices=Object.entries(subs).filter(([,d])=>d.device_changes?.length);
  const totalSimSwaps=id?.total_sim_swaps||0;
  const totalDeviceChanges=id?.total_device_changes||0;
  
  let html='<div class="inv-sev-row">'+
    '<span class="inv-sev-badge high">Burners: '+burners.length+'</span>'+
    '<span class="inv-sev-badge high">SIM Swaps: '+totalSimSwaps+'</span>'+
    '<span class="inv-sev-badge medium">Device Changes: '+totalDeviceChanges+'</span>'+
    '<span class="inv-sev-badge low">Analyzed: '+keys.length+'</span>'+
  '</div>';
  
  // Top 15 most suspicious subjects (sorted by burner score desc)
  const sorted=Object.entries(subs).sort((a,b)=>b[1].burner_score-a[1].burner_score);
  const top=sorted.slice(0,15);
  html+='<div class="inv-section-label">Most Suspicious Subjects</div>';
  html+=top.map(([sub,d])=>{
    const isBurner=d.is_suspected_burner;
    return '<div class="invest-finding '+(isBurner?'high':'low')+'">'+
      '<div class="if-title">'+
        _badge(isBurner?'BURNER':'Normal',isBurner?'high':'low')+' '+esc(sub)+
        ' <span class="if-detail" style="font-weight:400">Score: '+d.burner_score+'% | '+d.unique_imei+' IMEI | '+d.unique_imsi+' IMSI | '+d.total_transitions+' changes</span>'+
      '</div>'+
      (d.findings?.length?'<div class="if-detail">'+d.findings.slice(0,3).map(f=>'<span style="color:var(--warn)">&#9656; '+esc(f)+'</span><br>').join('')+'</div>':'')+
      (d.sim_swaps?.length?'<div class="if-detail" style="margin-top:2px"><strong style="color:var(--danger);font-size:0.7rem">SIM Swaps:</strong> '+d.sim_swaps.map(s=>'<span class="inv-tag inv-tag-danger">'+fmts(s.timestamp)+'</span>').join('')+'</div>':'')+
      (d.device_changes?.length?'<div class="if-detail" style="margin-top:2px"><strong style="color:var(--warn);font-size:0.7rem">Device Changes:</strong> '+d.device_changes.slice(0,3).map(s=>'<span class="inv-tag inv-tag-warn">'+fmts(s.timestamp)+'</span>').join('')+'</div>':'')+
    '</div>';
  }).join('');
  
  if(sorted.length>15){
    _investMoreData['identity']={count:sorted.length-15,label:'subjects',items:sorted.slice(15),fn:([sub,d])=>{
      const isBurner=d.is_suspected_burner;
      return '<div class="invest-finding '+(isBurner?'high':'low')+'">'+
        '<div class="if-title">'+
          _badge(isBurner?'BURNER':'Normal',isBurner?'high':'low')+' '+esc(sub)+
          ' <span class="if-detail" style="font-weight:400">Score: '+d.burner_score+'% | '+d.unique_imei+' IMEI | '+d.unique_imsi+' IMSI | '+d.total_transitions+' changes</span>'+
        '</div></div>';
    }};
    html+=_showMoreBtn('identity',sorted.length-15,'subjects');
  }
  body.innerHTML=html||'<div class="invest-msg">No identity data.</div>';
}

function renderAnomalies(an){
  const body=document.getElementById('investAnomalyBody');
  const cnt=document.getElementById('investAnomalyCount');
  if(!body)return;
  const list=an?.anomalies||[];
  cnt.textContent=list.length;
  
  let html='<div class="inv-sev-row">'+
    '<span class="inv-sev-badge high">High: '+(an?.high_severity_count||0)+'</span>'+
    '<span class="inv-sev-badge medium">Medium: '+(an?.medium_severity_count||0)+'</span>'+
    '<span class="inv-sev-badge low">Total: '+list.length+'</span>'+
  '</div>';
  
  // Group by type
  const grouped={};
  list.forEach(a=>{if(!grouped[a.type])grouped[a.type]=[];grouped[a.type].push(a);});
  
  Object.entries(grouped).forEach(([type,items],idx)=>{
    const highCount=items.filter(a=>a.severity==='High').length;
    html+='<div class="inv-section-label">'+esc(type)+' <span class="if-detail">('+items.length+' total'+(highCount?', '+highCount+' high':'')+')</span></div>';
    const show=items.slice(0,8);
    html+=show.map(a=>'<div class="invest-anom '+a.severity.toLowerCase()+'">'+
      '<span class="anom-subj">'+esc(a.subject)+'</span> '+
      '<span class="anom-detail">'+esc(a.detail)+'</span>'+
    '</div>').join('');
    if(items.length>8){
      _investMoreData['anom_'+idx]={count:items.length-8,label:'anomalies',items:items.slice(8),fn:a=>'<div class="invest-anom '+a.severity.toLowerCase()+'">'+
        '<span class="anom-subj">'+esc(a.subject)+'</span> <span class="anom-detail">'+esc(a.detail)+'</span></div>'};
      html+=_showMoreBtn('anom_'+idx,items.length-8,'anomalies');
    }
  });
  body.innerHTML=html||'<div class="invest-msg">No anomalies detected.</div>';
}

function renderSessions(sess, gap){
  const body=document.getElementById('investSessionsBody');
  const cnt=document.getElementById('investSessionsCount');
  if(!body)return;
  const subs=sess?.by_subject||{};
  const keys=Object.keys(subs);
  cnt.textContent=keys.length;
  const gapsBySubject=gap?.by_subject||{};
  
  if(!keys.length){body.innerHTML='<div class="invest-msg">No session data.</div>';return;}
  
  // Aggregate stats
  let totalSessions=0,totalGaps24h=0,subsWithGaps24h=0;
  keys.forEach(k=>{
    totalSessions+=subs[k].total_sessions;
    if(subs[k].gaps_above_24h>0)subsWithGaps24h++;
    totalGaps24h+=subs[k].gaps_above_24h||0;
  });
  
  let html='<div class="inv-sev-row">'+
    '<span class="inv-sev-badge low">Subjects: '+keys.length+'</span>'+
    '<span class="inv-sev-badge low">Sessions: '+totalSessions+'</span>'+
    '<span class="inv-sev-badge '+(totalGaps24h>0?'warn':'low')+'">Gaps >24h: '+totalGaps24h+'</span>'+
    '<span class="inv-sev-badge '+(subsWithGaps24h>0?'warn':'low')+'">Affected Subjects: '+subsWithGaps24h+'</span>'+
  '</div>';
  
  // Top subjects by gaps >24h
  const sorted=keys.filter(k=>subs[k].gaps_above_24h>0).sort((a,b)=>subs[b].gaps_above_24h-subs[a].gaps_above_24h);
  if(sorted.length){
    html+='<div class="inv-section-label">Subjects with Notable Gaps (sorted by gaps >24h)</div>';
    html+='<table class="inv-compact-table"><tr><th>Subject</th><th>Sessions</th><th>Avg Gap</th><th>Gaps &gt;24h</th><th>Max Gap</th></tr>';
    const show=sorted.slice(0,15);
    show.forEach(k=>{
      const s=subs[k];
      html+='<tr'+(s.gaps_above_24h>3?' class="inv-row-warn"':'')+'>'+
        '<td><strong>'+esc(k)+'</strong></td>'+
        '<td>'+n(s.total_sessions)+'</td>'+
        '<td>'+(s.avg_gap_between_sessions_minutes?Math.round(s.avg_gap_between_sessions_minutes)+'m':'—')+'</td>'+
        '<td>'+(s.gaps_above_24h||0)+'</td>'+
        '<td>'+(s.max_gap_minutes?Math.round(s.max_gap_minutes/60)+'h':'—')+'</td></tr>';
    });
    html+='</table>';
    if(sorted.length>15){
      _investMoreData['sessions']={count:sorted.length-15,label:'subjects',items:sorted.slice(15),fn:k=>{
        const s=subs[k];
        return '<tr'+(s.gaps_above_24h>3?' class="inv-row-warn"':'')+'>'+
          '<td><strong>'+esc(k)+'</strong></td>'+
          '<td>'+n(s.total_sessions)+'</td>'+
          '<td>'+(s.avg_gap_between_sessions_minutes?Math.round(s.avg_gap_between_sessions_minutes)+'m':'—')+'</td>'+
          '<td>'+(s.gaps_above_24h||0)+'</td>'+
          '<td>'+(s.max_gap_minutes?Math.round(s.max_gap_minutes/60)+'h':'—')+'</td></tr>';
      }};
      html+=_showMoreBtn('sessions',sorted.length-15,'subjects');
    }
  }
  
  if(gap?.subjects_with_gaps){
    html+='<div style="margin-top:6px;font-size:0.72rem;color:var(--muted)">'+n(gap.subjects_with_gaps)+' subject(s) with network gaps detected.'+(gap.global_finding?.length?' '+esc(gap.global_finding.join(' ')):'')+'</div>';
  }
  body.innerHTML=html;
}

function renderNetwork(net, hier){
  const body=document.getElementById('investNetworkBody');
  const cnt=document.getElementById('investNetworkCount');
  if(!body)return;
  cnt.textContent=net?.nodes||0;
  
  if(!net?.nodes){body.innerHTML='<div class="invest-msg">No network data.</div>';return;}
  
  // Role distribution
  const roles=net.structural_roles||{};
  const roleCounts={};
  Object.values(roles).forEach(r=>{roleCounts[r.inferred_role]=(roleCounts[r.inferred_role]||0)+1;});
  
  let html='<div class="inv-sev-row">'+
    '<span class="inv-sev-badge low">Nodes: '+n(net.nodes)+'</span>'+
    '<span class="inv-sev-badge low">Edges: '+n(net.edges)+'</span>'+
    '<span class="inv-sev-badge low">Density: '+net.density+'</span>'+
    '<span class="inv-sev-badge low">Reciprocity: '+net.reciprocity+'</span>'+
    '<span class="inv-sev-badge '+(net.total_bridges>0?'warn':'low')+'">Bridges: '+n(net.total_bridges)+'</span>'+
  '</div>';
  
  // Role distribution
  html+='<div class="inv-role-dist">'+Object.entries(roleCounts).map(([role,count])=>{
    const cls=role.includes('Broker')||role.includes('Hub')?'warn':role.includes('Core')?'medium':'low';
    return _badge(role+': '+count,cls);
  }).join(' ')+'</div>';
  
  // Centrality table (top 15)
  html+='<div class="inv-section-label">Top Nodes by Degree Centrality</div>';
  html+='<table class="inv-compact-table"><tr><th>Node</th><th>Role</th><th>Degree</th><th>Betweenness</th><th>k-Core</th></tr>';
  const sorted=Object.entries(roles).sort((a,b)=>b[1].degree_centrality-a[1].degree_centrality);
  sorted.slice(0,15).forEach(([node,r])=>{
    const cls=r.inferred_role.includes('Broker')||r.inferred_role.includes('Hub')?'inv-row-warn':'';
    html+='<tr class="'+cls+'"><td><strong>'+esc(node)+'</strong></td><td>'+r.inferred_role+'</td><td>'+r.degree_centrality+'</td><td>'+r.betweenness_centrality+'</td><td>'+r.k_core+'</td></tr>';
  });
  html+='</table>';
  
  // Critical bridges as compact cards
  if(net.critical_bridges?.length){
    html+='<div class="inv-section-label">Critical Bridges ('+net.critical_bridges.length+')</div>';
    html+='<div class="inv-bridge-row">';
    net.critical_bridges.slice(0,5).forEach(b=>{
      html+='<div class="inv-bridge-card"><strong>'+esc(b.from)+'</strong> &#8596; <strong>'+esc(b.to)+'</strong><br><span class="if-detail">'+n(b.weight)+' interactions</span></div>';
    });
    html+='</div>';
  }
  
  // Hierarchy summary
  if(hier?.command_chain_summary){
    html+='<div class="inv-section-label">Organization</div>';
    html+='<div style="font-size:0.78rem;padding:4px 0">'+esc(hier.command_chain_summary);
    if(hier.checkin_patterns?.length){
      html+='<br><span class="if-detail">'+hier.checkin_patterns.length+' check-in patterns detected</span>';
    }
    html+='</div>';
  }
  body.innerHTML=html;
}

function renderLocation(loc){
  const body=document.getElementById('investLocationBody');
  const cnt=document.getElementById('investLocationCount');
  if(!body)return;
  const subs=loc?.by_subject||{};
  const keys=Object.keys(subs);
  cnt.textContent=keys.length;
  const hotspots=loc?.geo_hotspots||[];
  
  if(!keys.length){body.innerHTML='<div class="invest-msg">No location data.</div>';return;}
  
  let html='<div class="inv-sev-row">'+
    '<span class="inv-sev-badge low">Subjects: '+keys.length+'</span>'+
    '<span class="inv-sev-badge low">Hotspots: '+hotspots.length+'</span>'+
  '</div>';
  
  // Hotspots table
  if(hotspots.length){
    html+='<div class="inv-section-label">Top Activity Hotspots</div>';
    html+='<table class="inv-compact-table"><tr><th>Tower</th><th>Visits</th><th>Subjects</th></tr>';
    hotspots.slice(0,10).forEach(h=>{
      html+='<tr><td><strong>'+esc(h.tower_id)+'</strong></td><td>'+n(h.total_visits)+'</td><td>'+n(h.unique_subjects)+'</td></tr>';
    });
    html+='</table>';
  }
  
  // Subjects with widest range
  const withRadius=Object.entries(subs).filter(([,d])=>d.radius_of_operation_km).sort((a,b)=>b[1].radius_of_operation_km-a[1].radius_of_operation_km);
  if(withRadius.length){
    html+='<div class="inv-section-label">Widest Operational Range</div>';
    withRadius.slice(0,10).forEach(([sub,d])=>{
      html+='<div class="invest-finding low"><div class="if-title">'+esc(sub)+'</div><div class="if-detail">'+
        d.radius_of_operation_km+'km radius &middot; '+d.total_locations+' towers &middot; Entropy: '+d.location_entropy+' ('+d.location_predictability+')'+
      '</div></div>';
    });
  }
  body.innerHTML=html;
}

function renderCallDetails(call, comm){
  const body=document.getElementById('investCallBody');
  const cnt=document.getElementById('investCallCount');
  if(!body)return;
  const subs=call?.by_subject||{};
  const keys=Object.keys(subs);
  cnt.textContent=keys.length;
  const circles=comm?.calling_circles||[];
  
  if(!keys.length){body.innerHTML='<div class="invest-msg">No call data.</div>';return;}
  
  // Aggregate suspicious counts
  let shortCalls=0, oddCalls=0, bursts=0;
  Object.values(subs).forEach(d=>{shortCalls+=d.short_signal_calls||0; oddCalls+=d.odd_hour_calls||0; bursts+=d.call_bursts||0;});
  
  let html='<div class="inv-sev-row">'+
    '<span class="inv-sev-badge low">Pairs: '+n(comm?.total_pairs_analyzed||0)+'</span>'+
    '<span class="inv-sev-badge '+(shortCalls>0?'warn':'low')+'">Signal Calls: '+shortCalls+'</span>'+
    '<span class="inv-sev-badge '+(oddCalls>0?'warn':'low')+'">Odd-Hour: '+oddCalls+'</span>'+
    '<span class="inv-sev-badge '+(bursts>0?'warn':'low')+'">Bursts: '+bursts+'</span>'+
    '<span class="inv-sev-badge low">Circles: '+circles.length+'</span>'+
  '</div>';
  
  // Calling circles
  if(circles.length){
    html+='<div class="inv-section-label">Calling Circles (3-way mutual communication)</div>';
    html+='<div class="inv-circle-row">';
    circles.slice(0,10).forEach(c=>{
      html+='<div class="inv-circle-card">'+
        c.members.map(m=>esc(m)).join(' &#8644; ')+
        '<br><span class="if-detail">'+n(c.total_calls_between)+' calls</span></div>';
    });
    html+='</div>';
  }
  
  // Top suspicious subjects
  const suspicious=Object.entries(subs).filter(([,d])=>d.short_signal_calls>0||d.odd_hour_calls>0||d.call_bursts>0)
    .sort((a,b)=>(b.short_signal_calls+b.odd_hour_calls+b.call_bursts)-(a.short_signal_calls+a.odd_hour_calls+a.call_bursts));
  if(suspicious.length){
    html+='<div class="inv-section-label">Suspicious Calling Patterns</div>';
    suspicious.slice(0,12).forEach(([sub,d])=>{
      const cp=comm?.by_subject?.[sub]||{};
      html+='<div class="invest-anom high">'+
        '<span class="anom-subj">'+esc(sub)+'</span> '+
        '<span class="anom-detail">In:'+n(cp.incoming||0)+' Out:'+n(cp.outgoing||0)+' Avg:'+(cp.avg_duration_seconds?Math.round(cp.avg_duration_seconds)+'s':'—')+'</span>'+
        (d.short_signal_calls?' <span class="inv-tag inv-tag-warn">'+d.short_signal_calls+' short</span>':'')+
        (d.odd_hour_calls?' <span class="inv-tag inv-tag-warn">'+d.odd_hour_calls+' odd-hr</span>':'')+
        (d.call_bursts?' <span class="inv-tag inv-tag-danger">'+d.call_bursts+' bursts</span>':'')+
      '</div>';
    });
  }
  body.innerHTML=html;
}

function renderTemporal(temp){
  const body=document.getElementById('investTemporalBody');
  const cnt=document.getElementById('investTemporalCount');
  if(!body)return;
  const profiles=temp?.subject_profiles||{};
  const pkeys=Object.keys(profiles);
  cnt.textContent=pkeys.length;
  
  if(!temp?.total_records){body.innerHTML='<div class="invest-msg">No temporal data.</div>';return;}
  
  const dr=temp.date_range||{};
  let html='<div class="inv-sev-row">'+
    '<span class="inv-sev-badge low">Records: '+n(temp.total_records)+'</span>'+
    '<span class="inv-sev-badge low">Span: '+(dr.span_days?n(dr.span_days)+'d':'—')+'</span>'+
    '<span class="inv-sev-badge '+(temp.night_activity_ratio>0.3?'warn':'low')+'">Night: '+Math.round((temp.night_activity_ratio||0)*100)+'%</span>'+
    '<span class="inv-sev-badge '+(temp.activity_trend==='increasing'?'warn':temp.activity_trend==='decreasing'?'success':'low')+'">Trend: '+temp.activity_trend+'</span>'+
    '<span class="inv-sev-badge low">Peak: '+(temp.most_active_hour!=null?temp.most_active_hour+':00':'—')+'</span>'+
  '</div>';
  
  // Day-of-week
  if(temp.day_of_week){
    html+='<div class="inv-section-label">Activity by Day</div><div class="inv-dow-row">';
    Object.entries(temp.day_of_week).forEach(([d,c])=>{
      const pct=Math.round(c/temp.total_records*100);
      html+='<span class="inv-dow-badge">'+d.substring(0,3)+': '+n(c)+' ('+pct+'%)</span>';
    });
    html+='</div>';
  }
  
  // Night owls
  const nightOwls=Object.entries(profiles).filter(([,p])=>p.is_night_owl).sort((a,b)=>b[1].night_activity_pct-a[1].night_activity_pct);
  if(nightOwls.length){
    html+='<div class="inv-section-label">Night-Dominant Subjects ('+nightOwls.length+')</div>';
    nightOwls.slice(0,15).forEach(([sub,p])=>{
      html+='<div class="invest-anom warn"><span class="anom-subj">'+esc(sub)+'</span> <span class="anom-detail">'+p.night_activity_pct+'% night &middot; Profile: '+p.profile+' &middot; Peak: '+(p.peak_hour>=0?p.peak_hour+':00':'—')+'</span></div>';
    });
    if(nightOwls.length>15){
      _investMoreData['temporal']={count:nightOwls.length-15,label:'night-dominant subjects',items:nightOwls.slice(15),fn:([sub,p])=>
        '<div class="invest-anom warn"><span class="anom-subj">'+esc(sub)+'</span> <span class="anom-detail">'+p.night_activity_pct+'% night &middot; Profile: '+p.profile+'</span></div>'
      };
      html+=_showMoreBtn('temporal',nightOwls.length-15,'night-dominant subjects');
    }
  }
  body.innerHTML=html;
}
// ====== ADMIN ======
function renderAdmin(){
  const tbody=D.adminBody;const empty=D.adminEmpty;const table=D.adminTable;
  tbody.innerHTML='<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--muted)">Loading...</td></tr>';
  API.get('/auth/admin/users').then(data=>{
    const users=data.users;
    if(!users.length){table.style.display='none';empty.style.display='block';return}
    table.style.display='';empty.style.display='none';
    tbody.innerHTML=users.map(u=>{
      const d=u.created_at?new Date(u.created_at).toLocaleString():'-';
      const l=u.last_login_at?new Date(u.last_login_at).toLocaleString():'-';
      return `<tr>
        <td>${u.id}</td>
        <td>${esc(u.username)}</td>
        <td>${esc(u.role)}</td>
        <td>${u.is_active?'Yes':'No'}</td>
        <td>${d}</td>
        <td>${l}</td>
        <td><div class="admin-actions">
          <button data-id="${u.id}" data-username="${esc(u.username)}" data-role="${esc(u.role)}" data-active="${u.is_active}" class="admin-edit">Edit</button>
          <button data-id="${u.id}" data-username="${esc(u.username)}" class="admin-reset-pw">Reset PW</button>
          <button data-id="${u.id}" data-username="${esc(u.username)}" class="admin-delete btn-danger">Delete</button>
        </div></td>
      </tr>`
    }).join('');
  }).catch(e=>{tbody.innerHTML='<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--danger)">Failed to load users.</td></tr>';console.error(e)});
}

function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}

// ---- Admin Modal ----
function showAdminModal(title,fields,onSubmit){
  let m=document.getElementById('adminModal');
  if(!m){
    m=document.createElement('div');m.id='adminModal';m.className='modal-overlay';
    m.style.cssText='position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.55);z-index:999;display:flex;align-items:center;justify-content:center';
    const box=document.createElement('div');box.className='modal';box.style.cssText='background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:24px;max-width:420px;width:90%;max-height:80vh;overflow:auto;box-shadow:0 8px 32px rgba(0,0,0,0.3)';
    box.innerHTML='<div id="adminModalHead" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px"><h3 id="adminModalTitle" style="margin:0"></h3><button id="adminModalClose" class="btn-sm" style="font-size:1.2rem;background:none;border:none;cursor:pointer;color:var(--fg)">&times;</button></div><div id="adminModalBody"></div>';
    m.appendChild(box);document.body.appendChild(m);
    m.addEventListener('click',e=>{if(e.target===m)hideAdminModal()});
    m.querySelector('#adminModalClose').addEventListener('click',hideAdminModal);
  }
  const formId='adminModalForm_'+(title.replace(/\s/g,''));
  let body=m.querySelector('#adminModalBody');
  m.querySelector('#adminModalTitle').textContent=title;
  body.innerHTML='<form id="'+formId+'">'+fields.map(f=>{
    let inpts=f.type==='select'
      ? '<select name="'+f.name+'" id="af_'+f.name+'" style="width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--fg);font-size:0.85rem;margin-bottom:10px">'+f.options.map(o=>'<option value="'+o.value+'"'+(f.val===o.value?' selected':'')+'>'+o.label+'</option>').join('')+'</select>'
      : '<input name="'+f.name+'" id="af_'+f.name+'" type="'+f.type+'" value="'+(f.val||'')+'" placeholder="'+f.label+'" style="width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--fg);font-size:0.85rem;margin-bottom:10px;box-sizing:border-box"/>';
    return '<label style="font-size:0.78rem;color:var(--muted);display:block;margin-bottom:4px">'+f.label+'<br>'+inpts+'</label>';
  }).join('')+'<button type="submit" style="padding:8px 16px;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:0.85rem">Save</button></form>';
  m.style.display='flex';
  document.getElementById(formId).addEventListener('submit',async e=>{
    e.preventDefault();const btn=e.target.querySelector('button[type="submit"]');btn.disabled=true;btn.textContent='Saving...';
    try{await onSubmit(e);hideAdminModal()}catch(err){btn.disabled=false;btn.textContent='Save';alert('Error: '+err.message)}
  });
}

function hideAdminModal(){
  const m=document.getElementById('adminModal');if(m)m.style.display='none';
}

// ---- Admin Event Delegation ----
document.addEventListener('click',e=>{
  const t=e.target;
  if(t.classList.contains('admin-edit')){
    const id=parseInt(t.dataset.id),uname=t.dataset.username,role=t.dataset.role,active=t.dataset.active==='true';
    showAdminModal('Edit User',[
      {name:'username',label:'Username',type:'text',val:uname},
      {name:'role',label:'Role',type:'select',val:role,options:[{value:'investigator',label:'Investigator'},{value:'admin',label:'Admin'}]},
      {name:'is_active',label:'Active',type:'select',val:active?'true':'false',options:[{value:'true',label:'Yes'},{value:'false',label:'No'}]}
    ],async f=>{
      const fd=new FormData(f.target);
      await API.put('/auth/admin/users/'+id,{
        username:fd.get('username'),
        role:fd.get('role'),
        is_active:fd.get('is_active')==='true'
      });
      renderAdmin();
    });
  }
  if(t.classList.contains('admin-reset-pw')){
    const id=parseInt(t.dataset.id),uname=t.dataset.username;
    showAdminModal('Reset Password for '+uname,[
      {name:'new_password',label:'New Password (8+ chars)',type:'password',val:''}
    ],async f=>{
      const fd=new FormData(f.target);
      await API.put('/auth/admin/users/'+id+'/password',{new_password:fd.get('new_password')});
      renderAdmin();
    });
  }
  if(t.classList.contains('admin-delete')){
    const id=parseInt(t.dataset.id),uname=t.dataset.username;
    if(!confirm('Delete user "'+uname+'"?'))return;
    API.del('/auth/admin/users/'+id).then(renderAdmin).catch(err=>alert('Delete failed: '+err.message));
  }
});
D.adminCreateBtn.addEventListener('click',()=>{
  showAdminModal('Create User',[
    {name:'username',label:'Username',type:'text',val:''},
    {name:'password',label:'Password (8+ chars)',type:'password',val:''},
    {name:'role',label:'Role',type:'select',val:'investigator',options:[{value:'investigator',label:'Investigator'},{value:'admin',label:'Admin'}]}
  ],async f=>{
    const fd=new FormData(f.target);
    await API.post('/auth/admin/users',{
      username:fd.get('username'),
      password:fd.get('password'),
      role:fd.get('role')
    });
    renderAdmin();
  });
});

// ====== EVIDENCE EXPORT ======
D.exportBtn.addEventListener('click',()=>{
  const now=new Date().toISOString().slice(0,19).replace('T',' ');
  let report='';
  report+='=== CDR/IPDR Investigation Report ===\n';
  report+='Generated: '+now+'\n';
  report+='User: '+(state.auth.user?state.auth.user.username:'Unknown')+'\n';
  report+='Case: '+(D.caseSelector.options[D.caseSelector.selectedIndex]?.text||'None')+'\n';
  report+='\n--- Summary ---\n';
  report+='Total Records: '+allRows.length+'\n';
  report+='CDR: '+state.cdr.length+', IPDR: '+state.ipdr.length+'\n';
  report+='Towers: '+state.towers.length+'\n';
  report+='Subjects: '+state.subjects.length+'\n';

  const timeSorted=allRows.filter(r=>r.ts).map(r=>new Date(r.ts).getTime());
  if(timeSorted.length){
    report+='Date Range: '+new Date(Math.min(...timeSorted)).toLocaleString()+' to '+new Date(Math.max(...timeSorted)).toLocaleString()+'\n';
    const spanMs=Math.max(...timeSorted)-Math.min(...timeSorted);
    report+='Span: '+Math.round(spanMs/3600000)+' hours\n';
  }

  const allSvc=[],allProt=[],allCnter=[];
  allRows.forEach(r=>{
    if(r.svc)allSvc.push(r.svc);
    if(r.prot)allProt.push(r.prot);
    if(r.cnt)allCnter.push(r.cnt);
  });
  const topSvc=Object.entries(allRows.reduce((a,r)=>{const s=recordSvcAttr(r)||r.svc||'Unknown';a[s]=(a[s]||0)+1;return a},{}))
    .sort((a,b)=>b[1]-a[1]).slice(0,10);
  if(topSvc.length){
    report+='\nTop Attributed Services:\n';
    topSvc.forEach(([s,c])=>report+='  '+s+': '+c+'\n');
  }
  const topCnt=Object.entries(allCnter.reduce((a,c)=>{a[c]=(a[c]||0)+1;return a},{})).sort((a,b)=>b[1]-a[1]).slice(0,10);
  if(topCnt.length){
    report+='\nTop Contacts:\n';topCnt.forEach(([c,n])=>report+='  '+c+': '+n+' interactions\n');
  }

  // Geofence
  if(geoFenceDrawn&&geoFenceLayer){
    const fencePts=geoFenceLayer.getLatLngs();const coords=Array.isArray(fencePts[0])?fencePts[0]:fencePts;
    report+='\n--- Geofence ---\n';
    coords.forEach(p=>report+='  '+p.lat.toFixed(4)+', '+p.lng.toFixed(4)+'\n');
  }

  // ===== SUBJECT PROFILES =====
  report+='\n--- Subject Profiles ---\n';
  const subData=state.subjects.slice(0,50).map(sub=>{
    const rows=allRows.filter(r=>r.sub===sub);
    const contacts=[...new Set(rows.map(r=>r.cnt).filter(Boolean))];
    const svcs={};rows.forEach(r=>{const a=recordSvcAttr(r)||r.svc||'Unknown';svcs[a]=(svcs[a]||0)+1});
    const topS=Object.entries(svcs).sort((a,b)=>b[1]-a[1]).slice(0,5);
    const first=rows.find(r=>r.ts);const last=rows.slice().reverse().find(r=>r.ts);
    const tows=[...new Set(rows.map(r=>r.tow).filter(Boolean))];
    const apns=[...new Set(rows.map(r=>r.apn).filter(Boolean))];
    const rats=[...new Set(rows.map(r=>r.rat).filter(Boolean))];
    const sessionCount=reconstructSessions(sub).length;
    const meetingsSub=detectMeetings({subject:sub});
    return{name:sub,count:rows.length,contacts:contacts.length,topSvc:topS,first,last,tows,apns,rats,sessionCount,meetings:meetingsSub.length,meetingsHigh:meetingsSub.filter(m=>m.gapLevel==='high').length};
  }).sort((a,b)=>b.count-a.count);

  subData.forEach(p=>{
    report+='\nSubject: '+p.name+'\n';
    report+='  Records: '+p.count+' | Sessions: '+p.sessionCount+' | Contacts: '+p.contacts;
    if(p.meetings)report+=' | Meetings: '+p.meetings+' ('+p.meetingsHigh+' high conf)';
    report+='\n';
    if(p.topSvc.length)report+='  Top Services: '+p.topSvc.map(([s,c])=>s+' ('+c+')').join(', ')+'\n';
    if(p.tows.length)report+='  Towers: '+p.tows.join(', ')+'\n';
    if(p.apns.length)report+='  APNs: '+p.apns.join(', ')+'\n';
    if(p.rats.length)report+='  RATs: '+p.rats.join(', ')+'\n';
    if(p.meetings&&p.meetingsHigh){
      const topMeetings=detectMeetings({subject:p.name}).filter(m=>m.gapLevel==='high').slice(0,5);
      topMeetings.forEach(m=>report+='  + Meeting: '+m.time.toLocaleString()+' with '+m.subB+' at '+m.tow+' (gap:'+m.gap+'m)\n');
    }
    if(p.first)report+='  First seen: '+new Date(p.first).toLocaleString()+'\n';
    if(p.last)report+='  Last seen: '+new Date(p.last).toLocaleString()+'\n';
    // Sessions for this subject
    const sessions=reconstructSessions(p.name);
    if(sessions.length){
      sessions.slice(0,5).forEach(s=>{
        const svcName=s.primary?s.primary.service:(s.service||'Unknown');
        const disLabel=s.activityLabel||s.activity||'';
        report+='    + Session: '+svcName+(s.serviceConfidence?' ('+Math.round(s.serviceConfidence)+'%)':'')+' '+disLabel+
          (s.start?' ['+new Date(s.start).toLocaleString()+']':'')+
          (s.duration?' dur:'+s.duration+'s':'')+'\n';
      });
      if(sessions.length>5)report+='    + ... and '+(sessions.length-5)+' more sessions\n';
    }
  });
  if(state.subjects.length>50)report+='\n... and '+(state.subjects.length-50)+' more subjects\n';

  // ===== SESSIONS (full) =====
  report+='\n--- All Reconstructed Sessions ---\n';
  let sessionCount=0;
  state.subjects.forEach(entity=>{
    const sessions=reconstructSessions(entity);
    sessions.forEach(s=>{
      if(++sessionCount>200)return;
      const svcName=s.primary?s.primary.service:(s.service||'Unknown');
      const disLabel=s.activityLabel||s.activity||'';
      report+='Subject: '+entity+' | '+svcName+(s.serviceConfidence?' ('+Math.round(s.serviceConfidence)+'%)':'')+' '+disLabel+'\n';
      if(s.start||s.end)report+='  Time: '+(s.start?new Date(s.start).toLocaleString():'?')+' — '+(s.end?new Date(s.end).toLocaleString():'?')+'\n';
      if(s.duration)report+='  Duration: '+s.duration+'s\n';
      if(s.cnt)report+='  Counterpart: '+s.cnt+'\n';
      if(s.tow)report+='  Tower: '+s.tow+'\n';
      if(s.evidence&&s.evidence.length)report+='  Evidence: '+s.evidence.join('; ')+'\n';
      if(s.candidates&&s.candidates.length){
        report+='  Candidates:\n';
        s.candidates.slice(0,5).forEach((ca,i)=>{
          report+='    '+(i+1)+'. '+ca.service+(ca.activity?' - '+ca.activity:'')+(ca.score?' ['+Math.round(ca.score)+'%]':'')+'\n';
        });
      }
    });
  });
  if(sessionCount>200)report+='\n... and '+(sessionCount-200)+' more sessions\n';

  // ===== RAW RECORDS (only non-empty fields per record) =====
  if(state.cdr.length){
    const cdrKeys=['ts','sub','cnt','dur','dir','tow','cll','svc','tec','car','imei','imsi','roam','lac','lat','lng','cell','msisdn'];
    report+='\n--- CDR Records ---\n';
    state.cdr.slice(0,200).forEach((r,i)=>{
      const vals=cdrKeys.filter(k=>r[k]).map(k=>k+'='+r[k]).join(' ');
      if(vals)report+='  #'+(i+1)+': '+vals+'\n';
    });
    if(state.cdr.length>200)report+='  ... and '+(state.cdr.length-200)+' more\n';
  }

  if(state.ipdr.length){
    const ipdrKeys=['ts','sub','cnt','prot','sport','dport','svc','tow','bytesUp','bytesDn','dur','rat','apn','lac','lat','lng'];
    report+='\n--- IPDR Records ---\n';
    state.ipdr.slice(0,200).forEach((r,i)=>{
      const vals=ipdrKeys.filter(k=>r[k]).map(k=>k+'='+r[k]).join(' ');
      if(vals)report+='  #'+(i+1)+': '+vals+'\n';
    });
    if(state.ipdr.length>200)report+='  ... and '+(state.ipdr.length-200)+' more\n';
  }

  // ===== TOWERS =====
  if(state.towers.length){
    report+='\n--- Towers ---\n';
    state.towers.forEach(t=>{
      const parts=[t.tower_id||t.id||'?'];
      if(t.name)parts.push(t.name);
      if(t.lat)parts.push('Lat:'+t.lat);
      if(t.lng)parts.push('Lng:'+t.lng);
      if(t.tech)parts.push(t.tech);
      if(t.range)parts.push(t.range+'m');
      report+='  '+parts.join(' | ')+'\n';
    });
  }

  // ===== MEETING EVIDENCE =====
  const allMeetingsReport=detectMeetings({allPairs:true});
  if(allMeetingsReport.length){
    report+='\n--- Meeting Evidence ---\n';
    report+='Total meetings detected: '+allMeetingsReport.length+'\n';
    const h=allMeetingsReport.filter(m=>m.gapLevel==='high').length;
    const m=allMeetingsReport.filter(m=>m.gapLevel==='medium').length;
    const l=allMeetingsReport.filter(m=>m.gapLevel==='low').length;
    report+='High confidence: '+h+' | Medium: '+m+' | Low: '+l+'\n';
    allMeetingsReport.sort((a,b)=>b.score-a.score).slice(0,30).forEach(mt=>{
      report+='  '+mt.time.toLocaleString()+' | '+mt.subA+' & '+mt.subB+' | '+mt.tow+' | gap:'+mt.gap+'m | '+mt.gapLevel.toUpperCase()+' | score:'+mt.score+'\n';
      if(mt.subAEvent||mt.subBEvent)report+='    Events: ['+mt.subA+'] '+mt.subAEvent+' | ['+mt.subB+'] '+mt.subBEvent+'\n';
      if(mt.evidence&&mt.evidence.length)report+='    Why: '+mt.evidence.join('; ')+'\n';
      report+='    Encounters: '+mt.encounterCount+' same-tower events\n';
    });
    if(allMeetingsReport.length>30)report+='  ... and '+(allMeetingsReport.length-30)+' more\n';
  }

  report+='\n--- End of Report ---\n';

  const blob=new Blob([report],{type:'text/plain;charset=utf-8'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);
  a.download='investigation_report_'+now.replace(/[:\s]/g,'_')+'.txt';
  a.click();URL.revokeObjectURL(a.href);
});

// ====== SERVICE ATTRIBUTION TAB ======
let svcCorrData=null;
function renderServicesTab(){
  if(!allRows.length){D.svcCardGrid.innerHTML='<div style="padding:40px;text-align:center;color:var(--muted)">No data loaded.</div>';D.svcBursts.innerHTML='';D.svcCount.textContent='0 services';return}
  // Build service data from sessions
  const svcMap=new Map();// serviceName -> {sessions, subjects, contacts, totalDur, confidences, subjectsSet, contactsSet}
  const allSubjects=[...new Set(allRows.map(r=>r.sub).filter(Boolean))];
  allSubjects.forEach(sub=>{
    const sessions=reconstructSessions(sub);
    sessions.forEach(s=>{
      const sName=s.primary?s.primary.service:(s.service||'Unknown');
      if(!svcMap.has(sName))svcMap.set(sName,{name:sName,sessions:[],subjects:new Set(),contacts:new Set(),totalDur:0,confidences:[],towers:new Set(),ports:new Set(),protocols:new Set(),services:new Map()});
      const d=svcMap.get(sName);
      d.sessions.push({...s,subject:sub});
      d.subjects.add(sub);
      if(s.cnt)d.contacts.add(s.cnt);
      if(s.duration)d.totalDur+=s.duration;
      if(s.serviceConfidence)d.confidences.push(s.serviceConfidence);
      if(s.tow)d.towers.add(s.tow);
      // Track all candidate services under this bucket
      if(s.candidates)s.candidates.forEach(ca=>{
        const cur=d.services.get(ca.service)||{count:0,score:0};
        cur.count++;
        cur.score+=ca.score||0;
        d.services.set(ca.service,cur);
      });
      // Track evidence types
      if(s.evidence)s.evidence.forEach(ev=>{
        if(ev.includes('IP range')||ev.includes('DNS IP')){if(!d._ipEvidence)d._ipEvidence=0;d._ipEvidence++}
        if(ev.includes('Port')){if(!d._portEvidence)d._portEvidence=0;d._portEvidence++}
        if(ev.includes('Distinctive')){if(!d._distinctive)d._distinctive=0;d._distinctive++}
        if(ev.includes('Signature')){if(!d._sigEvidence)d._sigEvidence=0;d._sigEvidence++}
      });
    });
  });
  // Convert to array and sort by session count
  let services=[...svcMap.values()].sort((a,b)=>b.sessions.length-a.sessions.length);
  svcCorrData=services;
  // Apply filters
  const q=D.svcSearchInput.value.trim().toLowerCase();
  const minConf=parseInt(D.svcMinConf.value);
  if(q)services=services.filter(s=>s.name.toLowerCase().includes(q));
  if(minConf>0)services=services.filter(s=>{
    const avgConf=s.confidences.length?s.confidences.reduce((a,c)=>a+c,0)/s.confidences.length:0;
    return avgConf>=minConf;
  });
  D.svcCount.textContent=services.length+' services';
  // Render bursts
  renderServiceBursts();
  // Render cards
  D.svcCardGrid.innerHTML=services.map(s=>renderServiceCard(s)).join('');
}
function renderServiceBursts(){
  // Burst detection: per-subject daily activity vs rolling average
  const bursts=[];
  const subDays=new Map();// subject -> {date:count}
  allRows.forEach(r=>{
    if(!r.ts||!r.sub)return;
    const d=new Date(r.ts).toLocaleDateString();
    if(!subDays.has(r.sub))subDays.set(r.sub,new Map());
    const days=subDays.get(r.sub);
    days.set(d,(days.get(d)||0)+1);
  });
  subDays.forEach((days,sub)=>{
    const counts=[...days.values()];
    if(counts.length<3)return;
    const avg=counts.reduce((a,c)=>a+c,0)/counts.length;
    const threshold=Math.max(avg*3,10);
    days.forEach((count,date)=>{
      if(count>=threshold){
        const sessionsToday=allRows.filter(r=>r.sub===sub&&r.ts&&new Date(r.ts).toLocaleDateString()===date);
        bursts.push({subject:sub,date,count,avg:Math.round(avg),sessions:sessionsToday.length});
      }
    });
  });
  bursts.sort((a,b)=>b.count-a.count);
  if(!bursts.length){D.svcBursts.innerHTML='';return}
  D.svcBursts.innerHTML='<span style="font-size:0.78rem;font-weight:600;color:var(--danger);display:flex;align-items:center;gap:4px">&#9888; Activity Spikes Detected</span>'+
    bursts.slice(0,6).map(b=>`<div class="svc-burst-card">
      <span class="burst-icon">&#128200;</span>
      <span><span class="burst-date">${esc(b.date)}</span> — <strong>${esc(b.subject)}</strong></span>
      <span class="burst-detail">${b.count} records (avg ${b.avg}) &middot; ${b.sessions} sessions</span>
    </div>`).join('');
  if(bursts.length>6)D.svcBursts.innerHTML+='<span style="font-size:0.72rem;color:var(--muted);align-self:center">+'+(bursts.length-6)+' more</span>';
}
function renderServiceCard(svc){
  const avgConf=svc.confidences.length?Math.round(svc.confidences.reduce((a,c)=>a+c,0)/svc.confidences.length):0;
  const topCandidates=[...svc.services.entries()].sort((a,b)=>b[1].score-b[1].score).slice(0,5);
  const c=svcColor(svc.name);
  const durStr=svc.totalDur>=3600?Math.floor(svc.totalDur/3600)+'h '+Math.round((svc.totalDur%3600)/60)+'m':
    svc.totalDur>=60?Math.floor(svc.totalDur/60)+'m '+Math.round(svc.totalDur%60)+'s':svc.totalDur+'s';
  const initials=svc.name.replace(/[^A-Z0-9]/g,'').slice(0,2)||svc.name.slice(0,2).toUpperCase();
  const evidences=[
    {label:'IP/Infrastructure Match',pass:svc._ipEvidence>0||(svc.name!=='Unknown'&&svc.name!=='TCP'&&svc.name!=='UDP')},
    {label:'Port/Protocol Match',pass:svc._portEvidence>0||svc.protocols.size>0},
    {label:'Distinctive Indicators',pass:svc._distinctive>0},
    {label:'Session Pattern Match',pass:svc.name!=='Unknown'},
    {label:'Multiple Subjects',pass:svc.subjects.size>1},
    {label:'Clear Attribution',pass:topCandidates.length>1?false:true},
  ];
  const passCount=evidences.filter(e=>e.pass).length;
  const evidenceScore=Math.round((passCount/evidences.length)*100);
  const evColor=evidenceScore>=67?'var(--success)':evidenceScore>=34?'var(--warn)':'var(--danger)';
  return `<div class="svc-card">
    <div class="svc-card-head" style="border-left:3px solid ${c}" onclick="this.classList.toggle('open');this.nextElementSibling.style.display=this.classList.contains('open')?'block':'none'">
      <span class="svc-badge" style="background:${c}">${esc(initials)}</span>
      <span class="svc-name">${esc(svc.name)}</span>
      <span class="svc-stats">
        <span>${svc.sessions.length} sessions</span>
        <span>${durStr}</span>
        <span>${svc.subjects.size} subjects</span>
        <span>${svc.contacts.size} contacts</span>
      </span>
      <span class="svc-conf-badge" style="background:${avgConf>=70?'rgba(90,159,126,0.15)':avgConf>=40?'rgba(212,160,23,0.15)':'rgba(0,0,0,0.04)'};color:${avgConf>=70?'var(--success)':avgConf>=40?'var(--warn)':'var(--muted)'}">${avgConf}%</span>
      <span class="svc-arrow">&#9654;</span>
    </div>
    <div class="svc-card-body">
      <div class="svc-card-body-inner">
        <div class="svc-section-label">Evidence Scorecard</div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px">
          <div style="min-width:200px;flex:2">
            <div class="svc-evidences">
              ${evidences.map(e=>`<div class="svc-evidence-row ${e.pass?'pass':'fail'}">
                <span class="ev-icon ${e.pass?'pass':'fail'}">${e.pass?'&#10003;':'&#10007;'}</span>
                <span>${e.label}</span>
              </div>`).join('')}
            </div>
            <div class="svc-evidence-meter"><div class="svc-evidence-meter-fill" style="width:${evidenceScore}%;background:${evColor}"></div></div>
            <div style="font-size:0.68rem;color:var(--muted);margin-top:3px">${passCount}/${evidences.length} checks passed</div>
          </div>
          ${topCandidates.length?`<div style="min-width:160px;flex:1">
            <div style="font-size:0.7rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Alternative Services</div>
            <div class="svc-alt-grid">
              ${topCandidates.map(([n,data],i)=>{
                const maxScore=topCandidates[0][1].score;
                const avgScore=Math.round(data.score/data.count);
                const pct=data.score>0?Math.round((data.score/maxScore)*100):0;
                const barColor=avgScore>=70?'var(--success)':avgScore>=40?'var(--warn)':'var(--muted)';
                return `<div class="svc-alt-row">
                  <span class="svc-alt-rank">${i+1}.</span>
                  <span class="svc-alt-name">${esc(n)}</span>
                  <span class="svc-alt-bar" style="width:${Math.max(pct*0.6,3)}px;background:${barColor}" title="${data.count} sessions, avg ${avgScore}%"></span>
                  <span class="svc-alt-pct">${avgScore}%</span>
                </div>`;
              }).join('')}
            </div>
          </div>`:''}
        </div>
        <div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:14px">
          ${svc.subjects.size?`<div style="min-width:140px;flex:1">
            <div style="font-size:0.7rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Subjects (${svc.subjects.size})</div>
            <div class="svc-list-grid">${[...svc.subjects].slice(0,12).map(s=>'<div class="svc-list-item clickable" onclick="showProfile(\''+esc(s)+'\')">'+esc(s)+'</div>').join('')}</div>
          </div>`:''}
          ${svc.towers.size?`<div style="min-width:120px;flex:1">
            <div style="font-size:0.7rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Towers (${svc.towers.size})</div>
            <div class="svc-list-grid">${[...svc.towers].slice(0,10).map(t=>'<div class="svc-list-item">'+esc(t)+'</div>').join('')}</div>
          </div>`:''}
          ${svc.contacts.size?`<div style="min-width:140px;flex:1">
            <div style="font-size:0.7rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Contacts (${svc.contacts.size})</div>
            <div class="svc-list-grid">${[...svc.contacts].slice(0,10).map(c=>'<div class="svc-list-item clickable" onclick="showProfile(\''+esc(c)+'\')">'+esc(c)+'</div>').join('')}</div>
          </div>`:''}
        </div>
        <div style="margin-top:4px">
          <div style="font-size:0.7rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Recent Sessions (${Math.min(svc.sessions.length,20)})</div>
          <div class="svc-session-list">
            ${svc.sessions.slice(0,20).map(s=>{
              return `<div class="svc-session-row">
                <span class="ss-time">${s.start?new Date(s.start).toLocaleString():'?'}</span>
                <span class="ss-subj" onclick="showProfile('${esc(s.subject)}')">${esc(s.subject)}</span>
                <span class="ss-cnt">${esc(s.cnt||s.activityLabel||s.activity||'')}</span>
                <span class="ss-dur">${s.duration?s.duration+'s':''}</span>
                <span class="ss-conf" style="color:${s.serviceConfidence>=70?'var(--success)':s.serviceConfidence>=40?'var(--warn)':'var(--muted)'}">${s.serviceConfidence?Math.round(s.serviceConfidence)+'%':''}</span>
              </div>`;
            }).join('')}
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

// ====== CROSS-SUBJECT CORRELATION TAB ======
function renderCorrelationTab(){
  // Populate subject dropdowns
  const subs=state.subjects.filter(s=>s!==(D.corrSubB.value||''));
  const subsB=state.subjects.filter(s=>s!==(D.corrSubA.value||''));
  const curA=D.corrSubA.value;
  D.corrSubA.innerHTML='<option value="">Select subject A...</option>'+subs.map(s=>`<option value="${esc(s)}"${s===curA?' selected':''}>${esc(s)}</option>`).join('');
  const curB=D.corrSubB.value;
  D.corrSubB.innerHTML='<option value="">Select subject B...</option>'+subsB.map(s=>`<option value="${esc(s)}"${s===curB?' selected':''}>${esc(s)}</option>`).join('');
  D.corrGoBtn.disabled=!(D.corrSubA.value&&D.corrSubB.value);
}
function runCorrelation(){
  const a=D.corrSubA.value,b=D.corrSubB.value;
  if(!a||!b){D.corrResults.innerHTML='<div class="corr-empty">Select two subjects and click Compare.</div>';return}
  const rowsA=allRows.filter(r=>r.sub===a),rowsB=allRows.filter(r=>r.sub===b);
  if(!rowsA.length||!rowsB.length){D.corrResults.innerHTML='<div class="corr-empty">One or both subjects have no records.</div>';return}
  // Common towers
  const towsA=new Set(rowsA.map(r=>r.tow).filter(Boolean));
  const towsB=new Set(rowsB.map(r=>r.tow).filter(Boolean));
  const commonTows=[...towsA].filter(t=>towsB.has(t));
  // Common contacts
  const cntsA=new Set(rowsA.map(r=>r.cnt).filter(Boolean));
  const cntsB=new Set(rowsB.map(r=>r.cnt).filter(Boolean));
  const commonCnts=[...cntsA].filter(c=>cntsB.has(c));
  // Common services
  const svcsA={};rowsA.forEach(r=>{const s=recordSvcAttr(r)||r.svc||'Unknown';svcsA[s]=(svcsA[s]||0)+1});
  const svcsB={};rowsB.forEach(r=>{const s=recordSvcAttr(r)||r.svc||'Unknown';svcsB[s]=(svcsB[s]||0)+1});
  const commonSvcs=Object.keys(svcsA).filter(s=>svcsB[s]);
  // All services union
  const allSvcKeys=new Set([...Object.keys(svcsA),...Object.keys(svcsB)]);
  // Common sessions (reconstructed)
  const sA=reconstructSessions(a),sB=reconstructSessions(b);
  // Time overlaps: both subjects active within 1 hour
  const overlapWindows=[];
  const timesA=rowsA.filter(r=>r.ts).map(r=>new Date(r.ts).getTime()).sort((x,y)=>x-y);
  const timesB=rowsB.filter(r=>r.ts).map(r=>new Date(r.ts).getTime()).sort((x,y)=>x-y);
  timesA.forEach(tA=>{
    const nearB=timesB.filter(tB=>Math.abs(tA-tB)<3600000);
    nearB.forEach(tB=>{
      const start=new Date(Math.min(tA,tB)),end=new Date(Math.max(tA,tB));
      const label=`${start.toLocaleString()} — ${end.toLocaleString()} (${Math.round(Math.abs(tA-tB)/60000)}m gap)`;
      if(!overlapWindows.find(o=>o.label===label))overlapWindows.push({label,start,end});
    });
  });
  overlapWindows.sort((a,b)=>a.start-b.start).slice(0,20);
  // Common towers with map
  const commonTowerData=state.towers.filter(t=>commonTows.includes(t.tower_id||t.id));
  // Meeting detection via unified engine
  const meetings=detectMeetings({rowsA,rowsB});
  window.meetingStore=window.meetingStore||{};const msKey=a+'|'+b;window.meetingStore[msKey]=meetings;
  // -- Weighted Correlation Score --
  const weights={contact:5,service:2,tower:1,session:4};
  let weightedScore=0;
  if(commonCnts.length)weightedScore+=commonCnts.length*weights.contact;
  if(commonSvcs.length)weightedScore+=commonSvcs.length*weights.service;
  if(commonTows.length)weightedScore+=commonTows.length*weights.tower;
  if(meetings.length)weightedScore+=meetings.length*weights.session;
  const maxPossible=Math.max(1,Math.min(rowsA.length,rowsB.length)*weights.contact+Object.keys(svcsA).length*weights.service+towsA.size*weights.tower+meetings.length*weights.session);
  const correlationPct=Math.min(100,Math.round((weightedScore/maxPossible)*100));
  // Build HTML
  let html='';
  // Correlation score card
  html+=`<div class="corr-card" style="grid-column:1/-1;border-color:${correlationPct>=50?'var(--danger)':correlationPct>=25?'var(--warn)':'var(--muted)'}">
    <h4 style="color:${correlationPct>=50?'var(--danger)':correlationPct>=25?'var(--warn)':'var(--muted)'}">
      Correlation Score: ${correlationPct}%
      <span style="font-size:0.7rem;font-weight:400;color:var(--muted);margin-left:8px">
        weighted: contact—${weights.contact} | service—${weights.service} | tower—${weights.tower} | meeting—${weights.session}
      </span>
    </h4>
    <div style="display:flex;gap:12px;font-size:0.72rem;color:var(--muted);flex-wrap:wrap">
      <span>${commonCnts.length} shared contacts (+${commonCnts.length*weights.contact})</span>
      <span>${commonSvcs.length} shared services (+${commonSvcs.length*weights.service})</span>
      <span>${commonTows.length} shared towers (+${commonTows.length*weights.tower})</span>
      <span>${meetings.length} meetings (+${meetings.length*weights.session})</span>
    </div>
  </div>`;
  // Meeting card - MOST PROMINENT
  const mHigh=meetings.filter(m=>m.gapLevel==='high').length,mMed=meetings.filter(m=>m.gapLevel==='medium').length,mLow=meetings.filter(m=>m.gapLevel==='low').length;
  html+=`<div class="corr-card" style="grid-column:1/-1;border-color:var(--danger);background:rgba(185,74,72,0.04)">
    <h4 style="color:var(--danger)">&#128680; Meeting Confidence: ${meetings.length?'<span style="color:'+(mHigh?'var(--success)':mMed?'var(--warn)':'var(--muted)')+'">'+(mHigh>mMed?'High':mMed>0?'Medium':'Low')+'</span>':'None'}<span class="corr-count" style="color:var(--danger)">${meetings.length} events</span></h4>
    <div style="font-size:0.72rem;color:var(--muted);margin:-4px 0 8px">${esc(a)} & ${esc(b)} — ${mHigh} high, ${mMed} med, ${mLow} low confidence</div>
    ${meetings.length?meetings.slice(0,15).map((m,meetingIdx)=>{
      const confLabel=m.gapLevel==='high'?'High Confidence':m.gapLevel==='medium'?'Medium Confidence':'Low Confidence';
      const confColor=m.gapLevel==='high'?'var(--success)':m.gapLevel==='medium'?'var(--warn)':'var(--muted)';
      return `<div class="ct-block" style="border-left:3px solid ${confColor};display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 10px">
        <span style="font-weight:600">${esc(m.time.toLocaleString())}</span>
        <span style="font-size:0.72rem;color:${confColor};font-weight:600">${confLabel}</span>
        <span style="font-size:0.72rem;color:var(--muted)">gap: ${m.gap}m</span>
        <span style="font-size:0.72rem;color:var(--muted)">at ${esc(m.tow)}</span>
        <span style="font-size:0.72rem;color:var(--muted)">score: ${m.score} (${m.encounterCount} encounters)</span>
        <span style="font-size:0.7rem;color:var(--muted)">${esc(a)}: ${m.subAEvent}</span>
        <span style="font-size:0.7rem;color:var(--muted)">${esc(b)}: ${m.subBEvent}</span>
        ${m.evidence&&m.evidence.length?`<span style="font-size:0.68rem;color:var(--muted);width:100%">Why: ${m.evidence.join('; ')}</span>`:''}
        <button onclick="showMeetingOverlay('${esc(a+'|'+b)}',${meetingIdx})" style="background:none;border:1px solid var(--line);color:var(--accent);padding:2px 8px;border-radius:4px;cursor:pointer;font-size:0.65rem">View</button>
      </div>`;
    }).join('')+(meetings.length>15?'<div style="font-size:0.72rem;color:var(--muted);padding-top:4px">... and '+(meetings.length-15)+' more</div>':'')
      :'<div style="font-size:0.75rem;color:var(--muted)">No co-location events detected.</div>'}
  </div>`;
  // Overview card
  const sessionsA=sA.length,sessionsB=sB.length;
  html+=`<div class="corr-card" style="grid-column:1/-1">
    <h4>Correlation Overview: ${esc(a)} ? ${esc(b)}</h4>
    <div style="display:flex;gap:20px;font-size:0.78rem">
      <div><strong>${esc(a)}</strong>: ${rowsA.length} records, ${sessionsA} sessions, ${cntsA.size} contacts</div>
      <div><strong>${esc(b)}</strong>: ${rowsB.length} records, ${sessionsB} sessions, ${cntsB.size} contacts</div>
      <div style="color:var(--accent);font-weight:600">${commonTows.length} shared towers &middot; ${commonCnts.length} shared contacts &middot; ${commonSvcs.length} shared services</div>
    </div>
  </div>`;
  // Common towers card
  html+=`<div class="corr-card">
    <h4>&#128205; Common Towers <span class="corr-count">${commonTows.length}</span></h4>
    ${commonTows.length?commonTows.map(t=>`<div class="corr-item"><span class="corr-badge" style="background:var(--accent)"></span>${esc(t)}</div>`).join(''):
      '<div style="font-size:0.75rem;color:var(--muted)">No towers in common.</div>'}
  </div>`;
  // Common contacts card
  html+=`<div class="corr-card">
    <h4>&#128101; Common Contacts <span class="corr-count">${commonCnts.length}</span></h4>
    ${commonCnts.length?commonCnts.map(c=>`<div class="corr-item"><span class="corr-badge" style="background:var(--warn)"></span>
      <span style="cursor:pointer;color:var(--accent)" onclick="showProfile('${esc(c)}')">${esc(c)}</span></div>`).join(''):
      '<div style="font-size:0.75rem;color:var(--muted)">No contacts in common.</div>'}
  </div>`;
  // Common services card
  html+=`<div class="corr-card">
    <h4>&#128268; Common Services <span class="corr-count">${commonSvcs.length}</span></h4>
    ${commonSvcs.length?commonSvcs.sort((x,y)=>svcsA[y]-svcsA[x]).map(s=>`<div class="corr-item">
      <span class="corr-badge" style="background:${svcColor(s)}"></span>
      <span style="flex:1">${esc(s)}</span>
      <span style="font-size:0.7rem;color:var(--muted)">A: ${svcsA[s]} | B: ${svcsB[s]}</span>
    </div>`).join(''):'<div style="font-size:0.75rem;color:var(--muted)">No services in common.</div>'}
  </div>`;
  // Service comparison card
  html+=`<div class="corr-card">
    <h4>&#128202; Service Comparison</h4>
    <div style="font-size:0.75rem;display:grid;grid-template-columns:1fr 60px 60px;gap:3px">
      <div style="font-weight:600;color:var(--muted);padding:4px 0;border-bottom:1px solid var(--line)">Service</div>
      <div style="font-weight:600;color:var(--muted);padding:4px 0;border-bottom:1px solid var(--line);text-align:right">${esc(a)}</div>
      <div style="font-weight:600;color:var(--muted);padding:4px 0;border-bottom:1px solid var(--line);text-align:right">${esc(b)}</div>
      ${[...allSvcKeys].sort().map(s=>{
        const c=svcColor(s);
        const vA=svcsA[s]||0,vB=svcsB[s]||0;
        const barA=Math.min(40,vA*2),barB=Math.min(40,vB*2);
        return `<div style="display:contents">
          <div style="padding:3px 0"><span class="svc-badge" style="background:${c};font-size:0.65rem;padding:1px 6px">${esc(s)}</span></div>
          <div style="padding:3px 0;text-align:right"><span style="background:${c}22;padding:1px 4px;border-radius:3px;font-size:0.7rem;display:inline-block;min-width:${barA}px">${vA}</span></div>
          <div style="padding:3px 0;text-align:right"><span style="background:${c}22;padding:1px 4px;border-radius:3px;font-size:0.7rem;display:inline-block;min-width:${barB}px">${vB}</span></div>
        </div>`;
      }).join('')}
    </div>
  </div>`;
  // Time overlaps card
  html+=`<div class="corr-card corr-timeline">
    <h4>&#128339; Overlapping Time Windows <span class="corr-count">${overlapWindows.length}</span></h4>
    ${overlapWindows.length?overlapWindows.slice(0,10).map(o=>`<div class="ct-block">${esc(o.label)}</div>`).join('')+
      (overlapWindows.length>10?`<div style="font-size:0.72rem;color:var(--muted);padding-top:4px">... and ${overlapWindows.length-10} more</div>`:'')
      :'<div style="font-size:0.75rem;color:var(--muted)">No overlapping time windows found.</div>'}
  </div>`;
  D.corrResults.innerHTML=html;
}
// Wire up Services tab
D.svcSearchInput.addEventListener('input',renderServicesTab);
D.svcMinConf.addEventListener('change',renderServicesTab);
// Wire up Correlation tab
D.corrSubA.addEventListener('change',()=>{renderCorrelationTab()});
D.corrSubB.addEventListener('change',()=>{renderCorrelationTab()});
D.corrGoBtn.addEventListener('click',runCorrelation);
D.corrSwapBtn.addEventListener('click',()=>{
  const a=D.corrSubA.value,b=D.corrSubB.value;
  if(!a&&!b)return;
  // Temp swap via value change
  const optsA=[...D.corrSubA.options];D.corrSubA.value='';D.corrSubB.value='';
  // Set swapped via render which filters each other out
  D.corrSubA.value='';D.corrSubB.value='';
  // Manually set and re-render  
  const subs=state.subjects;
  // Quick swap: just exchange the selected values directly
  D.corrSubA.innerHTML='<option value="">Select subject A...</option>'+subs.map(s=>`<option value="${esc(s)}"${s===b?' selected':''}>${esc(s)}</option>`).join('');
  D.corrSubB.innerHTML='<option value="">Select subject B...</option>'+subs.map(s=>`<option value="${esc(s)}"${s===a?' selected':''}>${esc(s)}</option>`).join('');
  D.corrGoBtn.disabled=!(a&&b);
});

// ====== BOOTSTRAP ======
async function bootstrap(){
  await loadCases();
  try{await loadCaseData();}catch(e){console.error(e)}
  D.loginPass.value='';
  resetIdle();
  D.importStatus.textContent='Data loaded from previous session. Use Reset Case to start fresh.';
  healthTimer=setInterval(async()=>{try{await API.get('/auth/me')}catch(e){doLogout()}},HEALTH_MS);
}

async function resetCase(){
  if(!confirm('Reset all case data? This will delete all CDR, IPDR, and Tower records.'))return;
  D.importStatus.textContent='Resetting case data...';
  const q=activeCaseId?'?case_id='+activeCaseId:'';
  try{await API.del('/records/reset'+q);D.importStatus.textContent='Case reset. Reloading...';await loadCaseData();D.importStatus.textContent='Case reset. Upload files to begin.'}catch(e){D.importStatus.textContent='Reset failed: '+e.message;console.error(e)}
}
if(!D.loginUser.value)D.loginUser.value='admin';
checkAuth();
