// upload-tools.mjs — un agente SUBE un libro (EPUB o PDF) a la biblioteca, en dos pasos y sin
// que los bytes pasen por el modelo ni por JSON-RPC:
//
//   1. create_book_upload: el agente declara nombre, tamaño y SHA-256 del fichero. Si el libro
//      ya está, lo dice y no hay nada que subir. Si no, devuelve una URL de un solo uso, que
//      caduca en minutos y solo acepta ese tamaño.
//   2. PUT de los bytes a esa URL (`curl -T libro.epub <url>`). El Worker comprueba tamaño,
//      formato y hash, cifra con la clave del sync, guarda el fichero y da el libro de alta en
//      `library.json`. La respuesta del PUT ya dice cómo quedó; get_book_upload lo repite.
//
// El bookId ES el SHA-256 del fichero (como en la app: sync/blobs.js), así que subir dos veces
// el mismo libro no lo duplica. Solo existe en el MCP del Worker del sync, con el permiso
// «Subir libros» (`canUpload`); la subida en sí la hace `source.uploads` (workers/sync/src/upload.js).
//
// El libro entra como entra uno subido desde otro dispositivo: ficha con `blob` y sin fichero
// local, que cada dispositivo baja al abrirla. La portada la saca la app la primera vez que lo
// abre. Cada alta queda en Ajustes → Datos → Agentes con «Deshacer».

import { ToolError } from './errors.mjs';

export const FORMATS = ['epub', 'pdf'];
const NAME_MAX = 255;
const META_MAX = 300;

// La ruta del fichero dentro del layout (sin `bookreader/`), la misma que usa la app.
export const bookFile = (id, format) => 'files/' + id + '.' + format;

function text(v, name) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new ToolError('«' + name + '» tiene que ser texto.');
  const s = v.trim().replace(/\s+/g, ' ');
  if (s.length > META_MAX) throw new ToolError('«' + name + '» pasa de ' + META_MAX + ' caracteres.');
  return s;
}

// Lo que declara el agente, validado. `maxBytes` lo pone el Worker (MCP_UPLOAD_MAX_BYTES).
export function cleanUploadArgs(args, { maxBytes }) {
  const rawName = typeof args.fileName === 'string' ? args.fileName.trim() : '';
  const fileName = rawName.split(/[\\/]/).pop();
  if (!fileName) throw new ToolError('Falta «fileName»: el nombre del fichero (p. ej. «libro.epub»).');
  if (fileName.length > NAME_MAX) throw new ToolError('«fileName» pasa de ' + NAME_MAX + ' caracteres.');
  const ext = (fileName.match(/\.([A-Za-z0-9]+)$/) || [])[1];
  const format = String(args.format || ext || '').toLowerCase();
  if (!FORMATS.includes(format)) throw new ToolError('Solo EPUB o PDF: pasa un fichero .epub o .pdf (o «format»).');
  const size = args.size;
  if (!Number.isInteger(size) || size <= 0) throw new ToolError('«size» tiene que ser el tamaño del fichero en bytes (entero).');
  if (size > maxBytes) {
    throw new ToolError(`El fichero pasa del máximo para subir por agente (${Math.round(maxBytes / 1048576)} MB: Cloudflare corta ` +
      'las peticiones más grandes). Que lo suba el usuario desde la app, que lo manda por partes.');
  }
  const sha256 = typeof args.sha256 === 'string' ? args.sha256.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new ToolError('«sha256» tiene que ser el SHA-256 del fichero en hexadecimal (`sha256sum libro.epub`).');
  const title = text(args.title, 'title');
  const author = text(args.author, 'author');
  return {
    fileName, format, size, sha256,
    title: title || fileName.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || fileName,
    author, titleGiven: !!title, authorGiven: !!author,
  };
}

