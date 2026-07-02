// analytics/investigation.js — the Full Investigation Command Center: one click posts to
// /ai/investigate and renders the returned modules (findings, identity, anomalies, sessions, social
// network + hierarchy, location intelligence, call details + comms, temporal). Pure server-data
// rendering — no client analytics engines. Extracted from app.js (feature layer). showProfile in
// onclick strings resolves via the window bridge; the three interactive handlers
// (runFullInvestigation / toggleInvestModule / investToggleMore) are re-exposed on window (they moved
// out of the app.js bridge). No behavior change.

import { esc, n, fmts } from '../core/utils.js';
import { D } from '../core/dom.js';
import { state } from '../core/state.js';
import { API } from '../core/api.js';

function toggleInvestModule(headerEl){
  const mod=headerEl.parentElement;
  if(mod)mod.classList.toggle('open');
}
async function runFullInvestigation(){
  const statusEl=document.getElementById('investStatus');
  const summaryEl=document.getElementById('investSummary');
  const modulesEl=document.getElementById('investModules');
  if(!modulesEl)return;
  statusEl.textContent='Running full investigation...';
  modulesEl.style.display='none';
  summaryEl.style.display='none';
  try{
    const r=await API.post('/ai/investigate'+(state.data.caseId?'?case_id='+encodeURIComponent(state.data.caseId):''),{});
    const inv=r.investigation;
    if(!inv){statusEl.textContent='Empty response';return}
    
    // Summary cards
    const s=inv.summary;
    summaryEl.style.display='grid';
    summaryEl.innerHTML=
      '<div class="is-card"><span class="is-label">Records</span><span class="is-value">'+n(s.total_records_analyzed)+'</span></div>'+
      '<div class="is-card"><span class="is-label">CDR/IPDR</span><span class="is-value">'+n(s.cdr_count)+' / '+n(s.ipdr_count)+'</span></div>'+
      '<div class="is-card"><span class="is-label">Subjects</span><span class="is-value">'+n(s.total_subjects)+'</span></div>'+
      '<div class="is-card"><span class="is-label">Towers</span><span class="is-value">'+n(s.total_towers)+'</span></div>'+
      '<div class="is-card"><span class="is-label">Findings</span><span class="is-value '+(s.high_priority_findings>0?'is-warn':'is-success')+'">'+n(s.total_findings)+' <span style="font-size:0.7rem;font-weight:400">('+n(s.high_priority_findings)+' high)</span></span></div>'+
      '<div class="is-card"><span class="is-label">Date Range</span><span class="is-value" style="font-size:0.78rem">'+(s.date_range?.start?fmts(s.date_range.start):'N/A')+'</span></div>'+
      '<div class="is-card"><span class="is-label">Modules</span><span class="is-value">'+n(s.modules_executed)+'</span></div>';
    
    // Render modules
    modulesEl.style.display='flex';
    
    // Findings
    renderFindings(inv.findings);
    renderIdentity(inv.identity_analysis);
    renderAnomalies(inv.anomaly_detection);
    renderSessions(inv.sessions, inv.gap_analysis);
    renderNetwork(inv.social_network, inv.hierarchical_analysis);
    renderLocation(inv.location_intelligence);
    renderCallDetails(inv.call_detail_analysis, inv.communication_patterns);
    renderTemporal(inv.temporal_analysis);
    
    statusEl.textContent='Investigation complete. '+n(s.total_findings)+' findings generated.';
    statusEl.style.color='var(--success)';
  }catch(e){
    console.error('Investigation error:',e);
    statusEl.textContent='Error: '+e.message;
    statusEl.style.color='var(--danger)';
  }
}
function _badge(s,c){return '<span class="if-badge '+c+'">'+esc(s)+'</span>'}
function _sevBadge(s){return _badge(s,s.toLowerCase())}
function _showMoreBtn(id,count,label){
  return '<div class="invest-toggle-row"><button class="invest-toggle-btn" onclick="investToggleMore(\''+id+'\')">Show all '+count+' '+label+' \u25BC</button></div>'+
    '<div id="investMore_'+id+'" style="display:none"></div>';
}
function _investMoreHtml(id,items,fn){
  return '<div style="display:none" id="investMore_'+id+'">'+items.map(fn).join('')+'</div>';
}
var _investMoreData={};
function investToggleMore(id){
  const btn=event.target;
  const container=document.getElementById('investMore_'+id);
  if(!container)return;
  const showing=container.style.display!=='none';
  container.style.display=showing?'none':'block';
  btn.innerHTML=(showing?'Show all ':_investMoreData[id]?.count||'')+' '+(showing?_investMoreData[id]?.label||'':_investMoreData[id]?.label||'')+(showing?' \u25BC':' \u25B2');
  if(!showing && _investMoreData[id] && !container.children.length){
    container.innerHTML=_investMoreData[id].items.map(_investMoreData[id].fn).join('');
  }
}

