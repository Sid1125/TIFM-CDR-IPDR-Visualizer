// ui/toast.js — transient toast notification. Extracted verbatim from app.js (step 9 of the
// frontend modularization). Pure DOM, no dependencies. No behavior change.

export function toast(msg){let t=document.getElementById('argusToast');if(!t){t=document.createElement('div');t.id='argusToast';t.className='argus-toast';document.body.appendChild(t);}t.textContent=msg;t.classList.add('show');clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),2200);}
