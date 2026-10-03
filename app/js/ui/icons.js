// SF Symbols-inspired line icons. Single source of truth for every glyph in the
// UI (no emoji). Each entry is the inner markup of a 24×24 SVG; the wrapper sets
// stroke: currentColor so icons inherit text colour and tint with the theme.
//
// Usage:
//   import { icon, hydrateIcons } from './ui/icons.js';
//   el.innerHTML = icon('bookmark');           // returns an <svg> string
//   hydrateIcons(root);                         // fills every [data-icon] in root

const ICONS = {
  // ——— chrome / navigation ———
  menu: '<line x1="3.5" y1="7" x2="20.5" y2="7"/><line x1="3.5" y1="12" x2="20.5" y2="12"/><line x1="3.5" y1="17" x2="20.5" y2="17"/>',
  xmark: '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>',
  'chevron-left': '<polyline points="14.5 5 8 12 14.5 19"/>',
  'chevron-right': '<polyline points="9.5 5 16 12 9.5 19"/>',
  'arrow-up-right': '<line x1="7" y1="17" x2="16.5" y2="7.5"/><polyline points="8.5 7 17 7 17 15.5"/>',
  'arrow-up': '<line x1="12" y1="19" x2="12" y2="5.5"/><polyline points="6.5 11 12 5.5 17.5 11"/>',
  'chevron-down': '<polyline points="5 9.5 12 16 19 9.5"/>',
  'chevron-up': '<polyline points="5 14.5 12 8 19 14.5"/>',
  // Subir/bajar un FICHERO: flecha sobre una bandeja. Antes `upload` era una caja con
  // flecha, el mismo dibujo que `share` (y en iOS esa caja SIGNIFICA compartir).
  upload: '<line x1="5" y1="19.5" x2="19" y2="19.5"/><path d="M12 15.5V4.5"/><polyline points="7.5 9 12 4.5 16.5 9"/>',
  download: '<line x1="5" y1="19.5" x2="19" y2="19.5"/><path d="M12 4.5V15.5"/><polyline points="7.5 11 12 15.5 16.5 11"/>',
  // Flashcards: dos tarjetas apiladas.
  cards: '<rect x="7" y="7.5" width="13" height="12" rx="2"/><path d="M4 15V6a2 2 0 0 1 2-2h9"/><line x1="10" y1="12" x2="17" y2="12"/><line x1="10" y1="15.5" x2="14.5" y2="15.5"/>',
  sort: '<line x1="5" y1="7" x2="19" y2="7"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="10" y1="17" x2="14" y2="17"/>',
  expand: '<polyline points="9 4 4 4 4 9"/><polyline points="15 4 20 4 20 9"/><polyline points="20 15 20 20 15 20"/><polyline points="4 15 4 20 9 20"/>',
  compress: '<polyline points="4 9 9 9 9 4"/><polyline points="20 9 15 9 15 4"/><polyline points="15 20 15 15 20 15"/><polyline points="9 20 9 15 4 15"/>',
  // Toggles de panel lateral (estilo NotebookLM): marco + divisor del lado.
  'panel-left': '<rect x="3.5" y="4" width="17" height="16" rx="2.3"/><line x1="9.5" y1="4" x2="9.5" y2="20"/>',
  'panel-right': '<rect x="3.5" y="4" width="17" height="16" rx="2.3"/><line x1="14.5" y1="4" x2="14.5" y2="20"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><line x1="15.8" y1="15.8" x2="20.5" y2="20.5"/>',
  // Imagotipo de la app (libro abierto: página con curl + cinta marcapáginas):
  // botón "volver a la biblioteca". Versión de línea del mark en la rejilla 24×24;
  // se tiñe con currentColor (emerald). Mark relleno en app/icons/icon.svg.

  // ——— actions ———
  bookmark: '<path d="M6.5 4.5h11a1 1 0 0 1 1 1V20l-6.5-4.3L5.5 20V5.5a1 1 0 0 1 1-1Z"/>',
  'bookmark-fill': '<path d="M6.5 4.5h11a1 1 0 0 1 1 1V20l-6.5-4.3L5.5 20V5.5a1 1 0 0 1 1-1Z" fill="currentColor" stroke="none"/>',
  share: '<path d="M12 15V4"/><polyline points="8 8 12 4 16 8"/><path d="M5 14v4a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 18v-4"/>',
  pencil: '<path d="M4 20h4L18.5 9.5a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4 16v4Z"/><line x1="13" y1="7" x2="17" y2="11"/>',
  check: '<polyline points="5 12.5 10 17.5 19 7"/>',
  copy: '<rect x="9" y="9" width="10.5" height="10.5" rx="2.4"/><path d="M5.5 15H5A1.5 1.5 0 0 1 3.5 13.5v-8A1.5 1.5 0 0 1 5 4h8a1.5 1.5 0 0 1 1.5 1.5V6"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  ellipsis: '<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  books: '<path d="M5 5.5A1.5 1.5 0 0 1 6.5 4H10a1.5 1.5 0 0 1 1.5 1.5V20a2 2 0 0 0-2-2H5V5.5Z"/><path d="M19 5.5A1.5 1.5 0 0 0 17.5 4H14a1.5 1.5 0 0 0-1.5 1.5V20a2 2 0 0 1 2-2H19V5.5Z"/>',
  trash: '<polyline points="4 7 20 7"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7"/><path d="M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7"/>',
  // Deshacer: flecha en U hacia la izquierda (modo Estudiar).
  undo: '<polyline points="8.5 6.5 4.5 10.5 8.5 14.5"/><path d="M4.5 10.5h9a5 5 0 0 1 0 10H9"/>',
  // Suspender una tarjeta: ojo tachado.
  'eye-off': '<path d="M4 12s3.2-5 8-5c1.2 0 2.3.3 3.2.8"/><path d="M19.4 9.4c.4.5.6 1 .6 1.1v1.5s-3.2 5-8 5c-1.3 0-2.4-.4-3.4-.9"/><circle cx="12" cy="12" r="2.4"/><line x1="4.5" y1="19.5" x2="19.5" y2="4.5"/>',
  // Ver la API key en Ajustes (estado revelado → eye-off).
  eye: '<path d="M4 12s3.2-5 8-5 8 5 8 5-3.2 5-8 5-8-5-8-5Z"/><circle cx="12" cy="12" r="2.4"/>',
  // Aviso (leech, avisos discretos): triángulo con exclamación.
  warning: '<path d="M12 4.5 21 19.5H3L12 4.5Z"/><line x1="12" y1="10" x2="12" y2="14.5"/><circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none"/>',
  // Engranaje geométrico de 8 dientes (dientes definidos, sin las curvas
  // abultadas del glifo Feather que se emborronaban a 16–20px).
  // Engranaje de 6 dientes anchos: el de 8 se empastaba a 14-16 px (rail, menús).
  gear: '<path d="M8.80 6.46 L9.80 5.99 L9.90 3.04 L14.10 3.04 L14.20 5.99 L15.20 6.46 L16.11 7.09 L18.71 5.70 L20.81 9.34 L18.30 10.90 L18.40 12.00 L18.30 13.10 L20.81 14.66 L18.71 18.30 L16.11 16.91 L15.20 17.54 L14.20 18.01 L14.10 20.96 L9.90 20.96 L9.80 18.01 L8.80 17.54 L7.89 16.91 L5.29 18.30 L3.19 14.66 L5.70 13.10 L5.60 12.00 L5.70 10.90 L3.19 9.34 L5.29 5.70 L7.89 7.09Z"/><circle cx="12" cy="12" r="2.6"/>',
  // «Aa»: apariencia del TEXTO del libro abierto (tema, letra, tamaño, modo). Es el glifo
  // que usan Apple Books, Kindle y Kobo para lo mismo. Distinto del engranaje, reservado a
  // los Ajustes generales de la app. Sustituye a los deslizadores (auditoría de la cabecera, F2).
  type: '<path d="M3 17.5 7.5 6.5l4.5 11"/><line x1="4.7" y1="13.5" x2="10.3" y2="13.5"/><path d="M15 11.2a3 3 0 0 1 5.5 1.6v4.7"/><path d="M20.5 14.2c-3.8-.4-6.2.5-6.2 1.9 0 2.2 4.1 2.1 6.2-.3"/>',

  // ——— agent / AI ———
  sparkles: '<path d="M12 3.5l1.5 4.2 4.2 1.5-4.2 1.5L12 14.9l-1.5-4.2L6.3 9.2l4.2-1.5L12 3.5Z"/><path d="M18.5 14l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9Z"/>',
  bubble: '<path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.5L4 20.5l1.2-4.3A8.5 8.5 0 1 1 21 11.5Z"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5.5 19.5a6.5 6.5 0 0 1 13 0"/>',
  note: '<rect x="5" y="3.5" width="14" height="17" rx="2.2"/><line x1="8.5" y1="9" x2="15.5" y2="9"/><line x1="8.5" y1="12.5" x2="15.5" y2="12.5"/><line x1="8.5" y1="16" x2="12.5" y2="16"/>',
  // Dictado: cápsula del micro + arco del soporte. Sin relleno, como el resto.
  mic: '<rect x="9" y="3" width="6" height="10.5" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><line x1="12" y1="18" x2="12" y2="21"/>',
  // Recorte de zona (IA6 v2): dos escuadras cruzadas, como el marco de una cámara.
  crop: '<path d="M7.5 3.5v13h13"/><path d="M3.5 7.5h13v13"/>',
  target: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3.6"/><circle cx="12" cy="12" r="0.6" fill="currentColor" stroke="none"/>',
  shield: '<path d="M12 3.5l6.5 2.3v5.2c0 4-2.8 6.8-6.5 8-3.7-1.2-6.5-4-6.5-8V5.8L12 3.5Z"/>',

  // ——— content / blocks ———
  book: '<path d="M5 4.5h7a2 2 0 0 1 2 2V20a2.5 2.5 0 0 0-2.5-2H5V4.5Z"/><path d="M19 4.5h-3a2 2 0 0 0-2 2V20a2.5 2.5 0 0 1 2.5-2H19V4.5Z"/>',
  columns: '<path d="M4 9l8-4.5L20 9"/><line x1="3.5" y1="20" x2="20.5" y2="20"/><line x1="6.5" y1="9.5" x2="6.5" y2="19"/><line x1="10" y1="9.5" x2="10" y2="19"/><line x1="14" y1="9.5" x2="14" y2="19"/><line x1="17.5" y1="9.5" x2="17.5" y2="19"/>',
  chart: '<line x1="5.5" y1="20" x2="5.5" y2="12"/><line x1="12" y1="20" x2="12" y2="4.5"/><line x1="18.5" y1="20" x2="18.5" y2="9"/>',
  // P29 · Infografía: una lámina con su titular, su imagen y sus líneas.
  poster: '<rect x="4" y="3.5" width="16" height="17" rx="2"/><line x1="7" y1="8" x2="17" y2="8"/><rect x="7" y="11.5" width="4.6" height="4.6" rx="1"/><line x1="14" y1="12" x2="17" y2="12"/><line x1="14" y1="15.4" x2="17" y2="15.4"/>',

  // ——— añadidos con la revisión de iconos (2026-10-03): un significado por icono ———
  // Fijar (estanterías en la tira). El marcapáginas es «marcar página» y nada más.
  pin: '<path d="M9.5 4h5l-.8 4.7 3.3 2.8H7l3.3-2.8L9.5 4Z"/><line x1="12" y1="11.5" x2="12" y2="20"/>',
  // Filtro por regla (estanterías inteligentes). `sparkles` queda solo para la IA.
  funnel: '<path d="M4.5 5h15l-5.8 7v5.4l-3.4 1.8V12L4.5 5Z"/>',
  // Ayuda / guía rápida.
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.6a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1.1.8-1.1 1.5v.4"/><line x1="12" y1="16.6" x2="12" y2="16.7"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><line x1="12" y1="11" x2="12" y2="16.2"/><line x1="12" y1="7.9" x2="12" y2="8"/>',
  // Nube (Drive, sincronizar). `upload` es subir un fichero desde el dispositivo.
  cloud: '<path d="M7.5 18.5h9.2a3.8 3.8 0 0 0 .6-7.55 5.3 5.3 0 0 0-10.2-1.2 4.4 4.4 0 0 0 .4 8.75Z"/><polyline points="10 13.6 12 11.6 14 13.6"/><line x1="12" y1="11.6" x2="12" y2="16.4"/>',
  // La libreta (pestaña, «A la libreta»): con anillas. `note` es una nota suelta.
  notebook: '<rect x="6.5" y="3.5" width="13" height="17" rx="2"/><line x1="4" y1="8" x2="8.5" y2="8"/><line x1="4" y1="12" x2="8.5" y2="12"/><line x1="4" y1="16" x2="8.5" y2="16"/><line x1="11.5" y1="8.5" x2="16.5" y2="8.5"/><line x1="11.5" y1="12" x2="15.5" y2="12"/>',
  // Fórmula / ejemplo con números (ƒx). `chart` es Análisis.
  function: '<path d="M13.8 4.5h-.6c-1.6 0-2.5.9-2.8 2.5L8.4 19.5"/><line x1="7.2" y1="10" x2="13.2" y2="10"/><line x1="14.6" y1="13" x2="19.6" y2="19"/><line x1="19.6" y1="13" x2="14.6" y2="19"/>',
  // Otra persona / material compartido. `user` es tu perfil.
  users: '<circle cx="9" cy="8.5" r="3"/><path d="M3.8 19.2a5.2 5.2 0 0 1 10.4 0"/><circle cx="16.6" cy="9.6" r="2.4"/><path d="M15.6 14.3a4.5 4.5 0 0 1 4.9 4.9"/>',
  // Racha. Sustituye al emoji 🔥, que cambia de dibujo en cada sistema.
  flame: '<path d="M12 20.5c3.3 0 5.8-2.4 5.8-5.7 0-3.5-2.6-5.2-3.5-8.3-.5 1.9-1.4 3-2.6 3.6.3-2.6-.8-4.9-3-6.6.2 3.4-3.5 5.7-3.5 10.2 0 3.7 2.9 6.8 6.8 6.8Z"/>',
  // Mapa mental: un nodo y sus ramas (antes `columns`, que es un edificio con columnas).
  mindmap: '<circle cx="12" cy="12" r="2.6"/><circle cx="5" cy="6" r="1.8"/><circle cx="19" cy="6" r="1.8"/><circle cx="5" cy="18" r="1.8"/><circle cx="19" cy="18" r="1.8"/><line x1="9.9" y1="10.4" x2="6.4" y2="7.2"/><line x1="14.1" y1="10.4" x2="17.6" y2="7.2"/><line x1="9.9" y1="13.6" x2="6.4" y2="16.8"/><line x1="14.1" y1="13.6" x2="17.6" y2="16.8"/>',
  // La biblioteca entera: lomos en un estante. `books`/`book` (libro abierto) son UN libro.
  library: '<line x1="3.5" y1="20.5" x2="20.5" y2="20.5"/><rect x="5" y="4.5" width="3.8" height="16" rx="1"/><rect x="10" y="7.5" width="3.8" height="13" rx="1"/><path d="M14.9 8.9l3.4-.9 2.9 11.6"/><path d="M15 8.9 17.9 20.5"/>',
  // Sin clasificar (libros sin estantería): bandeja de entrada.
  inbox: '<path d="M3.5 13.5 6.2 5.6A1.5 1.5 0 0 1 7.6 4.6h8.8a1.5 1.5 0 0 1 1.4 1l2.7 7.9V18a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3.5 18Z"/><path d="M3.5 13.5h4.6l1.4 2.2h5l1.4-2.2h4.6"/>',
  'arrow-down': '<line x1="12" y1="5" x2="12" y2="18.5"/><polyline points="6.5 13 12 18.5 17.5 13"/>',

  // ——— theme glyphs (used inside swatches when helpful) ———
  sun: '<circle cx="12" cy="12" r="4"/><line x1="12" y1="3" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="21"/><line x1="3" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="21" y2="12"/><line x1="5.6" y1="5.6" x2="7" y2="7"/><line x1="17" y1="17" x2="18.4" y2="18.4"/><line x1="18.4" y1="5.6" x2="17" y2="7"/><line x1="7" y1="17" x2="5.6" y2="18.4"/>',
  moon: '<path d="M20 13.5A8 8 0 1 1 10.5 4 6.4 6.4 0 0 0 20 13.5Z"/>',
};

