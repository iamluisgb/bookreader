// remote.mjs — el MCP remoto (el del Worker del sync, MON4) desde la terminal, para agentes que
// hablan shell y no MCP (pi en Hermes, por ejemplo). Las mismas tools que el servidor local; la
// biblioteca la lee y la descifra el Worker con un token de agente (Ajustes → Datos → Agentes).
//
//   BOOKREADER_MCP_TOKEN=br-mcp-… node mcp/cli.mjs --remote list_books
//   node mcp/cli.mjs --remote --token-file ~/.config/bookreader/mcp-token search_highlights '{"query":"x"}'

import { SourceError } from './errors.mjs';

export const REMOTE_URL = 'https://bookreader-sync.luisgonzalezb93.workers.dev/mcp';
const TIMEOUT_MS = 60000;

export async function readTokenFile(path, readFile, stat) {
  const info = await stat(path);
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new SourceError('El fichero del token (' + path + ') lo pueden leer otros usuarios: chmod 600 ' + path + '.');
  }
  return (await readFile(path, 'utf8')).trim();
}

/** Una llamada JSON-RPC al MCP remoto. Devuelve `result` o lanza con un mensaje legible. */
export async function remoteCall({ url = REMOTE_URL, token, method, params = {}, fetchImpl = fetch }) {
  if (!token) throw new SourceError('Falta el token del agente: BOOKREADER_MCP_TOKEN o --token-file (se crea en la app: Ajustes → Datos → Agentes).');
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401) throw new SourceError('El token no vale: revocado, caducado o mal copiado. Crea otro en la app (Ajustes → Datos → Agentes).');
  if (res.status === 403) throw new SourceError('Sin acceso: la suscripción de BookReader ha caducado.');
  if (!res.ok) throw new SourceError('El MCP remoto respondió ' + res.status + '.');
  const body = await res.json();
  if (body.error) throw new SourceError('MCP remoto: ' + body.error.message);
  return body.result;
}
