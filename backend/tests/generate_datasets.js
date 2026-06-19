// Validation Dataset Generator
// Generates 5 CDR+IPDR datasets for testing AI findings, meeting detection,
// identity resolution, and false-positive rates.
// Usage: node generate_datasets.js

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'testdata');
fs.mkdirSync(OUT, { recursive: true });

// ── Helpers ──
function pad(n) { return String(n).padStart(2, '0') }
function dt(d, h, m) {
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(h)}:${pad(m)}:00`;
}
function dateRange(start, days) {
  const d = new Date(start);
  const dates = [];
  for (let i = 0; i < days; i++) {
    dates.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}
function rng(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min }
function pick(arr) { return arr[rng(0, arr.length - 1)] }

const TOWERS = [
  { id: 'TWR001', lat: 28.669671, lng: 77.019004, city: 'New Delhi', state: 'Delhi' },
  { id: 'TWR002', lat: 28.369512, lng: 76.915884, city: 'Gurugram', state: 'Haryana' },
  { id: 'TWR003', lat: 28.535517, lng: 77.391029, city: 'Noida', state: 'UP' },
  { id: 'TWR004', lat: 28.612345, lng: 77.229876, city: 'New Delhi', state: 'Delhi' },
  { id: 'TWR005', lat: 12.971599, lng: 77.594566, city: 'Bangalore', state: 'Karnataka' },
  { id: 'TWR006', lat: 19.076090, lng: 72.877426, city: 'Mumbai', state: 'Maharashtra' },
  { id: 'TWR007', lat: 13.082680, lng: 80.270718, city: 'Chennai', state: 'Tamil Nadu' },
  { id: 'TWR008', lat: 17.385044, lng: 78.486671, city: 'Hyderabad', state: 'Telangana' },
  { id: 'TWR009', lat: 22.572645, lng: 88.363892, city: 'Kolkata', state: 'WB' },
  { id: 'TWR010', lat: 23.022505, lng: 72.571362, city: 'Ahmedabad', state: 'Gujarat' },
];

// ── Scenario 1: Normal User ──
function genNormalUser() {
  const imei = '351234567890001', imsi = '404010123456789', msisdn = '9000000001';
  const days = dateRange('2026-06-01', 7);
  const cdr = [], ipdr = [];
  const contacts = ['9000000101', '9000000102', '9000000103', '9000000104', '9000000105'];
  const homeTow = 'TWR001', workTow = 'TWR002';

  days.forEach((d, di) => {
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;

    // Morning commute (8-9am)
    if (!isWeekend) {
      const h = 8, m = rng(15, 45);
      cdr.push({ ts: dt(d, h, m), dir: 'MO', cnt: pick(contacts), dur: rng(30, 300), tow: homeTow });
      cdr.push({ ts: dt(d, h, m + 2), dir: 'MO', cnt: pick(contacts), dur: rng(60, 180), tow: workTow });
    }

    // Daytime activity (9am-5pm)
    for (let i = 0; i < rng(2, 5); i++) {
      const h = rng(10, 17), m = rng(0, 59);
      cdr.push({ ts: dt(d, h, m), dir: pick(['MO', 'MT', 'ROAMING']), cnt: pick(contacts), dur: rng(30, 600), tow: isWeekend ? homeTow : pick([homeTow, workTow]) });
      ipdr.push({ ts: dt(d, h, m), svc: pick(['WhatsApp', 'Facebook', 'YouTube']), dur: rng(60, 900), tow: isWeekend ? homeTow : pick([homeTow, workTow]) });
    }

    // Evening (6-10pm)
    for (let i = 0; i < rng(1, 3); i++) {
      const h = rng(18, 22), m = rng(0, 59);
      cdr.push({ ts: dt(d, h, m), dir: pick(['MO', 'MT']), cnt: pick(contacts), dur: rng(60, 900), tow: homeTow });
      ipdr.push({ ts: dt(d, h, m), svc: pick(['WhatsApp', 'Instagram', 'YouTube']), dur: rng(120, 1800), tow: homeTow });
    }
  });

  return { cdr, ipdr, towers: TOWERS, meta: { scenario: 'normal_user', subjects: [msisdn], desc: 'Regular person with normal communication patterns' } };
}

// ── Scenario 2: Family Group ──
function genFamilyGroup() {
  const family = [
    { imei: '351234567890101', imsi: '404010123456101', msisdn: '9000000101', name: 'father' },
    { imei: '351234567890102', imsi: '404010123456102', msisdn: '9000000102', name: 'mother' },
    { imei: '351234567890103', imsi: '404010123456103', msisdn: '9000000103', name: 'child1' },
    { imei: '351234567890104', imsi: '404010123456104', msisdn: '9000000104', name: 'child2' },
  ];
  const days = dateRange('2026-06-01', 14);
  const homeTow = 'TWR003';
  const external = ['9000000999', '9000000888'];
  const cdr = [], ipdr = [];

  days.forEach((d) => {
    const h = d.getDay() === 0 || d.getDay() === 6 ? 'weekend' : 'weekday';

    // Family calls each other multiple times a day
    for (let i = 0; i < rng(3, 6); i++) {
      const [a, b] = [pick(family), pick(family)].sort(() => Math.random() - 0.5);
      if (a.msisdn === b.msisdn) return;
      cdr.push({ ts: dt(d, rng(8, 22), rng(0, 59)), dir: 'MO', cnt: b.msisdn, dur: rng(30, 1200), tow: homeTow, sub: a.msisdn, imei: a.imei, imsi: a.imsi });
    }

    // Each family member talks to external contacts too
    family.forEach(m => {
      cdr.push({ ts: dt(d, rng(9, 21), rng(0, 59)), dir: pick(['MO', 'MT']), cnt: pick(external), dur: rng(60, 600), tow: homeTow, sub: m.msisdn, imei: m.imei, imsi: m.imsi });
    });

    // IPDR sessions
    family.forEach(m => {
      const svcs = m.name === 'child1' || m.name === 'child2' ? ['WhatsApp', 'Instagram', 'YouTube', 'Snapchat'] : ['WhatsApp', 'Facebook', 'YouTube'];
      ipdr.push({ ts: dt(d, rng(7, 23), rng(0, 59)), svc: pick(svcs), dur: rng(120, 3600), tow: homeTow, sub: m.msisdn, imei: m.imei, imsi: m.imsi });
    });
  });

  return { cdr, ipdr, towers: TOWERS, meta: { scenario: 'family_group', subjects: family.map(f => f.msisdn), desc: '4 family members sharing home tower, frequent intra-family calls' } };
}

// ── Scenario 3: Business User ──
function genBusinessUser() {
  const imei = '351234567890201', imsi = '404010123456201', msisdn = '9000000201';
  const days = dateRange('2026-06-01', 10);
  const cdr = [], ipdr = [];
  const contacts = Array.from({ length: 30 }, (_, i) => `90000${String(200 + i).padStart(5, '0')}`);
  const towers = ['TWR001', 'TWR002', 'TWR003', 'TWR004', 'TWR008'];

  days.forEach((d, di) => {
    if (d.getDay() === 0 || d.getDay() === 6) return; // weekends off

    // Many short calls to different numbers (business calls)
    for (let i = 0; i < rng(8, 20); i++) {
      const h = rng(9, 20), m = rng(0, 59);
      cdr.push({ ts: dt(d, h, m), dir: pick(['MO', 'MT']), cnt: pick(contacts), dur: rng(30, 600), tow: pick(towers) });
    }

    // Business travel - tower changes during day
    for (let i = 0; i < rng(2, 5); i++) {
      const h = rng(10, 18), m = rng(0, 59);
      ipdr.push({ ts: dt(d, h, m), svc: pick(['WhatsApp', 'Email', 'LinkedIn', 'Gmail']), dur: rng(120, 1800), tow: pick(towers) });
    }
  });

  return { cdr, ipdr, towers: TOWERS, meta: { scenario: 'business_user', subjects: [msisdn], desc: 'Sales professional, many contacts, travels across towers, regular hours' } };
}

// ── Scenario 4: Call Center ──
function genCallCenter() {
  const imei = '351234567890301', imsi = '404010123456301', msisdn = '9000000301';
  const days = dateRange('2026-06-01', 10);
  const cdr = [], ipdr = [];
  const contacts = Array.from({ length: 80 }, (_, i) => `90000${String(300 + i).padStart(5, '0')}`);
  const tow = 'TWR005'; // Same tower always (call center location)

  days.forEach((d) => {
    if (d.getDay() === 0 || d.getDay() === 6) return; // weekends off

    // 30-50 outbound calls per day, all same tower, 10am-7pm
    const numCalls = rng(30, 50);
    for (let i = 0; i < numCalls; i++) {
      const h = rng(10, 18), m = rng(0, 59);
      cdr.push({ ts: dt(d, h, m), dir: 'MO', cnt: pick(contacts), dur: rng(120, 600), tow });
    }

    // Occasional WhatsApp/web use during breaks
    ipdr.push({ ts: dt(d, rng(13, 14), rng(0, 59)), svc: 'WhatsApp', dur: rng(300, 900), tow });
  });

  return { cdr, ipdr, towers: TOWERS, meta: { scenario: 'call_center', subjects: [msisdn], desc: 'Call center agent: high call volume, single tower, repetitive schedule' } };
}

// ── Scenario 5: Criminal Network ──
function genCriminalNetwork() {
  const network = [
    { imei: '351234567890401', imsi: '404010123456401', msisdn: '9000000401', name: 'kingpin' },
    { imei: '351234567890402', imsi: '404010123456402', msisdn: '9000000402', name: 'lieutenant' },
    { imei: '351234567890403', imsi: '404010123456403', msisdn: '9000000403', name: 'runner1' },
    { imei: '351234567890404', imsi: '404010123456404', msisdn: '9000000404', name: 'runner2' },
    { imei: '351234567890405', imsi: '404010123456405', msisdn: '9000000405', name: 'lookout' },
  ];
  const days = dateRange('2026-06-01', 14);
  const cdr = [], ipdr = [];
  const towers = ['TWR006', 'TWR007', 'TWR008', 'TWR009', 'TWR010'];
  const meetTowers = ['TWR006', 'TWR009']; // two towers they meet at

  // SIM swap config: kingpin and runner1 swap SIMs mid-period
  const swapDay = 7;

  days.forEach((d, di) => {
    const isNight = d.getDay() === 0 || d.getDay() === 6 || di % 2 === 0;

    // Night meetings: multiple subjects at same tower within short window
    if (isNight) {
      const meetTow = pick(meetTowers);
      const meetHour = rng(23, 23); // 11pm
      const meetMin = rng(0, 30);

      // 2-4 subjects at the same tower within 15 minutes
      const attendees = pick([network.slice(0, 3), network.slice(1, 4), [network[0], network[2], network[4]]]);
      attendees.forEach((m, idx) => {
        const subA = pick(attendees.filter(x => x.msisdn !== m.msisdn));
        if (subA) {
          cdr.push({ ts: dt(d, meetHour, meetMin + idx * 3), dir: 'MO', cnt: subA.msisdn, dur: rng(10, 120), tow: meetTow, sub: m.msisdn, imei: m.imei, imsi: m.imsi });
        }
      });
    }

    // Encrypted service usage (Telegram, WhatsApp, Signal) at night
    network.forEach(m => {
      if (isNight) {
        for (let i = 0; i < rng(1, 4); i++) {
          ipdr.push({ ts: dt(d, rng(22, 23), rng(0, 59)), svc: pick(['Telegram', 'WhatsApp', 'Signal']), dur: rng(180, 3600), tow: pick(towers), sub: m.msisdn, imei: m.imei, imsi: m.imsi });
        }
      }
      // Daytime activity (sparse, less suspicious apps)
      if (!isNight) {
        ipdr.push({ ts: dt(d, rng(14, 17), rng(0, 59)), svc: 'YouTube', dur: rng(300, 1200), tow: pick(towers), sub: m.msisdn, imei: m.imei, imsi: m.imsi });
      }
    });

    // SIM swap for kingpin on swapDay
    if (di === swapDay) {
      const kp = network[0];
      kp.imsi = '404010123456999'; // swapped
    }
    // SIM swap for runner1 on swapDay+2
    if (di === swapDay + 2) {
      const r1 = network[2];
      r1.imsi = '404010123456888'; // swapped
    }

    // Device change for lieutenant on swapDay+1
    if (di === swapDay + 1) {
      const lt = network[1];
      lt.imei = '351234567890999'; // new device
    }
  });

  return { cdr, ipdr, towers: TOWERS, meta: { scenario: 'criminal_network', subjects: network.map(m => m.msisdn), desc: '5-person criminal network: night meetings, SIM swaps, device changes, encrypted comms' } };
}

// ── Scenario 5b: Criminal Network with Noise Contacts ──
// Same criminal activity but interleaved with normal family/business/social contacts.
// Makes it harder for AI to isolate the criminal signal.
function genCriminalNetworkNoise() {
  const network = [
    { imei: '351234567890501', imsi: '404010123456501', msisdn: '9010000501', name: 'kingpin' },
    { imei: '351234567890502', imsi: '404010123456502', msisdn: '9010000502', name: 'lieutenant' },
    { imei: '351234567890503', imsi: '404010123456503', msisdn: '9010000503', name: 'runner1' },
    { imei: '351234567890504', imsi: '404010123456504', msisdn: '9010000504', name: 'runner2' },
    { imei: '351234567890505', imsi: '404010123456505', msisdn: '9010000505', name: 'lookout' },
  ];
  const days = dateRange('2026-06-01', 14);
  const cdr = [], ipdr = [];
  const towers = ['TWR006', 'TWR007', 'TWR008', 'TWR009', 'TWR010'];
  const meetTowers = ['TWR006', 'TWR009'];

  // SIM swap config
  const swapDay = 7;

  // Per-subject normal contacts (different to avoid cross-contamination with criminal pairs)
  const familyPools = {
    '9010000501': ['9020000101', '9020000102', '9020000103'],
    '9010000502': ['9020000201', '9020000202', '9020000203', '9020000204'],
    '9010000503': ['9020000301', '9020000302'],
    '9010000504': ['9020000401', '9020000402', '9020000403'],
    '9010000505': ['9020000501', '9020000502', '9020000503', '9020000504', '9020000505'],
  };
  const businessPools = Array.from({ length: 60 }, (_, i) => `90300${String(i).padStart(4, '0')}`);
  const socialPools = Array.from({ length: 30 }, (_, i) => `90400${String(i).padStart(4, '0')}`);

  days.forEach((d, di) => {
    const isNight = d.getDay() === 0 || d.getDay() === 6 || di % 2 === 0;
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;

    network.forEach((m, mi) => {
      const homeTow = 'TWR010';
      const familyContacts = familyPools[m.msisdn];

      // ── Normal Family Activity (evenings, home tower) ──
      if (!isWeekend) {
        for (let i = 0; i < rng(1, 3); i++) {
          cdr.push({ ts: dt(d, rng(19, 21), rng(0, 59)), dir: pick(['MO', 'MT']), cnt: pick(familyContacts), dur: rng(60, 900), tow: homeTow, sub: m.msisdn, imei: m.imei, imsi: m.imsi });
        }
      }

      // ── Normal Business Activity (weekdays, various towers) ──
      if (!isWeekend) {
        const numBiz = rng(5, 12);
        for (let i = 0; i < numBiz; i++) {
          cdr.push({ ts: dt(d, rng(9, 17), rng(0, 59)), dir: pick(['MO', 'MT']), cnt: pick(businessPools), dur: rng(30, 600), tow: pick(towers), sub: m.msisdn, imei: m.imei, imsi: m.imsi });
        }
        // Business IP data (normal apps)
        ipdr.push({ ts: dt(d, rng(10, 12), rng(0, 59)), svc: pick(['Gmail', 'YouTube', 'LinkedIn']), dur: rng(120, 600), tow: pick(towers), sub: m.msisdn, imei: m.imei, imsi: m.imsi });
      }

      // ── Social Contacts (weekend afternoons) ──
      if (isWeekend) {
        for (let i = 0; i < rng(2, 5); i++) {
          cdr.push({ ts: dt(d, rng(14, 19), rng(0, 59)), dir: pick(['MO', 'MT']), cnt: pick(socialPools), dur: rng(120, 1800), tow: pick(towers), sub: m.msisdn, imei: m.imei, imsi: m.imsi });
        }
      }
    });

    // ── Criminal Activity (same as original) ──
    if (isNight) {
      const meetTow = pick(meetTowers);
      const meetHour = 23;
      const meetMin = rng(0, 30);
      const attendees = pick([network.slice(0, 3), network.slice(1, 4), [network[0], network[2], network[4]]]);
      attendees.forEach((m, idx) => {
        const subA = pick(attendees.filter(x => x.msisdn !== m.msisdn));
        if (subA) {
          cdr.push({ ts: dt(d, meetHour, meetMin + idx * 3), dir: 'MO', cnt: subA.msisdn, dur: rng(10, 120), tow: meetTow, sub: m.msisdn, imei: m.imei, imsi: m.imsi });
        }
      });

      // Encrypted app usage at night
      network.forEach(m => {
        for (let i = 0; i < rng(1, 4); i++) {
          ipdr.push({ ts: dt(d, rng(22, 23), rng(0, 59)), svc: pick(['Telegram', 'WhatsApp', 'Signal']), dur: rng(180, 3600), tow: meetTow, sub: m.msisdn, imei: m.imei, imsi: m.imsi });
        }
      });
    } else {
      // Daytime criminal comms (sparse, WhatsApp)
      network.forEach(m => {
        ipdr.push({ ts: dt(d, rng(14, 17), rng(0, 59)), svc: 'WhatsApp', dur: rng(300, 1200), tow: pick(towers), sub: m.msisdn, imei: m.imei, imsi: m.imsi });
      });
    }

    // SIM swaps
    if (di === swapDay) { network[0].imsi = '404010123456999' }
    if (di === swapDay + 2) { network[2].imsi = '404010123456888' }
    if (di === swapDay + 1) { network[1].imei = '351234567890999' }
  });

  return { cdr, ipdr, towers: TOWERS, meta: { scenario: 'criminal_network_noise', subjects: network.map(m => m.msisdn), desc: '5-person criminal network interleaved with normal family/business/social contacts per subject. Tests ability to extract signal from noise.' } };
}

// ── CSV Writers ──
function esc(s) { return `"${String(s).replace(/"/g, '""')}"` }

