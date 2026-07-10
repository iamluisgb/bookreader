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

export function add(cfi, text, color, chapter, note = '') {
  const highlights = getAll();
  const existing = highlights.find(h => h.cfi === cfi);
  if (existing) {
    // Mismo pasaje: actualiza color y nota en vez de duplicar.
    existing.color = color || existing.color;
    if (note) existing.note = note;
    Storage.set(getKey(), highlights);
    if (onChangeCallback) onChangeCallback();
    return true;
  }
  highlights.push({
    id: cfi,                 // en EPUB el propio CFI es la identidad
    cfi,
    text: text || '',
    color: color || '#ffeb3b',
    chapter: chapter || '',
    note: note || '',
    timestamp: Date.now()
  });
  Storage.set(getKey(), highlights);
  if (onChangeCallback) onChangeCallback();
  return true;
}

// PDF3 · Subrayado de PDF. El ancla es {page, rects}, donde rects son rectángulos en
// coordenadas FRACCIONALES (0..1) de la página, para re-pintarse nítido a cualquier
// escala/HiDPI. No hay CFI. Identidad = id generado.
export function addPdf(page, rects, text, color, chapter, note = '') {
  const highlights = getAll();
  const id = 'pdf-' + page + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  highlights.push({
    id,
    page,
    rects: rects || [],
    text: text || '',
    color: color || '#ffeb3b',
    chapter: chapter || `Pág. ${page}`,
    note: note || '',
    timestamp: Date.now()
  });
  Storage.set(getKey(), highlights);
  if (onChangeCallback) onChangeCallback();
  return id;
}

// Subrayados de una página concreta (para pintar el overlay al renderizarla).
export function getByPage(page) {
  return getAll().filter(h => h.page === page);
}

// Borra por identidad genérica (id de PDF o CFI de EPUB).
export function removeById(id) {
  let highlights = getAll();
  highlights = highlights.filter(h => (h.id ?? h.cfi) !== id);
  Storage.set(getKey(), highlights);
  if (onChangeCallback) onChangeCallback();
}

export function setNote(cfi, note) {
  const highlights = getAll();
  const h = highlights.find(x => x.cfi === cfi);
  if (!h) return false;
  h.note = note;
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
      note: h.note || null,
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
