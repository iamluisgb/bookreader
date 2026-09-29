// Tarjetas visuales (WU4b): DETECCIÓN y EXTRACCIÓN de figuras en EPUB. Un EPUB es un ZIP:
// las figuras son entradas de imagen referenciadas desde los capítulos XHTML. Este módulo
// resuelve las referencias, lee las imágenes como data URLs y persiste con `save`
// inyectada (en producción saveFigure de figures.js con page/rect null y source 'epub').
//
// Todo el IO va INYECTADO: el caller provee las entradas del zip y las funciones de
// lectura (zipReader sobre la instancia de JSZip). Sin dependencia del reader ni de
// jszip: el módulo solo conoce contratos, así se testea offline importándolo en la página.
// Sin UI ni llamadas al LLM (la validación/labels viven en figures.js).

// Descarta iconos, viñetas y separadores: ninguna figura real pesa menos que esto.
export const MIN_IMAGE_BYTES = 8 * 1024;

// Extensiones de imagen reconocidas → MIME del data URL. La clave es la extensión en
// minúsculas (la comparación es case-insensitive).
const IMAGE_MIMES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

// Extensión de la ruta (sin query ni fragmento, case-insensitive). '' si no tiene:
// 'img/a.png?v=2' → 'png', 'img/.hidden' → '', 'img/a.svg#f' → 'svg'.
function extOf(path) {
  const clean = String(path ?? '').split('#')[0].split('?')[0];
  const name = clean.slice(clean.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot + 1).toLowerCase();
}

// ¿La ruta parece de imagen? Sin query/fragmento, case-insensitive.
export function isImagePath(path) {
  return Object.hasOwn(IMAGE_MIMES, extOf(path));
}

// MIME de la imagen según su extensión; '' si la ruta no es imagen.
export function mimeOf(path) {
  return IMAGE_MIMES[extOf(path)] || '';
}

// ¿Capítulo XHTML/HTML? (los que se escanean en busca de referencias a imágenes).
function isChapterPath(path) {
  return /\.(xhtml|html|htm)$/i.test(String(path ?? ''));
}

// Resuelve un href de un capítulo a la ruta DENTRO del zip. basePath es la ruta del
// XHTML ('OEBPS/xhtml/ch1.xhtml'). Normaliza: sin './', sin '../' colgando (se clampea
// en la raíz), sin barras dobles, sin query ni fragmento. Casos:
//   '../images/a.jpg'      → relativo al directorio del capítulo
//   './img/b.png'          → ídem
//   '/OEBPS/img/c.png'     → raíz del zip ('/' inicial)
//   'OEBPS/img/d.png'      → ruta del zip completa SIN '/' inicial. No hay forma de
//       distinguirla de una relativa pura, así que se usa una heurística: si el primer
//       segmento del href coincide con el primer segmento del basePath (mismo directorio
//       raíz que el capítulo, p.ej. 'OEBPS/…'), se toma desde la raíz. Un href relativo
//       genuino hacia un subdirectorio del propio árbol del capítulo pasa por '../'.
// Devuelve '' para URLs externas o embebidas (http:, https:, data:, blob: y cualquier
// otro esquema) y para hrefs vacíos o de solo fragmento.
export function resolveHref(basePath, href) {
  const raw = String(href ?? '').trim();
  if (!raw) return '';
  // Esquema absoluto ⇒ recurso externo o embebido: nada que buscar en el zip.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return '';
  const clean = raw.split('#')[0].split('?')[0];
  if (!clean) return '';
  const segments = clean.split('/');
  const baseSegs = String(basePath ?? '').split('/');
  // '/' inicial o primer segmento compartido con el capítulo ⇒ href ya es ruta del zip.
  const fromRoot = clean.startsWith('/') || (!!segments[0] && segments[0] === baseSegs[0]);
  const stack = fromRoot ? [] : baseSegs.slice(0, -1);
  for (const seg of clean.split('/')) {
    if (!seg || seg === '.') continue;      // vacíos ('//' o './') y '.': se omiten
    if (seg === '..') { stack.pop(); continue; } // '..' en la raíz: no-op (clampeo)
    stack.push(seg);
  }
  return stack.join('/');
}

