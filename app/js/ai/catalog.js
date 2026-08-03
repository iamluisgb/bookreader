// Catálogo de modelos (models.dev) — de dónde salen los modelos que ofrecemos.
//
// "Descubrir" pedía `GET /models` al proveedor, y eso falla en el sitio que más
// importa: nan no manda cabeceras CORS, así que el navegador bloquea la respuesta y
// el botón solo podía fallar en el proveedor por defecto. Donde sí funcionaba
// (OpenRouter) devolvía 337 ids pelados, que tampoco sirven para elegir.
//
// models.dev es el catálogo público que usa opencode: 178 proveedores, CORS abierto
// (`access-control-allow-origin: *`, verificado 2026-08-02) y, sobre todo, METADATOS
// — nombre legible, `tool_call`, `attachment` (acepta imágenes), contexto y precio.
// Con eso el selector de visión puede ofrecer SOLO modelos que ven, en vez de dejar
// escribir un id y que el fallo aparezca semanas después al pulsar "Explicar lo que veo".
//
// PRIVACIDAD: es una petición a un tercero desde una app que no habla con nadie más
// que con tu proveedor. No viaja NADA del libro ni de la key: es un GET a un JSON
// estático. Se pide solo al abrir el selector, nunca en el arranque.
//
// COSTE: el JSON son ~3,4 MB. Se cachea en memoria durante la sesión; entre sesiones
// lo revalida el navegador (la respuesta trae ETag → 304 si no ha cambiado).

const CATALOG_URL = 'https://models.dev/api.json';

let cache = null;        // { providers } ya parseado
let inFlight = null;     // promesa compartida: dos aperturas seguidas no bajan 3,4 MB dos veces

// Normaliza una ficha de models.dev a lo que la UI necesita. `cost` puede faltar
// (modelos locales/gratuitos): se deja en null y quien pinte decide qué hacer.
function normalize(id, m) {
  const inputs = (m.modalities && m.modalities.input) || [];
  return {
    id,
    name: m.name || id,
    tools: !!m.tool_call,
    vision: !!m.attachment && inputs.includes('image'),
    contextK: m.limit && m.limit.context ? Math.round(m.limit.context / 1000) : null,
    costIn: m.cost && typeof m.cost.input === 'number' ? m.cost.input : null,
    costOut: m.cost && typeof m.cost.output === 'number' ? m.cost.output : null,
    releaseDate: m.release_date || '',
  };
}

// Descarga (o devuelve de caché) el catálogo entero. Lanza si no hay red.
export async function load({ signal } = {}) {
  if (cache) return cache;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const res = await fetch(CATALOG_URL, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cache = await res.json();
    return cache;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

// ¿Sabemos pedirle el catálogo a este proveedor? `catalogId` lo declara el preset.
export function has(provider) {
  return !!(provider && provider.catalogId);
}

// Modelos de un proveedor, normalizados y ordenados: primero los que valen para el
// slot, luego por fecha de publicación descendente (lo nuevo arriba, que es lo que
// alguien busca al elegir modelo).
export async function modelsFor(provider, { signal } = {}) {
  if (!has(provider)) return [];
  const data = await load({ signal });
  const entry = data[provider.catalogId];
  const models = (entry && entry.models) || {};
  return Object.entries(models)
    .map(([id, m]) => normalize(id, m))
    .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || '') || a.id.localeCompare(b.id));
}

// Solo para tests: olvida la caché para poder servir otro catálogo.
export function _reset() { cache = null; inFlight = null; }
