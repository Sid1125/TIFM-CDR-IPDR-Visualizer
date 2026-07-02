// services/meetings.js — the meeting / co-location cache. Meeting detection runs server-side
// (exact, full-coverage: /investigation/meetings); ensureMeetingsLoaded() fetches the whole case once
// into meetingsCache.v (client-shaped), and every consumer reads it synchronously via detectMeetings()
// or meetingTotals(). Extracted from app.js (frontend services layer). meetingsCache is wrapped in an
// object so app.js can reset its value (meetingsCache.v=null) across the module boundary. Depends only
// on core state + API. No behavior change.

import { state } from '../core/state.js';
import { API } from '../core/api.js';

export const meetingsCache={v:null};  // was the loose _meetings global

export async function ensureMeetingsLoaded(force){
  if(meetingsCache.v&&!force)return meetingsCache.v;
  try{
    const p=new URLSearchParams();if(state.data.caseId)p.set('case_id',state.data.caseId);p.set('limit','2000');
    const r=await API.get('/investigation/meetings?'+p.toString());
    const byPair=new Map();
    (r.meetings||[]).forEach(m=>{const k=[m.subject_a,m.subject_b].sort().join('|');byPair.set(k,(byPair.get(k)||0)+1);});
    const list=(r.meetings||[]).map(m=>{
      const gl=(m.confidence||'').toLowerCase()||(m.gap_min<5?'high':m.gap_min<15?'medium':'low');
      const k=[m.subject_a,m.subject_b].sort().join('|');
      return {subA:m.subject_a,subB:m.subject_b,tow:m.tower_id,lat:m.latitude,lng:m.longitude,
        time:new Date(m.time_a),gap:m.gap_min,gapLevel:gl,
        score:gl==='high'?90:gl==='medium'?60:30,
        encounterCount:byPair.get(k)||1,subAEvent:'',subBEvent:'',
        evidence:['Time gap: '+Math.round(m.gap_min)+'m ('+gl+')'+(byPair.get(k)>1?'; '+byPair.get(k)+' same-tower encounters':'')]};
    });
    meetingsCache.v={list,total:r.total||list.length,high:r.high||0,medium:r.medium||0,low:r.low||0};
  }catch(e){console.error('meetings load',e);meetingsCache.v={list:[],total:0,high:0,medium:0,low:0};}
  return meetingsCache.v;
}
// Exact meeting totals (full case), used by count consumers instead of the (capped) list length.
export function meetingTotals(){return meetingsCache.v||{list:[],total:0,high:0,medium:0,low:0};}
export function detectMeetings(opts){
  const {subject,subjectA,subjectB,allPairs,maxResults}=opts||{};
  const all=(meetingsCache.v&&meetingsCache.v.list)||[];
  let res;
  if(subject){
    res=all.filter(m=>m.subA===subject||m.subB===subject);
  }else if(subjectA&&subjectB){
    res=all.filter(m=>(m.subA===subjectA&&m.subB===subjectB)||(m.subA===subjectB&&m.subB===subjectA));
  }else{ // allPairs / default
    res=all.slice();
  }
  res.sort((a,b)=>b.score-a.score);
  return maxResults?res.slice(0,maxResults):res;
}
