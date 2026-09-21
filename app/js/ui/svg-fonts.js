// P14 F3 · Fuente embebida en el SVG que se exporta.
//
// EL BUG QUE ARREGLA: un SVG cargado como `<img>` —que es exactamente como se rasteriza a
// PNG— se trata como documento AISLADO y no puede pedir NINGÚN recurso externo, tampoco
// fuentes. Inter está self-hosted en `fonts/*.woff2`, así que el mapa mental salía en
// pantalla con Inter y en el PNG descargado con la fuente del sistema: el artefacto que
// existe para publicarse era justo el que no se veía como debía.
//
// La solución es meter la fuente DENTRO del SVG como `data:` URI. Beneficio doble: el PNG
// sale idéntico a la pantalla y el `.svg` descargado es autónomo — se abre igual en una
// máquina que no tenga Inter instalada.
//
// COSTE: los woff2 son subconjuntos latinos (~15-25 KB cada uno) y solo se piden al exportar,
// nunca en el arranque. El resultado se cachea para toda la sesión.
//
// DEGRADACIÓN: si algún fetch falla (offline con la caché fría), se devuelve '' y el SVG se
// queda con `font-family: Inter, system-ui, sans-serif` — o sea, exactamente lo que hacía
// antes. Nunca se bloquea la descarga por no poder embeber la tipografía.

const INTER_FACES = [
  { weight: 400, url: 'fonts/inter-400.woff2' },
  { weight: 600, url: 'fonts/inter-600.woff2' },
];

// Póster de la infografía (P29): además de Inter, la serif de display para el titular. Source
// Serif 4 ya estaba self-hosted para lectura, así que el artefacto no añade dependencias —
// solo el coste de embeber dos woff2 más (≈40 KB), y solo al exportar.
const SERIF_FACES = [
  { weight: 400, url: 'fonts/source-serif-4-400.woff2' },
  { weight: 600, url: 'fonts/source-serif-4-600.woff2' },
];

let interCached = null;
let posterCached = null;

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  // Por trozos: `String.fromCharCode(...bytes)` con decenas de miles de argumentos revienta
  // la pila en algunos navegadores.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

async function faceCss(family, { weight, url }) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const b64 = toBase64(await res.arrayBuffer());
  return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};` +
    `src:url(data:font/woff2;base64,${b64}) format('woff2');}`;
}

// CSS con las `@font-face` embebidas, listo para un `<style>` dentro del SVG. Cadena vacía si
// no se pudo cargar: el llamante no necesita distinguirlo (sin `<style>`, el SVG cae a la
// fuente de sistema como siempre).
function facesCss(family, faces, label) {
  return Promise.all(faces.map((f) => faceCss(family, f)))
    .then((parts) => parts.join(''))
    .catch((e) => { console.warn(`No se pudo embeber ${label} en el SVG:`, e); return ''; });
}

export function interFaceCss() {
  if (!interCached) interCached = facesCss('Inter', INTER_FACES, 'Inter');
  return interCached;
}

export function posterFaceCss() {
  if (!posterCached) {
    posterCached = Promise.all([
      facesCss('Inter', INTER_FACES, 'Inter'),
      facesCss('Source Serif 4', SERIF_FACES, 'Source Serif 4'),
    ]).then((parts) => parts.join(''));
  }
  return posterCached;
}
