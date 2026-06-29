import * as Storage from './storage.js';

const HIGHLIGHTS_KEY = 'highlights';
let currentBookId = null;
let onChangeCallback = null;

export function setBook(bookId) {
  currentBookId = bookId;
}

export function setOnChange(cb) {
  onChangeCallback = cb;
}

function getKey() {
  return HIGHLIGHTS_KEY + '_' + currentBookId;
}

export function getAll() {
  return Storage.get(getKey(), []);
}

export function add(cfi, text, color, chapter) {
  const highlights = getAll();
  if (highlights.some(h => h.cfi === cfi && h.color === color)) return false;
  highlights.push({
    cfi,
    text: text || '',
    color: color || '#ffeb3b',
    chapter: chapter || '',
    timestamp: Date.now()
  });
  Storage.set(getKey(), highlights);
  if (onChangeCallback) onChangeCallback();
  return true;
}

export function remove(cfi) {
  let highlights = getAll();
  highlights = highlights.filter(h => h.cfi !== cfi);
  Storage.set(getKey(), highlights);
  if (onChangeCallback) onChangeCallback();
}

export function getByCfi(cfi) {
  return getAll().find(h => h.cfi === cfi);
}

export function exportJSON(bookTitle) {
  const highlights = getAll();
  if (highlights.length === 0) return null;

  const data = {
    book: bookTitle || 'Sin título',
    bookId: currentBookId,
    exportedAt: new Date().toISOString(),
    count: highlights.length,
    highlights: highlights.map(h => ({
      text: h.text,
      color: h.color,
      chapter: h.chapter || null,
      page: h.page || null,
      cfi: h.cfi || null,
      timestamp: h.timestamp
    }))
  };

  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  const safeTitle = (bookTitle || 'book').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
  const date = new Date().toISOString().split('T')[0];
  a.href = url;
  a.download = `bookreader-highlights-${safeTitle}-${date}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  return data;
}
