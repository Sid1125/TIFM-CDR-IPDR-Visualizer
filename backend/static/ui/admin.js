// ui/admin.js — the Admin tab: user management (list / create / edit / reset-password / delete via
// /auth/admin), the audit log viewer (/audit/log), and a small modal helper. Also exports auditView,
// the fire-and-forget chain-of-custody beacon that other views call on case-open / subject-view.
// Extracted from app.js (feature layer). Depends only on core DOM + API + esc. Self-registers with
// the router. No behavior change.

import { esc } from '../core/utils.js';
import { D } from '../core/dom.js';
import { API } from '../core/api.js';
import { registerTab } from '../core/router.js';

function renderAdmin(){
  const tbody=D.adminBody;const empty=D.adminEmpty;const table=D.adminTable;
  tbody.innerHTML='<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--muted)">Loading...</td></tr>';
  API.get('/auth/admin/users').then(data=>{
    const users=data.users;
    if(!users.length){table.style.display='none';empty.style.display='block';return}
    table.style.display='';empty.style.display='none';
    tbody.innerHTML=users.map(u=>{
      const d=u.created_at?new Date(u.created_at).toLocaleString():'-';
      const l=u.last_login_at?new Date(u.last_login_at).toLocaleString():'-';
      return `<tr>
        <td>${u.id}</td>
        <td>${esc(u.username)}</td>
        <td>${esc(u.role)}</td>
        <td>${u.is_active?'Yes':'No'}</td>
        <td>${d}</td>
        <td>${l}</td>
        <td><div class="admin-actions">
          <button data-id="${u.id}" data-username="${esc(u.username)}" data-role="${esc(u.role)}" data-active="${u.is_active}" class="admin-edit">Edit</button>
          <button data-id="${u.id}" data-username="${esc(u.username)}" class="admin-reset-pw">Reset PW</button>
          <button data-id="${u.id}" data-username="${esc(u.username)}" class="admin-delete btn-danger">Delete</button>
        </div></td>
      </tr>`
    }).join('');
  }).catch(e=>{tbody.innerHTML='<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--danger)">Failed to load users.</td></tr>';console.error(e)});
  renderAuditLog();
}

function renderAuditLog(){
  const tbody=D.auditBody;const table=D.auditTable;const empty=D.auditEmpty;
  if(!tbody)return;
  tbody.innerHTML='<tr><td colspan="8" style="text-align:center;padding:16px;color:var(--muted)">Loading...</td></tr>';
  const p=new URLSearchParams();
  const u=(D.auditFilterUser.value||'').trim();if(u)p.set('username',u);
  const a=D.auditFilterAction.value;if(a)p.set('action',a);
  const f=D.auditFilterFrom.value;if(f)p.set('date_from',f);
  p.set('limit','500');
  API.get('/audit/log?'+p.toString()).then(rows=>{
    if(!rows.length){table.style.display='none';empty.style.display='block';return}
    table.style.display='';empty.style.display='none';
    tbody.innerHTML=rows.map(r=>{
      const t=r.ts?new Date(r.ts).toLocaleString():'-';
      const det=r.detail&&Object.keys(r.detail).length?esc(JSON.stringify(r.detail)):'';
      const caseTxt=r.case_name?esc(r.case_name):(r.case_id?esc(r.case_id):'-');
      return `<tr>
        <td style="white-space:nowrap">${t}</td>
        <td>${esc(r.username||'-')}</td>
        <td>${esc(r.role||'-')}</td>
        <td>${esc(r.ip_address||'-')}</td>
        <td><span class="audit-act audit-${esc(r.action)}">${esc(r.action)}</span></td>
        <td>${caseTxt}</td>
        <td>${esc(r.target||'-')}</td>
        <td style="color:var(--muted);font-size:.8rem;max-width:240px;overflow:hidden;text-overflow:ellipsis">${det}</td>
      </tr>`
    }).join('');
  }).catch(e=>{tbody.innerHTML='<tr><td colspan="8" style="text-align:center;padding:16px;color:var(--danger)">Failed to load audit log.</td></tr>';console.error(e)});
}

// Fire-and-forget chain-of-custody beacon for reads (case open / subject view). Debounced so
// repeated renders of the same target don't spam rows.
let _lastBeacon='';
export function auditView(action,opts){
  try{
    opts=opts||{};
    const key=action+'|'+(opts.case_id||'')+'|'+(opts.target||'');
    if(key===_lastBeacon)return; _lastBeacon=key;
    API.post('/audit/view',{action:action,case_id:opts.case_id!=null?String(opts.case_id):null,case_name:opts.case_name||null,target:opts.target!=null?String(opts.target):null}).catch(()=>{});
  }catch(e){}
}

