// frame-rect.js — Paso de coordenadas del iframe del EPUB a coordenadas de pantalla.
//
// El contenido del EPUB vive dentro de un iframe que a su vez cuelga de `#reader-viewport`,
// y ese viewport LLEVA UNA ESCALA en táctil con las barras a la vista (updateReaderScale:
// encoge el texto para que quepa entre la cabecera y el pie). Medido en un móvil de 390px:
// el iframe mide 390×780 px CSS por dentro y ocupa 338×676 en pantalla — factor 0,867.
//
// Todo lo que se dibuja ENCIMA del iframe (la capa de selección táctil, la barra de
// acciones) vive fuera del viewport, en coordenadas de pantalla reales. Sumar sin más el
// offset del iframe a un rect medido dentro mezcla los dos espacios, y el error crece con
// la distancia al origen de la transformación: 65 px de desvío vertical para una selección
// a media página. De ahí el resaltado descuadrado y los tiradores que no se dejan agarrar.
//
// El factor se deriva del propio iframe (caja en pantalla ÷ caja CSS), así que no hay que
// leer la matriz ni saber quién la puso; sin transformación sale 1 y esto no hace nada.

export function frameTransform(iframe) {
  const f = iframe || document.querySelector('#epub-container iframe');
  if (!f) return { x: 0, y: 0, sx: 1, sy: 1 };
  const r = f.getBoundingClientRect();
  const w = f.clientWidth || r.width || 1;
  const h = f.clientHeight || r.height || 1;
  return { x: r.left, y: r.top, sx: r.width / w || 1, sy: r.height / h || 1 };
}

// Un rect medido DENTRO del iframe, en coordenadas de pantalla. La banda que ocupa toda la
// selección (blockTop/blockBottom, ver anchorRect) viaja con él si la trae.
export function toScreen(rect, tr) {
  const t = tr || frameTransform();
  const out = {
    left: t.x + rect.left * t.sx,
    top: t.y + rect.top * t.sy,
    width: rect.width * t.sx,
    height: rect.height * t.sy,
  };
  if (rect.blockTop != null) {
    out.blockTop = t.y + rect.blockTop * t.sy;
    out.blockBottom = t.y + rect.blockBottom * t.sy;
  }
  return out;
}

// Los rects de una selección, sin los degenerados. `getClientRects()` devuelve rects de
// ancho o alto cero en los saltos de línea y de columna; tomarlos como primero o último
// (los tiradores, el anclaje de la barra) apunta a un sitio donde no hay texto.
export function usableRects(range) {
  const out = [];
  for (const r of range.getClientRects()) {
    if (r.width >= 0.5 && r.height >= 0.5) out.push(r);
  }
  return out;
}

// Caja de anclaje para la barra de acciones: la PRIMERA línea de la selección, no el
// bounding box. En un texto a varias líneas —y más aún si cruza un salto de columna— el
// bounding abarca todo el bloque: su centro cae en medio del párrafo o en el canalón entre
// columnas, lejos de lo que el usuario acaba de marcar.
// Además del ancla, el rect lleva la BANDA vertical de toda la selección
// (blockTop/blockBottom): colocar la barra es un problema de dos cajas —dónde apuntar y qué
// no tapar—. Anclando solo en la primera línea, cuando la barra no cabía arriba caía
// justo debajo de ESA línea, encima del resto de lo seleccionado.
export function anchorRect(range) {
  const rs = usableRects(range);
  if (!rs.length) {
    const b = range.getBoundingClientRect();
    if (!(b.width || b.height)) return null;
    return { left: b.left, top: b.top, width: b.width, height: b.height, blockTop: b.top, blockBottom: b.bottom };
  }
  return withBand(rs[0], rs);
}

// Pega a un rect de ancla la banda vertical que ocupan todos los rects de la selección.
export function withBand(ancla, rects) {
  let top = ancla.top, bottom = ancla.top + ancla.height;
  for (const r of rects) {
    if (r.top < top) top = r.top;
    const b = r.bottom != null ? r.bottom : r.top + r.height;
    if (b > bottom) bottom = b;
  }
  return { left: ancla.left, top: ancla.top, width: ancla.width, height: ancla.height, blockTop: top, blockBottom: bottom };
}
