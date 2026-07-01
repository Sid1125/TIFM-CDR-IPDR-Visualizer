// core/state.js — the single shared, mutable application store. Extracted from app.js (step 4 of
// the frontend modularization). Feature modules import `state` and read/write through it: because
// it's ONE shared object, cross-module writes (state.data.caseId = …, state.data.records = …) are
// visible everywhere — unlike a top-level `let`, which can't be reassigned across a module boundary.
// That's why the loose globals (allRows, activeCaseId, geoRecords, …) are being folded into the
// grouped namespaces below over the next few steps.

export const state={
  auth:{status:'checking',user:null,session:null},
  cdr:[],ipdr:[],towers:[],tab:'dashboard',subjects:[],graphData:null,timeline:[],charts:{},
  subjectTags:{},_ownedSubjects:[],_cdrStats:null,_ipdrStats:null,_cd:null,_totalCdr:0,_totalIpdr:0,

  // grouped namespaces for folded-in loose globals (populated in steps 4.1+)
  data:{caseId:null,records:[],rowIdx:new Map(),ownedRowIdx:new Map(),geoRecords:[],geoSubjects:[]},
};
