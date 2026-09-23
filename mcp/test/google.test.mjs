// google — el camino de Drive, probado sin credenciales: se sustituye `fetch` por un doble que
// responde con la forma REAL de la API (list por nombre, `alt=media`, tokens del Worker) y se
// comprueba que el proveedor y la fuente hacen lo que dicen.
//
// Lo que esto NO demuestra, y por eso está escrito en el README: que el OAuth de verdad
// entregue un `access_token` (eso es de Google) ni que el `appDataFolder` del usuario tenga el
// layout que esperamos. Sí demuestra todo lo demás: la forma de las llamadas, el reintento
// tras un 401, el mapeo de errores y que los etags/versiones se usan donde toca.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGoogleAuth, readRefreshTokenFile, AUTH_WORKER_URL } from '../src/auth/google.mjs';
import { createGoogleDriveProvider } from '../src/providers/google-drive.mjs';
import { createDriveSource } from '../src/sources/drive.mjs';
import { SourceError } from '../src/errors.mjs';
import { buildLayoutFiles, BOOK_1 } from './helpers/dataset.mjs';

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Doble de la API de Drive: guarda ficheros por nombre y responde como Drive v3. */
function driveStub(files = buildLayoutFiles(), { refreshToken = 'rt-ok' } = {}) {
  const store = new Map(
    Object.entries(files).map(([name, content], i) => [
      name,
      {
        id: 'file-' + i,
        name,
        version: String(i + 1),
        modifiedTime: '2026-09-22T10:00:00.000Z',
        content: typeof content === 'string' ? content : JSON.stringify(content),
      },
    ]),
  );
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ host: u.hostname, path: u.pathname, q: u.searchParams.get('q') || '', method: options.method || 'GET' });
    if (u.hostname === new URL(AUTH_WORKER_URL).hostname) {
      const body = JSON.parse(options.body || '{}');
      if (body.refresh_token !== refreshToken) return jsonRes({ error: 'invalid_grant' }, 400);
      return jsonRes({ access_token: 'access-1', expires_in: 3600 });
    }
    const name = /name='([^']+)'/.exec(u.searchParams.get('q') || '');
    if (u.pathname === '/drive/v3/files' && name) {
      const f = store.get(name[1]);
      return jsonRes({ files: f ? [meta(f)] : [] });
    }
    if (u.pathname === '/drive/v3/files') {
      return jsonRes({ files: [...store.values()].map(meta) });
    }
    const byId = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (byId) {
      const f = [...store.values()].find((x) => x.id === byId[1]);
      return f ? new Response(f.content, { status: 200 }) : new Response('', { status: 404 });
    }
    return jsonRes({ error: { message: 'no existe', errors: [{ reason: 'notFound' }] } }, 404);
  };
  const meta = (f) => ({ id: f.id, name: f.name, version: f.version, modifiedTime: f.modifiedTime, size: f.content.length });
  return { fetchImpl, calls, store };
}

test('auth: el refresh token se cambia por un access token y se reutiliza mientras vive', async () => {
  const { fetchImpl, calls } = driveStub();
  let now = 0;
  const auth = createGoogleAuth({ refreshToken: 'rt-ok', fetchImpl, now: () => now });

  assert.equal(await auth.getAccessToken(), 'access-1');
  assert.equal(await auth.getAccessToken(), 'access-1');
  assert.equal(calls.filter((c) => c.path === '/auth/refresh').length, 1, 'no se pide uno por llamada');

  now += 3600_000; // más allá del margen de 60 s
  await auth.getAccessToken();
  assert.equal(calls.filter((c) => c.path === '/auth/refresh').length, 2);

  await auth.getAccessToken(true);
  assert.equal(calls.filter((c) => c.path === '/auth/refresh').length, 3);
});

test('auth: un refresh token revocado se cuenta como «reconecta», no como bucle de error', async () => {
  const { fetchImpl } = driveStub();
  const auth = createGoogleAuth({ refreshToken: 'rt-viejo', fetchImpl });
  await assert.rejects(() => auth.getAccessToken(), (e) => e instanceof SourceError && /vuelve a conectar/.test(e.message));
});

