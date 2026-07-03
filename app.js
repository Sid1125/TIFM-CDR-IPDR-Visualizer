(function(){
'use strict';

/* ── Navbar ── */
let lastScroll=0;
const navbar=document.getElementById('navbar');
window.addEventListener('scroll',()=>{
  const y=window.scrollY;
  if(y>80&&y>lastScroll)navbar.classList.add('hidden');
  else navbar.classList.remove('hidden');
  lastScroll=y;
},{passive:true});

/* ── Mobile menu ── */
document.getElementById('menu-toggle').addEventListener('click',()=>{
  document.querySelector('.nav-links').classList.toggle('open');
});
document.querySelectorAll('.nav-links a').forEach(a=>{
  a.addEventListener('click',()=>{
    document.querySelector('.nav-links').classList.remove('open');
  });
});

/* ── Scroll reveal (feature cards, workflow steps, architecture cards) ── */
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

/* ── Counters ── */
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
    counterObs.unobserve(el);
  });
},{threshold:.35});
document.querySelectorAll('.stat-num').forEach(el=>counterObs.observe(el));

/* ── Scrollspy: highlight the nav link of the section in view ── */
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

})();
