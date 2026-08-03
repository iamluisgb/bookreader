// Pantalla de Biblioteca, inspirada en Google Play Books: rail izquierdo con
// "Libros" + estanterías (miniatura, contador, renombrar/borrar), barra de
// herramientas con orden (Recientes) y filtro (Progreso), y rejilla de portadas.
import * as Store from './store.js';
import * as Shelves from './shelves.js';
import * as Study from '../ai/study.js';
import * as Blobs from '../sync/blobs.js';
import * as DriveAuth from '../sync/drive-auth.js';
import { ensurePro } from '../ui/paywall.js';
import { icon, brandMark } from '../ui/icons.js';
import { t, getLang } from '../i18n.js';
import { escapeHtml } from '../ui/escape.js';
import { confirmBox, promptBox, alertBox, formBox } from '../ui/dialog.js';

let host = null;                 // #library
let onOpenBook = () => {};
let onAddBook = () => {};
let onOpenSettings = () => {};

// Selección de estanterías. Un conjunto, no un valor: las estanterías son
// etiquetas y un libro está en varias, así que lo que la gente quiere ver casi
// siempre es un CRUCE ("Técnico" ∩ "Pendientes"), no una carpeta. Vacía = todos
// los libros; el pseudo-id 'none' (sin estantería) es exclusivo, porque cruzarlo
// con cualquier estantería da siempre el conjunto vacío.
//
// Cada entrada es una FILA del rail, no un id: `{ label, ids }`. Una rama con
// hijas ("Técnico", con "Técnico/ML" debajo) son varios ids que valen como UNA
// condición —"Técnico o algo bajo él"—, y se resuelve en O internamente. Si se
// guardaran los ids sueltos, cruzar esa rama con otra estantería en modo Y
// pediría los libros que están en la rama Y en TODAS sus hijas a la vez: casi
// siempre vacío, y nunca lo que se quería pedir.
let selection = new Map();   // key (id de estantería | 'g:<ruta>' | 'none') → { label, ids }
let matchAllShelves = true;      // true = intersección (Y) · false = unión (O)
let sortBy = 'recent';           // 'recent' | 'title' | 'author'
let filterProgress = 'all';      // 'all' | 'unread' | 'reading' | 'finished'
let query = '';                  // texto del buscador de la estantería (título/autor)
let allBooks = [];               // caché del último render (para refiltrar sin re-fetch)
let allShelves = [];             // ídem para las estanterías (resolver reglas y nombres)
let menuEl = null;
// Transferencias en curso, por bookId: { loaded, total, state }. Solo para
// pintar la barra de la tarjeta; la verdad la tiene sync/blobs.js.
const transfers = new Map();

const SORT_LABELS = { recent: t('Recientes'), title: t('Título'), author: t('Autor') };
const PROG_LABELS = { all: t('Progreso'), unread: t('Sin empezar'), reading: t('Leyendo'), finished: t('Terminados') };

export function init(opts = {}) {
  host = document.getElementById('library');
  onOpenBook = opts.onOpenBook || (() => {});
  onAddBook = opts.onAddBook || (() => {});
  onOpenSettings = opts.onOpenSettings || (() => {});
  host.addEventListener('click', onClick);
  host.addEventListener('input', onInput);
  document.addEventListener('click', (e) => {
    if (menuEl && !menuEl.contains(e.target) && !e.target.closest('.lib-kebab, .lib-rail-kebab')) closeMenu();
    if (!e.target.closest('.lib-dd')) host.querySelectorAll('.lib-dd.open').forEach(d => d.classList.remove('open'));
  });

  // El sync trajo libros de otro dispositivo: repintar para que aparezcan sus
  // fichas (o desaparezcan las que se borraron allí).
  window.addEventListener('bookreader:library-changed', () => { if (isOpen()) render(); });
  window.addEventListener('bookreader:blob-progress', onBlobProgress);
}

// Progreso de una transferencia. Se actualiza SOLO la tarjeta afectada: un
// render completo por cada trozo descargado haría parpadear toda la rejilla y
// perdería el foco del buscador.
function onBlobProgress(e) {
  const d = e.detail || {};
  if (!d.id) return;
  if (d.state === 'done' || d.state === 'error') {
    transfers.delete(d.id);
    if (d.state === 'error' && d.message) alertBox(d.message, { title: t('Sincronización') });
    if (isOpen()) render();
    return;
  }
  transfers.set(d.id, { loaded: d.loaded || 0, total: d.total || 0, state: d.state });
  paintTransfer(d.id);
}

function paintTransfer(id) {
  const card = host && host.querySelector(`.lib-card[data-id="${CSS.escape(id)}"]`);
  if (!card) return;
  const tr = transfers.get(id);
  const bar = card.querySelector('.lib-dl-fill');
  if (!bar || !tr) return;
  card.classList.add('is-transferring');
  bar.style.width = tr.total ? Math.round((tr.loaded / tr.total) * 100) + '%' : '0%';
}

export function show() {
  document.getElementById('epub-container').style.display = 'none';
  document.getElementById('pdf-container').style.display = 'none';
  document.getElementById('reader-footer').style.display = 'none';
  document.body.classList.add('in-library');
  host.style.display = 'block';
}

