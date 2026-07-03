// services/attribution.js — the offline service-attribution engine: classify an IPDR record or
// session to provider + service with a confidence tier, using the ATTR_DATA lookup tables. Pure
// logic (no DOM, no state) — depends only on core constants + fmtBytes. Extracted verbatim from
// app.js (bottom-up modularization). The session engine (classifySession/reconstructSessions) stays
// in app.js for now and imports these helpers downward. No behavior change.

import { ISP_PROVIDERS, KNOWN_IP_HINTS, IP_RANGES, SERVICE_DB, EPHEMERAL_MIN, PRIVATE_LABEL, PORT_SVC, PORT_MAP, PORT_RANGES, GENERIC_FAMILIES, HOSTING_PROVIDERS, DISTINCTIVE_INDICATORS } from '../core/constants.js';
import { fmtBytes } from '../core/utils.js';

function isIspProvider(name){return ISP_PROVIDERS.has(name)}
// Longest-prefix match: among all CIDRs containing the IP, return the most specific
// (largest mask = most 1-bits), so a tight block beats a broad one.
function ipInRange(ip,range){if(!ip||!ip.includes('.'))return null;const n=ip.split('.').reduce((s,o)=>(s*256+parseInt(o))>>>0,0);let best=null;for(const r of range){if((n&r.mask)===(r.range&r.mask)&&(!best||(r.mask>>>0)>(best.mask>>>0)))best=r}return best}
// Non-public address classification (CGNAT / private / loopback / link-local).
function ipKind(ip){if(!ip||!ip.includes('.'))return null;const o=ip.split('.').map(x=>parseInt(x));if(o.length!==4||o.some(isNaN))return null;const n=((o[0]*256+o[1])*256+o[2])*256+o[3];const in_=(a,bits)=>{const m=~(2**(32-bits)-1)>>>0;const r=a.split('.').reduce((s,x)=>(s*256+parseInt(x))>>>0,0);return (n&m)===(r&m)};if(in_('100.64.0.0',10))return'cgnat';if(in_('127.0.0.0',8))return'loopback';if(in_('169.254.0.0',16))return'link_local';if(in_('10.0.0.0',8)||in_('172.16.0.0',12)||in_('192.168.0.0',16))return'private';return null}
function ipHint(ip){if(!ip||!ip.includes('.'))return null;const n=ip.split('.').reduce((s,o)=>(s*256+parseInt(o))>>>0,0);const h=KNOWN_IP_HINTS.find(r=>(n&r.mask)===(r.range&r.mask));return h?{provider:h.prov,service:h.svc,activity:h.act}:null}
function trafficPattern(dur,up,dwn,protocol,portSet,recCount,hour){
  // Returns {category, activity, confidenceDelta, evidence}
  if(!dur&&!up&&!dwn)return null;
  const totalBytes=(up||0)+(dwn||0);
  const isUDP=protocol==='UDP';
  const isTCP=protocol==='TCP';
  const ratio=up>0&&dwn>0?up/dwn:(up>0?999:0);
  const symmetric=ratio>0.3&&ratio<3;
  const uploadHeavy=ratio>5;
  const downloadHeavy=dwn>0&&ratio<0.2;
  const hasVoipPort=portSet&&([...portSet].some(p=>[3478,3479,3480,3481,16384,16387,19302,19303,19304,19305,8801,8810,5004].includes(p)));
  const hasStreamPort=portSet&&([...portSet].some(p=>[80,443,8080].includes(p)));
  const hasVpnPort=portSet&&([...portSet].some(p=>[1194,1195,1701,1723,4500,500,51820,51821].includes(p)));
  const hasRemoteDesktopPort=portSet&&([...portSet].some(p=>[3389,5900,5901,5902,5938,7070].includes(p)));
  const hasFileTransferPort=portSet&&([...portSet].some(p=>[20,21,989,990,445,2049].includes(p)));
  const evidence=[];
  let category='',activity='',confDelta=0;

  // VPN / Tunnel: UDP, persistent, moderate data, VPN ports
  if(hasVpnPort&&dur>=30&&(isUDP||isTCP)){
    category='VPN';activity='Encrypted Tunnel';confDelta=15;
    evidence.push('VPN port(s): '+[...portSet].filter(p=>[1194,1195,1701,1723,4500,500,51820,51821].includes(p)).join(','));
    if(dur>=600){confDelta+=5;evidence.push('Persistent tunnel ('+dur+'s)')}
  }
  // Remote Desktop: TCP, interactive, screen-sharing ports
  else if(hasRemoteDesktopPort&&isTCP&&dur>10){
    category='Remote Desktop';activity='Remote Access';confDelta=15;
    evidence.push('Remote desktop port(s): '+[...portSet].filter(p=>[3389,5900,5901,5902,5938,7070].includes(p)).join(','));
    if(dur>=300){confDelta+=5;evidence.push('Extended remote session')}
    if(totalBytes>1e6){confDelta+=5;evidence.push('Data: '+fmtBytes(totalBytes))}
  }
  // File Transfer / SMB: TCP, upload+download, file-transfer ports
  else if(hasFileTransferPort&&isTCP&&totalBytes>500000){
    category='File Transfer';activity='File Transfer';confDelta=12;
    evidence.push('File transfer port(s): '+[...portSet].filter(p=>[20,21,989,990,445,2049].includes(p)).join(','));
    if(uploadHeavy)evidence.push('Upload: '+fmtBytes(up));
    if(downloadHeavy)evidence.push('Download: '+fmtBytes(dwn));
  }
  // Cloud Sync: moderate data, TCP, persistent, bidirectional
  else if(isTCP&&dur>60&&totalBytes>100000&&symmetric&&!hasVoipPort){
    category='Cloud Sync';activity='Sync / Backup';confDelta=8;
    evidence.push('Bidirectional sync: '+fmtBytes(up)+' up ↔ '+fmtBytes(dwn)+' down');
    if(dur>=600){confDelta+=5;evidence.push('Extended sync session ('+dur+'s)')}
  }
  // Screen Sharing: UDP, sustained, moderate data, screen-share ports
  else if(isUDP&&dur>=30&&totalBytes>200000&&totalBytes<5e6&&hasStreamPort){
    category='Screen Sharing';activity='Screen Share';confDelta=10;
    evidence.push('UDP screen sharing pattern, '+fmtBytes(totalBytes));
  }
  // Video Call: UDP + more data + longer duration (check before Voice for specificity)
  else if(isUDP&&dur>=60&&totalBytes>1e6&&symmetric){
    category='Video Call';activity='Video Session';confDelta=15;
    evidence.push('UDP '+dur+'s session');
    evidence.push('High data volume: '+fmtBytes(totalBytes));
    if(hasVoipPort){confDelta+=10;evidence.push('VoIP port(s)')}
  }
  // Voice Call: UDP + symmetric + moderate-long duration + VoIP ports
  else if(isUDP&&dur>=30&&symmetric&&totalBytes>50000&&totalBytes<2e7){
    category='Voice Call';activity='Voice Session';confDelta=15;
    evidence.push('UDP '+dur+'s session');
    evidence.push('Symmetric traffic (ratio '+(ratio.toFixed(1))+')');
    if(hasVoipPort){confDelta+=10;evidence.push('VoIP port(s): '+[...portSet].filter(p=>[3478,3479,3480,3481,8801,8810,16384,19302].includes(p)).join(','))}
    if(dur>=300){confDelta+=5;evidence.push('Extended call >5min')}
  }
  // Streaming: TCP + high download + long duration + download-heavy
  else if(isTCP&&dur>=120&&downloadHeavy&&dwn>5000000){
    category='Streaming';activity='Content Stream';confDelta=12;
    evidence.push('Download: '+fmtBytes(dwn));
    evidence.push('Duration: '+dur+'s');
    if(dwn>5e7){confDelta+=5;evidence.push('HD stream quality (>50MB)')}
  }
  // Conference: UDP + multiple concurrent streams or long duration
  else if(isUDP&&dur>=120&&totalBytes>500000){
    category='Conference';activity='Conference Call';confDelta=10;
    evidence.push('UDP '+dur+'s session, '+fmtBytes(totalBytes));
  }
  // Media Upload: upload-heavy
  else if(up>500000&&uploadHeavy&&dur>5){
    category='Media Upload';activity='Upload';confDelta=8;
    evidence.push('Upload: '+fmtBytes(up)+' (ratio '+ratio.toFixed(1)+')');
  }
  // Messaging: short burst, small data
  else if(recCount>1&&dur<=30&&totalBytes<100000&&isUDP){
    category='Messaging';activity='Chat / Status Update';confDelta=8;
    evidence.push('Short burst: '+recCount+' records in '+dur+'s');
  }
  else if(recCount>1&&dur<=30&&totalBytes<200000&&isTCP){
    category='Messaging';activity='Interactive Messaging';confDelta=5;
    evidence.push('Brief TCP exchange: '+recCount+' records');
  }
  // Browsing / Interactive: TCP, moderate data, mix
  else if(isTCP&&dur<120&&totalBytes<5e6){
    category='Browsing';activity='Web / Interactive';confDelta=3;
    evidence.push('Brief TCP session');
  }
  // Keep-alive / Presence
  else if(dur<5&&recCount<=2&&totalBytes<5000){
    category='Presence';activity='Keep-alive / Ping';confDelta=5;
    evidence.push('Minimal traffic: '+fmtBytes(totalBytes));
  }
  // Default to network traffic
  else{
    category='Network Traffic';activity='Data Transfer';
    evidence.push('Traffic: '+fmtBytes(totalBytes)+' over '+dur+'s');
  }
  // Time-of-day enhancement (bonus evidence for regular patterns)
  if(hour!==undefined){
    if(hour>=23||hour<4){evidence.push('Late night activity ('+hour+':00) — off-peak pattern')}
    else if(hour>=9&&hour<=17){evidence.push('Business hours ('+hour+':00) — work pattern')}
  }
  return{category,activity,confDelta,evidence};
}
// -- Multi-level service attribution engine --
// Level 1: Infrastructure (provider IP) → 95-99%
// Level 2: Session behavioral fingerprint → +5-25%
// Level 3: Port + Protocol match → +10-30%
// Level 4: Activity taxonomy
// Output: {provider, tier, primary:{service,activity}, confidence, evidence[], candidates[]}
function scoreProvider(servs,ports,proto,dur,dir,bytesUp,bytesDn,recCount,provName){
  const scored=[];
  const tp=trafficPattern(dur,bytesUp,bytesDn,proto,ports,recCount);
  servs.forEach(svc=>{
    const allPorts=[...(svc.ports.tcp||[]),...(svc.ports.udp||[])];
    const portMatch=ports.size>0?[...ports].some(p=>allPorts.includes(p)):false;
    const protoMatch=proto&&svc.proto.includes(proto);
    const actMatch=tp?svc.acts.some(a=>a.toLowerCase().includes(tp.category.toLowerCase().split(' ')[0].toLowerCase())||tp.category.toLowerCase().includes(a.toLowerCase().split(' ')[0].toLowerCase())):false;
    let score=60; // provider base
    if(portMatch)score+=15;
    if(protoMatch)score+=10;
    if(actMatch)score+=10;
    // Duration signals
    if(dur>=300)score+=5;
    else if(dur>=30)score+=2;
    // Data volume signals
    if((bytesUp||0)>1e6||(bytesDn||0)>1e6)score+=3;
    // Category-based scoring with penalties
    if(tp&&svc.cats){
      if(svc.cats.includes(tp.category)){
        score+=15; // matching behavior category
      }else if(svc.cats.length>0&&tp.category!=='Network Traffic'&&tp.category!=='Presence'){
        score-=10; // non-matching specific activity
      }
    }
    // VPN services: penalize heavily for non-VPN traffic patterns
    if(svc.cats&&svc.cats.length===1&&svc.cats[0]==='VPN'&&tp&&tp.category!=='VPN'){
      score-=25;
    }
    // Infrastructure-only services (empty cats): reduce score for specific activities
    if(svc.cats&&svc.cats.length===0&&tp&&tp.category!=='Network Traffic'){
      score=Math.round(score*0.6);
    }
    // Distinctive indicators: strong multi-factor signatures
    const di=DISTINCTIVE_INDICATORS.find(d=>d.svc===svc.n);
    const diHit=di&&provName&&di.check(provName,proto,ports,new Set(ports));
    if(diHit){score+=15}
    scored.push({svc:svc.n,act:svc.acts[0],score,portMatch,protoMatch,actMatch,dur,trafficCat:tp?tp.category:null,diHit});
  });
  scored.sort((a,b)=>b.score-a.score);
  return scored;
}
function pickBest(scored,duration,trafficCat,trafficEvidence){
  if(!scored||!scored.length)return{tier:4,providerConfidence:10,serviceConfidence:5,primary:{service:'Unknown',activity:'Traffic'},serviceLabel:'Unknown',activityLabel:'Traffic',candidates:[],evidence:['No matching services'],hasPortProto:false,strongCount:0};
  const top=scored[0];
  const strong=scored.filter(s=>s.score>=top.score*0.85);
  const hasPortProto=scored.some(s=>s.portMatch||s.protoMatch);
  const hasBoth=top.portMatch&&top.protoMatch;
  const hasAct=scored.some(s=>s.actMatch);
  let tier,serviceConfidence,providerConfidence,serviceLabel,activityLabel;
  const evidence=[...trafficEvidence];
  // Provider confidence: based on specificity and consensus
  providerConfidence=hasPortProto?75:hasAct?68:60;
  // Service confidence: based on match strength
  if(hasBoth&&hasAct&&duration>=60&&top.score>=100){tier=3;serviceConfidence=73;serviceLabel='Possible '+top.svc;activityLabel=top.act}
  else if(strong.length===1&&top.portMatch&&hasAct){tier=2;serviceConfidence=84;providerConfidence=82;serviceLabel='Likely '+top.svc;activityLabel=top.act}
  else if(strong.length===1&&hasAct){tier=2;serviceConfidence=80;serviceLabel='Likely '+top.svc;activityLabel=top.act}
  else if(strong.length===1&&top.portMatch){tier=2;serviceConfidence=82;serviceLabel='Likely '+top.svc;activityLabel=top.act}
  else if(strong.length===1&&hasPortProto){tier=2;serviceConfidence=78;serviceLabel='Likely '+top.svc;activityLabel=top.act}
  else if(hasPortProto&&strong.length>1){tier=4;serviceConfidence=50;providerConfidence=70;serviceLabel='__MULTI__';activityLabel=strong.map(s=>s.svc).join('/')}
  else if(!hasPortProto&&!hasAct){tier=1;serviceConfidence=30;providerConfidence=92;serviceLabel='__PROV__';activityLabel='Network Traffic'}
  else if(!hasPortProto&&hasAct){tier=1;serviceConfidence=45;providerConfidence=90;serviceLabel='__PROV__';activityLabel=trafficCat||'Activity'}
  else{tier=4;serviceConfidence=41;providerConfidence=35;serviceLabel='Unknown';activityLabel='Traffic'}
  const alts=scored.slice(1,5).filter(s=>s.score>=top.score-20).map(s=>({service:s.svc,activity:s.act,score:s.score}));
  if(top.portMatch){const mp=scored.filter(s=>s.portMatch).map(s=>s.svc);if(mp.length)evidence.push('Port match: '+[...new Set(mp)].join(', '))}
  if(top.protoMatch)evidence.push(scored[0].trafficCat?'Behavioral: '+scored[0].trafficCat:'Protocol match');
  if(duration>=60)evidence.push('Session duration: '+duration+'s');
  if(strong.length>1)evidence.push('Candidates: '+strong.map(s=>s.svc+' ('+s.score+'%)').join(', '));
  return{tier,providerConfidence,serviceConfidence,primary:{service:top.svc,activity:top.act},serviceLabel,activityLabel,candidates:alts,evidence,hasPortProto,strongCount:strong.length,trafficCat:top.trafficCat};
}
function recordSvcAttr(r){
  if(r.type!=='IPDR')return'';
  const m=matchService(r);
  const conf=m.serviceConfidence||0;
  if(m.tier===4&&conf<15)return'';
  const actStr=m.activityLabel?': '+m.activityLabel:'';
  const confStr=conf?' ['+conf+'%]':'';
  return m.serviceLabel+actStr+confStr;
}
function matchService(rec){
  const sp=parseInt(rec.sport),dp=parseInt(rec.dport);
  // Drop an ephemeral source port when a destination port exists — it's the
  // connection's own short-lived port, not the service being contacted.
  const ports=new Set();
  if(dp)ports.add(dp);
  if(sp&&!(dp&&sp>=EPHEMERAL_MIN))ports.add(sp);
  const proto=rec.prot?rec.prot.toUpperCase():'';
  const dur=rec.dur||0;const dir=rec.dir||'';const up=rec.bytesUp||0;const dn=rec.bytesDn||0;
  // Deterministic: a private/CGNAT/loopback destination is internal, not an internet service.
  const dkind=ipKind(rec.cnt);
  if(dkind){
    const label=PRIVATE_LABEL[dkind]||'Private';
    const portName=dp&&PORT_SVC[dp]?' ('+PORT_SVC[dp]+')':'';
    return{provider:'',tier:1,primary:{service:label,activity:'Internal'},serviceLabel:label,activityLabel:'Internal / non-routable',serviceConfidence:70,category:'internal',candidates:[],evidence:[label+' destination IP'+portName].concat(proto?[proto+' protocol']:[])};
  }
  // The COUNTERPART (destination) is what names the contacted service. The subject's own IP is
  // their endpoint (carrier CGNAT, or a hosting box for server-side records) — consulting it as a
  // content label would tag any session merely ORIGINATING from an AWS/Meta IP as that service.
  // It is therefore only used to identify the access network (ISP) when the counterpart matches
  // nothing — mirroring the backend engine's _classify_by_ip policy.
  const cntM=ipInRange(rec.cnt,IP_RANGES),subM=ipInRange(rec.sub,IP_RANGES);
  const ipRes=cntM||(subM&&subM.isp?subM:null);
  const provName=ipRes?ipRes.provider:null;
  const evidence=[];
  // An ISP-only match identifies the carrier; fall through to port classification and only
  // label it an access network if no specific service is found (Phase 2 fallbacks below).
  const ispCarrier=(ipRes&&ipRes.isp)?provName:null;
  const accessNet=()=>({provider:provName,providerConfidence:55,tier:1,primary:{service:provName,activity:'Access Network'},serviceLabel:provName+' (Access Network)',activityLabel:'Carrier / ISP traffic',serviceConfidence:30,candidates:[],evidence:[provName+' access network ('+ipRes.raw+')'].concat(proto?[proto+' protocol']:[])});
  // Phase 1: known content provider from IP (Level 1 — Infrastructure)
  if(provName&&!ispCarrier){
    evidence.push(provName+' IP range ('+ipRes.raw+')');
    const hint=ipHint(rec.cnt);  // counterpart only — a hint on the subject's own IP is not the contacted service
    if(hint){
      evidence.push(hint.provider+' '+hint.service+' ('+hint.activity+')');
      return{provider:hint.provider,providerConfidence:96,tier:1,primary:{service:hint.service,activity:hint.activity},serviceLabel:hint.service,activityLabel:hint.activity,serviceConfidence:95,candidates:[],evidence};
    }
    const prov=SERVICE_DB.find(p=>p.pr===provName);
    if(prov){
      const tp=trafficPattern(dur,up,dn,proto,ports,1,rec.ts?new Date(rec.ts).getHours():undefined);
      const scored=scoreProvider(prov.services,ports,proto,dur,dir,up,dn,1,provName);
      const best=pickBest(scored,dur,tp?tp.category:null,tp?tp.evidence:[]);
      best.provider=provName;
      if(HOSTING_PROVIDERS.has(provName)){best.category='hosting';best.evidence.push('Cloud/VPS host — possible VPN, proxy, or self-hosted endpoint')}
      // Resolve placeholders
      if(best.serviceLabel==='__PROV__'){best.serviceLabel=provName+' '+best.primary.service;best.primary={service:provName,activity:best.activityLabel||'Network Traffic'}}
      else if(best.serviceLabel==='__MULTI__'){best.serviceLabel=provName+' ('+best.activityLabel+')';best.primary={service:provName,activity:'Multiple'};best.activityLabel='Multiple: '+scored.filter(s=>s.score>=scored[0].score-3).map(s=>s.svc).join('/')}
      // Build evidence for display
      if(ports.size){const mp=[...ports].join(',');best.evidence.unshift(ports.size>1?'Ports: '+mp:'Port: '+mp+(PORT_SVC[parseInt(mp)]?' ('+PORT_SVC[parseInt(mp)]+')':''))}
      if(proto)best.evidence.unshift(proto+' protocol');
      if(tp&&best.trafficCat)best.evidence.unshift('Behavior: '+best.trafficCat);
      best.candidates=scored.map(s=>({service:s.svc,activity:s.act,score:s.score,portMatch:s.portMatch,protoMatch:s.protoMatch,trafficCat:s.trafficCat}));
      best.evidence=best.evidence.filter((v,i,a)=>a.indexOf(v)===i);
      return best;
    }
  }
  // Phase 2: no provider — fallback to port-based classification
  const genericPorts=[80,443,8080,8443,9443,10443];
  // UDP on a TLS port is QUIC (HTTP/3) — real signal, so let it reach the port table below.
  const isQuic=proto==='UDP'&&[...ports].some(p=>p===443||p===8443);
  if(!isQuic&&(ports.size===0||[...ports].every(p=>genericPorts.includes(p))))return ispCarrier?accessNet():{provider:'',tier:4,primary:{service:'Unknown',activity:'Encrypted Traffic'},serviceLabel:'Unknown',activityLabel:'Encrypted Traffic',serviceConfidence:5,candidates:[],evidence:['No matching provider IP — generic HTTPS/encrypted']};
  // Shared port-classification table — the SAME ~250-port PORT_MAP + range bands the backend
  // engine uses (attribution_data.json "port_map"/"port_ranges"): port -> [label, confidence,
  // reason, family, subtype]. Best match = highest confidence; tie-break toward the lower
  // (more well-known) port. Replaces the old ~30-entry GENERIC_SVC subset.
  const _portRule=p=>{const m=PORT_MAP[p];if(m)return m;const b=PORT_RANGES.find(r=>p>=r[0]&&p<=r[1]);return b?b.slice(2):null};
  let pmPort=null,pmRule=null;
  for(const p of ports){
    const m=_portRule(p);
    if(m&&(!pmRule||m[1]>pmRule[1]||(m[1]===pmRule[1]&&p<pmPort))){pmPort=p;pmRule=m;}
  }
  if(pmRule){
    const label=pmRule[0],reason=pmRule[2],family=pmRule[3];let conf=pmRule[1],subtype=pmRule[4];
    // A generic web family carries no real service detail — the carrier is the one thing we know.
    if(ispCarrier&&GENERIC_FAMILIES.has(family))return accessNet();
    if(proto==='UDP'&&(pmPort===443||pmPort===8443)){conf=Math.min(96,conf+2);subtype='QUIC (HTTP/3) session';evidence.push('QUIC (HTTP/3): UDP on TLS port')}
    evidence.unshift('Port '+pmPort+' — '+reason+(proto?' ('+proto+')':''));
    if(ispCarrier)evidence.push(ispCarrier+' access network ('+ipRes.raw+')');
    const category=family==='VPN / Tunnel'?'vpn':family==='Proxy / Tor'?'anonymization':'service';
    return{provider:ispCarrier||'',tier:4,primary:{service:family,activity:subtype},serviceLabel:label,activityLabel:subtype,serviceConfidence:conf,category,candidates:[],evidence};
  }
  // Try known provider DB for less common ports
  const fallbackCandidates=[];
  SERVICE_DB.forEach(prov=>{
    prov.services.forEach(svc=>{
      const allPorts=[...(svc.ports.tcp||[]),...(svc.ports.udp||[])];
      if([...ports].some(p=>allPorts.includes(p)))fallbackCandidates.push({provider:prov.pr,service:svc.n,activity:svc.acts[0],port:[...ports].find(p=>allPorts.includes(p))});
    });
  });
  if(fallbackCandidates.length){
    const best=fallbackCandidates[0];
    evidence.push('Port '+best.port+' ('+(PORT_SVC[best.port]||'')+') — candidate: '+best.provider+' '+best.service);
    if(proto)evidence.push(proto+' protocol');
    if(ispCarrier)evidence.push(ispCarrier+' access network ('+ipRes.raw+')');
    return{provider:best.provider,providerConfidence:25,tier:4,primary:{service:best.service,activity:best.activity},serviceLabel:'Unknown',activityLabel:'Possible '+best.activity,serviceConfidence:12,candidates:fallbackCandidates.map(c=>({service:c.service,activity:c.activity,score:10})),evidence};
  }
  return ispCarrier?accessNet():{provider:'',tier:4,primary:{service:'Unknown',activity:'Traffic'},serviceLabel:'Unknown',activityLabel:'Traffic',serviceConfidence:8,candidates:[],evidence:['No matching provider or service signature']};
}

export { isIspProvider, ipInRange, ipKind, ipHint, trafficPattern, scoreProvider, pickBest, recordSvcAttr, matchService };
