/* global window, document, location, URL, Image, fetch, getComputedStyle, requestAnimationFrame, setTimeout, ResizeObserver, URLSearchParams, localStorage, history, matchMedia, performance, clearTimeout */
// Perfil público (experimento, 23-nov-2026): pinta la estantería de perfil.json como una cinta
// de libros en 3D. El activo gira y enseña su portada; pulsándola se abre. Se recorre con las
// flechas, el teclado, arrastrando o con la rueda horizontal. Solo títulos, autores, estado y
// portadas: nada del contenido de los libros.
import { escapeHtml as esc } from '../../app/js/ui/escape.js';
import { paperCover } from './portada-paper.js';

// Absoluta: un url() relativo dentro de una variable CSS se resuelve contra la hoja que la usa
// (assets/perfil/), no contra la página.
// La carpeta de portadas es la del perfil de la dirección (`/@luis/` → assets/perfil/luis/).
const HANDLE = (location.pathname.match(/\/(?:@|%40)([^/]+)/) || [])[1] || 'luis';
const COVERS = new URL(`../assets/perfil/${HANDLE}/`, location.href).href;
// Textos de la página en sus dos idiomas; el de cada perfil lo elige quien publica (`profile.lang`).
const STR = {
  en: {
    all: 'All', reading: 'Reading', finished: 'Finished', unread: 'Not started',
    sFinished: 'Finished', sUnread: 'Not started', sReading: 'Reading',
    readingNow: 'Reading now', show: 'Show', book: 'book', books: 'books', tapHint: 'tap a spine to see its cover',
    no: 'No.', pages: 'pages', close: 'Close', by: 'by', getBook: 'Get the book',
    openApp: 'Open BookReader', readWith: 'Read with BookReader', kBrowse: 'browse', kOpen: 'open', kClose: 'close',
    fullShelf: 'Full shelf on BookReader ↗',
    footTitle: 'Want a shelf like this?',
    footPitch: 'These books are read in BookReader, a reader for your own EPUBs and PDFs, with an assistant that answers with the exact page it cites.',
    tryApp: 'Try BookReader', wantShelf: 'I want my own public shelf',
    wantSubject: 'I want my own public shelf on BookReader',
    madePrivacy: 'Only titles and covers are public. The books never leave the reader’s device.',
    shelves: 'Shelves', filterBy: 'Filter by status', shelfAria: 'Bookshelf. Arrow keys to browse, Enter to open the book',
    prev: 'Previous book', next: 'Next book', title: (n) => `${n}’s shelf · BookReader`,
    noDraft: 'There is no preview to show. Open Settings → Public profile in BookReader and press Preview.',
    loadFail: 'The shelf could not be loaded. Reload the page to try again.',
  },
  es: {
    all: 'Todos', reading: 'Leyendo', finished: 'Terminados', unread: 'Sin empezar',
    sFinished: 'Terminado', sUnread: 'Sin empezar', sReading: 'Leyendo',
    readingNow: 'Leyendo ahora', show: 'Ver', book: 'libro', books: 'libros', tapHint: 'toca un lomo para ver su portada',
    no: 'N.º', pages: 'páginas', close: 'Cerrar', by: 'de', getBook: 'Conseguir el libro',
    openApp: 'Abrir BookReader', readWith: 'Leído con BookReader', kBrowse: 'recorrer', kOpen: 'abrir', kClose: 'cerrar',
    fullShelf: 'La estantería completa en BookReader ↗',
    footTitle: '¿Quieres una estantería como esta?',
    footPitch: 'Estos libros se leen en BookReader, un lector para tus propios EPUB y PDF, con un asistente que responde citando la página exacta.',
    tryApp: 'Probar BookReader', wantShelf: 'Quiero mi propia estantería pública',
    wantSubject: 'Quiero mi propia estantería pública en BookReader',
    madePrivacy: 'Solo son públicos los títulos y las portadas. Los libros nunca salen del dispositivo de quien los lee.',
    shelves: 'Estanterías', filterBy: 'Filtrar por estado', shelfAria: 'Estantería. Flechas para recorrerla, Intro para abrir el libro',
    prev: 'Libro anterior', next: 'Libro siguiente', title: (n) => `La estantería de ${n} · BookReader`,
    noDraft: 'No hay vista previa que enseñar. En BookReader, abre Ajustes → Perfil público y pulsa Vista previa.',
    loadFail: 'No se ha podido cargar la estantería. Recarga la página para volver a intentarlo.',
  },
};
let L = STR.en;
function applyLang(lang, owner) {
  L = STR[lang] || STR.en;
  document.documentElement.lang = lang === 'es' ? 'es' : 'en';
  document.querySelectorAll('[data-t]').forEach(el => { if (typeof L[el.dataset.t] === 'string') el.textContent = L[el.dataset.t]; });
  document.querySelectorAll('[data-t-aria]').forEach(el => { if (L[el.dataset.tAria]) el.setAttribute('aria-label', L[el.dataset.tAria]); });
  if (owner) document.title = L.title(owner);
  // El correo de «quiero mi estantería» en el idioma de la página, y con el perfil de donde viene.
  const want = document.getElementById('pf-want');
  if (want) want.href = `mailto:hola@raiatech.com?subject=${encodeURIComponent(L.wantSubject)}&body=${encodeURIComponent('\n\n— ' + location.origin + location.pathname)}`;
}
const FILTERS = [
  { id: 'all', label: () => L.all, test: () => true },
  { id: 'reading', label: () => L.reading, test: b => b.status === 'reading' },
  { id: 'finished', label: () => L.finished, test: b => b.status === 'finished' },
  { id: 'unread', label: () => L.unread, test: b => b.status === 'unread' },
];
const LOGO = { oreilly: 'O’REILLY', packt: '&lt;packt&gt;', arxiv: 'arXiv' };

