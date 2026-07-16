// Utilidades compartidas de los scripts de evals (check/judge/report).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RUNS = path.join(ROOT, 'evals', 'runs');

// Carga .env (mismo patrón sin-dependencias que playwright.config.ts).
export function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* sin .env */ }
}

// Run a puntuar: argumento CLI (nombre bajo evals/runs/) o, por defecto, el más reciente.
export function resolveRunDir(arg = process.argv[2]) {
  if (arg) {
    const dir = path.isAbsolute(arg) ? arg : path.join(RUNS, arg);
    if (!fs.existsSync(dir)) throw new Error(`no existe el run ${dir}`);
    return dir;
  }
  // Por mtime, no alfabético: los runs con nombre ("post-mejoras", "f2-…") rompen el
  // orden por fecha del nombre y el scoring puntuaba el run equivocado.
  const runs = fs.existsSync(RUNS)
    ? fs.readdirSync(RUNS)
      .map(d => ({ d, st: fs.statSync(path.join(RUNS, d)) }))
      .filter(x => x.st.isDirectory())
      .sort((a, b) => a.st.mtimeMs - b.st.mtimeMs)
    : [];
  if (!runs.length) throw new Error('no hay runs en evals/runs/ — genera uno con: npm run eval:gen');
  return path.join(RUNS, runs[runs.length - 1].d);
}

// Los JSON de batería de un run (los produce tests/evals.spec.ts).
export function loadBatteries(runDir) {
  return fs.readdirSync(runDir)
    .filter(f => /^p\d.*\.json$/.test(f))
    .map(f => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(runDir, f), 'utf8')) }));
}

// El resumen del run: el artefacto kind='summary' más reciente. `result` es markdown.
export function summaryOf(battery) {
  const sums = (battery.artifacts || []).filter(a => a.kind === 'summary');
  if (!sums.length) return null;
  const a = sums.sort((x, y) => String(y.id).localeCompare(String(x.id)))[0];
  return typeof a.result === 'string' ? a.result : JSON.stringify(a.result);
}

export function cardsOf(battery) {
  return (battery.decks || []).flatMap(d => d.cards || []);
}

export function citesOf(text) {
  return [...String(text || '').matchAll(/\[\[(a\d+)\]\]/g)].map(m => m[1]);
}

// Objetos JSON balanceados (misma lógica que query-expand.js, para respuestas del juez
// con prosa/razonamiento alrededor). Devuelve el ÚLTIMO objeto parseable, o null.
export function lastJsonObject(text) {
  const t = String(text || '').replace(/```(?:json)?/gi, '').replace(/<think>[\s\S]*?<\/think>/gi, ' ');
  const objs = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}' && depth > 0) { depth--; if (depth === 0 && start >= 0) { objs.push(t.slice(start, i + 1)); start = -1; } }
  }
  for (let i = objs.length - 1; i >= 0; i--) {
    try { return JSON.parse(objs[i]); } catch { /* siguiente */ }
  }
  return null;
}

// Cliente mínimo de nan: no-streaming, UA de navegador (Cloudflare da 403/1010 a UAs
// no-navegador), reintentos simples en transitorios. Llamar SIEMPRE en secuencia:
// nan rechaza concurrencia con la misma key.
export async function nanChat({ model, messages, maxTokens = 4096, temperature = 0 }) {
  const key = process.env.NAN_API_KEY;
  if (!key) throw new Error('NAN_API_KEY no definida (crea .env a partir de .env.example)');
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch('https://api.nan.builders/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, stream: false }),
      });
    } catch (e) {
      // Red caída / reset del proveedor (ECONNRESET): transitorio, mismo trato que un 5xx.
      if (attempt < 3) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue; }
      throw e;
    }
    if ([408, 425, 429, 500, 502, 503, 504].includes(res.status) && attempt < 3) {
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`nan ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    return json.choices?.[0]?.message?.content || '';
  }
}

export function pct(n, d) { return d ? Math.round((n / d) * 100) : 0; }
export function avg(xs) { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; }
