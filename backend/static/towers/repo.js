// towers/repo.js — the Tower Repository tab: a permanent, case-independent master of every
// tower seen across all loaded cases (harvested from CDR/IPDR + optional tower-master CSV import).
// Renders coverage stats + a searchable listing, and owns the rebuild / reverse-geocode / import
// controls. Extracted from app.js (feature layer). Self-registers with the router. No behavior change.

import { esc, n } from '../core/utils.js';
import { D } from '../core/dom.js';
import { state } from '../core/state.js';
import { API } from '../core/api.js';
import { twr } from '../data/records.js';
import { toast } from '../ui/toast.js';
import { registerTab } from '../core/router.js';

// ---- Tower Repository tab (permanent, case-independent master of all towers) ----
async function renderTowerRepo(){
  const el=D.towerRepo;if(!el)return;
  el.innerHTML='<div class="tr-empty">Loading tower repository…</div>';
  try{
    const search=(D.trSearch&&D.trSearch.value.trim())||'';
    const [stats,list]=await Promise.all([
      API.get('/towers/repo/stats'),
      API.get('/towers/repo?limit=300'+(search?'&search='+encodeURIComponent(search):'')),
    ]);
    renderTowerRepoView(stats,list,search);
  }catch(e){el.innerHTML='<div class="tr-empty" style="color:var(--danger)">Failed to load tower repository: '+esc(e.message||String(e))+'</div>';}
}
function renderTowerRepoView(stats,list,search){
  const el=D.towerRepo;if(!el)return;
  const pct=stats.total?Math.round(stats.with_coords/stats.total*100):0;
  const cards=[
    {l:'Towers in repo',v:n(stats.total),d:'across every loaded case'},
    {l:'With coordinates',v:n(stats.with_coords),d:pct+'% located',cls:'ok'},
    {l:'Missing coordinates',v:n(stats.without_coords),d:'need a tower master',cls:stats.without_coords?'warn':''},
    {l:'States covered',v:n(stats.states_covered),d:n(stats.cities_covered)+' cities'},
  ];
  let h='<div class="tr-report">';
  h+='<div class="tr-stats">'+cards.map(c=>'<div class="tr-stat '+(c.cls||'')+'"><div class="tr-stat-v">'+c.v+'</div><div class="tr-stat-l">'+esc(c.l)+'</div><div class="tr-stat-d">'+esc(c.d)+'</div></div>').join('')+'</div>';
  // coverage by state
  const bs=(stats.by_state||[]).filter(s=>s.state!=='Unknown');
  if(bs.length){
    const max=Math.max(...bs.map(s=>s.count));
    h+='<h4 class="tr-sec">Coverage by state</h4><div class="tr-states">'+bs.slice(0,18).map(s=>
      '<div class="tr-state"><span class="tr-state-n">'+esc(s.state)+'</span><span class="tr-bar"><span class="tr-bar-fill" style="width:'+Math.max(4,Math.round(s.count/max*100))+'%"></span></span><span class="tr-state-c">'+n(s.count)+'</span></div>'
    ).join('')+'</div>';
  }
  // listing
  const rows=list.rows||[];
  h+='<h4 class="tr-sec">Towers'+(search?' matching "'+esc(search)+'"':'')+' &mdash; showing '+rows.length+' of '+n(list.total)+'</h4>';
  if(!rows.length){
    h+='<div class="tr-empty" style="padding:24px">'+(stats.total?'No towers match.':'No towers yet. Upload CDR/IPDR (towers are harvested automatically) or import a tower master CSV.')+'</div>';
  }else{
    h+='<div class="tr-table-wrap"><table class="data-table tr-table"><thead><tr><th>Tower ID</th><th>Latitude</th><th>Longitude</th><th>City</th><th>State</th><th></th></tr></thead><tbody>';
    h+=rows.map(t=>{
      const located=t.latitude!=null&&t.longitude!=null;
      return '<tr><td>'+esc(t.tower_id)+'</td><td>'+(located?t.latitude.toFixed(5):'<span class="tr-miss">—</span>')+'</td><td>'+(located?t.longitude.toFixed(5):'<span class="tr-miss">—</span>')+'</td><td>'+esc(t.city||'')+'</td><td>'+esc(t.state||'')+'</td><td>'+(located?twr(t.tower_id):'')+'</td></tr>';
    }).join('');
    h+='</tbody></table></div>';
    if(list.total>rows.length)h+='<div class="tr-note">Refine the search to narrow beyond the first '+rows.length+' rows.</div>';
  }
  h+='</div>';
  el.innerHTML=h;
}
let _trSearchTimer=null;
if(D.trSearch)D.trSearch.addEventListener('input',()=>{clearTimeout(_trSearchTimer);_trSearchTimer=setTimeout(renderTowerRepo,300);});
if(D.trRefreshBtn)D.trRefreshBtn.addEventListener('click',renderTowerRepo);
if(D.trRebuildBtn)D.trRebuildBtn.addEventListener('click',async()=>{
  const el=D.towerRepo;if(el)el.innerHTML='<div class="tr-empty">Rebuilding repository from loaded records…</div>';
  try{
    const r=await API.post('/towers/repo/rebuild',{});
    try{state.towers=await API.get('/towers/')}catch(e){}  // refresh map's tower cache
    await renderTowerRepo();
    D.importStatus&&(D.importStatus.textContent='Tower repo rebuilt: +'+r.added+' new, '+r.updated+' located, '+(r.geocoded||0)+' named ('+r.total+' total).');
  }catch(e){if(el)el.innerHTML='<div class="tr-empty" style="color:var(--danger)">Rebuild failed: '+esc(e.message||String(e))+'</div>';}
});
if(D.trGeocodeBtn)D.trGeocodeBtn.addEventListener('click',async()=>{
  const el=D.towerRepo;if(el)el.innerHTML='<div class="tr-empty">Reverse-geocoding located towers (offline)…</div>';
  try{
    const r=await API.post('/towers/repo/geocode',{});
    try{state.towers=await API.get('/towers/')}catch(e){}  // refresh map's tower cache with names
    await renderTowerRepo();
    D.importStatus&&(D.importStatus.textContent='Reverse-geocoded '+(r.filled||0)+' tower'+((r.filled||0)===1?'':'s')+' to a city/state.');
  }catch(e){if(el)el.innerHTML='<div class="tr-empty" style="color:var(--danger)">Geocoding failed: '+esc(e.message||String(e))+'</div>';}
});
if(D.trImportBtn)D.trImportBtn.addEventListener('click',()=>D.trImportFile&&D.trImportFile.click());
if(D.trImportFile)D.trImportFile.addEventListener('change',async function(){
  const f=this.files&&this.files[0];if(!f)return;
  const el=D.towerRepo;if(el)el.innerHTML='<div class="tr-empty">Importing tower master…</div>';
  try{
    const fd=new FormData();fd.append('file',f);
    const r=await fetch('/towers/upload',{credentials:'same-origin',method:'POST',body:fd});
    if(!r.ok)throw new Error(await r.text()||'Import failed');
    const res=await r.json().catch(()=>({}));
    try{state.towers=await API.get('/towers/')}catch(e){}  // refresh map's tower cache so new towers locate
    await renderTowerRepo();
    try{toast('✓ Tower master imported'+(res&&res.records_imported!=null?' ('+n(res.records_imported)+' rows)':'')+'.');}catch(e){}
  }catch(e){if(el)el.innerHTML='<div class="tr-empty" style="color:var(--danger)">Import failed: '+esc(e.message||String(e))+'</div>';try{toast('Tower import failed: '+(e.message||String(e)));}catch(_){}}
  finally{this.value='';}
});

// This tab owns its rendering; register with the router.
registerTab('towerrepo', renderTowerRepo);
