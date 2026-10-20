// Trocear un libro sin abrir el lector: parsea el EPUB/PDF guardado (sin IA) y deja en
// IndexedDB el texto anotado y las anclas, como al abrirlo (DB.saveSegmented). Lo usan el
// estudio (una tarjeta llegada por sync sin libro troceado aquí) y la cola de texto para
// agentes (sync/book-text.js · fill), que trocea en segundo plano los libros nunca abiertos.

import * as DB from './db.js';
import * as Store from '../library/store.js';
import { t } from '../i18n.js';
import { segmentBook } from './segment.js';
import { segmentPdf } from './segment-pdf.js';
import { loadEpubJs, loadPdfJs } from '../vendor-loader.js';

const inFlight = new Map();   // bookId → Promise<boolean> (dos que piden el mismo libro esperan al mismo)

// true si el libro queda troceado (ya lo estaba o se acaba de trocear); false si el fichero
// no está en este dispositivo o no se pudo parsear.
export async function ensureSegmented(bookId, onStatus) {
  if (!bookId) return false;
  if (await DB.loadSegmented(bookId)) return true;
  if (inFlight.has(bookId)) return inFlight.get(bookId);
  const job = (async () => {
    try {
      const record = await Store.getBook(bookId);
      if (!record || !Store.hasFile(record)) return false;
      onStatus?.(t('Preparando el libro…'));
      const buf = record.file instanceof ArrayBuffer ? record.file.slice(0) : await record.file.arrayBuffer();
      let seg;
      if (record.format === 'pdf') {
        const pdfjs = await loadPdfJs();
        const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
        try { seg = await segmentPdf(doc, onStatus); } finally { doc.destroy(); }
      } else {
        const ePub = await loadEpubJs();
        const book = ePub(buf);
        try { seg = await segmentBook(book, onStatus); } finally { book.destroy?.(); }
      }
      await DB.saveSegmented(bookId, record.title, seg);
      return true;
    } catch { return false; }
  })();
  inFlight.set(bookId, job);
  try { return await job; } finally { inFlight.delete(bookId); }
}