function renderFindings(f){
  const body=document.getElementById('investFindingsBody');
  const cnt=document.getElementById('investFindingsCount');
  if(!body)return;
  const all=f?.findings||[];
  cnt.textContent=all.length;
  const bySev=f?.by_severity||{};
  const byCat=f?.by_category||{};
  
  // Severity badges row
  let html='<div class="inv-sev-row">'+
    ['Critical','High','Medium','Low'].map(s=>'<span class="inv-sev-badge '+s.toLowerCase()+'">'+s+': '+(bySev[s]||0)+'</span>').join('')+
  '</div>';
  
  // Category summary
  const cats=Object.entries(byCat).sort((a,b)=>b[1]-a[1]);
  if(cats.length){
    html+='<div class="inv-cat-row">'+cats.slice(0,6).map(([c,v])=>_badge(c+': '+v,'medium')).join(' ')+'</div>';
  }
  
  // Top 10 high-severity findings
  const high=all.filter(f=>f.severity==='Critical'||f.severity==='High');
  const top=high.slice(0,10);
  if(top.length){
    html+='<div class="inv-section-label">Top High-Severity Findings</div>';
    html+=top.map(f=>'<div class="invest-finding '+f.severity.toLowerCase()+'">'+
      '<div class="if-title">'+_sevBadge(f.severity)+' '+esc(f.title)+'</div>'+
      '<div class="if-detail">'+
        (f.subject?'<strong>'+esc(f.subject)+'</strong> &middot; ':'')+
        '<em>'+esc(f.category)+'</em> &middot; '+esc(f.detail)+
      '</div></div>').join('');
    if(high.length>10){
      _investMoreData['findings']={count:high.length-10,label:'more high-severity',items:high.slice(10),fn:f=>'<div class="invest-finding '+f.severity.toLowerCase()+'">'+
        '<div class="if-title">'+_sevBadge(f.severity)+' '+esc(f.title)+'</div>'+
        '<div class="if-detail">'+
          (f.subject?'<strong>'+esc(f.subject)+'</strong> &middot; ':'')+
          '<em>'+esc(f.category)+'</em> &middot; '+esc(f.detail)+
        '</div></div>'};
      html+=_showMoreBtn('findings',high.length-10,'more high-severity');
    }
  }
  
  // All findings count note
  if(all.length>10){
    html+='<div style="margin-top:6px;font-size:0.72rem;color:var(--muted);text-align:center">'+all.length+' total findings across '+(cats.length)+' categories. '+
      (f?.executive_summary?esc(f.executive_summary):'')+'</div>';
  }
  body.innerHTML=html||'<div class="invest-msg">No findings.</div>';
}

