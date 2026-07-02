// records/annotations.js — the Records-table flag/annotation toggle. Clicking a row's star flags
// (or unflags) that record via /annotations and mirrors it into the evidence board (pin/unpin), so a
// flagged record shows up in the dossier. _recordEvidence builds the evidence blurb from the record.
// Extracted from app.js (records layer). toggleAnnot is re-exposed on window (the Records-table row
// star's inline onclick references it). No behavior change.

import { fmt } from '../core/utils.js';
import { D } from '../core/dom.js';
import { state } from '../core/state.js';
import { API } from '../core/api.js';
import { subjLabelTxt } from '../core/subjects.js';
import { toast } from '../ui/toast.js';
import { pinEvidence, unpinEvidenceBySig } from '../workspace/evidence.js';

// Build an evidence item mirroring a flagged record, looked up from state.data.records for a meaningful blurb.
function _recordEvidence(r,numId){
  const row=state.data.records.find(x=>x.id===r.id)||{};
  const parts=[];
  if(row.ts)parts.push(fmt(row.ts));
  if(row.cnt)parts.push((r.type==='CDR'?'with ':'→ ')+row.cnt);
  if(row.dur!=null&&row.dur!=='')parts.push(row.dur+'s');
  if(row.svc)parts.push(row.svc);
  if(row.tow)parts.push('tower '+row.tow);
  return {kind:'record',sig:'record|'+r.type+'|'+numId,
    label:subjLabelTxt(row.sub||'?')+' — '+r.type,
    detail:'Flagged record · '+(parts.join(' · ')||(r.type+' #'+numId)),
    ts:row.ts||null,subject:row.sub||null};
}
function toggleAnnot(r){
  const numId=parseInt(r.id.slice(1));
  const key=r.type+'_'+numId;
  // Repaint just this row's star in place — re-rendering the whole table here would reset
  // the paged view back to the first page.
  const paint=()=>{const cell=D.recBody.querySelector('.annot-cell[data-annot="'+key+'"]');if(cell)cell.innerHTML=state.data.annotations[key]?'&#9733;':'&#9734;';};
  if(state.data.annotations[key]){
    API.del('/annotations/'+state.data.annotations[key].id).then(()=>{
      delete state.data.annotations[key];paint();
      unpinEvidenceBySig('record|'+r.type+'|'+numId);
    }).catch(()=>{});
  }else{
    API.post('/annotations/',{record_type:r.type,record_id:numId,tag:'flagged',note:''}).then(a=>{
      state.data.annotations[key]=a;paint();
      pinEvidence(_recordEvidence(r,numId));
      try{toast('Record added to evidence.');}catch(e){}
    }).catch(e=>{console.error('annotation failed',e);});
  }
}

// The Records-table row star's inline onclick references toggleAnnot; re-expose on window.
Object.assign(window,{toggleAnnot});
