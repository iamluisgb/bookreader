// Capa de persistencia en IndexedDB para la feature de IA (E4 del backlog).
// Sin dependencias: envoltorio mínimo sobre IndexedDB con promesas.
//
// Stores:
//   books    (keyPath id)      -> { id, title, addedAt }
//   bookText (keyPath bookId)  -> { bookId, annotatedText, tokenEstimate, blockCount }
//   anchors  (keyPath bookId)  -> { bookId, entries: [ [id, {cfi, chapter}], ... ] }
//   convos   (keyPath id)      -> { id, bookId, templateId, goal, title, createdAt, lastUsedAt } [index: bookId]
//   messages (keyPath id, ++)  -> { id, convoId, bookId?, role, content, ts }  [index: bookId, convoId]
//   notes    (keyPath id, ++)  -> { id, convoId, bookId?, fieldKey, content, sourceCfis, ts } [index: bookId, convoId]
//   sessions (keyPath bookId)  -> LEGACY (v<=3): { bookId, templateId, goal, createdAt } — solo para migrar
//   ratings  (keyPath bookId)  -> { bookId, goal, scores }  (la clave ahora es convoId)
//   decks    (keyPath id, ++)  -> { id, bookId, name, cardType, scope, cards, createdAt } [index: bookId]
//   artifacts(keyPath key)     -> { key:`${bookId}:${kind}`, bookId, kind, result, params, segVersion, createdAt } [index: bookId]
//
// v4: una conversación (convo) por objetivo; varias por libro. messages/notes
// se indexan por convoId. Las conversaciones antiguas (sessions, una por libro)
// se migran a una convo en migrateBook().
// v5: decks — mazos de flashcards generados (feature de export a Anki).
// v6: artifacts — resúmenes y mapas mentales generados, cacheados para no re-generar
// (coste LLM) al reabrir o recargar. Se validan contra SEG_VERSION.

