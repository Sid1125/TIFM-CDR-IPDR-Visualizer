// data/records.js — raw DB record -> client record-shape normalizers (nCdr/nIpdr), plus two small
// cell helpers used when rendering record rows: portSvc (port -> service name) and twr (tower link).
// Extracted verbatim from app.js (data layer, bottom-up modularization). Depend only on core
// constants/utils; twr's onclick=showTower resolves via the window bridge. No behavior change.

import { PORT_SVC } from '../core/constants.js';
import { esc } from '../core/utils.js';

export function nCdr(r){
  const s=r.a_party_number||'',c=r.b_party_number||'';
  return{type:'CDR',id:'c'+r.id,ts:r.start_time,tsMs:r.start_time?Date.parse(r.start_time):0,sub:s,cnt:c,tow:r.tower_id||'',dur:r.duration_seconds,svc:s?'Voice':'Unknown',raw:r,
    msisdn:r.msisdn,imsi:r.imsi,imei:r.imei,lat:r.latitude,lng:r.longitude,
    cll:r.call_type,dir:r.direction,cell:r.cell_id,tec:r.technology,end:r.end_time,
    case_id:r.case_id,lac:r.lac};
}
export function nIpdr(r){
  const s=r.source_ip||'',c=r.destination_ip||'';
  return{type:'IPDR',id:'i'+r.id,ts:r.start_time,tsMs:r.start_time?Date.parse(r.start_time):0,sub:s,cnt:c,tow:r.tower_id||'',dur:r.duration_seconds,svc:r.protocol||'Unknown',raw:r,
    msisdn:r.msisdn,imsi:r.imsi,imei:r.imei,lat:r.latitude,lng:r.longitude,
    bytesUp:r.bytes_uploaded,bytesDn:r.bytes_downloaded,sport:r.source_port,dport:r.destination_port,prot:r.protocol,apn:r.apn,rat:r.rat,end:r.end_time,
    case_id:r.case_id,lac:r.lac,cell:r.cell_id};
}
export function portSvc(p){return p?PORT_SVC[parseInt(p)]||'':''}
export function twr(id){
  if(id==null||id==='')return '';
  const s=esc(String(id));
  return '<span class="twr-link" data-tower="'+s+'" onclick="event.stopPropagation();showTower(this.dataset.tower)" title="Show tower '+s+' on map">'+s+'</span>';
}
