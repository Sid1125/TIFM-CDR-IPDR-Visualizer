/**
 * ai-worker.js — off-main-thread AI analytics
 *
 * Receives: { type: 'compute', rows: allRows[], watchlist: [{value, group_name}] }
 * Posts back:
 *   { type: 'progress', pct: 0-100 }
 *   { type: 'done', result: { pairCounts, subDays, svcCounts, allMeetings, svcDist } }
 *   { type: 'error', message: string }
 *
 * Runs entirely off the main thread — no DOM access.
 * Uses tsMs (pre-computed epoch ms) on each row — never calls new Date(string).
 */

self.onmessage = function (e) {
  const msg = e.data;
  if (msg.type !== 'compute') return;

  try {
    const rows = msg.rows || [];
    const wl = msg.watchlist || [];
    const total = rows.length;
    if (!total) {
      self.postMessage({ type: 'done', result: _empty() });
      return;
    }

    // ── pair counts: CDR contact pairs ────────────────────────────────────────
    const pairCounts = new Map();   // "A|B" -> n
    const subDays = new Map();      // sub -> Map(date_str -> n)
    const svcCounts = new Map();    // sub -> {CALL:n, SMS:n, DATA:n}
    // For meetings (co-presence): bucket by tower+hour key -> [{sub, ts, lat, lon}]
    const towerHour = new Map();    // "tower|YYYY-MM-DD|HH" -> [{sub,ts,lat,lon}]

    let processed = 0;
    const CHUNK = 5000;

    for (let i = 0; i < total; i++) {
      const r = rows[i];

      if (r.type === 'CDR' && r.sub && r.cnt) {
        // pair counts
        const key = r.sub + '|' + r.cnt;
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }

      // subDays
      if (r.sub && r.tsMs) {
        const d = new Date(r.tsMs).toISOString().slice(0, 10);
        if (!subDays.has(r.sub)) subDays.set(r.sub, new Map());
        const dm = subDays.get(r.sub);
        dm.set(d, (dm.get(d) || 0) + 1);
      }

      // svcCounts (CDR only, a-party)
      if (r.type === 'CDR' && r.sub) {
        if (!svcCounts.has(r.sub)) svcCounts.set(r.sub, { CALL: 0, SMS: 0, DATA: 0 });
        const sc = svcCounts.get(r.sub);
        const ct = (r.callType || '').toUpperCase();
        if (ct.includes('CALL') || ct.includes('VOICE')) sc.CALL++;
        else if (ct.includes('SMS') || ct.includes('TEXT') || ct.includes('MMS')) sc.SMS++;
        else sc.DATA++;
      }

      // Co-presence bucket (CDR with tower, owned rows)
      if (r.type === 'CDR' && r.sub && r.tower && r.tsMs) {
        const dt = new Date(r.tsMs);
        const thKey = r.tower + '|' + dt.toISOString().slice(0, 10) + '|' + dt.getUTCHours();
        if (!towerHour.has(thKey)) towerHour.set(thKey, []);
        towerHour.get(thKey).push({ sub: r.sub, ts: r.tsMs, lat: r.lat, lon: r.lon });
      }

      processed++;
      if (processed % CHUNK === 0) {
        self.postMessage({ type: 'progress', pct: Math.round(processed / total * 80) });
      }
    }

    // ── derive allMeetings from towerHour buckets ─────────────────────────────
    const allMeetings = [];
    const MEET_CAP = 5000;
    for (const [thKey, entries] of towerHour) {
      if (entries.length < 2) continue;
      const tower = thKey.split('|')[0];
      // unique subjects in this bucket
      const bySub = new Map();
      for (const e of entries) {
        if (!bySub.has(e.sub)) bySub.set(e.sub, e);
      }
      const subs = [...bySub.keys()];
      for (let a = 0; a < subs.length && allMeetings.length < MEET_CAP; a++) {
        for (let b = a + 1; b < subs.length && allMeetings.length < MEET_CAP; b++) {
          const ea = bySub.get(subs[a]);
          allMeetings.push({
            a: subs[a], b: subs[b],
            ts: ea.ts, tower,
            lat: ea.lat, lon: ea.lon,
          });
        }
      }
    }

    self.postMessage({ type: 'progress', pct: 95 });

    // ── serialise Maps to plain objects for postMessage ───────────────────────
    const pairCountsObj = {};
    pairCounts.forEach((v, k) => { pairCountsObj[k] = v; });

    const subDaysObj = {};
    subDays.forEach((dm, sub) => {
      subDaysObj[sub] = {};
      dm.forEach((n, d) => { subDaysObj[sub][d] = n; });
    });

    const svcCountsObj = {};
    svcCounts.forEach((v, k) => { svcCountsObj[k] = v; });

    self.postMessage({
      type: 'done',
      result: { pairCounts: pairCountsObj, subDays: subDaysObj, svcCounts: svcCountsObj, allMeetings },
    });

  } catch (err) {
    self.postMessage({ type: 'error', message: String(err) });
  }
};

function _empty() {
  return { pairCounts: {}, subDays: {}, svcCounts: {}, allMeetings: [] };
}