export function hide() {
  host.style.display = 'none';
  document.body.classList.remove('in-library');
  closeMenu();
}

export function isOpen() {
  return host && host.style.display !== 'none';
}

export async function hasBooks() {
  const books = await Store.getAllBooks();
  return books.length > 0;
}

export async function render() {
  if (!host) return;
  const [books, shelves] = await Promise.all([Store.getAllBooks(), Store.getShelves()]);
  allBooks = books;
  allShelves = shelves;
  memberCache = new Map();   // los datos son otros: la pertenencia calculada caduca

  // Una estantería borrada (aquí o en otro dispositivo) desaparece de la
  // selección en vez de dejarla filtrando por ids que ya no existen.
  const live = new Set(shelves.map(s => s.id));
  for (const [key, entry] of [...selection]) {
    if (key === 'none') continue;
    const ids = entry.ids.filter(id => live.has(id));
    if (ids.length) selection.set(key, { ...entry, ids }); else selection.delete(key);
  }

  const noShelfCount = books.filter(b => !(b.shelfIds && b.shelfIds.length)).length;
  const list = computeList();

  host.innerHTML = `
    <div class="lib-layout">
      <aside class="lib-rail">
        <button class="lib-rail-item${selection.size ? '' : ' active'}" data-shelf="all">
          <span class="lib-rail-mark">${brandMark({ size: 28 })}</span>
          <span class="lib-rail-name">${t('Libros')}</span>
          <span class="lib-rail-count">${books.length}</span>
        </button>

        <div class="lib-rail-section">${t('Estanterías')}</div>
        ${Shelves.shelfRows(shelves).map(railRowHtml).join('')}
        <button class="lib-rail-item lib-rail-shelf${selection.has('none') ? ' active' : ''}" data-shelf="none">
          <span class="lib-rail-thumb"><span class="lib-rail-thumb-ph">${icon('book', { size: 14 })}</span></span>
          <span class="lib-rail-name">${t('Sin estantería')}</span>
          <span class="lib-rail-count">${noShelfCount}</span>
        </button>

        <button class="lib-rail-create" data-act="newshelf">${icon('pencil', { size: 16 })}<span>${t('Crear estantería')}</span></button>
        <button class="lib-rail-create" data-act="newsmart">${icon('sparkles', { size: 16 })}<span>${t('Estantería inteligente')}</span></button>
        <button class="lib-rail-create lib-rail-settings" data-act="settings">${icon('gear', { size: 16 })}<span>${t('Ajustes generales')}</span></button>
      </aside>

      <section class="lib-main">
        <h1 class="lib-h1">${escapeHtml(currentTitle())}</h1>
        ${filterChipsHtml()}
        <div class="lib-toolbar">
          <div class="lib-search-box">
            ${icon('search', { size: 16 })}
            <input type="search" class="lib-search" placeholder="${t('Buscar libro…')}" value="${escapeHtml(query)}"
              autocomplete="off" spellcheck="false" aria-label="${t('Buscar libro por título o autor')}">
          </div>
          ${dropdownHtml('sort', icon('sort', { size: 16 }) + SORT_LABELS[sortBy], SORT_LABELS, sortBy)}
          ${dropdownHtml('progress', PROG_LABELS[filterProgress], PROG_LABELS, filterProgress)}
          <button class="lib-upload" data-act="add">${icon('upload', { size: 18 })}<span>${t('Subir archivos')}</span></button>
        </div>
        <div class="lib-results">${resultsHtml(list)}</div>
      </section>
    </div>
  `;
  paintStudyChip();   // async, no bloquea el render de la rejilla
}

// Portada de muestra de una fila del rail: la del primer libro que contenga.
function rowThumb(ids) {
  const set = memberIdsOf(ids);
  const b = allBooks.find(x => set.has(x.id) && x.cover);
  return b ? `<img src="${escapeHtml(b.cover)}" alt="">` : `<span class="lib-rail-thumb-ph">${icon('book', { size: 14 })}</span>`;
}

// Una fila del rail: estantería (manual o inteligente) o GRUPO —un tramo del
// nombre que no existe como estantería propia, p. ej. "Técnico" cuando solo hay
// "Técnico/ML"—. El grupo filtra por todo lo que cuelga de él, pero no tiene
// menú: no hay nada que renombrar ni borrar.
function railRowHtml(row) {
  const ids = row.shelfIds;
  const active = selection.has(row.key);
  const count = memberIdsOf(ids).size;
  const indent = row.depth ? ` style="padding-left:${12 + row.depth * 16}px"` : '';
  const smart = row.shelf && Shelves.isSmart(row.shelf);
  const thumb = smart
    ? `<span class="lib-rail-thumb lib-rail-thumb--smart">${icon('sparkles', { size: 15 })}</span>`
    : `<span class="lib-rail-thumb">${rowThumb(ids)}</span>`;
  const kebab = row.shelf
    ? `<span class="lib-rail-kebab" data-shelf-menu="${escapeHtml(row.shelf.id)}" title="${t('Opciones')}">${icon('ellipsis', { size: 18 })}</span>`
    : '';
  return `<button class="lib-rail-item lib-rail-shelf${active ? ' active' : ''}${row.kind === 'group' ? ' lib-rail-group' : ''}"
      data-row-key="${escapeHtml(row.key)}" data-row-label="${escapeHtml(row.label)}"
      data-shelf-ids="${escapeHtml(ids.join(','))}"${indent}>
    ${row.kind === 'group' ? `<span class="lib-rail-thumb lib-rail-thumb--group"></span>` : thumb}
    <span class="lib-rail-name">${escapeHtml(row.label)}</span>
    <span class="lib-rail-count">${count}</span>
    ${kebab}
  </button>`;
}

