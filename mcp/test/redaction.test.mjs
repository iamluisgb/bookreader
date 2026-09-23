// redacción — el test que P28 pide explícitamente: el MCP NUNCA lee ni devuelve `ai_key`,
// `drive_refresh_token` ni `device_id`.
//
// Dos comprobaciones (F1):
//
//   1. En un backup REAL (el que produce la app) esas claves ni están: lo dice el fixture.
//   2. Con un fichero ENVENENADO (secretos plantados) ninguna tool los deja pasar: la defensa
//      no depende de que otro módulo se porte bien. (El caso del `deviceId` que el layout de
//      sync SÍ lleva dentro de cada registro llega con la fuente de Drive.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from './helpers/mcp-client.mjs';
import { findForbidden, NEVER_EXPOSED_KEYS } from '../src/redact.mjs';
import { BOOK_1, buildBackupFixture } from './helpers/dataset.mjs';

const SECRETS = {
  ai_key: 'sk-proj-clave-secretisima-001',
  drive_refresh_token: '1//0gRefreshTokenFalso',
  device_id: 'dev-robado',
  license: { key: 'BR-PRO-FALSA', activationId: 'act-1' },
};

const TOOL_CALLS = [
  ['list_books', {}],
  ['get_highlights', { bookId: BOOK_1.id }],
  ['get_notes', { bookId: BOOK_1.id }],
  ['search_highlights', { query: 'memoria' }],
];

async function everyPayload(client) {
  const out = [];
  for (const [name, args] of TOOL_CALLS) {
    const res = await client.call(name, args);
    assert.equal(res.isError, false, name + ' falló: ' + res.text);
    out.push([name, res.text]);
  }
  return out;
}

test('el backup real de la app no lleva secretos ni device_id', () => {
  const backup = buildBackupFixture();
  assert.deepEqual(findForbidden(backup), []);
  const raw = JSON.stringify(backup);
  for (const key of ['ai_key', 'drive_refresh_token', 'device_id']) {
    assert.ok(!raw.includes(key), 'el backup versionado no debería tener ' + key);
  }
});

test('un backup envenenado con secretos no los devuelve por ninguna tool', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bookreader-mcp-secrets-'));
  const path = join(dir, 'backup-envenenado.json');
  const backup = buildBackupFixture();
  Object.assign(backup.localStorage, SECRETS);
  backup.ai.books[0].ai_key = SECRETS.ai_key; // también anidado, no solo arriba
  await writeFile(path, JSON.stringify(backup), 'utf8');

  const client = await connect(['--backup', path]);
  try {
    const payloads = await everyPayload(client);
    for (const [name, text] of payloads) {
      for (const [key, value] of Object.entries(SECRETS)) {
        if (typeof value !== 'string') continue;
        assert.ok(!text.includes(value), name + ' filtra el valor de ' + key);
      }
      assert.deepEqual(findForbidden(JSON.parse(text)), [], name + ' filtra una clave vetada');
      for (const key of NEVER_EXPOSED_KEYS) {
        assert.ok(!text.includes('"' + key + '"'), name + ' devuelve ' + key);
      }
    }
  } finally {
    await client.close();
  }
});

