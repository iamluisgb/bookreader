// Commit del código que CORRE. En el repo va vacío; scripts/build-pages.mjs lo reescribe en
// dist/ con el commit del build. Viaja con el resto de módulos (precache del service worker
// incluido), así que si el navegador está sirviendo código viejo de caché, este sello también
// es el viejo: compararlo con /build.json (lo servido HOY) es lo que delata el desfase.
// Antes se comparaba /build.json al arrancar con /build.json más tarde: si el código venía de
// caché, el primero ya decía la versión nueva y el aviso no salía nunca.
export const BUILD = '';