function currentTitle() {
  if (!selection.size) return t('Libros');
  if (selection.has('none')) return t('Sin estantería');
  const names = [...selection.values()].map(e => e.label);
  if (names.length === 1) return names[0];
  return names.join(matchAllShelves ? ' · ' : ' / ');
}

// Chips de la selección: hacen visible QUÉ está filtrando (con varias
// estanterías el título solo no basta), permiten quitar una a una en táctil
// —donde no hay ⌘+clic— y llevan el conmutador Y/O, que es la diferencia entre
// "los que están en las dos" y "los que están en alguna".
function filterChipsHtml() {
  if (selection.size < 1 || selection.has('none')) return '';
  const chips = [...selection].map(([key, entry]) =>
    `<span class="lib-chip">${escapeHtml(entry.label)}
      <button class="lib-chip-x" data-unselect="${escapeHtml(key)}" aria-label="${t('Quitar del filtro')}">${icon('xmark', { size: 13 })}</button>
    </span>`).join('');
  const mode = selection.size > 1
    ? `<button class="lib-chip lib-chip-mode" data-act="togglemode" title="${t('Cambiar entre Y (en todas) y O (en alguna)')}">
        ${matchAllShelves ? t('en todas') : t('en alguna')}</button>`
    : '';
  return `<div class="lib-chips">${chips}${mode}
    <button class="lib-chip lib-chip-clear" data-act="clearsel">${t('Quitar filtro')}</button></div>`;
}

// Chip "Repasar hoy · N" (P10): la cola diaria de repetición espaciada, el bucle de
// retorno de la app. Solo aparece si hay tarjetas vencidas; al cerrar la sesión se
// re-pinta (el contador baja o el chip desaparece).
async function paintStudyChip() {
  const bar = host && host.querySelector('.lib-toolbar');
  if (!bar) return;
  const { cards } = await Study.dueToday();
  bar.querySelector('.lib-study-chip')?.remove();
  if (!cards || !bar.isConnected) return;
  const chip = document.createElement('button');
  chip.className = 'lib-study-chip';
  chip.innerHTML = `${icon('cards', { size: 16 })}<span>${t('Repasar hoy · {n}', { n: cards })}</span>`;
  // P12 · Si hay estanterías con vencidas, el chip abre un selector de ámbito
  // (Todo / cada estantería). Si no, repasa todo directo (flujo rápido de siempre).
  chip.addEventListener('click', async (e) => {
    e.stopPropagation();
    const scopes = await Study.studyScopes();
    // Sin elección real (un solo libro suelto, sin estanterías) → repasa todo directo.
    const nBooks = scopes.shelves.reduce((n, s) => n + s.books.length, 0) + scopes.looseBooks.length;
    if (!scopes.shelves.length && nBooks <= 1) { Study.openToday({ onClose: paintStudyChip }); return; }
    showStudyChooser(chip, scopes);
  });
  bar.insertBefore(chip, bar.querySelector('.lib-upload'));
}

// Selector de ámbito de repaso (P12, árbol estilo Anki): "Todo" + cada estantería como
// categoría PADRE (suma de sus libros) con sus LIBROS anidados debajo, y los sueltos aparte.
// Se repasa a cualquier nivel (estantería o libro).
function showStudyChooser(chip, scopes) {
  document.querySelector('.lib-study-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'lib-study-menu';
  const row = (label, count, scope, kind = '') =>
    `<button class="lib-study-opt${kind ? ' lib-study-opt--' + kind : ''}" data-scope='${escapeHtml(JSON.stringify(scope))}'>
      <span class="lib-study-opt-lbl">${escapeHtml(label)}</span><span class="lib-study-opt-n">${count}</span>
    </button>`;
  const section = (title, rows) => rows ? `<div class="lib-study-sec">${title}</div>${rows}` : '';
  const shelfTree = scopes.shelves.map(s =>
    row(s.name, s.cards, { type: 'shelf', shelfId: s.id }, 'shelf') +
    s.books.map(b => row(b.title, b.cards, { type: 'book', bookId: b.id }, 'book')).join('')
  ).join('');
  const loose = scopes.looseBooks.map(b => row(b.title, b.cards, { type: 'book', bookId: b.id }, 'book')).join('');
  menu.innerHTML =
    row(t('Todo'), scopes.total, { type: 'all' }) +
    shelfTree +
    section(t('Sin estantería'), loose);
  chip.parentElement.appendChild(menu);
  const r = chip.getBoundingClientRect();
  const pr = chip.parentElement.getBoundingClientRect();
  menu.style.left = (r.left - pr.left) + 'px';
  menu.style.top = (r.bottom - pr.top + 6) + 'px';

  const close = () => { menu.remove(); document.removeEventListener('click', onOutside, true); };
  const onOutside = (ev) => { if (!menu.contains(ev.target)) close(); };
  setTimeout(() => document.addEventListener('click', onOutside, true), 0);
  menu.addEventListener('click', (ev) => {
    const opt = ev.target.closest('.lib-study-opt');
    if (!opt) return;
    close();
    Study.openToday({ scope: JSON.parse(opt.dataset.scope), onClose: paintStudyChip });
  });
}

function dropdownHtml(key, label, options, current) {
  return `<div class="lib-dd" data-dd="${key}">
    <button class="lib-dd-btn">${label}${icon('chevron-down', { size: 15 })}</button>
    <div class="lib-dd-menu">
      ${Object.entries(options).filter(([v]) => !(key === 'progress' && v === 'all') || true).map(([v, lbl]) =>
        `<button class="lib-dd-opt${v === current ? ' active' : ''}" data-dd-val="${v}">
          <span class="lib-dd-check">${v === current ? icon('check', { size: 15 }) : ''}</span>${escapeHtml(key === 'progress' && v === 'all' ? t('Todos') : lbl)}
        </button>`).join('')}
    </div>
  </div>`;
}

// Tamaño legible para el botón de descarga ("Descargar · 4,2 MB").
function humanSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + ' MB';
}

