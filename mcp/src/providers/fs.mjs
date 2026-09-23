// providers/fs.mjs — proveedor de disco: una carpeta con el layout tal cual lo escribe el
// sync (bookreader/manifest.json, settings.json, books/<id>.json).
//
// Para qué sirve: probar la fuente F2 sin credenciales (y sin exponer el Drive de nadie).
// Basta con copiar la carpeta `bookreader/` del appDataFolder —o un export hecho con las
// DevTools— y apuntar el MCP ahí. Lo que NO demuestra: ni el OAuth, ni el formato real de
// las respuestas de Drive, ni los etags. Eso lo cubre el proveedor de verdad.
//
// Confinamiento: `path` sale de un manifest remoto, así que toda ruta se resuelve y se
// comprueba que sigue dentro de `root`. Un `..` en el manifest no puede sacar al MCP de la
// carpeta que el usuario eligió.

import { readFile as fsReadFile, readdir as fsReaddir } from 'node:fs/promises';
import { resolve, sep, join, relative } from 'node:path';
import { SourceError } from '../errors.mjs';

export function createFsProvider({
  root,
  readFile = fsReadFile,
  readdir = fsReaddir,
  modifiedTime = '1970-01-01T00:00:00.000Z',
} = {}) {
  if (!root) throw new SourceError('createFsProvider necesita un `root`.');
  const base = resolve(root);

  function confined(relPath) {
    const target = resolve(base, relPath);
    if (target !== base && !target.startsWith(base + sep)) {
      throw new SourceError('Ruta fuera de la carpeta del layout: ' + relPath);
    }
    return target;
  }

  return {
    async list(prefix = '') {
      const out = [];
      async function walk(dir) {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return; // carpeta ausente o sin permisos: el layout simplemente no tiene eso
        }
        for (const e of entries) {
          const full = join(dir, e.name);
          if (e.isDirectory()) await walk(full);
          else if (e.isFile()) {
            const rel = relative(base, full).split(sep).join('/');
            if (rel.startsWith(prefix)) out.push({ path: rel, etag: null, modifiedTime, size: 0 });
          }
        }
      }
      await walk(base);
      return out.sort((a, b) => (a.path < b.path ? -1 : 1));
    },
    async read(path) {
      try {
        return { content: await readFile(confined(path), 'utf8'), etag: null, modifiedTime };
      } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'EISDIR') return null;
        throw e;
      }
    },
  };
}
