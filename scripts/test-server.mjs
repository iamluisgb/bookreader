#!/usr/bin/env node
// Servidor estático para los tests. Sustituye a `python3 -m http.server`.
//
// POR QUÉ. El de Python es un servidor de juguete: bajo la concurrencia de varios
// workers de Playwright escupía `BrokenPipeError` y dejaba peticiones a medias.
// Un recurso que no llega no rompe el test que lo pidió de forma legible —rompe la
// ASERCIÓN que dependía de él—, así que el síntoma era una suite que fallaba en un
// test distinto cada pasada y pasaba en cuanto lo ejecutabas aislado. Node sirve
// asíncrono de serie y una desconexión del cliente es un evento normal, no un error.
//
// Sin dependencias (Node ya hace falta para Playwright), igual que el resto del repo.
//
//   node scripts/test-server.mjs <puerto> <directorio>
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, normalize, extname, resolve } from 'node:path';

const port = Number(process.argv[2] || 8888);
const root = resolve(process.argv[3] || '.');

// `type` importa más de lo que parece: un .js servido como text/plain hace que el
// navegador rechace el módulo ES y la app no arranca, y el .wasm necesita su tipo
// para instanciarse en streaming.
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.epub': 'application/epub+zip',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    // normalize() colapsa los `..`; anclarlo a '/' impide salir de `root`.
    rel = normalize(rel).replace(/^(\.\.[/\\])+/, '');
    let file = join(root, rel);

    let info = await stat(file).catch(() => null);
    if (info && info.isDirectory()) {
      file = join(file, 'index.html');
      info = await stat(file).catch(() => null);
    }
    if (!info || !info.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404');
      return;
    }

    // Revalidación condicional, como hacía el servidor de Python. Sin esto cada
    // navegación de cada test se vuelve a bajar epub.js, pdf.js y el wasm enteros:
    // medido, la suite pasaba de 3,8 a 5,2 minutos. `must-revalidate` mantiene la
    // garantía de que un fichero editado se ve al momento.
    const lastModified = info.mtime.toUTCString();
    if (req.headers['if-modified-since'] === lastModified) {
      res.writeHead(304);
      res.end();
      return;
    }

    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': info.size,
      'last-modified': lastModified,
      'cache-control': 'no-cache, must-revalidate',
      'access-control-allow-origin': '*',
    });
    if (req.method === 'HEAD') { res.end(); return; }

    const stream = createReadStream(file);
    // Que el navegador cancele una descarga (cambio de página, iframe que se
    // destruye) es NORMAL. Aquí solo se suelta el fichero; es justo el caso que en
    // Python salía como BrokenPipeError y ensuciaba la corrida.
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

// Un socket que muere no debe tumbar el proceso ni contaminar la salida del test.
server.on('clientError', (err, socket) => socket.destroy());
server.listen(port, () => console.log(`static: http://localhost:${port} → ${root}`));
