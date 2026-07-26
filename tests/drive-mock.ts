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
// `binary` solo lo usan los ficheros de libro (bookreader/files/…), que viajan
// como bytes y no como JSON: guardarlos en `content` los corrompería al pasar
// por string.
export type DriveFile = {
  id: string; name: string; content: string; version: number;
  revisions: DriveRevision[]; binary?: Buffer;
};

// Sesión de subida resumable en curso (ficheros > 5 MB, ver drive-provider).
export type UploadSession = {
  name: string; fileId?: string; total: number; received: number; chunks: Buffer[];
};

// Estado del Drive compartido entre dispositivos (creado en el test, no por página).
export type DriveState = {
  store: Map<string, DriveFile>;
  counters: { refresh: number; manifestFinds: number; chunkPuts: number; chunkBytesOffered: number };
  nextId: number;
  revId: number;
  bumpAt: number;
  revoked: boolean;
  sessions: Map<string, UploadSession>;
  /** Trozo (1-indexado) que se acepta SOLO A MEDIAS, para forzar una reanudación. */
  partialAt: number;
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
    counters: { refresh: 0, manifestFinds: 0, chunkPuts: 0, chunkBytesOffered: 0 },
    nextId: 1,
    revId: 1,
    bumpAt: -1,
    revoked: false,
    sessions: new Map<string, UploadSession>(),
    partialAt: -1,
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

  // Igual que parseMultipart pero sobre el Buffer crudo, para los ficheros de
  // libro: se localizan los separadores por índice y el cuerpo se corta como
  // bytes. Pasar un EPUB por String() lo destroza, y el test dejaría de
  // comprobar justo lo que importa (que llegan los mismos bytes).
  const BOUNDARY = Buffer.from('-----bookreader_boundary');
  const CRLF2 = Buffer.from('\r\n\r\n');
  function parseMultipartBuffer(buf: Buffer) {
    const metaStart = buf.indexOf(CRLF2) + 4;
    const metaEnd = buf.indexOf(BOUNDARY, metaStart);
    const metadata = JSON.parse(buf.subarray(metaStart, metaEnd - 2).toString('utf8'));
    const bodyStart = buf.indexOf(CRLF2, metaEnd) + 4;
    const bodyEnd = buf.lastIndexOf(BOUNDARY);
    return { metadata, content: buf.subarray(bodyStart, bodyEnd - 2) };
  }

  // Un upload puede ser JSON (manifest, biblioteca…) o un fichero de libro.
  // Se decide por la ruta que declara la propia metadata.
  function readUpload(buf: Buffer | null, text: string) {
    if (buf) {
      const parsed = parseMultipartBuffer(buf);
      if (String(parsed.metadata.name || '').startsWith('bookreader/files/')) {
        return { metadata: parsed.metadata, content: '', binary: parsed.content as Buffer };
      }
    }
    const { metadata, content } = parseMultipart(text);
    return { metadata, content, binary: undefined as Buffer | undefined };
  }

  await routeTarget(target).route('https://www.googleapis.com/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const asMeta = (f: DriveFile) => ({
      id: f.id, name: f.name, version: String(f.version), modifiedTime: new Date().toISOString(),
      size: String(f.binary ? f.binary.length : f.content.length),
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
      if (!f) return route.fulfill({ status: 404, body: '' });
      // Content-Length: lo usa fetchArrayBuffer para el progreso de la descarga.
      return f.binary
        ? route.fulfill({ body: f.binary, headers: { 'Content-Length': String(f.binary.length) } })
        : route.fulfill({ body: f.content });
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
    // ---- Subida resumable (ficheros > 5 MB) --------------------------------
    //
    // 1) POST/PATCH con uploadType=resumable abre sesión y devuelve su URI en la
    //    cabecera `Location`.
    // 2) PUT de cada trozo con `Content-Range`; el servidor responde 308 con
    //    `Range` hasta que tiene el fichero entero, y 200 al terminar.
    //
    // `Access-Control-Expose-Headers` va explícito a propósito: sin él, el
    // navegador OCULTA `Location` y `Range` al JS aunque la respuesta llegue
    // bien, y no habría forma de subir nada grande. Es el contrato exacto que la
    // API real tiene que cumplir, y dejarlo escrito aquí lo documenta.
    if (url.pathname.startsWith('/upload/drive/v3/files') &&
        url.searchParams.get('uploadType') === 'resumable' && (method === 'POST' || method === 'PATCH')) {
      const metadata = JSON.parse(req.postData() || '{}');
      const sid = 's' + state.nextId++;
      state.sessions.set(sid, {
        name: metadata.name,
        fileId: url.pathname.match(/\/files\/([^/]+)$/)?.[1],
        total: Number(req.headers()['x-upload-content-length'] || 0),
        received: 0,
        chunks: [],
      });
      return route.fulfill({
        status: 200,
        headers: {
          Location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${sid}`,
          'Access-Control-Expose-Headers': 'Location, Range',
        },
        body: '',
      });
    }
    if (url.pathname === '/upload/drive/v3/files' && method === 'PUT' && url.searchParams.get('upload_id')) {
      const sess = state.sessions.get(url.searchParams.get('upload_id')!);
      if (!sess) return route.fulfill({ status: 404, body: '' });
      state.counters.chunkPuts++;
      const m = (req.headers()['content-range'] || '').match(/bytes (\d+)-(\d+)\/(\d+)/);
      if (!m) return route.fulfill({ status: 400, body: 'sin Content-Range' });
      const start = Number(m[1]);
      // Un trozo que no empieza donde el servidor se quedó se RECHAZA con 308:
      // así el test falla ruidosamente si el cliente calcula mal el offset, en
      // vez de ensamblar un fichero corrupto en silencio.
      if (start !== sess.received) {
        return route.fulfill({
          status: 308,
          headers: { Range: `bytes=0-${sess.received - 1}`, 'Access-Control-Expose-Headers': 'Range' },
          body: '',
        });
      }
      let chunk = req.postDataBuffer() || Buffer.alloc(0);
      state.counters.chunkBytesOffered += chunk.length;
      // Aceptación PARCIAL: Drive puede quedarse a medias de un trozo y decir
      // hasta dónde llegó en `Range`. Un cliente que reanude desde su propio
      // offset en vez de desde ese valor duplicaría o perdería bytes y dejaría
      // un fichero corrupto. Sin simularlo, el test no distingue las dos cosas.
      if (state.counters.chunkPuts === state.partialAt && chunk.length > 1) {
        chunk = chunk.subarray(0, Math.floor(chunk.length / 2));
      }
      sess.chunks.push(chunk);
      sess.received += chunk.length;
      if (sess.received < sess.total) {
        return route.fulfill({
          status: 308,
          headers: { Range: `bytes=0-${sess.received - 1}`, 'Access-Control-Expose-Headers': 'Range' },
          body: '',
        });
      }
      const binary = Buffer.concat(sess.chunks);
      const prev = sess.fileId ? [...store.values()].find((x) => x.id === sess.fileId) : store.get(sess.name);
      const f: DriveFile = prev
        ? Object.assign(prev, { binary, content: '', version: prev.version + 1 })
        : { id: 'f' + state.nextId++, name: sess.name, content: '', binary, version: 1, revisions: [] };
      store.set(f.name, f);
      return route.fulfill({ json: asMeta(f) });
    }

    const mkRev = (content: string): DriveRevision =>
      ({ id: 'r' + state.revId++, content, modifiedTime: new Date(Date.now() + state.revId * 1000).toISOString(), size: content.length });
    if (url.pathname === '/upload/drive/v3/files' && method === 'POST') {
      const { metadata, content, binary } = readUpload(req.postDataBuffer(), req.postData() || '');
      const f: DriveFile = {
        id: 'f' + state.nextId++, name: metadata.name, content, binary,
        version: 1, revisions: binary ? [] : [mkRev(content)],
      };
      store.set(f.name, f);
      return route.fulfill({ json: asMeta(f) });
    }
    const up = url.pathname.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);
    if (up && method === 'PATCH') {
      const f = [...store.values()].find((x) => x.id === up[1]);
      if (!f) return route.fulfill({ status: 404, body: '' });
      const up2 = readUpload(req.postDataBuffer(), req.postData() || '');
      f.content = up2.content;
      f.binary = up2.binary;
      f.version++;
      if (!up2.binary) f.revisions.push(mkRev(f.content));
      return route.fulfill({ json: asMeta(f) });
    }
    // Cuota de la cuenta (Ajustes · espacio en Drive)
    if (url.pathname === '/drive/v3/about' && method === 'GET') {
      return route.fulfill({ json: { storageQuota: { limit: String(15 * 1024 ** 3), usage: String(1024 ** 3) } } });
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