// Da de alta el libro en el catálogo (library.json), como persistToLibrary en la app. Pura:
// `lib` se cambia en el sitio y `undo` recoge lo que deshacer (null = el libro no estaba).
// Devuelve { changed, undoable, result, summary }.
export function addBook(lib, meta, path, now, undo) {
  if (!lib || typeof lib.books !== 'object') {
    throw new ToolError('Esta biblioteca no tiene catálogo (library.json) en el sync: ábrela una vez con la app actual.');
  }
  const id = meta.sha256;
  const cur = lib.books[id];
  const blob = { path, uploadedAt: now };
  if (cur && !cur.deleted) {
    if (cur.blob && cur.blob.path) {
      return { changed: false, result: { status: 'exists', bookId: id, title: cur.title || '', author: cur.author || '' } };
    }
    // El libro estaba en la biblioteca pero su fichero solo en algún dispositivo: ahora está en
    // el sync. No hay nada que deshacer (quitar el fichero no devolvería nada al usuario).
    lib.books[id] = { ...cur, blob, updatedAt: now };
    return {
      changed: true, undoable: false,
      result: { status: 'attached', bookId: id, title: cur.title || '', author: cur.author || '' },
      summary: { books: 1 },
    };
  }
  // Nuevo, o uno que se borró: vuelve como recién importado (updatedAt de ahora gana al
  // tombstone en el merge, como al reimportarlo en la app).
  const record = {
    title: meta.title, author: meta.author, format: meta.format, fileName: meta.fileName,
    fileBaseId: meta.fileName.replace(/\.[^.]+$/, ''), size: meta.size,
    addedAt: now, status: 'unread', progress: 0, shelfIds: [], blob,
    deleted: false, deletedAt: 0, metaAt: now, updatedAt: now,
  };
  // Lo que dijo el agente se conserva al abrir el fichero (book-meta.js · isEdited); lo que no
  // dijo (el título sacado del nombre del fichero) lo cambian los metadatos del EPUB.
  if (meta.titleGiven) record.origTitle = '';
  if (meta.authorGiven) record.origAuthor = '';
  lib.books[id] = record;
  undo.books[id] = null;
  return {
    changed: true, undoable: true,
    result: { status: 'added', bookId: id, title: record.title, author: record.author, format: record.format, size: record.size },
    summary: { booksAdded: 1 },
  };
}

const CREATE_BOOK_UPLOAD = {
  name: 'create_book_upload',
  title: 'Subir un libro (paso 1)',
  description:
    'Añade un libro EPUB o PDF del disco a la biblioteca del usuario. Pasa el nombre, el tamaño ' +
    'en bytes y el SHA-256 del fichero (`stat -c %s libro.epub`, `sha256sum libro.epub`). Si el ' +
    'libro ya está, contesta `exists` y no hay que subir nada. Si no, devuelve `upload.url`: ' +
    'súbelo con un PUT del fichero tal cual (`curl -sS -T libro.epub "<url>"`), que contesta ' +
    'con el libro ya en la biblioteca. La URL es de un solo uso y caduca en 15 minutos. ' +
    '`title` y `author` son opcionales: en un EPUB, la app toma los del fichero al abrirlo.',
  capability: 'canUpload',
  inputSchema: {
    type: 'object',
    properties: {
      fileName: { type: 'string', description: 'Nombre del fichero, con su extensión (.epub o .pdf).' },
      size: { type: 'integer', description: 'Tamaño exacto en bytes.' },
      sha256: { type: 'string', description: 'SHA-256 del fichero, en hexadecimal.' },
      format: { type: 'string', enum: FORMATS, description: 'Solo si la extensión no lo dice.' },
      title: { type: 'string' },
      author: { type: 'string' },
    },
    required: ['fileName', 'size', 'sha256'],
    additionalProperties: false,
  },
  run: (source, args) => source.uploads.create(cleanUploadArgs(args, { maxBytes: source.uploads.maxBytes })),
};

const GET_BOOK_UPLOAD = {
  name: 'get_book_upload',
  title: 'Estado de una subida (paso 2)',
  description:
    'Cómo quedó una subida de create_book_upload: `pending` (falta el PUT), `uploading`, `done` ' +
    '(el libro está en la biblioteca), `failed` (con el motivo) o `expired`. Útil si la respuesta ' +
    'del PUT se perdió.',
  capability: 'canUpload',
  inputSchema: {
    type: 'object',
    properties: { uploadId: { type: 'string' } },
    required: ['uploadId'],
    additionalProperties: false,
  },
  run(source, args) {
    const id = typeof args.uploadId === 'string' ? args.uploadId.trim() : '';
    if (!id) throw new ToolError('Falta «uploadId» (sale en create_book_upload).');
    return source.uploads.status(id);
  },
};

export const UPLOAD_TOOLS = [CREATE_BOOK_UPLOAD, GET_BOOK_UPLOAD];
