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

// ── Port-classification layer: a 1:1 mirror of the backend engine's stack ──
// (service_attribution_service.py: _classify_whatsapp / _classify_generic / _fallback_classify /
// _classify_by_port). Same shared PORT_MAP/PORT_RANGES data, same subtype refinement by transfer
// volume, same ephemeral demotion, protocol-alignment nudges, and tie-breaks — so a record shown
// in the frontend Records table classifies identically to the backend Services report. The parity
// harness (scripts/test_attribution_parity.mjs) asserts this stays true; if you change a rule
// here, change the backend too and re-run it.
function humanBytes(b){if(b>=1e9)return(b/1e9).toFixed(1)+'GB';if(b>=1e6)return(b/1e6).toFixed(1)+'MB';if(b>=1e3)return(b/1e3).toFixed(1)+'KB';return b+'B'}

function classifyWhatsApp(protocol,port,bytes){
  if(port===3478&&protocol==='UDP')return['Call initialization',96,['UDP STUN / NAT traversal']];
  if(port===5222||port===5223)return['Session setup / keepalive',90,['Messaging session port']];
  if(port===5228)return['Session keepalive',91,['Push / background messaging port']];
  if(bytes!=null){
    if(bytes<25000)return['Call teardown / keepalive',72,['Low transfer volume']];
    if(bytes<250000)return['Call signaling',82,['Medium transfer volume']];
    if(bytes<1500000)return['Call duration / active session',88,['Sustained media exchange']];
    return['Call duration / media session',92,['High transfer volume']];
  }
  return['Call session',80,['Port mapped to WhatsApp']];
}

function classifyGeneric(service,port,bytes,protocol){
  if(service==='DNS')return['Lookup / resolution',92,['DNS family port']];
  if(service==='Web'||service==='Encrypted Web/App'||service==='Hosting / Web'||service==='Casting / Streaming'){
    if(bytes!=null&&bytes>500000)return['Content transfer / session',80,['Large payload']];
    if(protocol==='TLS'||port===443||port===8443||port===2083||port===2096)return['Encrypted session',82,['Encrypted transport']];
    return['Page fetch / browsing',76,['Web family port']];
  }
  if(service==='Mail'){
    if(port===25||port===465||port===587||port===2525)return['Submission',84,['Mail submission port']];
    return['Retrieval',84,['Mailbox retrieval port']];
  }
  if(service==='VPN / Tunnel'){
    if(bytes!=null&&bytes>250000)return['Tunnel traffic',84,['Sustained tunnel traffic']];
    if(bytes!=null&&bytes<5000)return['Keepalive / handshake',78,['Minimal tunnel traffic']];
    return['Tunnel setup',86,['Tunnel negotiation port']];
  }
  if(service==='VoIP / SIP')return['Call signaling',90,['SIP family port']];
  if(service==='Remote Desktop'){
    if(bytes!=null&&bytes>250000)return['Interactive session',86,['Active remote session']];
    return['Session setup',82,['Remote access port']];
  }
  if(service==='Database'){
    if(bytes!=null&&bytes>1000000)return['Bulk data / query',80,['Large database transfer']];
    return['Query / transaction',78,['Database family port']];
  }
  if(service==='Streaming'){
    if(bytes!=null&&bytes>5000000)return['Active media stream',86,['High-volume streaming']];
    return['Media session',80,['Streaming family port']];
  }
  if(service==='IoT / MQTT')return['Broker session',78,['MQTT broker port']];
  if(service==='File Transfer'){
    if(bytes!=null&&bytes>5000000)return['Large file transfer',84,['High-volume transfer']];
    return['Transfer session',78,['File transfer port']];
  }
  if(service==='Remote Access'){
    if(bytes!=null&&bytes>100000)return['Active session',76,['Sustained remote access']];
    return['Remote login',74,['Remote access port']];
  }
  if(service==='Device Discovery')return['Discovery',70,['Discovery port']];
  if(service==='Video Conf / Streaming'){
    if(bytes!=null&&bytes>500000)return['Active video call',86,['Sustained media exchange']];
    if(bytes!=null&&bytes>50000)return['Audio call / screen share',80,['Medium media exchange']];
    if(bytes!=null&&bytes<5000)return['Keepalive / STUN',72,['Minimal media keepalive']];
    return['Media session',78,['Conferencing family port']];
  }
  if(service==='Messaging / Social'){
    if(bytes!=null&&bytes<10000)return['Instant message / ping',74,['Minimal transfer volume']];
    return['Messaging session',72,['Messaging platform port']];
  }
  if(service==='Gaming'){
    if(bytes!=null&&bytes>5000000)return['Active gameplay',82,['High-volume game traffic']];
    if(bytes!=null&&bytes>100000)return['Multiplayer session',78,['Sustained game traffic']];
    return['Client / lobby',72,['Game family port']];
  }
  if(service==='P2P / File Sharing'){
    if(bytes!=null&&bytes>10000000)return['Active download / upload',86,['High-volume P2P transfer']];
    return['P2P session',76,['P2P family port']];
  }
  if(service==='Proxy / Tor'){
    if(bytes!=null&&bytes>1000000)return['Relayed traffic',76,['High-volume proxy tunnel']];
    return['Proxy session',72,['Proxy family port']];
  }
  if(service==='Cache / Backend')return['Backend session',70,['Cache / backend port']];
  if(service==='Queue / Backend')return['Message broker session',72,['Queue/backend port']];
  if(service==='File / Print')return['File / print service',68,['File/print family port']];
  if(service==='Directory / LDAP')return['Directory lookup',72,['Directory family port']];
  if(service==='Authentication')return['Auth session',68,['Authentication protocol port']];
  if(service==='Infrastructure')return['Network service',68,['Infrastructure port']];
  if(service==='Remote Management')return['Admin session',66,['Management port']];
  if(service==='Multimedia / Home')return['Media sharing session',62,['Home entertainment port']];
  if(service==='Development')return['Dev tool session',62,['Development port']];
  if(service==='Crypto / Blockchain'){
    if(bytes!=null&&bytes>100000000)return['Blockchain sync',80,['High-volume blockchain traffic']];
    return['Crypto node session',68,['Blockchain port']];
  }
  if(service==='Security')return['Suspicious activity',44,['Common RAT port']];
  return['Session',60,['Generic service family']];
}

