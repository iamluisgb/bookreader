// providers/memory.mjs — proveedor simulado en memoria, con la MISMA interfaz que el de
// Drive ({ list, read, write, remove }). Es lo que permite probar la fuente F2 (con su
// manifest, su settings.json y sus books/<id>.json) sin credenciales y sin red.
//
// El etag es una huella determinista del contenido, para que los tests puedan comprobar que
// una escritura invalida la caché igual que lo haría un fichero nuevo en Drive.

const DEFAULT_MODIFIED = '2026-09-22T10:00:00.000Z';

export function createMemoryProvider(files = {}, { modifiedTime = DEFAULT_MODIFIED } = {}) {
  /** @type {Map<string, { content: string, etag: string, modifiedTime: string }>} */
  const store = new Map();

  function put(path, content) {
    const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    store.set(path, { content: text, etag: etagOf(text), modifiedTime });
  }

  for (const [path, content] of Object.entries(files)) put(path, content);

  return {
    /** Ficheros del proveedor, ordenados (para inspección en tests). */
    paths() {
      return [...store.keys()].sort();
    },
    async list(prefix = '') {
      return [...store.entries()]
        .filter(([path]) => path.startsWith(prefix))
        .map(([path, f]) => ({
          path,
          etag: f.etag,
          modifiedTime: f.modifiedTime,
          size: f.content.length,
        }))
        .sort((a, b) => (a.path < b.path ? -1 : 1));
    },
    async read(path) {
      const f = store.get(path);
      return f ? { content: f.content, etag: f.etag, modifiedTime: f.modifiedTime } : null;
    },
    async write(path, content) {
      put(path, content);
      return { etag: store.get(path).etag };
    },
    async remove(path) {
      store.delete(path);
    },
  };
}

/** Huella barata y determinista (djb2): solo tiene que cambiar cuando cambia el contenido. */
export function etagOf(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return String(h >>> 0);
}
