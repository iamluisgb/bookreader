#!/usr/bin/env node
// cli.mjs — la misma biblioteca, sin protocolo: una tool por invocación y el JSON por stdout.
//
//   node mcp/cli.mjs --backup backup.json list_books
//   node mcp/cli.mjs --backup backup.json search_highlights '{"query":"consenso"}'
//   node mcp/cli.mjs --dir ./bookreader tools        → qué tools tiene esta fuente
//   node mcp/cli.mjs --remote list_books             → el MCP remoto del sync de BookReader,
//                                                      con BOOKREADER_MCP_TOKEN (o --token-file)
//
// Para qué, si ya hay servidor MCP: para comprobar la fuente en dos comandos, para depurar
// una tool sin cliente MCP, y para agentes que hablan shell y no MCP (pi, por ejemplo, que en
// esta versión no trae cliente MCP: `node mcp/cli.mjs …` es la vía).

import { pathToFileURL } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import { remoteCall, readTokenFile, REMOTE_URL } from './src/remote.mjs';
import { parseConfig, usage, ConfigError } from './src/config.mjs';
import { createSource } from './src/sources/index.mjs';
import { callTool, toolsFor } from './src/tools.mjs';

// Interruptores: no consumen el argumento siguiente (que suele ser la tool).
const SWITCHES = new Set(['--help', '-h', '--version', '-V', '--remote']);

export function splitArgs(argv = []) {
  const flags = [];
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      flags.push(arg);
      // Las opciones con valor lo consumen; los interruptores no.
      if (!SWITCHES.has(arg) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
        flags.push(argv[++i]);
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const { stdout = process.stdout, stderr = process.stderr, env = process.env, fetchImpl = fetch } = io;
  const { flags, positionals } = splitArgs(argv);
  const tool = positionals[0];
  const rawArgs = positionals[1];

  if (flags.includes('--remote')) return remote(flags, tool, rawArgs, { stdout, stderr, env, fetchImpl });

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

// --remote: sin fuente local; las tools las ejecuta el MCP del Worker del sync.
async function remote(flags, tool, rawArgs, { stdout, stderr, env, fetchImpl }) {
  const opt = (name) => { const i = flags.indexOf(name); return i >= 0 ? flags[i + 1] : null; };
  if (!tool) {
    stderr.write('Uso: node mcp/cli.mjs --remote [--url <url>] [--token-file <p>] <tool> [\'{"json":"de argumentos"}\']\n');
    return 2;
  }
  let args = {};
  try { if (rawArgs !== undefined) args = JSON.parse(rawArgs); }
  catch (e) { stderr.write('Los argumentos de la tool no son JSON válido: ' + e.message + '\n'); return 2; }
  try {
    const tokenFile = opt('--token-file') || env.BOOKREADER_MCP_TOKEN_FILE;
    const token = env.BOOKREADER_MCP_TOKEN || (tokenFile ? await readTokenFile(tokenFile, readFile, stat) : '');
    const url = opt('--url') || env.BOOKREADER_MCP_URL || REMOTE_URL;
    if (tool === 'tools' || tool === 'list-tools') {
      const r = await remoteCall({ url, token, method: 'tools/list', fetchImpl });
      stdout.write(r.tools.map((t) => t.name).join('\n') + '\n');
      return 0;
    }
    const r = await remoteCall({ url, token, method: 'tools/call', params: { name: tool, arguments: args }, fetchImpl });
    const text = r.content.map((c) => c.text).join('\n');
    (r.isError ? stderr : stdout).write(text + '\n');
    return r.isError ? 1 : 0;
  } catch (e) {
    stderr.write(e.message + '\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main();
  process.exitCode = code;
}
