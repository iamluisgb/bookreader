// Marca de BookReader (el imagotipo de icons/icon.svg) para pintarla en la interfaz. No es un
// icono del set (ui/icons.js): no significa una acción, es la identidad. Sus colores salen de
// los tokens --logo-tile / --logo-page / --brand, así se invierte con el tema.
//
// Vive en la biblioteca, la pantalla de entrada (auditoría de la cabecera, Q2: el lector ya no
// la usa como botón de volver).
export function brandMark(size = 24, cls = 'brand-mark') {
  return `<svg class="${cls}" viewBox="0 0 512 512" width="${size}" height="${size}" aria-hidden="true" focusable="false">`
    + '<rect width="512" height="512" rx="118" fill="var(--logo-tile)"/>'
    + '<path d="M288 119 Q288 99 308 99 L396 99 Q416 99 416 119 L416 371 L352 323 L288 371 Z" fill="var(--brand)"/>'
    + '<path d="M98 90 L222 90 Q256 90 256 124 L256 470 C 249 442 233 424 206 414 C 177 403 140 401 100 401 Q64 401 64 365 L64 124 Q64 90 98 90 Z" fill="var(--logo-page)"/>'
    + '</svg>';
}

// Logo + nombre. El nombre es marca: no se traduce.
export function brandLockup(size = 24) {
  return `<div class="brand-lockup">${brandMark(size)}<span class="brand-name">BookReader</span></div>`;
}

// Logo de carga al abrir un libro (UX: «estados de transición»). Solo aparece si la carga
// pasa de ~300 ms: en las rápidas, un logo que destella es ruido. Se va solo cuando el libro
// entra en lectura (body.reading) o se vuelve a la biblioteca, y nunca bloquea: debajo de la
// cabecera y sin capturar clics, así «‹ Biblioteca» sigue sirviendo para salir.
export function startBookSplash({ delay = 300, max = 20000 } = {}) {
  const body = document.body;
  if (body.classList.contains('reading')) return () => {};   // de un libro a otro: sin logo
  let el = null;
  const timer = setTimeout(() => {
    el = document.createElement('div');
    el.className = 'book-splash';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = brandMark(56);
    body.appendChild(el);
  }, delay);
  const stop = () => {
    clearTimeout(timer); clearTimeout(cap); obs.disconnect();
    if (!el) return;
    const gone = el; el = null;
    gone.classList.add('is-out');
    setTimeout(() => gone.remove(), 250);
  };
  // La biblioteca sigue a la vista al arrancar (se oculta justo después): solo cuenta VOLVER
  // a ella, no estar todavía en ella.
  let leftLibrary = !body.classList.contains('in-library');
  const obs = new MutationObserver(() => {
    const inLib = body.classList.contains('in-library');
    if (!inLib) leftLibrary = true;
    if (body.classList.contains('reading') || (inLib && leftLibrary)) stop();
  });
  obs.observe(body, { attributes: true, attributeFilter: ['class'] });
  const cap = setTimeout(stop, max);
  return stop;
}

// Pie del menú «Más»: quién hace la app y qué versión corre. La versión es el commit del
// build (build.json, lo escribe scripts/build-pages.mjs); en local no existe y no se muestra.
let buildStamp;
export async function buildVersion() {
  if (buildStamp !== undefined) return buildStamp;
  try {
    const r = await fetch('/build.json', { cache: 'no-store' });
    const j = (r.ok && (r.headers.get('content-type') || '').includes('json')) ? await r.json() : null;
    buildStamp = j && /^[0-9a-f]{40}$/.test(j.commit) ? j.commit.slice(0, 7) : '';
  } catch { buildStamp = ''; }
  return buildStamp;
}