const $ = id => document.getElementById(id);
const wrapEl = $('pf-tape-wrap');
const tape = $('pf-tape');
const ob = $('pf-ob');
// `active` = -1: ningún libro girado, todos de canto y centrados (así empieza la página).
const NONE = -1;
const state = { filter: 'all', active: NONE, open: false };
let BOOKS = [];          // libros de la estantería que se ve
let SHELF = '';          // su nombre
let SHELVES = [];        // todas: [{ id, name, books }]
let CUR = 0;             // índice de la que se ve
let H = 380;

function track(name, data) { try { window.umami?.track(name, data); } catch { /* sin analítica */ } }
function statusLabel(b) {
  if (b.status === 'finished') return L.sFinished;
  if (b.status === 'unread') return L.sUnread;
  // Sin progreso: quien publica eligió no enseñarlo.
  return b.progress == null ? L.sReading : `${L.sReading} · ${b.progress}%`;
}
function matches(b) { return FILTERS.find(f => f.id === state.filter).test(b); }
// Un paper no trae portada: se dibuja con sus metadatos (portada-paper.js) en vez de usar un fichero.
// Un perfil alojado (MON7, servido por el Worker desde R2) trae `coverFile`: la portada vive junto a
// la página, en `c/`, y la versión del perfil rompe la caché al volver a publicar.
let VERSION = '';
const hosted = (file) => new URL(`c/${file}${VERSION ? `?v=${VERSION}` : ''}`, location.href).href;
function coverUrl(b) { return b.coverData || (b.coverFile ? hosted(b.coverFile) : `${COVERS}${b.id}.webp`); }

function loadAspect(b) {
  return new Promise(res => {
    const im = new Image();
    im.onload = () => { b.ar = im.naturalWidth / im.naturalHeight; res(); };
    im.onerror = () => { b.ar = 0.75; res(); };
    im.src = coverUrl(b);
  });
}

