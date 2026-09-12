// reading-log.js — cuánto se ha LEÍDO de verdad (P25 F1).
//
// El problema que resuelve: "tiempo con el libro abierto" cuenta igual leer un capítulo
// que pasar treinta páginas buscando una cita — y cuenta también el café. Aquí no se mide
// tiempo, se miden PALABRAS A RITMO PLAUSIBLE.
//
// Cada posición del lector llega en UNIDADES comparables: en EPUB las localizaciones de
// epub.js (~1024 caracteres ≈ 205 palabras cada una), en PDF la página. Entre dos eventos
// hay Δunidades y Δt, y su cociente —palabras por minuto implícitas— clasifica el tramo:
//
//   < MIN_WPM ............ el libro estaba abierto, tú no. No suma.
//   MIN_WPM..MAX_WPM ..... lectura. Suman tiempo y palabras.
//   > MAX_WPM ............ nadie lee a eso: barrido. No suma.
//   salto no contiguo .... navegación. Ni suma ni rompe nada.
//
// El segundo signo es más fuerte que cualquier umbral y sale gratis: el ORIGEN del
// movimiento. Los lectores avisan con markJump() cuando la posición cambió por índice,
// búsqueda, marcador, barra de progreso o cita del agente — no por pasar página. Tras un
// salto el lector entra en modo CONSULTA y no suma hasta encadenar CONSULT_STEPS tramos
// contiguos a ritmo plausible: es justo el caso de "busco algo y doy vueltas por el
// capítulo". Quien salta a un marcador y se pone a leer recupera el conteo en tres tramos.
//
// Dos detalles que separan una cifra honesta de una inflada:
//   - Deduplicar por unidad: cada unidad suma palabras UNA vez. Releer un párrafo tres
//     veces es lectura real, pero no son tres párrafos leídos; el tiempo sí sigue contando.
//   - Cortes duros: pestaña oculta o libro cerrado cierran el tramo abierto, y un hueco
//     mayor que IDLE_MS no cuenta como lectura por mucho que la posición avanzara luego.
//
// Persistencia: un registro por DÍA y DISPOSITIVO (`${día}|${deviceId}`), nunca por día a
// secas. Dos dispositivos leyendo el mismo martes se machacarían en un merge LWW — el
// problema que ya está documentado para la racha de estudio en `sync/layout.js`. Con la
// clave por dispositivo el merge es UNIÓN y al leer se suma (eso es F3; aquí solo se deja
// el modelo listo para que no haya que migrar datos después).
import * as Storage from './storage.js';

const DB_NAME = 'bookreader_reading';
const DB_VERSION = 1;
const STORE = 'days';
const DEVICE_KEY = 'device_id';

// Topes FÍSICOS de la lectura humana, no la velocidad del usuario: por debajo del primero
// no se estaba leyendo y por encima del segundo no se puede haber leído. La velocidad real
// de cada uno se deducirá de sus propios tramos válidos cuando haya con qué (F2).
const MIN_WPM = 50;
const MAX_WPM = 600;
// Hueco sin cambiar de posición a partir del cual el tramo deja de ser lectura. Dos
// minutos mirando la misma página es posible; también lo es haber ido a por un café, y no
// hay forma de distinguirlos, así que no se cuenta.
const IDLE_MS = 2 * 60 * 1000;
// Tramos contiguos y a ritmo plausible que hay que encadenar tras un salto para volver a
// contar. Cuesta hasta tres "páginas" de lectura legítima por salto; a cambio, rastrear un
// capítulo entero a base de saltos no suma ni un minuto.
const CONSULT_STEPS = 3;
// Volcado a IndexedDB con rebote: leer genera un evento por página y no hace falta una
// escritura por página. Lo pendiente se vuelca también al cerrar libro/pestaña.
const FLUSH_MS = 10000;

// Sin palabras conocidas (PDF escaneado, sin capa de texto) se asume una página tipo. Aquí
// sí se estima, al revés que en el pie del lector: dejar fuera del análisis todos los PDFs
// sin capa de texto es peor error que contarlos con una media razonable.
const FALLBACK_UNIT_WORDS = 300;

let book = null;          // { id, unitWords, maxStep }
let anchor = null;        // { unit, t } — inicio del tramo abierto
let lastUnit = 0;
let lastEventAt = 0;      // última señal de vida (vuelta de página, aunque no mueva la unidad)
let consult = 0;          // tramos que faltan para salir del modo consulta
let credited = null;      // Set de unidades ya contadas (libro actual, día actual)
let creditedDay = null;
let pending = new Map();  // día -> { [bookId]: { ms, words, units: Set } }
let flushTimer = null;

