// Reconciliación de identidad entre dispositivos (caso límite documentado en
// SYNC_PLAN.md: "el mismo libro con distinto bookId"). El id canónico es el
// SHA-256 del fichero, así que dos descargas no byte-idénticas del mismo título
// (mirrors de z-lib que estampan metadatos, re-exportados…) producen dos ids:
// cada dispositivo sincroniza "su" libro y los subrayados nunca se cruzan.
//
// Regla: agrupar los ids canónicos (64 hex) por título normalizado; en un grupo
// con más de un id, todos son alias del MENOR lexicográfico. La regla es
// determinista: cada dispositivo la computa por su cuenta con los mismos datos
// (manifest remoto + metadatos locales) y converge al mismo canónico sin
// coordinación ni campos nuevos en el esquema.
//
// Al detectar un alias, las claves locales se fusionan en el canónico con
// migrateBook (unión por uid, LWW, borra la clave vieja) y el mapa queda en
// `book_aliases` para que canonicalOf() redirija las aperturas del libro cuyo
// fichero hashea al id viejo.

import * as Storage from '../storage.js';
import * as Highlights from '../highlights.js';
import * as Bookmarks from '../bookmarks.js';
import * as DB from '../ai/db.js';
import * as LibStore from '../library/store.js';
import { cleanTitle } from './recovery.js';

const KEY = 'book_aliases'; // { <aliasId>: <canonicalId> }

const isCanonicalId = (id) => /^[0-9a-f]{64}$/i.test(id);

// Título comparable entre dispositivos: sin sufijos de mirror (cleanTitle), sin
// tildes, sin puntuación y en minúsculas. "Lituma en los Andes (z-lib.org)" y
// "Lituma en los andes" deben coincidir.
export function normTitle(raw) {
  return cleanTitle(raw)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function getAliases() {
  return Storage.get(KEY, {});
}

// Id canónico de un libro, siguiendo la cadena de alias (con tope por si un
// mapa corrupto formara un ciclo).
export function canonicalOf(id) {
  const map = getAliases();
  let cur = id;
  for (let i = 0; i < 10 && map[cur]; i++) cur = map[cur];
  return cur;
}

// Títulos de todos los ids conocidos: manifest remoto (trae los libros de los
// otros dispositivos) + metadatos locales (agente y biblioteca).
export async function collectTitles(remoteBooks) {
  const titles = {};
  for (const [id, info] of Object.entries(remoteBooks || {})) {
    if (info && info.title) titles[id] = info.title;
  }
  try {
    for (const b of (await DB.getAll('books')) || []) if (b && b.id && b.title) titles[b.id] = b.title;
  } catch (e) { /* IDB no disponible */ }
  try {
    for (const b of (await LibStore.getAllBooks()) || []) if (b && b.id && b.title && !titles[b.id]) titles[b.id] = b.title;
  } catch (e) { /* IDB no disponible */ }
  return titles;
}

// Mapa de alias nuevo (sin aplicar) a partir de { id: título }. Solo agrupa ids
// canónicos: los legacy (epubjs:…, nombre de fichero) los trata purgeOrphans.
export function computeAliases(titlesById) {
  const groups = new Map();
  for (const [id, title] of Object.entries(titlesById || {})) {
    if (!isCanonicalId(id)) continue;
    const t = normTitle(title || '');
    if (!t) continue;
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(id);
  }
  const aliases = {};
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    const canonical = [...ids].sort()[0];
    for (const id of ids) if (id !== canonical) aliases[id] = canonical;
  }
  return aliases;
}

// Calcula, persiste y APLICA los alias: fusiona subrayados/marcadores de cada
// alias en su canónico (también los que un pull posterior re-cree bajo el alias:
// se corre en cada ciclo y migrateBook en vacío es no-op). Devuelve cuántos
// items movió. Síncrono e idempotente.
export function reconcile(titlesById) {
  const map = getAliases();
  let changed = false;
  for (const [alias, canonical] of Object.entries(computeAliases(titlesById))) {
    if (map[alias] !== canonical) { map[alias] = canonical; changed = true; }
  }
  if (changed) Storage.set(KEY, map);
  let moved = 0;
  for (const alias of Object.keys(map)) {
    const canonical = canonicalOf(alias);
    moved += Highlights.migrateBook([alias], canonical);
    moved += Bookmarks.migrateBook([alias], canonical);
  }
  return moved;
}
