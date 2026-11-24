// Perfiles públicos alojados (MON7, ADR-064): cualquiera con el sync de BookReader (Plus) publica
// su estantería en `bookreader.raiatech.com/@<handle>/` desde la app, sin build ni commit.
//
// Publicar: la app manda la foto (formato 2, `snapshot()` de app/js/library/publish.js). Aquí se
// LIMPIA campo a campo (nada de la foto llega a la página sin pasar por una lista blanca), las
// portadas salen de sus data URL a objetos de R2, se genera el widget now.svg y se guarda un
// `perfil.json` con la forma que ya lee assets/perfil/estanteria.js. El `bookId` (SHA-256 del
// fichero) NO se publica: el id público es un hash del handle y el libro.
//
// Servir: la ruta `bookreader.raiatech.com/@*` pasa por este Worker. Un handle alojado se sirve
// desde R2 con la plantilla de Pages (assets/perfil/plantilla.html); uno que no lo es sigue a Pages
// (que da su 404). Mismo origen que la app: por eso la página va con
// una CSP que solo deja correr los scripts de la plantilla (hashes calculados al servir).

import { sha256Hex } from './index.js';

export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;   // 3-30, sin guion al borde
// Rutas del sitio y nombres que no se dan: no se puede publicar como «app» ni como la marca.
export const RESERVED = new Set(['app', 'api', 'assets', 'es', 'en', 'help', 'blog', 'docs', 'why', 'privacy',
  'terms', 'samples', 'anki', 'admin', 'root', 'www', 'mail', 'support', 'soporte', 'hola', 'about', 'login',
  'signup', 'settings', 'mcp', 'sync', 'static', 'perfil', 'profile', 'bookreader', 'raiatech', 'official',
  'u', 's', 'null', 'undefined']);
export const LIMITS = { books: 300, shelves: 20, coverBytes: 400 * 1024, avatarBytes: 200 * 1024, profileBytes: 16 * 1024 * 1024 };
const PREFIX = (h) => `profiles/${h}/`;
const SPINES = new Set(['plain', 'oreilly', 'arxiv', 'paper', 'packt', 'manning', 'nostarch', 'pragprog']);
const HEX = /^#[0-9a-f]{6}$/i;
const IMG = /^data:image\/(webp|jpeg|png);base64,([A-Za-z0-9+/=]+)$/;

const str = (v, n) => (typeof v === 'string' ? v : '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const httpLink = (v) => {
  const s = str(v, 500);
  try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : ''; } catch { return ''; }
};
function decodeImage(dataUrl, max) {
  const m = IMG.exec(typeof dataUrl === 'string' ? dataUrl : '');
  if (!m) return null;
  const bin = atob(m[2]);
  if (bin.length > max) return { tooBig: true };
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, type: 'image/' + m[1], ext: m[1] === 'jpeg' ? 'jpg' : m[1], b64: m[2] };
}
function spineOf(s) {
  const sp = s && typeof s === 'object' ? s : {};
  const out = { style: SPINES.has(sp.style) ? sp.style : 'plain', title: str(sp.title, 120), author: str(sp.author, 120) };
  for (const k of ['bg', 'ink', 'muted']) if (HEX.test(sp[k] || '')) out[k] = sp[k];
  return out;
}