// `?og=1`: composición de 1200×630 para la imagen que se ve al compartir el enlace (la hace
// scripts/publicar-perfil.mjs con un navegador). Solo cabecera, nombre de la estantería y lomos.
const OG = new URLSearchParams(location.search).get('og') === '1';
if (OG) document.documentElement.classList.add('is-og');
function sizes() {
  const W = wrapEl.clientWidth || 800;
  H = OG ? 360 : Math.round(Math.max(230, Math.min(400, W * 0.36)));
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
function overflowsBox(el) { return el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth + 1; }
// El título se mide por su tamaño natural frente al hueco que dejan los demás elementos del lomo, con
// dos píxeles de holgura: si cabe justo, el navegador lo encoge una fracción y pinta «…».
function titleOverflows(el) {
  const sp = el.parentElement; const cs = getComputedStyle(sp);
  let used = 0;
  for (const c of sp.children) if (c !== el) { const k = getComputedStyle(c); used += c.offsetHeight + parseFloat(k.marginTop) + parseFloat(k.marginBottom); }
  const avail = sp.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - used;
  return el.offsetHeight > avail - 2 || el.scrollWidth > el.clientWidth + 1;
}
function fitSpines() {
  // Primero el autor (franja corta) y luego el título, que se queda con el resto del lomo.
  const els = [...tape.querySelectorAll('.pf-sp-auth[data-fit]'), ...tape.querySelectorAll('.pf-sp-title[data-fit]')];
  for (const el of els) {
    const t = parseFloat(el.closest('.pf-bk').style.getPropertyValue('--t'));
    const isTitle = el.classList.contains('pf-sp-title');
    if (isTitle) el.style.flex = 'none';   // tamaño natural mientras se mide
    const overflows = isTitle ? titleOverflows : overflowsBox;
    let fs = parseFloat(getComputedStyle(el).fontSize);
    while (overflows(el) && fs > 5) { fs -= 0.5; el.style.fontSize = fs + 'px'; }
    // A dos líneas si en una no cabe, o si en un lomo grueso la letra quedaría diminuta.
    if (el.classList.contains('pf-sp-title') && t > 20 && (overflows(el) || fs < Math.max(9, t * 0.24))) {
      el.classList.add('is-two');
      el.innerHTML = splitInTwo(el.textContent);
      fs = Math.min(t * 0.3, 22); el.style.fontSize = fs + 'px';
      while (overflows(el) && fs > 6) { fs -= 0.5; el.style.fontSize = fs + 'px'; }
    }
    // Lomo tan fino que ni así cabe (un libro de 30 páginas en el móvil): fuera la etiqueta del pie
    // («Own work»), que es lo prescindible, y se vuelve a ajustar con ese sitio.
    const tag = el.parentElement.querySelector('.pf-sp-logo.tag');
    if (isTitle && tag && overflows(el)) {
      tag.style.display = 'none';
      fs = parseFloat(el.style.getPropertyValue('--fs')) || fs; el.style.fontSize = fs + 'px';
      while (overflows(el) && fs > 5) { fs -= 0.5; el.style.fontSize = fs + 'px'; }
    }
    if (isTitle) el.style.flex = '';
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
  // `plain`: lomo automático de la app (color del borde de la portada), sin editorial.
  const logo = s.style === 'tag'
    ? `<div class="pf-sp-logo tag">${esc(s.tag)}</div>`
    : LOGO[s.style] ? `<div class="pf-sp-logo ${s.style}">${LOGO[s.style]}</div>` : '<div class="pf-sp-end"></div>';
  const serif = s.serif ? ' is-serif' : '';
  let title;
  if (s.kicker || s.sub) {
    const big = Math.max(10, Math.min(24, Math.round(t * 0.4)));
    title = `<div class="pf-sp-title is-stack${serif}" style="--fs:${big}px">${s.kicker ? `<span class="k">${esc(s.kicker)}</span>` : ''}<span class="m">${esc(s.title)}</span>${s.sub ? `<span class="k">${esc(s.sub)}</span>` : ''}</div>`;
  } else {
    // Como en O'Reilly: fitSpines encoge la letra y, si no basta, lo parte en dos líneas. Antes se
    // decidía aquí a ojo y en los lomos finos del móvil el título salía cortado («Claude Cod…»).
    const fs = Math.max(9.5, Math.min(21, Math.round(t * 0.34)));
    title = `<div class="pf-sp-title${serif}" data-fit style="--fs:${fs}px">${esc(s.title)}</div>`;
  }
  // El autor también se ajusta (con tope de altura en el CSS): un nombre largo dejaba sin sitio al título.
  return `<div class="pf-face pf-spine">${animal}${rule}${title}<div class="pf-sp-auth" data-fit>${esc(s.author)}</div>${logo}</div>`;
}

function buildTape() {
  tape.innerHTML = BOOKS.map((b, i) => {
    const { h, t, d } = dims(b); const s = b.spine;
    const vars = `--h:${h}px;--t:${t}px;--d:${d}px;--sp:${s.bg};--spbg:${s.gradient || s.bg};--ink:${s.ink};--muted:${s.muted};--img:url('${coverUrl(b)}')`;
    return `<button type="button" class="pf-bk" data-i="${i}" style="${esc(vars)}" aria-label="${esc(b.title)}, ${L.by} ${esc(b.author)}. ${esc(statusLabel(b))}">
      <div class="pf-lift">
        <div class="pf-face pf-top"></div><div class="pf-face pf-fore"></div><div class="pf-face pf-back"></div><div class="pf-face pf-cover"></div>
        ${spineHtml(b, t, h)}
      </div></button>`;
  }).join('');
}

// ---------- Movimiento ----------
// La cinta se pinta desde una posición continua: `cur.p` (índice de libro con decimales) y `cur.a`
// (0 = todos de canto, 1 = uno abierto). Cada libro se abre según lo cerca del centro que esté, con
// una curva suave: al arrastrar, el que llega se va girando y el que se va se cierra, sin saltos. Un
// bucle de animación acerca `cur` a su destino `aim` en cada fotograma (sin transiciones CSS en
// la cinta), así arrastre, inercia y flechas son el mismo movimiento.
const cur = { p: 0, a: 0 }, aim = { p: 0, a: 0 };
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const smooth = x => x * x * (3 - 2 * x);
function openness(i, p, a) { return matches(BOOKS[i]) ? a * smooth(Math.max(0, 1 - Math.abs(i - p))) : 0; }

function geometry(p, a) {
  const W = wrapEl.clientWidth;
  const GAP = Math.max(3, H * 0.012), GAP_A = H * 0.1;
  let x = 0; const pos = [];
  BOOKS.forEach((b, i) => {
    const { t, d } = dims(b); const l = openness(i, p, a);
    const w = t + GAP + l * (d * 0.985 + t * 0.17 + GAP_A * 2 - t - GAP);
    pos.push({ x, w, t, d, l }); x += w;
  });
  const n = pos.length, q = Math.max(0, Math.min(n - 1, p));
  const f = Math.floor(q), c = Math.min(n - 1, f + 1);
  const cf = pos[f].x + pos[f].w / 2, cc = pos[c].x + pos[c].w / 2;
  let xp = cf + (cc - cf) * (q - f);
  if (p < 0) xp += p * pos[0].w; else if (p > n - 1) xp += (p - n + 1) * pos[n - 1].w;
  return { W, pos, offset: (W / 2 - x / 2) * (1 - a) + (W / 2 - xp) * a };
}

function paint() {
  const els = tape.children; if (!els.length) return;
  const { pos, offset } = geometry(cur.p, cur.a);
  pos.forEach((q, i) => {
    const cx = q.x + q.w / 2 + offset - q.t / 2;
    els[i].style.transform = `translate3d(${cx.toFixed(2)}px, 0, ${((q.d / 2 - q.t / 2 + 24) * q.l).toFixed(2)}px) rotateY(${(-80 * q.l).toFixed(2)}deg)`;
  });
}

let raf = 0, lastT = 0, dragging = false;
function tick(now) {
  const dt = lastT ? Math.min(64, now - lastT) : 16.7; lastT = now;
  const k = 1 - Math.pow(0.84, dt / 16.7);   // un 16 % del camino por fotograma
  if (!dragging) cur.p += (aim.p - cur.p) * k;
  cur.a += (aim.a - cur.a) * k;
  const done = !dragging && Math.abs(aim.p - cur.p) < 1e-3 && Math.abs(aim.a - cur.a) < 1e-3;
  if (done) { cur.p = aim.p; cur.a = aim.a; }
  paint();
  if (done) { raf = 0; lastT = 0; } else raf = requestAnimationFrame(tick);
}
function kick() {
  if (REDUCED || OG) { cur.p = aim.p; cur.a = aim.a; paint(); return; }
  if (!raf) raf = requestAnimationFrame(tick);
}

function layout() {
  const els = [...tape.children];
  if (!els.length) return;
  const act = state.active !== NONE;
  aim.a = act ? 1 : 0;
  if (act) aim.p = state.active;
  els.forEach((el, i) => {
    el.classList.toggle('is-active', i === state.active);
    el.classList.toggle('is-dim', !matches(BOOKS[i]));
    el.tabIndex = -1;
    el.setAttribute('aria-current', i === state.active ? 'true' : 'false');
  });
  renderCaption();
  kick();
}

function renderCaption(at = state.active) {
  const b = BOOKS[at];
  const shown = BOOKS.filter(matches);
  if (!b) {
    $('pf-count').innerHTML = `— / ${String(shown.length).padStart(2, '0')}`;
    $('pf-caption').innerHTML = `<div class="ct">${esc(SHELF)}</div><div class="cs">${shown.length} ${shown.length === 1 ? L.book : L.books} · ${L.tapHint}</div>`;
    $('pf-prev').disabled = $('pf-next').disabled = !shown.length;
    return;
  }
  const n = shown.indexOf(b) + 1;
  $('pf-count').innerHTML = `${n > 0 ? `<b>${String(n).padStart(2, '0')}</b>` : '—'} / ${String(shown.length).padStart(2, '0')}`;
  $('pf-caption').innerHTML = `<div class="ct">${esc(b.title)}</div><div class="cs">${esc(b.author)}<span class="pf-chip${b.status === 'reading' ? ' is-reading' : ''}">${esc(statusLabel(b))}</span></div>`;
  const idx = BOOKS.map((x, i) => matches(x) ? i : -1).filter(i => i >= 0);
  $('pf-prev').disabled = !idx.some(i => i < at);
  $('pf-next').disabled = !idx.some(i => i > at);
}

function go(dir) {
  if (state.open) closeBook();
  // Desde la fila de lomos, → entra por el primero y ← por el último.
  let i = state.active === NONE ? (dir > 0 ? 0 : BOOKS.length - 1) : state.active + dir;
  while (i >= 0 && i < BOOKS.length && !matches(BOOKS[i])) i += dir;
  if (i < 0 || i >= BOOKS.length) return;
  state.active = i; layout();
}
function goTo(i) { if (state.open) closeBook(); state.active = i; layout(); }
// Volver a la fila de lomos: Esc con el libro cerrado, o tocar fuera de los libros.
function shelve() { if (state.open) closeBook(); if (state.active === NONE) return; state.active = NONE; layout(); }

function openBook() {
  const b = BOOKS[state.active]; if (!b || state.open) return;
  const { h, d, t } = dims(b);
  ob.style.setProperty('--od', d + 'px'); ob.style.setProperty('--oh', h + 'px'); ob.style.setProperty('--oz', (d / 2 - t / 2 + 24) + 'px');
  $('pf-ob-front').style.setProperty('--img', `url('${coverUrl(b)}')`);
  $('pf-ob-page').innerHTML = `
    <span class="pf-ob-num">${L.no} ${String(state.active + 1).padStart(2, '0')} · ${esc(SHELF)}</span>
    ${b.kind ? `<span class="pf-ob-kind">${esc(b.kind)}</span>` : ''}
    <div class="pf-ob-title">${esc(b.title)}</div>
    <div class="pf-ob-auth">${esc(b.author)}</div>
    <div class="pf-ob-state"><span>${esc(statusLabel(b))}${b.pagesEstimated ? '' : ` · ${b.pages} ${L.pages}`}</span>${b.progress == null ? '' : `<div class="pf-ob-track"><i data-w="${Math.max(b.progress, 2)}"></i></div>`}</div>
    ${b.note ? `<p class="pf-ob-note">${esc(b.note)}</p>` : ''}
    <div class="pf-ob-actions">${safeLink(b.link) ? `<a class="pf-ob-link" href="${esc(safeLink(b.link))}" target="_blank" rel="noopener nofollow" data-umami-event="Profile: get book">${L.getBook} ↗</a>` : ''}<button type="button" data-close>${L.close}</button></div>`;
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
    return `<button type="button" role="tab" data-f="${f.id}" aria-selected="${state.filter === f.id}" ${n ? '' : 'disabled'}>${f.label()}<span>${n}</span></button>`;
  }).join('');
}

