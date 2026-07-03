// data/workers.js — lazy Web Workers with same-thread fallbacks. _W owns two workers: an AI
// analytics pre-warm (ai-worker.js) and an off-main-thread export (export-worker.js), each created
// once and reused, and each degrading to inline execution when Workers are unavailable (e.g. file://
// origin). _aiComputeInline is the AI fallback (same logic as ai-worker.js). Extracted from app.js
// (data layer). No DOM/state deps. No behavior change.

// Inline fallback — same logic as ai-worker.js for environments without Worker support.
function _aiComputeInline(rows,wl){
  const pairCounts={};const subDays={};const svcCounts={};const towerHour=new Map();
  rows.forEach(r=>{
    if(r.type==='CDR'&&r.sub&&r.cnt){const k=r.sub+'|'+r.cnt;pairCounts[k]=(pairCounts[k]||0)+1;}
    if(r.sub&&r.tsMs){const d=new Date(r.tsMs).toISOString().slice(0,10);if(!subDays[r.sub])subDays[r.sub]={};subDays[r.sub][d]=(subDays[r.sub][d]||0)+1;}
    if(r.type==='CDR'&&r.sub){if(!svcCounts[r.sub])svcCounts[r.sub]={CALL:0,SMS:0,DATA:0};const ct=(r.callType||'').toUpperCase();if(ct.includes('CALL')||ct.includes('VOICE'))svcCounts[r.sub].CALL++;else if(ct.includes('SMS')||ct.includes('TEXT'))svcCounts[r.sub].SMS++;else svcCounts[r.sub].DATA++;}
    if(r.type==='CDR'&&r.sub&&r.tower&&r.tsMs){const dt=new Date(r.tsMs);const thKey=r.tower+'|'+dt.toISOString().slice(0,10)+'|'+dt.getUTCHours();if(!towerHour.has(thKey))towerHour.set(thKey,[]);towerHour.get(thKey).push({sub:r.sub,ts:r.tsMs,lat:r.lat,lon:r.lon});}
  });
  const allMeetings=[];
  for(const[thKey,entries]of towerHour){if(entries.length<2)continue;const tower=thKey.split('|')[0];const bySub=new Map();entries.forEach(e=>{if(!bySub.has(e.sub))bySub.set(e.sub,e);});const subs=[...bySub.keys()];for(let a=0;a<subs.length&&allMeetings.length<5000;a++){for(let b=a+1;b<subs.length&&allMeetings.length<5000;b++){const ea=bySub.get(subs[a]);allMeetings.push({a:subs[a],b:subs[b],ts:ea.ts,tower,lat:ea.lat,lon:ea.lon});}}}
  return {pairCounts,subDays,svcCounts,allMeetings};
}

export const _W = {
  _ai: null,
  _export: null,
  _aiPending: [],   // queue of {resolve, reject} waiting for the AI result
  _aiRunning: false,
  _exportQueue: [], // FIFO of {resolve, reject} — worker answers postMessages in order

  ai() {
    if (!this._ai && typeof Worker !== 'undefined') {
      try {
        this._ai = new Worker('/static/workers/ai-worker.js');
        this._ai.onmessage = (e) => {
          const msg = e.data;
          if (msg.type === 'done') {
            this._aiRunning = false;
            this._aiPending.forEach(({resolve}) => resolve(msg.result));
            this._aiPending = [];
          } else if (msg.type === 'error') {
            this._aiRunning = false;
            this._aiPending.forEach(({reject}) => reject(new Error(msg.message)));
            this._aiPending = [];
          }
          // 'progress' messages are ignored for now
        };
        this._ai.onerror = (err) => {
          this._aiRunning = false;
          this._aiPending.forEach(({reject}) => reject(err));
          this._aiPending = [];
          this._ai = null;  // recreate on next call
        };
      } catch (_) {}
    }
    return this._ai;
  },

  // Returns a Promise that resolves with the AI result object.
  // If state.data.records is large, this runs in the worker; otherwise inline.
  computeAi(rows, wl) {
    const worker = this.ai();
    if (!worker) return Promise.resolve(_aiComputeInline(rows, wl));
    return new Promise((resolve, reject) => {
      this._aiPending.push({resolve, reject});
      if (!this._aiRunning) {
        this._aiRunning = true;
        worker.postMessage({type: 'compute', rows, watchlist: wl});
      }
    });
  },

  // Export to CSV off-main-thread. Handlers are attached once and a FIFO queue
  // pairs each worker reply with its caller, so overlapping exports don't clobber
  // each other's onmessage/onerror.
  export(format, headers, rows, filename) {
    if (typeof Worker === 'undefined') {
      return Promise.resolve(null);  // caller falls back to sync export
    }
    try {
      if (!this._export) {
        this._export = new Worker('/static/workers/export-worker.js');
        this._export.onmessage = (e) => {
          const job = this._exportQueue.shift();
          if (!job) return;
          if (e.data.type === 'done') job.resolve(e.data);
          else job.reject(new Error(e.data.message || 'export failed'));
        };
        this._export.onerror = (err) => {
          const pending = this._exportQueue; this._exportQueue = [];
          this._export = null;  // recreate on next call
          pending.forEach(({reject}) => reject(err));
        };
      }
      return new Promise((resolve, reject) => {
        this._exportQueue.push({resolve, reject});
        this._export.postMessage({type: format, headers, rows, filename});
      });
    } catch (err) {
      return Promise.reject(err);
    }
  },
};
