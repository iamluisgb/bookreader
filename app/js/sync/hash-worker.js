// Worker que hashea un Blob sin tocar el hilo principal. El Blob viaja por
// referencia (structured clone no copia sus bytes), así que mandarlo aquí es
// gratis por grande que sea el libro.

import { sha256Blob } from './sha256.js';

self.onmessage = async (e) => {
  try {
    self.postMessage({ hash: await sha256Blob(e.data) });
  } catch (err) {
    self.postMessage({ error: (err && err.message) || 'hash' });
  }
};