function renderNow(nowId) {
  const all = SHELVES.flatMap(sh => sh.books);
  const b = all.find(x => x.id === nowId); if (!b) return;
  const el = $('pf-now');
  el.hidden = false;
  el.innerHTML = `<span class="pf-dot" aria-hidden="true"></span><span>${L.readingNow}</span><b>${esc(b.spine.title)}</b>${b.progress == null ? '' : `<span>${b.progress}%</span>`}<button type="button">${L.show}</button>`;
  el.querySelector('button').addEventListener('click', () => {
    // Si no está en la estantería que se ve, se cambia a la primera que lo tenga.
    if (!BOOKS.includes(b)) selectShelf(SHELVES.findIndex(sh => sh.books.includes(b)));
    state.filter = 'all'; renderFilters();
    goTo(BOOKS.indexOf(b)); setTimeout(openBook, 700);
    wrapEl.focus({ preventScroll: true });
  });
}

// Solo enlaces http(s): el perfil lo escribe una persona y aquí no se fía de nada más.
function safeLink(v) { try { const u = new URL(v); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : ''; } catch { return ''; } }
function renderList() {
  $('pf-list').innerHTML = BOOKS.map(b => `<li>${esc(b.title)}, ${L.by} ${esc(b.author)} (${esc(statusLabel(b))})</li>`).join('');
}

