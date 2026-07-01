// core/auth.js — authentication, session rendering, AFK/idle management, and the health-check ping.
// Extracted from app.js (step 8 of the frontend modularization). checkAuth/login run the app-level
// bootstrap on success via an injected callback (onAuthenticated), so this module never imports
// bootstrap/feature code directly. No behavior change.

import { state } from './state.js';
import { D } from './dom.js';
import { API } from './api.js';

let idleTimer=null,idleWarnTimer=null,idleWarnTimer2=null,healthTimer=null;
const AFK_MS=10*60*1000,IDLE_MS=2*60*1000,WARN_MS=60*1000,HEALTH_MS=5*60*1000;

let _onAuthenticated=()=>{};
// app.js injects bootstrap here; runs after a successful auth (session check or login).
export function onAuthenticated(fn){ _onAuthenticated=fn; }

export async function checkAuth(){
  try{const me=await API.get('/auth/me');state.auth.user=me.user;state.auth.session=me.session;state.auth.status='authenticated';renderAuth();_onAuthenticated()}catch(e){state.auth.status='anonymous';renderAuth()}
}

export function renderAuth(){
  const ok=state.auth.status==='authenticated';
  D.shell.style.display=ok?'block':'none';D.auth.style.display=ok?'none':'flex';
  D.sessionUser.textContent=ok?state.auth.user.username+` (${state.auth.user.role})`:'Signed out';
  {const av=document.getElementById('userAvatar');if(av)av.textContent=ok&&state.auth.user.username?state.auth.user.username[0]:'?';}
  D.adminTabBtn.style.display=ok&&state.auth.user.role==='admin'?'':'none';
  if(ok){resetIdle();D.sessionStatus.style.display=''}else{D.sessionStatus.style.display='none';idleTimer&&clearTimeout(idleTimer);idleWarnTimer&&clearTimeout(idleWarnTimer);healthTimer&&clearInterval(healthTimer)}
}

export function resetIdle(){
  if(state.auth.status!=='authenticated')return;
  if(idleTimer)clearTimeout(idleTimer);
  if(idleWarnTimer)clearTimeout(idleWarnTimer);
  if(idleWarnTimer2)clearTimeout(idleWarnTimer2);
  D.sessionStatus.textContent='Active';D.sessionStatus.className='sess-active';
  idleWarnTimer=setTimeout(()=>{if(state.auth.status==='authenticated'){D.sessionStatus.textContent='Idle';D.sessionStatus.className='sess-idle'}},IDLE_MS);
  idleWarnTimer2=setTimeout(()=>{if(state.auth.status==='authenticated'){D.sessionStatus.textContent='Expiring soon';D.sessionStatus.className='sess-warn'}},AFK_MS-WARN_MS);
  idleTimer=setTimeout(doLogout,AFK_MS);
}

export async function doLogout(){
  idleTimer&&clearTimeout(idleTimer);idleWarnTimer&&clearTimeout(idleWarnTimer);idleWarnTimer2&&clearTimeout(idleWarnTimer2);healthTimer&&clearInterval(healthTimer);
  D.sessionStatus.textContent='Expired';D.sessionStatus.className='sess-expired';
  try{await fetch('/auth/logout',{method:'POST',credentials:'same-origin'})}catch(e){}
  state.auth={status:'anonymous',user:null,session:null};renderAuth();
}

// Periodic session ping; logs out if the session died. Called by bootstrap after a successful load.
export function startHealthCheck(){
  healthTimer=setInterval(async()=>{try{await API.get('/auth/me')}catch(e){doLogout()}},HEALTH_MS);
}

// Wire the auth-related DOM listeners once at startup (login form, logout button, idle activity).
export function initAuth(){
  D.loginForm.addEventListener('submit',async e=>{e.preventDefault();try{const r=await API.post('/auth/login',{username:D.loginUser.value.trim(),password:D.loginPass.value});state.auth.user=r.user;state.auth.session=r.session;state.auth.status='authenticated';renderAuth();_onAuthenticated()}catch(err){D.loginStatus.textContent='Invalid credentials'}});
  D.logoutBtn.addEventListener('click',async()=>{await doLogout()});
  ['mousemove','mousedown','click','keydown','scroll','touchstart','touchmove','wheel'].forEach(e=>document.addEventListener(e,resetIdle,{passive:true}));
}
