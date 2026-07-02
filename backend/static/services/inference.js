// services/inference.js — shared fetch + cache of the server inference report (/inference/report),
// reused by the Inferences tab, the map overlays, the Story tab and the dossier. Extracted from app.js
// (frontend services layer). INF wraps the report + the rendered-HTML cache in an object so any module
// can reset them (INF.report=null / INF.cache=null) across the boundary. Depends only on state + API.

import { state } from '../core/state.js';
import { API } from '../core/api.js';

export const INF={report:null,cache:null};  // was _infReport / _infCache

export async function getInfReport(force){
  if(INF.report&&!force)return INF.report;
  const cq=state.data.caseId?'?case_id='+encodeURIComponent(state.data.caseId):'';
  INF.report=await API.get('/inference/report'+cq);
  return INF.report;
}
