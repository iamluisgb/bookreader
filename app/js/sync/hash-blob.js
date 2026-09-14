// Hash SHA-256 de un Blob, fuera del hilo principal cuando se puede.
//
// Es la verificación de integridad de un fichero recién bajado de Drive: el
// bookId ES el hash del contenido, así que comprobarlo garantiza que los
// subrayados de los otros dispositivos enganchan. Lo que no puede es congelar
// la app mientras tanto, que es lo que pasaba con `crypto.subtle.digest` sobre
// el fichero entero (ver sha256.js).

import { sha256Blob } from './sha256.js';

// Por debajo de esto no compensa levantar un Worker: la WebCrypto resuelve en
// milisegundos y de un tirón. El umbral es el tamaño típico de un EPUB.
const WORKER_MIN = 8 * 1024 * 1024;

export async function hashBlob(blob) {
  if (blob.size < WORKER_MIN) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
      return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) { /* sin WebCrypto (contexto no seguro): abajo */ }
  }
  try {
    return await inWorker(blob);
  } catch (e) {
    // Sin Worker de módulo (Safari viejo, CSP rara): mismo cálculo aquí. Sigue
    // leyendo a trozos, así que la memoria aguanta; solo se nota el tirón.
    return sha256Blob(blob);
  }
}

function inWorker(blob) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./hash-worker.js', import.meta.url), { type: 'module' });
    const done = (fn, arg) => { worker.terminate(); fn(arg); };
    worker.onmessage = (e) => {
      const d = e.data || {};
      if (d.error) done(reject, new Error(d.error)); else done(resolve, d.hash);
    };
    worker.onerror = (e) => { e.preventDefault(); done(reject, new Error('worker')); };
    worker.postMessage(blob);
  });
}