// ---- Identidad y calendario ------------------------------------------------

// Id de ESTE dispositivo. No identifica a nadie: solo separa los contadores para que el
// merge de F3 sea una unión y no una carrera.
export function deviceId() {
  let id = Storage.get(DEVICE_KEY);
  if (!id) {
    id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    Storage.set(DEVICE_KEY, id);
  }
  return id;
}

// Día LOCAL (no UTC): leer a las 23:50 en Madrid pertenece a ese día, no al siguiente.
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function recordKey(day) {
  return `${day}|${deviceId()}`;
}

// ---- Almacén ---------------------------------------------------------------

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; }).catch(reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const reqP = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

// ---- Clasificación del tramo (pura: la parte que se testea) ----------------

// Qué fue el tramo que va de `from` a `to` en `dt` milisegundos. `gap` es el mayor hueco
// SIN señal de vida dentro de ese tramo; `unitWords` son las palabras de una unidad y
// `maxStep` el mayor avance que puede dar una vuelta de página (una página ancha cubre
// varias localizaciones; un salto, muchas más).
//
// El corte por inactividad va por `gap` y no por `dt` a propósito. Una página de pantalla
// puede ser MÁS PEQUEÑA que una localización (letra grande, móvil): ahí se pasan tres
// páginas sin que el índice se mueva, y medir el hueco contra el tramo entero descartaba
// como "ausente" justo al lector lento, que es el que más está leyendo. Cada vuelta de
// página es señal de vida aunque la unidad no cambie; que el ritmo global sea humano ya lo
// vigila MIN_WPM.
export function classify(from, to, dt, gap, unitWords, maxStep) {
  const step = to - from;
  if (step === 0) return 'hold';          // misma unidad: el tramo sigue abierto
  if (gap > IDLE_MS) return 'idle';       // se fue a por un café (o cerró el portátil)
  if (step < 0 || step > maxStep) return 'seek';
  if (dt <= 0) return 'skim';
  const wpm = (step * unitWords) / (dt / 60000);
  if (wpm > MAX_WPM) return 'skim';
  if (wpm < MIN_WPM) return 'idle';
  return 'read';
}

// ---- Ciclo de vida del libro abierto ---------------------------------------

// `unitWords`: palabras por unidad. EPUB → 1024 chars / 5 ≈ 205 por localización (es
// constante por construcción de book.locations). PDF → palabras totales / páginas, que se
// conoce más tarde: hasta entonces vale FALLBACK_UNIT_WORDS (ver setUnitWords).
// Devuelve la promesa de haber recuperado lo ya contado hoy. La app no la espera (llega
// en milisegundos y el primer tramo contable tarda medio minuto en cerrarse); los tests
// sí, porque ahí todo pasa en el mismo tick.
export function startBook(id, { unitWords = FALLBACK_UNIT_WORDS, maxStep = 4 } = {}) {
  if (book && book.id !== id) endBook();
  book = { id, unitWords: unitWords || FALLBACK_UNIT_WORDS, maxStep };
  anchor = null;
  lastUnit = 0;
  lastEventAt = 0;
  consult = 0;
  credited = null;
  creditedDay = null;
  return loadCredited(id);
}

export function setUnitWords(w) {
  if (book && w > 0) book.unitWords = w;
}

// Cierra el tramo abierto y suelta el libro. `now` inyectable para los tests. DEVUELVE la
// promesa del volcado: quien cierre el libro y se vaya de la pantalla acto seguido tiene
// que poder esperar a que el último tramo esté en disco, o se pierde.
export function endBook(now = Date.now()) {
  if (book) closeOpenSpan(now);
  book = null;
  anchor = null;
  credited = null;
  creditedDay = null;
  return flush();
}

// La posición cambió por navegación, no por leer: índice, búsqueda, marcador, barra de
// progreso o cita del agente.
export function markJump() {
  if (!book) return;
  anchor = null;              // el tramo en curso muere aquí: no se sabe qué se leyó
  consult = CONSULT_STEPS;
}

// Nueva posición del lector, en unidades (localización de EPUB o página de PDF).
export function position(unit, now = Date.now()) {
  if (!book || !(unit > 0)) return;
  lastUnit = unit;
  if (!anchor) { anchor = { unit, t: now }; lastEventAt = now; return; }

  const gap = now - lastEventAt;
  const verdict = classify(anchor.unit, unit, now - anchor.t, gap, book.unitWords, book.maxStep);
  lastEventAt = now;
  // Aún en la misma unidad: el tramo sigue vivo y la vuelta de página cuenta como señal de
  // vida (por eso lastEventAt se refresca justo antes de salir).
  if (verdict === 'hold') return;

  if (verdict === 'read') {
    // En consulta el tramo es plausible pero todavía no cuenta: solo acerca la salida.
    if (consult > 0) consult--;
    else creditSpan(anchor.unit, unit, now - anchor.t, now);
  }
  anchor = { unit, t: now };
}

// El tramo abierto al cerrar (libro, pestaña): no hay unidad siguiente con la que medir,
// así que se juzga como "se leyó la unidad actual" con el mismo baremo.
function closeOpenSpan(now) {
  if (!anchor) return;
  const dt = now - anchor.t;
  const verdict = classify(anchor.unit, anchor.unit + 1, dt, now - lastEventAt, book.unitWords, book.maxStep);
  if (verdict === 'read' && consult === 0) creditSpan(anchor.unit, anchor.unit + 1, dt, now);
  anchor = null;
}

// ---- Acumulación -----------------------------------------------------------

function creditSpan(from, to, ms, now) {
  const day = dayKey(now);
  if (creditedDay !== day) { credited = new Set(); creditedDay = day; }
  let fresh = 0;
  for (let u = from; u < to; u++) {
    if (credited.has(u)) continue;        // releer no multiplica lo leído
    credited.add(u);
    fresh++;
  }
  const slot = slotFor(day, book.id);
  slot.ms += ms;
  slot.words += Math.round(fresh * book.unitWords);
  for (let u = from; u < to; u++) slot.units.add(u);
  scheduleFlush();
}

function slotFor(day, bookId) {
  let d = pending.get(day);
  if (!d) { d = {}; pending.set(day, d); }
  if (!d[bookId]) d[bookId] = { ms: 0, words: 0, units: new Set() };
  return d[bookId];
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flush(); }, FLUSH_MS);
}

