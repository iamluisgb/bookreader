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
  const bins = new Map();   // ruta → bytes de un fichero por bloques (writeBlocks), en claro

  function put(path, content) {
    const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    store.set(path, { content: text, etag: etagOf(text), modifiedTime });
  }

  for (const [path, content] of Object.entries(files)) put(path, content);

  return {
    /** Ficheros del proveedor, ordenados (para inspección en tests). */
    paths() {
      return [...store.keys(), ...bins.keys()].sort();
    },
    async list(prefix = '') {
      return [
        ...[...store.entries()].map(([path, f]) => ({ path, etag: f.etag, modifiedTime: f.modifiedTime, size: f.content.length })),
        ...[...bins.entries()].map(([path, b]) => ({ path, etag: etagOf(String(b.length) + path), modifiedTime, size: b.length })),
      ]
        .filter((f) => f.path.startsWith(prefix))
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
      bins.delete(path);
    },
    // Ficheros por bloques (el almacén de pasajes del índice, IA10): aquí van en claro,
    // concatenados; `offsets` dice dónde empieza cada uno.
    async writeBlocks(path, blocks) {
      const offsets = [0];
      for (const b of blocks) offsets.push(offsets[offsets.length - 1] + b.length);
      const body = new Uint8Array(offsets[offsets.length - 1]);
      blocks.forEach((b, i) => body.set(b, offsets[i]));
      bins.set(path, body);
      return { etag: etagOf(String(body.length) + path), offsets };
    },
    async readBlocks(path, specs) {
      const body = bins.get(path);
      if (!body) return null;
      const dec = new TextDecoder();
      return specs.map(({ offset, length }) => dec.decode(body.subarray(offset, offset + length)));
    },
  };
}

/** Huella barata y determinista (djb2): solo tiene que cambiar cuando cambia el contenido. */
export function etagOf(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return String(h >>> 0);
}