function writeCdr(path, rows) {
  const header = 'case_id,msisdn,imsi,imei,a_party_number,b_party_number,call_type,direction,start_time,end_time,duration_seconds,tower_id,cell_id,lac,latitude,longitude,technology';
  const lines = rows.map(r => {
    const end = new Date(new Date(r.ts).getTime() + r.dur * 1000).toISOString().replace('Z', '');
    return [
      `VALIDATION-${esc(r.sub || r.cnt || 'unknown')}`, esc(r.sub || r.cnt || ''), esc(r.imsi || ''), esc(r.imei || ''),
      esc(r.sub || ''), esc(r.cnt || ''), 'VOICE', esc(r.dir || 'MO'),
      r.ts.replace('T', 'T') + 'Z', end, r.dur, esc(r.tow || ''),
      rng(1000, 9999), rng(100, 999), '', '', '4G'
    ].join(',');
  });
  fs.writeFileSync(path, header + '\n' + lines.join('\n'));
}

function writeIpdr(path, rows) {
  const header = 'case_id,msisdn,imsi,imei,start_time,end_time,duration_seconds,source_ip,destination_ip,source_port,destination_port,protocol,bytes_uploaded,bytes_downloaded,tower_id,cell_id,lac,latitude,longitude,apn,rat';
  const lines = rows.map(r => {
    const end = new Date(new Date(r.ts).getTime() + r.dur * 1000).toISOString().replace('Z', '');
    return [
      `VALIDATION-${esc(r.sub || 'unknown')}`, esc(r.sub || ''), esc(r.imsi || ''), esc(r.imei || ''),
      r.ts.replace('T', 'T') + 'Z', end, r.dur,
      `10.1.${rng(1, 10)}.${rng(1, 255)}`, `198.41.${rng(0, 255)}.${rng(1, 255)}`,
      rng(10000, 65000), rng(80, 443), pick(['TCP', 'UDP']),
      rng(1000, 500000), rng(1000, 500000),
      esc(r.tow || ''), rng(1000, 9999), rng(100, 999), '', '', 'LTE'
    ].join(',');
  });
  fs.writeFileSync(path, header + '\n' + lines.join('\n'));
}

