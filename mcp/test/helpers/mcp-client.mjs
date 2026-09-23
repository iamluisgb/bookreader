// helpers/mcp-client.mjs — un cliente MCP de verdad sobre un servidor de verdad, por stdio.
//
// Los tests de tools NO llaman a las funciones en proceso: arrancan `server.mjs` como proceso
// hijo y hablan JSON-RPC con él, como lo haría Claude Desktop. Es la única forma de probar de
// una vez el protocolo (mensajes, esquemas, isError) y el arranque real (argumentos, ping,
// fuente).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const MCP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SERVER = resolve(MCP_ROOT, 'server.mjs');
export const FIXTURES = resolve(MCP_ROOT, 'test', 'fixtures');

/** Arranca el servidor por stdio y devuelve un cliente cómodo para los tests. */
export async function connect(args = []) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER, ...args],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'bookreader-mcp-test', version: '1.0.0' });
  await client.connect(transport);

  let stderr = '';
  if (transport.stderr) transport.stderr.on('data', (d) => (stderr += d.toString()));

  return {
    client,
    get stderr() {
      return stderr;
    },
    async tools() {
      const res = await client.listTools();
      return res.tools;
    },
    async toolNames() {
      return (await client.listTools()).tools.map((t) => t.name);
    },
    /** Resultado crudo, tal cual lo devuelve el protocolo. */
    raw(name, args) {
      return client.callTool({ name, arguments: args });
    },
    /** Payload ya parseado del JSON que devuelve la tool. */
    async call(name, args) {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content || []).map((c) => c.text || '').join('\n');
      return { isError: Boolean(res.isError), text, json: tryJson(text) };
    },
    close() {
      return client.close();
    },
  };
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