function renderIdentity(id){
  const body=document.getElementById('investIdentityBody');
  const cnt=document.getElementById('investIdentityCount');
  if(!body)return;
  const subs=id?.by_subject||{};
  const keys=Object.keys(subs);
  cnt.textContent=keys.length;
  const burners=Object.entries(subs).filter(([,d])=>d.is_suspected_burner);
  const swaps=Object.entries(subs).filter(([,d])=>d.sim_swaps?.length);
  const devices=Object.entries(subs).filter(([,d])=>d.device_changes?.length);
  const totalSimSwaps=id?.total_sim_swaps||0;
  const totalDeviceChanges=id?.total_device_changes||0;
  
  let html='<div class="inv-sev-row">'+
    '<span class="inv-sev-badge high">Burners: '+burners.length+'</span>'+
    '<span class="inv-sev-badge high">SIM Swaps: '+totalSimSwaps+'</span>'+
    '<span class="inv-sev-badge medium">Device Changes: '+totalDeviceChanges+'</span>'+
    '<span class="inv-sev-badge low">Analyzed: '+keys.length+'</span>'+
  '</div>';
  
  // Top 15 most suspicious subjects (sorted by burner score desc)
  const sorted=Object.entries(subs).sort((a,b)=>b[1].burner_score-a[1].burner_score);
  const top=sorted.slice(0,15);
  html+='<div class="inv-section-label">Most Suspicious Subjects</div>';
  html+=top.map(([sub,d])=>{
    const isBurner=d.is_suspected_burner;
    return '<div class="invest-finding '+(isBurner?'high':'low')+'">'+
      '<div class="if-title">'+
        _badge(isBurner?'BURNER':'Normal',isBurner?'high':'low')+' '+esc(sub)+
        ' <span class="if-detail" style="font-weight:400">Score: '+d.burner_score+'% | '+d.unique_imei+' IMEI | '+d.unique_imsi+' IMSI | '+d.total_transitions+' changes</span>'+
      '</div>'+
      (d.findings?.length?'<div class="if-detail">'+d.findings.slice(0,3).map(f=>'<span style="color:var(--warn)">&#9656; '+esc(f)+'</span><br>').join('')+'</div>':'')+
      (d.sim_swaps?.length?'<div class="if-detail" style="margin-top:2px"><strong style="color:var(--danger);font-size:0.7rem">SIM Swaps:</strong> '+d.sim_swaps.map(s=>'<span class="inv-tag inv-tag-danger">'+fmts(s.timestamp)+'</span>').join('')+'</div>':'')+
      (d.device_changes?.length?'<div class="if-detail" style="margin-top:2px"><strong style="color:var(--warn);font-size:0.7rem">Device Changes:</strong> '+d.device_changes.slice(0,3).map(s=>'<span class="inv-tag inv-tag-warn">'+fmts(s.timestamp)+'</span>').join('')+'</div>':'')+
    '</div>';
  }).join('');
  
  if(sorted.length>15){
    _investMoreData['identity']={count:sorted.length-15,label:'subjects',items:sorted.slice(15),fn:([sub,d])=>{
      const isBurner=d.is_suspected_burner;
      return '<div class="invest-finding '+(isBurner?'high':'low')+'">'+
        '<div class="if-title">'+
          _badge(isBurner?'BURNER':'Normal',isBurner?'high':'low')+' '+esc(sub)+
          ' <span class="if-detail" style="font-weight:400">Score: '+d.burner_score+'% | '+d.unique_imei+' IMEI | '+d.unique_imsi+' IMSI | '+d.total_transitions+' changes</span>'+
        '</div></div>';
    }};
    html+=_showMoreBtn('identity',sorted.length-15,'subjects');
  }
  body.innerHTML=html||'<div class="invest-msg">No identity data.</div>';
}

function renderAnomalies(an){
  const body=document.getElementById('investAnomalyBody');
  const cnt=document.getElementById('investAnomalyCount');
  if(!body)return;
  const list=an?.anomalies||[];
  cnt.textContent=list.length;
  
  let html='<div class="inv-sev-row">'+
    '<span class="inv-sev-badge high">High: '+(an?.high_severity_count||0)+'</span>'+
    '<span class="inv-sev-badge medium">Medium: '+(an?.medium_severity_count||0)+'</span>'+
    '<span class="inv-sev-badge low">Total: '+list.length+'</span>'+
  '</div>';
  
  // Group by type
  const grouped={};
  list.forEach(a=>{if(!grouped[a.type])grouped[a.type]=[];grouped[a.type].push(a);});
  
  Object.entries(grouped).forEach(([type,items],idx)=>{
    const highCount=items.filter(a=>a.severity==='High').length;
    html+='<div class="inv-section-label">'+esc(type)+' <span class="if-detail">('+items.length+' total'+(highCount?', '+highCount+' high':'')+')</span></div>';
    const show=items.slice(0,8);
    html+=show.map(a=>'<div class="invest-anom '+a.severity.toLowerCase()+'">'+
      '<span class="anom-subj">'+esc(a.subject)+'</span> '+
      '<span class="anom-detail">'+esc(a.detail)+'</span>'+
    '</div>').join('');
    if(items.length>8){
      _investMoreData['anom_'+idx]={count:items.length-8,label:'anomalies',items:items.slice(8),fn:a=>'<div class="invest-anom '+a.severity.toLowerCase()+'">'+
        '<span class="anom-subj">'+esc(a.subject)+'</span> <span class="anom-detail">'+esc(a.detail)+'</span></div>'};
      html+=_showMoreBtn('anom_'+idx,items.length-8,'anomalies');
    }
  });
  body.innerHTML=html||'<div class="invest-msg">No anomalies detected.</div>';
}