// Vuelca lo pendiente sumándolo al registro del día (lectura-modificación-escritura). Es
// seguro porque el único escritor de `${día}|${deviceId}` es esta pestaña de este equipo.
export function flush() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!pending.size) return Promise.resolve();
  const batch = pending;
  pending = new Map();
  const days = [...batch.entries()];
  return Promise.all(days.map(([day, books]) => tx('readwrite', async (s) => {
    const key = recordKey(day);
    const rec = (await reqP(s.get(key))) || { key, day, deviceId: deviceId(), books: {} };
    for (const [bookId, delta] of Object.entries(books)) {
      const cur = rec.books[bookId] || { ms: 0, words: 0, units: [] };
      cur.ms += delta.ms;
      cur.words += delta.words;
      // `units` es la LISTA de unidades contadas en el registro propio y un CONTADOR en
      // los que llegan por sync (la lista no viaja: son cientos de enteros por libro y
      // día, y fuera de este dispositivo no sirven para nada — la deduplicación es
      // local). Con un contador ya no se puede deduplicar contra él: se suma.
      cur.units = Array.isArray(cur.units)
        ? [...new Set([...cur.units, ...delta.units])].sort((a, b) => a - b)
        : (cur.units || 0) + delta.units.size;
      rec.books[bookId] = cur;
    }
    rec.updatedAt = Date.now();
    s.put(rec);
  }))).catch((e) => {
    // Sin IndexedDB (modo privado) el análisis se queda sin datos, pero leer no se rompe.
    console.warn('reading-log: no se pudo guardar', e);
  });
}

// Unidades ya contadas hoy para este libro: sin esto, cerrar y reabrir el libro volvería a
// contar como nuevas las páginas releídas.
function loadCredited(id) {
  const day = dayKey();
  return tx('readonly', s => reqP(s.get(recordKey(day)))).then((rec) => {
    if (!book || book.id !== id) return;        // se cambió de libro mientras leíamos IDB
    const u = rec && rec.books[id] ? rec.books[id].units : [];
    const units = Array.isArray(u) ? u : [];
    // UNIÓN, no reemplazo: si algún tramo se contó mientras IndexedDB contestaba, lo
    // suyo es sumarlo a lo que ya había, no borrarlo.
    credited = new Set(creditedDay === day && credited ? [...credited, ...units] : units);
    creditedDay = day;
  }).catch(() => { credited = new Set(); creditedDay = day; });
}

// ---- Lectura (lo que consumirá la pantalla de F2) --------------------------

// Todos los registros, de todos los dispositivos que hayan sincronizado.
export function getRecords() {
  return tx('readonly', s => reqP(s.getAll())).catch(() => []);
}

// Unidades contadas de una entrada, venga como lista (registro propio) o como contador
// (registro de otro dispositivo, ver flush).
export function unitCount(v) {
  if (!v) return 0;
  return Array.isArray(v.units) ? v.units.length : (v.units || 0);
}

