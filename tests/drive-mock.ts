import { Page } from '@playwright/test';

// Mock de red compartido para los tests de sync: Worker de auth + Drive API v3
// (appDataFolder) en memoria. El "Drive" vive en el proceso del test (Node), así
// que sobrevive a recargas de página y sirve para simular varios dispositivos.

export type DriveFile = { id: string; name: string; content: string; version: number };

export type DriveMock = {
  store: Map<string, DriveFile>;
  counters: { refresh: number; manifestFinds: number };
  /** Simula un escritor concurrente: bumpea la versión del manifest en el N-ésimo lookup por nombre. */
  bumpManifestAtFind: (n: number) => void;
  /** Hace que el Worker devuelva invalid_grant (token revocado). */
  revokeToken: () => void;
  seedFile: (name: string, content: string) => void;
};

export async function installDriveMocks(page: Page): Promise<DriveMock> {
  const store = new Map<string, DriveFile>();
  let nextId = 1;
  const counters = { refresh: 0, manifestFinds: 0 };
  let bumpAt = -1;
  let revoked = false;

  await page.route('https://bookreader-auth.luisgonzalezb93.workers.dev/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/auth/refresh') {
      counters.refresh++;
      if (revoked) return route.fulfill({ status: 400, json: { error: 'invalid_grant' } });
      return route.fulfill({ json: { access_token: 'tok_test', expires_in: 3600 } });
    }
    return route.fulfill({ status: 404, json: { error: 'not_found' } });
  });

  function parseMultipart(body: string) {
    const parts = body
      .split('-----bookreader_boundary')
      .map((p) => p.split('\r\n\r\n')[1])
      .filter((p): p is string => p !== undefined)
      .map((p) => p.replace(/\r\n$/, ''));
    return { metadata: JSON.parse(parts[0]), content: parts[1] };
  }

  await page.route('https://www.googleapis.com/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const asMeta = (f: DriveFile) => ({
      id: f.id, name: f.name, version: String(f.version), modifiedTime: new Date().toISOString(),
    });

    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      let files = [...store.values()];
      const m = url.searchParams.get('q')?.match(/name='(.+)'/);
      if (m) {
        const name = m[1].replace(/\\'/g, "'");
        if (name === 'bookreader/manifest.json') {
          counters.manifestFinds++;
          const f = store.get(name);
          if (f && counters.manifestFinds === bumpAt) f.version++; // "otro dispositivo" escribió
        }
        files = files.filter((f) => f.name === name);
      }
      return route.fulfill({ json: { files: files.map(asMeta) } });
    }
    const dl = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (dl && method === 'GET' && url.searchParams.get('alt') === 'media') {
      const f = [...store.values()].find((x) => x.id === dl[1]);
      return f ? route.fulfill({ body: f.content }) : route.fulfill({ status: 404, body: '' });
    }
    if (dl && method === 'DELETE') {
      for (const [k, f] of store) if (f.id === dl[1]) store.delete(k);
      return route.fulfill({ status: 204, body: '' });
    }
    if (url.pathname === '/upload/drive/v3/files' && method === 'POST') {
      const { metadata, content } = parseMultipart(req.postData() || '');
      const f: DriveFile = { id: 'f' + nextId++, name: metadata.name, content, version: 1 };
      store.set(f.name, f);
      return route.fulfill({ json: asMeta(f) });
    }
    const up = url.pathname.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);
    if (up && method === 'PATCH') {
      const f = [...store.values()].find((x) => x.id === up[1]);
      if (!f) return route.fulfill({ status: 404, body: '' });
      f.content = parseMultipart(req.postData() || '').content;
      f.version++;
      return route.fulfill({ json: asMeta(f) });
    }
    return route.fulfill({ status: 500, body: 'mock: ruta no soportada ' + method + ' ' + url.pathname });
  });

  return {
    store,
    counters,
    bumpManifestAtFind: (n) => { bumpAt = n; },
    revokeToken: () => { revoked = true; },
    seedFile: (name, content) => {
      store.set(name, { id: 'f' + nextId++, name, content, version: 1 });
    },
  };
}

export async function seedDriveToken(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('bookreader_drive_refresh_token', JSON.stringify('rt_test'));
  });
}
