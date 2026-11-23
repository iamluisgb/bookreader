/* global window, document, location, URL, Image, fetch, getComputedStyle, requestAnimationFrame, setTimeout, ResizeObserver */
// Perfil público (experimento, 23-nov-2026): pinta la estantería de perfil.json como una cinta
// de libros en 3D. El activo gira y enseña su portada; pulsándola se abre. Se recorre con las
// flechas, el teclado, arrastrando o con la rueda horizontal. Solo títulos, autores, estado y
// portadas: nada del contenido de los libros.
import { escapeHtml as esc } from '../../app/js/ui/escape.js';
import { paperCover } from './portada-paper.js';

// Absoluta: un url() relativo dentro de una variable CSS se resuelve contra la hoja que la usa
// (assets/perfil/), no contra la página.
const COVERS = new URL('../assets/perfil/luis/', location.href).href;
const FILTERS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'reading', label: 'Reading', test: b => b.status === 'reading' },
  { id: 'finished', label: 'Finished', test: b => b.status === 'finished' },
  { id: 'unread', label: 'Not started', test: b => b.status === 'unread' },
];
const LOGO = { oreilly: 'O’REILLY', packt: '&lt;packt&gt;', arxiv: 'arXiv' };

const $ = id => document.getElementById(id);
const wrapEl = $('pf-tape-wrap');
const tape = $('pf-tape');
const ob = $('pf-ob');
const state = { filter: 'all', active: 0, open: false };
let BOOKS = [];
let H = 380;

function track(name, data) { try { window.umami?.track(name, data); } catch { /* sin analítica */ } }
function statusLabel(b) {
  if (b.status === 'finished') return 'Finished';
  if (b.status === 'unread') return 'Not started';
  return `Reading · ${b.progress}%`;
}
function matches(b) { return FILTERS.find(f => f.id === state.filter).test(b); }
// Un paper no trae portada: se dibuja con sus metadatos (portada-paper.js) en vez de usar un fichero.
function coverUrl(b) { return b.coverData || `${COVERS}${b.id}.webp`; }

function loadAspect(b) {
  return new Promise(res => {
    const im = new Image();
    im.onload = () => { b.ar = im.naturalWidth / im.naturalHeight; res(); };
    im.onerror = () => { b.ar = 0.75; res(); };
    im.src = coverUrl(b);
  });
}

function sizes() {
  const W = wrapEl.clientWidth || 800;
  H = Math.round(Math.max(230, Math.min(400, W * 0.36)));
  wrapEl.style.setProperty('--H', H + 'px');
}
function dims(b) {
  const h = H;
  const t = Math.round(Math.max(h * 0.075, Math.min(h * 0.2, h * (0.05 + b.pages * 0.00034))));
  return { h, t, d: Math.round(h * b.ar) };
}

// Lomo de O'Reilly tal como es (cubierta completa de Fluent Python 2e, 2022): blanco; arriba la
// «O’» roja y, si la hay, la edición en gris; el título en negro, en vertical y en una línea, sin
// subtítulo; el apellido del autor; abajo «O’REILLY» en rojo, también en vertical. Sin animal.
const OMARK = '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="18" cy="22" r="12.5" fill="none" stroke="currentColor" stroke-width="6"/><circle cx="34" cy="6" r="4.2" fill="currentColor"/></svg>';
function oreillySpine(s, t) {
  const fs = Math.round(Math.min(t * 0.46, 26));
  const ed = s.edition ? `<div class="pf-sp-ed">${esc(s.edition)}</div>` : '';
  return `<div class="pf-face pf-spine is-oreilly"><div class="pf-sp-omark">${OMARK}</div>${ed}<div class="pf-sp-title" data-fit style="--fs:${fs}px">${esc(s.title)}</div><div class="pf-sp-auth" data-fit>${esc(s.author)}</div><div class="pf-sp-logo oreilly">O’REILLY</div></div>`;
}

