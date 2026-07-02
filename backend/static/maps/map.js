// maps/map.js — the Tower Map (Leaflet) tab: geo-record loading, all visualization modes
// (path / heat / zones / co-location / triangulation / meetings), tower locate + highlight, geofence
// drawing, and the time scrubber. Extracted from app.js (feature layer). Reads the vendor globals L
// (Leaflet + Leaflet.draw + leaflet-heat) and turf. Inference-backed overlays (impossible-travel,
// co-presence, anchors) call getInfReport, injected via provideInfReport() so this module doesn't
// import the not-yet-extracted analytics layer. Sidebar zoom rows use data-act delegation
// (mapView / mapFit) instead of inline onclick (which referenced module-scoped state and had been
// dead since app.js became a module). No behavior change.

import { esc, fmt, n } from '../core/utils.js';
import { D } from '../core/dom.js';
import { state } from '../core/state.js';
import { API } from '../core/api.js';
import { subjLabelTxt } from '../core/subjects.js';
import { twr } from '../data/records.js';
import { registerTab } from '../core/router.js';
import { registerActions } from '../core/events.js';

// getInfReport lives in the inferences layer (still in app.js); app.js injects it here at boot.
let _getInfReport=()=>Promise.reject(new Error('inferences not ready'));
export function provideInfReport(fn){ _getInfReport=fn; }