function renderSessions(sess, gap){
  const body=document.getElementById('investSessionsBody');
  const cnt=document.getElementById('investSessionsCount');
  if(!body)return;
  const subs=sess?.by_subject||{};
  const keys=Object.keys(subs);
  cnt.textContent=keys.length;
  const gapsBySubject=gap?.by_subject||{};
  
  if(!keys.length){body.innerHTML='<div class="invest-msg">No session data.</div>';return;}
  
  // Aggregate stats
  let totalSessions=0,totalGaps24h=0,subsWithGaps24h=0;
  keys.forEach(k=>{
    totalSessions+=subs[k].total_sessions;
    if(subs[k].gaps_above_24h>0)subsWithGaps24h++;
    totalGaps24h+=subs[k].gaps_above_24h||0;
  });
  
  let html='<div class="inv-sev-row">'+
    '<span class="inv-sev-badge low">Subjects: '+keys.length+'</span>'+
    '<span class="inv-sev-badge low">Sessions: '+totalSessions+'</span>'+
    '<span class="inv-sev-badge '+(totalGaps24h>0?'warn':'low')+'">Gaps >24h: '+totalGaps24h+'</span>'+
    '<span class="inv-sev-badge '+(subsWithGaps24h>0?'warn':'low')+'">Affected Subjects: '+subsWithGaps24h+'</span>'+
  '</div>';
  
  // Top subjects by gaps >24h
  const sorted=keys.filter(k=>subs[k].gaps_above_24h>0).sort((a,b)=>subs[b].gaps_above_24h-subs[a].gaps_above_24h);
  if(sorted.length){
    html+='<div class="inv-section-label">Subjects with Notable Gaps (sorted by gaps >24h)</div>';
    html+='<table class="inv-compact-table"><tr><th>Subject</th><th>Sessions</th><th>Avg Gap</th><th>Gaps &gt;24h</th><th>Max Gap</th></tr>';
    const show=sorted.slice(0,15);
    show.forEach(k=>{
      const s=subs[k];
      html+='<tr'+(s.gaps_above_24h>3?' class="inv-row-warn"':'')+'>'+
        '<td><strong>'+esc(k)+'</strong></td>'+
        '<td>'+n(s.total_sessions)+'</td>'+
        '<td>'+(s.avg_gap_between_sessions_minutes?Math.round(s.avg_gap_between_sessions_minutes)+'m':'—')+'</td>'+
        '<td>'+(s.gaps_above_24h||0)+'</td>'+
        '<td>'+(s.max_gap_minutes?Math.round(s.max_gap_minutes/60)+'h':'—')+'</td></tr>';
    });
    html+='</table>';
    if(sorted.length>15){
      _investMoreData['sessions']={count:sorted.length-15,label:'subjects',items:sorted.slice(15),fn:k=>{
        const s=subs[k];
        return '<tr'+(s.gaps_above_24h>3?' class="inv-row-warn"':'')+'>'+
          '<td><strong>'+esc(k)+'</strong></td>'+
          '<td>'+n(s.total_sessions)+'</td>'+
          '<td>'+(s.avg_gap_between_sessions_minutes?Math.round(s.avg_gap_between_sessions_minutes)+'m':'—')+'</td>'+
          '<td>'+(s.gaps_above_24h||0)+'</td>'+
          '<td>'+(s.max_gap_minutes?Math.round(s.max_gap_minutes/60)+'h':'—')+'</td></tr>';
      }};
      html+=_showMoreBtn('sessions',sorted.length-15,'subjects');
    }
  }
  
  if(gap?.subjects_with_gaps){
    html+='<div style="margin-top:6px;font-size:0.72rem;color:var(--muted)">'+n(gap.subjects_with_gaps)+' subject(s) with network gaps detected.'+(gap.global_finding?.length?' '+esc(gap.global_finding.join(' ')):'')+'</div>';
  }
  body.innerHTML=html;
}

