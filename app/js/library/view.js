// Pantalla de Biblioteca, inspirada en Google Play Books: rail izquierdo con
// "Libros" + estanterías (miniatura, contador, renombrar/borrar), barra de
// herramientas con orden (Recientes) y filtro (Progreso), y rejilla de portadas.
import * as Store from './store.js';
import * as Study from '../ai/study.js';
import * as Blobs from '../sync/blobs.js';
import * as DriveAuth from '../sync/drive-auth.js';
import { ensurePro } from '../ui/paywall.js';
import { icon, brandMark } from '../ui/icons.js';
import { t, getLang } from '../i18n.js';
import { escapeHtml } from '../ui/escape.js';
import { confirmBox, promptBox, alertBox } from '../ui/dialog.js';

let host = null;                 // #library
let onOpenBook = () => {};
let onAddBook = () => {};
let onOpenSettings = () => {};

let currentShelf = 'all';        // 'all' | 'none' | <shelfId>
let sortBy = 'recent';           // 'recent' | 'title' | 'author'
let filterProgress = 'all';      // 'all' | 'unread' | 'reading' | 'finished'
let query = '';                  // texto del buscador de la estantería (título/autor)
let allBooks = [];               // caché del último render (para refiltrar sin re-fetch)
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
  document.getElementById('landing').style.display = 'none';
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

  if (currentShelf !== 'all' && currentShelf !== 'none' && !shelves.some(s => s.id === currentShelf)) {
    currentShelf = 'all';
  }

  const noShelfCount = books.filter(b => !(b.shelfIds && b.shelfIds.length)).length;
  const shelfThumb = (id) => {
    const b = books.find(x => (x.shelfIds || []).includes(id));
    return b && b.cover ? `<img src="${escapeHtml(b.cover)}" alt="">` : `<span class="lib-rail-thumb-ph">${icon('book', { size: 14 })}</span>`;
  };

  const list = computeList();

  const title = currentShelf === 'all' ? t('Libros')
    : currentShelf === 'none' ? t('Sin estantería')
    : (shelves.find(s => s.id === currentShelf)?.name || t('Estantería'));

  host.innerHTML = `
    <div class="lib-layout">
      <aside class="lib-rail">
        <button class="lib-rail-item${currentShelf === 'all' ? ' active' : ''}" data-shelf="all">
          <span class="lib-rail-mark">${brandMark({ size: 28 })}</span>
          <span class="lib-rail-name">${t('Libros')}</span>
          <span class="lib-rail-count">${books.length}</span>
        </button>

        <div class="lib-rail-section">${t('Estanterías')}</div>
        ${shelves.map(s => {
          const count = books.filter(b => (b.shelfIds || []).includes(s.id)).length;
          return `<button class="lib-rail-item lib-rail-shelf${currentShelf === s.id ? ' active' : ''}" data-shelf="${s.id}">
            <span class="lib-rail-thumb">${shelfThumb(s.id)}</span>
            <span class="lib-rail-name">${escapeHtml(s.name)}</span>
            <span class="lib-rail-count">${count}</span>
            <span class="lib-rail-kebab" data-shelf-menu="${s.id}" title="${t('Opciones')}">${icon('ellipsis', { size: 18 })}</span>
          </button>`;
        }).join('')}
        <button class="lib-rail-item lib-rail-shelf${currentShelf === 'none' ? ' active' : ''}" data-shelf="none">
          <span class="lib-rail-thumb"><span class="lib-rail-thumb-ph">${icon('book', { size: 14 })}</span></span>
          <span class="lib-rail-name">${t('Sin estantería')}</span>
          <span class="lib-rail-count">${noShelfCount}</span>
        </button>

        <button class="lib-rail-create" data-act="newshelf">${icon('pencil', { size: 16 })}<span>${t('Crear estantería')}</span></button>
        <button class="lib-rail-create lib-rail-settings" data-act="settings">${icon('gear', { size: 16 })}<span>${t('Ajustes generales')}</span></button>
      </aside>

      <section class="lib-main">
        <h1 class="lib-h1">${escapeHtml(title)}</h1>
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

function matchShelf(b) {
  if (currentShelf === 'all') return true;
  if (currentShelf === 'none') return !(b.shelfIds && b.shelfIds.length);
  return (b.shelfIds || []).includes(currentShelf);
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

  // Menú de estantería (renombrar / borrar)
  const shelfMenu = e.target.closest('.lib-rail-kebab');
  if (shelfMenu) { e.stopPropagation(); await openShelfMenu(shelfMenu.dataset.shelfMenu, shelfMenu); return; }

  // Seleccionar estantería / "Libros"
  const railItem = e.target.closest('.lib-rail-item');
  if (railItem && !e.target.closest('.lib-rail-create')) {
    currentShelf = railItem.dataset.shelf; await render(); return;
  }

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

async function createShelf() {
  const name = (await promptBox('Nombre de la nueva estantería:', { title: 'Nueva estantería' }) || '').trim();
  if (!name) return;
  const sh = await Store.addShelf(name);
  currentShelf = sh.id;
  await render();
}

// ---- menú de estantería ----------------------------------------------------

async function openShelfMenu(id, anchor) {
  closeMenu();
  const shelves = await Store.getShelves();
  const shelf = shelves.find(s => s.id === id);
  if (!shelf) return;
  buildMenu(anchor, `
    <button class="lib-menu-item" data-act="rename">${icon('pencil', { size: 16 })}<span>${t('Renombrar')}</span></button>
    <button class="lib-menu-item danger" data-act="delete">${icon('trash', { size: 16 })}<span>${t('Eliminar estantería')}</span></button>
  `, async (act) => {
    if (act === 'rename') {
      const name = (await promptBox('Nuevo nombre:', { title: 'Renombrar estantería', value: shelf.name }) || '').trim();
      if (name) await Store.renameShelf(id, name);
    } else if (act === 'delete') {
      if (await confirmBox(t('¿Eliminar la estantería "{name}"? Los libros no se borran.', { name: shelf.name }),
          { title: 'Eliminar estantería', okText: 'Eliminar', danger: true })) {
        await Store.deleteShelf(id);
        if (currentShelf === id) currentShelf = 'all';
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
    ${shelves.length
      ? shelves.map(s => `<button class="lib-menu-item" data-act="shelf" data-shelf="${s.id}">
          <span class="lib-menu-check">${inShelf.has(s.id) ? icon('check', { size: 16 }) : ''}</span><span>${escapeHtml(s.name)}</span></button>`).join('')
      : `<div class="lib-menu-empty">${t('Aún no hay estanterías')}</div>`}
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
