// Arnés del sync de BookReader: D1 = SQLite de verdad (node:sqlite) con las MISMAS migraciones;
// R2 = un doble en memoria con la API que usa el Worker (y que falla si se lista). Lo usan los
// tests del Worker (sync.test.mjs) y los E2E de la app (tests/bookreader-sync-mock.ts), que
// así corren contra el Worker real y no contra una imitación.

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
export class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async run() { this.db.prepare(this.sql).run(...this.args); return { success: true }; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
}
export function nuevaDB() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).sort()) db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  return { prepare: (sql) => new Stmt(db, sql), _raw: db };
}
export function fakeR2() {
  const m = new Map();
  const uploads = new Map();
  const ops = { put: 0, get: 0, list: 0, parts: 0 };
  const r2 = {
    _m: m, _ops: ops, _uploads: uploads, onPut: null,
    async put(key, body) {
      ops.put++;
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      if (r2.onPut) { const f = r2.onPut; r2.onPut = null; await f(key); }
      m.set(key, bytes);
      return { key, size: bytes.length };
    },
    async get(key, opts = {}) {
      ops.get++;
      const b = m.get(key);
      if (!b) return null;
      const r = opts.range;
      const slice = r ? b.subarray(r.offset || 0, r.length !== undefined ? (r.offset || 0) + r.length : undefined) : b;
      return { body: new Blob([slice]).stream(), size: b.length };
    },
    async delete(keys) { for (const k of [].concat(keys)) m.delete(k); },
    async list() { ops.list++; throw new Error('listar R2 es clase A: no se usa'); },
    async createMultipartUpload(key) {
      const uploadId = 'up' + (uploads.size + 1) + Math.random().toString(36).slice(2, 6);
      uploads.set(uploadId, { key, parts: new Map() });
      return r2.resumeMultipartUpload(key, uploadId);
    },
    resumeMultipartUpload(key, uploadId) {
      return {
        key, uploadId,
        async uploadPart(n, body) {
          const u = uploads.get(uploadId);
          if (!u) throw new Error('upload desconocido');
          ops.parts++;
          u.parts.set(n, new Uint8Array(await new Response(body).arrayBuffer()));
          return { partNumber: n, etag: 'p' + n };
        },
        async complete(parts) {
          const u = uploads.get(uploadId);
          if (!u) throw new Error('upload desconocido');
          const chunks = parts.map((p) => u.parts.get(p.partNumber));
          const total = chunks.reduce((a, c) => a + c.length, 0);
          const out = new Uint8Array(total);
          let o = 0;
          for (const c of chunks) { out.set(c, o); o += c.length; }
          m.set(key, out);
          uploads.delete(uploadId);
          return { key, size: total };
        },
        async abort() { uploads.delete(uploadId); },
      };
    },
  };
  return r2;
}
export const ORIGIN = 'https://bookreader.raiatech.com';
export const env = (extra = {}) => ({
  SYNC: fakeR2(), DB: nuevaDB(), ALLOWED_ORIGINS: ORIGIN, ALLOW_MOCK_LICENSES: '1',
  USAGE_TOKEN: 'secreto', DATA_QUOTA_BYTES: '1000', FILE_QUOTA_BYTES: '5000', FILES_ENABLED: '1',
  MAX_BYTES: '4000', ...extra,
});
