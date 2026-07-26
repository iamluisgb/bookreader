// Sync de BIBLIOTECA (Fase A): los metadatos de cada libro y las estanterías
// viajan entre dispositivos aunque el fichero no. Es lo que convierte el sync de
// anotaciones en una biblioteca de verdad, estilo Play Books: el libro que
// importaste en el portátil APARECE en el móvil (ficha fantasma) y desde ahí se
// descarga bajo demanda.
//
// Antes de esto el agujero era visible: los subrayados de un libro llegaban al
// otro dispositivo, pero el libro no existía en su biblioteca. Datos huérfanos
// sin nada a lo que engancharse.
//
// DOS ficheros, no uno, y la razón es el ritmo de escritura:
//
//   library.json  metadatos LIGEROS (título, autor, progreso, estado,
//                 estanterías, puntero al binario). Cambia constantemente
//                 —el progreso se mueve al leer— así que se reescribe a menudo
//                 y tiene que ser barato.
//   covers.json   las portadas (dataURL). Son ~90% del peso y solo cambian al
//                 añadir o quitar libros. Metidas en library.json, cada avance
//                 de página habría reescrito cientos de KB.
//
// El manifest lleva `libraryUpdatedAt`/`coversUpdatedAt` para saber si hay que
// bajarlos, sin leerlos en cada ciclo.

import * as LibStore from '../library/store.js';
import { mergeMaps } from './merge.js';

export const LIBRARY_FILE = 'library.json';
export const COVERS_FILE = 'covers.json';
export const SCHEMA_VERSION = 1;

// Ancho de la miniatura que viaja. Las tarjetas de la rejilla se pintan a ~160px
// de ancho; guardar la portada original (a veces 1400px y 400 KB) multiplicaba
// por cincuenta el tamaño de covers.json sin que se notara en pantalla.
const THUMB_WIDTH = 200;
const THUMB_QUALITY = 0.72;

// Campos que solo conoce quien tiene el fichero: no se pierden porque el otro
// lado gane el LWW por haber tocado el progreso (ver mergeMaps · monotone).
const MONOTONE = ['title', 'author', 'format', 'fileName', 'fileBaseId', 'size', 'blob', 'addedAt'];

// ---- Miniaturas -------------------------------------------------------------

