import type { Page, BrowserContext } from '@playwright/test';

// MON4 · El sync de BookReader en los tests de la app, contra el Worker REAL
// (workers/sync/src/index.js) corriendo en el proceso del test, sobre SQLite y un R2 en
// memoria (workers/sync/test/harness.mjs). No es una imitación del protocolo: lo que pasa
// aquí es lo que pasaría con el Worker desplegado, cuotas, 412 y solo lectura incluidos.
//
// Un mismo `SyncServer` puede instalarse en varias páginas o contextos: dos dispositivos con
// su propio localStorage/IndexedDB que comparten servidor.

export const SYNC_URL = 'https://bookreader-sync.luisgonzalezb93.workers.dev';

export type SyncServer = {
  env: any;
  worker: { fetch: (req: Request, env: any) => Promise<Response> };
  /** Peticiones recibidas, por método y ruta (sin el id de objeto). */
  calls: string[];
};

export async function createSyncServer(vars: Record<string, string> = {}): Promise<SyncServer> {
  const harness = await import('../workers/sync/test/harness.mjs');
  const mod = await import('../workers/sync/src/index.js');
  const env = harness.env({
    ALLOWED_ORIGINS: 'http://localhost:8888,http://localhost:8890',
    DATA_QUOTA_BYTES: String(50 * 1024 * 1024),
    FILE_QUOTA_BYTES: String(500 * 1024 * 1024),
    MAX_BYTES: String(100 * 1024 * 1024),
    ...vars,
  });
  return { env, worker: mod.default, calls: [] };
}

export async function installSyncServer(target: Page | BrowserContext, server: SyncServer) {
  await target.route(SYNC_URL + '/**', async (route) => {
    const r = route.request();
    const url = new URL(r.url());
    server.calls.push(`${r.method()} ${url.pathname.replace(/\/[A-Za-z0-9_-]{43}(\/|$)/, '/:path$1')}`);
    const headers = await r.allHeaders();
    const body = ['GET', 'HEAD', 'OPTIONS'].includes(r.method()) ? undefined : (r.postDataBuffer() || Buffer.alloc(0));
    if (body) headers['content-length'] = String(body.length);
    const res: Response = await server.worker.fetch(new Request(r.url(), { method: r.method(), headers, body }), server.env);
    const out: Record<string, string> = {};
    res.headers.forEach((v, k) => { out[k] = v; });
    await route.fulfill({ status: res.status, headers: out, body: Buffer.from(await res.arrayBuffer()) });
  });
}

// Licencia de prueba + el sync de BookReader como proveedor activo, antes de cargar la app.
// Sin clave: el primer `enable()` la crea (o pide emparejar si el servidor ya tiene datos).
export async function seedBookReaderSync(target: Page | BrowserContext, license = 'BKRD-TEST-SYNC') {
  await target.addInitScript((lic) => {
    if (!localStorage.getItem('bookreader_license')) {
      localStorage.setItem('bookreader_license', JSON.stringify({ key: lic, activationId: 'mock', validatedAt: Date.now(), revoked: false }));
    }
    if (!localStorage.getItem('bookreader_sync_provider')) localStorage.setItem('bookreader_sync_provider', JSON.stringify('bookreader'));
  }, license);
}
