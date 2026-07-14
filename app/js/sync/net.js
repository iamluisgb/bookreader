// fetch con techo de tiempo, compartido por el proveedor de Drive y el auth. Un fetch sin
// abort que se cuelga (red inestable, portal cautivo, servidor lento) dejaba el ciclo de
// sync colgado PARA SIEMPRE: el badge "Sincronizando…" no se limpiaba nunca y el Web Lock
// quedaba retenido, así que ninguna pestaña podía volver a sincronizar hasta recargar. Con
// abort, la petición estancada falla → el ciclo lanza error → syncNow pasa a 'error', libera
// el lock y el intervalo reintenta más tarde.

export const REQUEST_TIMEOUT_MS = 30000;

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
