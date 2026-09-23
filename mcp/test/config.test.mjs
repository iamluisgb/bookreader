// config.mjs — el arranque no adivina de dónde leer, y lo dice claro cuando falta algo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, ConfigError, DEFAULT_BASE } from '../src/config.mjs';

test('--backup implica la fuente de backup, sin OAuth ni credenciales', () => {
  const c = parseConfig(['--backup', '/tmp/b.json'], {});
  assert.equal(c.source, 'backup-file');
  assert.equal(c.backupPath, '/tmp/b.json');
  assert.equal(c.base, DEFAULT_BASE);
});

test('--dir implica la fuente drive con proveedor local', () => {
  const c = parseConfig(['--dir', '/tmp/layout'], {});
  assert.equal(c.source, 'drive');
  assert.equal(c.layoutDir, '/tmp/layout');
});

test('sin fuente no arranca: mensaje con la ayuda, no un error críptico', () => {
  assert.throws(() => parseConfig([], {}), (e) => e instanceof ConfigError && /--backup o --dir/.test(e.message));
});

test('las dos fuentes a la vez es ambiguo', () => {
  assert.throws(
    () => parseConfig(['--backup', 'b.json', '--dir', 'layout'], {}),
    /no las dos/,
  );
});

test('la fuente drive exige credenciales o carpeta local', () => {
  assert.throws(() => parseConfig(['--source', 'drive'], {}), /credenciales/);
  assert.doesNotThrow(() => parseConfig(['--source', 'drive', '--dir', 'layout'], {}));
  assert.doesNotThrow(() => parseConfig(['--source', 'drive'], { BOOKREADER_DRIVE_REFRESH_TOKEN: 'rt' }));
});

test('mezclar --dir con credenciales de Drive es un error: o una vía o la otra', () => {
  assert.throws(
    () => parseConfig(['--dir', 'layout', '--access-token', 'tok'], {}),
    /proveedor local/,
  );
});

test('el entorno sustituye a los flags (registro en Claude Desktop sin rutas en el JSON)', () => {
  const c = parseConfig([], { BOOKREADER_MCP_BACKUP: '/tmp/b.json', BOOKREADER_MCP_CACHE_MS: '1000' });
  assert.equal(c.source, 'backup-file');
  assert.equal(c.backupPath, '/tmp/b.json');
  assert.equal(c.cacheMs, 1000);
});

test('--base tiene que acabar en / y no puede llevar ..', () => {
  assert.equal(parseConfig(['--backup', 'b.json', '--base', 'otro/'], {}).base, 'otro/');
  assert.throws(() => parseConfig(['--backup', 'b.json', '--base', 'otro'], {}), /acabar en/);
  assert.throws(() => parseConfig(['--backup', 'b.json', '--base', '../x/'], {}), /\.\./);
});

test('un flag desconocido o sin valor no pasa de largo', () => {
  assert.throws(() => parseConfig(['--backup'], {}), /le falta el valor/);
  assert.throws(() => parseConfig(['--backup', 'b.json', '--turbo'], {}), /desconocida/);
  assert.throws(() => parseConfig(['suelto'], {}), /inesperado/);
});

test('--cache-ms inválido no arranca', () => {
  assert.throws(() => parseConfig(['--backup', 'b.json', '--cache-ms', 'muchos'], {}), /cache-ms/);
  assert.throws(() => parseConfig(['--backup', 'b.json', '--cache-ms', '-1'], {}), /cache-ms/);
});

test('--help y --version salen sin fuente', () => {
  assert.equal(parseConfig(['--help'], {}).help, true);
  assert.equal(parseConfig(['--version'], {}).version, '1.0.0');
});

test('fuente desconocida: se dice cuáles valen', () => {
  assert.throws(() => parseConfig(['--source', 'dropbox'], {}), /backup-file o drive/);
});
