const PREFIX = 'bookreader_';

export function get(key, defaultValue = null) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw !== null ? JSON.parse(raw) : defaultValue;
  } catch {
    return defaultValue;
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
