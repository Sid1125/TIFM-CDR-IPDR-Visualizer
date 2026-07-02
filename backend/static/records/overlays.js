// records/overlays.js — three modal record/detail overlays reachable from many tabs: a session's
// supporting records + evidence chain (showSessionRecords), a co-location meeting's detail
// (showMeetingOverlay, reading window.meetingStore), and a subject's recent records
// (showSubjectRecords). Extracted from app.js (records layer). Depends only on utils + record-index
// helpers + subject labels. All three are re-exposed on window (referenced from inline onclick
// strings across the app). No behavior change.

import { esc, fmt, evidenceHash } from '../core/utils.js';
import { rowsFor } from '../data/records.js';
import { subjLabel } from '../core/subjects.js';

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
    <h3 style="margin:0">Subject: ${subjLabel(sub)}</h3>
    <span style="color:var(--muted);font-size:0.7rem">${rows.length} records shown</span></div>
    <table style="width:100%;border-collapse:collapse">
      <thead><tr style="border-bottom:1px solid var(--line)"><th style="text-align:left;padding:3px">Time</th><th style="text-align:left;padding:3px">Type</th><th style="text-align:left;padding:3px">Counterpart</th><th style="text-align:left;padding:3px">Service</th><th style="text-align:left;padding:3px">Tower</th></tr></thead>
      <tbody>${rows.map(r=>'<tr style="border-bottom:1px solid var(--line)"><td style="padding:2px">'+fmt(r.ts)+'</td><td style="padding:2px">'+esc(r.type||'')+'</td><td style="padding:2px">'+esc(r.cnt||'')+'</td><td style="padding:2px">'+esc(r.svc||'')+'</td><td style="padding:2px">'+esc(r.tow||'')+'</td></tr>').join('')}</tbody>
    </table>`;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

// Referenced from inline onclick strings across the app; re-expose on window.
Object.assign(window,{showSessionRecords,showMeetingOverlay,showSubjectRecords});
