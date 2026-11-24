// Biblioteca libre (/samples/): reenvía al navegador un libro técnico con licencia abierta cuya
// fuente no manda CORS. NO guarda nada (ni R2, ni KV, ni caché): el cuerpo pasa en streaming.
//
//   GET /libro/<id>   → el fichero de assets/muestra/tecnicos.json con ese id y via=proxy
//
// No es un proxy abierto: solo sirve ids del catálogo (empaquetado en el bundle, así que
// cambiar el catálogo es redesplegar), y las redirecciones se siguen a mano comprobando que
// cada salto cae en un dominio de la lista. Standard Ebooks nunca pasa por aquí: manda CORS y
// además rechaza a los Workers (403, medido el 2026-11-24).
import catalogo from '../../../assets/muestra/tecnicos.json' with { type: 'json' };

export const LIBROS = new Map(catalogo.books.filter((b) => b.via === 'proxy').map((b) => [b.id, b]));
// Dominios a los que puede llevar una redirección: los de las URLs del catálogo más los CDN
// a los que redirigen las releases de GitHub.
export const HOSTS = new Set([
  ...[...LIBROS.values()].map((b) => new URL(b.url).hostname),
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);
const MAX_SALTOS = 5;
const TIPOS = { epub: 'application/epub+zip', pdf: 'application/pdf' };

function cabecerasCors(req, env) {
  const permitidos = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get('Origin');
  const h = new Headers({ Vary: 'Origin' });
  if (origin && permitidos.includes(origin)) {
    h.set('Access-Control-Allow-Origin', origin);
    h.set('Access-Control-Expose-Headers', 'Content-Length');
  }
  return h;
}

function respuesta(status, texto, cors) {
  const h = new Headers(cors);
  h.set('Content-Type', 'text/plain; charset=utf-8');
  return new Response(texto, { status, headers: h });
}

export default {
  async fetch(req, env = {}) {
    const cors = cabecerasCors(req, env);
    if (req.method === 'OPTIONS') {
      cors.set('Access-Control-Allow-Methods', 'GET');
      return new Response(null, { status: 204, headers: cors });
    }
    if (req.method !== 'GET') return respuesta(405, 'solo GET', cors);
    const m = new URL(req.url).pathname.match(/^\/libro\/([a-z0-9-]+)$/);
    if (!m) return respuesta(404, 'ruta: /libro/<id>', cors);
    const libro = LIBROS.get(m[1]);
    if (!libro) return respuesta(404, `no hay libro «${m[1]}» que reenviar`, cors);

    let url = new URL(libro.url);
    for (let salto = 0; salto <= MAX_SALTOS; salto++) {
      if (url.protocol !== 'https:' || !HOSTS.has(url.hostname)) return respuesta(502, `redirección fuera de la lista: ${url.hostname}`, cors);
      const r = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': 'BookReader (+https://bookreader.raiatech.com/samples/)' } });
      const loc = r.headers.get('Location');
      if (r.status >= 300 && r.status < 400 && loc) { url = new URL(loc, url); continue; }
      if (!r.ok) return respuesta(502, `la fuente respondió ${r.status}`, cors);
      const h = new Headers(cors);
      h.set('Content-Type', TIPOS[libro.format] || 'application/octet-stream');
      if (r.headers.get('Content-Length')) h.set('Content-Length', r.headers.get('Content-Length'));
      h.set('Cache-Control', 'no-store');
      return new Response(r.body, { status: 200, headers: h });
    }
    return respuesta(508, 'demasiadas redirecciones', cors);
  },
};