// ---- Admin Modal ----
function showAdminModal(title,fields,onSubmit){
  let m=document.getElementById('adminModal');
  if(!m){
    m=document.createElement('div');m.id='adminModal';m.className='modal-overlay';
    m.style.cssText='position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.55);z-index:999;display:flex;align-items:center;justify-content:center';
    const box=document.createElement('div');box.className='modal';box.style.cssText='background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:24px;max-width:420px;width:90%;max-height:80vh;overflow:auto;box-shadow:0 8px 32px rgba(0,0,0,0.3)';
    box.innerHTML='<div id="adminModalHead" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px"><h3 id="adminModalTitle" style="margin:0"></h3><button id="adminModalClose" class="btn-sm" style="font-size:1.2rem;background:none;border:none;cursor:pointer;color:var(--fg)">&times;</button></div><div id="adminModalBody"></div>';
    m.appendChild(box);document.body.appendChild(m);
    m.addEventListener('click',e=>{if(e.target===m)hideAdminModal()});
    m.querySelector('#adminModalClose').addEventListener('click',hideAdminModal);
  }
  const formId='adminModalForm_'+(title.replace(/\s/g,''));
  let body=m.querySelector('#adminModalBody');
  m.querySelector('#adminModalTitle').textContent=title;
  body.innerHTML='<form id="'+formId+'">'+fields.map(f=>{
    let inpts=f.type==='select'
      ? '<select name="'+f.name+'" id="af_'+f.name+'" style="width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--fg);font-size:0.85rem;margin-bottom:10px">'+f.options.map(o=>'<option value="'+o.value+'"'+(f.val===o.value?' selected':'')+'>'+o.label+'</option>').join('')+'</select>'
      : '<input name="'+f.name+'" id="af_'+f.name+'" type="'+f.type+'" value="'+(f.val||'')+'" placeholder="'+f.label+'" style="width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--fg);font-size:0.85rem;margin-bottom:10px;box-sizing:border-box"/>';
    return '<label style="font-size:0.78rem;color:var(--muted);display:block;margin-bottom:4px">'+f.label+'<br>'+inpts+'</label>';
  }).join('')+'<button type="submit" style="padding:8px 16px;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:0.85rem">Save</button></form>';
  m.style.display='flex';
  document.getElementById(formId).addEventListener('submit',async e=>{
    e.preventDefault();const btn=e.target.querySelector('button[type="submit"]');btn.disabled=true;btn.textContent='Saving...';
    try{await onSubmit(e);hideAdminModal()}catch(err){btn.disabled=false;btn.textContent='Save';alert('Error: '+err.message)}
  });
}

function hideAdminModal(){
  const m=document.getElementById('adminModal');if(m)m.style.display='none';
}

// ---- Admin Event Delegation ----
document.addEventListener('click',e=>{
  const t=e.target;
  if(t.classList.contains('admin-edit')){
    const id=parseInt(t.dataset.id),uname=t.dataset.username,role=t.dataset.role,active=t.dataset.active==='true';
    showAdminModal('Edit User',[
      {name:'username',label:'Username',type:'text',val:uname},
      {name:'role',label:'Role',type:'select',val:role,options:[{value:'investigator',label:'Investigator'},{value:'admin',label:'Admin'}]},
      {name:'is_active',label:'Active',type:'select',val:active?'true':'false',options:[{value:'true',label:'Yes'},{value:'false',label:'No'}]}
    ],async f=>{
      const fd=new FormData(f.target);
      await API.put('/auth/admin/users/'+id,{
        username:fd.get('username'),
        role:fd.get('role'),
        is_active:fd.get('is_active')==='true'
      });
      renderAdmin();
    });
  }
  if(t.classList.contains('admin-reset-pw')){
    const id=parseInt(t.dataset.id),uname=t.dataset.username;
    showAdminModal('Reset Password for '+uname,[
      {name:'new_password',label:'New Password (8+ chars)',type:'password',val:''}
    ],async f=>{
      const fd=new FormData(f.target);
      await API.put('/auth/admin/users/'+id+'/password',{new_password:fd.get('new_password')});
      renderAdmin();
    });
  }
  if(t.classList.contains('admin-delete')){
    const id=parseInt(t.dataset.id),uname=t.dataset.username;
    if(!confirm('Delete user "'+uname+'"?'))return;
    API.del('/auth/admin/users/'+id).then(renderAdmin).catch(err=>alert('Delete failed: '+err.message));
  }
});
D.adminCreateBtn.addEventListener('click',()=>{
  showAdminModal('Create User',[
    {name:'username',label:'Username',type:'text',val:''},
    {name:'password',label:'Password (8+ chars)',type:'password',val:''},
    {name:'role',label:'Role',type:'select',val:'investigator',options:[{value:'investigator',label:'Investigator'},{value:'admin',label:'Admin'}]}
  ],async f=>{
    const fd=new FormData(f.target);
    await API.post('/auth/admin/users',{
      username:fd.get('username'),
      password:fd.get('password'),
      role:fd.get('role')
    });
    renderAdmin();
  });
});

if(D.auditRefreshBtn)D.auditRefreshBtn.addEventListener('click',renderAuditLog);
if(D.auditFilterAction)D.auditFilterAction.addEventListener('change',renderAuditLog);

// This tab owns its rendering; register with the router.
registerTab('admin', renderAdmin);
