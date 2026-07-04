// Pantalla de Biblioteca, inspirada en Google Play Books: rail izquierdo con
// "Libros" + estanterías (miniatura, contador, renombrar/borrar), barra de
// herramientas con orden (Recientes) y filtro (Progreso), y rejilla de portadas.
import * as Store from './store.js';
import { icon } from '../ui/icons.js';
import { escapeHtml } from '../ui/escape.js';

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

const SORT_LABELS = { recent: 'Recientes', title: 'Título', author: 'Autor' };
const PROG_LABELS = { all: 'Progreso', unread: 'Sin empezar', reading: 'Leyendo', finished: 'Terminados' };

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

  const title = currentShelf === 'all' ? 'Libros'
    : currentShelf === 'none' ? 'Sin estantería'
    : (shelves.find(s => s.id === currentShelf)?.name || 'Estantería');

  host.innerHTML = `
    <div class="lib-layout">
      <aside class="lib-rail">
        <button class="lib-rail-item${currentShelf === 'all' ? ' active' : ''}" data-shelf="all">
          <span class="lib-rail-ico">${icon('books', { size: 20 })}</span>
          <span class="lib-rail-name">Libros</span>
          <span class="lib-rail-count">${books.length}</span>
        </button>

        <div class="lib-rail-section">Estanterías</div>
        ${shelves.map(s => {
          const count = books.filter(b => (b.shelfIds || []).includes(s.id)).length;
          return `<button class="lib-rail-item lib-rail-shelf${currentShelf === s.id ? ' active' : ''}" data-shelf="${s.id}">
            <span class="lib-rail-thumb">${shelfThumb(s.id)}</span>
            <span class="lib-rail-name">${escapeHtml(s.name)}</span>
            <span class="lib-rail-count">${count}</span>
            <span class="lib-rail-kebab" data-shelf-menu="${s.id}" title="Opciones">${icon('ellipsis', { size: 18 })}</span>
          </button>`;
        }).join('')}
        <button class="lib-rail-item lib-rail-shelf${currentShelf === 'none' ? ' active' : ''}" data-shelf="none">
          <span class="lib-rail-thumb"><span class="lib-rail-thumb-ph">${icon('book', { size: 14 })}</span></span>
          <span class="lib-rail-name">Sin estantería</span>
          <span class="lib-rail-count">${noShelfCount}</span>
        </button>

        <button class="lib-rail-create" data-act="newshelf">${icon('pencil', { size: 16 })}<span>Crear estantería</span></button>
        <button class="lib-rail-create lib-rail-settings" data-act="settings">${icon('gear', { size: 16 })}<span>Ajustes generales</span></button>
      </aside>

      <section class="lib-main">
        <h1 class="lib-h1">${escapeHtml(title)}</h1>
        <div class="lib-toolbar">
          <div class="lib-search-box">
            ${icon('search', { size: 16 })}
            <input type="search" class="lib-search" placeholder="Buscar libro…" value="${escapeHtml(query)}"
              autocomplete="off" spellcheck="false" aria-label="Buscar libro por título o autor">
          </div>
          ${dropdownHtml('sort', icon('sort', { size: 16 }) + SORT_LABELS[sortBy], SORT_LABELS, sortBy)}
          ${dropdownHtml('progress', PROG_LABELS[filterProgress], PROG_LABELS, filterProgress)}
          <button class="lib-upload" data-act="add">${icon('upload', { size: 18 })}<span>Subir archivos</span></button>
        </div>
        <div class="lib-results">${resultsHtml(list)}</div>
      </section>
    </div>
  `;
}

function dropdownHtml(key, label, options, current) {
  return `<div class="lib-dd" data-dd="${key}">
    <button class="lib-dd-btn">${label}${icon('chevron-down', { size: 15 })}</button>
    <div class="lib-dd-menu">
      ${Object.entries(options).filter(([v]) => !(key === 'progress' && v === 'all') || true).map(([v, lbl]) =>
        `<button class="lib-dd-opt${v === current ? ' active' : ''}" data-dd-val="${v}">
          <span class="lib-dd-check">${v === current ? icon('check', { size: 15 }) : ''}</span>${escapeHtml(key === 'progress' && v === 'all' ? 'Todos' : lbl)}
        </button>`).join('')}
    </div>
  </div>`;
}