function writeTowers(path, towers) {
  const header = 'tower_id,latitude,longitude,city,state';
  const lines = towers.map(t => [esc(t.id), t.lat, t.lng, esc(t.city), esc(t.state)].join(','));
  fs.writeFileSync(path, header + '\n' + lines.join('\n'));
}

// ── Scenario 6: Shared Transport (Commuter Challenge) ──
// 10 commuters on the same train every weekday.
// Same towers at same times = maximum false-positive risk for meeting detection.
function genSharedTransport() {
  const days = dateRange('2026-06-01', 20);
  const cdr = [], ipdr = [];
  const trainTowers = ['TWR001', 'TWR002', 'TWR003', 'TWR004', 'TWR008'];
  const routeTimes = [8, 9, 10, 11, 12]; // 5 stops during commute
  const externalContacts = Array.from({ length: 20 }, (_, i) => `90600${String(i).padStart(5, '0')}`);

  // 10 commuters
  for (let ci = 0; ci < 10; ci++) {
    const imei = `352${String(ci).padStart(13, '0')}`;
    const imsi = `40402${String(ci).padStart(10, '0')}`;
    const msisdn = `9070000${String(ci).padStart(3, '0')}`;

    days.forEach(d => {
      if (d.getDay() === 0 || d.getDay() === 6) return; // weekdays only

      // Morning commute: all 10 at the same towers at the same times
      routeTimes.forEach((h, ti) => {
        const tow = trainTowers[ti % trainTowers.length];
        cdr.push({ ts: dt(d, h, rng(0, 5)), dir: 'MO', cnt: pick(externalContacts), dur: rng(20, 120), tow, sub: msisdn, imei, imsi });
        ipdr.push({ ts: dt(d, h, rng(1, 6)), svc: 'WhatsApp', dur: rng(60, 300), tow, sub: msisdn, imei, imsi });
      });

      // Evening commute: reverse order
      routeTimes.reverse().forEach((h, ti) => {
        const tow = trainTowers[(trainTowers.length - 1 - ti) % trainTowers.length];
        cdr.push({ ts: dt(d, 17 + ti, rng(0, 5)), dir: 'MT', cnt: pick(externalContacts), dur: rng(20, 120), tow, sub: msisdn, imei, imsi });
      });

      // Evening at home: normal calls
      cdr.push({ ts: dt(d, 20, rng(0, 59)), dir: 'MO', cnt: pick(externalContacts), dur: rng(60, 600), tow: 'TWR001', sub: msisdn, imei, imsi });
    });
  }

  return { cdr, ipdr, towers: TOWERS, meta: { scenario: 'shared_transport', subjects: Array.from({ length: 10 }, (_, i) => `9070000${String(i).padStart(3, '0')}`), desc: '10 commuters on same train: identical towers/times = false meeting detection risk' } };
}

