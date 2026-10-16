/* ---------- Star field generator ---------- */
function scatterStars(container, count){
  const frag = document.createDocumentFragment();
  for(let i=0;i<count;i++){
    const s = document.createElement('div');
    s.className='star';
    const size = Math.random()*2+0.6;
    s.style.width = size+'px';
    s.style.height = size+'px';
    s.style.left = (Math.random()*100)+'%';
    s.style.top = (Math.random()*100)+'%';
    s.style.animationDelay = (Math.random()*3)+'s';
    s.style.animationDuration = (2+Math.random()*3)+'s';
    frag.appendChild(s);
  }
  container.appendChild(frag);
}
scatterStars(document.getElementById('splash-stars'), 140);

/* ---------- Sidebar collapse ---------- */
const sidebarEl = document.querySelector('aside');
const sidebarToggleBtn = document.getElementById('sidebar-toggle');
sidebarToggleBtn.addEventListener('click', () => {
  sidebarEl.classList.toggle('collapsed');
  sidebarToggleBtn.title = sidebarEl.classList.contains('collapsed') ? 'Open layers panel' : 'Collapse layers panel';
});

/* ---------- Splash dismiss ---------- */
const splash = document.getElementById('splash');
function dismissSplash(){ splash.classList.add('hide'); setTimeout(()=>splash.style.display='none', 1000); }
splash.addEventListener('click', dismissSplash);
setTimeout(dismissSplash, 5200);
