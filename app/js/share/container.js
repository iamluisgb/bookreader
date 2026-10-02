// P24 · El paquete `.bookreader`: un ZIP con `dossier.json` (el sobre de bundle.js) y los
// libros en `files/<bookId>.<ext>`. ZIP y no JSON con base64: los libros son lo que pesa,
// y base64 los inflaría un tercio. JSZip ya está vendorizado (lo usa epub.js).
//
// Los libros se guardan sin comprimir (STORE): un EPUB ya es un ZIP y un PDF ya va
// comprimido por dentro, así que deflate gastaría CPU del móvil para ganar casi nada.
import { loadJsZip } from '../vendor-loader.js';
import { hashBuffer } from '../ai/db.js';
import * as Bundle from './bundle.js';

export const MIME = 'application/zip';

// files: Map bookId → Blob, solo de los libros cuyo `file` va en el sobre.
export async function pack(bundle, files) {
  const JSZip = await loadJsZip();
  const zip = new JSZip();
  zip.file(Bundle.DOSSIER_ENTRY, Bundle.serialize(bundle), { compression: 'DEFLATE' });
  for (const b of bundle.books) {
    if (!b.file) continue;
    const blob = files.get(b.bookId);
    if (!blob) throw new Error(`Falta el fichero de «${b.title}»`);
    zip.file(b.file, blob, { compression: 'STORE', binary: true });
  }
  return zip.generateAsync({ type: 'blob', mimeType: MIME });
}

// Paquete → { bundle, files: Map bookId → Blob, rejected: [bookId] }.
// Frontera de confianza: el fichero viene de otra persona. Solo se leen las entradas que
// el sobre declara (con la ruta recalculada en validate), y un libro cuyos bytes no dan
// su `bookId` se descarta: si no, sus notas se anclarían a un libro que no es el suyo, y
// en el sync ese libro llevaría un id que miente sobre su contenido.
export async function unpack(blobOrBuffer) {
  const JSZip = await loadJsZip();
  let zip;
  try {
    zip = await JSZip.loadAsync(blobOrBuffer);
  } catch (cause) {
    throw new Error('El fichero no es un dossier de BookReader.', { cause });
  }
  const entry = zip.file(Bundle.DOSSIER_ENTRY);
  if (!entry) throw new Error('El fichero no es un dossier de BookReader (falta dossier.json).');
  const bundle = Bundle.parse(await entry.async('string'));
  const files = new Map();
  const rejected = [];
  for (const b of bundle.books) {
    if (!b.file) continue;
    const f = zip.file(b.file);
    if (!f) { rejected.push(b.bookId); continue; }
    const buf = await f.async('arraybuffer');
    if (await hashBuffer(buf.slice(0)) !== b.bookId) { rejected.push(b.bookId); continue; }
    files.set(b.bookId, new Blob([buf], { type: b.format === 'pdf' ? 'application/pdf' : 'application/epub+zip' }));
  }
  return { bundle, files, rejected };
}