// ── Scenario 7: Large Dataset (Stress Test) ──
// 50 subjects, 100k records for performance validation.
function genLargeDataset() {
  const days = dateRange('2026-06-01', 30);
  const towers = TOWERS.slice(0, 10);
  const subjects = Array.from({ length: 50 }, (_, i) => ({
    imei: `353${String(i).padStart(13, '0')}`,
    imsi: `40403${String(i).padStart(10, '0')}`,
    msisdn: `9080000${String(i).padStart(3, '0')}`,
  }));
  const cdr = [], ipdr = [];

  subjects.forEach((sub, si) => {
    const numCalls = rng(800, 2500);
    const contacts = Array.from({ length: rng(10, 40) }, (_, i) => `90900${String(si * 100 + i).padStart(5, '0')}`);

    // Generate records across the 30-day period
    for (let i = 0; i < numCalls; i++) {
      const d = pick(days);
      const h = rng(6, 23);
      cdr.push({ ts: dt(d, h, rng(0, 59)), dir: pick(['MO', 'MT', 'ROAMING']), cnt: pick(contacts), dur: rng(10, 1800), tow: pick(towers), sub: sub.msisdn, imei: sub.imei, imsi: sub.imsi });
    }

    const numSessions = rng(400, 1200);
    for (let i = 0; i < numSessions; i++) {
      const d = pick(days);
      const h = rng(6, 23);
      ipdr.push({ ts: dt(d, h, rng(0, 59)), svc: pick(['WhatsApp', 'Facebook', 'YouTube', 'Instagram', 'Gmail', 'Telegram']), dur: rng(60, 3600), tow: pick(towers), sub: sub.msisdn, imei: sub.imei, imsi: sub.imsi });
    }
  });

  return { cdr, ipdr, towers, meta: { scenario: 'large_dataset', subjects: subjects.map(s => s.msisdn), desc: '50 subjects, ~100k total records. Performance stress test.' } };
}

// ── Register & Generate ──
const scenarios = [
  { name: 'normal_user', gen: genNormalUser },
  { name: 'family_group', gen: genFamilyGroup },
  { name: 'business_user', gen: genBusinessUser },
  { name: 'call_center', gen: genCallCenter },
  { name: 'criminal_network', gen: genCriminalNetwork },
  { name: 'criminal_network_noise', gen: genCriminalNetworkNoise },
  { name: 'shared_transport', gen: genSharedTransport },
  { name: 'large_dataset', gen: genLargeDataset },
];

scenarios.forEach(s => {
  const data = s.gen();
  const dir = path.join(OUT, s.name);
  fs.mkdirSync(dir, { recursive: true });
  writeCdr(path.join(dir, 'cdr.csv'), data.cdr);
  writeIpdr(path.join(dir, 'ipdr.csv'), data.ipdr);
  writeTowers(path.join(dir, 'towers.csv'), data.towers);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(data.meta, null, 2));
  console.log(`  ${s.name}: ${data.cdr.length} CDR + ${data.ipdr.length} IPDR records (${data.meta.subjects.length} subjects)`);
});

console.log('\nDataset pack generated in testdata/');