async function initMap(){
  if(!state.data.geoRecords)await loadGeoData();
  if(!state.map.instance){
    state.map.instance=L.map(D.mapStage,{zoomControl:true,preferCanvas:true}).setView([20.5937,78.9629],5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'&copy; OpenStreetMap',maxZoom:18}).addTo(state.map.instance);
    setTimeout(()=>state.map.instance.invalidateSize(),100);
    initGeofenceListeners();
  }
  runMapMode();
}
// Resolve a tower's coordinates: prefer the loaded geo records (per-record lat/lng), fall
// back to the towers table. Returns {lat,lng} or null.
function towerLocate(towerId){
  const tc=towerCoords();if(tc[towerId])return tc[towerId];
  const t=(state.towers||[]).find(x=>x.tower_id===towerId&&x.latitude!=null&&x.longitude!=null);
  return t?{lat:t.latitude,lng:t.longitude}:null;
}
// Click-through for any tower id rendered via twr(): jump to the Tower Map tab and zoom to
// the tower with a highlight marker. Works from any tab (loads geo / builds the map if the
// map was never opened). Leaves the current overlay in place and drops a marker on top.
async function showTower(towerId){
  if(!towerId)return;
  // activate the map tab visually (mirror switchTab without re-running the mode)
  state.tab='map';
  document.querySelectorAll('.topbar-tab').forEach(b=>b.classList.toggle('active',b.dataset.tab==='map'));
  document.querySelectorAll('.tab-content').forEach(s=>s.classList.toggle('active',s.id==='tab-map'));
  if(!state.data.geoRecords)await loadGeoData();
  if(!state.map.instance){
    state.map.instance=L.map(D.mapStage,{zoomControl:true,preferCanvas:true}).setView([20.5937,78.9629],5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'&copy; OpenStreetMap',maxZoom:18}).addTo(state.map.instance);
    initGeofenceListeners();
  }
  setTimeout(()=>state.map.instance.invalidateSize(),50);
  const pt=towerLocate(towerId);
  if(!pt){D.mapAnalysis&&(D.mapAnalysis.innerHTML='<p style="color:var(--muted);font-size:0.85rem">No location on file for tower <b>'+esc(towerId)+'</b>.</p>');return;}
  if(state.map.towerHi){try{state.map.instance.removeLayer(state.map.towerHi)}catch(e){}}
  state.map.towerHi=L.circleMarker([pt.lat,pt.lng],{radius:12,color:'#fff',weight:3,fillColor:'#b94a48',fillOpacity:0.95}).addTo(state.map.instance);
  state.map.towerHi.bindPopup('<b>'+esc(towerId)+'</b><br>Tower location').openPopup();
  state.map.instance.setView([pt.lat,pt.lng],15,{animate:true});
}
async function loadGeoData(){
  const cq=state.data.caseId?'?case_id='+state.data.caseId:'';
  try{const[recs,subs]=await Promise.all([API.get('/geo/records'+cq),API.get('/geo/subjects'+cq)]);state.data.geoRecords=recs;state.data.geoSubjects=subs;populateMapSubjects()}catch(e){console.error(e)}
}
function populateMapSubjects(){
  const dl=document.getElementById('mapSubjectList');
  if(dl)dl.innerHTML=state.data.geoSubjects.map(s=>`<option value="${esc(s)}"></option>`).join('');
  const sel=document.getElementById('mapSubjectSelect');
  if(sel){const cur=sel.value;
    sel.innerHTML='<option value="">All subjects ('+state.data.geoSubjects.length+')</option>'+state.data.geoSubjects.map(s=>`<option value="${esc(s)}">${esc(subjLabelTxt(s))}</option>`).join('');
    if(state.data.geoSubjects.includes(cur))sel.value=cur;}
}
function clearMap(){
  state.map.layers.forEach(l=>state.map.instance.removeLayer(l));state.map.markers.forEach(m=>state.map.instance.removeLayer(m));state.map.circles.forEach(c=>state.map.instance.removeLayer(c));
  if(state.map.polyline){state.map.instance.removeLayer(state.map.polyline);state.map.polyline=null}
  if(state.map.towerHi){try{state.map.instance.removeLayer(state.map.towerHi)}catch(e){}state.map.towerHi=null}
  state.map.layers=[];state.map.markers=[];state.map.circles=[];
}
function geoSub(sub){if(!sub)return state.data.geoRecords;return state.data.geoRecords.filter(r=>r.subject===sub||r.counterpart===sub||r.msisdn===sub)}
function popupHtml(r){
  let h='<div style="min-width:140px;line-height:1.5;font-size:0.8rem">';
  h+=`<b>${esc(r.type)}</b><br>`;if(r.subject)h+=`<b>Subject:</b> ${esc(r.subject)}<br>`;if(r.counterpart)h+=`<b>Counterpart:</b> ${esc(r.counterpart)}<br>`;
  h+=`<b>Time:</b> ${fmt(r.start_time)}<br>`;if(r.duration_seconds!=null)h+=`<b>Duration:</b> ${r.duration_seconds}s<br>`;
  if(r.call_type)h+=`<b>Type:</b> ${esc(r.call_type)}<br>`;if(r.direction)h+=`<b>Direction:</b> ${esc(r.direction)}<br>`;
  if(r.protocol)h+=`<b>Protocol:</b> ${esc(r.protocol)}<br>`;if(r.msisdn)h+=`<b>MSISDN:</b> ${esc(r.msisdn)}<br>`;
  if(r.tower_id)h+=`<b>Tower:</b> ${twr(r.tower_id)}<br>`;if(r.tower&&r.tower.city)h+=`<b>Location:</b> ${esc(r.tower.city)}<br>`;
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
// Tower id -> coordinates. Primary source: state.towers (the Tower master table, always
// has coordinates when a tower file was uploaded). Secondary: state.data.geoRecords for any CDR/IPDR
// records with direct lat/lon that aren't in the master yet.
function towerCoords(){
  const m={};
  (state.towers||[]).forEach(t=>{if(t.tower_id&&t.latitude!=null&&t.longitude!=null)m[t.tower_id]={lat:t.latitude,lng:t.longitude};});
  state.data.geoRecords.forEach(r=>{if(r.tower_id&&r.latitude!=null&&r.longitude!=null&&!m[r.tower_id])m[r.tower_id]={lat:r.latitude,lng:r.longitude};});
  return m;
}
async function showMapImpossible(sub){
  clearMap();
  let rep;try{rep=await _getInfReport();}catch(e){D.mapAnalysis.innerHTML='<p style="color:var(--danger)">Failed to load inferences.</p>';return;}
  const tc=towerCoords();
  let legs=(rep.cdr&&rep.cdr.impossible_travel)||[];
  if(sub)legs=legs.filter(l=>l.subject===sub);
  const cloneBy={};((rep.cdr&&rep.cdr.clone_corroboration)||[]).forEach(c=>cloneBy[c.subject]=c);
  if(!legs.length){D.mapAnalysis.innerHTML='<p style="color:var(--muted)">No impossible-travel legs'+(sub?' for this subject':'')+'.</p>';return;}
  const bounds=[];
  legs.forEach(l=>{
    const a=tc[l.from_tower],b=tc[l.to_tower];if(!a||!b)return;
    const line=L.polyline([[a.lat,a.lng],[b.lat,b.lng]],{color:'#b94a48',weight:3,opacity:0.85,dashArray:'7,6'}).addTo(state.map.instance);
    line.bindPopup('<b>Impossible travel</b><br>'+esc(l.subject)+'<br><b>'+(l.speed_kmh!=null?Math.round(l.speed_kmh)+' km/h':'same minute (∞)')+'</b><br>'+l.distance_km+' km in '+l.dt_minutes+' min'+(l.from_imei!==l.to_imei?'<br>IMEI changed':'')+(cloneBy[l.subject]?'<br>⚠ '+esc(cloneBy[l.subject].verdict):''));
    state.map.layers.push(line);
    [[a,l.from_tower],[b,l.to_tower]].forEach(p=>{const mk=L.circleMarker([p[0].lat,p[0].lng],{radius:7,color:'#fff',weight:2,fillColor:'#b94a48',fillOpacity:0.9}).addTo(state.map.instance);mk.bindTooltip(esc(p[1]),{direction:'top'});state.map.markers.push(mk);bounds.push([p[0].lat,p[0].lng]);});
  });
  if(bounds.length)state.map.instance.fitBounds(bounds,{padding:[60,60]});
  let h='<h4 style="margin:0 0 6px;color:var(--danger)">Impossible Travel</h4><div style="font-size:0.7rem;color:var(--muted);margin-bottom:6px">Red dashed legs exceed human travel speed (likely clone / spoofed record).</div>';
  legs.forEach(l=>{h+='<div class="evt" onclick="showProfile(\''+esc(l.subject)+'\')"><span class="evt-time">'+esc(l.subject)+'</span><span class="evt-loc" style="color:var(--danger)">'+(l.speed_kmh!=null?Math.round(l.speed_kmh)+' km/h':'∞')+'</span></div>';});
  D.mapAnalysis.innerHTML=h;
}
async function showMapCopresence(sub){
  clearMap();
  let rep;try{rep=await _getInfReport();}catch(e){D.mapAnalysis.innerHTML='<p style="color:var(--danger)">Failed to load inferences.</p>';return;}
  const tc=towerCoords();
  let pairs=((rep.cdr&&rep.cdr.co_presence)||[]).filter(c=>c.convoy||c.hidden_link);
  if(sub)pairs=pairs.filter(c=>c.subject_a===sub||c.subject_b===sub);
  if(!pairs.length){D.mapAnalysis.innerHTML='<p style="color:var(--muted)">No convoy / hidden-link pairs'+(sub?' for this subject':'')+'.</p>';return;}
  const bounds=[];
  pairs.forEach(c=>{
    const col=c.hidden_link?'#b94a48':'#d4a017';
    (c.towers||[]).forEach(tw=>{
      const base=String(tw).split('~')[0];const pt=tc[base];if(!pt)return;
      const mk=L.circleMarker([pt.lat,pt.lng],{radius:9,color:'#fff',weight:2,fillColor:col,fillOpacity:0.85}).addTo(state.map.instance);
      mk.bindPopup('<b>'+(c.hidden_link?'Hidden link (met, never called)':'Convoy')+'</b><br>'+esc(c.subject_a)+' &amp; '+esc(c.subject_b)+'<br>'+c.occurrences+'× over '+c.distinct_days+' day(s)<br>'+(c.ever_called?'they also call each other':'never call each other')+'<br>Tower '+esc(base));
      state.map.markers.push(mk);bounds.push([pt.lat,pt.lng]);
    });
  });
  if(bounds.length)state.map.instance.fitBounds(bounds,{padding:[60,60]});
  let h='<h4 style="margin:0 0 6px;color:var(--warn)">Co-presence</h4><div style="font-size:0.7rem;color:var(--muted);margin-bottom:6px">Amber = convoy (repeated co-location). Red = hidden link (co-located but never call).</div>';
  pairs.forEach(c=>{h+='<div class="evt"><span class="evt-time">'+esc(c.subject_a)+' &amp; '+esc(c.subject_b)+'</span><span class="evt-loc" style="color:'+(c.hidden_link?'var(--danger)':'var(--warn)')+'">'+(c.hidden_link?'hidden':'convoy')+' ('+c.distinct_days+'d)</span></div>';});
  D.mapAnalysis.innerHTML=h;
}
async function showMapAnchors(sub){
  clearMap();
  let rep;try{rep=await _getInfReport();}catch(e){D.mapAnalysis.innerHTML='<p style="color:var(--danger)">Failed to load inferences.</p>';return;}
  const mv=((rep.cdr&&rep.cdr.movement)||{})[sub];
  if(!mv||!mv.anchors){D.mapAnalysis.innerHTML='<p style="color:var(--muted)">No anchors for this subject.</p>';return;}
  const bounds=[];
  const MAP_PT_CAP=2000;
  const pts=geoSub(sub).filter(r=>r.latitude!=null&&r.longitude!=null);
  const capped=pts.length>MAP_PT_CAP;
  pts.slice(0,MAP_PT_CAP).forEach(r=>{const mk=L.circleMarker([r.latitude,r.longitude],{radius:3,color:'#888',weight:1,fillColor:'#888',fillOpacity:0.35}).addTo(state.map.instance);state.map.markers.push(mk);bounds.push([r.latitude,r.longitude]);});
  const place=(anchor,label,color)=>{
    if(!anchor||anchor.latitude==null)return;
    const mk=L.circleMarker([anchor.latitude,anchor.longitude],{radius:12,color:'#fff',weight:3,fillColor:color,fillOpacity:0.92}).addTo(state.map.instance);
    mk.bindPopup('<b>'+label+'</b><br>'+esc(sub)+'<br>Tower '+esc(anchor.tower_id)+'<br>'+anchor.events+' events');
    mk.bindTooltip(label,{permanent:true,direction:'top'});state.map.markers.push(mk);bounds.push([anchor.latitude,anchor.longitude]);
  };
  place(mv.anchors.home,'Home','#2c6f79');
  place(mv.anchors.work,'Work','#2d7d46');
  if(bounds.length)state.map.instance.fitBounds(bounds,{padding:[50,50]});
  let h='<h4 style="margin:0 0 6px">Anchors — '+esc(sub)+'</h4>'+(capped?`<p style="color:var(--warn);font-size:0.72rem;margin:0 0 6px">Showing first ${n(MAP_PT_CAP)} of ${n(pts.length)} positions (canvas renderer active)</p>`:'');
  h+='<div class="stat-row"><span class="label">Home tower</span><span class="value">'+(mv.anchors.home?twr(mv.anchors.home.tower_id):'?')+'</span></div>';
  h+='<div class="stat-row"><span class="label">Work tower</span><span class="value">'+(mv.anchors.work?twr(mv.anchors.work.tower_id):'?')+'</span></div>';
  h+='<div class="stat-row"><span class="label">Distinct towers</span><span class="value">'+mv.distinct_towers+'</span></div>';
  h+='<div class="stat-row"><span class="label">Max leg</span><span class="value">'+mv.max_leg_km+' km</span></div>';
  if(mv.impossible_travel&&mv.impossible_travel.length)h+='<div class="stat-row"><span class="label" style="color:var(--danger)">Impossible legs</span><span class="value" style="color:var(--danger)">'+mv.impossible_travel.length+'</span></div>';
  D.mapAnalysis.innerHTML=h;
}
D.mapGo.addEventListener('click',runMapMode);
D.mapMode.addEventListener('change',runMapMode);
D.mapSubject.addEventListener('change',()=>{if(D.mapSubject.value)runMapMode()});
// Run immediately when a complete subject is typed or picked from the suggestions.
D.mapSubject.addEventListener('input',()=>{const sel=document.getElementById('mapSubjectSelect');if(sel)sel.value=state.data.geoSubjects.includes(D.mapSubject.value)?D.mapSubject.value:'';if(state.data.geoSubjects.includes(D.mapSubject.value))runMapMode()});
// Dropdown: pick a subject -> mirror into the search box and run.
(function(){const sel=document.getElementById('mapSubjectSelect');if(sel)sel.addEventListener('change',()=>{D.mapSubject.value=sel.value;runMapMode();});})();
D.mapFit.addEventListener('click',()=>{const pts=[];state.data.geoRecords.forEach(r=>{if(r.latitude!=null&&r.longitude!=null)pts.push([r.latitude,r.longitude])});if(pts.length)state.map.instance.fitBounds(pts,{padding:[30,30]})});

// -- Geofence --
// geofence view state -> state.map (core/state.js)
D.geoFenceBtn.addEventListener('click',()=>{
  if(!state.map.instance)return;
  if(state.map.fenceDrawn){
    state.map.instance.removeLayer(state.map.fenceLayer);state.map.fenceLayer=null;state.map.fenceDrawn=false;
    clearGeofenceHighlights();
    D.mapAnalysis.innerHTML='<p style="color:var(--muted);font-size:0.85rem">Geofence cleared.</p>';
    D.geoFenceBtn.textContent='Geofence';D.geoFenceBtn.style.borderColor='var(--danger)';D.geoFenceBtn.style.color='var(--danger)';
    return;
  }
  if(state.map.fenceDrawing){
    if(state.map.fenceDrawHandler)state.map.fenceDrawHandler.disable();
    state.map.fenceDrawing=false;
    D.geoFenceBtn.textContent='Geofence';D.geoFenceBtn.style.borderColor='var(--danger)';D.geoFenceBtn.style.color='var(--danger)';
    return;
  }
  state.map.fenceDrawHandler=new L.Draw.Polygon(state.map.instance,{shapeOptions:{color:'#b94a48',weight:2},allowIntersection:false,showArea:true,metric:true});
  state.map.fenceDrawHandler.enable();
  state.map.fenceDrawing=true;
  D.geoFenceBtn.textContent='Cancel';D.geoFenceBtn.style.borderColor='var(--warn)';D.geoFenceBtn.style.color='var(--warn)';
});
function initGeofenceListeners(){
  state.map.instance.off('draw:created');
  state.map.instance.on('draw:created',function(e){
    if(state.map.fenceDrawing){
      if(state.map.fenceDrawHandler)state.map.fenceDrawHandler.disable();
      state.map.fenceDrawing=false;
    }
    if(state.map.fenceLayer)state.map.instance.removeLayer(state.map.fenceLayer);
    state.map.fenceLayer=e.layer;state.map.fenceDrawn=true;
    state.map.instance.addLayer(state.map.fenceLayer);
    D.geoFenceBtn.textContent='Clear Fence';D.geoFenceBtn.style.borderColor='var(--success)';D.geoFenceBtn.style.color='var(--success)';
    analyzeGeofence();
  });
}
function clearGeofenceHighlights(){
  state.map.fenceMarkers.forEach(m=>{try{state.map.instance.removeLayer(m)}catch(e){}});
  state.map.fenceMarkers=[];
}
// Find every loaded geo record inside the drawn polygon, summarise the subjects/towers
// present, and highlight the points on the map.
function analyzeGeofence(){
  if(!state.map.fenceLayer){return;}
  clearGeofenceHighlights();
  const fencePts=state.map.fenceLayer.getLatLngs();
  const ring=Array.isArray(fencePts[0])?fencePts[0]:fencePts;
  if(!ring||ring.length<3){D.mapAnalysis.innerHTML='<p style="color:var(--muted)">Draw a closed area.</p>';return;}
  const coords=ring.map(p=>[p.lng,p.lat]);
  coords.push(coords[0]); // close the ring for turf
  const poly=turf.polygon([coords]);
  const inside=(state.data.geoRecords||[]).filter(r=>r.latitude!=null&&r.longitude!=null&&turf.booleanPointInPolygon(turf.point([r.longitude,r.latitude]),poly));
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
    const mk=L.circleMarker([r.latitude,r.longitude],{radius:5,color:'#fff',weight:1,fillColor:col,fillOpacity:0.85}).addTo(state.map.instance);
    mk.bindPopup(popupHtml(r));state.map.fenceMarkers.push(mk);
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
  clearMap();const rows=state.data.geoRecords.filter(r=>(r.msisdn===sub||r.subject===sub)&&r.latitude!=null&&r.longitude!=null);
  rows.sort((a,b)=>(a.start_time||'').localeCompare(b.start_time||''));
  if(!rows.length){D.mapAnalysis.innerHTML='No geo records.';return}
  const coords=rows.map(r=>[r.latitude,r.longitude]);
  // One polyline per leg, graded by travel mode; a rotated arrow shows direction.
  let dist=0,flagged=0,fastest=0;const usedModes=new Set();const legs=[];
  for(let i=1;i<rows.length;i++){
    const a=rows[i-1],b=rows[i];
    const km=state.map.instance.distance([a.latitude,a.longitude],[b.latitude,b.longitude])/1000;
    dist+=km;
    const seg=segMetrics(a,b,km);usedModes.add(seg.mode);legs.push({a,b,seg,i});
    if(seg.impossible)flagged++;
    if(seg.kmh&&!seg.dwell&&seg.kmh>fastest)fastest=seg.kmh;
    const opts={color:seg.color,weight:seg.weight,opacity:0.85};if(seg.dash)opts.dashArray=seg.dash;
    const line=L.polyline([[a.latitude,a.longitude],[b.latitude,b.longitude]],opts);
    line.bindTooltip(seg.tip,{sticky:true,direction:'top',opacity:0.97});
    line.on('mouseover',function(){this.setStyle({weight:seg.weight+3,opacity:1})});
    line.on('mouseout',function(){this.setStyle({weight:seg.weight,opacity:0.85})});
    line.addTo(state.map.instance);state.map.layers.push(line);
    if(!seg.dwell&&km>=0.25){ // direction arrow at the leg midpoint (real moves only)
      const ang=bearing(a.latitude,a.longitude,b.latitude,b.longitude);
      const arrow=L.marker([(a.latitude+b.latitude)/2,(a.longitude+b.longitude)/2],{interactive:false,
        icon:L.divIcon({className:'',html:'<div style="transform:rotate('+ang+'deg);color:'+seg.color+';font-size:13px;line-height:1;text-shadow:0 0 2px #fff">&#9650;</div>',iconSize:[13,13],iconAnchor:[7,7]})});
      arrow.addTo(state.map.instance);state.map.markers.push(arrow);
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
    m.addTo(state.map.instance);state.map.markers.push(m);
  });
  if(coords.length>1)state.map.instance.fitBounds(L.latLngBounds(coords),{padding:[40,40]});else state.map.instance.setView(coords[0],14);
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
    h+='<div class="evt" title="Zoom to this leg" data-act="mapFit" data-b="'+L2.a.latitude+','+L2.a.longitude+','+L2.b.latitude+','+L2.b.longitude+'">'
      +'<span class="evt-time"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:'+s.color+';margin-right:5px"></span>'+fmt(L2.b.start_time)+'</span>'
      +'<span class="evt-loc" style="color:'+(s.impossible?'var(--danger)':'inherit')+'">'+s.km.toFixed(1)+' km · '+speed+'</span></div>';
  });
  D.mapAnalysis.innerHTML=h;
  D.mapTimeBar.style.display='flex';setupMapTime(rows);
}
function showMapHeat(sub,_retry){
  clearMap();const rows=geoSub(sub).filter(r=>r.latitude!=null&&r.longitude!=null);
  if(!rows.length){D.mapAnalysis.innerHTML='No records.';return}
  // leaflet-heat draws via getImageData(width,height); if the map container isn't laid out yet
  // (0×0) that throws IndexSizeError. Make sure the map has a real size first — invalidate and
  // retry a few times — before drawing.
  const _sz=state.map.instance&&state.map.instance.getSize?state.map.instance.getSize():{x:0,y:0};
  if((_sz.x===0||_sz.y===0)&&(_retry||0)<10){
    if(state.map.instance&&state.map.instance.invalidateSize)state.map.instance.invalidateSize();
    setTimeout(()=>showMapHeat(sub,(_retry||0)+1),120);
    return;
  }
  const _mapSized=_sz.x>0&&_sz.y>0;
  // Aggregate per tower, snapping its records to their centroid. Records carry ~400 m of
  // per-event jitter around a tower; using raw coords makes one tower fragment into several
  // blobs when zoomed in, so we collapse each tower to a single representative point.
  const locs={};
  rows.forEach(r=>{
    const k=r.tower_id||`${+r.latitude.toFixed(4)},${+r.longitude.toFixed(4)}`;
    if(!locs[k])locs[k]={slat:0,slng:0,count:0,id:r.tower_id||null};
    locs[k].slat+=r.latitude;locs[k].slng+=r.longitude;locs[k].count++;
  });
  const towers=Object.values(locs).map(t=>({lat:t.slat/t.count,lng:t.slng/t.count,count:t.count,id:t.id}));
  const maxC=Math.max(1,...towers.map(t=>t.count));
  // Warm scale (purple→magenta→orange→red): the old blue low-end washed out against the
  // light basemap and blue water and only read once zoomed in. Warm colours stay legible on
  // land and water, and the 0.5 opacity floor keeps sparse areas visible at any zoom.
  const grad={0.0:'#7b2d8e',0.35:'#c2185b',0.6:'#ef6c00',0.8:'#e53935',1.0:'#b71c1c'};
  let heatOk=false;
  if(typeof L.heatLayer==='function'&&_mapSized){
    // Stack `count` points at each tower's centroid. Stacking accumulates into a graded hot
    // core (a single weighted point can't — its alpha is capped, not additive, so it reads
    // cold), and because the points share one exact coordinate the tower stays a single blob
    // at every zoom level. Total points == record count, so no extra cost over per-record.
    try{
      const heatPts=[];
      towers.forEach(t=>{for(let i=0;i<t.count;i++)heatPts.push([t.lat,t.lng,1]);});
      const heat=L.heatLayer(heatPts,
        {radius:30,blur:20,maxZoom:16,minOpacity:0.5,gradient:grad}).addTo(state.map.instance);
      state.map.layers.push(heat);
      // tiny clickable dots keep every location inspectable on top of the gradient
      towers.forEach(t=>{
        const m=L.circleMarker([t.lat,t.lng],{radius:3,color:'#fff',weight:1,opacity:0.5,fillColor:'#222',fillOpacity:0.45});
        m.bindPopup(`<strong>${esc(t.id||t.lat.toFixed(4)+', '+t.lng.toFixed(4))}</strong><br>${t.count} visits`);
        m.addTo(state.map.instance);state.map.markers.push(m);
      });
      heatOk=true;
    }catch(e){console.warn('heatmap draw failed — falling back to bubbles',e);clearMap();}
  }
  if(!heatOk){
    // fallback: graduated bubbles if the heat plugin failed/unavailable or the map wasn't sized
    towers.forEach(t=>{const p=t.count/maxC;const c=p>0.7?'#b71c1c':p>0.4?'#ef6c00':'#7b2d8e';
      state.map.circles.push(L.circleMarker([t.lat,t.lng],{radius:5+15*p,color:c,fillColor:c,fillOpacity:0.25+0.55*p,weight:1,opacity:0.6}).bindPopup(`<strong>${esc(t.id||t.lat.toFixed(4)+', '+t.lng.toFixed(4))}</strong><br>${t.count} visits`).addTo(state.map.instance))});
  }
  const pts=towers.map(t=>[t.lat,t.lng]);if(pts.length)state.map.instance.fitBounds(pts,{padding:[40,40]});else fitAllGeo();
  const sorted=towers.sort((a,b)=>b.count-a.count);
  let h='<h4 style="margin:0 0 6px">Activity Heatmap</h4>'
    +`<div class="stat-row"><span class="label">Records</span><span class="value">${rows.length}</span></div>`
    +`<div class="stat-row"><span class="label">Locations</span><span class="value">${sorted.length}</span></div>`
    +`<div class="stat-row"><span class="label">Peak</span><span class="value">${maxC} visits</span></div>`;
  h+='<div style="margin:8px 0 4px"><div style="height:10px;border-radius:5px;background:linear-gradient(to right,#7b2d8e,#c2185b,#ef6c00,#e53935,#b71c1c)"></div><div style="display:flex;justify-content:space-between;font-size:0.62rem;color:var(--muted);margin-top:2px"><span>low</span><span>high</span></div></div>';
  h+='<h4 style="margin:8px 0 4px">Hotspots</h4>';
  sorted.slice(0,8).forEach(t=>{
    const p=t.count/maxC;
    const c=p>0.7?'#b71c1c':p>0.4?'#ef6c00':'#7b2d8e';
    const loc=t.id||(t.lat.toFixed(4)+','+t.lng.toFixed(4));
    h+=`<div class="evt" style="border-left-color:${c}" data-act="mapView" data-lat="${t.lat}" data-lng="${t.lng}" data-z="15"><span class="evt-loc">${esc(loc)}</span><span class="evt-time">${t.count} visits</span></div>`;
  });
  D.mapAnalysis.innerHTML=h;
}
function showMapZones(sub){
  clearMap();const rows=geoSub(sub).filter(r=>r.latitude!=null&&r.longitude!=null);
  if(!rows.length){D.mapAnalysis.innerHTML='No data.';return}
  const t={};rows.forEach(r=>{const k=r.tower_id||('p-'+r.latitude);if(!t[k])t[k]={lat:r.latitude,lng:r.longitude,count:0};t[k].count++});
  const sorted=Object.entries(t).sort((a,b)=>b[1].count-a[1].count);
  sorted.forEach(([id,td])=>{const rad=Math.min(60,10+Math.sqrt(td.count)*4);state.map.circles.push(L.circle([td.lat,td.lng],{radius:rad*1000,color:'#2c6f79',fillColor:'#2c6f79',fillOpacity:0.1+Math.min(0.4,td.count/100),weight:2}).addTo(state.map.instance));state.map.markers.push(L.marker([td.lat,td.lng]).bindPopup(`<strong>${esc(id)}</strong><br>${td.count} visits`).addTo(state.map.instance))});
  fitAllGeo();
  let h='<h4>Operational Zones</h4>'+`<div class="stat-row"><span class="label">Zones</span><span class="value">${sorted.length}</span></div>`+`<div class="stat-row"><span class="label">Primary</span><span class="value">${esc(sorted[0][0])} (${((sorted[0][1].count/rows.length)*100).toFixed(0)}%)</span></div>`;
  h+='<h4 style="margin:8px 0 4px">Breakdown</h4>';sorted.slice(0,8).forEach(([id,td])=>{h+=`<div class="evt"><span class="evt-loc">${esc(id)}</span><span class="evt-time">${td.count} (${((td.count/rows.length)*100).toFixed(0)}%)</span></div>`});
  D.mapAnalysis.innerHTML=h;
}
function showMapColocation(sub){
  clearMap();const rows=state.data.geoRecords.filter(r=>r.latitude!=null&&r.longitude!=null);
  if(!rows.length){D.mapAnalysis.innerHTML='No data.';return}
  const twrs={};rows.forEach(r=>{const k=r.tower_id||('p-'+r.latitude);if(!twrs[k])twrs[k]={lat:r.latitude,lng:r.longitude,subjects:new Set(),records:[]};twrs[k].subjects.add(r.subject);twrs[k].records.push(r)});
  const shared=Object.entries(twrs).filter(([k,v])=>v.subjects.size>1&&v.records.some(r=>r.subject===sub)).sort((a,b)=>b[1].records.length-a[1].records.length);
  shared.slice(0,20).forEach(([id,td])=>{state.map.markers.push(L.marker([td.lat,td.lng]).bindPopup(`<strong>${esc(id)}</strong><br>Subjects: ${[...td.subjects].slice(0,5).join(', ')}`).addTo(state.map.instance));td.records.filter(r=>r.subject===sub).forEach(r=>{const cm=L.circleMarker([r.latitude,r.longitude],{radius:5,color:'#b94a48',fillColor:'#b94a48',fillOpacity:0.6}).bindPopup(popupHtml(r));cm.addTo(state.map.instance);state.map.markers.push(cm)})});
  const locs=state.map.markers.filter(m=>m.getLatLng).map(m=>m.getLatLng());if(locs.length)state.map.instance.fitBounds(locs,{padding:[40,40]});else fitAllGeo();
  let h='<h4>Co-location</h4>'+`<div class="stat-row"><span class="label">Shared Towers</span><span class="value">${shared.length}</span></div>`+`<div class="stat-row"><span class="label">Co-located With</span><span class="value">${new Set(shared.flatMap(([k,v])=>[...v.subjects].filter(s=>s!==sub))).size}</span></div>`;
  h+='<h4 style="margin:8px 0 4px">Details</h4>';shared.slice(0,8).forEach(([id,td])=>{const others=[...td.subjects].filter(s=>s!==sub).join(', ');h+=`<div class="evt"><span class="evt-loc">${esc(id)}</span><span class="evt-time">With: ${esc(others)}</span></div>`});
  D.mapAnalysis.innerHTML=h;
}
// Best-effort intersection of tower coverage cells, tightest-first. Skips a cell that
// doesn't overlap the running region (rather than aborting the whole cluster), so partial
// overlaps still yield a confidence polygon. Returns a GeoJSON polygon or null.
function triangulateOverlap(tw){
  if(typeof turf==='undefined'||!tw||tw.length<2)return null;
  const sorted=[...tw].sort((a,b)=>a.rad-b.rad);
  const circ=t=>turf.circle([t.lng,t.lat],t.rad/1000,{steps:48,units:'kilometers'});
  try{
    let acc=circ(sorted[0]),got=false;
    for(let i=1;i<sorted.length;i++){
      // Turf v7: intersect() takes a FeatureCollection of two polygons (not two args).
      const inter=turf.intersect(turf.featureCollection([acc,circ(sorted[i])]));
      if(!inter)continue;
      acc=inter;got=true;
    }
    return got?acc:null;
  }catch(e){return null}
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
    const c=L.circle([loc.lat,loc.lng],{radius:rad,color:densColor(cnt),fillColor:densColor(cnt),fillOpacity:0.12,weight:1.5,opacity:0.5}).addTo(state.map.instance);
    state.map.circles.push(c);
    const m=L.circleMarker([loc.lat,loc.lng],{radius:6,color:'#fff',weight:2,fillColor:densColor(cnt),fillOpacity:0.9});
    m.bindTooltip(id,{direction:'top'});
    m.bindPopup(`<strong>${esc(id)}</strong><br>Records: ${cnt}<br>Coverage: ${(rad/1000).toFixed(1)} km`);
    m.addTo(state.map.instance);state.map.markers.push(m);
  });
  const fixes=[];
  usedClusters.forEach((c,ci)=>{
    const ids=[...new Set(c.map(r=>r.tower_id))];
    if(ids.length<2)return;
    const tw=ids.map(id=>{const loc=towerLocs[id];if(!loc)return null;const rad=covRadius(c.find(r=>r.tower_id===id)||{});if(rad<=0)return null;return{id,lat:loc.lat,lng:loc.lng,rad}}).filter(Boolean);
    if(tw.length<2)return;
    // Weighted position estimate: a tighter cell (smaller coverage radius) constrains the fix
    // more, so weight each tower by 1/r^2 — the RF analogue of an inverse-variance mean. This
    // yields an estimate even when the cells don't all intersect.
    let sw=0,la=0,lo=0;tw.forEach(t=>{const w=1/(t.rad*t.rad);sw+=w;la+=t.lat*w;lo+=t.lng*w});
    const est={lat:la/sw,lng:lo/sw};
    const unc=Math.min(...tw.map(t=>t.rad)); // tightest constraining cell bounds the precision
    // Geometry lines from the estimate to each contributing tower.
    tw.forEach(t=>{const ln=L.polyline([[est.lat,est.lng],[t.lat,t.lng]],{color:'#7a8aa0',weight:1,opacity:0.45,dashArray:'2 4'}).addTo(state.map.instance);state.map.layers.push(ln)});
    // Rigorous overlap region (best-effort; skips non-overlapping cells instead of aborting).
    const overlap=triangulateOverlap(tw);
    if(overlap){const coords=overlap.geometry.coordinates[0].map(p=>[p[1],p[0]]);const poly=L.polygon(coords,{color:'#b94a48',fillColor:'#b94a48',fillOpacity:0.22,weight:1.5,dashArray:'4 4'}).addTo(state.map.instance);state.map.layers.push(poly)}
    // Uncertainty circle + estimated-position marker (crosshair).
    const uc=L.circle([est.lat,est.lng],{radius:unc,color:'#b94a48',fillColor:'#b94a48',fillOpacity:0.05,weight:1,opacity:0.4,dashArray:'2 6'}).addTo(state.map.instance);state.map.circles.push(uc);
    const em=L.marker([est.lat,est.lng],{icon:L.divIcon({className:'',html:'<div style="width:16px;height:16px;border:2px solid #b94a48;border-radius:50%;box-shadow:0 0 0 2px #fff;position:relative"><div style="position:absolute;left:50%;top:50%;width:6px;height:6px;background:#b94a48;border-radius:50%;transform:translate(-50%,-50%)"></div></div>',iconSize:[16,16],iconAnchor:[8,8]})});
    em.bindTooltip('Estimated position',{direction:'top'});
    em.bindPopup(`<strong>Estimated position</strong><br>Cluster ${ci+1} · ${tw.length} towers${overlap?' · overlap fix':''}<br>Confidence ±${(unc/1000).toFixed(1)} km<br>${fmt(c[0].start_time)}`);
    em.addTo(state.map.instance);state.map.markers.push(em);
    fixes.push({ci,est,unc,n:tw.length,overlap:!!overlap,time:c[0].start_time});
  });
  const allPts=towerIds.map(id=>[towerLocs[id].lat,towerLocs[id].lng]).concat(fixes.map(f=>[f.est.lat,f.est.lng]));
  if(allPts.length)state.map.instance.fitBounds(allPts,{padding:[40,40]});
  fixes.sort((a,b)=>a.unc-b.unc);
  let h='<h4 style="margin:0 0 6px">Triangulation</h4>';
  h+=`<div class="stat-row"><span class="label">Towers</span><span class="value">${towerIds.length}</span></div>`;
  h+=`<div class="stat-row"><span class="label">Position Fixes</span><span class="value">${fixes.length}</span></div>`;
  h+=`<div class="stat-row"><span class="label">Overlap Fixes</span><span class="value">${fixes.filter(f=>f.overlap).length}</span></div>`;
  if(fixes.length)h+=`<div class="stat-row"><span class="label">Best Precision</span><span class="value">±${(fixes[0].unc/1000).toFixed(1)} km</span></div>`;
  if(fixes.length){
    h+='<h4 style="margin:8px 0 4px">Estimated Positions</h4>';
    fixes.slice(0,8).forEach(f=>{h+=`<div class="evt" data-act="mapView" data-lat="${f.est.lat}" data-lng="${f.est.lng}" data-z="15"><span class="evt-time">${fmt(f.time)}</span><span class="evt-loc">${f.n} towers · ±${(f.unc/1000).toFixed(1)} km${f.overlap?' · overlap':''}</span></div>`});
  }
  h+='<h4 style="margin:8px 0 4px">Tower Usage</h4>';
  const sortedTowers=Object.entries(towerTotals).sort((a,b)=>b[1]-a[1]);
  sortedTowers.slice(0,6).forEach(([id,cnt])=>{const loc=towerLocs[id]||{};h+=`<div class="evt" data-act="mapView" data-lat="${loc.lat}" data-lng="${loc.lng}" data-z="14"><span class="evt-loc">${esc(id)}</span><span class="evt-time">${cnt} records</span></div>`});
  h+='<div style="margin-top:10px;padding:8px;background:var(--card-bg);border-radius:6px;font-size:0.72rem;color:var(--muted)"><b>How it works:</b> Each burst of tower hand-offs inside a 30-min window is one fix. Coverage cells are sized by radio technology (1–15 km); the crosshair is the inverse-variance weighted centre of those towers (tighter cells weigh more), the red dashed polygon is the rigorous cell-overlap region when one exists, and the faint circle marks the ±precision bound.</div>';
  D.mapAnalysis.innerHTML=h;
}
async function showMapMeetings(sub){
  clearMap();
  // Exact co-location detection runs server-side now (was an O(n^2) client scan over loaded
  // records); it covers the whole case, not just what's in memory.
  D.mapAnalysis.innerHTML='<p style="color:var(--muted);font-size:0.85rem">Detecting meetings…</p>';
  let res;
  try{
    const p=new URLSearchParams();
    if(state.data.caseId)p.set('case_id',state.data.caseId);
    if(sub)p.set('subject',sub);
    res=await API.get('/investigation/meetings?'+p.toString());
  }catch(e){console.error('meetings',e);D.mapAnalysis.innerHTML='<p style="color:var(--danger)">Failed to detect meetings.</p>';return;}
  const ms=(res.meetings||[]).filter(m=>m.latitude!=null&&m.longitude!=null);
  ms.slice(0,40).forEach(m=>{const col=m.gap_min<5?'#b94a48':m.gap_min<15?'#d4a017':'#2c6f79';
    state.map.markers.push(L.circleMarker([m.latitude,m.longitude],{radius:8,color:col,fillColor:col,fillOpacity:0.4,weight:2}).bindPopup(`<strong>Possible Meeting</strong><br>${esc(m.subject_a)} & ${esc(m.subject_b)}<br>Tower ${esc(m.tower_id)}<br>Gap: ${m.gap_min.toFixed(0)} min`).addTo(state.map.instance))});
  if(ms.length){const pts=state.map.markers.filter(m=>m.getLatLng).map(m=>m.getLatLng());if(pts.length)state.map.instance.fitBounds(pts,{padding:[40,40]})}else fitAllGeo();
  const withSet=new Set(ms.map(m=>m.subject_a===sub?m.subject_b:m.subject_a));
  let h='<h4>Meeting Detection</h4>'
    +`<div class="stat-row"><span class="label">Meetings</span><span class="value">${res.total||ms.length}</span></div>`
    +`<div class="stat-row"><span class="label">Distinct pairs</span><span class="value">${res.distinct_pairs||0}</span></div>`
    +(sub?`<div class="stat-row"><span class="label">With</span><span class="value">${withSet.size}</span></div>`:'');
  if(!ms.length)h+='<p style="color:var(--muted);font-size:0.8rem">No meetings detected.</p>';
  else{h+='<h4 style="margin:8px 0 4px">Closest encounters</h4>';ms.slice(0,12).forEach(m=>{const c=m.gap_min<5?'#b94a48':m.gap_min<15?'#d4a017':'#2c6f79';h+=`<div class="evt" style="border-left-color:${c}" data-act="mapView" data-lat="${m.latitude}" data-lng="${m.longitude}" data-z="15"><span class="evt-time">${fmt(m.time_a)}</span><span class="evt-loc">${esc(m.subject_a)} & ${esc(m.subject_b)} (${esc(m.confidence)})</span></div>`})}
  D.mapAnalysis.innerHTML=h;
}
function fitAllGeo(){const pts=[];state.data.geoRecords.forEach(r=>{if(r.latitude!=null&&r.longitude!=null)pts.push([r.latitude,r.longitude])});if(pts.length)state.map.instance.fitBounds(pts,{padding:[30,30]})}
function setupMapTime(rows){state.map.timeData=rows;D.mapTimeSlider.max=Math.max(0,rows.length-1);D.mapTimeSlider.value=0;updateMapTime()}
function updateMapTime(){if(!state.map.timeData.length)return;const idx=Math.min(parseInt(D.mapTimeSlider.value),state.map.timeData.length-1);const r=state.map.timeData[idx];if(!r)return;D.mapTimeLabel.textContent=fmt(r.start_time);state.map.instance.setView([r.latitude,r.longitude],15);state.map.markers.forEach(m=>{if(m.setStyle)m.setStyle({radius:5,opacity:0.4})});if(state.map.markers[idx]&&state.map.markers[idx].setStyle)state.map.markers[idx].setStyle({radius:10,color:'#b94a48',weight:3})}
D.mapTimeSlider.addEventListener('input',updateMapTime);
D.mapTimePlay.addEventListener('click',()=>{state.map.timePlaying=!state.map.timePlaying;D.mapTimePlay.textContent=state.map.timePlaying?'Stop':'Play';if(state.map.timePlaying)playMapTimeFn()});
function playMapTimeFn(){if(!state.map.timePlaying||!state.map.timeData.length)return;D.mapTimeSlider.value=Math.min(parseInt(D.mapTimeSlider.value)+1,state.map.timeData.length-1);updateMapTime();if(parseInt(D.mapTimeSlider.value)<state.map.timeData.length-1)setTimeout(playMapTimeFn,1000);else{state.map.timePlaying=false;D.mapTimePlay.textContent='Play'}}

// This tab owns its rendering; register with the router. Sidebar zoom rows delegate via data-act.
registerTab('map', initMap);
registerActions({
  mapView:(el)=>{const m=state.map.instance;if(m)m.setView([+el.dataset.lat,+el.dataset.lng],+el.dataset.z);},
  mapFit:(el)=>{const m=state.map.instance;if(!m)return;const b=el.dataset.b.split(',').map(Number);m.fitBounds([[b[0],b[1]],[b[2],b[3]]],{padding:[80,80]});},
});
// showTower is still reached from profile-tab tower chips via the transitional window bridge.
Object.assign(window,{showTower});
export { initMap, showTower };