// ---- Escala de tamaños (DS1) ----------------------------------------------------
// Seis pasos con nombre, como la tipográfica: `icon(name, { size: 'md' })`. Espejo de los
// tokens `--icon-*` de themes.css (tests/icons.spec.ts comprueba que coinciden y que nadie
// pasa un número suelto). El trazo baja un poco al crecer el icono, como SF Symbols: con un
// trazo fijo, a 14 px el icono pesaba más que el texto de al lado y a 56 px se quedaba fino.
export const ICON_SIZES = { sm: 14, md: 16, lg: 20, xl: 24, display: 32, hero: 56 };
const STROKE = { sm: 1.9, md: 1.8, lg: 1.7, xl: 1.7, display: 1.5, hero: 1.4 };

function resolveSize(size) {
  if (typeof size === 'string' && ICON_SIZES[size]) return { px: ICON_SIZES[size], stroke: STROKE[size] };
  const n = Number(size) || ICON_SIZES.xl;
  return { px: n, stroke: n <= 15 ? 1.9 : n <= 17 ? 1.8 : n <= 24 ? 1.7 : 1.5 };
}

const warned = new Set();

// Build an <svg> string. `size`: un paso de ICON_SIZES (por defecto `xl`, el de la cabecera);
// `filled` swaps to the solid variant when one exists.
export function icon(name, { size = 'xl', strokeWidth, filled = false } = {}) {
  const key = filled && ICONS[name + '-fill'] ? name + '-fill' : name;
  const body = ICONS[key];
  if (!body) {
    // Antes devolvía '' en silencio: `info` no existía y la nota del Resumen salía sin
    // icono sin que nadie lo notara.
    if (!warned.has(name)) { warned.add(name); console.warn(`icon(): no existe el icono «${name}»`); }
    return '';
  }
  const r = resolveSize(size);
  size = r.px;
  strokeWidth = strokeWidth ?? r.stroke;
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

// Solo el contenido interno del glifo, en la rejilla 24×24. Lo necesitan los SVG que se
// construyen como CADENA en vez de como DOM (el póster de la infografía, P29): ahí un
// `<svg>` anidado no hereda trazo ni admite `currentColor`, así que se inserta el cuerpo
// dentro de un `<g>` con su propio `stroke` y `transform`. Devuelve '' si no existe.
export const ICON_NAMES = Object.keys(ICONS);

export function iconBody(name) {
  return ICONS[name] || '';
}

// Imagotipo de marca a color. Va aparte de ICONS a propósito: los glifos de
// arriba son de línea y heredan currentColor, y este tiene sus tres tonos fijos
// (fondo, página, cinta) porque es la marca, no un icono de interfaz. Fuente:
// assets/brand/mark-dark.svg.
export function brandMark({ size = 28 } = {}) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 512 512" role="img" aria-label="BookReader" focusable="false">`
    + '<rect width="512" height="512" rx="118" fill="#111418"/>'
    + '<path d="M288 119 Q288 99 308 99 L396 99 Q416 99 416 119 L416 371 L352 323 L288 371 Z" fill="#22c55e"/>'
    + '<path d="M98 90 L222 90 Q256 90 256 124 L256 470 C 249 442 233 424 206 414 C 177 403 140 401 100 401 Q64 401 64 365 L64 124 Q64 90 98 90 Z" fill="#f8fafc"/>'
    + '</svg>';
}

// Fill every element carrying a data-icon attribute. Reads optional
// data-icon-size / data-icon-filled overrides. Idempotent.
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    const name = el.getAttribute('data-icon');
    if (!name) return;
    const raw = el.getAttribute('data-icon-size') || '';
    const size = ICON_SIZES[raw] ? raw : (parseInt(raw, 10) || undefined);
    const filled = el.getAttribute('data-icon-filled') === 'true';
    el.innerHTML = icon(name, { size, filled });
  });
}
