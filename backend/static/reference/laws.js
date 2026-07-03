// reference/laws.js — the Laws / legal-reference tab (India CDR/IPDR): a static legal-reference
// dataset (LAW_CATS + LAW_REFERENCE) plus a search/filter renderer. Self-contained — depends only on
// esc + the DOM. Extracted verbatim from app.js (feature layer). No behavior change.

import { esc } from '../core/utils.js';
import { registerTab } from '../core/router.js';

// ====== LAWS / LEGAL REFERENCE (India — CDR/IPDR) ======
const LAW_CATS={
  'Production':'#2c6f79',
  'Interception':'#b07d2b',
  'Evidence & Admissibility':'#3a7d5a',
  'Offences':'#c0392b',
  'Retention':'#7b4f9c',
  'Privacy & Misuse':'#b94a48',
  'Case Law':'#6d4c41',
  'Cross-Border':'#00695c',
  'Procedure & Templates':'#455a64',
};
const LAW_REFERENCE=[
  {cat:'Production',title:'Production of records & devices (the workhorse for stored CDR/IPDR)',statute:'BNSS, 2023 — Section 94',
   tagline:'Successor to Sections 91–92 CrPC; unlike the CrPC it expressly covers electronic records.',
   covers:'Empowers a court — or, during investigation, the officer in charge of a police station — to issue a summons or written order requiring the production of any document or "other thing", expressly including electronic communications and devices containing digital evidence, needed for an investigation, inquiry or trial.',
   use:'This is the everyday, lawful route to obtain STORED records: CDR, tower-dump / cell-ID data, subscriber (CAF) details, and IPDR from a telecom operator or ISP. Draft a written requisition / production order naming the exact identifier (MSISDN, IMEI, IMSI, IP) and a bounded date-time range, and the specific records sought. Prefer this over interception whenever the data already exists in storage. Always pair the records received with a Section 63 BSA certificate so they are admissible.',
   authority:'A Magistrate court, or during investigation the SHO / IO. Note the separate 2013 executive guideline that restricts which police officer may actually requisition CDR from operators (SP rank and above).',
   caselaw:'High Courts (e.g. Rajasthan HC, 2025) have held that an accused may also invoke Section 94 to seek preservation/production of CDR and tower-location data crucial to the defence, even against a marginal privacy intrusion.',
   pitfall:'Over-broad requests ("every number on a tower for a month" with no nexus) invite challenge and may be quashed. Keep the identifier and the time-window tight and tied to the offence.'},

  {cat:'Production',title:'Investigation, forensic-collection & attendance powers',statute:'BNSS, 2023 — Sections 175, 176, 179, 185',
   covers:'Section 175 — power of police to investigate a cognizable offence. Section 176 — procedure for investigation; for offences punishable with 7 years or more it mandates forensic-expert collection of evidence at the scene (with videography). Section 179 — power to require the attendance of witnesses. Section 185 — search by an officer with reasons recorded.',
   use:'These frame the investigation within which you issue Section 94 production orders and analyse CDR/IPDR. Section 176\'s forensic mandate for serious offences supports a documented, defensible digital-evidence chain from seizure onward.',
   authority:'Investigating officer / SHO, observing the rank and reason-recording requirements each section specifies.'},

  {cat:'Interception',title:'Lawful interception of telecom messages (real-time)',statute:'Telecommunications Act, 2023 — Section 20(2); Lawful Interception Rules, 2024',
   tagline:'Replaces Section 5(2) of the Indian Telegraph Act, 1885 and Rule 419A of the Telegraph Rules.',
   covers:'Permits an authorised agency to intercept, detain or disclose telecommunication messages on the occurrence of a public emergency or in the interest of public safety, where necessary in the interest of the sovereignty and integrity of India, defence, security of the State, friendly relations with foreign States, public order, or preventing incitement to an offence. This is for live / ongoing communication — not historical stored records.',
   authority:'Order by the Union Home Secretary (Centre) or State Home Secretary (States). In unavoidable circumstances an officer not below the rank of Joint Secretary to the Government of India, duly authorised, may issue it.',
   timeline:'An interception order stays in force up to 60 days, is renewable, but never beyond a total of 180 days. A copy must reach the Review Committee within 7 working days, and records are destroyed when no longer required.',
   pitfall:'Do not use interception to obtain something Section 94 can lawfully produce from storage. Skipping the Review-Committee / renewal safeguards taints the evidence and the order.'},

  {cat:'Interception',title:'Interception, monitoring & decryption of digital information (IPDR basis)',statute:'IT Act, 2000 — Sections 69 & 69B; IT (Interception, Monitoring & Decryption) Rules, 2009',
   covers:'Section 69 lets an authorised agency direct interception, monitoring or decryption of any information generated, transmitted, received or stored in any computer resource, on the broad State-interest grounds plus investigation of an offence. Sections 69(3)–(4) compel intermediaries/ISPs to extend technical assistance — non-compliance is punishable with imprisonment up to 7 years and fine. Section 69B allows monitoring and collection of traffic data for cyber-security.',
   use:'This is the principal basis for obtaining and monitoring IPDR and internet activity. Use it (with Section 94 production for stored logs) to get source/destination IP and port, timestamps, data volume, and the NAT/CGNAT mapping needed to resolve a public IP + port + time back to a subscriber.',
   authority:'Competent authority under the 2009 Rules = Secretary, Ministry of Home Affairs (Centre) / Secretary in charge of the Home Department (State), with Review Committee oversight.',
   pitfall:'IPDR is only meaningful with the EXACT timestamp and source port. A public IP alone (behind CGNAT) does not identify a subscriber — always capture IP + port + precise time.'},

  {cat:'Evidence & Admissibility',title:'Admissibility of electronic records — the Section 63 certificate',statute:'Bharatiya Sakshya Adhiniyam, 2023 — Sections 61, 62, 63 (replaces Section 65B, Evidence Act)',
   tagline:'The single most important card: get this wrong and the CDR/IPDR is excluded.',
   covers:'Electronic records (a CDR/IPDR printout, CD/pen-drive, or server extract) are admissible as documents only if accompanied by the Section 63 certificate. The new Schedule requires a DUAL certificate — Part A signed by the person operating / in charge of the device or system that produced the record, and Part B signed by an expert — and the expert must state the hash value of the record and the algorithm used to obtain it.',
   use:'Always obtain the Section 63 certificate from the telecom operator / ISP for the exact records produced, and compute and record a hash (e.g. SHA-256) of every digital exhibit at the moment of seizure. The certificate must accompany the record each time it is submitted.',
   caselaw:'The 65B/63 certificate is mandatory for electronic evidence — Anvar P.V. v. P.K. Basheer (2014) and Arjun Panditrao Khotkar v. Kailash Kushanrao Gorantyal (2020) — now codified with the hash requirement under the BSA.',
   pitfall:'A missing, unsigned or after-the-fact certificate, or a hash mismatch between the seized and produced copy, is the most common way CDR/IPDR evidence is thrown out.'},

  {cat:'Retention',title:'Data-retention obligations (the window in which records still exist)',statute:'Unified / ISP Licence conditions (DoT); CERT-In Directions, 2022',
   covers:'Telecom and internet licensees must retain CDR, EDR and IPDR (and related commercial records) for government scrutiny. The retention period was extended from one year to at least TWO years by the December 2021 licence amendments. CERT-In\'s 2022 directions add log-retention duties (180 days, within India) for service providers.',
   use:'This sets the window in which historical records still exist — file your Section 94 production order before the retention window closes. For older offences, move quickly and ask the operator to PRESERVE the records pending the formal requisition.',
   pitfall:'Delay past the retention window means the records are lawfully destroyed and become unrecoverable.'},

  {cat:'Privacy & Misuse',title:'CDR procurement guidelines (anti-misuse — protects you too)',statute:'DoT / MHA executive instructions, 2013',
   covers:'After CDR-misuse scandals, executive guidelines restricted who may requisition CDR: only an officer of the rank of Superintendent of Police (SP) and above may seek CDR from operators. The officer must maintain a directory of CDRs obtained and report it monthly to the District Magistrate, who forwards a consolidated record to the Chief Secretary.',
   use:'Route every CDR requisition through an SP-rank-or-above authorisation and log it. This protects the investigation and the officer personally.',
   pitfall:'Unauthorised or unlogged CDR procurement is itself actionable — it can collapse the prosecution and expose the officer to departmental and criminal liability.'},

  {cat:'Privacy & Misuse',title:'Right to privacy & the proportionality test',statute:'K.S. Puttaswamy v. Union of India, (2017) 10 SCC 1',
   covers:'Privacy is a fundamental right under Article 21. Any State intrusion — including accessing CDR/IPDR and location data — must satisfy proportionality: a legitimate aim, a rational nexus, necessity (the least-intrusive means), and a fair balance, all resting on a valid law and procedure.',
   use:'Frame every CDR/IPDR/interception request as targeted, time-bound and necessary, with the offence and the nexus recorded on file. That documented reasoning is what makes the intrusion defensible if challenged.'},

  {cat:'Privacy & Misuse',title:'Personal-data-protection context',statute:'Digital Personal Data Protection Act, 2023 — Sections 3, 14, 30, 43(2)',
   covers:'India\'s data-protection regime: §3 defines personal data; §14 requires a lawful basis (mostly consent) or a "reasonable purpose"; §30 limits retention to no longer than necessary; §43(2) exempts State agencies acting for sovereignty, security, or the prevention/investigation/prosecution of offences. The exemption does NOT override the normal judicial process for obtaining evidence.',
   use:'Treat CDR/IPDR and subscriber data as sensitive: access on a need-to-know basis, use only for the case, do not redistribute, and store securely — consistent with the §43(2) exemption you are relying on. Personal data of non-accused parties appearing in CDRs may need redaction.'},

  // ── Offences ──
  {cat:'Offences',title:'Identity theft & cheating by personation',statute:'IT Act, 2000 — Sections 66C & 66D',
   covers:'§66C punishes fraudulent/dishonest use of another person\'s electronic signature, password or any unique identification feature (up to 3 years + fine). §66D punishes cheating by personation using a computer/communication device (up to 3 years + fine).',
   use:'The charging sections for SIM-swap fraud, OTP/credential theft, fake-KYC SIMs and impersonation scams that CDR/IPDR analysis uncovers. Tie the device/number evidence to the personation act.',
   pitfall:'Prove the dishonest/fraudulent intent and the link between the accused and the identifier — possession of a number alone is not the offence.'},

  {cat:'Offences',title:'Cyber terrorism',statute:'IT Act, 2000 — Section 66F',
   covers:'Acts done with intent to threaten the unity, integrity, security or sovereignty of India — including denial of access, unauthorised access to a protected system, or introducing a contaminant — that cause or are likely to cause death/injury or damage critical infrastructure. Punishable up to imprisonment for life.',
   use:'The apex cyber-offence; relevant where telecom/IPDR evidence ties a subject to an attack on critical systems or a terror nexus. Usually investigated by specialised agencies.'},

  {cat:'Offences',title:'Breach of confidentiality & wrongful disclosure of data',statute:'IT Act, 2000 — Sections 72 & 72A',
   covers:'§72 punishes a person who, having secured access to electronic records/information under powers of the Act, discloses it without consent (up to 2 years + fine). §72A punishes disclosure of personal information in breach of a lawful contract (up to 3 years + fine).',
   use:'The flip side of lawful collection: data obtained under interception/production powers must NOT be leaked or used beyond the case. Cite to discipline misuse — and to reassure courts your handling was lawful.',
   pitfall:'Leaking intercepted CDR/personal data, or sharing it outside the investigation, is itself a punishable offence and can collapse the case.'},

  {cat:'Offences',title:'Unauthorised interception / access to telecom (offence)',statute:'Telecommunications Act, 2023 — Section 42',
   covers:'Intercepting, or unlawfully accessing, a telecommunication message or telecom equipment without authorisation is a criminal offence (imprisonment up to 3 years and/or fine). Only interception ordered under the lawful-interception provisions (and the 2024 Rules) is permitted.',
   use:'Reinforces that every tap/intercept must rest on a valid order. Use it against illegal CDR/IMSI-catcher operations; cite it to show your own interception was duly authorised.'},

  // ── Production (telecom-specific furnish order) ──
  {cat:'Production',title:'Government direction to furnish telecom records',statute:'Telecommunications Act, 2023 — Section 44',
   tagline:'The telecom-specific analogue of BNSS §94 — compels operators/ISPs to hand over records.',
   covers:'An officer specially authorised by the Government can direct a telecom entity to furnish any telecommunication record or information for a pending or potential criminal/civil matter — subscriber details, CDRs, tower logs, etc.',
   use:'An additional lawful route (alongside BNSS §94) to obtain stored telecom records directly from an operator. Ensure the requisitioning officer is duly authorised and the request is specific and proportionate.',
   pitfall:'Authorisation and specificity matter: a vague or unauthorised demand can be challenged and the operator may (rightly) refuse.'},

  // ── Retention (CERT-In) ──
  {cat:'Retention',title:'CERT-In logging & incident-reporting directions',statute:'IT Act, 2000 — Section 70B; CERT-In Directions, 28 April 2022',
   covers:'Intermediaries, ISPs, data-centres, cloud and VPN providers must: report specified cyber incidents within 6 hours; retain ICT system logs for 180 days within India; and (for VPN/cloud) keep customer KYC for 5 years. They must appoint a CERT-In point of contact and synchronise clocks to NIC/NPL.',
   use:'These mandates mean logs you need (IPDR-adjacent system logs, VPN/cloud KYC) are preserved for a known window — and that "the evidence was lawfully retained" is easy to establish. CERT-In can itself be asked for incident logs relevant to a case.',
   pitfall:'180 days is short for system logs — move quickly on cyber matters; the in-India storage requirement helps but the clock is unforgiving.'},

  // ── Case Law ──
  {cat:'Case Law',title:'Electronic-evidence certificate is mandatory',statute:'Anvar P.V. v. P.K. Basheer, (2014) 10 SCC 473 (Supreme Court)',
   covers:'Held that a §65B certificate (now BSA §63) is MANDATORY for the admissibility of any electronic record led as secondary evidence (CDRs, emails, CD/printouts). Overruled the earlier view that allowed admission without a certificate.',
   use:'The reason you must obtain an operator\'s certificate with every CDR/IPDR extract. Without it the records are inadmissible, however probative.',
   caselaw:'Anvar P.V. v. P.K. Basheer (2014) — the foundational ruling on electronic-evidence certification.'},

  {cat:'Case Law',title:'Certificate reaffirmed; primary-device exception',statute:'Arjun Panditrao Khotkar v. Kailash Kushanrao Gorantyal, (2020) 7 SCC 1 (Supreme Court)',
   covers:'A three-judge bench reaffirmed Anvar: the §65B/63 certificate is required when copies (CDRs on CD, printouts) are tendered. Producing the ORIGINAL device in court can dispense with the certificate (primary evidence). Issued general directions to telecom companies to preserve CDRs as per law.',
   use:'Two practical takeaways: (1) seize the ORIGINAL device when feasible to rely on the primary-evidence route; (2) otherwise always pair copies with the §63 certificate. Operators are on notice to retain call logs.'},

  {cat:'Case Law',title:'"Substantial compliance" no longer good law',statute:'Shafhi Mohammad v. State of H.P., (2018) 2 SCC 801 — OVERRULED',
   covers:'Shafhi had allowed admission of electronic evidence on "substantial compliance" where the party could not produce a certificate. This was OVERRULED by Arjun Khotkar (2020).',
   use:'Do not rely on Shafhi to admit uncertified CDRs — it is no longer good law. Obtain the §63 certificate.',
   pitfall:'Citing Shafhi for a certificate-free shortcut will fail; the certificate (or the original device) is required.'},

  {cat:'Case Law',title:'Privacy lineage — Article 21',statute:'R. Rajagopal v. State of T.N. (1994); Kharak Singh v. State of U.P. (1962)',
   covers:'Early Supreme Court recognition that privacy is part of the right to life and personal liberty under Article 21 — Kharak Singh (against unlawful police surveillance) and R. Rajagopal (informational privacy). The lineage culminates in Puttaswamy (2017).',
   use:'Supports narrowly-tailored production orders: CDR/location data implicate privacy, so requests should be specific, time-bound and necessary.'},

  // ── Cross-Border ──
  {cat:'Cross-Border',title:'Mutual Legal Assistance Treaty (MLAT) route',statute:'MLATs (e.g. India–US 2000); BNSS Chapter on reciprocal arrangements',
   covers:'The formal, normative route to obtain data held abroad (e.g. on Google/Meta/Microsoft servers) is a Letter Rogatory / MLAT request to the foreign government, which provides the lawful basis for cross-border evidence transfer.',
   use:'For content/records hosted overseas, route the request through the MHA/Central Authority via MLAT. Plan ahead — MLAT is slow (months); for volatile data, send a preservation request to the provider first.',
   pitfall:'A direct letter to a foreign company (bypassing MLAT) may violate the foreign law (e.g. US Stored Communications Act) and the data may be inadmissible.'},

  {cat:'Cross-Border',title:'US CLOUD Act',statute:'US Clarifying Lawful Overseas Use of Data Act, 2018',
   covers:'Allows a "qualified" foreign government, IF it has signed an executive agreement with the US, to request data directly from US providers. As of 2026 India has NOT signed such an agreement, so Indian requests generally still go via MLAT.',
   use:'Track whether an India–US CLOUD Act agreement is in force; until then, use MLAT/Letters Rogatory for US-held data. US providers cannot lawfully answer a foreign subpoena without MLAT or a CLOUD Act agreement.'},

  {cat:'Cross-Border',title:'EU/UK data — GDPR Article 48 & Schrems II',statute:'GDPR Art. 48; Schrems II (CJEU, 2020)',
   covers:'EU/UK data-protection law restricts transfers in response to foreign court orders: Art. 48 requires an international agreement (e.g. MLAT) as the basis, and Schrems II requires that transferred data receive protection essentially equivalent to EU law.',
   use:'For data on EU/UK persons or EU-based platforms, use the MLAT / European Investigation Order route and expect data-protection scrutiny. Minimise and encrypt what you request; involve legal counsel early.'},

  // ── Procedure & Templates ──
  {cat:'Procedure & Templates',title:'Production order — checklist & sample (BNSS §94)',statute:'Operational template',
   covers:'A BNSS §94 production order must specify the issuing authority, case/FIR reference, the exact target identifiers, the bounded period, the precise data sought, and sealing/delivery directions — and should require a BSA §63 certificate with the records.',
   use:'Use this checklist and outline when drafting a CDR/IPDR/tower-dump requisition. Keep it specific and proportionate so it survives challenge.',
   pitfall:'Vague scope ("all records") or a missing certificate request are the two most common defects.',
   sample:`PRODUCTION ORDER CHECKLIST
  [ ] Issuing authority — name, rank, jurisdiction
  [ ] Case / FIR number and purpose (investigation/trial)
  [ ] Target identifiers — MSISDN / IMSI / IMEI / IP
  [ ] Period sought — from date-time to date-time
  [ ] Data sought — CDR / SMS logs / tower-dump / IPDR / subscriber (CAF)
  [ ] Format — searchable digital media (CSV on sealed CD/DVD)
  [ ] Require a BSA Section 63 certificate of authenticity
  [ ] Sealing & delivery instructions; signature + seal + date

SAMPLE OUTLINE
  In the Court of [Magistrate], [City]      Case No.: [__]/20__
  To: [Telecom Operator], [Address]
  Under Section 94 of the BNSS, 2023, you are directed to produce the
  Call Detail Records (call & SMS logs, internet-usage/IPDR logs and
  related subscriber information) for:
    Subscriber: [name];  Mobile: [number]  (IMSI: [__]; IMEI: [__])
  for the period [Date1] to [Date2], in certified digital format on
  sealed media, accompanied by a certificate under Section 63 of the
  BSA, 2023.
  By order of the Court / Officer — Name, Signature & Seal — Date.`},

  {cat:'Procedure & Templates',title:'Chain of custody — checklist & form',statute:'Operational template',
   covers:'Every physical/digital exhibit must be sealed, labelled and logged at seizure, with each transfer recorded and a hash (MD5/SHA-256) taken of digital files before and after copying to prove integrity.',
   use:'Follow this on every seizure (SIM, handset, CDR media) so the evidence withstands a §63 / integrity challenge. Note IMEI/serial before extraction; limit the number of handlers.',
   pitfall:'A broken or undocumented custody chain, or a hash mismatch, lets the defence attack integrity even if the data is genuine.',
   sample:`CHAIN-OF-CUSTODY FORM (fields)
  Item No. | Description (device / printout / CDR file)
  Collected from (person / location)
  Date & time of collection
  Collected by (name + badge)   |   Sealed by   |   Seal / label ID
  Witness(es)
  Hash (SHA-256) at seizure ............................
  Hash (SHA-256) after copy ............................   [must match]
  Transfers: from → to, date/time, signature (one row each)
  Storage location / conditions (e.g. police safe)
  Remarks (e.g. device powered off; SIM extracted)`},

  {cat:'Procedure & Templates',title:'BSA §63 evidence certificate — sample wording',statute:'Operational template (Bharatiya Sakshya Adhiniyam §63)',
   covers:'The operator\'s certificate that accompanies produced records. It identifies the subscriber/records, the period and the device/system, and attests the records are true copies kept in the ordinary course of business with no alteration. Under the BSA Schedule it is signed in two parts (operator + expert), with the expert stating the hash and algorithm.',
   use:'Request this wording (on letterhead / digitally signed by a senior officer of the operator) with every CDR/IPDR extract.',
   pitfall:'An unsigned, undated, or post-hoc certificate — or one missing the hash/algorithm — is the classic ground for exclusion.',
   sample:`SAMPLE CERTIFICATE (Section 63, BSA 2023)
  "This is to certify that the attached sealed media contains the Call
  Detail Records / IP Detail Records of subscriber [Name / Number] for
  the period [Date1]–[Date2], as maintained by [Operator] in the
  ordinary course of business, produced from [device/system], and that
  no alterations have been made. SHA-256 hash of the data: [value],
  computed using [algorithm]. Provided pursuant to Order No. [__] of
  [Court], dated [date]."
  Part A — signed by the person in charge of the system (name, designation)
  Part B — signed by an expert (name, hash value, algorithm)`},

  {cat:'Procedure & Templates',title:'Investigator CDR/IPDR data-handling checklist',statute:'Operational template',
   covers:'A step-by-step list to obtain, verify and preserve telecom records correctly.',
   use:'Run through this when collecting CDR/IPDR from an operator.',
   sample:`CDR / IPDR HANDLING CHECKLIST
  [ ] Verify order validity — signature, jurisdiction, authorised officer (SP+ for CDR)
  [ ] Confirm the subscriber / IMEI matches the target
  [ ] Collect related data — subscriber CAF, tower lat/long, cell-ID mapping
  [ ] Insist on searchable digital format (CSV), not only printed sheets
  [ ] Obtain the BSA §63 certificate of authenticity
  [ ] Note any SIM / network-technology changes affecting the data
  [ ] Hash the data, duplicate it, re-hash (record both on the form)
  [ ] Reconcile timestamps (network time vs server time)
  [ ] Store original media in a secure evidence locker; limit handlers`},
];
let _lawsInit=false;
function renderLaws(){
  const body=document.getElementById('lawsBody');if(!body)return;
  const sb=document.getElementById('lawSearch'),cat=document.getElementById('lawCategory'),ex=document.getElementById('lawExpandBtn');
  if(!_lawsInit){
    _lawsInit=true;
    const cats=[...new Set(LAW_REFERENCE.map(l=>l.cat))];
    if(cat)cat.innerHTML='<option value="">All categories</option>'+cats.map(c=>'<option>'+esc(c)+'</option>').join('');
    sb&&sb.addEventListener('input',renderLaws);
    cat&&cat.addEventListener('change',renderLaws);
    ex&&ex.addEventListener('click',()=>{const anyClosed=body.querySelectorAll('details:not([open])').length>0;body.querySelectorAll('details').forEach(d=>d.open=anyClosed);ex.textContent=anyClosed?'Collapse all':'Expand all';});
  }
  const q=(sb&&sb.value.trim().toLowerCase())||'';
  const fc=(cat&&cat.value)||'';
  const items=LAW_REFERENCE.filter(l=>{
    if(fc&&l.cat!==fc)return false;
    if(!q)return true;
    if(!l._t)l._t=[l.title,l.statute,l.tagline,l.covers,l.use,l.authority,l.timeline,l.caselaw,l.pitfall,l.sample,l.cat].filter(Boolean).join(' ').toLowerCase();
    return l._t.includes(q);
  });
  const field=(label,val)=>val?'<div class="law-field"><h5>'+label+'</h5><p>'+esc(val)+'</p></div>':'';
  const sample=(label,val)=>val?'<div class="law-field"><h5>'+label+'</h5><pre class="law-sample">'+esc(val)+'</pre></div>':'';
  let h='<div class="law-disclaimer"><b>&#9878; Practical guidance for investigators — not legal advice.</b> Statute text and procedures change; verify the current provision and your State&rsquo;s standing orders before relying on this in court.</div>';
  if(!items.length){h+='<div class="story-muted" style="padding:24px;text-align:center">No laws match your search.</div>';}
  else h+=items.map(l=>{const c=LAW_CATS[l.cat]||'#888';
    return '<details class="law-card" style="--lc:'+c+'"><summary><span class="law-badge">'+esc(l.cat)+'</span><span class="law-title">'+esc(l.title)+'</span><span class="law-statute">'+esc(l.statute)+'</span></summary>'
      +'<div class="law-body-in">'
      +(l.tagline?'<p class="law-tagline">'+esc(l.tagline)+'</p>':'')
      +field('What it covers',l.covers)
      +field('How to use it in an investigation',l.use)
      +field('Who can authorise',l.authority)
      +field('Timeline &amp; safeguards',l.timeline)
      +field('Holding / case law',l.caselaw)
      +field('Common pitfall',l.pitfall)
      +sample('Template / checklist',l.sample)
      +'</div></details>';
  }).join('');
  body.innerHTML=h;
}

// This tab owns its rendering; register it with the router (no exports — app.js reaches it only here).
registerTab('laws', renderLaws);
