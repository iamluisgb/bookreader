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