function fallbackClassify(protocol,bytes,port){
  const candidates=[];
  if(protocol==='UDP'){
    if(bytes!=null&&bytes>5000000)candidates.push({service:'Likely Streaming / Media',subtype:'High-volume stream',confidence:60,evidence:['UDP high traffic ('+humanBytes(bytes)+')','Unrecognized port']});
    if(bytes!=null&&bytes>1000000)candidates.push({service:'Likely Video Conf / Streaming',subtype:'Media stream',confidence:56,evidence:['UDP sustained traffic ('+humanBytes(bytes)+')','Unrecognized port']});
    candidates.push({service:'Likely Messaging / VoIP',subtype:'Media / signalling session',confidence:42,evidence:['Protocol UDP','Generic media or signalling session']});
  }else if(protocol==='TCP'){
    if(bytes!=null&&bytes>10000000)candidates.push({service:'Likely Content Transfer',subtype:'Large download / upload',confidence:58,evidence:['TCP high traffic ('+humanBytes(bytes)+')','Unrecognized port']});
    if(bytes!=null&&bytes>500000)candidates.push({service:'Likely File Transfer',subtype:'Medium file transfer',confidence:44,evidence:['TCP sustained traffic ('+humanBytes(bytes)+')','Unrecognized port']});
    candidates.push({service:'Likely Encrypted Web/App',subtype:'Generic TCP session',confidence:26,evidence:['Protocol TCP','Generic TCP session']});
  }else{
    candidates.push({service:'Likely Custom Protocol',subtype:'Protocol '+protocol+' session',confidence:18,evidence:['Unknown protocol '+protocol,'No known port match']});
  }
  if(bytes===0&&port)candidates.push({service:'Likely Keepalive / Probe',subtype:'Zero-byte session',confidence:36,evidence:['Zero data transferred','Port connection attempt']});
  if(port!=null&&port>=49152&&port<=65535)candidates.forEach(c=>c.evidence.push('Ephemeral source port (no service info)'));
  return candidates.reduce((a,b)=>b.confidence>a.confidence?b:a,candidates[0]);
}

const _UDP_ALIGNED=new Set([53,3478,500,4500,1194,1701,51820,3544,19302]);
const _TCP_ALIGNED=new Set([80,443,5222,5223,5228,5060,5061,3389,5900,3306,5432,8443,25,110,143,993,995]);

