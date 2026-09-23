#!/usr/bin/env node
// server.mjs — el servidor MCP local por stdio (BACKLOG · P28).
//
//   node mcp/server.mjs --backup ~/bookreader-backup-2026-09-23.json
//   node mcp/server.mjs --dir ~/drive-export/bookreader
//
// Reglas del protocolo que aquí importan:
//   - stdout es EL CANAL. Cualquier log va a stderr: una línea de más en stdout rompe el
//     JSON-RPC y el cliente se queda esperando para siempre.
//   - El servidor se valida a sí mismo al arrancar (`ping`): si la fuente no se puede leer
//     (no es un backup, no hay manifest), se muere con un mensaje claro en stderr en vez de
//     aceptar tools que van a fallar.

import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { parseConfig, usage, VERSION, ConfigError } from './src/config.mjs';
import { createSource } from './src/sources/index.mjs';
import { SourceError } from './src/errors.mjs';
import { callTool, toolsFor } from './src/tools.mjs';

export const SERVER_NAME = 'bookreader-mcp';

const INSTRUCTIONS = [
  'Lee la biblioteca de BookReader del usuario: subrayados, notas de libreta y (con la fuente',
  'de Drive) estadísticas de lectura. Es de solo lectura: aquí no se crea ni se modifica nada.',
  'Empieza por `list_books` para conocer los bookIds. Si una tool no aparece, es que la fuente',
  'no puede responderla: `reading_stats` solo existe con la fuente de Drive.',
].join(' ');

/** El servidor MCP armado sobre una fuente. Exportado para poder probarlo sin proceso hijo. */
export function buildServer(source) {
  const server = new Server(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolsFor(source) }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const params = request.params || {};
    return callTool(source, params.name, params.arguments);
  });

  return server;
}

/**
 * Arranque completo: configuración → fuente → validación → stdio.
 * Devuelve el código de salida (0 en marcha, 2 en error de uso, 1 en error de fuente).
 */
export async function main(argv = process.argv.slice(2), { stderr = process.stderr, connect = true } = {}) {
  let config;
  try {
    config = parseConfig(argv, process.env);
  } catch (e) {
    stderr.write((e instanceof ConfigError ? e.message : String(e)) + '\n');
    return 2;
  }
  if (config.help) {
    stderr.write(usage() + '\n');
    return 0;
  }
  if (config.version) {
    stderr.write(VERSION + '\n');
    return 0;
  }

  let source;
  try {
    source = await createSource(config);
    await source.ping();
  } catch (e) {
    const kind = e instanceof SourceError || e instanceof ConfigError ? 'error' : 'fallo inesperado';
    stderr.write(SERVER_NAME + ': ' + kind + ': ' + e.message + '\n');
    return 1;
  }

  const server = buildServer(source);
  const tools = toolsFor(source)
    .map((t) => t.name)
    .join(', ');
  stderr.write(
    SERVER_NAME +
      ' ' +
      VERSION +
      ' · fuente: ' +
      source.describe() +
      (source.hasReadingStats ? ' (con registro de lectura)' : ' (sin registro de lectura)') +
      ' · tools: ' +
      tools +
      '\n',
  );

  if (connect) await server.connect(new StdioServerTransport());
  return 0;
}

// Solo cuando se ejecuta como programa: importarlo desde un test no debe arrancar nada.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main();
  if (code !== 0) process.exit(code);
}