test('auth: sin credenciales se dice exactamente qué falta', async () => {
  const auth = createGoogleAuth({});
  await assert.rejects(() => auth.getAccessToken(), /--refresh-token-file/);
});

test('auth: un access token suelto sirve para una prueba de una hora', async () => {
  const auth = createGoogleAuth({ accessToken: 'tok-manual' });
  assert.equal(await auth.getAccessToken(), 'tok-manual');
});

test('auth: el fichero del refresh token se lee entero y sin el salto de línea', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bookreader-mcp-token-'));
  const path = join(dir, 'refresh-token');
  await writeFile(path, '1//0gTokenConSalto\n', 'utf8');
  assert.equal(await readRefreshTokenFile(path), '1//0gTokenConSalto');
  await assert.rejects(() => readRefreshTokenFile(join(dir, 'no-existe')), /refresh token/);
});

test('provider: lista con el prefijo y lee con alt=media', async () => {
  const { fetchImpl, calls } = driveStub();
  const provider = createGoogleDriveProvider({ getAccessToken: async () => 'access-1', fetchImpl });

  const listed = await provider.list('bookreader/books/');
  assert.deepEqual(
    listed.map((f) => f.path),
    ['bookreader/books/' + BOOK_1.id + '.json', 'bookreader/books/7c4d1e9ab0f23a58.json'],
  );
  assert.equal(listed[0].etag, '3', 'la versión de Drive hace de etag');

  const file = await provider.read('bookreader/manifest.json');
  assert.match(file.content, /schemaVersion/);
  assert.ok(calls.some((c) => c.q.includes("name='bookreader/manifest.json'")));
  assert.equal(await provider.read('bookreader/no-existe.json'), null);
});

test('provider: un 401 se reintenta una vez tras renovar, y no dos', async () => {
  const real = driveStub();
  const forces = [];
  let primera = true;
  const fetchImpl = async (url, options) => {
    if (String(url).includes('/drive/v3/files') && primera) {
      primera = false;
      return jsonRes({ error: { message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } }, 401);
    }
    return real.fetchImpl(url, options);
  };
  const provider = createGoogleDriveProvider({
    getAccessToken: async (force) => {
      forces.push(Boolean(force));
      return 'access-1';
    },
    fetchImpl,
  });
  const listed = await provider.list('bookreader/');
  assert.equal(listed.length, 4);
  assert.deepEqual(forces, [false, true], 'un 401 fuerza UNA renovación y se reintenta una vez');
});

test('provider: un error de Drive llega como SourceError con motivo, no como «algo falló»', async () => {
  const provider = createGoogleDriveProvider({
    getAccessToken: async () => 'access-1',
    fetchImpl: async () => jsonRes({ error: { message: 'Quota exceeded', errors: [{ reason: 'storageQuotaExceeded' }] } }, 403),
  });
  await assert.rejects(() => provider.list('bookreader/'), (e) => e instanceof SourceError && /storageQuotaExceeded/.test(e.message));
});

test('de punta a punta: la fuente F2 funciona contra el doble de Drive', async () => {
  const { fetchImpl, calls } = driveStub();
  const auth = createGoogleAuth({ refreshToken: 'rt-ok', fetchImpl });
  const provider = createGoogleDriveProvider({ getAccessToken: (f) => auth.getAccessToken(f), fetchImpl });
  const source = createDriveSource({ provider, cacheMs: 15000 });

  const books = await source.listBooks();
  assert.deepEqual(
    books.map((b) => [b.id, b.highlightCount, b.noteCount]),
    [
      [BOOK_1.id, 3, 2],
      ['7c4d1e9ab0f23a58', 2, 0],
    ],
  );
  const stats = await source.readingDays();
  assert.equal(stats.length, 4);
  assert.ok(calls.some((c) => c.q.includes("name='bookreader/settings.json'")));
  assert.ok(calls.filter((c) => c.path.startsWith('/drive/v3/files/')).length >= 2, 'leyó por alt=media');
});
