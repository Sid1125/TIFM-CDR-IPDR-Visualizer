// core/router.js — tab switching + render dispatch. Extracted from app.js (step 7 of the frontend
// modularization). switchTab dispatches through a registry so the router never imports feature code
// directly (features call registerTab as they move to their own modules; app.js registers them for
// now). Render-generation counters live on the shared store (state.render). No behavior change.

import { state } from './state.js';

// A tab is (re)rendered only when its recorded gen is stale vs the current case-load gen. Callers
// mark a tab rendered on SUCCESS (never pre-marked), so a failed render retries next time.
export function tabNeedsRender(tab){ return state.render.rendered[tab] !== state.render.gen; }
export function tabMarkRendered(tab){ state.render.rendered[tab] = state.render.gen; }

// Feature modules (or app.js, transitionally) register their tab's render function here.
const TAB_RENDERERS = Object.create(null);
export function registerTab(name, fn){ TAB_RENDERERS[name] = fn; }

export function switchTab(tab){
  state.tab=tab;
  document.querySelectorAll('.topbar-tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  document.querySelectorAll('.tab-content').forEach(s=>s.classList.toggle('active',s.id==='tab-'+tab));
  // Reflect the active tab onto its parent dropdown group, and close any open menus.
  document.querySelectorAll('.nav-group').forEach(g=>{g.classList.toggle('group-active',[...g.querySelectorAll('.topbar-tab')].some(b=>b.dataset.tab===tab));g.classList.remove('open');});
  document.querySelectorAll('.user-menu.open').forEach(m=>m.classList.remove('open'));
  const fn=TAB_RENDERERS[tab];
  if(fn) fn();
}