function cardHtml(b) {
  const pct = Math.max(0, Math.min(100, Math.round(b.progress || 0)));
  const cover = b.cover
    ? `<img class="lib-cover-img" src="${escapeHtml(b.cover)}" alt="">`
    : `<div class="lib-cover-fallback"><span>${escapeHtml(initials(b.title))}</span></div>`;
  const badge = (b.status === 'finished') ? `<span class="lib-badge">${icon('check', { size: 13 })}</span>` : '';

  // Ficha FANTASMA: el libro está en tu biblioteca pero su fichero no está en
  // este dispositivo. Se distingue de un libro normal (portada atenuada) y
  // ofrece traerlo, igual que la nube de Play Books. Si nadie lo subió todavía,
  // no hay nada que ofrecer: se dice y punto, en vez de un botón que fallaría.
  const ghost = Store.isGhost(b);
  const transfer = transfers.get(b.id);
  let overlay = '';
  if (transfer) {
    overlay = `<div class="lib-dl lib-dl-active">
      <div class="lib-dl-bar"><span class="lib-dl-fill" style="width:${transfer.total ? Math.round((transfer.loaded / transfer.total) * 100) : 0}%"></span></div>
      <span class="lib-dl-lbl">${transfer.dir === 'up' ? t('Subiendo…') : t('Descargando…')}</span>
    </div>`;
  } else if (ghost && b.blob && b.blob.path) {
    overlay = `<div class="lib-dl">
      <button class="lib-dl-btn" data-download="${escapeHtml(b.id)}" title="${t('Descargar a este dispositivo')}">
        ${icon('download', { size: 16 })}<span>${escapeHtml(humanSize(b.size))}</span>
      </button>
    </div>`;
  } else if (ghost) {
    overlay = `<div class="lib-dl"><span class="lib-dl-note">${t('Solo notas')}</span></div>`;
  }

  return `
    <div class="lib-card${ghost ? ' is-ghost' : ''}${transfer ? ' is-transferring' : ''}" data-id="${b.id}">
      <div class="lib-cover">
        ${cover}
        ${badge}
        ${overlay}
        <button class="lib-kebab" data-id="${b.id}" title="${t('Más')}" aria-label="${t('Más opciones')}">${icon('ellipsis', { size: 20 })}</button>
      </div>
      <div class="lib-progressbar"><span style="width:${pct}%"></span></div>
      <div class="lib-title">${escapeHtml(b.title || t('Sin título'))}</div>
      <div class="lib-author">${escapeHtml(b.author || '')}</div>
    </div>`;
}

function emptyHtml(noBooksAtAll) {
  return `<div class="lib-empty">
    <div class="lib-empty-icon">${icon('books', { size: 56 })}</div>
    <p>${noBooksAtAll ? t('Tu biblioteca está vacía.') : t('No hay libros aquí.')}</p>
    ${noBooksAtAll ? `<button class="lib-upload" data-act="add">${icon('upload', { size: 18 })}<span>${t('Subir tu primer libro')}</span></button>` : ''}
  </div>`;
}

// ---- filtros / orden -------------------------------------------------------

// Miembros de una estantería, cacheados por render. Una estantería INTELIGENTE
// no guarda miembros: los calcula recorriendo la biblioteca. Sin caché eso se
// repetiría por cada contador del rail y por cada libro de la rejilla —O(n·m) en
// cada tecleo del buscador—; con ella se evalúa una vez por estantería.
let memberCache = new Map();
function membersOf(id) {
  let set = memberCache.get(id);
  if (!set) {
    const sh = allShelves.find(s => s.id === id);
    set = new Set(Shelves.booksIn(allBooks, sh).map(b => b.id));
    memberCache.set(id, set);
  }
  return set;
}
// Unión de varias estanterías (una fila del rail arrastra a sus descendientes).
function memberIdsOf(ids) {
  const out = new Set();
  for (const id of ids) for (const bid of membersOf(id)) out.add(bid);
  return out;
}

