const PREFIX = 'bookreader_';

export function get(key, defaultValue = null) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw !== null ? JSON.parse(raw) : defaultValue;
  } catch {
    return defaultValue;
  }
}

// La cadena cruda, sin parsear. La usa quien memoiza un parseo caro y necesita saber si
// lo guardado sigue siendo lo mismo (ver highlights.js).
export function raw(key) {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function set(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch (e) {
    console.warn('Storage full or unavailable:', e);
  }
}

export function remove(key) {
  localStorage.removeItem(PREFIX + key);
}

export function getAll(prefix = '') {
  const result = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key.startsWith(PREFIX + prefix)) {
      const shortKey = key.slice(PREFIX.length);
      try {
        result[shortKey] = JSON.parse(localStorage.getItem(key));
      } catch {
        result[shortKey] = localStorage.getItem(key);
      }
    }
  }
  return result;
}