// Ajusta cada título al hueco real del lomo: baja la letra hasta que quepa en una línea y, si en
// un lomo grueso quedaría diminuta, la parte en dos líneas (como hacen los lomos anchos).
// Parte un título en dos líneas por el espacio más cercano a la mitad.
function splitInTwo(text) {
  const mid = text.length / 2; let best = -1;
  for (let i = 0; i < text.length; i++) if (text[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  return best < 0 ? esc(text) : `${esc(text.slice(0, best))}<br>${esc(text.slice(best + 1))}`;
}
function overflows(el) { return el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth + 1; }
function fitSpines() {
  // Primero el autor (franja corta) y luego el título, que se queda con el resto del lomo.
  const els = [...tape.querySelectorAll('.pf-sp-auth[data-fit]'), ...tape.querySelectorAll('.pf-sp-title[data-fit]')];
  for (const el of els) {
    const t = parseFloat(el.closest('.pf-bk').style.getPropertyValue('--t'));
    let fs = parseFloat(getComputedStyle(el).fontSize);
    while (overflows(el) && fs > 5) { fs -= 0.5; el.style.fontSize = fs + 'px'; }
    // A dos líneas si en una no cabe, o si en un lomo grueso la letra quedaría diminuta.
    if (el.classList.contains('pf-sp-title') && t > 24 && (overflows(el) || fs < Math.max(9, t * 0.24))) {
      el.classList.add('is-two');
      el.innerHTML = splitInTwo(el.textContent);
      fs = Math.min(t * 0.3, 22); el.style.fontSize = fs + 'px';
      while (overflows(el) && fs > 6) { fs -= 0.5; el.style.fontSize = fs + 'px'; }
    }
  }
}

function spineHtml(b, t, h) {
  const s = b.spine;
  if (s.style === 'oreilly') return oreillySpine(s, t, h);
  let animal = '';
  if (s.animal) {
    const [cx, cy, cw, ch] = s.animal;
    const aw = t - 8, cW = aw / cw, cH = cW / b.ar;
    const ah = Math.min(cH * ch, h * 0.2);
    animal = `<div class="pf-sp-animal" style="--aw:${aw}px;--ah:${ah}px;--abs:${cW}px ${cH}px;--abp:${-cx * cW}px ${-cy * cH}px"></div>`;
  }
  const rule = s.rule ? `<div class="pf-sp-rule" style="--rc:${esc(s.rule)}"></div>` : '';
  const logo = s.style === 'tag'
    ? `<div class="pf-sp-logo tag">${esc(s.tag)}</div>`
    : `<div class="pf-sp-logo ${s.style}">${LOGO[s.style]}</div>`;
  const serif = s.serif ? ' is-serif' : '';
  let title;
  if (s.kicker || s.sub) {
    const big = Math.max(10, Math.min(24, Math.round(t * 0.4)));
    title = `<div class="pf-sp-title is-stack${serif}" style="--fs:${big}px">${s.kicker ? `<span class="k">${esc(s.kicker)}</span>` : ''}<span class="m">${esc(s.title)}</span>${s.sub ? `<span class="k">${esc(s.sub)}</span>` : ''}</div>`;
  } else {
    const fs = Math.max(9.5, Math.min(21, Math.round(t * 0.34)));
    const avail = h - (s.animal ? h * 0.2 : 20) - h * 0.22;
    const two = s.title.length * fs * 0.52 > avail && t > 40;
    title = `<div class="pf-sp-title${two ? ' is-two' : ''}${serif}" style="--fs:${two ? Math.min(fs, Math.round(t * 0.27)) : fs}px">${esc(s.title)}</div>`;
  }
  return `<div class="pf-face pf-spine">${animal}${rule}${title}<div class="pf-sp-auth">${esc(s.author)}</div>${logo}</div>`;
}

function buildTape() {
  tape.innerHTML = BOOKS.map((b, i) => {
    const { h, t, d } = dims(b); const s = b.spine;
    const vars = `--h:${h}px;--t:${t}px;--d:${d}px;--sp:${s.bg};--spbg:${s.gradient || s.bg};--ink:${s.ink};--muted:${s.muted};--img:url('${coverUrl(b)}')`;
    return `<button type="button" class="pf-bk" data-i="${i}" style="${esc(vars)}" aria-label="${esc(b.title)}, by ${esc(b.author)}. ${esc(statusLabel(b))}">
      <div class="pf-lift">
        <div class="pf-face pf-top"></div><div class="pf-face pf-fore"></div><div class="pf-face pf-back"></div><div class="pf-face pf-cover"></div>
        ${spineHtml(b, t, h)}
      </div></button>`;
  }).join('');
}

function layout() {
  const els = [...tape.children];
  if (!els.length) return;
  const W = wrapEl.clientWidth;
  const GAP = Math.max(3, H * 0.012), GAP_A = H * 0.1;
  let x = 0; const pos = [];
  BOOKS.forEach((b, i) => {
    const { t, d } = dims(b); const act = i === state.active;
    const w = act ? d * 0.985 + t * 0.17 + GAP_A * 2 : t + GAP;
    pos.push({ x, w, t, d, act }); x += w;
  });
  const a = pos[state.active];
  const offset = W / 2 - (a.x + a.w / 2);
  els.forEach((el, i) => {
    const p = pos[i]; const cx = p.x + p.w / 2 + offset - p.t / 2;
    el.style.transform = p.act
      ? `translate3d(${cx}px, 0, ${p.d / 2 - p.t / 2 + 24}px) rotateY(-80deg)`
      : `translate3d(${cx}px, ${matches(BOOKS[i]) ? 0 : 10}px, 0) rotateY(0deg)`;
    el.classList.toggle('is-active', p.act);
    el.classList.toggle('is-dim', !matches(BOOKS[i]));
    el.tabIndex = -1;
    el.setAttribute('aria-current', p.act ? 'true' : 'false');
  });
  renderCaption();
}

function renderCaption() {
  const b = BOOKS[state.active];
  const shown = BOOKS.filter(matches);
  const n = shown.indexOf(b) + 1;
  $('pf-count').innerHTML = `${n > 0 ? `<b>${String(n).padStart(2, '0')}</b>` : '—'} / ${String(shown.length).padStart(2, '0')}`;
  $('pf-caption').innerHTML = `<div class="ct">${esc(b.title)}</div><div class="cs">${esc(b.author)}<span class="pf-chip${b.status === 'reading' ? ' is-reading' : ''}">${esc(statusLabel(b))}</span></div>`;
  const idx = BOOKS.map((x, i) => matches(x) ? i : -1).filter(i => i >= 0);
  $('pf-prev').disabled = !idx.some(i => i < state.active);
  $('pf-next').disabled = !idx.some(i => i > state.active);
}

function go(dir) {
  if (state.open) closeBook();
  let i = state.active + dir;
  while (i >= 0 && i < BOOKS.length && !matches(BOOKS[i])) i += dir;
  if (i < 0 || i >= BOOKS.length) return;
  state.active = i; layout();
}
function goTo(i) { if (state.open) closeBook(); state.active = i; layout(); }

function openBook() {
  const b = BOOKS[state.active]; if (!b || state.open) return;
  const { h, d, t } = dims(b);
  ob.style.setProperty('--od', d + 'px'); ob.style.setProperty('--oh', h + 'px'); ob.style.setProperty('--oz', (d / 2 - t / 2 + 24) + 'px');
  $('pf-ob-front').style.setProperty('--img', `url('${coverUrl(b)}')`);
  $('pf-ob-page').innerHTML = `
    <span class="pf-ob-num">No. ${String(state.active + 1).padStart(2, '0')} · Agents</span>
    ${b.kind ? `<span class="pf-ob-kind">${esc(b.kind)}</span>` : ''}
    <div class="pf-ob-title">${esc(b.title)}</div>
    <div class="pf-ob-auth">${esc(b.author)}</div>
    <div class="pf-ob-state"><span>${esc(statusLabel(b))} · ${b.pages} pages</span><div class="pf-ob-track"><i data-w="${Math.max(b.progress, 2)}"></i></div></div>
    <div class="pf-ob-actions"><button type="button" data-close>Close</button></div>`;
  ob.classList.add('is-shown'); ob.setAttribute('aria-hidden', 'false');
  tape.children[state.active].style.opacity = '0';
  state.open = true;
  track('Profile: open book', { book: b.id });
  requestAnimationFrame(() => requestAnimationFrame(() => {
    ob.classList.add('is-open');
    const bar = ob.querySelector('.pf-ob-track i'); if (bar) bar.style.width = bar.dataset.w + '%';
  }));
}
function closeBook() {
  if (!state.open) return;
  state.open = false;
  ob.classList.remove('is-open');
  const el = tape.children[state.active];
  setTimeout(() => {
    // Si mientras se cerraba se abrió otro libro, este vuelve a la cinta igualmente.
    if (el && !(state.open && tape.children[state.active] === el)) el.style.opacity = '';
    if (state.open) return;
    ob.classList.remove('is-shown'); ob.setAttribute('aria-hidden', 'true');
  }, 780);
}
function closeNow() { state.open = false; ob.classList.remove('is-open', 'is-shown'); }

function renderFilters() {
  $('pf-filters').innerHTML = FILTERS.map(f => {
    const n = BOOKS.filter(f.test).length;
    return `<button type="button" role="tab" data-f="${f.id}" aria-selected="${state.filter === f.id}" ${n ? '' : 'disabled'}>${f.label}<span>${n}</span></button>`;
  }).join('');
}

function renderNow(nowId) {
  const b = BOOKS.find(x => x.id === nowId); if (!b) return;
  const el = $('pf-now');
  el.hidden = false;
  el.innerHTML = `<span class="pf-dot" aria-hidden="true"></span><span>Reading now</span><b>${esc(b.spine.title)}</b><span>${b.progress}%</span><button type="button">Show</button>`;
  el.querySelector('button').addEventListener('click', () => {
    state.filter = 'all'; renderFilters();
    goTo(BOOKS.indexOf(b)); setTimeout(openBook, 700);
    wrapEl.focus({ preventScroll: true });
  });
}

function renderList() {
  $('pf-list').innerHTML = BOOKS.map(b => `<li>${esc(b.title)}, by ${esc(b.author)} (${esc(statusLabel(b))})</li>`).join('');
}

// ---------- Eventos ----------
let downX = null, dragged = false, wheelAt = 0;
tape.addEventListener('click', e => {
  const bk = e.target.closest('.pf-bk'); if (!bk || dragged) return;
  const i = +bk.dataset.i;
  if (i === state.active) openBook(); else goTo(i);
});
ob.addEventListener('click', e => { if (e.target.closest('.pf-ob-cover, [data-close]')) closeBook(); });
$('pf-prev').addEventListener('click', () => go(-1));
$('pf-next').addEventListener('click', () => go(1));
$('pf-filters').addEventListener('click', e => {
  const btn = e.target.closest('button[data-f]'); if (!btn) return;
  state.filter = btn.dataset.f; renderFilters();
  if (state.open) closeBook();
  const first = BOOKS.findIndex(matches);
  if (first >= 0 && !matches(BOOKS[state.active])) state.active = first;
  layout();
});
wrapEl.addEventListener('keydown', e => {
  if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (state.open) closeBook(); else openBook(); }
  else if (e.key === 'Escape') closeBook();
});
wrapEl.addEventListener('pointerdown', e => { downX = e.clientX; dragged = false; });
wrapEl.addEventListener('pointermove', e => { if (downX !== null && Math.abs(e.clientX - downX) > 8) dragged = true; });
wrapEl.addEventListener('pointerup', e => {
  if (downX === null) return;
  const dx = e.clientX - downX; downX = null;
  if (Math.abs(dx) > 40) { const steps = Math.max(1, Math.min(4, Math.round(Math.abs(dx) / 90))); for (let k = 0; k < steps; k++) go(dx < 0 ? 1 : -1); }
  setTimeout(() => { dragged = false; }, 0);
});
wrapEl.addEventListener('wheel', e => {
  if (Math.abs(e.deltaX) < Math.abs(e.deltaY) || Math.abs(e.deltaX) < 12) return;
  e.preventDefault();
  const now = Date.now(); if (now - wheelAt < 260) return; wheelAt = now;
  go(e.deltaX > 0 ? 1 : -1);
}, { passive: false });

let lastW = 0;
try {
  new ResizeObserver(en => {
    const w = Math.round(en[0].contentRect.width);
    if (Math.abs(w - lastW) > 20 && BOOKS.length) { lastW = w; closeNow(); sizes(); buildTape(); fitSpines(); layout(); }
  }).observe(wrapEl);
} catch { /* sin ResizeObserver: se queda con el tamaño inicial */ }

async function start() {
  const res = await fetch('perfil.json', { cache: 'no-cache' });
  const data = await res.json();
  BOOKS = data.books;
  if (BOOKS.some(b => b.cover?.type === 'paper')) {
    await Promise.all(['600 52px "Source Serif 4"', '400 24px "Source Serif 4"', '500 16px Inter', '600 13px Inter'].map(f => document.fonts?.load(f).catch(() => null)));
    for (const b of BOOKS) if (b.cover?.type === 'paper') b.coverData = paperCover(b.cover);
  }
  await Promise.all(BOOKS.map(loadAspect));
  renderNow(data.now);
  renderFilters();
  renderList();
  sizes(); buildTape(); fitSpines(); layout();
  // Las fuentes pueden llegar después del primer ajuste: se reajusta al cargarlas.
  document.fonts?.ready.then(() => { buildTape(); fitSpines(); layout(); });
}
start().catch(() => { $('pf-caption').textContent = 'The shelf could not be loaded. Reload the page to try again.'; });