// Agregado de los últimos `days` días naturales, este incluido. Suma entre dispositivos:
// por eso el merge de F3 puede ser una unión de registros sin tocar estas cuentas.
export async function summary(days = 7, now = Date.now()) {
  const from = dayKey(now - (days - 1) * 86400000);
  const recs = (await getRecords()).filter(r => r.day >= from && r.day <= dayKey(now));
  const out = { ms: 0, words: 0, units: 0, days: 0, books: {}, byDay: {} };
  for (const rec of recs) {
    for (const [bookId, v] of Object.entries(rec.books || {})) {
      const b = out.books[bookId] || (out.books[bookId] = { ms: 0, words: 0, units: 0 });
      const n = unitCount(v);
      b.ms += v.ms; b.words += v.words; b.units += n;
      const d = out.byDay[rec.day] || (out.byDay[rec.day] = { ms: 0, words: 0, units: 0 });
      d.ms += v.ms; d.words += v.words; d.units += n;
      out.ms += v.ms; out.words += v.words; out.units += n;
    }
  }
  out.days = Object.keys(out.byDay).length;
  return out;
}

// ---- Cortes del navegador --------------------------------------------------

// La pestaña se va: cerrar el tramo abierto (no se cuenta el tiempo en segundo plano) y
// volcar. Al volver, el tramo se re-ancla en la última posición con la hora de vuelta, así
// que los minutos de ausencia no se cuelan en la siguiente vuelta de página.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!book) return;
    if (document.visibilityState === 'hidden') { closeOpenSpan(Date.now()); flush(); }
    else if (lastUnit > 0) { anchor = { unit: lastUnit, t: Date.now() }; lastEventAt = Date.now(); }
  });
  // iOS mata la pestaña sin pasar por visibilitychange (ver el comentario gemelo en
  // epub-reader.js): `pagehide` es el único corte fiable ahí.
  window.addEventListener('pagehide', () => {
    if (!book) return;
    closeOpenSpan(Date.now());
    flush();
  });
}

// ---- Sync (P25 F3) ---------------------------------------------------------
//
// Los días viajan como REGISTROS INDEPENDIENTES por dispositivo, y esa es toda la
// estrategia de conflicto: cada equipo escribe solo su propia fila (`${día}|${deviceId}`),
// así que fusionar es UNIR, nunca elegir. Leer el martes en el PC y en la tablet da dos
// filas que se suman; con una fila por día, el LWW se habría comido una de las dos — es el
// problema que ya estaba documentado para la racha de estudio en `sync/layout.js`.

// Días que viajan. Un año largo: suficiente para un "resumen anual" y acotado, que esto va
// dentro de settings.json y no puede crecer sin fin. Lo más viejo no se borra de aquí, solo
// deja de subirse (el otro dispositivo conserva lo que ya tuviera).
const SYNC_DAYS = 400;

// Forma compacta para el sync: la LISTA de unidades se convierte en su cuenta. Son cientos
// de enteros por libro y día, y fuera de este dispositivo no sirven para nada: solo
// alimentan la deduplicación de relecturas, que es local por definición.
export async function exportDays(now = Date.now()) {
  const from = dayKey(now - (SYNC_DAYS - 1) * 86400000);
  const recs = await getRecords();
  return recs
    .filter(r => r && r.day >= from)
    .map(r => ({
      key: r.key, day: r.day, deviceId: r.deviceId, updatedAt: r.updatedAt || 0,
      books: Object.fromEntries(Object.entries(r.books || {})
        .map(([id, v]) => [id, { ms: v.ms, words: v.words, units: unitCount(v) }])),
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));   // huella estable
}

// Une los registros remotos con los locales. Devuelve cuántos se escribieron.
export async function importDays(list) {
  if (!Array.isArray(list) || !list.length) return 0;
  const mine = deviceId();
  let written = 0;
  for (const rec of list) {
    if (!rec || !rec.key || !rec.day) continue;
    try {
      await tx('readwrite', async (s) => {
        const cur = await reqP(s.get(rec.key));
        // La fila PROPIA no se pisa jamás con la copia remota: este dispositivo es su
        // único autor y lo local siempre está igual o más adelantado (la copia de allá es,
        // como mucho, lo que subimos la última vez). La excepción es no tener nada: un
        // equipo reinstalado recupera así su propio histórico.
        if (rec.deviceId === mine && cur) return;
        if (cur && (cur.updatedAt || 0) >= (rec.updatedAt || 0)) return;
        s.put({ ...rec, books: rec.books || {} });
        written++;
      });
    } catch (e) { /* sin IndexedDB: el análisis se queda sin estos días, leer no se rompe */ }
  }
  return written;
}
