// UI de marcadores: botón de marcar página (cabecera) y lista de marcadores de la
// sidebar. Extraído de app.js (BACKLOG-TECH T8). La persistencia vive en
// bookmarks.js; aquí solo el DOM. Público: initBookmarkButton, updateBookmarkButton,
// renderBookmarks.
import * as EpubReader from './epub-reader.js';
import * as Bookmarks from './bookmarks.js';
import { icon } from './ui/icons.js';
import { escapeHtml } from './ui/escape.js';

export function initBookmarkButton() {
  document.getElementById('bookmark-toggle').addEventListener('click', () => {
    if (!EpubReader.isLoaded()) return;

    const cfi = EpubReader.getCurrentCfi();
    if (!cfi) return;

    const chapter = EpubReader.getCurrentChapterLabel();
    const title = document.getElementById('reader-title').textContent;

    Bookmarks.toggle(cfi, title, chapter);
    updateBookmarkButton();
  });

  Bookmarks.setOnChange(() => renderBookmarks());
}

export function updateBookmarkButton() {
  if (!EpubReader.isLoaded()) return;

  const btn = document.getElementById('bookmark-toggle');
  const cfi = EpubReader.getCurrentCfi();
  if (!cfi) return;

  const isBookmarked = Bookmarks.has(cfi);
  btn.innerHTML = icon('bookmark', { filled: isBookmarked });
  btn.classList.toggle('is-active', isBookmarked);
  btn.title = isBookmarked ? 'Quitar marcador' : 'Marcar página';
}

export function renderBookmarks() {
  const list = document.getElementById('bookmarks-list');
  const bookmarks = Bookmarks.getAll();

  if (bookmarks.length === 0) {
    list.innerHTML = '<p class="empty-state">No hay marcadores aún</p>';
    return;
  }

  list.innerHTML = '';
  bookmarks.sort((a, b) => b.timestamp - a.timestamp).forEach(bm => {
    const item = document.createElement('div');
    item.className = 'bookmark-item';
    item.innerHTML = `
      <div class="bookmark-info">
        <div class="bookmark-title">${escapeHtml(bm.title)}</div>
        <div class="bookmark-chapter">${escapeHtml(bm.chapter)}</div>
      </div>
      <button class="bookmark-delete" title="Eliminar">${icon('xmark', { size: 16 })}</button>
    `;

    item.querySelector('.bookmark-info').addEventListener('click', async () => {
      await EpubReader.goTo(bm.cfi);
      document.getElementById('sidebar').classList.remove('open');
    });

    item.querySelector('.bookmark-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      Bookmarks.remove(bm.cfi);
      updateBookmarkButton();
    });

    list.appendChild(item);
  });
}
