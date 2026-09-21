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

// Tamaño de cada Blob parcial de una descarga (ver fetchBinary).
const PART_SIZE = 4 * 1024 * 1024;

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
    throw annotateHost(e, url);
  } finally {
    clearTimeout(timer);
  }
}

// "Failed to fetch" no dice contra quién: DNS caído, conexión rechazada, CORS o un
// filtro de red que bloquea el dominio se ven idénticos. Anotar el host en el mensaje
// es lo que permite distinguir en el diagnóstico "no llego a Drive" de "no llego al
// Worker de auth" — la primera pista de por qué un dispositivo no sincroniza.
function annotateHost(e, url) {
  try {
    const host = new URL(url).host;
    e.host = host;
    e.message = `${e.message} [${host}]`;
  } catch (err) { /* url rara: dejar el mensaje tal cual */ }
  return e;
}

export function timeoutError() {
  const err = new Error('Tiempo de espera de red agotado');
  err.code = 'timeout';
  return err;
}

// Descarga con progreso y timeout de INACTIVIDAD (no de duración total): el
// reloj se reinicia con cada trozo recibido, así una descarga larga pero viva
// nunca se aborta y una estancada muere en TRANSFER_TIMEOUT_MS.
// Devuelve un **Blob**. `onProgress(loaded, total)` — total 0 si el servidor
// no manda Content-Length.
//
// Blob y no ArrayBuffer a propósito: los bytes de un Blob los guarda el
// navegador fuera del heap de JS (y los vuelca a disco si crecen), mientras que
// un ArrayBuffer los tiene todos en memoria. Juntando los trozos en un
// ArrayBuffer, una revista de 400 MB pedía 800 MB de pico —los trozos sueltos
// MÁS el buffer final— y el móvil mataba la pestaña a media descarga.
export async function fetchBinary(url, options = {}, onProgress = null, idleMs = TRANSFER_TIMEOUT_MS) {
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), idleMs);
  const kick = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(), idleMs);
  };
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok || !res.body || !onProgress) {
      // Sin cuerpo legible (o sin interés en el progreso) el propio blob()
      // resuelve; el abort sigue armado por si se cuelga a mitad.
      const blob = res.ok ? await res.blob() : null;
      return { ok: res.ok, status: res.status, blob };
    }
    const total = Number(res.headers.get('Content-Length') || 0);
    const reader = res.body.getReader();
    const parts = [];       // Blobs ya cerrados: sus bytes ya no están en el heap
    let pending = [];       // trozos del Blob en curso
    let pendingBytes = 0;
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      kick();
      pending.push(value);
      pendingBytes += value.byteLength;
      loaded += value.byteLength;
      // Cerrar un Blob cada PART_SIZE es lo que mantiene el heap plano: sin
      // esto los trozos se acumulan hasta el final y da igual lo que se
      // devuelva.
      if (pendingBytes >= PART_SIZE) {
        parts.push(new Blob(pending));
        pending = [];
        pendingBytes = 0;
      }
      onProgress(loaded, total);
    }
    if (pending.length) parts.push(new Blob(pending));
    return { ok: true, status: res.status, blob: new Blob(parts) };
  } catch (e) {
    if (e && e.name === 'AbortError') throw timeoutError();
    throw annotateHost(e, url);
  } finally {
    clearTimeout(timer);
  }
}
