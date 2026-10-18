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
let buildAlArrancar = null;     // promesa del commit servido al ARRANCAR: el del código que corre
async function leerBuild() {
  // En local no hay build.json (lo escribe el despliegue): pedirlo solo ensucia la consola con un 404.
  if (/^(localhost|127\.|\[::1\])/.test(location.hostname)) return '';
  try {
    const r = await fetch('/build.json', { cache: 'no-store' });
    const j = (r.ok && (r.headers.get('content-type') || '').includes('json')) ? await r.json() : null;
    return j && /^[0-9a-f]{40}$/.test(j.commit) ? j.commit : '';
  } catch { return ''; }
}
export async function buildVersion() {
  if (buildStamp !== undefined) return buildStamp;
  buildAlArrancar ||= leerBuild();
  buildStamp = (await buildAlArrancar).slice(0, 7);
  return buildStamp;
}

// En móvil la PWA queda viva en segundo plano días y al volver NO recarga el JS: seguía
// ejecutando una versión vieja mientras el menú (que pedía build.json al abrirse) decía la
// nueva. Se fija el commit al arrancar y, al volver a primer plano, se compara con el servido:
// si difiere, `onNueva()` avisa. Como mucho una consulta cada 30 s.
export function vigilarBuild(onNueva) {
  buildAlArrancar ||= leerBuild();
  let ultima = 0, avisado = false;
  const comprobar = async () => {
    if (avisado || Date.now() - ultima < 30000) return;
    ultima = Date.now();
    const base = await buildAlArrancar;
    if (!base) return;
    const ahora = await leerBuild();
    if (ahora && ahora !== base) { avisado = true; onNueva(); }
  };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') comprobar(); });
  avisoDesfase = onNueva;
  // Red para las cargas diferidas que no pasan por `cargar` (un `await import()` dentro de un
  // manejador): su rechazo llega aquí sin capturar.
  window.addEventListener('unhandledrejection', (e) => {
    if (!esDesfase(e.reason)) return;
    e.preventDefault();
    console.warn('código desfasado:', e.reason);
    avisarDesfase();
  });
}

// CÓDIGO DESFASADO. Si se despliega con la app abierta, la página conserva en memoria los
// módulos que cargó al arrancar (el navegador los guarda por URL y no los vuelve a pedir), pero
// los que se cargan al pulsar algo (Análisis, Mazos…) llegan NUEVOS. Si el nuevo importa algo
// que el viejo no exporta, la importación falla y el botón no hace nada: el error solo se veía
// en la consola. Se reconoce por el SyntaxError de enlazado (cada motor lo redacta a su manera)
// o por el fallo de red de un módulo, y se avisa con el mismo «Hay una versión nueva ·
// Actualizar»: recargar es lo único que lo arregla.
const RE_DESFASE = /does not provide an export|import not found|binding name .* is not found|dynamically imported module|Importing a module script failed/i;
export function esDesfase(err) {
  return !!err && (err instanceof SyntaxError || RE_DESFASE.test(String(err.message || err)));
}
let avisoDesfase = null;
let ultimoAviso = 0;
function avisarDesfase() {
  if (!avisoDesfase || Date.now() - ultimoAviso < 3000) return;   // un toque, un aviso
  ultimoAviso = Date.now();
  avisoDesfase();
}

// Carga diferida de un módulo para una acción del usuario: `cargar(() => import('./x.js'), 'x')`.
// Si falla por código desfasado, avisa para actualizar; nunca rechaza (la promesa se queda
// pendiente), así quien llama solo escribe el `.then` del caso bueno.
export function cargar(loader, etiqueta) {
  return loader().catch((err) => {
    console.warn(`${etiqueta}:`, err);
    if (esDesfase(err)) avisarDesfase();
    return new Promise(() => {});
  });
}