const DB_NAME = 'bookreader_ai';
const DB_VERSION = 6;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const t = req.transaction; // transacción versionchange (acceso a stores existentes)
      if (!db.objectStoreNames.contains('books'))    db.createObjectStore('books',    { keyPath: 'id' });
      if (!db.objectStoreNames.contains('bookText')) db.createObjectStore('bookText', { keyPath: 'bookId' });
      if (!db.objectStoreNames.contains('anchors'))  db.createObjectStore('anchors',  { keyPath: 'bookId' });

      let messages;
      if (!db.objectStoreNames.contains('messages')) {
        messages = db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
        messages.createIndex('bookId', 'bookId', { unique: false });
      } else messages = t.objectStore('messages');
      if (!messages.indexNames.contains('convoId')) messages.createIndex('convoId', 'convoId', { unique: false });

      let notes;
      if (!db.objectStoreNames.contains('notes')) {
        notes = db.createObjectStore('notes', { keyPath: 'id', autoIncrement: true });
        notes.createIndex('bookId', 'bookId', { unique: false });
      } else notes = t.objectStore('notes');
      if (!notes.indexNames.contains('convoId')) notes.createIndex('convoId', 'convoId', { unique: false });

      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'bookId' });
      if (!db.objectStoreNames.contains('ratings'))  db.createObjectStore('ratings',  { keyPath: 'bookId' });
      if (!db.objectStoreNames.contains('convos')) {
        const c = db.createObjectStore('convos', { keyPath: 'id' });
        c.createIndex('bookId', 'bookId', { unique: false });
      }
      if (!db.objectStoreNames.contains('decks')) {
        const d = db.createObjectStore('decks', { keyPath: 'id', autoIncrement: true });
        d.createIndex('bookId', 'bookId', { unique: false });
      }
      if (!db.objectStoreNames.contains('artifacts')) {
        const a = db.createObjectStore('artifacts', { keyPath: 'key' });
        a.createIndex('bookId', 'bookId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    // Si el callback falla hay que ABORTAR: sin esto, `oncomplete` podía resolver antes de
    // que llegara el rechazo y la operación se daba por buena habiendo escrito a medias.
    // En código de sync eso es pérdida de datos silenciosa, que es la peor clase que hay.
    Promise.resolve(fn(s)).then(r => { result = r; }).catch(err => {
      try { t.abort(); } catch (e) { /* ya terminada */ }
      reject(err);
    });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const reqP = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

// Lee, decide y escribe DENTRO de la misma transacción, encadenando por callbacks.
//
// La versión con `await reqP(s.get(k))` y luego `s.put(...)` parecía equivalente y no lo es:
// IndexedDB auto-confirma la transacción en cuanto la cola de microtareas se vacía sin
// peticiones pendientes, así que bajo carga el `put` caía en una transacción ya muerta. Se
// manifestaba como un sync que fallaba 1 de cada 5 veces sin decir nada. Desde un callback de
// petición la transacción sigue viva por definición, y el problema desaparece.
//
// `patch(actual)` devuelve el registro a guardar, o algo falsy para no tocar nada.
function readModifyWrite(s, key, patch) {
  return new Promise((resolve, reject) => {
    const g = s.get(key);
    g.onerror = () => reject(g.error);
    g.onsuccess = () => {
      let next;
      try { next = patch(g.result); } catch (e) { return reject(e); }
      if (!next) return resolve(undefined);
      const p = s.put(next);
      p.onerror = () => reject(p.error);
      p.onsuccess = () => resolve(p.result);
    };
  });
}

// Stores que participan en el sync: sus escrituras de usuario avisan al
// SyncEngine (que hace push con debounce). Las escrituras del propio sync
// (mergeRecords) NO avisan — evita el bucle push→pull→push.
const SYNCED_STORES = ['messages', 'notes', 'convos', 'ratings', 'artifacts', 'decks'];

function notifySync(store) {
  if (!SYNCED_STORES.includes(store)) return;
  try { window.dispatchEvent(new CustomEvent('bookreader:data-changed')); } catch { /* SSR/tests */ }
}

export function get(store, key) {
  return tx(store, 'readonly', s => reqP(s.get(key)));
}

// Todos los registros de un store (para export/backup global, P3).
export function getAll(store) {
  return tx(store, 'readonly', s => reqP(s.getAll()));
}

export function put(store, value) {
  return tx(store, 'readwrite', s => reqP(s.put(value))).then(r => {
    notifySync(store);
    return r;
  });
}

// Mensajes de chat por conversación ------------------------------------------

export function getMessages(convoId) {
  return tx('messages', 'readonly', s => reqP(s.index('convoId').getAll(convoId)));
}

export function addMessage(convoId, role, content) {
  const now = Date.now();
  // uid: identidad global para el merge entre dispositivos (el id autoincremental
  // colisiona entre equipos; sigue siendo solo la clave local). Ver SYNC_PLAN.md.
  return put('messages', { uid: crypto.randomUUID(), convoId, role, content, ts: now, updatedAt: now });
}

function clearByIndex(store, index, key) {
  return tx(store, 'readwrite', s => new Promise((resolve, reject) => {
    const cur = s.index(index).openCursor(IDBKeyRange.only(key));
    cur.onsuccess = () => { const c = cur.result; if (c) { c.delete(); c.continue(); } else resolve(); };
    cur.onerror = () => reject(cur.error);
  }));
}

export function clearMessages(convoId) {
  return clearByIndex('messages', 'convoId', convoId);
}

// Conversaciones (objetivo + plantilla); varias por libro --------------------

export function getConvos(bookId) {
  return tx('convos', 'readonly', s => reqP(s.index('bookId').getAll(bookId)))
    .then(list => (list || []).sort((a, b) => (b.lastUsedAt || b.createdAt || 0) - (a.lastUsedAt || a.createdAt || 0)));
}

export function getConvo(id) {
  return get('convos', id);
}

export async function createConvo(bookId, templateId, goal, title = null, createdAt = null) {
  const now = Date.now();
  const convo = { id: 'cv_' + now.toString(36) + Math.random().toString(36).slice(2, 6),
    bookId, templateId, goal, title, createdAt: createdAt || now, lastUsedAt: now };
  await put('convos', convo);
  return convo;
}

export async function updateConvo(id, patch) {
  const cur = await getConvo(id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  await put('convos', next);
  return next;
}

export function touchConvo(id) {
  return updateConvo(id, { lastUsedAt: Date.now() });
}

// Borra la conversación y todo lo suyo (mensajes, notas, relevancia).
export async function deleteConvo(id) {
  await tx('convos', 'readwrite', s => reqP(s.delete(id)));
  await clearByIndex('messages', 'convoId', id);
  await clearByIndex('notes', 'convoId', id);
  await tx('ratings', 'readwrite', s => reqP(s.delete(id)));
}

// Migra la sesión antigua (una por libro) a una conversación, reasignando sus
// mensajes y notas. Idempotente: si el libro ya tiene conversaciones, no hace nada.
export async function migrateBook(bookId) {
  const convos = await getConvos(bookId);
  if (convos.length) return;
  const ses = await get('sessions', bookId);
  if (!ses) return;
  const convo = await createConvo(bookId, ses.templateId, ses.goal, null, ses.createdAt);
  await reassign('messages', bookId, convo.id);
  await reassign('notes', bookId, convo.id);
}

function reassign(store, bookId, convoId) {
  return tx(store, 'readwrite', s => new Promise((resolve, reject) => {
    const cur = s.index('bookId').openCursor(IDBKeyRange.only(bookId));
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) { const v = c.value; if (!v.convoId) { v.convoId = convoId; c.update(v); } c.continue(); }
      else resolve();
    };
    cur.onerror = () => reject(cur.error);
  }));
}

// Notas de la libreta por conversación --------------------------------------

export function getNotes(convoId) {
  return tx('notes', 'readonly', s => reqP(s.index('convoId').getAll(convoId)))
    .then(list => (list || []).filter(n => !n.deleted));
}

export function addNote(convoId, fieldKey, content, sourceCfis = []) {
  const now = Date.now();
  return put('notes', { uid: crypto.randomUUID(), convoId, fieldKey, content, sourceCfis, ts: now, updatedAt: now });
}

export function updateNote(id, patch) {
  return tx('notes', 'readwrite', s => readModifyWrite(s, id,
    cur => cur && { ...cur, ...patch, id, updatedAt: Date.now() }),
  ).then(r => { notifySync('notes'); return r; });
}

// Borrado lógico (tombstone): el borrado se propaga en el sync en vez de
// resucitar en la unión. La purga física la hace purgeDeletedNotes().
export function deleteNote(id) {
  return tx('notes', 'readwrite', s => readModifyWrite(s, id, (cur) => {
    if (!cur) return null;
    const now = Date.now();
    return { ...cur, deleted: true, deletedAt: now, updatedAt: now };
  })).then(r => { notifySync('notes'); return r; });
}

// Purga física de tombstones de notas anteriores a `olderThan` (ms epoch).
export function purgeDeletedNotes(olderThan) {
  return tx('notes', 'readwrite', s => new Promise((resolve, reject) => {
    const cur = s.openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve();
      if (c.value.deleted && (c.value.deletedAt || 0) < olderThan) c.delete();
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  }));
}

// Sync · Fusiona registros remotos en un store con id autoincremental, casando
// por uid (el id numérico local NO viaja entre dispositivos): mismo uid → gana
// el updatedAt mayor conservando el id LOCAL; uid nuevo → inserta con id nuevo.
export function mergeRecords(store, records) {
  if (!records || !records.length) return Promise.resolve(0);
  // Un solo `await` (el getAll) y después SOLO escrituras: los put no dependen unos de
  // otros, así que no hay nada que esperar y la transacción no puede auto-confirmarse a
  // mitad del bucle. Los errores de cada put burbujean a `t.onerror`, que ya se escucha.
  return tx(store, 'readwrite', s => reqP(s.getAll()).then(existing => {
    const byUid = new Map();
    for (const e of existing) if (e.uid) byUid.set(e.uid, e);
    let written = 0;
    for (const r of records) {
      if (!r || !r.uid) continue; // registros pre-Fase 0: no mergeables
      const l = byUid.get(r.uid);
      if (l) {
        const ru = r.updatedAt || 0;
        const lu = l.updatedAt || 0;
        if (ru > lu || (ru === lu && r.deleted && !l.deleted)) {
          s.put({ ...r, id: l.id });
          written++;
        }
      } else {
        const rest = { ...r };
        delete rest.id; // el id remoto no vale aquí: autoincrement asigna uno local
        s.put(rest);
        written++;
      }
    }
    return written;
  }));
}

// Sync Fase 0 · Backfill de uid/updatedAt en los stores con id autoincremental
// (messages, notes, decks): el id entero colisiona entre dispositivos, el merge
// va por uid. Idempotente: solo escribe campos ausentes.
export function backfillSyncFields(now = Date.now()) {
  const backfill = (store) => tx(store, 'readwrite', s => new Promise((resolve, reject) => {
    const cur = s.openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve();
      const v = c.value;
      let changed = false;
      if (!v.uid) { v.uid = crypto.randomUUID(); changed = true; }
      if (!v.updatedAt) { v.updatedAt = v.ts || v.createdAt || now; changed = true; }
      // Los mazos necesitan identidad por TARJETA además de por mazo: el merge va
      // tarjeta a tarjeta para no perder el estado de repaso (ver mergeDecks).
      for (const card of v.cards || []) {
        if (!card) continue;
        if (!card.uid) { card.uid = crypto.randomUUID(); changed = true; }
        if (!card.updatedAt) { card.updatedAt = v.updatedAt || v.createdAt || now; changed = true; }
      }
      if (changed) c.update(v);
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  }));
  return Promise.all(['messages', 'notes', 'decks'].map(backfill));
}

// Mazos de flashcards (export a Anki + modo Estudiar) -------------------------
//
// Sincronizan (leer en el PC, repasar en el móvil), y eso obliga a dos cosas que no
// hacían falta cuando eran locales:
//
//   1. Identidad POR TARJETA (`card.uid`), no solo por mazo. El estado de repetición
//      espaciada vive dentro de cada tarjeta (`card.srs`), así que un LWW a nivel de
//      mazo tiraría los repasos del otro dispositivo: repasas 20 tarjetas en el bus,
//      el PC guarda una edición después y se pierden. El merge va tarjeta a tarjeta.
//   2. TOMBSTONES, tanto del mazo como de la tarjeta suelta (el editor permite quitar
//      tarjetas): sin ellos, borrar aquí y sincronizar allá las resucita.
//
// Las tarjetas borradas se quedan en el array marcadas `deleted` (y sin `front`, que
// es lo que ya filtraban las vistas) hasta que las purga purgeDeletedDecks().

// Tarjetas VISIBLES de un mazo (las que no son tombstone). Todo lo que cuente,
// pinte o exporte tarjetas debe pasar por aquí.
export function cardsOf(deck) {
  return (deck?.cards || []).filter(c => c && !c.deleted);
}

export function getDecks(bookId) {
  return tx('decks', 'readonly', s => reqP(s.index('bookId').getAll(bookId)))
    .then(list => (list || []).filter(d => !d.deleted).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
}

// Todos los mazos (la cola diaria del modo Estudiar cruza todos los libros).
export function getAllDecks() {
  return getAll('decks')
    .then(list => (list || []).filter(d => !d.deleted).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
}

export function addDeck(deck) {
  const now = Date.now();
  const cards = (deck.cards || []).map(c => ({ uid: crypto.randomUUID(), updatedAt: now, ...c }));
  return put('decks', { uid: crypto.randomUUID(), ...deck, cards, createdAt: now, updatedAt: now });
}

// `patch.cards`, si viene, es la lista COMPLETA de tarjetas visibles del mazo:
//   - las que cambian de contenido o de estado SRS reciben su propio `updatedAt`
//     (es lo que el merge compara: sin sello por tarjeta no hay LWW por tarjeta),
//   - las que estaban y ya no vienen se convierten en tombstone y se conservan.
// Poner el sello aquí y no en cada llamante es a propósito: hay tres sitios que
// escriben tarjetas y olvidarlo en uno se manifestaría como repasos que se pierden
// solo al sincronizar, que es justo el bug imposible de reproducir.
export function updateDeck(id, patch) {
  return tx('decks', 'readwrite', s => readModifyWrite(s, id, (cur) => {
    if (!cur) return null;
    const next = { ...cur, ...patch, id, updatedAt: Date.now() };
    if (patch && patch.cards) next.cards = stampCards(cur.cards, patch.cards, next.updatedAt);
    return next;
  })).then(r => { notifySync('decks'); return r; });
}

// Reconcilia la lista entrante contra la guardada: sella lo que cambió, asigna uid a
// lo nuevo y conserva como tombstone lo que desapareció.
function stampCards(before, after, now) {
  const prev = new Map();
  for (const c of before || []) if (c && c.uid) prev.set(c.uid, c);
  const out = [];
  const seen = new Set();
  for (const c of after || []) {
    if (!c) continue;
    const uid = c.uid || crypto.randomUUID();
    seen.add(uid);
    const old = prev.get(uid);
    const same = old && sameCard(old, c);
    out.push({ ...c, uid, updatedAt: same ? (old.updatedAt || now) : now });
  }
  for (const [uid, old] of prev) {
    if (seen.has(uid)) continue;
    // Ya era tombstone: se respeta su deletedAt para que la purga no se reinicie.
    out.push(old.deleted ? old : { ...old, front: '', back: '', srs: old.srs, deleted: true, deletedAt: now, updatedAt: now });
  }
  return out;
}

function sameCard(a, b) {
  const norm = (c) => JSON.stringify({ front: c.front, back: c.back, type: c.type, chapter: c.chapter, src: c.src, srs: c.srs || null });
  return norm(a) === norm(b);
}

// TOMBSTONE (mismo motivo que en notas y artefactos). Las tarjetas se vacían: un mazo
// borrado no debe seguir ocupando su contenido en el fichero de sync durante 30 días.
export function deleteDeck(id) {
  return tx('decks', 'readwrite', s => readModifyWrite(s, id, (cur) => {
    if (!cur) return null;
    const now = Date.now();
    return { ...cur, cards: [], deleted: true, deletedAt: now, updatedAt: now };
  })).then(r => { notifySync('decks'); return r; });
}

// Purga física: mazos con tombstone caducado y, en los mazos vivos, sus tarjetas
// borradas hace más de `olderThan`.
export function purgeDeletedDecks(olderThan) {
  return tx('decks', 'readwrite', s => new Promise((resolve, reject) => {
    const cur = s.openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve();
      const v = c.value;
      if (v.deleted && (v.deletedAt || 0) < olderThan) c.delete();
      else {
        const kept = (v.cards || []).filter(x => !x.deleted || (x.deletedAt || 0) >= olderThan);
        if (kept.length !== (v.cards || []).length) c.update({ ...v, cards: kept });
      }
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  }));
}

// Sync · Fusiona mazos remotos. Casa por `uid` (el id es autoincremental y colisiona
// entre dispositivos) conservando el id LOCAL, como mergeRecords. La diferencia está en
// las tarjetas: NO se toman las del ganador del LWW, se fusionan por su cuenta —
// si no, repasar en el móvil y editar en el PC hace que uno de los dos pierda su trabajo.
export function mergeDecks(records) {
  if (!records || !records.length) return Promise.resolve(0);
  // Igual que mergeRecords: un solo await (el getAll) y después solo escrituras.
  return tx('decks', 'readwrite', s => reqP(s.getAll()).then(existing => {
    const byUid = new Map();
    for (const e of existing) if (e.uid) byUid.set(e.uid, e);
    let written = 0;
    for (const r of records) {
      if (!r || !r.uid) continue;              // mazo pre-Fase 0: no mergeable
      const l = byUid.get(r.uid);
      if (!l) {
        const rest = { ...r };
        delete rest.id;                        // autoincrement asigna uno local
        s.put(rest);
        written++;
        continue;
      }
      const merged = mergeDeckPair(l, r);
      if (merged) { s.put({ ...merged, id: l.id }); written++; }
    }
    return written;
  }));
}

// Fusión de un mazo (pura, exportada para poder testearla sin IndexedDB).
// Devuelve null si el remoto no aporta nada (evita escrituras que reboten en el sync).
export function mergeDeckPair(local, remote) {
  const lu = local.updatedAt || 0;
  const ru = remote.updatedAt || 0;
  // Metadatos (nombre, tipo, ámbito, borrado del mazo entero): LWW, con el borrado
  // ganando el empate — misma regla determinista que mergeCollections.
  const win = ru > lu || (ru === lu && remote.deleted && !local.deleted) ? remote : local;
  const cards = mergeCards(local.cards, remote.cards);
  const changed = win !== local || !sameCardList(local.cards, cards);
  if (!changed) return null;
  return { ...win, cards: win.deleted ? [] : cards, updatedAt: Math.max(lu, ru) };
}

function mergeCards(local = [], remote = []) {
  const byUid = new Map();
  for (const c of local || []) if (c && c.uid) byUid.set(c.uid, c);
  const out = [];
  const seen = new Set();
  for (const r of remote || []) {
    if (!r || !r.uid) continue;
    seen.add(r.uid);
    const l = byUid.get(r.uid);
    if (!l) { out.push(r); continue; }
    const lu = l.updatedAt || 0;
    const ru = r.updatedAt || 0;
    if (ru > lu || (ru === lu && r.deleted && !l.deleted)) out.push(r);
    else out.push(l);
  }
  for (const l of local || []) {
    if (l && l.uid && !seen.has(l.uid)) out.push(l);
    else if (l && !l.uid) out.push(l);        // pre-backfill: nunca se descarta
  }
  return out;
}

function sameCardList(a, b) {
  if ((a || []).length !== (b || []).length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

// Relevancia de capítulos vs objetivo ---------------------------------------

export function getRatings(bookId) {
  return get('ratings', bookId);
}

export function saveRatings(bookId, goal, scores) {
  return put('ratings', { bookId, goal, scores });
}

// Libro segmentado ----------------------------------------------------------

// Versión del esquema de segmentación. Al subirla, las segmentaciones cacheadas
// con una versión anterior se ignoran y el libro se re-segmenta. v2: las anclas
// EPUB se registran SIEMPRE (antes solo si había CFI → citas huérfanas que salían
// crudas); ahora llevan href/capítulo de fallback. v3: purga cachés ENVENENADAS por
// la carrera al segmentar (el saveSegmented viejo pudo guardar el contenido de un
// libro bajo el id de otro); el guard de prepareBook ya evita nuevas contaminaciones.
// v4: en PDFs "Part → Chapter" los capítulos reales son los hijos de la Part (antes
// todo se atribuía a la Part) → re-segmentar para recuperar la granularidad de capítulo.
// v5: anclas EPUB con CFI de RANGO (no de elemento) → la cita resalta el trozo exacto.
const SEG_VERSION = 5;

export async function loadSegmented(bookId) {
  const [text, anch] = await Promise.all([get('bookText', bookId), get('anchors', bookId)]);
  if (!text || !anch || text.segVersion !== SEG_VERSION) return null;   // stale → re-segmentar
  return {
    annotatedText: text.annotatedText,
    tokenEstimate: text.tokenEstimate,
    blockCount: text.blockCount,
    anchors: new Map(anch.entries),
  };
}

export async function saveSegmented(bookId, title, seg) {
  await put('books', { id: bookId, title, addedAt: Date.now() });
  await put('bookText', {
    bookId,
    segVersion: SEG_VERSION,
    annotatedText: seg.annotatedText,
    tokenEstimate: seg.tokenEstimate,
    blockCount: seg.blockCount,
  });
  await put('anchors', { bookId, entries: [...seg.anchors.entries()] });
}

// Artefactos generados (resumen, mapa mental) --------------------------------
// Persistidos para no re-generar (coste LLM) al reabrir el modal o recargar la app, y para
// conservar el HISTORIAL: cada generación es un artefacto propio con clave única
// `${bookId}:${kind}:${id}` (antes `${bookId}:${kind}`, que se sobrescribía). Se conservan hasta
// que el usuario los borra. Se validan contra SEG_VERSION: si el libro se re-segmentó (anclas
// nuevas), las citas del artefacto viejo ya no casan → se ignora (y se podrá re-generar).

export function getArtifacts(bookId) {
  return tx('artifacts', 'readonly', s => reqP(s.index('bookId').getAll(bookId)))
    .then(list => (list || []).filter(a => a.segVersion === SEG_VERSION && !a.deleted));
}

// Devuelve la clave del artefacto guardado (el handle para borrarlo). `id` opcional: si no
// viene, se genera → cada llamada crea un artefacto NUEVO (no sobrescribe: historial).
export function putArtifact({ bookId, kind, result, params, id }) {
  const now = Date.now();
  const aid = id || crypto.randomUUID();
  const key = `${bookId}:${kind}:${aid}`;
  return put('artifacts', {
    key, id: aid, uid: crypto.randomUUID(),
    bookId, kind, result, params: params || {}, segVersion: SEG_VERSION,
    createdAt: now, updatedAt: now,
  }).then(() => key);
}

// Borra por clave completa (soporta también las claves legacy `${bookId}:${kind}` sin id).
// TOMBSTONE, no borrado físico: sin él, borrar un resumen en el portátil no se propaga y
// el móvil lo devuelve en el siguiente ciclo de sync. La purga la hace purgeDeletedArtifacts().
export function deleteArtifact(key) {
  return tx('artifacts', 'readwrite', s => readModifyWrite(s, key, (cur) => {
    if (!cur) return null;
    const now = Date.now();
    return { ...cur, result: null, deleted: true, deletedAt: now, updatedAt: now };
  })).then(r => { notifySync('artifacts'); return r; });
}

// Purga física de tombstones de artefactos anteriores a `olderThan` (ms epoch).
export function purgeDeletedArtifacts(olderThan) {
  return tx('artifacts', 'readwrite', s => new Promise((resolve, reject) => {
    const cur = s.openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve();
      if (c.value.deleted && (c.value.deletedAt || 0) < olderThan) c.delete();
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  }));
}

// Sync · Fusiona artefactos remotos. A diferencia de messages/notes, la clave (`key`) YA es
// global —`bookId:kind:<uuid>`— así que no hay que casar por uid ni reasignar ids: mismo key
// → gana el updatedAt mayor (con el borrado ganando los empates, como mergeCollections).
// El `result` de un artefacto no se edita nunca; en la práctica esto solo resuelve
// generado-aquí / borrado-allí.
export function mergeArtifacts(records) {
  if (!records || !records.length) return Promise.resolve(0);
  // Un getAll en vez de un get por clave: así hay UN solo await y el resto son escrituras
  // que no dependen entre sí (antes, el get de cada vuelta dejaba morir la transacción bajo
  // carga y el merge decía que había ido bien sin escribir nada).
  return tx('artifacts', 'readwrite', s => reqP(s.getAll()).then(existing => {
    const byKey = new Map(existing.map(e => [e.key, e]));
    let written = 0;
    for (const r of records) {
      if (!r || !r.key) continue;
      const l = byKey.get(r.key);
      const ru = r.updatedAt || 0;
      const lu = l ? (l.updatedAt || 0) : -1;
      if (!l || ru > lu || (ru === lu && r.deleted && !l.deleted)) {
        s.put(r);
        byKey.set(r.key, r);   // dos registros con la misma clave en el mismo lote: gana el
        written++;             // que corresponda, no el último que pase por aquí
      }
    }
    return written;
  }));
}

// Utilidad: SHA-256 del arrayBuffer del fichero -> id estable del libro.
export async function hashBuffer(arrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
