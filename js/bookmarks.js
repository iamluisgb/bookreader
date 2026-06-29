import * as Storage from './storage.js';

const BOOKMARKS_KEY = 'bookmarks';
let currentBookId = null;
let onChangeCallback = null;

export function setBook(bookId) {
  currentBookId = bookId;
}

export function setOnChange(cb) {
  onChangeCallback = cb;
}

function getKey() {
  return BOOKMARKS_KEY + '_' + currentBookId;
}

export function getAll() {
  return Storage.get(getKey(), []);
}

export function add(cfi, title, chapter) {
  const bookmarks = getAll();
  if (bookmarks.some(b => b.cfi === cfi)) return false;
  bookmarks.push({
    cfi,
    title: title || '',
    chapter: chapter || '',
    timestamp: Date.now()
  });
  Storage.set(getKey(), bookmarks);
  if (onChangeCallback) onChangeCallback();
  return true;
}

export function remove(cfi) {
  let bookmarks = getAll();
  bookmarks = bookmarks.filter(b => b.cfi !== cfi);
  Storage.set(getKey(), bookmarks);
  if (onChangeCallback) onChangeCallback();
}

export function has(cfi) {
  return getAll().some(b => b.cfi === cfi);
}

export function toggle(cfi, title, chapter) {
  if (has(cfi)) {
    remove(cfi);
    return false;
  } else {
    add(cfi, title, chapter);
    return true;
  }
}
