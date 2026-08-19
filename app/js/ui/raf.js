// rafThrottle — colapsa una ráfaga de eventos en un solo trabajo por frame.
//
// Para lo que REPINTA algo que debe seguir al contenido (una capa superpuesta sobre el
// lector), no vale un debounce: esperar a que la ráfaga termine deja la capa descolgada
// mientras dura el gesto. Y sin nada, un `resize` dispara decenas de eventos por segundo
// y cada uno mide y repinta. Un frame es exactamente el ritmo al que la pantalla se
// actualiza: más llamadas no se ven, menos se notan.
//
// El re-paginado del EPUB sí va con debounce (epub-reader.js) y es otra cosa: allí lo que
// interesa es el estado final, no seguir el gesto.
export function rafThrottle(fn) {
  let pendiente = 0;
  return function throttled(...args) {
    if (pendiente) return;
    pendiente = requestAnimationFrame(() => {
      pendiente = 0;
      fn.apply(this, args);
    });
  };
}