function renderNetwork(net, hier){
  const body=document.getElementById('investNetworkBody');
  const cnt=document.getElementById('investNetworkCount');
  if(!body)return;
  cnt.textContent=net?.nodes||0;
  
  if(!net?.nodes){body.innerHTML='<div class="invest-msg">No network data.</div>';return;}
  
  // Role distribution
  const roles=net.structural_roles||{};
  const roleCounts={};
  Object.values(roles).forEach(r=>{roleCounts[r.inferred_role]=(roleCounts[r.inferred_role]||0)+1;});
  
  let html='<div class="inv-sev-row">'+
    '<span class="inv-sev-badge low">Nodes: '+n(net.nodes)+'</span>'+
    '<span class="inv-sev-badge low">Edges: '+n(net.edges)+'</span>'+
    '<span class="inv-sev-badge low">Density: '+net.density+'</span>'+
    '<span class="inv-sev-badge low">Reciprocity: '+net.reciprocity+'</span>'+
    '<span class="inv-sev-badge '+(net.total_bridges>0?'warn':'low')+'">Bridges: '+n(net.total_bridges)+'</span>'+
  '</div>';
  
  // Role distribution
  html+='<div class="inv-role-dist">'+Object.entries(roleCounts).map(([role,count])=>{
    const cls=role.includes('Broker')||role.includes('Hub')?'warn':role.includes('Core')?'medium':'low';
    return _badge(role+': '+count,cls);
  }).join(' ')+'</div>';
  
  // Centrality table (top 15)
  html+='<div class="inv-section-label">Top Nodes by Degree Centrality</div>';
  html+='<table class="inv-compact-table"><tr><th>Node</th><th>Role</th><th>Degree</th><th>Betweenness</th><th>k-Core</th></tr>';
  const sorted=Object.entries(roles).sort((a,b)=>b[1].degree_centrality-a[1].degree_centrality);
  sorted.slice(0,15).forEach(([node,r])=>{
    const cls=r.inferred_role.includes('Broker')||r.inferred_role.includes('Hub')?'inv-row-warn':'';
    html+='<tr class="'+cls+'"><td><strong>'+esc(node)+'</strong></td><td>'+r.inferred_role+'</td><td>'+r.degree_centrality+'</td><td>'+r.betweenness_centrality+'</td><td>'+r.k_core+'</td></tr>';
  });
  html+='</table>';
  
  // Critical bridges as compact cards
  if(net.critical_bridges?.length){
    html+='<div class="inv-section-label">Critical Bridges ('+net.critical_bridges.length+')</div>';
    html+='<div class="inv-bridge-row">';
    net.critical_bridges.slice(0,5).forEach(b=>{
      html+='<div class="inv-bridge-card"><strong>'+esc(b.from)+'</strong> &#8596; <strong>'+esc(b.to)+'</strong><br><span class="if-detail">'+n(b.weight)+' interactions</span></div>';
    });
    html+='</div>';
  }
  
  // Hierarchy summary
  if(hier?.command_chain_summary){
    html+='<div class="inv-section-label">Organization</div>';
    html+='<div style="font-size:0.78rem;padding:4px 0">'+esc(hier.command_chain_summary);
    if(hier.checkin_patterns?.length){
      html+='<br><span class="if-detail">'+hier.checkin_patterns.length+' check-in patterns detected</span>';
    }
    html+='</div>';
  }
  body.innerHTML=html;
}

