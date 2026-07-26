// fetch con techo de tiempo, compartido por el proveedor de Drive y el auth. Un fetch sin
// abort que se cuelga (red inestable, portal cautivo, servidor lento) dejaba el ciclo de
// sync colgado PARA SIEMPRE: el badge "Sincronizando…" no se limpiaba nunca y el Web Lock
// quedaba retenido, así que ninguna pestaña podía volver a sincronizar hasta recargar. Con
// abort, la petición estancada falla → el ciclo lanza error → syncNow pasa a 'error', libera
// el lock y el intervalo reintenta más tarde.

export const REQUEST_TIMEOUT_MS = 30000;
// Techo por TROZO de una transferencia de fichero. El de 30 s es correcto para
// un JSON pequeño y letal para un EPUB de 40 MB: aplicado al fichero entero
// abortaría cualquier libro grande en una conexión normal. Se aplica por chunk
// de subida (CHUNK_SIZE en drive-provider) y como INACTIVIDAD en la bajada.
export const TRANSFER_TIMEOUT_MS = 120000;

export async function fetchWithTimeout(url, options = {}, ms = REQUEST_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      const err = new Error('Tiempo de espera de red agotado');
      err.code = 'timeout';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export function timeoutError() {
  const err = new Error('Tiempo de espera de red agotado');
  err.code = 'timeout';
  return err;
}

// Descarga con progreso y timeout de INACTIVIDAD (no de duración total): el
// reloj se reinicia con cada trozo recibido, así una descarga larga pero viva
// nunca se aborta y una estancada muere en TRANSFER_TIMEOUT_MS.
// Devuelve un ArrayBuffer. `onProgress(loaded, total)` — total 0 si el servidor
// no manda Content-Length.
export async function fetchArrayBuffer(url, options = {}, onProgress = null, idleMs = TRANSFER_TIMEOUT_MS) {
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), idleMs);
  const kick = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(), idleMs);
  };
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok || !res.body || !onProgress) {
      // Sin cuerpo legible (o sin interés en el progreso) el propio arrayBuffer()
      // resuelve; el abort sigue armado por si se cuelga a mitad.
      const buf = res.ok ? await res.arrayBuffer() : null;
      return { ok: res.ok, status: res.status, buffer: buf };
    }
    const total = Number(res.headers.get('Content-Length') || 0);
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      kick();
      chunks.push(value);
      loaded += value.byteLength;
      onProgress(loaded, total);
    }
    const out = new Uint8Array(loaded);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.byteLength; }
    return { ok: true, status: res.status, buffer: out.buffer };
  } catch (e) {
    if (e && e.name === 'AbortError') throw timeoutError();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