// ---------- Eventos ----------
let downX = null, dragged = false;
tape.addEventListener('click', e => {
  const bk = e.target.closest('.pf-bk'); if (!bk || dragged) return;
  const i = +bk.dataset.i;
  if (i === state.active) openBook(); else goTo(i);
});
// Tocar el hueco (no un libro ni el libro abierto) devuelve los libros al estante.
wrapEl.addEventListener('click', e => {
  if (dragged || state.open || e.target.closest('.pf-bk, .pf-ob')) return;
  shelve();
});
ob.addEventListener('click', e => { if (e.target.closest('.pf-ob-cover, [data-close]')) closeBook(); });
$('pf-prev').addEventListener('click', () => go(-1));
$('pf-next').addEventListener('click', () => go(1));
$('pf-filters').addEventListener('click', e => {
  const btn = e.target.closest('button[data-f]'); if (!btn) return;
  state.filter = btn.dataset.f; renderFilters();
  if (state.open) closeBook();
  if (state.active !== NONE && !matches(BOOKS[state.active])) state.active = NONE;
  layout();
});
wrapEl.addEventListener('keydown', e => {
  if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
  else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    if (state.open) closeBook(); else if (state.active === NONE) go(1); else openBook();
  }
  else if (e.key === 'Escape') { if (state.open) closeBook(); else shelve(); }
});
// Arrastrar (dedo, ratón o trackpad): la cinta va pegada al dedo y, al soltar, sigue con la
// inercia del gesto y se asienta en el libro que quede en el centro. Un gesto vertical se deja al
// scroll de la página. El puntero se captura solo cuando ya es un arrastre: capturarlo antes
// desviaría el toque de un libro.
const matching = () => BOOKS.map((b, i) => matches(b) ? i : -1).filter(i => i >= 0);
function nearest(p) {
  let best = NONE, bd = Infinity;
  for (const i of matching()) { const d = Math.abs(i - p); if (d < bd) { bd = d; best = i; } }
  return best;
}
// La posición continua que deja la cinta desplazada `dx` px desde donde empezó el gesto (con un
// libro abierto, que es como queda al arrastrar). Pasado el primer o el último libro, se estira
// con resistencia.
let base = 0, startAt = NONE;
const off1 = p => geometry(p, 1).offset;
function pFor(dx) {
  const m = matching(); if (!m.length) return cur.p;
  const hi = off1(m[0]), lo = off1(m[m.length - 1]);
  let want = base + dx;
  if (want > hi) want = hi + (want - hi) * 0.35; else if (want < lo) want = lo + (want - lo) * 0.35;
  let a = -0.6, b = BOOKS.length - 0.4;   // `off1` baja al subir p: bisección
  for (let k = 0; k < 32; k++) { const mid = (a + b) / 2; if (off1(mid) > want) a = mid; else b = mid; }
  return (a + b) / 2;
}
function startDrag() {
  if (state.open) closeBook();
  startAt = state.active;
  if (state.active === NONE) {
    // Desde la fila de lomos: el gesto parte del libro que está en el centro.
    const { W, pos, offset } = geometry(cur.p, cur.a);
    let bd = Infinity;
    pos.forEach((q, i) => { const d = Math.abs(q.x + q.w / 2 + offset - W / 2); if (matches(BOOKS[i]) && d < bd) { bd = d; cur.p = i; } });
  }
  aim.a = 1; dragging = true;
  base = off1(cur.p);
  tape.classList.add('is-dragging');
}
let shown = NONE;
function dragTo(dx) {
  cur.p = pFor(dx); kick();
  const i = nearest(cur.p); if (i !== shown) { shown = i; renderCaption(i); }
}
function settle(p, dx = 0) {
  dragging = false; shown = NONE;
  tape.classList.remove('is-dragging');
  let i = nearest(p);
  // Gesto claro que no llegó a cambiar de libro: uno en su dirección.
  if (i === startAt && Math.abs(dx) > 40) {
    const m = matching(), k = m.indexOf(i) + (dx < 0 ? 1 : -1);
    if (k >= 0 && k < m.length) i = m[k];
  }
  state.active = i; layout();
}