function cardHtml(b) {
  const pct = Math.max(0, Math.min(100, Math.round(b.progress || 0)));
  const cover = b.cover
    ? `<img class="lib-cover-img" src="${escapeHtml(b.cover)}" alt="">`
    : `<div class="lib-cover-fallback"><span>${escapeHtml(initials(b.title))}</span></div>`;
  const badge = (b.status === 'finished') ? `<span class="lib-badge">${icon('check', { size: 13 })}</span>` : '';
  return `
    <div class="lib-card" data-id="${b.id}">
      <div class="lib-cover">
        ${cover}
        ${badge}
        <button class="lib-kebab" data-id="${b.id}" title="Más" aria-label="Más opciones">${icon('ellipsis', { size: 20 })}</button>
      </div>
      <div class="lib-progressbar"><span style="width:${pct}%"></span></div>
      <div class="lib-title">${escapeHtml(b.title || 'Sin título')}</div>
      <div class="lib-author">${escapeHtml(b.author || '')}</div>
    </div>`;
}

function emptyHtml(noBooksAtAll) {
  return `<div class="lib-empty">
    <div class="lib-empty-icon">${icon('books', { size: 56 })}</div>
    <p>${noBooksAtAll ? 'Tu biblioteca está vacía.' : 'No hay libros aquí.'}</p>
    ${noBooksAtAll ? `<button class="lib-upload" data-act="add">${icon('upload', { size: 18 })}<span>Subir tu primer libro</span></button>` : ''}
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
      <p>Ningún libro coincide con “${escapeHtml(query.trim())}”.</p></div>`;
  }
  return emptyHtml(allBooks.length === 0);
}
// Re-pinta SOLO la rejilla (el input vive en la toolbar, intacto → no pierde el foco).
function paintResults() {
  const wrap = host && host.querySelector('.lib-results');
  if (wrap) wrap.innerHTML = resultsHtml(computeList());
}
function sortBooks(list) {
  if (sortBy === 'title') return list.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'es'));
  if (sortBy === 'author') return list.sort((a, b) => (a.author || '').localeCompare(b.author || '', 'es'));
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

  // Menú de libro
  const kebab = e.target.closest('.lib-kebab');
  if (kebab) { e.stopPropagation(); await openBookMenu(kebab.dataset.id, kebab); return; }

  const card = e.target.closest('.lib-card');
  if (card) { const book = await Store.getBook(card.dataset.id); if (book) onOpenBook(book); }
}

async function createShelf() {
  const name = (prompt('Nombre de la nueva estantería:') || '').trim();
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
    <button class="lib-menu-item" data-act="rename">${icon('pencil', { size: 16 })}<span>Renombrar</span></button>
    <button class="lib-menu-item danger" data-act="delete">${icon('trash', { size: 16 })}<span>Eliminar estantería</span></button>
  `, async (act) => {
    if (act === 'rename') {
      const name = (prompt('Nuevo nombre:', shelf.name) || '').trim();
      if (name) await Store.renameShelf(id, name);
    } else if (act === 'delete') {
      if (confirm(`¿Eliminar la estantería "${shelf.name}"? Los libros no se borran.`)) {
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

  buildMenu(anchor, `
    <button class="lib-menu-item" data-act="open">${icon('book', { size: 16 })}<span>Abrir</span></button>
    <button class="lib-menu-item" data-act="finish">${icon('check', { size: 16 })}<span>${finished ? 'Marcar como no leído' : 'Marcar como terminado'}</span></button>
    <div class="lib-menu-sep"></div>
    <div class="lib-menu-label">Estanterías</div>
    ${shelves.length
      ? shelves.map(s => `<button class="lib-menu-item" data-act="shelf" data-shelf="${s.id}">
          <span class="lib-menu-check">${inShelf.has(s.id) ? icon('check', { size: 16 }) : ''}</span><span>${escapeHtml(s.name)}</span></button>`).join('')
      : '<div class="lib-menu-empty">Aún no hay estanterías</div>'}
    <button class="lib-menu-item" data-act="newshelf">${icon('plus', { size: 16 })}<span>Nueva estantería…</span></button>
    <div class="lib-menu-sep"></div>
    <button class="lib-menu-item danger" data-act="delete">${icon('trash', { size: 16 })}<span>Eliminar</span></button>
  `, async (act, item) => {
    if (act === 'open') { const b = await Store.getBook(id); if (b) onOpenBook(b); return; }
    if (act === 'finish') {
      await Store.updateBook(id, { status: finished ? (book.progress > 0 ? 'reading' : 'unread') : 'finished' });
    } else if (act === 'shelf') {
      await Store.toggleBookShelf(id, item.dataset.shelf, !inShelf.has(item.dataset.shelf));
    } else if (act === 'newshelf') {
      const name = (prompt('Nombre de la nueva estantería:') || '').trim();
      if (name) { const sh = await Store.addShelf(name); await Store.toggleBookShelf(id, sh.id, true); }
    } else if (act === 'delete') {
      if (!confirm(`¿Eliminar "${book.title}" de la biblioteca? Esto borra el archivo guardado.`)) return;
      await Store.deleteBook(id);
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
