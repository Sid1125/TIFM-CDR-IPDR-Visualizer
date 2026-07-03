// ui/gantt_tooltip.js — the rich hover tooltip for session Gantt bars (Timeline + Profile): shows
// the attributed service, time span, confidence, an evidence tree (infrastructure / ports / behavior /
// signals), alternative services, and a View-Records button with the session's integrity hash. Also
// the show/hide/position helpers. Extracted from app.js (ui layer). showSessionRecords + the evSessions
// store in the onclick string resolve via the window bridge / window global; showGanttTip +
// scheduleHideGanttTip are re-exposed on window (they moved out of the app.js bridge). No behavior change.

import { esc } from '../core/utils.js';
import { svcColor } from '../core/constants.js';
import { evidenceHash } from '../core/utils.js';

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

// Referenced from inline on*= handlers on the Gantt bars; re-expose on window.
Object.assign(window,{showGanttTip,scheduleHideGanttTip,hideGanttTip});
