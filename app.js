(function(){
'use strict';

/* -- Navbar & Scroll Progress -- */
let lastScroll=0;
const navbar=document.getElementById('navbar');
const progress=document.getElementById('scroll-progress');
window.addEventListener('scroll',()=>{
 const y=window.scrollY;
 if(y>80&&y>lastScroll)navbar.classList.add('hidden');
 else navbar.classList.remove('hidden');
 lastScroll=y;

 const winScroll = document.documentElement.scrollTop || document.body.scrollTop;
 const height = document.documentElement.scrollHeight - document.documentElement.clientHeight;
 const scrolled = height > 0 ? (winScroll / height) * 100 : 0;
 if(progress) progress.style.width = scrolled + '%';
},{passive:true});

/* -- Mobile menu -- */
document.getElementById('menu-toggle').addEventListener('click',()=>{
 document.querySelector('.nav-links').classList.toggle('open');
});
document.querySelectorAll('.nav-links a').forEach(a=>{
 a.addEventListener('click',()=>{
 document.querySelector('.nav-links').classList.remove('open');
 });
});

/* -- Scroll reveal (feature cards, workflow steps, architecture cards) -- */
const observer=new IntersectionObserver(entries=>{
 entries.forEach(entry=>{
 if(!entry.isIntersecting)return;
 const el=entry.target;
 // Stagger by explicit data-delay, else by position among visible siblings.
 let d=parseFloat(el.dataset.delay);
 if(isNaN(d)){
 const sibs=[...el.parentElement.children].filter(c=>c.matches('.step,.arch-card'));
 d=Math.max(0,sibs.indexOf(el));
 }
 setTimeout(()=>el.classList.add('visible'),d*80);
 observer.unobserve(el);
 });
},{threshold:.08});
document.querySelectorAll('.feat-card,.step,.arch-card').forEach(el=>observer.observe(el));

/* -- Counters & Sparklines -- */
const counterObs=new IntersectionObserver(entries=>{
 entries.forEach(entry=>{
 if(!entry.isIntersecting)return;
 const el=entry.target;
 const target=parseInt(el.dataset.target);
 const start=performance.now();
 const dur=1200;
 function tick(now){
 const t=Math.min((now-start)/dur,1);
 el.textContent=Math.floor((1-Math.pow(1-t,3))*target);
 if(t<1)requestAnimationFrame(tick);
 else el.textContent=target;
 }
 requestAnimationFrame(tick);
 
 // Trigger sparkline draw animation
 const card=el.closest('.stat-card');
 if(card){
 const path=card.querySelector('.sparkline path');
 if(path) path.style.strokeDashoffset='0';
 }
 
 counterObs.unobserve(el);
 });
},{threshold:.35});
document.querySelectorAll('.stat-num').forEach(el=>counterObs.observe(el));

/* -- Scrollspy: highlight the nav link of the section in view -- */
const spyLinks=[...document.querySelectorAll('.nav-links a[href^="#"]')];
const spyTargets=spyLinks.map(a=>document.querySelector(a.getAttribute('href'))).filter(Boolean);
if(spyTargets.length){
 const spy=new IntersectionObserver(entries=>{
 entries.forEach(entry=>{
 if(!entry.isIntersecting)return;
 const id='#'+entry.target.id;
 spyLinks.forEach(a=>a.classList.toggle('active',a.getAttribute('href')===id));
 });
 },{rootMargin:'-40% 0px -55% 0px'});
 spyTargets.forEach(t=>spy.observe(t));
}

/* -- Hero Canvas Drifting Nodes -- */
const canvas = document.getElementById('hero-canvas');
if(canvas){
 const ctx = canvas.getContext('2d');
 const container = document.getElementById('hero');
 let w = canvas.width = container.offsetWidth;
 let h = canvas.height = container.offsetHeight;

 window.addEventListener('resize',()=>{
 w = canvas.width = container.offsetWidth;
 h = canvas.height = container.offsetHeight;
 },{passive:true});

 const nodes = [];
 const nodeCount = 45;
 for(let i=0; i<nodeCount; i++){
 nodes.push({
 x: Math.random() * w,
 y: Math.random() * h,
 vx: (Math.random() - 0.5) * 0.3,
 vy: (Math.random() - 0.5) * 0.3,
 r: 1.5 + Math.random() * 1.5
 });
 }

 let mouse = { x: null, y: null };
 container.addEventListener('mousemove', (e) => {
 const rect = container.getBoundingClientRect();
 mouse.x = e.clientX - rect.left;
 mouse.y = e.clientY - rect.top;
 });
 container.addEventListener('mouseleave', () => {
 mouse.x = null;
 mouse.y = null;
 });

 function animate(){
 ctx.clearRect(0,0,w,h);

 // Update and draw nodes
 nodes.forEach(node=>{
 node.x += node.vx;
 node.y += node.vy;

 if(node.x < 0) node.x = w;
 if(node.x > w) node.x = 0;
 if(node.y < 0) node.y = h;
 if(node.y > h) node.y = 0;

 ctx.beginPath();
 ctx.arc(node.x, node.y, node.r, 0, Math.PI*2);
 ctx.fillStyle = 'rgba(107, 131, 158, 0.4)';
 ctx.fill();
 });

 // Draw lines between nodes
 for(let i=0; i<nodes.length; i++){
 const n1 = nodes[i];
 for(let j=i+1; j<nodes.length; j++){
 const n2 = nodes[j];
 const dx = n1.x - n2.x;
 const dy = n1.y - n2.y;
 const dist = Math.sqrt(dx*dx + dy*dy);
 if(dist < 100){
 ctx.beginPath();
 ctx.moveTo(n1.x, n1.y);
 ctx.lineTo(n2.x, n2.y);
 ctx.strokeStyle = `rgba(107, 131, 158, ${(1 - dist/100) * 0.15})`;
 ctx.lineWidth = 1;
 ctx.stroke();
 }
 }
 }

 // Draw mouse lines
 if(mouse.x !== null && mouse.y !== null){
 nodes.forEach(node=>{
 const dx = mouse.x - node.x;
 const dy = mouse.y - node.y;
 const dist = Math.sqrt(dx*dx + dy*dy);
 if(dist < 120){
 ctx.beginPath();
 ctx.moveTo(mouse.x, mouse.y);
 ctx.lineTo(node.x, node.y);
 ctx.strokeStyle = `rgba(107, 131, 158, ${(1 - dist/120) * 0.3})`;
 ctx.lineWidth = 1.2;
 ctx.stroke();
 }
 });
 }

 requestAnimationFrame(animate);
 }
 animate();
}


})();
