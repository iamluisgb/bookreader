// ¿Qué es este fichero? Por su CONTENIDO, no por su nombre.
//
// El nombre miente en cuanto el fichero pasa por otra app: WhatsApp entrega un dossier
// como «tecnico-llm.zip», «….bookreader.zip» o sin extensión, y el móvil decía «Formato
// no soportado» a un dossier perfectamente válido. Así que la extensión solo desempata;
// mandan los primeros bytes:
//   - PDF: empieza por «%PDF-».
//   - ZIP («PK\x03\x04»): un EPUB y un dossier lo son los dos. Se distinguen por el nombre
//     de la PRIMERA entrada, que está en la cabecera local a partir del byte 30: el
//     estándar EPUB obliga a que sea `mimetype`, y share/container.js escribe
//     `dossier.json` la primera. Leer 64 bytes basta; no hace falta abrir el zip entero.
// Devuelve 'pdf' | 'epub' | 'bookreader' | null.

const HEAD = 64;

export async function kindOf(file) {
  const head = new Uint8Array(await file.slice(0, HEAD).arrayBuffer());
  const ascii = (from, to) => String.fromCharCode(...head.subarray(from, to));
  if (ascii(0, 5) === '%PDF-') return 'pdf';
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    const nameLen = head[26] | (head[27] << 8);
    const first = ascii(30, Math.min(30 + nameLen, HEAD));
    if (first === 'dossier.json') return 'bookreader';
    if (first === 'mimetype') return 'epub';
  }
  // Sin firma reconocible: la extensión, como antes (un PDF con basura delante, un
  // EPUB mal empaquetado que epub.js aún sabe abrir…).
  const ext = (file.name || '').split('.').pop().toLowerCase();
  return ['pdf', 'epub', 'bookreader'].includes(ext) ? ext : null;
}
