// nav-debug.js — diagnóstico de navegación, TEMPORAL y apagado por defecto.
//
// Existe porque hay un desvío al saltar a un marcador que no se reproduce en el banco de
// pruebas (probado: libro pequeño y grande, escritorio y móvil con puntero grueso, marcador
// y subrayado — desvío 0 en todos) pero sí en un dispositivo real. En vez de seguir
// adivinando, que el dispositivo lo cuente: se anota qué CFI se pidió, dónde se aterrizó
// tras cada paso y —lo que de verdad interesa— el ancho del CONTENIDO frente al ancho que
// la vista cree tener. Si el primero es mayor que el segundo por página, epub.js recorta el
// salto y deja corto, que es la hipótesis a confirmar o descartar.
//
// Se enciende visitando la app con `?nav-debug=1` y se apaga con `?nav-debug=0`. Sin eso no
// hace absolutamente nada: ni pinta, ni mide, ni engancha eventos. Fuera en cuanto se cierre
// el diagnóstico.
const KEY = 'bookreader_navDebug';

let on = false;
try {
  const q = new URLSearchParams(window.location.search).get('nav-debug');
  if (q === '1') window.localStorage.setItem(KEY, '1');
  if (q === '0') window.localStorage.removeItem(KEY);
  on = window.localStorage.getItem(KEY) === '1';
} catch (e) {
  on = false;   // sin localStorage (modo privado): simplemente apagado
}

export function enabled() {
  return on;
}

let caja = null;
let lineas = [];

function panel() {
  if (caja && caja.isConnected) return caja;
  caja = document.createElement('pre');
  caja.id = 'nav-debug';
  caja.style.cssText = [
    'position:fixed', 'left:4px', 'top:4px', 'right:4px', 'z-index:99999',
    'margin:0', 'padding:6px 8px', 'border-radius:6px',
    'background:rgba(0,0,0,.86)', 'color:#7CFC9B',
    'font:11px/1.35 ui-monospace,Menlo,monospace', 'white-space:pre-wrap',
    'max-height:46vh', 'overflow:auto', 'pointer-events:auto',
  ].join(';');
  // Un toque lo oculta: no debe estorbar para leer ni para hacer la captura.
  caja.addEventListener('click', () => { caja.style.display = 'none'; });
  document.body.appendChild(caja);
  return caja;
}

function pinta() {
  const p = panel();
  p.style.display = 'block';
  p.textContent = lineas.join('\n');
}

// Empieza una traza nueva (una por navegación).
export function reset(titulo) {
  if (!on) return;
  lineas = [titulo];
  pinta();
}

export function log(linea) {
  if (!on) return;
  lineas.push(linea);
  pinta();
}