let downY = 0, axis = '', vx = 0, lastX = 0, lastMv = 0;
wrapEl.addEventListener('pointerdown', e => {
  if (state.open || e.button > 0) return;
  downX = e.clientX; downY = e.clientY; dragged = false; axis = '';
});
wrapEl.addEventListener('pointermove', e => {
  if (downX === null) return;
  const dx = e.clientX - downX, dy = e.clientY - downY;
  if (!axis) {
    if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) { axis = 'v'; downX = null; return; }
    if (Math.abs(dx) <= 6) return;
    axis = 'h'; dragged = true; vx = 0; lastX = e.clientX; lastMv = performance.now();
    startDrag();
    try { wrapEl.setPointerCapture(e.pointerId); } catch { /* sin captura */ }
  }
  const now = performance.now();
  vx = 0.7 * ((e.clientX - lastX) / Math.max(1, now - lastMv)) + 0.3 * vx;
  lastX = e.clientX; lastMv = now;
  dragTo(dx);
});
function endDrag(e, cancelled) {
  if (downX === null) return;
  const dx = e.clientX - downX; downX = null;
  if (!dragged) return;
  // Si el dedo se paró antes de soltar, sin inercia.
  if (performance.now() - lastMv > 90) vx = 0;
  const fling = cancelled ? 0 : Math.max(-1.5, Math.min(1.5, vx)) * 260;
  settle(cancelled ? cur.p : pFor(dx + fling), cancelled ? 0 : dx);
  setTimeout(() => { dragged = false; }, 0);
}
wrapEl.addEventListener('pointerup', e => endDrag(e, false));
wrapEl.addEventListener('pointercancel', e => endDrag(e, true));
// Trackpad: el desplazamiento lateral mueve la cinta igual que el dedo y se asienta al parar.
let wheelDx = 0, wheelEnd = 0;
wrapEl.addEventListener('wheel', e => {
  if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || state.open) return;
  e.preventDefault();
  if (!wheelEnd) { wheelDx = 0; startDrag(); }
  wheelDx -= e.deltaX;
  dragTo(wheelDx);
  clearTimeout(wheelEnd);
  wheelEnd = setTimeout(() => { wheelEnd = 0; settle(cur.p); }, 120);
}, { passive: false });

