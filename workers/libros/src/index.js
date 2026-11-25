// Biblioteca libre (/samples/): reenvía al navegador un libro cuya fuente no manda CORS.
// NO guarda nada (ni R2, ni KV, ni caché): el cuerpo pasa en streaming.
//
//   GET /libro/<id>   → el fichero de assets/muestra/tecnicos.json con ese id y via=proxy
//   GET /pg/<n>       → EPUB de Project Gutenberg en su espejo (no manda CORS y www.gutenberg.org
//                       está caído para nuestros clientes). Solo ids del catálogo filtrado.
//   GET /el/<id>      → EPUB de Elejandría. Su descarga exige `Referer` de la ficha y son dos
//                       saltos (link_descarga_libro/<id>/<fichaid>); el fichaid del ePub se
//                       resuelve en el build (assets/muestra/elejandria-enlaces.json).
//
// No es un proxy abierto: solo sirve ids de nuestros catálogos (empaquetados en el bundle, así
// que cambiar el catálogo es redesplegar), y las redirecciones se siguen a mano comprobando que
// cada salto cae en un dominio de la lista. Standard Ebooks nunca pasa por aquí: manda CORS y
// además rechaza a los Workers (403, medido el 2026-11-24).
import catalogo from '../../../assets/muestra/catalogo.json' with { type: 'json' };
import tecnicos from '../../../assets/muestra/tecnicos.json' with { type: 'json' };
import enlaces from '../../../assets/muestra/elejandria-enlaces.json' with { type: 'json' };

export const LIBROS = new Map(tecnicos.books.filter((b) => b.via === 'proxy').map((b) => [b.id, b]));
// Dominios a los que puede llevar una redirección: los de las URLs del catálogo más los CDN
// a los que redirigen las releases de GitHub.
export const HOSTS = new Set([
  ...[...LIBROS.values()].map((b) => new URL(b.url).hostname),
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);
export const PG_IDS = new Set(catalogo.pgIds.map(Number));
export const PG_HOSTS = new Set(['gutenberg.pglaf.org', 'aleph.gutenberg.org', 'gutenberg.org', 'www.gutenberg.org']);
export const EL_ENLACES = new Map(Object.entries(enlaces.links || {}));
export const EL_HOSTS = new Set(['www.elejandria.com', 'elejandria.com']);
const MAX_SALTOS = 5;
const TIPOS = { epub: 'application/epub+zip', pdf: 'application/pdf' };
const UA = 'BookReader (+https://bookreader.raiatech.com/samples/)';

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

// Reenvía en streaming comprobando cada salto. `hosts` es la lista blanca de ESTA ruta.
async function reenviar(url, formato, hosts, cors, cabeceras = {}) {
  for (let salto = 0; salto <= MAX_SALTOS; salto++) {
    if (url.protocol !== 'https:' || !hosts.has(url.hostname)) return respuesta(502, `redirección fuera de la lista: ${url.hostname}`, cors);
    const r = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': UA, ...cabeceras } });
    const loc = r.headers.get('Location');
    if (r.status >= 300 && r.status < 400 && loc) {
      url = new URL(loc, url);
      continue;
    }
    if (!r.ok) return respuesta(502, `la fuente respondió ${r.status}`, cors);
    // Una página HTML donde tocaba un libro es un fallo de la fuente, no un libro.
    const tipo = r.headers.get('Content-Type') || '';
    if (tipo.startsWith('text/html')) return respuesta(502, 'la fuente devolvió una página, no el fichero', cors);
    const h = new Headers(cors);
    h.set('Content-Type', TIPOS[formato] || 'application/octet-stream');
    if (r.headers.get('Content-Length')) h.set('Content-Length', r.headers.get('Content-Length'));
    h.set('Cache-Control', 'no-store');
    return new Response(r.body, { status: 200, headers: h });
  }
  return respuesta(508, 'demasiadas redirecciones', cors);
}

export default {
  async fetch(req, env = {}) {
    const cors = cabecerasCors(req, env);
    if (req.method === 'OPTIONS') {
      cors.set('Access-Control-Allow-Methods', 'GET');
      return new Response(null, { status: 204, headers: cors });
    }
    if (req.method !== 'GET') return respuesta(405, 'solo GET', cors);
    const ruta = new URL(req.url).pathname;

    const tec = ruta.match(/^\/libro\/([a-z0-9-]+)$/);
    if (tec) {
      const libro = LIBROS.get(tec[1]);
      if (!libro) return respuesta(404, `no hay libro «${tec[1]}» que reenviar`, cors);
      return reenviar(new URL(libro.url), libro.format, HOSTS, cors);
    }

    const pg = ruta.match(/^\/pg\/(\d+)$/);
    if (pg) {
      const n = Number(pg[1]);
      if (!PG_IDS.has(n)) return respuesta(404, `el libro ${n} no está en el catálogo`, cors);
      // La URL se construye aquí, nunca llega del cliente.
      return reenviar(new URL(`https://gutenberg.pglaf.org/cache/epub/${n}/pg${n}-images-3.epub`), 'epub', PG_HOSTS, cors);
    }

    const el = ruta.match(/^\/el\/(\d+)$/);
    if (el) {
      const e = EL_ENLACES.get(el[1]);
      if (!e) return respuesta(404, `el libro ${el[1]} no está en el catálogo`, cors);
      const url = new URL(`https://www.elejandria.com/libro/link_descarga_libro/${el[1]}/${e.fichaid}`);
      const referer = `https://www.elejandria.com/libro/${e.slug}/${e.autor}/${el[1]}`;
      return reenviar(url, 'epub', EL_HOSTS, cors, { Referer: referer });
    }

    return respuesta(404, 'rutas: /libro/<id>, /pg/<n>, /el/<id>', cors);
  },
};
