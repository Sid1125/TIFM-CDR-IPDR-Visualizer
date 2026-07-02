// graph/network.js — the Network Graph (D3) tab: fetches a bounded subgraph from /graph/, then
// renders it either as interactive SVG (small graphs) or a canvas force-layout (large graphs, above
// GRAPH_CANVAS_MIN) with zoom/pan, hover, click-to-profile, search-highlight and per-node drag. Also
// renders the Network Intelligence sidebar (server centrality leaderboards). Extracted from app.js
// (feature layer). Reads the d3 global; showProfile/showSubjectRecords in generated onclick strings
// resolve via the window bridge. Self-registers with the router. No behavior change.

import { esc } from '../core/utils.js';
import { D } from '../core/dom.js';
import { state } from '../core/state.js';
import { API } from '../core/api.js';
import { isSuspect, subjTag, subjLabelTxt } from '../core/subjects.js';
import { registerTab } from '../core/router.js';

let curGraphNodes=null,curGraphLinks=null,curGraphSim=null,curCentrality=null;
// Cleanup for the canvas graph's window-level drag listeners, so they never stack across reloads.
let _gCanvasDragCleanup=null;
// Network Intelligence sidebar panel — surfaces the server's full-graph centrality leaderboards
// (PageRank, betweenness, degree, closeness) so the new metrics are visible, not just node weight.
async function renderNetworkIntel(){
  const el=document.getElementById('graphNetIntel');
  if(!el) return;
  el.innerHTML='<div style="font-size:0.74rem;opacity:0.55">Computing network intelligence…</div>';
  let m;
  try{
    const p=new URLSearchParams(); if(state.data.caseId)p.set('case_id',state.data.caseId);
    m=await API.get('/graph/metrics?'+p.toString());
  }catch(e){el.innerHTML='';return;}
  if(!m||!m.degree_centrality||!Object.keys(m.degree_centrality).length){el.innerHTML='';return;}
  const top=(obj,n=8)=>Object.entries(obj||{}).sort((a,b)=>b[1]-a[1]).slice(0,n);
  const board=(title,obj,note)=>{
    const rows=top(obj); if(!rows.length) return '';
    return '<div style="margin-bottom:9px"><div style="font-size:0.74rem;font-weight:600;margin-bottom:2px">'+title
      +(note?' <span style="font-weight:400;opacity:0.6">('+note+')</span>':'')+'</div>'
      +rows.map(([id,v])=>'<div onclick="showProfile(\''+esc(String(id))+'\')" style="display:flex;justify-content:space-between;gap:8px;cursor:pointer;font-size:0.76rem;padding:1px 0"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(String(id))+'</span><span style="opacity:0.65;font-variant-numeric:tabular-nums">'+(+v).toFixed(3)+'</span></div>').join('')
      +'</div>';
  };
  let html='<h3 style="margin:0 0 6px">Network Intelligence</h3>';
  html+='<div style="font-size:0.7rem;opacity:0.6;margin-bottom:8px">Leaders across the whole case graph ('+(m.total_nodes||0)+' nodes). Click to open a profile.</div>';
  html+=board('PageRank — influence',m.pagerank);
  html+=board('Betweenness — brokers',m.betweenness_centrality,m.betweenness_sampled?'sampled':'');
  html+=board('Degree — most connected',m.degree_centrality);
  html+=m.closeness_skipped
    ? '<div style="font-size:0.74rem;font-weight:600;margin-bottom:9px">Closeness — reach <span style="font-weight:400;opacity:0.6">(skipped — graph too large)</span></div>'
    : board('Closeness — reach',m.closeness_centrality);
  const nc=(m.communities||[]).length, nb=(m.bridges||[]).length;
  html+='<div style="font-size:0.72rem;opacity:0.7;margin-top:4px">'+nc+' communit'+(nc===1?'y':'ies')+' · '+nb+' bridge'+(nb===1?'':'s')+'</div>';
  el.innerHTML=html;
}

// Phase 2c — Canvas force-graph for large networks. SVG (renderGraph below) gives nice per-node
// interactions but bogs down past ~1-2k DOM nodes; above GRAPH_CANVAS_MIN we render to a single
// <canvas> instead (D3 drives the layout, canvas draws), which scales to many thousands of nodes.
// Zoom/pan, hover, click-to-profile, search-highlight AND per-node drag are all kept — the drag is
// hand-rolled (canvas has no per-node DOM) so a dense graph stays interactive after it settles.
const GRAPH_CANVAS_MIN=700;

function _renderGraphCanvas(nodes,links,subject,w,h){
  const cont=D.graphSvg;
  cont.innerHTML='';
  const dpr=window.devicePixelRatio||1;
  const canvas=document.createElement('canvas');
  canvas.width=w*dpr;canvas.height=h*dpr;canvas.style.width=w+'px';canvas.style.height=h+'px';canvas.style.cursor='grab';
  cont.appendChild(canvas);
  const ctx=canvas.getContext('2d');
  // group-stroke colours (mirror the SVG path)
  const _grpPalette=['#e03131','#2f9e44','#1971c2','#e67700','#9c36b5','#c2255c','#0c8599','#5c7cfa'];
  const _grpColor={};let _gi=0;
  (state.watchlist||[]).forEach(e=>{const g=e.group_name||'Default';if(!_grpColor[g])_grpColor[g]=_grpPalette[_gi++%_grpPalette.length];});
  const _stroke=id=>{const e=(state.watchlist||[]).find(x=>x.value===id);return e?(_grpColor[e.group_name||'Default']||'#e03131'):'#fff';};
  const textColor=(getComputedStyle(document.body).getPropertyValue('--text')||'#333').trim()||'#333';
  const nodeR=d=>Math.max(2.5,Math.min(14,d.weight*0.18));
  let transform=d3.zoomIdentity, hl='';
  const match=d=>{const id=(d.id||d);return id.toLowerCase().includes(hl);};
  function draw(){
    ctx.save();
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,w,h);
    ctx.translate(transform.x,transform.y);ctx.scale(transform.k,transform.k);
    for(const l of links){
      const dim=hl&&!(match(l.source)||match(l.target));
      ctx.globalAlpha=dim?0.04:0.45;ctx.strokeStyle='#cbb8a4';ctx.lineWidth=Math.max(0.4,Math.min(4,l.weight*0.4))/transform.k;
      ctx.beginPath();ctx.moveTo(l.source.x,l.source.y);ctx.lineTo(l.target.x,l.target.y);ctx.stroke();
    }
    for(const d of nodes){
      const dim=hl&&!match(d);
      ctx.globalAlpha=dim?0.12:1;ctx.beginPath();ctx.arc(d.x,d.y,nodeR(d),0,6.2832);
      ctx.fillStyle=d.id===subject?'#b94a48':(d.kind==='ipdr'?'#7b4f9c':'#2c6f79');ctx.fill();
      if(isSuspect(d.id)){ctx.lineWidth=2.5/transform.k;ctx.strokeStyle=_stroke(d.id);ctx.stroke();}
    }
    if(transform.k>1.5){
      ctx.globalAlpha=1;ctx.fillStyle=textColor;ctx.font=(10/transform.k)+'px sans-serif';
      for(const d of nodes){if(hl&&!match(d))continue;ctx.fillText(d.id.length>16?d.id.slice(0,16)+'…':d.id,d.x+nodeR(d)+2/transform.k,d.y+3/transform.k);}
    }
    ctx.restore();
  }
  // Coalesce sim-tick redraws to one per animation frame. On a big graph the force sim ticks faster
  // than the canvas can paint, and drawing on every tick is what made large layouts crawl.
  let _drawQueued=false;
  function scheduleDraw(){if(_drawQueued)return;_drawQueued=true;requestAnimationFrame(()=>{_drawQueued=false;draw();});}
  // Pick the node under a canvas point (screen coords), accounting for the current zoom/pan.
  const nodeAt=(mx,my)=>{
    const x=(mx-transform.x)/transform.k,y=(my-transform.y)/transform.k;let best=null,bd=1e18;
    for(const d of nodes){const dx=d.x-x,dy=d.y-y,dist=dx*dx+dy*dy,r=nodeR(d)+6/transform.k;if(dist<r*r&&dist<bd){bd=dist;best=d;}}
    return best;
  };
  // Pure client-side canvas layout — the browser runs the force simulation and draws to canvas
  // (the pre-server-layout rendition). Server-side layout was dropped: it recomputed a Python
  // Fruchterman-Reingold pass over every node on each request and simply never returned for the
  // "All links" case on large cases. Here the forces are tuned to stay responsive at scale: on a
  // big graph repulsion range is capped (distanceMax) with a coarser Barnes-Hut theta, collision is
  // skipped, and the cooldown is faster, so even tens of thousands of nodes settle and stay draggable.
  const N=nodes.length, BIG=N>2500;
  let _userInteracted=false;  // gates the one-time fit-to-view (any user pan/zoom/drag disables it)
  // Seed positions in a viewport-centred spiral so the layout starts already spread out — d3's
  // default drops every node near the origin, which reads as "collapsed for a second then jumps".
  nodes.forEach((d,i)=>{if(d.x==null){const a=i*2.399963,r=Math.sqrt((i+1)/N)*Math.min(w,h)*0.45;d.x=w/2+r*Math.cos(a);d.y=h/2+r*Math.sin(a);}});
  const sim=d3.forceSimulation(nodes)
    .force('link',d3.forceLink(links).id(d=>d.id).distance(BIG?40:60))
    .force('charge',d3.forceManyBody().strength(BIG?-45:-90).theta(0.9).distanceMax(BIG?350:Infinity))
    .force('center',d3.forceCenter(w/2,h/2))
    .force('collision',BIG?null:d3.forceCollide(8))
    .velocityDecay(0.45)
    .alphaDecay(BIG?0.045:0.0228)
    .on('tick',scheduleDraw);
  curGraphNodes=nodes;curGraphLinks=links;curGraphSim=sim;
  const zoom=d3.zoom().scaleExtent([0.05,8])
    // A press that lands on a node starts a node-drag; empty-space press + wheel still pan/zoom.
    .filter(ev=>{
      if(ev.type==='mousedown'){const rc=canvas.getBoundingClientRect();return !nodeAt(ev.clientX-rc.left,ev.clientY-rc.top);}
      return !ev.button;
    })
    .on('start',e=>{if(e.sourceEvent)_userInteracted=true;})  // a real user gesture cancels auto-fit
    .on('zoom',e=>{transform=e.transform;draw();});
  d3.select(canvas).call(zoom);
  // Frame the whole graph in the viewport once it settles (unless the user already moved the view),
  // so "fully rendered" means neatly fit — not a hairball parked off-centre at k=1.
  function fitView(){
    if(!nodes.length)return;
    let a=Infinity,b=Infinity,c=-Infinity,e=-Infinity;
    for(const d of nodes){if(d.x<a)a=d.x;if(d.y<b)b=d.y;if(d.x>c)c=d.x;if(d.y>e)e=d.y;}
    const gw=Math.max(1,c-a),gh=Math.max(1,e-b),pad=40;
    const k=Math.min(8,Math.max(0.05,Math.min((w-2*pad)/gw,(h-2*pad)/gh)));
    d3.select(canvas).call(zoom.transform,d3.zoomIdentity.translate(w/2-k*(a+c)/2,h/2-k*(b+e)/2).scale(k));
  }
  sim.on('end',()=>{if(!_userInteracted)fitView();});
  // Hand-rolled per-node drag: pick with nodeAt, move via fx/fy while the sim is reheated so
  // neighbours trail along, then release on mouseup. Window-level move/up handlers are torn down on
  // every render (via _gCanvasDragCleanup) so they never accumulate across graph reloads.
  _gCanvasDragCleanup&&_gCanvasDragCleanup();
  let dragNode=null;
  const onDown=ev=>{
    const rc=canvas.getBoundingClientRect();const d=nodeAt(ev.clientX-rc.left,ev.clientY-rc.top);
    if(!d)return;
    dragNode=d;d._moved=false;_userInteracted=true;
    // reheat assertively so neighbours visibly follow — a weak reheat makes the graph feel frozen
    sim.alpha(Math.max(sim.alpha(),0.5)).alphaTarget(0.3).restart();
    d.fx=d.x;d.fy=d.y;canvas.style.cursor='grabbing';ev.preventDefault();
  };
  const onMove=ev=>{
    if(!dragNode)return;
    const rc=canvas.getBoundingClientRect();
    const nx=(ev.clientX-rc.left-transform.x)/transform.k, ny=(ev.clientY-rc.top-transform.y)/transform.k;
    // Set x/y directly (not just fx/fy): draw() reads x, and fx only propagates to x on a sim tick —
    // so once the sim settles and stops ticking, fx alone wouldn't move the node. Setting both makes
    // the grabbed node follow the cursor immediately whether or not the sim is currently running.
    dragNode.fx=dragNode.x=nx; dragNode.fy=dragNode.y=ny;
    dragNode._moved=true; draw();
  };
  const onUp=()=>{
    if(!dragNode)return;
    sim.alphaTarget(0);
    // release the pin so forces relax around the dropped node; if it wasn't really moved, treat the
    // gesture as a click and open the profile.
    const d=dragNode;d.fx=null;d.fy=null;dragNode=null;canvas.style.cursor='grab';
    if(!d._moved)showProfile(d.id);
  };
  canvas.addEventListener('mousedown',onDown);
  window.addEventListener('mousemove',onMove);
  window.addEventListener('mouseup',onUp);
  _gCanvasDragCleanup=()=>{window.removeEventListener('mousemove',onMove);window.removeEventListener('mouseup',onUp);_gCanvasDragCleanup=null;};
  canvas.addEventListener('mousemove',ev=>{
    if(dragNode)return;  // don't fight the drag cursor/hover while dragging
    const rc=canvas.getBoundingClientRect();const d=nodeAt(ev.clientX-rc.left,ev.clientY-rc.top);
    canvas.style.cursor=d?'pointer':'grab';
    if(d)D.graphDetails.innerHTML=`<strong>${esc(d.id)}</strong> <span style="font-size:0.6rem;padding:1px 5px;border-radius:3px;background:${d.kind==='ipdr'?'#7b4f9c':'var(--accent)'};color:#fff">${d.kind==='ipdr'?'IPDR':'CDR'}</span><br>Total weight: ${d.weight}<br><button class="btn btn-sm" onclick="showSubjectRecords('${esc(d.id)}')" style="font-size:0.65rem;margin-top:4px">View Records</button>`;
  });
  D.graphSearch._handler&&D.graphSearch.removeEventListener('input',D.graphSearch._handler);
  D.graphSearch._handler=()=>{hl=D.graphSearch.value.trim().toLowerCase();draw();};
  D.graphSearch.addEventListener('input',D.graphSearch._handler);
  D.graphStats.textContent+=' · canvas';
}

