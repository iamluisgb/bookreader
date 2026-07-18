import { Page, BrowserContext } from '@playwright/test';

// Mock de red compartido para los tests de sync: Worker de auth + Drive API v3
// (appDataFolder) en memoria. El "Drive" vive en el proceso del test (Node), así
// que sobrevive a recargas de página y sirve para simular varios dispositivos.
//
// Un mismo `DriveState` puede instalarse en VARIAS páginas/contextos a la vez
// (installDriveMocks(page, state)): así dos dispositivos independientes —cada uno
// con su localStorage/IndexedDB— comparten el mismo Drive, que es justo el
// escenario de "subrayo en el móvil y el PC no lo ve".

export type DriveRevision = { id: string; content: string; modifiedTime: string; size: number };
export type DriveFile = { id: string; name: string; content: string; version: number; revisions: DriveRevision[] };

// Estado del Drive compartido entre dispositivos (creado en el test, no por página).
export type DriveState = {
  store: Map<string, DriveFile>;
  counters: { refresh: number; manifestFinds: number };
  nextId: number;
  revId: number;
  bumpAt: number;
  revoked: boolean;
};

export type DriveMock = {
  store: Map<string, DriveFile>;
  counters: { refresh: number; manifestFinds: number };
  state: DriveState;
  /** Simula un escritor concurrente: bumpea la versión del manifest en el N-ésimo lookup por nombre. */
  bumpManifestAtFind: (n: number) => void;
  /** Hace que el Worker devuelva invalid_grant (token revocado). */
  revokeToken: () => void;
  seedFile: (name: string, content: string) => void;
};

export function createDriveState(): DriveState {
  return {
    store: new Map<string, DriveFile>(),
    counters: { refresh: 0, manifestFinds: 0 },
    nextId: 1,
    revId: 1,
    bumpAt: -1,
    revoked: false,
  };
}

function routeTarget(target: Page | BrowserContext) {
  return target;
}

// Instala las rutas del Worker + Drive sobre `target` (una Page o un
// BrowserContext) apuntando a `state`. Si no se pasa state, crea uno nuevo (API
// clásica de un solo dispositivo). Devuelve el control del Drive.
export async function installDriveMocks(
  target: Page | BrowserContext,
  state: DriveState = createDriveState(),
): Promise<DriveMock> {
  const { store, counters } = state;

  await routeTarget(target).route('https://bookreader-auth.luisgonzalezb93.workers.dev/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/auth/refresh') {
      counters.refresh++;
      if (state.revoked) return route.fulfill({ status: 400, json: { error: 'invalid_grant' } });
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

  await routeTarget(target).route('https://www.googleapis.com/**', async (route) => {
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
          if (f && counters.manifestFinds === state.bumpAt) f.version++; // "otro dispositivo" escribió
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
    // Revisiones (recovery, Fase 3)
    const revList = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)\/revisions$/);
    if (revList && method === 'GET') {
      const f = [...store.values()].find((x) => x.id === revList[1]);
      const revisions = (f?.revisions || []).map((r) => ({ id: r.id, modifiedTime: r.modifiedTime, size: String(r.size) }));
      return route.fulfill({ json: { revisions } });
    }
    const revGet = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)\/revisions\/([^/]+)$/);
    if (revGet && method === 'GET' && url.searchParams.get('alt') === 'media') {
      const f = [...store.values()].find((x) => x.id === revGet[1]);
      const r = f?.revisions.find((x) => x.id === revGet[2]);
      return r ? route.fulfill({ body: r.content }) : route.fulfill({ status: 404, body: '' });
    }
    if (dl && method === 'DELETE') {
      for (const [k, f] of store) if (f.id === dl[1]) store.delete(k);
      return route.fulfill({ status: 204, body: '' });
    }
    const mkRev = (content: string): DriveRevision =>
      ({ id: 'r' + state.revId++, content, modifiedTime: new Date(Date.now() + state.revId * 1000).toISOString(), size: content.length });
    if (url.pathname === '/upload/drive/v3/files' && method === 'POST') {
      const { metadata, content } = parseMultipart(req.postData() || '');
      const f: DriveFile = { id: 'f' + state.nextId++, name: metadata.name, content, version: 1, revisions: [mkRev(content)] };
      store.set(f.name, f);
      return route.fulfill({ json: asMeta(f) });
    }
    const up = url.pathname.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);
    if (up && method === 'PATCH') {
      const f = [...store.values()].find((x) => x.id === up[1]);
      if (!f) return route.fulfill({ status: 404, body: '' });
      f.content = parseMultipart(req.postData() || '').content;
      f.version++;
      f.revisions.push(mkRev(f.content));
      return route.fulfill({ json: asMeta(f) });
    }
    return route.fulfill({ status: 500, body: 'mock: ruta no soportada ' + method + ' ' + url.pathname });
  });

  return {
    store,
    counters,
    state,
    bumpManifestAtFind: (n) => { state.bumpAt = n; },
    revokeToken: () => { state.revoked = true; },
    seedFile: (name, content) => {
      const rev = { id: 'r' + state.revId++, content, modifiedTime: new Date().toISOString(), size: content.length };
      store.set(name, { id: 'f' + state.nextId++, name, content, version: 1, revisions: [rev] });
    },
  };
}

export async function seedDriveToken(target: Page | BrowserContext) {
  await routeTarget(target).addInitScript(() => {
    localStorage.setItem('bookreader_drive_refresh_token', JSON.stringify('rt_test'));
  });
}