function renderLocation(loc){
  const body=document.getElementById('investLocationBody');
  const cnt=document.getElementById('investLocationCount');
  if(!body)return;
  const subs=loc?.by_subject||{};
  const keys=Object.keys(subs);
  cnt.textContent=keys.length;
  const hotspots=loc?.geo_hotspots||[];
  
  if(!keys.length){body.innerHTML='<div class="invest-msg">No location data.</div>';return;}
  
  let html='<div class="inv-sev-row">'+
    '<span class="inv-sev-badge low">Subjects: '+keys.length+'</span>'+
    '<span class="inv-sev-badge low">Hotspots: '+hotspots.length+'</span>'+
  '</div>';
  
  // Hotspots table
  if(hotspots.length){
    html+='<div class="inv-section-label">Top Activity Hotspots</div>';
    html+='<table class="inv-compact-table"><tr><th>Tower</th><th>Visits</th><th>Subjects</th></tr>';
    hotspots.slice(0,10).forEach(h=>{
      html+='<tr><td><strong>'+esc(h.tower_id)+'</strong></td><td>'+n(h.total_visits)+'</td><td>'+n(h.unique_subjects)+'</td></tr>';
    });
    html+='</table>';
  }
  
  // Subjects with widest range
  const withRadius=Object.entries(subs).filter(([,d])=>d.radius_of_operation_km).sort((a,b)=>b[1].radius_of_operation_km-a[1].radius_of_operation_km);
  if(withRadius.length){
    html+='<div class="inv-section-label">Widest Operational Range</div>';
    withRadius.slice(0,10).forEach(([sub,d])=>{
      html+='<div class="invest-finding low"><div class="if-title">'+esc(sub)+'</div><div class="if-detail">'+
        d.radius_of_operation_km+'km radius &middot; '+d.total_locations+' towers &middot; Entropy: '+d.location_entropy+' ('+d.location_predictability+')'+
      '</div></div>';
    });
  }
  body.innerHTML=html;
}

function renderCallDetails(call, comm){
  const body=document.getElementById('investCallBody');
  const cnt=document.getElementById('investCallCount');
  if(!body)return;
  const subs=call?.by_subject||{};
  const keys=Object.keys(subs);
  cnt.textContent=keys.length;
  const circles=comm?.calling_circles||[];
  
  if(!keys.length){body.innerHTML='<div class="invest-msg">No call data.</div>';return;}
  
  // Aggregate suspicious counts
  let shortCalls=0, oddCalls=0, bursts=0;
  Object.values(subs).forEach(d=>{shortCalls+=d.short_signal_calls||0; oddCalls+=d.odd_hour_calls||0; bursts+=d.call_bursts||0;});
  
  let html='<div class="inv-sev-row">'+
    '<span class="inv-sev-badge low">Pairs: '+n(comm?.total_pairs_analyzed||0)+'</span>'+
    '<span class="inv-sev-badge '+(shortCalls>0?'warn':'low')+'">Signal Calls: '+shortCalls+'</span>'+
    '<span class="inv-sev-badge '+(oddCalls>0?'warn':'low')+'">Odd-Hour: '+oddCalls+'</span>'+
    '<span class="inv-sev-badge '+(bursts>0?'warn':'low')+'">Bursts: '+bursts+'</span>'+
    '<span class="inv-sev-badge low">Circles: '+circles.length+'</span>'+
  '</div>';
  
  // Calling circles
  if(circles.length){
    html+='<div class="inv-section-label">Calling Circles (3-way mutual communication)</div>';
    html+='<div class="inv-circle-row">';
    circles.slice(0,10).forEach(c=>{
      html+='<div class="inv-circle-card">'+
        c.members.map(m=>esc(m)).join(' &#8644; ')+
        '<br><span class="if-detail">'+n(c.total_calls_between)+' calls</span></div>';
    });
    html+='</div>';
  }
  
  // Top suspicious subjects
  const suspicious=Object.entries(subs).filter(([,d])=>d.short_signal_calls>0||d.odd_hour_calls>0||d.call_bursts>0)
    .sort((a,b)=>(b.short_signal_calls+b.odd_hour_calls+b.call_bursts)-(a.short_signal_calls+a.odd_hour_calls+a.call_bursts));
  if(suspicious.length){
    html+='<div class="inv-section-label">Suspicious Calling Patterns</div>';
    suspicious.slice(0,12).forEach(([sub,d])=>{
      const cp=comm?.by_subject?.[sub]||{};
      html+='<div class="invest-anom high">'+
        '<span class="anom-subj">'+esc(sub)+'</span> '+
        '<span class="anom-detail">In:'+n(cp.incoming||0)+' Out:'+n(cp.outgoing||0)+' Avg:'+(cp.avg_duration_seconds?Math.round(cp.avg_duration_seconds)+'s':'—')+'</span>'+
        (d.short_signal_calls?' <span class="inv-tag inv-tag-warn">'+d.short_signal_calls+' short</span>':'')+
        (d.odd_hour_calls?' <span class="inv-tag inv-tag-warn">'+d.odd_hour_calls+' odd-hr</span>':'')+
        (d.call_bursts?' <span class="inv-tag inv-tag-danger">'+d.call_bursts+' bursts</span>':'')+
      '</div>';
    });
  }
  body.innerHTML=html;
}