// Recoge TODAS las referencias a imágenes de un capítulo: <img src>, <image xlink:href>
// y <image href> (SVG inline). Usa DOMParser en modo 'text/html' (tolerante: los XHTML
// reales a veces traen basura; el parser HTML también entiende SVG embebido). Devuelve
// [{ path, chapterPath }] con la ruta ya resuelta; las referencias sin ruta válida
// (externas, data:, vacías) se descartan. NO deduplica: el colector necesita ver todas.
export function refsFromXhtml(html, { chapterPath } = {}) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(String(html ?? ''), 'text/html');
  } catch {
    return [];
  }
  const chapter = chapterPath || '';
  const refs = [];
  // 'image' cubre el <image> de SVG; el <image> fuera de SVG el parser HTML ya lo volvió
  // img. xlink:href llega con namespace, pero getAttribute('xlink:href') lo encuentra.
  for (const el of doc.querySelectorAll('img, image')) {
    const raw = el.localName === 'img'
      ? el.getAttribute('src')
      : (el.getAttribute('href') || el.getAttribute('xlink:href'));
    const path = resolveHref(chapter, raw);
    if (path) refs.push({ path, chapterPath: chapter });
  }
  return refs;
}

// Lista las entradas de fichero del zip: [{ path, size }]. zip es una instancia de JSZip
// (o cualquier objeto con .files). Los directorios se ignoran; size sale de
// entry._data.uncompressedSize si existe (zips cargados con loadAsync), si no 0 — el
// colector trata size 0 como "desconocido, no descartar".
export function entriesFromZip(zip) {
  const files = zip && zip.files;
  if (!files || typeof files !== 'object') return [];
  const out = [];
  for (const path of Object.keys(files)) {
    const entry = files[path];
    if (!entry || entry.dir) continue;
    const raw = entry._data && entry._data.uncompressedSize;
    out.push({ path, size: typeof raw === 'number' && Number.isFinite(raw) ? raw : 0 });
  }
  return out;
}