let lastW = 0;
try {
  new ResizeObserver(en => {
    const w = Math.round(en[0].contentRect.width);
    if (Math.abs(w - lastW) > 20 && BOOKS.length) { lastW = w; closeNow(); sizes(); buildTape(); fitSpines(); layout(); }
  }).observe(wrapEl);
} catch { /* sin ResizeObserver: se queda con el tamaño inicial */ }

// Vista previa desde la app (`?draft=1`): el panel «Publicar…» deja la foto en localStorage (mismo
// origen) y la página la pinta en lugar de perfil.json, con las portadas dentro como data URL.
const DRAFT = new URLSearchParams(location.search).get('draft') === '1';
async function loadData() {
  if (DRAFT) {
    let d;
    try { d = JSON.parse(localStorage.getItem('bookreader_perfil_draft') || 'null'); } catch { d = null; }
    if (!d || !(d.books?.length || Object.keys(d.books || {}).length)) throw new Error('sin borrador');
    document.documentElement.classList.add('is-draft');
    return d;
  }
  const res = await fetch('perfil.json', { cache: 'no-cache' });
  return res.json();
}

// Dos formatos de perfil.json: el 1 (una estantería: `shelf` + `books`) y el 2 (varias:
// `shelves: [{ id, name, books: [ids] }]` + `books` con cada libro una vez). Se devuelve siempre
// la forma del 2 con los libros ya resueltos; un libro en dos estanterías es el MISMO objeto.
const slugOf = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'shelf';
function normalize(data) {
  if (Array.isArray(data.shelves)) {
    const byId = new Map((Array.isArray(data.books) ? data.books : Object.values(data.books || {})).map(b => [b.id, b]));
    return data.shelves.map(sh => ({ id: sh.id || slugOf(sh.name), name: sh.name, books: (sh.books || []).map(id => byId.get(id)).filter(Boolean) }))
      .filter(sh => sh.books.length);
  }
  return [{ id: slugOf(data.shelf || 'shelf'), name: data.shelf || '', books: data.books || [] }];
}

// La estantería que se pide: `#id` en la dirección (o `?shelf=id`, que es lo que usa la web que la
// incrusta). Sin pedir nada, la primera.
function requested() {
  const want = decodeURIComponent(location.hash.slice(1)) || new URLSearchParams(location.search).get('shelf') || '';
  const i = SHELVES.findIndex(sh => sh.id === want);
  return i >= 0 ? i : 0;
}

function renderTabs() {
  const tabs = $('pf-tabs');
  const many = SHELVES.length > 1;
  tabs.hidden = !many;
  $('pf-shelf-title').classList.toggle('pf-sr', many);
  if (!many) return;
  tabs.innerHTML = SHELVES.map((sh, i) => `<button type="button" role="tab" data-s="${i}" aria-selected="${i === CUR}" tabindex="${i === CUR ? 0 : -1}">${esc(sh.name)}<span>${sh.books.length}</span></button>`).join('');
}