function renderTemporal(temp){
  const body=document.getElementById('investTemporalBody');
  const cnt=document.getElementById('investTemporalCount');
  if(!body)return;
  const profiles=temp?.subject_profiles||{};
  const pkeys=Object.keys(profiles);
  cnt.textContent=pkeys.length;
  
  if(!temp?.total_records){body.innerHTML='<div class="invest-msg">No temporal data.</div>';return;}
  
  const dr=temp.date_range||{};
  let html='<div class="inv-sev-row">'+
    '<span class="inv-sev-badge low">Records: '+n(temp.total_records)+'</span>'+
    '<span class="inv-sev-badge low">Span: '+(dr.span_days?n(dr.span_days)+'d':'—')+'</span>'+
    '<span class="inv-sev-badge '+(temp.night_activity_ratio>0.3?'warn':'low')+'">Night: '+Math.round((temp.night_activity_ratio||0)*100)+'%</span>'+
    '<span class="inv-sev-badge '+(temp.activity_trend==='increasing'?'warn':temp.activity_trend==='decreasing'?'success':'low')+'">Trend: '+temp.activity_trend+'</span>'+
    '<span class="inv-sev-badge low">Peak: '+(temp.most_active_hour!=null?temp.most_active_hour+':00':'—')+'</span>'+
  '</div>';
  
  // Day-of-week
  if(temp.day_of_week){
    html+='<div class="inv-section-label">Activity by Day</div><div class="inv-dow-row">';
    Object.entries(temp.day_of_week).forEach(([d,c])=>{
      const pct=Math.round(c/temp.total_records*100);
      html+='<span class="inv-dow-badge">'+d.substring(0,3)+': '+n(c)+' ('+pct+'%)</span>';
    });
    html+='</div>';
  }
  
  // Night owls
  const nightOwls=Object.entries(profiles).filter(([,p])=>p.is_night_owl).sort((a,b)=>b[1].night_activity_pct-a[1].night_activity_pct);
  if(nightOwls.length){
    html+='<div class="inv-section-label">Night-Dominant Subjects ('+nightOwls.length+')</div>';
    nightOwls.slice(0,15).forEach(([sub,p])=>{
      html+='<div class="invest-anom warn"><span class="anom-subj">'+esc(sub)+'</span> <span class="anom-detail">'+p.night_activity_pct+'% night &middot; Profile: '+p.profile+' &middot; Peak: '+(p.peak_hour>=0?p.peak_hour+':00':'—')+'</span></div>';
    });
    if(nightOwls.length>15){
      _investMoreData['temporal']={count:nightOwls.length-15,label:'night-dominant subjects',items:nightOwls.slice(15),fn:([sub,p])=>
        '<div class="invest-anom warn"><span class="anom-subj">'+esc(sub)+'</span> <span class="anom-detail">'+p.night_activity_pct+'% night &middot; Profile: '+p.profile+'</span></div>'
      };
      html+=_showMoreBtn('temporal',nightOwls.length-15,'night-dominant subjects');
    }
  }
  body.innerHTML=html;
}

// These three are referenced from inline onclick handlers (the Investigation panel HTML); re-expose
// them on window (they moved out of the app.js bridge).
Object.assign(window,{runFullInvestigation,toggleInvestModule,investToggleMore});
