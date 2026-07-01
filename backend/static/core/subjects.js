// core/subjects.js — subject-identity display helpers shared across every feature: append the
// per-identity intel tag (state.subjectTags) wherever a number/IP is shown, and flag suspects
// (state.suspectSet). Depend only on the shared store + esc. Extracted from app.js (step 9 of the
// frontend modularization). No behavior change.

import { state } from './state.js';
import { esc } from './utils.js';

export function subjTag(sub){return (sub!=null&&state.subjectTags[sub])||''}
export function subjLabel(sub){const t=subjTag(sub);return esc(sub)+(t?' <span class="subj-tag">('+esc(t)+')</span>':'')}
export function subjLabelTxt(sub){const t=subjTag(sub);return String(sub)+(t?' ('+t+')':'')}
export function isSuspect(v){return !!(v!=null&&state.suspectSet&&state.suspectSet.has(String(v)));}
