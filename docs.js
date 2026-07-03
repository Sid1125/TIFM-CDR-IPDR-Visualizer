(function(){
'use strict';

/* -- Docs sidebar scrollspy: highlight the section link currently in view -- */
const navLinks=[...document.querySelectorAll('#docsNav a[href^="#"]')];
const targets=navLinks.map(a=>document.querySelector(a.getAttribute('href'))).filter(Boolean);
if(targets.length){
  const spy=new IntersectionObserver(entries=>{
    entries.forEach(entry=>{
      if(!entry.isIntersecting)return;
      const id='#'+entry.target.id;
      navLinks.forEach(a=>a.classList.toggle('active',a.getAttribute('href')===id));
    });
  },{rootMargin:'-15% 0px -70% 0px'});
  targets.forEach(t=>spy.observe(t));
}

/* -- Reveal doc sections as they enter view -- */
const reveal=new IntersectionObserver(entries=>{
  entries.forEach(entry=>{
    if(!entry.isIntersecting)return;
    entry.target.classList.add('visible');
    reveal.unobserve(entry.target);
  });
},{threshold:.06});
document.querySelectorAll('.doc-section').forEach(el=>reveal.observe(el));

})();
