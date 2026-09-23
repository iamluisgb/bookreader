#!/usr/bin/env node
// cli.mjs — la misma biblioteca, sin protocolo: una tool por invocación y el JSON por stdout.
//
//   node mcp/cli.mjs --backup backup.json list_books
//   node mcp/cli.mjs --backup backup.json search_highlights '{"query":"consenso"}'
//   node mcp/cli.mjs --dir ./bookreader tools        → qué tools tiene esta fuente
//
// Para qué, si ya hay servidor MCP: para comprobar la fuente en dos comandos, para depurar
// una tool sin cliente MCP, y para agentes que hablan shell y no MCP (pi, por ejemplo, que en
// esta versión no trae cliente MCP: `node mcp/cli.mjs …` es la vía).

import { pathToFileURL } from 'node:url';
import { parseConfig, usage, ConfigError } from './src/config.mjs';
import { createSource } from './src/sources/index.mjs';
import { callTool, toolsFor } from './src/tools.mjs';

export function splitArgs(argv = []) {
  const flags = [];
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      flags.push(arg);
      // Las opciones con valor lo consumen; los interruptores no.
      if (!arg.startsWith('--help') && !arg.startsWith('--version') && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
        flags.push(argv[++i]);
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const { stdout = process.stdout, stderr = process.stderr } = io;
  const { flags, positionals } = splitArgs(argv);
  const tool = positionals[0];
  const rawArgs = positionals[1];

  if (!tool) {
    stderr.write(usage() + '\n\nUso del CLI: node mcp/cli.mjs <tool> [\'{"json":"de argumentos"}\'] [opciones]\n');
    return 2;
  }

  let config;
  try {
    config = parseConfig(flags, process.env);
  } catch (e) {
    stderr.write((e instanceof ConfigError ? e.message : String(e)) + '\n');
    return 2;
  }

  let args = {};
  if (rawArgs !== undefined) {
    try {
      args = JSON.parse(rawArgs);
    } catch (e) {
      stderr.write('Los argumentos de la tool no son JSON válido: ' + e.message + '\n');
      return 2;
    }
  }

  const source = await createSource(config);
  await source.ping();

  if (tool === 'tools' || tool === 'list-tools') {
    stdout.write(toolsFor(source).map((t) => t.name).join('\n') + '\n');
    return 0;
  }

  const result = await callTool(source, tool, args);
  const text = result.content.map((c) => c.text).join('\n');
  if (result.isError) {
    stderr.write(text + '\n');
    return 1;
  }
  stdout.write(text + '\n');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main();
  process.exitCode = code;
}