// AbortError sin DOM: Error con name 'AbortError', la convención que espera el caller.
function abortError() {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

const isAbort = (err) => !!err && (err.name === 'AbortError' || err.code === 'AbortError');

// IO mínimo sobre el zip: { readText, readImage }. Ambas NUNCA lanzan (devuelven '' si
// la entrada no existe o la lectura falla) para que el colector pueda omitir y seguir.
// readImage devuelve 'data:<mime>;base64,...' con el MIME según la extensión.
export function zipReader(zip) {
  const file = (path) => {
    try {
      return zip && typeof zip.file === 'function' ? zip.file(path) : null;
    } catch {
      return null;
    }
  };
  return {
    async readText(path) {
      const f = file(path);
      if (!f) return '';
      try {
        return await f.async('string');
      } catch {
        return '';
      }
    },
    async readImage(path) {
      const f = file(path);
      if (!f) return '';
      const mime = mimeOf(path);
      if (!mime) return '';
      try {
        const b64 = await f.async('base64');
        return b64 ? `data:${mime};base64,${b64}` : '';
      } catch {
        return '';
      }
    },
  };
}

// Detecta y recolecta las figuras del EPUB. entries = [{ path, size }] (entriesFromZip);
// readText/readImage inyectadas (zipReader). Pasos:
//   (1) candidatas: imágenes con size >= minBytes; size 0 o desconocido NO se descarta
//       (mejor intentar la lectura y fallar que perder la figura).
//   (2) se leen los XHTML y se arma el mapa imagen→capítulo (la PRIMERA referencia gana).
//   (3) por cada imagen candidata, en el orden de las entradas, se lee el data URL; si
//       falla se omite. Dedupe por path (las entradas de un zip son únicas, pero el
//       caller puede pasar listas con repetidos).
// Devuelve [{ path, dataUrl, chapter, size }]; chapter es '' si ninguna capítulo la
// referencia. Abort (signal) ⇒ rechaza con AbortError.
export async function collectEpubFigures({ entries, readText, readImage, minBytes = MIN_IMAGE_BYTES, signal } = {}) {
  if (signal && signal.aborted) throw abortError();
  const list = Array.isArray(entries) ? entries : [];
  const readT = typeof readText === 'function' ? readText : async () => '';
  const readI = typeof readImage === 'function' ? readImage : async () => '';
  const min = Number.isFinite(minBytes) ? minBytes : MIN_IMAGE_BYTES;

  // (1) Imágenes candidatas por tamaño. size 0/desconocido pasa: puede haber figura.
  const images = list.filter((e) => {
    const path = e && typeof e.path === 'string' ? e.path : '';
    if (!path || !isImagePath(path)) return false;
    const size = Number(e.size);
    return !Number.isFinite(size) || size <= 0 || size >= min;
  });

  // (2) Mapa imagen → capítulo. Un readText que falla devuelve '' (sin refs) y se sigue.
  const chapterOf = new Map();
  for (const e of list) {
    if (signal && signal.aborted) throw abortError();
    const path = e && typeof e.path === 'string' ? e.path : '';
    if (!path || !isChapterPath(path)) continue;
    let html;
    try {
      html = await readT(path);
    } catch (err) {
      if (isAbort(err)) throw err;
      html = '';
    }
    for (const ref of refsFromXhtml(html, { chapterPath: path })) {
      if (!chapterOf.has(ref.path)) chapterOf.set(ref.path, path);
    }
  }

  // (3) Data URL por imagen, orden de las entradas. Lectura fallida ⇒ figura omitida.
  const out = [];
  const seen = new Set();
  for (const e of images) {
    if (signal && signal.aborted) throw abortError();
    const { path } = e;
    if (seen.has(path)) continue;
    seen.add(path);
    let dataUrl;
    try {
      dataUrl = await readI(path);
    } catch (err) {
      if (isAbort(err)) throw err;
      dataUrl = '';
    }
    if (signal && signal.aborted) throw abortError();
    if (typeof dataUrl !== 'string' || !dataUrl) continue;
    out.push({ path, dataUrl, chapter: chapterOf.get(path) || '', size: Number(e.size) || 0 });
  }
  return out;
}

// Envuelve collectEpubFigures y persiste cada figura con `save` (inyectada; en
// producción saveFigure de figures.js). Recorrido SECUENCIAL; onProgress({done,total})
// después de cada figura. Un save que falla va a `failed` y NO corta la corrida; un
// AbortError (signal o save) se re-lanza. Devuelve
// { saved: [{ key, path }], figures: [{ key, path, dataUrl, chapter }],
//   failed: [{ path, error }] }.
export async function extractAndSaveEpubFigures({ entries, readText, readImage, save, bookId, onProgress, signal, minBytes } = {}) {
  if (signal && signal.aborted) throw abortError();
  const collected = await collectEpubFigures({ entries, readText, readImage, minBytes, signal });
  const total = collected.length;
  const saved = [];
  const figures = [];
  const failed = [];
  let done = 0;
  for (const fig of collected) {
    if (signal && signal.aborted) throw abortError();
    try {
      const key = await save({
        bookId,
        page: null,          // un EPUB no tiene páginas: la referencia es el capítulo
        rect: null,
        dataUrl: fig.dataUrl,
        labels: [],
        caption: fig.chapter,
        source: 'epub',
      });
      saved.push({ key, path: fig.path });
      figures.push({ key, path: fig.path, dataUrl: fig.dataUrl, chapter: fig.chapter });
    } catch (err) {
      if (isAbort(err)) throw err;
      failed.push({ path: fig.path, error: String(err?.message || err) });
    }
    done++;
    onProgress?.({ done, total });
  }
  return { saved, figures, failed };
}