// Foto de la app → { perfil, files: [{ key, bytes, type }] } o { error }.
export async function buildProfile(snap, handle, name) {
  if (!Array.isArray(snap.shelves) || !Array.isArray(snap.books)) return { error: 'bad_snapshot' };
  if (snap.shelves.length > LIMITS.shelves) return { error: 'too_many_shelves' };
  const referenced = new Set(snap.shelves.flatMap(s => Array.isArray(s.books) ? s.books : []));
  const books = snap.books.filter(b => b && referenced.has(b.id));
  if (books.length > LIMITS.books) return { error: 'too_many_books' };
  const files = [];
  const idMap = new Map();
  const out = [];
  const covers = new Map();   // id público → b64 (para now.svg)
  for (const b of books) {
    const id = (await sha256Hex(`${handle}:${b.bookId || b.id}`)).slice(0, 12);
    if (idMap.has(b.id)) continue;
    idMap.set(b.id, id);
    const book = {
      id, title: str(b.title, 300), author: str(b.author, 200),
      status: ['reading', 'finished', 'unread'].includes(b.status) ? b.status : 'unread',
      ...(Number.isFinite(b.progress) ? { progress: Math.max(0, Math.min(100, Math.round(b.progress))) } : {}),
      ...(Number.isFinite(b.pages) && b.pages > 0 ? { pages: Math.min(20000, Math.round(b.pages)), pagesEstimated: true } : {}),
      spine: spineOf(b.spine),
      ...(str(b.note, 280) ? { note: str(b.note, 280) } : {}),
      ...(httpLink(b.link) ? { link: httpLink(b.link) } : {}),
    };
    const img = b.coverData ? decodeImage(b.coverData, LIMITS.coverBytes) : null;
    if (img?.tooBig) return { error: 'cover_too_large' };
    if (img) {
      files.push({ key: `${PREFIX(handle)}c/${id}.${img.ext}`, bytes: img.bytes, type: img.type });
      book.coverFile = `${id}.${img.ext}`;
      covers.set(id, img);
    }
    out.push(book);
  }
  const shelves = snap.shelves.map((s, i) => ({
    id: (str(s.id, 60).toLowerCase().replace(/[^a-z0-9-]/g, '') || `shelf-${i + 1}`),
    name: str(s.name, 80) || `Shelf ${i + 1}`,
    books: (Array.isArray(s.books) ? s.books : []).map(x => idMap.get(x)).filter(Boolean),
    ...(s.year ? { year: true } : {}),
  })).filter(s => s.books.length);
  if (!shelves.length) return { error: 'bad_snapshot' };
  const pr = snap.profile && typeof snap.profile === 'object' ? snap.profile : {};
  const profile = { lang: pr.lang === 'es' ? 'es' : 'en', ...(str(pr.bio, 200) ? { bio: str(pr.bio, 200) } : {}) };
  if (pr.avatarData) {
    const a = decodeImage(pr.avatarData, LIMITS.avatarBytes);
    if (a?.tooBig) return { error: 'avatar_too_large' };
    if (a) { files.push({ key: `${PREFIX(handle)}c/avatar.${a.ext}`, bytes: a.bytes, type: a.type }); profile.avatarFile = `avatar.${a.ext}`; }
  }
  const nowId = idMap.get(snap.now) || null;
  const perfil = {
    owner: name || handle, handle, profile, now: nowId,
    ...(snap.showFilters === false ? { showFilters: false } : {}),
    shelves, books: out,
  };
  const nowBook = nowId && out.find(b => b.id === nowId);
  if (nowBook) {
    files.push({ key: `${PREFIX(handle)}now.svg`, bytes: new TextEncoder().encode(nowSvg(perfil.owner, nowBook, covers.get(nowId))), type: 'image/svg+xml' });
  }
  return { perfil, files };
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
function widgetAuthor(a) {
  const people = String(a || '').split(/\s*,\s*/).filter(Boolean).map(p => p.split(/\s+/).pop());
  if (people.length <= 1) return a || '';
  return people.slice(0, -1).join(', ') + ' & ' + people.at(-1);
}
// El widget «Reading now» de scripts/publicar-perfil.mjs, con la portada tal como llega de la app.
export function nowSvg(owner, b, img) {
  const title = b.spine.title || b.title;
  const pct = b.progress == null ? null : b.progress;
  const SANS = 'font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif"';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="132" viewBox="0 0 440 132" role="img" aria-label="${xml(`${owner} is reading ${title}${pct == null ? '' : ` (${pct}%)`} · BookReader`)}">
  <style>
    .bg { fill: #ffffff; stroke: #e5e5ea; } .fg { fill: #1d1d1f; } .soft { fill: #5f5f64; } .track { fill: #f0f0f2; } .acc { fill: #178046; }
    @media (prefers-color-scheme: dark) { .bg { fill: #161b22; stroke: #30363d; } .fg { fill: #f0f6fc; } .soft { fill: #9198a1; } .track { fill: #30363d; } .acc { fill: #32d074; } }
  </style>
  <rect class="bg" x="0.5" y="0.5" width="439" height="131" rx="10"/>
  ${img ? `<image x="18" y="14" width="80" height="104" preserveAspectRatio="xMidYMid slice" href="data:${img.type};base64,${img.b64}"/>` : ''}
  <rect x="18" y="14" width="80" height="104" fill="none" stroke="#d1d1d6"/>
  <text class="soft" x="110" y="34" ${SANS} font-size="11" font-weight="600" letter-spacing="0.8">READING NOW</text>
  <text class="fg" x="110" y="58" font-family="Georgia, serif" font-size="18" font-weight="600">${xml(title.length > 34 ? title.slice(0, 33) + '…' : title)}</text>
  <text class="soft" x="110" y="78" ${SANS} font-size="12">${xml(widgetAuthor(b.author).slice(0, 52))}</text>
  ${pct == null ? '' : `<rect class="track" x="110" y="94" width="200" height="6" rx="3"/>
  <rect class="acc" x="110" y="94" width="${Math.max(6, Math.round(2 * pct))}" height="6" rx="3"/>
  <text class="soft" x="320" y="100" ${SANS} font-size="12">${pct}%</text>`}
  <text class="soft" x="424" y="120" text-anchor="end" ${SANS} font-size="10">BookReader</text>
</svg>
`;
}

// ---- publicar / retirar ------------------------------------------------------------------------

export async function profileOf(env, user) {
  return env.DB.prepare('SELECT handle, objects, bytes, books, updated_at FROM profiles WHERE user = ?').bind(user).first();
}
async function dropObjects(env, keys) {
  for (let i = 0; i < keys.length; i += 1000) if (keys.slice(i, i + 1000).length) await env.SYNC.delete(keys.slice(i, i + 1000));
}

// Devuelve [status, body].
export async function publishHosted(env, who, snap, { origin, now = Date.now() } = {}) {
  const handle = str(snap.handle, 40).toLowerCase();
  if (!HANDLE_RE.test(handle) || RESERVED.has(handle)) return [400, { error: 'bad_handle' }];
  const taken = await env.DB.prepare('SELECT user FROM profiles WHERE handle = ?').bind(handle).first();
  if (taken && taken.user !== who.user) return [409, { error: 'handle_taken' }];
  const built = await buildProfile(snap, handle, str(snap.profile?.name, 60));
  if (built.error) return [400, { error: built.error }];
  const v = now.toString(36);
  const json = new TextEncoder().encode(JSON.stringify({ ...built.perfil, version: v }));
  const files = [...built.files, { key: `${PREFIX(handle)}perfil.json`, bytes: json, type: 'application/json' }];
  const bytes = files.reduce((n, f) => n + f.bytes.length, 0);
  if (bytes > LIMITS.profileBytes) return [413, { error: 'too_large' }];

  for (const f of files) await env.SYNC.put(f.key, f.bytes, { httpMetadata: { contentType: f.type } });
  const keys = files.map(f => f.key);
  const prev = await profileOf(env, who.user);
  if (prev) {
    const keep = new Set(keys);
    await dropObjects(env, JSON.parse(prev.objects || '[]').filter(k => !keep.has(k)));
    if (prev.handle !== handle) await env.DB.prepare('DELETE FROM profiles WHERE user = ?').bind(who.user).run();
  }
  await env.DB.prepare(
    `INSERT INTO profiles (handle, user, objects, bytes, books, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(handle) DO UPDATE SET objects = excluded.objects, bytes = excluded.bytes, books = excluded.books, updated_at = excluded.updated_at`,
  ).bind(handle, who.user, JSON.stringify(keys), bytes, built.perfil.books.length, now, now).run();
  return [200, { state: 'done', hosted: true, handle, at: now, url: `${origin}/@${handle}/`, books: built.perfil.books.length }];
}

export async function unpublishHosted(env, user) {
  const prev = await profileOf(env, user);
  if (!prev) return false;
  await dropObjects(env, JSON.parse(prev.objects || '[]'));
  await env.DB.prepare('DELETE FROM profiles WHERE user = ?').bind(user).run();
  return true;
}

// ---- servir ------------------------------------------------------------------------------------

const PROFILE_PATH = /^\/(?:@|%40)([^/]+)(\/.*)?$/;
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000',
};
async function b64sha256(text) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  let s = ''; for (const x of d) s += String.fromCharCode(x);
  return btoa(s);
}

let templateCache = null;
async function template(env, origin, fetchImpl) {
  if (env.PROFILE_TEMPLATE_HTML) return env.PROFILE_TEMPLATE_HTML;
  if (templateCache && templateCache.at > Date.now() - 5 * 60 * 1000) return templateCache.html;
  const res = await fetchImpl(`${origin}/assets/perfil/plantilla.html`, { cf: { cacheTtl: 300 } });
  if (!res.ok) throw new Error('template_' + res.status);
  templateCache = { html: await res.text(), at: Date.now() };
  return templateCache.html;
}

// Rellena la plantilla y le pone una CSP que solo deja los scripts de la plantilla.
// `embed` (`?embed=1`): la estantería sola para incrustarla en otra web (la del dueño, un blog), así
// que esa variante SÍ se deja meter en un iframe. La página es de solo lectura —enlaces y libros que
// se abren, sin formularios ni sesión—, así que no hay acción que secuestrar con un clic.
export async function renderPage(tpl, perfil, origin, { shelf = null, embed = false } = {}) {
  const es = perfil.profile?.lang === 'es';
  const name = perfil.owner;
  const title = shelf ? `${name} · ${shelf.name} · BookReader` : (es ? `La estantería de ${name} · BookReader` : `${name}’s shelf · BookReader`);
  const desc = es ? `Lo que ${name} está leyendo, en BookReader.` : `What ${name} is reading, on BookReader.`;
  const url = `${origin}/@${perfil.handle}/`;
  const vals = { NAME: name, HANDLE: perfil.handle, TITLE: title, DESC: desc, URL: url, LANG: es ? 'es' : 'en', INITIAL: (name.trim()[0] || '·').toUpperCase() };
  const html = tpl.replace(/\{\{(NAME|HANDLE|TITLE|DESC|URL|LANG|INITIAL)\}\}/g, (_, k) => xml(vals[k]));
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const hashes = await Promise.all(inline.map(async s => `'sha256-${await b64sha256(s)}'`));
  const csp = [
    "default-src 'self'", `script-src 'self' ${hashes.join(' ')}`, "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data: blob:", "connect-src 'self' https://cloud.umami.is https://api-gateway.umami.dev",
    embed ? 'frame-ancestors *' : "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'", "object-src 'none'",
  ].join('; ');
  const headers = { ...SECURITY, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60', 'Content-Security-Policy': csp };
  if (embed) delete headers['X-Frame-Options'];
  return new Response(html, { status: 200, headers });
}

// Página de una estantería para compartir: tarjeta con su título y redirección a la página.
function shelfPage(perfil, shelf, origin) {
  const url = `${origin}/@${perfil.handle}/`;
  const t = xml(`${perfil.owner} · ${shelf.name} · BookReader`);
  return new Response(`<!doctype html><html lang="${perfil.profile?.lang === 'es' ? 'es' : 'en'}"><head><meta charset="utf-8">
<title>${t}</title><meta property="og:type" content="profile"><meta property="og:title" content="${t}">
<meta property="og:url" content="${xml(url + shelf.id + '/')}"><meta property="og:image" content="${origin}/app/icons/icon-512.png">
<link rel="canonical" href="${xml(url + '#' + shelf.id)}"><meta http-equiv="refresh" content="0; url=../?ref=share#${xml(shelf.id)}">
</head><body><p><a href="../?ref=share#${xml(shelf.id)}">${t}</a></p></body></html>`, {
    status: 200, headers: { ...SECURITY, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" },
  });
}

// null = no es un perfil alojado: que siga a Pages.
export async function serveProfile(request, env, { fetchImpl = fetch } = {}) {
  const url = new URL(request.url);
  const m = url.pathname.match(PROFILE_PATH);
  if (!m || !['GET', 'HEAD'].includes(request.method)) return null;
  const handle = decodeURIComponent(m[1]).toLowerCase();
  if (!HANDLE_RE.test(handle)) return null;
  const row = await env.DB.prepare(
    'SELECT p.handle FROM profiles p LEFT JOIN users u ON u.id = p.user WHERE p.handle = ? AND (u.lapsed_at IS NULL)',
  ).bind(handle).first();
  const rest = m[2] || '';
  // Vista previa desde la app (`?draft=1`) de un perfil que aún no existe: la plantilla vacía; la
  // página pinta el borrador de localStorage (estanteria.js), no nada del servidor.
  if (!row && rest === '/' && url.searchParams.get('draft') === '1') {
    const html = await template(env, url.origin, fetchImpl);
    const r = await renderPage(html, { owner: handle, handle, profile: {} }, url.origin);
    r.headers.set('Cache-Control', 'no-store');
    r.headers.set('X-Robots-Tag', 'noindex');
    return r;
  }
  if (!row) return null;
  if (!rest) return Response.redirect(`${url.origin}/@${handle}/${url.search}`, 301);
  const obj = async (key, cache) => {
    const o = await env.SYNC.get(PREFIX(handle) + key);
    if (!o) return new Response('Not found', { status: 404, headers: SECURITY });
    const type = o.httpMetadata?.contentType || (key.endsWith('.json') ? 'application/json' : key.endsWith('.svg') ? 'image/svg+xml' : 'image/webp');
    return new Response(o.body, { status: 200, headers: { ...SECURITY, 'Content-Type': type, 'Cache-Control': cache, ...(key.endsWith('.svg') ? { 'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'" } : {}) } });
  };
  if (rest === '/perfil.json') return obj('perfil.json', 'public, max-age=60');
  if (rest === '/now.svg') return obj('now.svg', 'public, max-age=300');
  const c = rest.match(/^\/c\/([a-z0-9]{12}|avatar)\.(webp|jpg|png)$/);
  if (c) return obj(`c/${c[1]}.${c[2]}`, 'public, max-age=86400');
  const perfilObj = await env.SYNC.get(PREFIX(handle) + 'perfil.json');
  if (!perfilObj) return null;
  const perfil = await new Response(perfilObj.body).json();
  if (rest === '/') return renderPage(await template(env, url.origin, fetchImpl), perfil, url.origin, { embed: url.searchParams.get('embed') === '1' });
  const sh = rest.match(/^\/([a-z0-9-]{1,60})\/?$/);
  const shelf = sh && perfil.shelves.find(s => s.id === sh[1]);
  if (shelf) return shelfPage(perfil, shelf, url.origin);
  return new Response('Not found', { status: 404, headers: SECURITY });
}