// Re-encoda una portada a JPEG estrecho. Devuelve null si no se puede (dataURL
// inválida, canvas bloqueado): la ficha fantasma se pinta igual con iniciales.
export function makeThumb(dataUrl, width = THUMB_WIDTH) {
  return new Promise((resolve) => {
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) return resolve(null);
    const img = new Image();
    img.onload = () => {
      try {
        if (!img.naturalWidth || !img.naturalHeight) return resolve(null);
        if (img.naturalWidth <= width && dataUrl.length < 24000) return resolve(dataUrl);
        const scale = Math.min(1, width / img.naturalWidth);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', THUMB_QUALITY));
      } catch (e) {
        resolve(null); // canvas "tainted" u otro fallo: no es motivo para romper el sync
      }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

// Miniatura del libro, calculada una vez y cacheada en su registro. Sin la caché
// se re-encodaría cada portada en CADA ciclo de sync (decodificar + pintar +
// exportar, por libro, cada 90 segundos).
async function thumbFor(record) {
  if (record.coverThumb) return record.coverThumb;
  if (!record.cover) return null;
  const thumb = await makeThumb(record.cover);
  if (thumb) {
    // stamp:false — la miniatura es un detalle de representación, no un cambio
    // del libro: no debe bumpear updatedAt ni ganar merges ajenos.
    await LibStore.putBook({ ...record, coverThumb: thumb }, { stamp: false });
  }
  return thumb;
}

// ---- Construcción del snapshot ---------------------------------------------

// Solo lo sincronizable. `file` (el binario) y `lastOpenedAt`/`lastCfi` (locales
// de cada dispositivo) se quedan fuera a propósito.
function bookEntry(b) {
  return {
    title: b.title || '', author: b.author || '', format: b.format || '',
    fileName: b.fileName || '', fileBaseId: b.fileBaseId || '',
    size: b.size || 0, addedAt: b.addedAt || 0,
    status: b.status || 'unread', progress: b.progress || 0,
    shelfIds: b.shelfIds || [],
    blob: b.blob || null,
    deleted: !!b.deleted, deletedAt: b.deletedAt || 0,
    updatedAt: b.updatedAt || 0,
  };
}

function shelfEntry(s) {
  return {
    name: s.name || '', createdAt: s.createdAt || 0,
    deleted: !!s.deleted, deletedAt: s.deletedAt || 0,
    updatedAt: s.updatedAt || s.createdAt || 0,
  };
}

export async function buildLibrary() {
  const [books, shelves] = await Promise.all([LibStore.getAllRecords(), LibStore.getAllShelfRecords()]);
  const out = { schemaVersion: SCHEMA_VERSION, books: {}, shelves: {} };
  for (const b of books) if (b && b.id) out.books[b.id] = bookEntry(b);
  for (const s of shelves) if (s && s.id) out.shelves[s.id] = shelfEntry(s);
  return out;
}

export async function buildCovers() {
  const books = await LibStore.getAllRecords();
  const covers = {};
  for (const b of books) {
    if (!b || !b.id || b.deleted) continue;
    const thumb = await thumbFor(b);
    if (thumb) covers[b.id] = thumb;
  }
  return { schemaVersion: SCHEMA_VERSION, covers };
}

// ---- Merge ------------------------------------------------------------------

// Fusiona el library.json remoto con lo local y ESCRIBE el resultado. Devuelve
// cuántos registros cambiaron.
//
// Nunca borra el binario local: si el remoto gana el LWW de un libro que aquí
// está descargado, se queda con los metadatos remotos y el `file` de siempre.
export async function applyLibrary(remote) {
  if (!remote || typeof remote !== 'object') return 0;
  const [localBooks, localShelves] = await Promise.all([LibStore.getAllRecords(), LibStore.getAllShelfRecords()]);

  const localBookMap = {};
  const byId = {};
  for (const b of localBooks) { localBookMap[b.id] = bookEntry(b); byId[b.id] = b; }
  const localShelfMap = {};
  const shelfById = {};
  for (const s of localShelves) { localShelfMap[s.id] = shelfEntry(s); shelfById[s.id] = s; }

  const mergedBooks = mergeMaps(localBookMap, remote.books || {}, { monotone: MONOTONE });
  const mergedShelves = mergeMaps(localShelfMap, remote.shelves || {}, { monotone: ['name', 'createdAt'] });

  let changed = 0;
  for (const [id, entry] of Object.entries(mergedBooks)) {
    const cur = byId[id];
    if (cur && JSON.stringify(bookEntry(cur)) === JSON.stringify(entry)) continue;
    if (entry.deleted) {
      // El borrado llegó de otro dispositivo: suelta el binario y la portada
      // aquí también, que es lo que ocupa, y conserva el tombstone.
      await LibStore.putBook({
        id, title: entry.title, format: entry.format, blob: entry.blob || null,
        deleted: true, deletedAt: entry.deletedAt, updatedAt: entry.updatedAt,
      }, { stamp: false });
    } else {
      // Lo LOCAL manda en lo local: partir del registro de aquí y aplicar
      // encima solo los campos sincronizables. Así el binario descargado, la
      // portada, la última posición y cuándo lo abriste en este dispositivo
      // —nada de lo cual viaja— sobreviven al merge.
      await LibStore.putBook({ ...(cur || { id }), ...entry, id }, { stamp: false });
    }
    changed++;
  }

  for (const [id, entry] of Object.entries(mergedShelves)) {
    const cur = shelfById[id];
    if (cur && JSON.stringify(shelfEntry(cur)) === JSON.stringify(entry)) continue;
    await LibStore.putShelf({ ...(cur || {}), ...entry, id });
    changed++;
  }
  return changed;
}

// Portadas de libros que aquí no tienen ninguna (fichas fantasma recién
// llegadas). Unión pura: la portada es inmutable y va indexada por el hash del
// libro, así que no hay conflicto posible ni hace falta LWW.
export async function applyCovers(remote) {
  const covers = (remote && remote.covers) || {};
  if (!Object.keys(covers).length) return 0;
  const books = await LibStore.getAllRecords();
  let changed = 0;
  for (const b of books) {
    if (!b || b.deleted || b.cover || !covers[b.id]) continue;
    await LibStore.putBook({ ...b, cover: covers[b.id], coverThumb: covers[b.id] }, { stamp: false });
    changed++;
  }
  return changed;
}