// Cada entrada de la selección se resuelve en O (la rama y todo lo que cuelga de
// ella) y las entradas entre sí en Y u O según el conmutador.
function matchShelf(b) {
  if (!selection.size) return true;
  if (selection.has('none')) return !(b.shelfIds && b.shelfIds.length);
  const entries = [...selection.values()];
  const inEntry = (e) => e.ids.some(id => membersOf(id).has(b.id));
  return matchAllShelves ? entries.every(inEntry) : entries.some(inEntry);
}
function matchFilter(b) {
  if (filterProgress === 'all') return true;
  return (b.status || 'unread') === filterProgress;
}
// Normaliza para buscar sin acentos/mayúsculas (mismo criterio que js/search.js).
function norm(s) { return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
function matchQuery(b) {
  const q = norm(query.trim());
  if (!q) return true;
  return norm(b.title).includes(q) || norm(b.author).includes(q);
}
// Lista visible = estantería · progreso · búsqueda, ordenada. Compartida por el
// render completo y el refiltrado en vivo del buscador.
function computeList() {
  return sortBooks(allBooks.filter(matchShelf).filter(matchFilter).filter(matchQuery));
}
// Rejilla (o estado vacío contextual) para la lista dada.
function resultsHtml(list) {
  if (list.length) return `<div class="lib-grid">${list.map(cardHtml).join('')}</div>`;
  if (query.trim()) {
    return `<div class="lib-empty"><div class="lib-empty-icon">${icon('search', { size: 56 })}</div>
      <p>${t('Ningún libro coincide con «{q}».', { q: escapeHtml(query.trim()) })}</p></div>`;
  }
  return emptyHtml(allBooks.length === 0);
}
// Re-pinta SOLO la rejilla (el input vive en la toolbar, intacto → no pierde el foco).
function paintResults() {
  const wrap = host && host.querySelector('.lib-results');
  if (wrap) wrap.innerHTML = resultsHtml(computeList());
}
function sortBooks(list) {
  if (sortBy === 'title') return list.sort((a, b) => (a.title || '').localeCompare(b.title || '', getLang()));
  if (sortBy === 'author') return list.sort((a, b) => (a.author || '').localeCompare(b.author || '', getLang()));
  return list; // 'recent': ya viene ordenado por lastOpenedAt desc
}

// ---- eventos ---------------------------------------------------------------

// Buscador de la estantería: refiltra en vivo sin re-render completo (mantiene el foco).
function onInput(e) {
  if (!e.target.closest('.lib-search')) return;
  query = e.target.value;
  paintResults();
}

async function onClick(e) {
  if (e.target.closest('.lib-upload, [data-act="add"]')) { onAddBook(); return; }

  // Desplegables (orden / progreso)
  const ddBtn = e.target.closest('.lib-dd-btn');
  if (ddBtn) {
    const dd = ddBtn.closest('.lib-dd');
    const wasOpen = dd.classList.contains('open');
    host.querySelectorAll('.lib-dd.open').forEach(d => d.classList.remove('open'));
    dd.classList.toggle('open', !wasOpen);
    return;
  }
  const opt = e.target.closest('.lib-dd-opt');
  if (opt) {
    const key = opt.closest('.lib-dd').dataset.dd;
    if (key === 'sort') sortBy = opt.dataset.ddVal; else filterProgress = opt.dataset.ddVal;
    await render();
    return;
  }

  if (e.target.closest('[data-act="settings"]')) { onOpenSettings(); return; }

  if (e.target.closest('[data-act="newshelf"]')) { await createShelf(); return; }
  if (e.target.closest('[data-act="newsmart"]')) { await createSmartShelf(); return; }

  // Chips del filtro: quitar una estantería, alternar Y/O, limpiar.
  const unsel = e.target.closest('[data-unselect]');
  if (unsel) { selection.delete(unsel.dataset.unselect); await render(); return; }
  if (e.target.closest('[data-act="togglemode"]')) { matchAllShelves = !matchAllShelves; await render(); return; }
  if (e.target.closest('[data-act="clearsel"]')) { selection.clear(); await render(); return; }

  // Menú de estantería (renombrar / regla / mover / borrar)
  const shelfMenu = e.target.closest('.lib-rail-kebab');
  if (shelfMenu) { e.stopPropagation(); await openShelfMenu(shelfMenu.dataset.shelfMenu, shelfMenu); return; }

  // Seleccionar estantería / grupo / "Libros"
  const railItem = e.target.closest('.lib-rail-item');
  if (railItem && !e.target.closest('.lib-rail-create')) { await selectRail(railItem, e); return; }

  // Botón de descarga de una ficha fantasma (no abre el libro)
  const dl = e.target.closest('[data-download]');
  if (dl) { e.stopPropagation(); await startDownload(dl.dataset.download); return; }

  // Menú de libro
  const kebab = e.target.closest('.lib-kebab');
  if (kebab) { e.stopPropagation(); await openBookMenu(kebab.dataset.id, kebab); return; }

  const card = e.target.closest('.lib-card');
  if (card) await openCard(card.dataset.id);
}

// Abrir una tarjeta. Si el fichero no está aquí, pulsar la portada equivale a
// pedir la descarga: es lo que espera cualquiera que venga de Play Books, y
// mejor que un "no se pudo abrir" sobre un libro que sí es suyo.
async function openCard(id) {
  const book = await Store.getBook(id);
  if (!book) return;
  if (Store.hasFile(book)) { onOpenBook(book); return; }
  if (book.blob && book.blob.path) await startDownload(id, { open: true });
  else await alertBox(t('Este libro se sincronizó desde otro dispositivo, pero su archivo aún no está en Drive. Ábrelo allí una vez para subirlo.'), { title: t('Archivo no disponible') });
}

// Descarga con las tres puertas en orden: Drive conectado, licencia Pro y cola.
async function startDownload(id, { open = false } = {}) {
  if (Blobs.isQueued(id)) return;
  if (!DriveAuth.isConnected()) {
    await alertBox(t('Conecta con Google Drive en Ajustes para descargar tus libros en este dispositivo.'), { title: t('Sincronización') });
    return;
  }
  if (!(await ensurePro('files'))) return;
  await Blobs.requestDownload(id);
  const book = await Store.getBook(id);
  if (open && book && Store.hasFile(book)) onOpenBook(book);
}

// Pulsar una fila del rail. Clic normal = ver SOLO eso (lo de siempre).
// ⌘/Ctrl/Mayús+clic = añadir o quitar del cruce sin salir del rail; en táctil,
// donde no hay modificador, lo mismo se hace desde el menú de la estantería.
async function selectRail(el, ev) {
  const fixed = el.dataset.shelf;          // "Libros" y "Sin estantería"
  if (fixed === 'all') { selection.clear(); await render(); return; }
  if (fixed === 'none') { selection = new Map([['none', { label: t('Sin estantería'), ids: [] }]]); await render(); return; }

  const key = el.dataset.rowKey;
  const entry = { label: el.dataset.rowLabel || '', ids: (el.dataset.shelfIds || '').split(',').filter(Boolean) };
  if (ev && (ev.metaKey || ev.ctrlKey || ev.shiftKey)) {
    selection.delete('none');
    if (selection.has(key)) selection.delete(key); else selection.set(key, entry);
  } else {
    selection = new Map([[key, entry]]);
  }
  await render();
}

async function createShelf() {
  const name = (await promptBox('Nombre de la nueva estantería:', { title: 'Nueva estantería',
    placeholder: 'Técnico/Machine Learning' }) || '').trim();
  if (!name) return;
  const sh = await Store.addShelf(name);
  selection = new Map([[sh.id, { label: Shelves.segments(sh.name).pop(), ids: [sh.id] }]]);
  await render();
}

async function createSmartShelf() {
  const sh = await editSmartShelf(null);
  if (sh) selection = new Map([[sh.id, { label: Shelves.segments(sh.name).pop(), ids: [sh.id] }]]);
  await render();
}

// ---- estanterías inteligentes ----------------------------------------------

// Editor de la regla. Devuelve la estantería creada/actualizada, o null.
//
// Los campos son los SINCRONIZADOS del libro a propósito: una regla sobre
// "abierto por última vez" o sobre si el fichero está descargado daría
// resultados distintos en cada dispositivo (ver library/shelves.js).
async function editSmartShelf(shelf) {
  const rule = (shelf && shelf.rule) || {};
  const manual = allShelves.filter(s => !Shelves.isSmart(s) && s.id !== (shelf && shelf.id));
  const res = await formBox({
    title: shelf ? 'Editar estantería inteligente' : 'Nueva estantería inteligente',
    message: 'Los libros entran solos cuando cumplen la regla.',
    fields: [
      { name: 'name', label: 'Nombre', type: 'text', value: shelf ? shelf.name : '', placeholder: 'Pendientes técnicos' },
      { name: 'status', label: 'Estado', type: 'select', value: rule.status || '',
        options: { '': 'Cualquiera', unread: 'Sin empezar', reading: 'Leyendo', finished: 'Terminados' } },
      { name: 'format', label: 'Formato', type: 'select', value: rule.format || '',
        options: { '': 'Cualquiera', epub: 'EPUB', pdf: 'PDF' } },
      { name: 'author', label: 'Autor contiene', type: 'text', value: rule.author || '' },
      { name: 'title', label: 'Título contiene', type: 'text', value: rule.title || '' },
      { name: 'addedWithinDays', label: 'Añadido hace menos de', type: 'select', value: String(rule.addedWithinDays || ''),
        options: { '': 'Cualquier fecha', 7: '7 días', 30: '30 días', 90: '90 días', 365: 'Un año' } },
      { name: 'shelfIds', label: 'En alguna de estas estanterías', type: 'checks', value: rule.shelfIds || [],
        emptyText: 'Aún no hay estanterías', options: manual.map(s => ({ value: s.id, label: s.name })) },
    ],
  });
  if (!res) return null;

  const name = (res.name || '').trim();
  if (!name) { await alertBox(t('La estantería necesita un nombre.'), { title: t('Nueva estantería inteligente') }); return null; }
  const next = Shelves.cleanRule({
    status: res.status, format: res.format, author: res.author, title: res.title,
    addedWithinDays: parseInt(res.addedWithinDays, 10) || 0, shelfIds: res.shelfIds || [],
  });
  // Sin ninguna condición la estantería contendría la biblioteca entera y no se
  // podría meter nada a mano (los miembros se calculan): mejor decirlo que
  // guardar una estantería que parece rota.
  if (!Shelves.hasRule(next)) {
    await alertBox(t('Pon al menos una condición: si no, la estantería contendría todos los libros.'),
      { title: t('Nueva estantería inteligente') });
    return null;
  }
  if (shelf) return Store.updateShelf(shelf.id, { name, rule: next });
  return Store.addShelf(name, { rule: next });
}

// ---- menú de estantería ----------------------------------------------------

async function openShelfMenu(id, anchor) {
  closeMenu();
  const shelves = await Store.getShelves();
  const shelf = shelves.find(s => s.id === id);
  if (!shelf) return;
  const smart = Shelves.isSmart(shelf);
  const inFilter = selection.has(id);
  buildMenu(anchor, `
    <button class="lib-menu-item" data-act="filter">${icon(inFilter ? 'xmark' : 'plus', { size: 16 })}<span>${inFilter ? t('Quitar del filtro') : t('Añadir al filtro')}</span></button>
    <div class="lib-menu-sep"></div>
    <button class="lib-menu-item" data-act="rename">${icon('pencil', { size: 16 })}<span>${t('Renombrar')}</span></button>
    ${smart ? `<button class="lib-menu-item" data-act="rule">${icon('sparkles', { size: 16 })}<span>${t('Editar regla')}</span></button>` : ''}
    <button class="lib-menu-item" data-act="up">${icon('chevron-up', { size: 16 })}<span>${t('Subir')}</span></button>
    <button class="lib-menu-item" data-act="down">${icon('chevron-down', { size: 16 })}<span>${t('Bajar')}</span></button>
    <div class="lib-menu-sep"></div>
    <button class="lib-menu-item danger" data-act="delete">${icon('trash', { size: 16 })}<span>${t('Eliminar estantería')}</span></button>
  `, async (act) => {
    if (act === 'filter') {
      // La vía táctil para cruzar estanterías: en el rail eso es ⌘/Ctrl+clic,
      // que en un móvil no existe.
      selection.delete('none');
      if (inFilter) selection.delete(id);
      else selection.set(id, { label: Shelves.segments(shelf.name).pop(), ids: [id] });
    } else if (act === 'rename') {
      // El nombre ES la jerarquía: renombrar a "Técnico/ML" la mueve bajo
      // "Técnico" (y lo crea como grupo si no existe). De ahí la pista.
      const name = (await promptBox('Nuevo nombre (usa «/» para anidar, p. ej. Técnico/ML):',
        { title: 'Renombrar estantería', value: shelf.name }) || '').trim();
      if (name) await Store.renameShelf(id, name);
    } else if (act === 'rule') {
      await editSmartShelf(shelf);
    } else if (act === 'up' || act === 'down') {
      await Store.moveShelf(id, act === 'up' ? -1 : 1);
    } else if (act === 'delete') {
      const msg = smart
        ? t('¿Eliminar la estantería inteligente "{name}"? Los libros no se borran.', { name: shelf.name })
        : t('¿Eliminar la estantería "{name}"? Los libros no se borran.', { name: shelf.name });
      if (await confirmBox(msg, { title: 'Eliminar estantería', okText: 'Eliminar', danger: true })) {
        await Store.deleteShelf(id);
        selection.delete(id);
      }
    }
    await render();
  });
}

// ---- menú de libro ---------------------------------------------------------

async function openBookMenu(id, anchor) {
  closeMenu();
  const [book, shelves] = await Promise.all([Store.getBook(id), Store.getShelves()]);
  if (!book) return;
  const inShelf = new Set(book.shelfIds || []);
  // Solo las MANUALES se marcan: en una inteligente la pertenencia la decide la
  // regla, y ofrecer una casilla que no hace nada sería mentir. Las que ya
  // contienen el libro se dicen abajo, para que no parezca que faltan.
  const manualShelves = shelves.filter(s => !Shelves.isSmart(s));
  const smartShelves = shelves.filter(s => Shelves.isSmart(s) && Shelves.booksIn([book], s).length);
  const finished = book.status === 'finished';
  const local = Store.hasFile(book);
  const uploaded = !!(book.blob && book.blob.path);

  // Bloque de almacenamiento: traer el fichero, liberarlo de este dispositivo o
  // —para los libros grandes que no se suben solos— subirlo a mano.
  let storage = '';
  if (!local && uploaded) {
    storage = `<button class="lib-menu-item" data-act="download">${icon('download', { size: 16 })}<span>${t('Descargar a este dispositivo')}</span></button>`;
  } else if (local && uploaded) {
    storage = `<button class="lib-menu-item" data-act="undownload">${icon('xmark', { size: 16 })}<span>${t('Quitar descarga de este dispositivo')}</span></button>`;
  } else if (local && (book.size || 0) > Blobs.MAX_AUTO_UPLOAD) {
    storage = `<button class="lib-menu-item" data-act="upload">${icon('upload', { size: 16 })}<span>${t('Subir a Drive ({size})', { size: humanSize(book.size) })}</span></button>`;
  }

  buildMenu(anchor, `
    <button class="lib-menu-item" data-act="open">${icon('book', { size: 16 })}<span>${local ? t('Abrir') : t('Descargar y abrir')}</span></button>
    <button class="lib-menu-item" data-act="finish">${icon('check', { size: 16 })}<span>${finished ? t('Marcar como no leído') : t('Marcar como terminado')}</span></button>
    ${storage ? `<div class="lib-menu-sep"></div>${storage}` : ''}
    <div class="lib-menu-sep"></div>
    <div class="lib-menu-label">${t('Estanterías')}</div>
    ${manualShelves.length
      ? manualShelves.map(s => `<button class="lib-menu-item" data-act="shelf" data-shelf="${s.id}">
          <span class="lib-menu-check">${inShelf.has(s.id) ? icon('check', { size: 16 }) : ''}</span><span>${escapeHtml(s.name)}</span></button>`).join('')
      : `<div class="lib-menu-empty">${t('Aún no hay estanterías')}</div>`}
    ${smartShelves.length
      ? `<div class="lib-menu-note">${icon('sparkles', { size: 13 })}<span>${t('En {names} entra solo, por su regla.', { names: smartShelves.map(s => s.name).join(', ') })}</span></div>`
      : ''}
    <button class="lib-menu-item" data-act="newshelf">${icon('plus', { size: 16 })}<span>${t('Nueva estantería…')}</span></button>
    <div class="lib-menu-sep"></div>
    <button class="lib-menu-item danger" data-act="delete">${icon('trash', { size: 16 })}<span>${t('Eliminar')}</span></button>
  `, async (act, item) => {
    if (act === 'open') { await openCard(id); return; }
    if (act === 'download') { await startDownload(id); return; }
    if (act === 'upload') {
      if (!DriveAuth.isConnected()) {
        await alertBox(t('Conecta con Google Drive en Ajustes para subir tus libros.'), { title: t('Sincronización') });
        return;
      }
      if (!(await ensurePro('files'))) return;
      Blobs.markManualUpload(id);
      Blobs.schedule();
      return;
    }
    if (act === 'undownload') {
      // Solo se ofrece con el fichero ya en Drive: si no, "quitar la descarga"
      // sería un borrado disfrazado, porque no habría de dónde recuperarlo.
      if (!(await confirmBox(t('Se liberará el archivo de este dispositivo. Seguirá en tu biblioteca y podrás volver a descargarlo desde Drive.'),
          { title: t('Quitar descarga'), okText: t('Quitar') }))) return;
      await Store.removeDownload(id);
      await render();
      return;
    }
    if (act === 'finish') {
      await Store.updateBook(id, { status: finished ? (book.progress > 0 ? 'reading' : 'unread') : 'finished' });
    } else if (act === 'shelf') {
      await Store.toggleBookShelf(id, item.dataset.shelf, !inShelf.has(item.dataset.shelf));
    } else if (act === 'newshelf') {
      const name = (await promptBox('Nombre de la nueva estantería:', { title: 'Nueva estantería' }) || '').trim();
      if (name) { const sh = await Store.addShelf(name); await Store.toggleBookShelf(id, sh.id, true); }
    } else if (act === 'delete') {
      // Con sync activo el borrado deja de ser local: viaja al resto de
      // dispositivos y se lleva la copia de Drive. Hay que decirlo antes.
      const msg = DriveAuth.isConnected()
        ? t('¿Eliminar "{title}" de la biblioteca? Se borrará en todos tus dispositivos sincronizados, junto con la copia de Drive.', { title: book.title })
        : t('¿Eliminar "{title}" de la biblioteca? Esto borra el archivo guardado.', { title: book.title });
      if (!(await confirmBox(msg, { title: t('Eliminar libro'), okText: t('Eliminar'), danger: true }))) return;
      await Store.deleteBook(id);
      Blobs.schedule();   // libera también el binario de Drive
    }
    await render();
  });
}

// ---- popover genérico ------------------------------------------------------

function buildMenu(anchor, innerHtml, onAct) {
  menuEl = document.createElement('div');
  menuEl.className = 'lib-menu';
  menuEl.innerHTML = innerHtml;
  document.body.appendChild(menuEl);
  positionMenu(anchor);
  menuEl.addEventListener('click', async (ev) => {
    const item = ev.target.closest('.lib-menu-item');
    if (!item) return;
    const keep = item.dataset.act === 'open' ? false : false; // siempre cerramos
    closeMenu();
    await onAct(item.dataset.act, item);
  });
}

function positionMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  menuEl.style.visibility = 'hidden';
  menuEl.style.display = 'block';
  const mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
  let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
  left = Math.max(8, left);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  menuEl.style.left = left + 'px';
  menuEl.style.top = top + 'px';
  menuEl.style.visibility = 'visible';
}

function closeMenu() {
  if (menuEl) { menuEl.remove(); menuEl = null; }
}

// ---- util ------------------------------------------------------------------

function initials(title) {
  return (title || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase();
}
