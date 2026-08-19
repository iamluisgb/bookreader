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
}

export function getSheetSnap() { return sheetSnap; }

// Repone el alto guardado. Lo llama app.js al arrancar.
export function restoreSheetSnap() {
  applySheetSnap(Storage.get(SHEET_KEY, SHEET_SNAPS[SHEET_SNAPS.length - 1]));
}