function classifyByPort(dportRaw,sportRaw,protocol,bytes){
  const candidates=[];
  const seenServices=new Set();
  // Destination first: for an outbound session it's the well-known service port; the source is
  // typically ephemeral, so a match there is flagged and demoted unless nothing better exists.
  for(const[raw,isSource]of[[dportRaw,false],[sportRaw,true]]){
    if(raw==null||raw==='')continue;
    const port=parseInt(raw);
    if(isNaN(port))continue;
    let base=PORT_MAP[port];
    if(!base){const band=PORT_RANGES.find(r=>port>=r[0]&&port<=r[1]);base=band?band.slice(2):null}
    if(!base)continue;
    const label=base[0],reason=base[2],family=base[3];
    if(seenServices.has(family))continue;
    seenServices.add(family);
    const suspectEphemeral=isSource&&port>=EPHEMERAL_MIN;
    const evidence=['Port '+port,reason];
    const sub=family==='WhatsApp'?classifyWhatsApp(protocol,port,bytes):classifyGeneric(family,port,bytes,protocol);
    let subtype=sub[0],confidence=sub[1];
    evidence.push(...sub[2]);
    if(protocol==='UDP'&&_UDP_ALIGNED.has(port)){confidence=Math.min(96,confidence+3);evidence.push('UDP aligned')}
    else if(protocol==='UDP'&&(port===443||port===8443)){confidence=Math.min(96,confidence+2);subtype='QUIC (HTTP/3) session';evidence.push('QUIC (HTTP/3): UDP on TLS port')}
    else if(protocol==='TCP'&&_TCP_ALIGNED.has(port)){confidence=Math.min(96,confidence+2);evidence.push('TCP aligned')}
    candidates.push({service:label,subtype,confidence,evidence,family,port,suspectEphemeral});
  }
  if(candidates.length){
    const strong=candidates.filter(c=>!c.suspectEphemeral);
    let pool=candidates;
    if(strong.length)pool=strong;
    else pool.forEach(c=>{c.confidence=Math.max(10,c.confidence-25);c.evidence.push('Ephemeral source-port match (low confidence)')});
    let best=pool[0];
    for(const c of pool)if(c.confidence>best.confidence||(c.confidence===best.confidence&&c.port<best.port))best=c;
    const category=best.family==='VPN / Tunnel'?'vpn':best.family==='Proxy / Tor'?'anonymization':'service';
    return{service:best.service,subtype:best.subtype,confidence:best.confidence,family:best.family,port:best.port,category,evidence:best.evidence};
  }
  const fbPort=parseInt(dportRaw)||parseInt(sportRaw)||null;
  const fb=fallbackClassify(protocol,bytes,fbPort);
  if(fb)return{service:fb.service,subtype:fb.subtype,confidence:fb.confidence,family:fb.service,port:null,category:'unknown',evidence:fb.evidence};
  return{service:'Unknown',subtype:'Unclassified',confidence:10,family:'Unknown',port:null,category:'unknown',evidence:[protocol?'Protocol '+protocol:'Protocol unknown','No classification possible']};
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
  // Shared port-classification result (backend _classify_by_port mirror) — computed up-front,
  // exactly as the backend does, because the private-destination and carrier branches both
  // consult it before the generic fallbacks.
  const portRes=classifyByPort(rec.dport,rec.sport,proto,up+dn);
  // Deterministic: a private/CGNAT/loopback destination is internal, not an internet service.
  const dkind=ipKind(rec.cnt);
  if(dkind){
    const label=PRIVATE_LABEL[dkind]||'Private';
    // Keep a specific port-mapped service (RDP into a LAN box, internal DB, ...) and mark it
    // internal; only fall back to the bare private label when the port says nothing specific.
    if(portRes.port!=null&&!GENERIC_FAMILIES.has(portRes.family)){
      return{provider:'',tier:1,primary:{service:portRes.family,activity:portRes.subtype},serviceLabel:portRes.service,activityLabel:portRes.subtype,serviceConfidence:portRes.confidence,category:'internal',candidates:[],evidence:portRes.evidence.concat([label+' destination'])};
    }
    return{provider:'',tier:1,primary:{service:label,activity:'Internal'},serviceLabel:label,activityLabel:'Internal / non-routable',serviceConfidence:70,category:'internal',candidates:[],evidence:[label+' destination IP'].concat(proto?[proto+' protocol']:[])};
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
  const accessNet=()=>({provider:provName,providerConfidence:55,tier:1,primary:{service:provName,activity:'Access Network'},serviceLabel:provName+' (Access Network)',activityLabel:'Carrier / ISP traffic',serviceConfidence:30,category:'access_network',candidates:[],evidence:[provName+' access network ('+ipRes.raw+')'].concat(proto?[proto+' protocol']:[])});
  // Phase 1: known content provider from IP (Level 1 — Infrastructure)
  if(provName&&!ispCarrier){
    evidence.push(provName+' IP range ('+ipRes.raw+')');
    const hint=ipHint(rec.cnt);  // counterpart only — a hint on the subject's own IP is not the contacted service
    if(hint){
      evidence.push(hint.provider+' '+hint.service+' ('+hint.activity+')');
      return{provider:hint.provider,providerConfidence:96,tier:1,primary:{service:hint.service,activity:hint.activity},serviceLabel:hint.service,activityLabel:hint.activity,serviceConfidence:95,category:'content',candidates:[],evidence};
    }
    const prov=SERVICE_DB.find(p=>p.pr===provName);
    if(prov&&prov.services&&prov.services.length){
      const tp=trafficPattern(dur,up,dn,proto,ports,1,rec.ts?new Date(rec.ts).getHours():undefined);
      const scored=scoreProvider(prov.services,ports,proto,dur,dir,up,dn,1,provName);
      const best=pickBest(scored,dur,tp?tp.category:null,tp?tp.evidence:[]);
      best.provider=provName;
      if(HOSTING_PROVIDERS.has(provName)){best.category='hosting';best.evidence.push('Cloud/VPS host — possible VPN, proxy, or self-hosted endpoint')}
      else best.category='content';
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
    // Provider matched by IP but has no service catalogue entry — still name it, exactly like the
    // backend's _merge_provider (confidence scaled by CIDR specificity). Previously this fell
    // through to the generic path and silently discarded the provider match.
    const plen=32-Math.log2((~ipRes.mask>>>0)+1);
    const conf=plen>=20?90:plen>=16?85:78;
    const hosting=HOSTING_PROVIDERS.has(provName);
    const mergeEv=[provName+' IP range ('+ipRes.raw+')'];
    if(hosting)mergeEv.push('Cloud/VPS host — possible VPN, proxy, or self-hosted endpoint');
    if(portRes.port)mergeEv.push('Port '+portRes.port);
    for(const e of portRes.evidence){if(!mergeEv.includes(e))mergeEv.push(e);if(mergeEv.length>=5)break}
    const mergeSub=portRes.service!=='Unknown'?portRes.subtype:'Network session';
    return{provider:provName,providerConfidence:conf,tier:1,primary:{service:provName,activity:mergeSub},serviceLabel:'Likely '+provName,activityLabel:mergeSub,serviceConfidence:conf,category:hosting?'hosting':'content',candidates:[],evidence:mergeEv};
  }
  // Phase 2: no content provider — the shared port-classification layer (a 1:1 backend mirror,
  // computed up-front as portRes). Carrier handling matches attribute_service(): a specific
  // port-mapped service (DNS, VPN, RDP, ...) is kept and annotated with the carrier; a generic
  // web match or behavioural guess never outranks the carrier, which falls back to the
  // access-network label.
  if(ispCarrier){
    if(portRes.port!=null&&!GENERIC_FAMILIES.has(portRes.family)){
      return{provider:ispCarrier,tier:4,primary:{service:portRes.family,activity:portRes.subtype},serviceLabel:portRes.service,activityLabel:portRes.subtype,serviceConfidence:portRes.confidence,category:portRes.category,candidates:[],evidence:portRes.evidence.concat([ispCarrier+' access network ('+ipRes.raw+')'])};
    }
    return accessNet();
  }
  // No port-table match either: check the provider service catalogues for less common ports
  // (frontend-only extra signal the backend doesn't have — kept because it can still suggest a
  // candidate service, at very low confidence, where the shared table says nothing).
  if(portRes.port==null&&ports.size){
    const fallbackCandidates=[];
    SERVICE_DB.forEach(prov=>{
      (prov.services||[]).forEach(svc=>{
        const allPorts=[...(svc.ports.tcp||[]),...(svc.ports.udp||[])];
        if([...ports].some(p=>allPorts.includes(p)))fallbackCandidates.push({provider:prov.pr,service:svc.n,activity:svc.acts[0],port:[...ports].find(p=>allPorts.includes(p))});
      });
    });
    if(fallbackCandidates.length){
      const best=fallbackCandidates[0];
      evidence.push('Port '+best.port+' ('+(PORT_SVC[best.port]||'')+') — candidate: '+best.provider+' '+best.service);
      if(proto)evidence.push(proto+' protocol');
      return{provider:best.provider,providerConfidence:25,tier:4,primary:{service:best.service,activity:best.activity},serviceLabel:'Unknown',activityLabel:'Possible '+best.activity,serviceConfidence:12,candidates:fallbackCandidates.map(c=>({service:c.service,activity:c.activity,score:10})),evidence};
    }
  }
  // Pure port-layer result: a table/range match, the behavioural fallback, or Unknown — all
  // shaped exactly like the backend's attribute_service() return for the same record.
  return{provider:'',tier:4,primary:{service:portRes.family,activity:portRes.subtype},serviceLabel:portRes.service,activityLabel:portRes.subtype,serviceConfidence:portRes.confidence,category:portRes.category,candidates:[],evidence:portRes.evidence};
}

export { isIspProvider, ipInRange, ipKind, ipHint, trafficPattern, scoreProvider, pickBest, recordSvcAttr, matchService, classifyByPort, fallbackClassify };
