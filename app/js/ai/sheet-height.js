// sheet-height.js — Alto del bottom sheet del agente (móvil).
//
// Vive FUERA de panel.js a propósito. El panel se carga con `import()` para no pesar en
// el arranque, pero esto sí tiene que correr en el arranque: la variable `--ai-sheet-h`
// gobierna el alto del sheet y hay que reponerla al cargar, sin depender de abrir el
// panel ni un libro (tests/sheet-snap.spec.ts). Si esperase al panel, el sheet aparecería
// primero a su altura por defecto y saltaría después a la guardada.
//
// Son las dos alturas y el estado; el tirador y el arrastre siguen en panel.js.
import * as Storage from '../storage.js';

// Se ENCAJA en una de las dos al soltar (no altura libre): en un móvil, una altura
// arbitraria te deja siempre en un tamaño incómodo, y además así el estado es uno de dos
// y se puede recordar entre sesiones.
export const SHEET_SNAPS = [52, 92];          // % de la altura visible (dvh)
export const SHEET_KEY = 'ui_ai_sheet_snap';

let sheetSnap = SHEET_SNAPS[SHEET_SNAPS.length - 1];

export function applySheetSnap(pct) {
  sheetSnap = pct;
  document.documentElement.style.setProperty('--ai-sheet-h', pct + 'dvh');
  syncSplit();
}

export function getSheetSnap() { return sheetSnap; }

// Repone el alto guardado. Lo llama app.js al arrancar.
export function restoreSheetSnap() {
  applySheetSnap(Storage.get(SHEET_KEY, SHEET_SNAPS[SHEET_SNAPS.length - 1]));
}

// ---- Split: el snap bajo encoge el lector, no lo tapa -------------------------------
//
// El snap bajo existía para "preguntar por una figura sin perder de vista la figura",
// pero la hoja era un OVERLAY: el lector seguía paginando contra la ventana entera, sin
// saber que se había encogido. Consecuencia — lo que cayera en la mitad inferior quedaba
// detrás de la hoja y NO había forma de traerlo: no es que estuviera lejos, es que el
// lector creía que ya estaba a la vista. Con el split el área de lectura mide de verdad
// la franja libre y re-pagina dentro.
//
// Solo el snap BAJO puede ser split. Con el alto quedaría un 8% de pantalla para el
// texto: repaginar para eso es caro y no sirve para nada.
export const SPLIT_SNAP = SHEET_SNAPS[0];

// Por debajo de esto la franja libre no es un lector, es una rendija. Es también el
// guardarraíl del teclado: al abrirse, la franja se queda sin sitio y el split se retira
// solo en vez de repaginar a un alto ridículo.
const MIN_READER_PX = 240;

export function isSplit() {
  return document.body.classList.contains('ai-split');
}

// Alto que la hoja le quita a la pantalla, para quien tenga que dejar algo a la vista
// (el recorte de una zona, una cita en PDF).
//
// Con el split activo devuelve 0 A PROPÓSITO: el contenedor del lector YA excluye la
// hoja, así que reservarla otra vez descontaría dos veces lo mismo y dejaría el pasaje
// pegado al borde de arriba.
export function sheetReservedPx() {
  if (!isSheetViewport() || !document.body.classList.contains('ai-open')) return 0;
  if (isSplit()) return 0;
  return Math.round(viewportH() * sheetSnap / 100);
}

function isSheetViewport() {
  return window.matchMedia('(max-width: 767px)').matches;
}

// visualViewport y no innerHeight: en iOS el viewport de layout NO encoge con el teclado,
// y es justo el caso en el que hay que decidir si cabe un lector.
function viewportH() {
  return (window.visualViewport && window.visualViewport.height) || window.innerHeight;
}

// Recalcula el estado del split y avisa SOLO cuando cambia. Lo de "solo cuando cambia" no
// es higiene: cada cambio obliga a repaginar el EPUB, y esto se llama en cada frame del
// arrastre del tirador.
export function syncSplit() {
  const vh = viewportH();
  const free = vh - Math.min(vh, vh * sheetSnap / 100);
  const on = isSheetViewport()
    && document.body.classList.contains('ai-open')
    && !document.body.classList.contains('sheet-dragging')
    && sheetSnap === SPLIT_SNAP
    && free >= MIN_READER_PX;
  if (on === isSplit()) return;
  document.body.classList.toggle('ai-split', on);
  // Quien re-pagina es el lector, y de eso se encarga app.js: este módulo no conoce ni
  // al EPUB ni al PDF, y meterle esa dependencia lo devolvería al arranque pesado del
  // que se separó.
  window.dispatchEvent(new CustomEvent('bookreader:sheet-split', { detail: { split: on } }));
}

// Girar la pantalla, cruzar el punto de ruptura o abrir el teclado cambian la franja
// libre sin que nadie toque el tirador.
window.addEventListener('resize', syncSplit);
window.addEventListener('orientationchange', syncSplit);
window.visualViewport?.addEventListener('resize', syncSplit);
