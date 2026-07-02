// services/cache.js — the shared analytics caches and their single invalidator. Extracted from
// app.js (frontend services layer). The session cache (reconstructSessions) and identity cache
// (buildIdentityProfile) are plain objects mutated in place, so cross-module writes are visible
// everywhere; the dashboard aggregate is wrapped in an object so its value can be reassigned from any
// module (an imported `let` binding can't be). clearAnalyticsCaches() drops all three when the loaded
// record set changes size (background load). No behavior change.

import { state } from '../core/state.js';

export const sessionCache={};          // was _rSess
export const identCache={};            // was _rIdent
export const dashAgg={v:null,len:-1};  // was _dashAgg / _dashAggLen

let _cacheRowLen=-1;
export function clearAnalyticsCaches(){
  if(state.data.records.length===_cacheRowLen)return;
  _cacheRowLen=state.data.records.length;
  Object.keys(sessionCache).forEach(k=>delete sessionCache[k]);
  Object.keys(identCache).forEach(k=>delete identCache[k]);
  dashAgg.v=null;dashAgg.len=-1;  // dashboard agg also stale
}
