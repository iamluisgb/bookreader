// Arnés compartido de los tests del gateway.
//
// D1 se sustituye por SQLite de verdad (node:sqlite) con las MISMAS migraciones que
// producción: un doble a mano tendría que fingir RETURNING, ON CONFLICT y date('now'),
// que es justo la parte donde vive la atomicidad que importa.

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/index.js';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// Adaptador mínimo de la API de D1 (prepare/bind/first/run) sobre node:sqlite.
class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async run() { this.db.prepare(this.sql).run(...this.args); return { success: true }; }
}

export function nuevaDB() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).sort()) {
    db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  return { prepare: (sql) => new Stmt(db, sql), _raw: db };
}

export function nuevoEnv(extra = {}) {
  return {
    DB: nuevaDB(),
    NAN_API_KEY: 'k',
    NAN_BASE_URL: 'https://proveedor.test/v1',
    ALLOWED_ORIGINS: 'https://bookreader.raiatech.com,https://arete.raiatech.com',
    DEMO_QUOTA: '3',
    MAX_DAILY_TOKENS: '10',
    MAX_DAILY_CALLS: '50',
    ...extra,
  };
}

// Upstream de mentira: registra lo que se le pide y responde como el proveedor.
export function stubUpstream() {
  const llamadas = [];
  globalThis.fetch = async (url, init) => {
    llamadas.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 5 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return llamadas;
}

export const llamar = (env, path, init = {}) =>
  worker.fetch(new Request('https://gw.test' + path, init), env, { waitUntil: (p) => p });

export const pedirDemo = async (env, product) => {
  const res = await llamar(env, '/demo-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' },
    ...(product ? { body: JSON.stringify({ product }) } : {}),
  });
  return { status: res.status, body: await res.json() };
};