function selectShelf(i, { fromUrl = false } = {}) {
  if (i < 0 || i >= SHELVES.length) return;
  closeNow();
  CUR = i;
  BOOKS = SHELVES[i].books; SHELF = SHELVES[i].name;
  $('pf-shelf-title').textContent = SHELF;
  const embedLink = document.querySelector('.pf-embed-link a');
  if (embedLink) embedLink.href = embedLink.href.replace(/#.*$/, '') + '#' + SHELVES[i].id;
  state.filter = 'all'; state.active = NONE;
  cur.p = aim.p = 0; cur.a = aim.a = 0;   // otra estantería: entra ya de canto, sin animar desde la anterior
  renderTabs(); renderFilters(); renderList();
  buildTape(); fitSpines(); layout();
  // La dirección lleva la estantería, para poder compartir una en concreto. Incrustada no se toca.
  if (!fromUrl && SHELVES.length > 1 && !document.documentElement.classList.contains('is-embed')) {
    history.replaceState(null, '', '#' + SHELVES[i].id);
  }
}

async function start() {
  const data = await loadData();
  VERSION = typeof data.version === 'string' ? data.version.replace(/[^a-z0-9]/gi, '') : '';
  // Perfil: idioma, presentación y foto (la foto, en el borrador como data URL; publicada, junto a las portadas).
  const pr = data.profile || {};
  applyLang(pr.lang, data.owner);
  // En la vista previa de un perfil nuevo la página aún no lleva el nombre: lo trae el borrador.
  if (pr.name && DRAFT) {
    const h1 = document.querySelector('.pf-who h1'); if (h1) h1.textContent = pr.name;
    const ex = document.querySelector('.pf-exlibris b'); if (ex) ex.textContent = pr.name;
  }
  if (pr.bio) { $('pf-bio').textContent = pr.bio; $('pf-bio').hidden = false; }
  const avatar = pr.avatarData || (pr.avatarFile ? hosted(pr.avatarFile) : pr.avatar ? `${COVERS}avatar.webp` : '');
  if (avatar) { const a = $('pf-avatar'); a.textContent = ''; a.style.backgroundImage = `url('${avatar}')`; a.classList.add('has-img'); }
  SHELVES = normalize(data);
  // Los filtros por estado (All, Reading…) son opcionales: quien publica decide si se ven.
  $('pf-filters').hidden = data.showFilters === false;
  if (!SHELVES.length) throw new Error('sin libros');
  const all = [...new Set(SHELVES.flatMap(sh => sh.books))];
  if (all.some(b => b.cover?.type === 'paper')) {
    await Promise.all(['600 52px "Source Serif 4"', '400 24px "Source Serif 4"', '500 16px Inter', '600 13px Inter'].map(f => document.fonts?.load(f).catch(() => null)));
    for (const b of all) if (b.cover?.type === 'paper') b.coverData = paperCover(b.cover);
  }
  await Promise.all(all.map(loadAspect));
  sizes();
  // Empieza con todos los libros de canto y centrados; tocar uno lo gira y enseña la portada.
  selectShelf(requested(), { fromUrl: true });
  // En la imagen para compartir, el libro del medio girado: que se vea al menos una portada.
  if (OG && BOOKS.length) { state.active = Math.floor(BOOKS.length / 2); layout(); }
  renderNow(data.now);
  // Las fuentes pueden llegar después del primer ajuste: se reajusta al cargarlas.
  document.fonts?.ready.then(() => { buildTape(); fitSpines(); layout(); });
}

$('pf-tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-s]'); if (!b) return;
  selectShelf(+b.dataset.s);
  track('Profile: shelf', { shelf: SHELVES[CUR].id });
});
$('pf-tabs').addEventListener('keydown', e => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  const n = SHELVES.length; const i = (CUR + (e.key === 'ArrowRight' ? 1 : n - 1)) % n;
  selectShelf(i); $('pf-tabs').querySelector(`[data-s="${i}"]`)?.focus();
});
window.addEventListener('hashchange', () => { const i = requested(); if (i !== CUR) selectShelf(i, { fromUrl: true }); });
// Incrustada: avisa a la página que la contiene de su alto (para ajustar el iframe) y acepta que
// esa página le cambie el tema. Solo escucha a la web personal de Luis.
const EMBED_PARENTS = ['https://luisgonzalezbernal.com'];
if (document.documentElement.classList.contains('is-embed') && window.parent !== window) {
  const tell = () => window.parent.postMessage({ type: 'bookreader-height', height: Math.ceil(document.documentElement.scrollHeight) }, '*');
  try { new ResizeObserver(tell).observe(document.body); } catch { /* sin ResizeObserver */ }
  window.addEventListener('load', tell);
  window.addEventListener('message', e => {
    if (!EMBED_PARENTS.includes(e.origin) || e.data?.type !== 'bookreader-theme') return;
    if (e.data.theme === 'dark' || e.data.theme === 'light') document.documentElement.setAttribute('data-theme', e.data.theme);
  });
}

start().catch(() => {
  $('pf-caption').textContent = DRAFT ? L.noDraft : L.loadFail;
});
