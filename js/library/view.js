// Pantalla de Biblioteca: rejilla de portadas estilo Apple Books, estanterías
// (automáticas + personalizadas) y menú por libro. Lee/escribe en library/store.
import * as Store from './store.js';
import { icon } from '../ui/icons.js';

let host = null;                 // #library
let onOpenBook = () => {};
let onAddBook = () => {};
let currentShelf = 'all';        // 'all' | 'reading' | 'finished' | <shelfId>
let menuEl = null;

export function init(opts = {}) {
  host = document.getElementById('library');
  onOpenBook = opts.onOpenBook || (() => {});
  onAddBook = opts.onAddBook || (() => {});
  host.addEventListener('click', onClick);
  document.addEventListener('click', (e) => {
    if (menuEl && !menuEl.contains(e.target) && !e.target.closest('.lib-menu-btn')) closeMenu();
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

// Decide qué pantalla mostrar al arrancar: biblioteca si hay libros, si no el
// landing de "abre un archivo".
export async function hasBooks() {
  const books = await Store.getAllBooks();
  return books.length > 0;
}

export async function render() {
  if (!host) return;
  const [books, shelves] = await Promise.all([Store.getAllBooks(), Store.getShelves()]);

  // Si la estantería personalizada seleccionada ya no existe, volver a "Todos".
  if (currentShelf !== 'all' && currentShelf !== 'reading' && currentShelf !== 'finished'
      && !shelves.some(s => s.id === currentShelf)) {
    currentShelf = 'all';
  }

  const filtered = books.filter(b => {
    if (currentShelf === 'all') return true;
    if (currentShelf === 'reading') return (b.status || 'unread') === 'reading';
    if (currentShelf === 'finished') return (b.status || 'unread') === 'finished';
    return (b.shelfIds || []).includes(currentShelf);
  });

  const tabs = [
    { id: 'all', name: 'Todos' },
    { id: 'reading', name: 'Leyendo' },
    { id: 'finished', name: 'Terminados' },
    ...shelves.map(s => ({ id: s.id, name: s.name })),
  ];

  host.innerHTML = `
    <div class="lib-head">
      <h1 class="lib-h1">Biblioteca</h1>
      <button class="lib-add primary-btn">${icon('plus', { size: 18 })}<span>Añadir libro</span></button>
    </div>
    <div class="lib-shelves">
      ${tabs.map(t => `<button class="lib-shelf-tab${t.id === currentShelf ? ' active' : ''}" data-shelf="${t.id}">${escapeHtml(t.name)}</button>`).join('')}
      <button class="lib-newshelf" title="Nueva estantería">${icon('plus', { size: 16 })}</button>
    </div>
    ${filtered.length
      ? `<div class="lib-grid">${filtered.map(cardHtml).join('')}</div>`
      : emptyHtml(books.length === 0)}
  `;
}

function cardHtml(b) {
  const pct = Math.max(0, Math.min(100, Math.round(b.progress || 0)));
  const cover = b.cover
    ? `<img class="lib-cover-img" src="${b.cover}" alt="">`
    : `<div class="lib-cover-fallback"><span>${escapeHtml(initials(b.title))}</span></div>`;
  const badge = (b.status === 'finished') ? `<span class="lib-badge">${icon('check', { size: 13 })}</span>` : '';
  return `
    <div class="lib-card" data-id="${b.id}">
      <div class="lib-cover">
        ${cover}
        ${badge}
        <button class="lib-menu-btn" data-id="${b.id}" title="Más" aria-label="Más opciones">${icon('ellipsis', { size: 20 })}</button>
      </div>
      <div class="lib-bar"><span class="lib-bar-fill" style="width:${pct}%"></span></div>
      <div class="lib-title">${escapeHtml(b.title || 'Sin título')}</div>
      <div class="lib-author">${escapeHtml(b.author || '')}</div>
    </div>`;
}

function emptyHtml(noBooksAtAll) {
  return `<div class="lib-empty">
    <div class="lib-empty-icon">${icon('books', { size: 56 })}</div>
    <p>${noBooksAtAll ? 'Tu biblioteca está vacía.' : 'No hay libros en esta estantería.'}</p>
    ${noBooksAtAll ? `<button class="lib-add primary-btn">${icon('plus', { size: 18 })}<span>Añadir tu primer libro</span></button>` : ''}
  </div>`;
}

// ---- Eventos ---------------------------------------------------------------

async function onClick(e) {
  const addBtn = e.target.closest('.lib-add');
  if (addBtn) { onAddBook(); return; }

  const tab = e.target.closest('.lib-shelf-tab');
  if (tab) { currentShelf = tab.dataset.shelf; await render(); return; }

  if (e.target.closest('.lib-newshelf')) { await createShelf(); return; }

  const menuBtn = e.target.closest('.lib-menu-btn');
  if (menuBtn) { e.stopPropagation(); await openMenu(menuBtn.dataset.id, menuBtn); return; }

  const card = e.target.closest('.lib-card');
  if (card) {
    const book = await Store.getBook(card.dataset.id);
    if (book) onOpenBook(book);
  }
}

async function createShelf() {
  const name = (prompt('Nombre de la nueva estantería:') || '').trim();
  if (!name) return;
  const sh = await Store.addShelf(name);
  currentShelf = sh.id;
  await render();
}

// ---- Menú por libro --------------------------------------------------------

async function openMenu(id, anchor) {
  closeMenu();
  const [book, shelves] = await Promise.all([Store.getBook(id), Store.getShelves()]);
  if (!book) return;
  const inShelf = new Set(book.shelfIds || []);
  const finished = book.status === 'finished';

  menuEl = document.createElement('div');
  menuEl.className = 'lib-menu';
  menuEl.innerHTML = `
    <button class="lib-menu-item" data-act="open">${icon('book', { size: 16 })}<span>Abrir</span></button>
    <button class="lib-menu-item" data-act="finish">${icon('check', { size: 16 })}<span>${finished ? 'Marcar como no leído' : 'Marcar como terminado'}</span></button>
    <div class="lib-menu-sep"></div>
    <div class="lib-menu-label">Estanterías</div>
    ${shelves.length
      ? shelves.map(s => `<button class="lib-menu-item lib-menu-shelf" data-act="shelf" data-shelf="${s.id}">
          <span class="lib-menu-check">${inShelf.has(s.id) ? icon('check', { size: 16 }) : ''}</span><span>${escapeHtml(s.name)}</span></button>`).join('')
      : '<div class="lib-menu-empty">Aún no hay estanterías</div>'}
    <button class="lib-menu-item" data-act="newshelf">${icon('plus', { size: 16 })}<span>Nueva estantería…</span></button>
    <div class="lib-menu-sep"></div>
    <button class="lib-menu-item danger" data-act="delete">${icon('trash', { size: 16 })}<span>Eliminar</span></button>
  `;
  document.body.appendChild(menuEl);
  positionMenu(anchor);

  menuEl.addEventListener('click', async (ev) => {
    const item = ev.target.closest('.lib-menu-item');
    if (!item) return;
    const act = item.dataset.act;
    if (act === 'open') { closeMenu(); const b = await Store.getBook(id); if (b) onOpenBook(b); return; }
    if (act === 'finish') {
      await Store.updateBook(id, { status: finished ? (book.progress > 0 ? 'reading' : 'unread') : 'finished' });
      closeMenu(); await render(); return;
    }
    if (act === 'shelf') {
      await Store.toggleBookShelf(id, item.dataset.shelf, !inShelf.has(item.dataset.shelf));
      closeMenu(); await render(); return;
    }
    if (act === 'newshelf') {
      const name = (prompt('Nombre de la nueva estantería:') || '').trim();
      if (name) { const sh = await Store.addShelf(name); await Store.toggleBookShelf(id, sh.id, true); }
      closeMenu(); await render(); return;
    }
    if (act === 'delete') {
      closeMenu();
      if (confirm(`¿Eliminar "${book.title}" de la biblioteca? Esto borra el archivo guardado.`)) {
        await Store.deleteBook(id); await render();
      }
      return;
    }
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
