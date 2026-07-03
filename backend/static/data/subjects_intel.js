// data/subjects_intel.js — subject intel tags + suspect groups. loadSubjectTags fetches the
// global-by-identifier intel tags into state.subjectTags; loadSuspects fetches the watchlist values +
// groups into state.suspects*. addToSuspectGroup / saveProfileTag are the interactive add-a-suspect /
// save-a-tag flows (re-rendering the records/graph/inferences views they affect). Extracted from
// app.js. addToSuspectGroup + saveProfileTag are re-exposed on window (profile-modal inline handlers).
// No behavior change.

import { state } from '../core/state.js';
import { D } from '../core/dom.js';
import { API } from '../core/api.js';
import { toast } from '../ui/toast.js';
import { subjLabelTxt } from '../core/subjects.js';
import { renderRecTable } from '../records/table.js';
import { renderGraph } from '../graph/network.js';
import { renderInferences } from '../analytics/inferences.js';
import { INF } from '../services/inference.js';

export async function loadSubjectTags(){
  try{const rows=await API.get('/subject-tags/');const m={};(rows||[]).forEach(r=>{if(r.subject)m[r.subject]=r.tag});state.subjectTags=m;}
  catch(e){state.subjectTags=state.subjectTags||{};}
}

export async function loadSuspects(){
  try{const [v,g]=await Promise.all([API.get('/watchlist/values'),API.get('/watchlist/groups')]);
    state.suspects=v||[];state.suspectSet=new Set((v||[]).map(x=>String(x.value)));state.suspectGroups=g||[];}
  catch(e){state.suspects=[];state.suspectSet=new Set();state.suspectGroups=[];}
}
window.addToSuspectGroup=async function(value,kind){
  value=String(value==null?'':value).trim();if(!value)return;
  const def=state._lastGroup||((state.suspectGroups||[])[0]||{}).group_name||'Default';
  const group=prompt('Add "'+value+'" to which suspect group?',def);
  if(group===null)return;
  state._lastGroup=(group||'').trim()||'Default';
  try{await API.post('/watchlist',{value:value,kind:kind||undefined,group_name:state._lastGroup,case_id:state.data.caseId||null});
    await loadSuspects();try{toast('Added “'+value+'” to suspect group “'+state._lastGroup+'”.');}catch(e){}
    if(state.tab==='records')renderRecTable();
    if(state.tab==='graph')renderGraph();
    if(state.tab==='inferences'){INF.cache=null;renderInferences(true);}
  }catch(e){try{toast('Could not add to suspect group');}catch(_){}}
};

async function saveSubjectTag(sub,tag){
  const r=await API.put('/subject-tags/',{subject:sub,tag:tag});
  const t=(tag||'').trim();
  if(t)state.subjectTags[sub]=t;else delete state.subjectTags[sub];
  return r;
}
function saveProfileTag(sub){
  const inp=document.getElementById('profileTagInput');if(!inp)return;
  const val=inp.value.trim();
  saveSubjectTag(sub,val).then(()=>{
    try{toast(val?'Intel tag saved':'Intel tag cleared');}catch(e){}
    if(D.profileTitle)D.profileTitle.textContent='Subject: '+subjLabelTxt(sub);
  }).catch(e=>{try{toast('Could not save tag');}catch(_){} });
}

// Profile-modal inline handlers reference these on window (addToSuspectGroup already assigned above).
Object.assign(window,{saveProfileTag});
