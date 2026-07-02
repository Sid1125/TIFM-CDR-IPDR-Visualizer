// reference/telecom.js — offline telecom reference: number -> operator/circle (series prefix),
// ISD country (dial-code), and IMEI -> make/model (TAC). loadReference() fetches the lookup tables
// from /reference/meta into state.ref; the pure ref* helpers read state.ref. Extracted from app.js
// (reference layer). Depends only on core state + API. No behavior change.

import { state } from '../core/state.js';
import { API } from '../core/api.js';

export async function loadReference(){
  try{const m=await API.get('/reference/meta');state.ref={series:m.series||{},isd:m.isd||{},tac:m.tac||{},seed:m.series_seed};}
  catch(e){state.ref={series:{},isd:{},tac:{}};}
}
function _refDigits(v){return String(v==null?'':v).replace(/\D/g,'')}
function _refNational(v){
  let d=_refDigits(v);const hadPlus=String(v||'').startsWith('+')||d.startsWith('00');
  if(d.startsWith('00'))d=d.slice(2);
  if(d.startsWith('91')&&d.length>10)return{national:d.slice(-10),d,hadPlus};
  if(d.length===10&&'6789'.includes(d[0]))return{national:d,d,hadPlus};
  if(d.length===11&&d[0]==='0')return{national:d.slice(1),d,hadPlus};
  return{national:null,d,hadPlus};
}
export function refIsdCountry(v){
  const ref=state.ref||{};let d=_refDigits(v);if(d.startsWith('00'))d=d.slice(2);
  for(let ln=Math.min(4,d.length);ln>=1;ln--){const p=d.slice(0,ln);if(ref.isd&&ref.isd[p])return{code:p,country:ref.isd[p]};}
  return null;
}
export function refLookup(v){
  const ref=state.ref||{series:{},isd:{}};const {national,d,hadPlus}=_refNational(v);
  const out={national,is_isd:false,country:null,operator:null,circle:null};
  if(national){for(const ln of [5,4]){const p=national.slice(0,ln);if(ref.series&&ref.series[p]){out.operator=ref.series[p].operator;out.circle=ref.series[p].circle;break;}}return out;}
  const isd=refIsdCountry(hadPlus?v:d);
  if(isd&&isd.code!=='91'){out.is_isd=true;out.country=isd.country;}
  return out;
}
export function refOperator(v){return refLookup(v).operator||''}
export function refCircle(v){return refLookup(v).circle||''}
export function isIsdNum(v){return refLookup(v).is_isd}
export function refCountry(v){return refLookup(v).country||''}
export function refImei(v){const d=_refDigits(v).slice(0,8);const t=(state.ref&&state.ref.tac&&state.ref.tac[d])||null;return t?(t.make+' '+t.model):''}
