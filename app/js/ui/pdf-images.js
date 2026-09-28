// PDF mínimo con una imagen JPEG por página (IG2). Es el formato de CARRUSEL que pide LinkedIn
// (un documento, una diapositiva por página); Instagram recibe las imágenes sueltas.
//
// Por qué a mano y no una librería: un PDF de imágenes es un puñado de objetos (catálogo,
// árbol de páginas y, por página, la página, su contenido y la imagen con /DCTDecode, que
// admite el JPEG tal cual, sin recodificar). Son ~60 líneas frente a una dependencia de
// cientos de KB en una app sin build step (ver AGENTS.md: no añadir dependencias sin motivo).

const enc = new TextEncoder();

// `pages`: [{ jpeg: Uint8Array, px: ancho, py: alto }] — píxeles de la imagen.
// `w`, `h`: tamaño de página en puntos. Devuelve un Blob application/pdf.
export function imagesToPdf(pages, w, h) {
  const parts = [];
  const offsets = [];
  let pos = 0;
  const push = (chunk) => {
    const b = typeof chunk === 'string' ? enc.encode(chunk) : chunk;
    parts.push(b);
    pos += b.length;
  };
  const obj = (n, body) => {
    offsets[n] = pos;
    push(`${n} 0 obj\n${body}\nendobj\n`);
  };

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const n = pages.length;
  // Numeración: 1 catálogo, 2 páginas; luego, por página i: 3+3i página, 4+3i contenido, 5+3i imagen.
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  pages.forEach((p, i) => {
    const pn = 3 + i * 3, cn = pn + 1, im = pn + 2;
    obj(pn, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${cn} 0 R >>`);
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    obj(cn, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    offsets[im] = pos;
    push(`${im} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.px} /Height ${p.py} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
    push(p.jpeg);
    push('\nendstream\nendobj\n');
  });

  const total = 3 + n * 3;
  const xref = pos;
  let table = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let k = 1; k < total; k++) table += `${String(offsets[k]).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}
