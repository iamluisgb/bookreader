// SVG → PNG/JPEG para los artefactos que se descargan o comparten (mapa mental, infografía).
//
// EL BUG QUE ARREGLA: el SVG lleva la tipografía EMBEBIDA (`svg-fonts.js`), y un SVG cargado
// como `<img>` resuelve `decode()` ANTES de que esas `@font-face` terminen de cargar. Mientras
// tanto el navegador pinta el texto INVISIBLE (periodo de bloqueo de la fuente), así que
// dibujarlo en el canvas nada más decodificar daba un póster con líneas y tarjetas pero sin
// una sola letra: ni título, ni ideas, ni pie. Medido en Chromium: 0 px de texto a 0 ms, el
// texto completo a ~500 ms.
//
// LA SOLUCIÓN, en dos capas:
// 1. `font-display: swap` en las `@font-face` embebidas: nunca hay texto invisible; como mucho,
//    la fuente de respaldo.
// 2. Antes de rasterizar se espera a que el dibujo se ESTABILICE: se pinta en un lienzo
//    pequeño cada 60 ms y se acepta cuando dos pasadas seguidas salen idénticas (con un
//    mínimo de espera, para no dar por buena la fuente de respaldo justo antes del cambio) o
//    cuando se agota el tope. Así la fuente buena entra sin una espera fija a ciegas.

const MIN_WAIT = 240, STEP = 60, MAX_WAIT = 2500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function svgImage(svg) {
  const xml = new XMLSerializer().serializeToString(svg);
  // `unescape` está deprecado; `TextEncoder` + base64 por trozos hace lo mismo y aguanta los
  // SVG grandes (la portada viaja dentro como data URL).
  const bytes = new TextEncoder().encode(xml);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  const img = new Image();
  img.src = 'data:image/svg+xml;base64,' + btoa(bin);
  return img;
}

// Firma barata de un pintado: el SVG reducido a ~240 px de ancho, sumado por bloques.
function signature(img, width, height, probe) {
  const g = probe.getContext('2d', { willReadFrequently: true });
  g.clearRect(0, 0, probe.width, probe.height);
  g.drawImage(img, 0, 0, probe.width, probe.height);
  const d = g.getImageData(0, 0, probe.width, probe.height).data;
  let h = 0;
  for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) | 0;
  return h;
}

async function settle(img, width, height) {
  const probe = document.createElement('canvas');
  probe.width = 240;
  probe.height = Math.max(1, Math.round(240 * height / width));
  let prev = null;
  for (let t = 0; t <= MAX_WAIT; t += STEP) {
    const sig = signature(img, width, height, probe);
    if (sig === prev && t >= MIN_WAIT) return;
    prev = sig;
    await sleep(STEP);
  }
}

// `scale`: fija; si no, 2× para que se vea nítido al compartir, con tope (un lienzo enorme lo
// rechaza el navegador en silencio y devolvía un PNG vacío).
export async function rasterizeSvg(svg, width, height, { type = 'image/png', scale = null, quality = 0.92 } = {}) {
  const img = svgImage(svg);
  await img.decode();
  await settle(img, width, height);
  const k = scale || Math.min(2, Math.max(1, 4200 / Math.max(width, height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * k);
  canvas.height = Math.round(height * k);
  const g = canvas.getContext('2d');
  if (type === 'image/jpeg') { g.fillStyle = '#ffffff'; g.fillRect(0, 0, canvas.width, canvas.height); }
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob null'))), type, quality));
}
