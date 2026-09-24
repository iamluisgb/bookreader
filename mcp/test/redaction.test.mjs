// redacción — el test que P28 pide explícitamente: el MCP NUNCA lee ni devuelve `ai_key`,
// `drive_refresh_token` ni `device_id`.
//
// Tres comprobaciones, de menos a más:
//
//   1. En un backup REAL (el que produce la app) esas claves ni están: lo dice el fixture.
//   2. El layout SÍ lleva el `deviceId` dentro de cada registro de lectura (es lo que hace el
//      sync), así que la fuente drive lo tiene que tirar. Se demuestra con el identificador
//      literal del fixture buscado en la salida entera de cada tool.
//   3. Con un fichero ENVENENADO (secretos plantados) ninguna tool los deja pasar: la defensa
//      no depende de que otro módulo se porte bien.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { connect, FIXTURES } from './helpers/mcp-client.mjs';
import { findForbidden, NEVER_EXPOSED_KEYS } from '../src/redact.mjs';
import { BOOK_1, DEVICE_IDS, buildBackupFixture, buildLayoutFiles } from './helpers/dataset.mjs';

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
  ['reading_stats', { range: 'all' }],
];

async function everyPayload(client) {
  const out = [];
  for (const [name, args] of TOOL_CALLS) {
    const res = await client.call(name, args);
    if (res.isError && /Tool desconocida/.test(res.text)) continue; // la fuente no la tiene
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

test('el layout SÍ lleva el deviceId (por eso hay que tirarlo en la fuente drive)', () => {
  // Si esto dejara de ser cierto, el test de abajo pasaría por casualidad y no probaría nada.
  assert.ok(JSON.stringify(buildLayoutFiles()).includes(DEVICE_IDS[0]));
});

test('ninguna tool, con la fuente de Drive, deja asomar un deviceId', async () => {
  const client = await connect(['--dir', resolve(FIXTURES, 'layout')]);
  try {
    const payloads = await everyPayload(client);
    assert.ok(payloads.length >= 4);
    for (const [name, text] of payloads) {
      const hits = findForbidden(JSON.parse(text), { needles: DEVICE_IDS });
      assert.deepEqual(hits, [], name + ' filtra el identificador del dispositivo');
      assert.ok(!/"deviceId"/.test(text), name + ' devuelve la clave deviceId');
      assert.ok(!/"key":/.test(text), name + ' devuelve el `key` del registro (lleva el deviceId dentro)');
    }
  } finally {
    await client.close();
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

test('un layout envenenado tampoco: settings, local y meta con secretos dentro', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bookreader-mcp-layout-'));
  const files = buildLayoutFiles();
  const manifest = files['bookreader/manifest.json'];
  files['bookreader/manifest.json'] = { ...manifest, ai_key: SECRETS.ai_key };
  const settings = files['bookreader/settings.json'];
  files['bookreader/settings.json'] = { ...settings, drive_refresh_token: SECRETS.drive_refresh_token };
  const bookPath = 'bookreader/books/' + BOOK_1.id + '.json';
  const book = files[bookPath];
  files[bookPath] = {
    ...book,
    local: { ...book.local, device_id: SECRETS.device_id },
    meta: { ...book.meta, license: SECRETS.license },
  };
  for (const [rel, value] of Object.entries(files)) {
    const target = join(dir, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(value), 'utf8');
  }

  const client = await connect(['--dir', dir]);
  try {
    for (const [name, text] of await everyPayload(client)) {
      for (const value of [SECRETS.ai_key, SECRETS.drive_refresh_token, SECRETS.device_id, SECRETS.license.key]) {
        assert.ok(!text.includes(value), name + ' filtra ' + value.slice(0, 12));
      }
      assert.deepEqual(findForbidden(JSON.parse(text), { needles: DEVICE_IDS }), [], name);
    }
  } finally {
    await client.close();
  }
});
