// core/utils.js — pure, dependency-free formatting/escaping helpers used across the app.
// Extracted verbatim from app.js (step 1 of the frontend modularization). No behavior change.

export function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
export function fmt(v){if(!v)return'';try{return new Date(v).toLocaleString()}catch(e){return v}}
export function fmts(v){if(!v)return'';try{const d=new Date(v);return d.toLocaleDateString()+' '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}catch{return v}}
export function fmtd(v){if(!v)return'';try{return new Date(v).toLocaleDateString()}catch{return v}}
export function fmtBytes(b){if(!b||b<0)return'0B';if(b<1024)return b+'B';if(b<1048576)return(b/1024).toFixed(1)+'KB';if(b<1073741824)return(b/1048576).toFixed(1)+'MB';return(b/1073741824).toFixed(2)+'GB'}
export function colWidth(v){if(!v)return 120;if(v.includes(':'))return 280;if(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v)||/^\+?\d{7,15}$/.test(v))return 150;return 200}
export function n(v){return v!=null?Number(v).toLocaleString():'0'}
export function debounce(fn,ms=220){let t;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms);};}

export function renderMd(t){
  if(!t)return'';
  let s=esc(t);
  // code blocks
  s=s.replace(/```(\w*)\n?([\s\S]*?)```/g,'<pre><code>$2</code></pre>');
  // horizontal rules
  s=s.replace(/^---+$/gm,'<hr>');
  // blockquotes
  s=s.replace(/^&gt;\s?(.*)$/gm,'<blockquote>$1</blockquote>');
  // headings
  s=s.replace(/^######\s+(.*)$/gm,'<h6>$1</h6>');
  s=s.replace(/^#####\s+(.*)$/gm,'<h5>$1</h5>');
  s=s.replace(/^####\s+(.*)$/gm,'<h4>$1</h4>');
  s=s.replace(/^###\s+(.*)$/gm,'<h3>$1</h3>');
  s=s.replace(/^##\s+(.*)$/gm,'<h2>$1</h2>');
  s=s.replace(/^#\s+(.*)$/gm,'<h1>$1</h1>');
  // bold & italic
  s=s.replace(/\*\*\*(.+?)\*\*\*/g,'<strong><em>$1</em></strong>');
  s=s.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  s=s.replace(/\*(.+?)\*/g,'<em>$1</em>');
  // inline code
  s=s.replace(/`([^`]+)`/g,'<code>$1</code>');
  // links
  s=s.replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank">$1</a>');
  // tables (basic)
  s=s.replace(/^(\|.+\|)$/gm,function(m){return m.includes('---')?'':m.replace(/\|/g,'').trim()?'<tr><td>'+m.replace(/^\||\|$/g,'').split('|').map(c=>c.trim()).join('</td><td>')+'</td></tr>':''});
  s=s.replace(/<tr><td>.*?<\/td><\/tr>/g,function(m,i,t){const p=t.substring(0,i).lastIndexOf('<table>');const n=t.substring(i+3).indexOf('<tr');const prev=t.substring(0,i);const prevLine=prev.split('\n').pop();return prevLine.includes('<table>')||(p>=0&&n===0)?m:'<table>'+m+'</table>'});
  // bullet lists
  s=s.replace(/^\s*[-*]\s+(.*)$/gm,'<li>$1</li>');
  s=s.replace(/(<li>.*<\/li>)\n<li>/g,'$1\n<li>');
  s=s.replace(/(<li>[\s\S]*?<\/li>)/g,'<ul>$1</ul>');
  s=s.replace(/<\/ul>\n<ul>/g,'\n');
  // paragraphs
  s=s.replace(/\n\n/g,'</p><p>');
  s=s.replace(/^<p>|<\/p>$/g,'');
  s='<p>'+s+'</p>';
  // clean empty paragraphs
  s=s.replace(/<p>\s*<\/p>/g,'');
  // consolidate adjacent blockquotes
  s=s.replace(/<\/blockquote>\n<blockquote>/g,'\n');
  return s;
}