export async function renderGraph(){
  const subject=D.graphSubject.value;
  // Max links to draw: user-selectable (0 = all). The browser force-layout gets sluggish past
  // a couple thousand nodes, so the picker tops out at 2000 with an explicit "All" escape hatch.
  const limit=D.graphLimit?parseInt(D.graphLimit.value):(subject?500:150);
  // Fetch a bounded subgraph server-side (top-N heaviest edges) so the browser normally renders a
  // trimmed view; "All" (0) is the explicit escape hatch that pulls every edge. Node weights are the
  // node's TRUE total over all edges, so the view is trimmed but the weights/degrees stay full.
  if(limit===0){
    const ok=confirm('Rendering all links may freeze the browser for large cases. Continue?');
    if(!ok){if(D.graphLimit)D.graphLimit.value='300';return;}
  }
  let payload;
  try{
    const p=new URLSearchParams();
    if(state.data.caseId)p.set('case_id',state.data.caseId);
    if(subject)p.set('subject',subject);
    p.set('limit',limit);
    payload=await API.get('/graph/?'+p.toString());
  }catch(e){console.error('graph load',e);D.graphStats.textContent='Failed to load graph.';return;}
  D.graphSvg.innerHTML='<svg width="100%" height="100%"></svg>';
  const svg=d3.select(D.graphSvg).select('svg'),w=D.graphSvg.clientWidth||800,h=D.graphSvg.clientHeight||500;
  const links=(payload.edges||[]).map(e=>({key:e.source+'|'+e.target,source:e.source,target:e.target,weight:e.weight}));
  const nodes=(payload.nodes||[]).map(n=>({id:n.id,weight:n.weight,kind:n.kind||'cdr'}));
  if(!nodes.length){D.graphStats.textContent='No connections'+(subject?' for this subject':'')+'.';return;}
  const moreEdges=(payload.total_edges||links.length)-(payload.shown_edges||links.length);
  D.graphStats.textContent=`${nodes.length} nodes, ${links.length} links`+(moreEdges>0?` (top ${links.length} of ${payload.total_edges})`:'')+(payload.total_nodes?` · ${payload.total_nodes} nodes total`:'');
  renderNetworkIntel();  // full-graph centrality leaderboards in the sidebar (fire-and-forget)

  // Large network → canvas renderer (scales to thousands of nodes); small → the SVG path below.
  if(nodes.length>GRAPH_CANVAS_MIN){ _renderGraphCanvas(nodes,links,subject,w,h); return; }

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

  // Per-group distinct colors so investigators can distinguish named groups at a glance.
  const _grpPalette=['#e03131','#2f9e44','#1971c2','#e67700','#9c36b5','#c2255c','#0c8599','#5c7cfa'];
  const _grpColor={};let _grpIdx=0;
  (state.watchlist||[]).forEach(e=>{const g2=e.group_name||'Default';if(!_grpColor[g2])_grpColor[g2]=_grpPalette[_grpIdx++%_grpPalette.length];});
  function _nodeStroke(d){const e=(state.watchlist||[]).find(x=>x.value===d.id);if(!e)return '#fff';return _grpColor[e.group_name||'Default']||'#e03131';}

  const link=g.append('g').selectAll('line').data(links).join('line').attr('stroke','#dccfc0').attr('stroke-width',d=>Math.max(0.5,Math.min(6,d.weight*0.5))).attr('stroke-opacity',0.6);
  const node=g.append('g').selectAll('circle').data(nodes).join('circle').attr('r',d=>Math.max(4,Math.min(16,d.weight*0.2))).style('fill',d=>d.id===subject?'#b94a48':(d.kind==='ipdr'?'#7b4f9c':'var(--accent)')).attr('stroke',d=>_nodeStroke(d)).attr('stroke-width',d=>isSuspect(d.id)?3.5:1.5).style('cursor','pointer')
    .on('mouseover',(e,d)=>{
      const deg=curCentrality?curCentrality.degree.find(x=>x[0]===d.id):null;
      D.graphDetails.innerHTML=`<strong>${esc(d.id)}</strong> <span style="font-size:0.6rem;padding:1px 5px;border-radius:3px;background:${d.kind==='ipdr'?'#7b4f9c':'var(--accent)'};color:#fff">${d.kind==='ipdr'?'IPDR':'CDR'}</span><br>
        Total weight: ${d.weight}<br>
        Connections (shown): ${links.filter(l=>(l.source.id||l.source)===d.id||(l.target.id||l.target)===d.id).length}<br>
        ${deg?`Degree: ${deg[1]}<br>`:''}<button class="btn btn-sm" onclick="showSubjectRecords('${esc(d.id)}')" style="font-size:0.65rem;margin-top:4px">View Records</button>`
    })
    // Open the profile from drag-end when the pointer didn't move — d3-drag swallows the native
    // 'click', so we detect a click as a zero-movement gesture instead.
    .call(d3.drag()
      // Reheat on START (event.active is 0 here) so the sim keeps ticking through the drag — the
      // tick handler is what repaints cx/cy. The reheat used to live in 'drag' guarded by
      // `!e.active`, but event.active is 1 during a drag, so it never fired and a settled graph
      // froze (nodes undraggable once the initial layout cooled).
      .on('start',(e,d)=>{if(!e.active)sim.alphaTarget(0.3).restart();d.fx=d.x;d.fy=d.y;d._sx=e.x;d._sy=e.y;d._moved=false})
      .on('drag',(e,d)=>{d._moved=true;d.fx=e.x;d.fy=e.y})
      .on('end',(e,d)=>{if(!e.active)sim.alphaTarget(0);d.fx=null;d.fy=null;const dx=e.x-(d._sx||0),dy=e.y-(d._sy||0);if(!d._moved||dx*dx+dy*dy<36)showProfile(d.id);}));

  const showTags=!!(D.graphShowTags&&D.graphShowTags.checked);
  const label=g.append('g').selectAll('text').data(nodes).join('text').text(d=>{const base=d.id.length>12?d.id.slice(0,12)+'...':d.id;if(showTags){const t=subjTag(d.id);if(t)return base+' ('+(t.length>18?t.slice(0,18)+'…':t)+')';}return base;}).attr('font-size','9').attr('dx',d=>Math.max(5,d.weight*0.2+5))   .attr('dy',3).attr('class','graph-label').style('pointer-events','none');

  sim.on('tick',()=>{link.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y).attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);node.attr('cx',d=>d.x).attr('cy',d=>d.y);label.attr('x',d=>d.x).attr('y',d=>d.y)});

  // Search
  D.graphSearch._handler&&D.graphSearch.removeEventListener('input',D.graphSearch._handler);
  D.graphSearch._handler=()=>{
    const q=D.graphSearch.value.trim().toLowerCase();
    node.attr('opacity',d=>!q||d.id.toLowerCase().includes(q)?1:0.1);
    link.attr('opacity',d=>!q||(d.source.id||d.source).toLowerCase().includes(q)||(d.target.id||d.target).toLowerCase().includes(q)?0.4:0.05);
  };
  D.graphSearch.addEventListener('input',D.graphSearch._handler);

  // Group color legend
  const legendEntries=Object.entries(_grpColor);
  if(legendEntries.length){
    const legEl=document.getElementById('graphGroupLegend');
    if(legEl)legEl.innerHTML='<div style="font-size:0.7rem;font-weight:600;color:var(--muted);margin-bottom:4px">Groups</div>'
      +legendEntries.map(([name,color])=>`<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px"><span style="width:10px;height:10px;border-radius:50%;border:2.5px solid ${color};display:inline-block;flex-shrink:0"></span><span style="font-size:0.72rem">${esc(name)}</span></div>`).join('');
  }
}
if(D.graphLimit)D.graphLimit.addEventListener('change',renderGraph);
D.graphReset.addEventListener('click',()=>location.reload());
D.graphCenter.addEventListener('click',()=>{const svg=d3.select(D.graphSvg).select('svg');svg.transition().duration(500).call(d3.zoom().transform,d3.zoomIdentity)});
if(D.graphShowTags)D.graphShowTags.addEventListener('change',renderGraph);

export function initGraphSubjects(){
  // Focus the graph on a real subject (a-party / source IP), not one of the tens of thousands of
  // counterparts — same reason the analysis/correlation pickers use _ownedSubjects.
  const gsubs=(state._ownedSubjects&&state._ownedSubjects.length)?state._ownedSubjects:state.subjects;
  D.graphSubject.innerHTML='<option value="">All subjects</option>'+gsubs.map(s=>`<option value="${esc(s)}">${esc(subjLabelTxt(s))}</option>`).join('');
  if(D.graphSubject._handler)D.graphSubject.removeEventListener('change',D.graphSubject._handler);
  D.graphSubject._handler=renderGraph;
  D.graphSubject.addEventListener('change',D.graphSubject._handler);
}

// This tab owns its rendering; register with the router.
registerTab('graph', renderGraph);
