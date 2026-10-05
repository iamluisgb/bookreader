// Pantalla de Biblioteca, inspirada en Google Play Books: rail izquierdo con
// "Libros" + estanterías (miniatura, contador, renombrar/borrar), barra de
// herramientas con orden (Recientes) y filtro (Progreso), y rejilla de portadas.
import * as Store from './store.js';
import * as Shelves from './shelves.js';
import * as Study from '../ai/study.js';
import * as Blobs from '../sync/blobs.js';
import * as DriveAuth from '../sync/drive-auth.js';
import { ensurePro } from '../ui/paywall.js';
import { icon } from '../ui/icons.js';
import { brandMark, brandLockup } from '../ui/brand.js';
import { editBookMeta } from './book-meta.js';
import { t, getLang } from '../i18n.js';
import { escapeHtml } from '../ui/escape.js';
import { confirmBox, promptBox, alertBox, formBox } from '../ui/dialog.js';
import * as AiDB from '../ai/db.js';
import * as Srs from '../ai/srs.js';
import * as Storage from '../storage.js';
import { track } from '../ui/usage-log.js';

let host = null;                 // #library
let onOpenBook = () => {};
let onAddBook = () => {};
let onDropFile = () => {};
let onOpenSettings = () => {};

// Selección de estanterías. Un conjunto, no un valor: las estanterías son
// etiquetas y un libro está en varias, así que lo que la gente quiere ver casi
// siempre es un CRUCE ("Técnico" ∩ "Pendientes"), no una carpeta. Vacía = todos
// los libros; el pseudo-id 'none' (sin estantería) es exclusivo, porque cruzarlo
// con cualquier estantería da siempre el conjunto vacío.
//
// Cada entrada es una FILA del rail, no un id: `{ label, ids }`. Una rama con
// hijas ("Técnico", con "Técnico/ML" debajo) son varios ids que valen como UNA
// condición —"Técnico o algo bajo él"—, y se resuelve en O internamente. Si se
// guardaran los ids sueltos, cruzar esa rama con otra estantería en modo Y
// pediría los libros que están en la rama Y en TODAS sus hijas a la vez: casi
// siempre vacío, y nunca lo que se quería pedir.
let selection = new Map();   // key (id de estantería | 'g:<ruta>' | 'none') → { label, ids }
let matchAllShelves = true;      // true = intersección (Y) · false = unión (O)
let sortBy = 'recent';           // 'recent' | 'title' | 'author'
let filterProgress = 'all';      // 'all' | 'unread' | 'reading' | 'finished'
let query = '';                  // texto del buscador de la estantería (título/autor)
let allBooks = [];               // caché del último render (para refiltrar sin re-fetch)
let allShelves = [];             // ídem para las estanterías (resolver reglas y nombres)
let menuEl = null;
// Ramas plegadas del rail, por RUTA de nodo ("Técnico", "Técnico/ML"). Se
// guarda en localStorage porque plegar una rama es una preferencia de vista, no
// un dato de la biblioteca: no viaja en el sync (cada pantalla es distinta) ni
// cambia lo que contiene una estantería.
const COLLAPSE_KEY = 'bookreader_lib_collapsed';
let collapsed = loadCollapsed();
// Transferencias en curso, por bookId: { loaded, total, state }. Solo para
// pintar la barra de la tarjeta; la verdad la tiene sync/blobs.js.
const transfers = new Map();
// Libro que se está arrastrando sobre el rail, y la fila resaltada debajo.
let dragBookId = null;
let dropRow = null;

function loadCollapsed() {
  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]')); }
  catch (e) { return new Set(); }
}
function saveCollapsed() {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed])); }
  catch (e) { /* storage bloqueado: se pliega solo para esta sesión */ }
}

const SORT_LABELS = { recent: t('Recientes'), title: t('Título'), author: t('Autor') };
const PROG_LABELS = { all: t('Progreso'), unread: t('Sin empezar'), reading: t('Leyendo'), finished: t('Terminados') };

export function init(opts = {}) {
  host = document.getElementById('library');
  onOpenBook = opts.onOpenBook || (() => {});
  onAddBook = opts.onAddBook || (() => {});
  onDropFile = opts.onDropFile || (() => {});
  onOpenSettings = opts.onOpenSettings || (() => {});
  host.addEventListener('click', onClick);
  // «Continuar leyendo» es un botón (role/tabindex): Intro y Espacio lo abren.
  host.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const hero = e.target.closest?.('.lib-hero');
    if (!hero) return;
    e.preventDefault();
    openCard(hero.dataset.id);
  });
  host.addEventListener('input', onInput);
  // Arrastrar una ficha sobre una estantería del rail para meterla ahí: el
  // gesto que cualquiera prueba en una biblioteca. Delegado en el host porque
  // la rejilla y el rail se repintan enteros en cada render.
  host.addEventListener('dragstart', onDragStart);
  host.addEventListener('dragend', endDrag);
  host.addEventListener('dragover', onDragOver);
  host.addEventListener('dragleave', onDragLeave);
  host.addEventListener('drop', onDrop);
  host.addEventListener('pointerdown', onChipPointerDown);
  host.addEventListener('pointermove', onChipPointerMove, { passive: true });
  host.addEventListener('pointerup', onChipPointerEnd);
  host.addEventListener('pointercancel', onChipPointerEnd);
  // La pulsación larga ya abrió el menú: el clic que llega al soltar no filtra.
  host.addEventListener('click', (e) => { if (swallowClick) { swallowClick = false; e.stopPropagation(); e.preventDefault(); } }, true);
  host.addEventListener('contextmenu', (e) => { if (e.target.closest('.lib-schip[data-shelf-id]')) e.preventDefault(); });
  document.addEventListener('click', (e) => {
    if (menuEl && !menuEl.contains(e.target) && !e.target.closest('.lib-kebab, .lib-rail-kebab')) closeMenu();
    if (!e.target.closest('.lib-dd')) host.querySelectorAll('.lib-dd.open').forEach(d => d.classList.remove('open'));
  });

  // El sync trajo libros de otro dispositivo: repintar para que aparezcan sus
  // fichas (o desaparezcan las que se borraron allí).
  window.addEventListener('bookreader:library-changed', () => { if (isOpen()) render(); });
  window.addEventListener('bookreader:blob-progress', onBlobProgress);
}

// Progreso de una transferencia. Se actualiza SOLO la tarjeta afectada: un
// render completo por cada trozo descargado haría parpadear toda la rejilla y
// perdería el foco del buscador.
function onBlobProgress(e) {
  const d = e.detail || {};
  if (!d.id) return;
  if (d.state === 'done' || d.state === 'error') {
    transfers.delete(d.id);
    if (d.state === 'error' && d.message) alertBox(d.message, { title: t('Sincronización') });
    if (isOpen()) render();
    return;
  }
  // `dir` va dentro: sin él la tarjeta decía "Descargando…" mientras subía.
  transfers.set(d.id, { dir: d.dir, loaded: d.loaded || 0, total: d.total || 0, state: d.state });
  paintTransfer(d.id);
}

// Overlay de transferencia en curso. Vive en su propia función porque se pinta
// desde DOS sitios: cardHtml (render normal) y paintTransfer, que lo INYECTA en
// una tarjeta ya dibujada.
function transferOverlayHtml(tr) {
  // Sin `total` no hay porcentaje honesto: el primer evento ('queued') llega
  // antes de saber el tamaño, y en una descarga sin Content-Length nunca se
  // sabe. Barra indeterminada, que un 0% quieto se lee como "está colgado".
  const pct = tr.total ? Math.round((tr.loaded / tr.total) * 100) : 0;
  return `<div class="lib-dl lib-dl-active">
      <div class="lib-dl-bar${tr.total ? '' : ' is-indeterminate'}"><span class="lib-dl-fill" style="width:${pct}%"></span></div>
      <span class="lib-dl-lbl">${transferLabel(tr)}</span>
    </div>`;
}

function transferLabel(tr) {
  if (tr.state === 'queued') return t('Preparando…');
  // La comprobación de integridad de un libro grande tarda segundos: con la
  // barra llena y el rótulo aún en "Descargando…" parecería atascada.
  if (tr.state === 'verifying') return t('Verificando…');
  return tr.dir === 'up' ? t('Subiendo…') : t('Descargando…');
}

// Progreso de UNA tarjeta, sin re-render de la rejilla (ver onBlobProgress).
//
// La tarjeta casi nunca tiene barra cuando llega el primer evento: se pintó en
// modo fantasma (botón "descargar") o, en una subida, sin overlay ninguno —
// `.lib-dl-fill` solo se renderiza si YA había transferencia al pintar. Antes
// esto se rendía ahí (`if (!bar) return`) y el evento se descartaba en
// silencio: nadie volvía a renderizar hasta `done`, así que pulsar descargar no
// movía nada hasta que el fichero estaba entero. Por eso aquí se sustituye el
// overlay en vez de abandonar.
function paintTransfer(id) {
  const card = host && host.querySelector(`.lib-card[data-id="${CSS.escape(id)}"]`);
  if (!card) return;
  const tr = transfers.get(id);
  if (!tr) return;
  card.classList.add('is-transferring');

  const bar = card.querySelector('.lib-dl-fill');
  if (!bar) {
    const old = card.querySelector('.lib-dl');
    if (old) old.outerHTML = transferOverlayHtml(tr);
    else card.querySelector('.lib-cover')?.insertAdjacentHTML('beforeend', transferOverlayHtml(tr));
    return;   // el HTML recién puesto ya refleja ESTE evento
  }
  bar.parentElement?.classList.toggle('is-indeterminate', !tr.total);
  bar.style.width = tr.total ? Math.round((tr.loaded / tr.total) * 100) + '%' : '0%';
  const lbl = card.querySelector('.lib-dl-lbl');
  if (lbl) lbl.textContent = transferLabel(tr);
}

export function show() {
  document.getElementById('epub-container').style.display = 'none';
  document.getElementById('pdf-container').style.display = 'none';
  document.getElementById('reader-footer').style.display = 'none';
  document.body.classList.add('in-library');
  host.style.display = 'block';
}

export function hide() {
  host.style.display = 'none';
  document.body.classList.remove('in-library');
  closeMenu();
}

export function isOpen() {
  return host && host.style.display !== 'none';
}

export async function hasBooks() {
  const books = await Store.getAllBooks();
  return books.length > 0;
}

export async function render() {
  if (!host) return;
  const [books, shelves] = await Promise.all([Store.getAllBooks(), Store.getShelves()]);
  allBooks = books;
  allShelves = shelves;
  memberCache = new Map();   // los datos son otros: la pertenencia calculada caduca

  // Una estantería borrada (aquí o en otro dispositivo) desaparece de la
  // selección en vez de dejarla filtrando por ids que ya no existen.
  const live = new Set(shelves.map(s => s.id));
  for (const [key, entry] of [...selection]) {
    if (key === 'none') continue;
    const ids = entry.ids.filter(id => live.has(id));
    if (ids.length) selection.set(key, { ...entry, ids }); else selection.delete(key);
  }

  const noShelfCount = books.filter(b => !(b.shelfIds && b.shelfIds.length)).length;
  const list = computeList();
  // Manuales y automáticas se pintan en secciones distintas porque no se usan
  // igual: a una manual se le arrastran libros, a una inteligente los mete su
  // regla. Mezcladas, la misma fila prometía dos cosas distintas.
  const manual = shelves.filter(s => !Shelves.isSmart(s));
  const smart = shelves.filter(s => Shelves.isSmart(s));

  host.innerHTML = `
    <div class="lib-layout">
      <aside class="lib-rail" aria-label="${t('Estanterías')}">
        ${brandLockup(24)}
        ${fixedRowHtml('all', `<span class="lib-rail-thumb lib-rail-thumb--all">${icon('library', { size: 'md' })}</span>`,
          t('Libros'), books.length, !selection.size)}
        ${fixedRowHtml('none', `<span class="lib-rail-thumb lib-rail-thumb--none">${icon('inbox', { size: 'md' })}</span>`,
          t('Sin estantería'), noShelfCount, selection.has('none'))}

        ${manual.length ? `<div class="lib-rail-section">${t('Estanterías')}</div>
        ${Shelves.shelfRows(manual).map(railRowHtml).join('')}` : ''}

        ${smart.length ? `<div class="lib-rail-section">${t('Automáticas')}</div>
        ${Shelves.shelfRows(smart).map(railRowHtml).join('')}` : ''}

        <button class="lib-rail-create" data-act="newshelfmenu">${icon('plus', { size: 'md' })}<span>${t('Nueva estantería')}</span></button>
        <button class="lib-rail-create lib-rail-analysis" data-act="analysis">${icon('chart', { size: 'md' })}<span>${t('Análisis')}</span></button>
        <button class="lib-rail-create lib-rail-decks" data-act="decks">${icon('cards', { size: 'md' })}<span>${t('Mazos')}</span></button>
        <button class="lib-rail-create lib-rail-settings" data-act="settings">${icon('gear', { size: 'md' })}<span>${t('Ajustes generales')}</span></button>
      </aside>

      <section class="lib-main">
        ${stripHtml(manual, smart, books.length, noShelfCount)}
        <div class="lib-head">
          ${brandMark(28, 'brand-mark lib-head-mark')}
          <h1 class="lib-h1">${escapeHtml(currentTitle())}</h1>
          ${headShelfKebab(shelves)}
          <button class="lib-more" data-act="more" aria-haspopup="dialog" aria-label="${t('Más: ajustes, análisis, mazos…')}" title="${t('Más')}">${icon('menu', { size: 'xl' })}</button>
        </div>
        ${await firstStepsHtml(books)}
        <div class="lib-top">${continueHtml(books)}<div class="lib-today-slot"></div><span class="lib-streak-slot"></span></div>
        ${filterChipsHtml()}
        <div class="lib-toolbar">
          <div class="lib-search-box">
            ${icon('search', { size: 'md' })}
            <input type="search" class="lib-search" placeholder="${t('Buscar libro…')}" value="${escapeHtml(query)}"
              autocomplete="off" spellcheck="false" aria-label="${t('Buscar libro por título o autor')}">
          </div>
          ${dropdownHtml('sort', icon('sort', { size: 'md' }) + SORT_LABELS[sortBy], SORT_LABELS, sortBy)}
          ${dropdownHtml('progress', PROG_LABELS[filterProgress], PROG_LABELS, filterProgress)}
          <button class="btn btn--primary lib-upload" data-act="add">${icon('upload', { size: 'lg' })}<span>${t('Subir archivos')}</span></button>
        </div>
        <div class="lib-results">${resultsHtml(list)}</div>
      </section>
    </div>
  `;
  syncStrip();        // móvil: el chip activo a la vista y los fundidos de la tira
  paintStudyChip();   // async, no bloquea el render de la rejilla
  paintMastery();     // ídem: dominio por libro, se pinta cuando llega la consulta
}

// ---- Móvil: tira corta de estanterías, cabecera y hojas (auditoría móvil) ---------
// En escritorio el rail es la navegación entera y se queda como está. En móvil ese
// mismo rail, puesto en horizontal, se convertía en una tira de 2.200 px con Ajustes al
// final (a cinco pantallas de deslizar), sin marca de cuál estaba elegida y con el ⋯
// dentro de cada chip. Ahora, en móvil (< 768 px, por CSS):
//   - una tira CORTA: Libros · Sin estantería · las fijadas, la elegida y las últimas
//     usadas (hasta STRIP_SHELVES) · «Estanterías ▾», que abre la hoja con todas;
//   - una cabecera con el título, el ⋯ de la estantería elegida y «Más» (Ajustes,
//     Análisis, Mazos, Nueva estantería, Guía rápida).
// Los chips llevan los mismos data-* que las filas del rail, así que seleccionar pasa
// por el mismo selectRail; pero NO su clase: con .lib-rail-item, los selectores del rail
// de escritorio encontraban también los chips (ocultos) de la tira.
const STRIP_SHELVES = 4;
const PIN_KEY = 'lib_pinned_shelves';
const RECENT_KEY = 'lib_recent_shelves';
const readList = (k) => { try { const v = JSON.parse(localStorage.getItem(k) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const writeList = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage bloqueado */ } };
export function pinnedShelves() { return readList(PIN_KEY); }
function togglePinned(id) {
  const cur = readList(PIN_KEY);
  writeList(PIN_KEY, cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]);
}
function rememberRecent(key) {
  writeList(RECENT_KEY, [key, ...readList(RECENT_KEY).filter(k => k !== key)].slice(0, 8));
}
const isMobile = () => window.matchMedia?.('(max-width: 767px)').matches;

function chipHtml(row) {
  const active = selection.has(row.key);
  const count = memberIdsOf(row.shelfIds).size;
  const smart = row.shelf && Shelves.isSmart(row.shelf);
  const full = row.path || row.label;   // «Técnico/LLM»: el nombre entero va en el title y en la voz
  return `<button class="lib-schip${active ? ' active' : ''}"
      data-row-key="${escapeHtml(row.key)}" data-row-label="${escapeHtml(row.label)}"
      data-shelf-ids="${escapeHtml(row.shelfIds.join(','))}"${row.shelf ? ` data-shelf-id="${escapeHtml(row.shelf.id)}"` : ''}
      title="${escapeHtml(full)}" aria-pressed="${active}" aria-label="${escapeHtml(countLabel(full, count))}">
      ${smart ? icon('funnel', { size: 'sm' }) : ''}<span class="lib-schip-name">${escapeHtml(row.label)}</span><span class="lib-schip-count" aria-hidden="true">${count}</span>
    </button>`;
}

function stripHtml(manual, smart, total, noShelfCount) {
  const rows = [...Shelves.shelfRows(manual), ...Shelves.shelfRows(smart)];
  const byKey = new Map(rows.map(r => [r.key, r]));
  const pinned = pinnedShelves().filter(k => byKey.has(k));
  const picked = [];
  const add = (k) => { if (byKey.has(k) && !picked.includes(k)) picked.push(k); };
  pinned.forEach(add);
  [...selection.keys()].forEach(add);                 // la elegida siempre a la vista
  for (const k of readList(RECENT_KEY)) { if (picked.length >= Math.max(STRIP_SHELVES, pinned.length)) break; add(k); }
  const fixed = (key, name, n, active) => `<button class="lib-schip${active ? ' active' : ''}" data-shelf="${key}"
      aria-pressed="${active}" aria-label="${escapeHtml(countLabel(name, n))}"><span class="lib-schip-name">${escapeHtml(name)}</span><span class="lib-schip-count" aria-hidden="true">${n}</span></button>`;
  return `<nav class="lib-strip" aria-label="${t('Estanterías')}">
    ${fixed('all', t('Libros'), total, !selection.size)}
    ${fixed('none', t('Sin estantería'), noShelfCount, selection.has('none'))}
    ${picked.map(k => chipHtml(byKey.get(k))).join('')}
    ${rows.length ? `<button class="lib-schip lib-schip--more" data-act="shelfsheet" aria-haspopup="dialog">${t('Estanterías')}<span class="lib-schip-count" aria-hidden="true">${rows.length}</span>${icon('chevron-down', { size: 'sm' })}</button>`
      : `<button class="lib-schip lib-schip--more" data-act="newshelfmenu">${icon('plus', { size: 'sm' })}${t('Nueva estantería')}</button>`}
  </nav>`;
}

// ⋯ de la estantería elegida, junto al título: sus opciones, a la vista (en móvil el
// chip solo filtra; también se abren con pulsación larga sobre él).
function headShelfKebab(shelves) {
  if (selection.size !== 1) return '';
  const [key] = selection.keys();
  const shelf = shelves.find(s => s.id === key);
  if (!shelf) return '';
  return `<button class="lib-rail-kebab lib-head-kebab" data-shelf-menu="${escapeHtml(shelf.id)}"
    aria-label="${escapeHtml(t('Opciones de {name}', { name: Shelves.segments(shelf.name).pop() }))}">${icon('ellipsis', { size: 'lg' })}</button>`;
}

// Tras cada render: la tira conserva su desplazamiento, el chip activo queda a la vista
// (antes volvía al principio y el elegido se perdía fuera) y los fundidos dicen hacia
// dónde hay más.
let stripScroll = 0;
function syncStrip() {
  const strip = host.querySelector('.lib-strip');
  if (!strip) return;
  strip.scrollLeft = stripScroll;
  const active = strip.querySelector('.lib-schip.active');
  if (active) {
    const a = active.getBoundingClientRect(), b = strip.getBoundingClientRect();
    if (a.left < b.left || a.right > b.right) {
      strip.scrollLeft += (a.left + a.width / 2) - (b.left + b.width / 2);
    }
  }
  const fades = () => {
    stripScroll = strip.scrollLeft;
    strip.classList.toggle('has-left', strip.scrollLeft > 2);
    strip.classList.toggle('has-right', strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 2);
  };
  strip.addEventListener('scroll', fades, { passive: true });
  fades();
}

// ---- Hojas inferiores (en escritorio, diálogo centrado) ---------------------------
let sheetEl = null;
function closeSheet() {
  if (!sheetEl) return;
  sheetEl.remove();
  sheetEl = null;
  document.removeEventListener('keydown', onSheetKey, true);
}
function onSheetKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeSheet(); } }
function openSheet(title, inner, onAct) {
  closeSheet();
  closeMenu();
  const el = document.createElement('div');
  el.className = 'lib-sheet-overlay';
  el.innerHTML = `<div class="lib-sheet" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="lib-sheet-grip" aria-hidden="true"></div>
      <div class="lib-sheet-head"><h2>${escapeHtml(title)}</h2>
        <button class="lib-sheet-x" aria-label="${t('Cerrar')}">${icon('xmark', { size: 'lg' })}</button></div>
      <div class="lib-sheet-body">${inner}</div>
    </div>`;
  document.body.appendChild(el);
  sheetEl = el;
  el.addEventListener('click', async (e) => {
    if (e.target === el || e.target.closest('.lib-sheet-x')) { closeSheet(); return; }
    await onAct(e);
  });
  document.addEventListener('keydown', onSheetKey, true);
  el.querySelector('.lib-sheet-body button, .lib-sheet-body input')?.focus();
}

// «Más»: lo que en escritorio está al pie del rail.
function openMoreSheet(anchor) {
  const row = (act, ico, label) => `<button class="lib-sheet-row" data-act="${act}">${icon(ico, { size: 'lg' })}<span>${escapeHtml(label)}</span>${icon('chevron-right', { size: 'md' })}</button>`;
  openSheet(t('Más'), `
    ${row('settings', 'gear', t('Ajustes generales'))}
    ${row('analysis', 'chart', t('Análisis'))}
    ${row('decks', 'cards', t('Mazos'))}
    <div class="lib-sheet-sep"></div>
    ${row('newshelfmenu', 'plus', t('Nueva estantería'))}
    ${row('guide', 'help', t('Guía rápida'))}`, async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    closeSheet();
    if (act === 'settings') onOpenSettings();
    else if (act === 'analysis') import('../analysis.js').then(m => m.open()).catch(err => console.warn('analysis:', err));
    else if (act === 'decks') import('../decks.js').then(m => m.open()).catch(err => console.warn('decks:', err));
    else if (act === 'newshelfmenu') openCreateMenu(anchor);
    else if (act === 'guide') import('../ui/feature-guide.js').then(m => m.open()).catch(err => console.warn('guide:', err));
  });
}

// «Estanterías ▾»: el rail de escritorio en vertical. Tocar el nombre elige esa
// estantería y cierra; la casilla la AÑADE al cruce (la selección múltiple que en
// escritorio es ⌘+clic y en táctil no existía más que escondida en el ⋯).
async function openShelfSheet() {
  const shelves = await Store.getShelves();
  const manual = shelves.filter(s => !Shelves.isSmart(s));
  const smart = shelves.filter(s => Shelves.isSmart(s));
  const pins = pinnedShelves();
  const rowHtml = (row) => {
    const on = selection.has(row.key);
    const count = memberIdsOf(row.shelfIds).size;
    const isSmart = row.shelf && Shelves.isSmart(row.shelf);
    return `<div class="lib-sheet-shelf" style="--depth:${row.depth}">
      <input type="checkbox" class="lib-sheet-check" data-cross="${escapeHtml(row.key)}" data-row-label="${escapeHtml(row.label)}" data-shelf-ids="${escapeHtml(row.shelfIds.join(','))}"${on ? ' checked' : ''} aria-label="${escapeHtml(t('Cruzar con {name}', { name: row.label }))}">
      <button class="lib-sheet-pick" data-row-key="${escapeHtml(row.key)}" data-row-label="${escapeHtml(row.label)}" data-shelf-ids="${escapeHtml(row.shelfIds.join(','))}">
        ${isSmart ? `<span class="lib-sheet-mark is-smart">${icon('funnel', { size: 'sm' })}</span>` : (row.kind === 'group' ? '<span class="lib-sheet-mark is-group"></span>' : shelfMarkHtml(row.label))}
        <span class="lib-sheet-name">${escapeHtml(row.label)}</span>
        ${row.shelf && pins.includes(row.shelf.id) ? `<span class="lib-sheet-pin" title="${t('Fijada en la tira')}">${icon('pin', { size: 'sm' })}</span>` : ''}
        <span class="lib-sheet-count">${count}</span>
      </button>
      ${row.shelf ? `<button class="lib-rail-kebab lib-sheet-kebab" data-shelf-menu="${escapeHtml(row.shelf.id)}" aria-label="${escapeHtml(t('Opciones de {name}', { name: row.label }))}">${icon('ellipsis', { size: 'lg' })}</button>` : '<span class="lib-sheet-kebab"></span>'}
    </div>`;
  };
  const multi = [...selection.keys()].filter(k => k !== 'none').length > 1;
  openSheet(t('Estanterías'), `
    ${multi ? `<button class="lib-sheet-mode" data-act="togglemode">${matchAllShelves ? t('Libros en TODAS las marcadas') : t('Libros en ALGUNA de las marcadas')} · ${t('cambiar')}</button>` : ''}
    ${manual.length ? `<div class="lib-sheet-section">${t('Estanterías')}</div>${Shelves.shelfRows(manual).map(rowHtml).join('')}` : ''}
    ${smart.length ? `<div class="lib-sheet-section">${t('Automáticas')}</div>${Shelves.shelfRows(smart).map(rowHtml).join('')}` : ''}
    <div class="lib-sheet-foot"><button class="lib-sheet-new" data-act="newshelfmenu">${icon('plus', { size: 'md' })}<span>${t('Nueva estantería')}</span></button></div>`,
  async (e) => {
    const kebab = e.target.closest('.lib-sheet-kebab[data-shelf-menu]');
    if (kebab) { e.stopPropagation(); closeSheet(); await openShelfMenu(kebab.dataset.shelfMenu, host.querySelector('.lib-head') || host); return; }
    const cross = e.target.closest('.lib-sheet-check');
    if (cross) {
      const key = cross.dataset.cross;
      selection.delete('none');
      if (cross.checked) selection.set(key, { label: cross.dataset.rowLabel, ids: cross.dataset.shelfIds.split(',').filter(Boolean) });
      else selection.delete(key);
      await render();
      await openShelfSheet();          // repinta la hoja (el modo Y/O aparece con dos)
      return;
    }
    const pick = e.target.closest('.lib-sheet-pick');
    if (pick) { closeSheet(); await selectRail(pick); return; }
    if (e.target.closest('[data-act="togglemode"]')) { matchAllShelves = !matchAllShelves; await render(); await openShelfSheet(); return; }
    if (e.target.closest('[data-act="newshelfmenu"]')) { closeSheet(); openCreateMenu(host.querySelector('.lib-more') || host); }
  });
}

// Pulsación larga sobre un chip de estantería = sus opciones. No es descubrible sola:
// por eso la acompaña el ⋯ junto al título. Tras la pulsación larga se traga el clic.
let pressTimer = 0, pressStart = null, swallowClick = false;
function onChipPointerDown(e) {
  const chip = e.target.closest('.lib-schip[data-shelf-id]');
  if (!chip || e.button > 0) return;
  pressStart = { x: e.clientX, y: e.clientY };
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    swallowClick = true;
    openShelfMenu(chip.dataset.shelfId, chip);
  }, 500);
}
function onChipPointerMove(e) {
  if (!pressStart) return;
  if (Math.abs(e.clientX - pressStart.x) > 10 || Math.abs(e.clientY - pressStart.y) > 10) { clearTimeout(pressTimer); pressStart = null; }
}
function onChipPointerEnd() { clearTimeout(pressTimer); pressStart = null; }

// Marca de una estantería: INICIAL sobre un tono derivado del nombre, no la
// portada de un libro suyo. Una portada a 28px no se reconoce, CAMBIA sola al
// añadir un libro (así que no sirve para acordarse de cuál es cuál) y una rama
// sin libros propios acaba enseñando la portada de su hija — dos filas
// idénticas que parecen un duplicado. La inicial es estable y legible.
// El tono sale del nombre, saltándose la franja verde entera (90–180): ahí vive
// el acento, y una inicial verdosa se lee como "seleccionada" o como las
// automáticas, que sí usan el acento a propósito.
function markHue(name) {
  let h = 0;
  const s = String(name || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 270;
  return h >= 90 ? h + 90 : h;
}
function markInitial(name) {
  const c = String(name || '?').trim().charAt(0);
  return (c || '?').toUpperCase();
}
// El contador se pinta como cifra suelta (aria-hidden): quien usa lector de
// pantalla lo oye aquí, con el nombre y en singular o plural según toque.
function countLabel(name, n) {
  return n === 1 ? t('{name}, {n} libro', { name, n }) : t('{name}, {n} libros', { name, n });
}

function shelfMarkHtml(label) {
  return `<span class="lib-rail-thumb lib-rail-thumb--mark" style="--mark-h:${markHue(label)}"
    aria-hidden="true">${escapeHtml(markInitial(label))}</span>`;
}

// Una fila del rail: estantería (manual o inteligente) o GRUPO —un tramo del
// nombre que no existe como estantería propia, p. ej. "Técnico" cuando solo hay
// "Técnico/ML"—. El grupo filtra por todo lo que cuelga de él, pero no tiene
// menú: no hay nada que renombrar ni borrar.
//
// El botón de opciones va FUERA del botón de la fila (un <button> dentro de
// otro es HTML inválido y el de dentro no se alcanza con el tabulador): la fila
// es un contenedor flex con triángulo · nombre · opciones.
function railRowHtml(row) {
  const ids = row.shelfIds;
  const active = selection.has(row.key);
  const count = memberIdsOf(ids).size;
  const smart = row.shelf && Shelves.isSmart(row.shelf);
  const folded = row.ancestors.some(p => collapsed.has(p));
  const shut = row.hasChildren && collapsed.has(row.path);

  const twisty = row.hasChildren
    ? `<button class="lib-rail-twisty" data-collapse="${escapeHtml(row.path)}"
        aria-expanded="${shut ? 'false' : 'true'}"
        aria-label="${escapeHtml(shut ? t('Desplegar {name}', { name: row.label }) : t('Plegar {name}', { name: row.label }))}"
        >${icon(shut ? 'chevron-right' : 'chevron-down', { size: 'sm' })}</button>`
    : '<span class="lib-rail-twisty" aria-hidden="true"></span>';

  const mark = row.kind === 'group'
    ? '<span class="lib-rail-thumb lib-rail-thumb--group" aria-hidden="true"></span>'
    : (smart
      ? `<span class="lib-rail-thumb lib-rail-thumb--smart" aria-hidden="true">${icon('funnel', { size: 'md' })}</span>`
      : shelfMarkHtml(row.label));

  // En la tira horizontal de móvil no hay indentación que valga, así que la
  // rama va delante del nombre ("Técnico/LLM"); en escritorio la dice el árbol.
  // Va como ATRIBUTO y lo pinta el CSS (content: attr(...)): es decoración de
  // una sola disposición, y como span metía "Técnico/" en el textContent de la
  // fila, donde el nombre de la estantería debe ser solo "LLM".
  const crumb = row.depth
    ? ` data-crumb="${escapeHtml(row.ancestors[row.ancestors.length - 1] + Shelves.SEP)}"`
    : '';

  const kebab = row.shelf
    ? `<button class="lib-rail-kebab" data-shelf-menu="${escapeHtml(row.shelf.id)}"
        title="${t('Opciones')}" aria-label="${escapeHtml(t('Opciones de {name}', { name: row.label }))}"
        >${icon('ellipsis', { size: 'lg' })}</button>`
    : '';

  // Soltar un libro encima solo tiene sentido en una estantería MANUAL: en una
  // inteligente manda la regla, y un grupo no es una estantería.
  const drop = row.shelf && !smart ? ` data-drop-shelf="${escapeHtml(row.shelf.id)}"` : '';
  const label = row.hasChildren
    ? t('{name}, {n} libros con sus subestanterías', { name: row.label, n: count })
    : countLabel(row.label, count);

  return `<div class="lib-rail-row${active ? ' is-active' : ''}${folded ? ' is-folded' : ''}${row.depth ? ' is-child' : ''}"
      style="--depth:${row.depth}"${drop}>
    ${twisty}
    <button class="lib-rail-item lib-rail-shelf${active ? ' active' : ''}${row.kind === 'group' ? ' lib-rail-group' : ''}"
      data-row-key="${escapeHtml(row.key)}" data-row-label="${escapeHtml(row.label)}"
      data-shelf-ids="${escapeHtml(ids.join(','))}"
      aria-label="${escapeHtml(label)}"${active ? ' aria-current="true"' : ''}>
      ${mark}
      <span class="lib-rail-name"${crumb}>${escapeHtml(row.label)}</span>
      <span class="lib-rail-count" aria-hidden="true">${count}</span>
    </button>
    ${kebab}
  </div>`;
}

// "Libros" y "Sin estantería": vistas del sistema, no estanterías. Comparten la
// caja de fila para que la columna de nombres quede alineada con el árbol.
function fixedRowHtml(key, mark, name, count, active) {
  return `<div class="lib-rail-row${active ? ' is-active' : ''}">
    <span class="lib-rail-twisty" aria-hidden="true"></span>
    <button class="lib-rail-item" data-shelf="${key}"
      aria-label="${escapeHtml(countLabel(name, count))}"${active ? ' aria-current="true"' : ''}>
      ${mark}
      <span class="lib-rail-name">${escapeHtml(name)}</span>
      <span class="lib-rail-count" aria-hidden="true">${count}</span>
    </button>
  </div>`;
}

function currentTitle() {
  if (!selection.size) return t('Libros');
  if (selection.has('none')) return t('Sin estantería');
  const names = [...selection.values()].map(e => e.label);
  if (names.length === 1) return names[0];
  return names.join(matchAllShelves ? ' · ' : ' / ');
}

// Chips de la selección: hacen visible QUÉ está filtrando (con varias
// estanterías el título solo no basta), permiten quitar una a una en táctil
// —donde no hay ⌘+clic— y llevan el conmutador Y/O, que es la diferencia entre
// "los que están en las dos" y "los que están en alguna".
function filterChipsHtml() {
  if (selection.size < 1 || selection.has('none')) return '';
  const chips = [...selection].map(([key, entry]) =>
    `<span class="lib-chip">${escapeHtml(entry.label)}
      <button class="lib-chip-x" data-unselect="${escapeHtml(key)}" aria-label="${t('Quitar del filtro')}">${icon('xmark', { size: 'sm' })}</button>
    </span>`).join('');
  const mode = selection.size > 1
    ? `<button class="lib-chip lib-chip-mode" data-act="togglemode" title="${t('Cambiar entre Y (en todas) y O (en alguna)')}">
        ${matchAllShelves ? t('en todas') : t('en alguna')}</button>`
    : '';
  return `<div class="lib-chips">${chips}${mode}
    <button class="lib-chip lib-chip-clear" data-act="clearsel">${t('Quitar filtro')}</button></div>`;
}

// Chip "Repasar hoy · N" (P10): la cola diaria de repetición espaciada, el bucle de
// retorno de la app. Solo aparece si hay tarjetas vencidas; al cerrar la sesión se
// re-pinta (el contador baja o el chip desaparece).
// Racha siempre visible en la biblioteca (T1 retención), no solo al terminar la sesión.
// «En riesgo» = la racha vive pero hoy aún no repasaste: flama atenuada que pide acción.
function paintStreakChip() {
  const slot = host && host.querySelector('.lib-streak-slot');
  if (!slot) return;
  const streak = Study.currentStreak();
  if (!streak) { slot.innerHTML = ''; return; }
  const risky = !Study.reviewsToday();
  slot.innerHTML = `<span class="lib-streakchip${risky ? ' is-risky' : ''}" `
    + `aria-label="${t('Racha de {n} día{s}', { n: streak, s: streak === 1 ? '' : 's' })}">${icon('flame', { size: 'sm' })}<b>${streak}</b></span>`;
}

async function paintStudyChip() {
  const slot = host && host.querySelector('.lib-today-slot');
  if (!slot) return;
  paintStreakChip();              // la racha se pinta aunque no haya nada vencido hoy
  const [{ cards, decks }, doneToday] = await Promise.all([Study.dueToday(), Promise.resolve(Study.reviewsToday())]);
  Study.syncBadge();
  if (!slot.isConnected) return;
  slot.innerHTML = '';
  slot.closest('.lib-top')?.classList.toggle('has-today', !!(cards || doneToday));
  if (!cards && !doneToday) return;
  // ST2 · «Hoy»: el motivo diario para volver a la app, con presencia propia (antes era un
  // botón más entre los filtros). Anillo = hechas / (hechas + pendientes), minutos estimados
  // (~8 s por tarjeta), racha y las portadas de los libros que tocan.
  const total = cards + doneToday;
  const pct = total ? doneToday / total : 1;
  const C = 2 * Math.PI * 26;
  const streak = Study.currentStreak();
  const mins = Math.max(1, Math.round((cards * 8) / 60));
  const books = await Promise.all([...new Set(decks.map(d => d.bookId).filter(Boolean))].slice(0, 4)
    .map(id => Store.getBook(id).catch(() => null)));
  const covers = books.filter(Boolean).map(b => b.cover
    ? `<img src="${escapeHtml(b.cover)}" alt="" title="${escapeHtml(b.title || '')}">`
    : `<span class="lib-today-ph" title="${escapeHtml(b.title || '')}">${escapeHtml(initials(b.title))}</span>`).join('');
  slot.innerHTML = `<section class="lib-today${cards ? '' : ' is-done'}" aria-label="${t('Repaso de hoy')}">
    <div class="lib-today-ring" aria-hidden="true">
      <svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="26" class="lib-ring-track"/>
      <circle cx="32" cy="32" r="26" class="lib-ring-fill" style="stroke-dasharray:${C.toFixed(1)};stroke-dashoffset:${(C * (1 - pct)).toFixed(1)}"/></svg>
      <span>${cards ? cards : icon('check', { size: 'lg' })}</span>
    </div>
    <div class="lib-today-body">
      <p class="lib-hero-kicker">${t('Repaso de hoy')}</p>
      <h2 class="lib-today-title">${cards ? t('{n} tarjeta{s}', { n: cards, s: cards === 1 ? '' : 's' }) : t('Hecho por hoy')}</h2>
      <p class="lib-today-meta">${cards ? t('~{n} min', { n: mins }) : t('{n} repasada{s}', { n: doneToday, s: doneToday === 1 ? '' : 's' })}${streak ? ` · <span class="lib-today-streak">${icon('flame', { size: 'sm' })}${t('{n} día{s}', { n: streak, s: streak === 1 ? '' : 's' })}</span>` : ''}</p>
      ${covers ? `<div class="lib-today-covers">${covers}</div>` : ''}
      ${cards ? `<div class="lib-today-actions">
        <button class="lib-study-chip">${icon('cards', { size: 'md' })}<span>${t('Repasar hoy · {n}', { n: cards })}</span></button>
        <button class="lib-study-pick" title="${t('Elegir qué repasar')}">${t('Elegir')}${icon('chevron-down', { size: 'sm' })}</button>
      </div>` : ''}
    </div>
  </section>`;
  const chip = slot.querySelector('.lib-study-chip');
  // Empezar repasa TODO, sin desplegable. Elegir un libro o una estantería es secundario.
  chip?.addEventListener('click', (e) => {
    e.stopPropagation();
    Study.openToday({ onClose: paintStudyChip });
  });
  const pick = slot.querySelector('.lib-study-pick');
  pick?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const scopes = await Study.studyScopes();
    showStudyChooser(pick, scopes);
  });
}

// Selector de ámbito de repaso (P12, árbol estilo Anki): "Todo" + cada estantería como
// categoría PADRE (suma de sus libros) con sus LIBROS anidados debajo, y los sueltos aparte.
// Se repasa a cualquier nivel (estantería o libro).
function showStudyChooser(chip, scopes) {
  document.querySelector('.lib-study-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'lib-study-menu';
  const row = (label, count, scope, kind = '') =>
    `<button class="lib-study-opt${kind ? ' lib-study-opt--' + kind : ''}" data-scope='${escapeHtml(JSON.stringify(scope))}'>
      <span class="lib-study-opt-lbl">${escapeHtml(label)}</span><span class="lib-study-opt-n">${count}</span>
    </button>`;
  const section = (title, rows) => rows ? `<div class="lib-study-sec">${title}</div>${rows}` : '';
  const shelfTree = scopes.shelves.map(s =>
    row(s.name, s.cards, { type: 'shelf', shelfId: s.id }, 'shelf') +
    s.books.map(b => row(b.title, b.cards, { type: 'book', bookId: b.id }, 'book')).join('')
  ).join('');
  const loose = scopes.looseBooks.map(b => row(b.title, b.cards, { type: 'book', bookId: b.id }, 'book')).join('');
  // Mazos huérfanos: su libro ya no está en la biblioteca (o su identidad quedó vieja).
  // Sin esta sección sus tarjetas vencidas no eran alcanzables desde «Elegir», aunque
  // «Repasar hoy» (que recorre TODOS los mazos) sí las estudia.
  const orphans = (scopes.orphanDecks || [])
    .map(o => row(o.name, o.cards, { type: 'book', bookId: o.bookId }, 'book')).join('');
  menu.innerHTML =
    row(t('Todo'), scopes.total, { type: 'all' }) +
    shelfTree +
    section(t('Sin estantería'), loose) +
    section(t('Mazos sin libro'), orphans);
  chip.parentElement.appendChild(menu);
  // Anclar al botón pero SUJETARLO al viewport (mismo patrón que positionMenu): medir
  // ya insertado, recortar contra los bordes con margen de 8px y abrir hacia arriba
  // si abajo no hay lugar. Antes se posicionaba a pelo y junto al borde derecho el
  // menú se salía de pantalla y cortaba las filas.
  const r = chip.getBoundingClientRect();
  const pr = chip.parentElement.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - mw - 8);
  left = Math.max(8, left);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  menu.style.left = (left - pr.left) + 'px';
  menu.style.top = (top - pr.top) + 'px';

  const close = () => { menu.remove(); document.removeEventListener('click', onOutside, true); };
  const onOutside = (ev) => { if (!menu.contains(ev.target)) close(); };
  setTimeout(() => document.addEventListener('click', onOutside, true), 0);
  menu.addEventListener('click', (ev) => {
    const opt = ev.target.closest('.lib-study-opt');
    if (!opt) return;
    close();
    Study.openToday({ scope: JSON.parse(opt.dataset.scope), onClose: paintStudyChip });
  });
}

function dropdownHtml(key, label, options, current) {
  return `<div class="lib-dd" data-dd="${key}">
    <button class="btn btn--secondary lib-dd-btn">${label}${icon('chevron-down', { size: 'md' })}</button>
    <div class="lib-dd-menu">
      ${Object.entries(options).filter(([v]) => !(key === 'progress' && v === 'all') || true).map(([v, lbl]) =>
        `<button class="lib-dd-opt${v === current ? ' active' : ''}" data-dd-val="${v}">
          <span class="lib-dd-check">${v === current ? icon('check', { size: 'md' }) : ''}</span>${escapeHtml(key === 'progress' && v === 'all' ? t('Todos') : lbl)}
        </button>`).join('')}
    </div>
  </div>`;
}

// A partir de aquí la descarga se pregunta antes (ver startDownload).
const BIG_DOWNLOAD = 150 * 1024 * 1024;

// Tamaño legible para el botón de descarga ("Descargar · 4,2 MB").
function humanSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + ' MB';
}

// UI4 · «Continuar leyendo»: el libro que tienes a medias, grande y con su progreso, arriba
// de todo. Solo en la vista general (sin estantería, búsqueda ni filtro): dentro de un
// filtro, el usuario está buscando otra cosa. Reutiliza `.lib-card` para abrirse igual.
function continueHtml(books) {
  if (selection.size || query.trim() || filterProgress !== 'all') return '';
  const b = books.find(x => !Store.isGhost(x) && (x.status === 'reading' || (x.progress > 0 && x.progress < 100)));
  if (!b) return '';
  const pct = Math.max(0, Math.min(100, Math.round(b.progress || 0)));
  const cover = b.cover
    ? `<img class="lib-cover-img" src="${escapeHtml(b.cover)}" alt="">`
    : `<div class="lib-cover-fallback"><span>${escapeHtml(initials(b.title))}</span></div>`;
  return `<section class="lib-continue" aria-label="${t('Continuar leyendo')}">
    <div class="lib-card lib-hero" data-id="${b.id}" role="button" tabindex="0">
      <div class="lib-hero-cover">${cover}</div>
      <div class="lib-hero-body">
        <p class="lib-hero-kicker">${t('Continuar leyendo')}</p>
        <h2 class="lib-hero-title">${escapeHtml(b.title || t('Sin título'))}</h2>
        ${b.author ? `<p class="lib-hero-author">${escapeHtml(b.author)}</p>` : ''}
        <div class="lib-hero-progress">
          <div class="lib-progressbar"><span style="width:${pct}%"></span></div>
          <span>${t('{n}% leído', { n: pct })}</span>
        </div>
        <span class="lib-hero-cta">${t('Seguir leyendo')} ${icon('chevron-right', { size: 'md' })}</span>
      </div>
    </div>
  </section>`;
}

function cardHtml(b) {
  const pct = Math.max(0, Math.min(100, Math.round(b.progress || 0)));
  const cover = b.cover
    ? `<img class="lib-cover-img" src="${escapeHtml(b.cover)}" alt="">`
    : `<div class="lib-cover-fallback"><span>${escapeHtml(initials(b.title))}</span></div>`;
  const badge = (b.status === 'finished') ? `<span class="lib-badge">${icon('check', { size: 'sm' })}</span>` : '';

  // Ficha FANTASMA: el libro está en tu biblioteca pero su fichero no está en
  // este dispositivo. Se distingue de un libro normal (portada atenuada) y
  // ofrece traerlo, igual que la nube de Play Books. Si nadie lo subió todavía,
  // no hay nada que ofrecer: se dice y punto, en vez de un botón que fallaría.
  const ghost = Store.isGhost(b);
  const transfer = transfers.get(b.id);
  let overlay = '';
  if (transfer) {
    overlay = transferOverlayHtml(transfer);
  } else if (ghost && b.blob && b.blob.path) {
    overlay = `<div class="lib-dl">
      <button class="lib-dl-btn" data-download="${escapeHtml(b.id)}" title="${t('Descargar a este dispositivo')}">
        ${icon('download', { size: 'md' })}<span>${escapeHtml(humanSize(b.size))}</span>
      </button>
    </div>`;
  } else if (ghost) {
    overlay = `<div class="lib-dl"><span class="lib-dl-note">${t('Solo notas')}</span></div>`;
  }

  return `
    <div class="lib-card${ghost ? ' is-ghost' : ''}${transfer ? ' is-transferring' : ''}" data-id="${b.id}" draggable="true">
      <div class="lib-cover">
        ${cover}
        ${badge}
        ${overlay}
        <button class="lib-kebab" data-id="${b.id}" title="${t('Más')}" aria-label="${t('Más opciones')}">${icon('ellipsis', { size: 'lg' })}</button>
      </div>
      <div class="lib-progressbar"><span style="width:${pct}%"></span></div>
      <div class="lib-mastery" data-mastery="${escapeHtml(b.id)}" hidden>
        <span class="lib-mastery-bar"><span class="lib-mastery-fill"></span></span><span class="lib-mastery-lbl"></span>
      </div>
      <div class="lib-title">${escapeHtml(b.title || t('Sin título'))}</div>
      <div class="lib-author">${escapeHtml(b.author || '')}</div>
    </div>`;
}

// ---- Primeros pasos (P30 · F3) ---------------------------------------------
// Checklist de onboarding en la estantería. Los estados se DERIVAN de lo que la
// app ya sabe — no hay contador propio que se desincronice:
//   1. hay algún libro importado (Store)
//   2. hay alguna conversación con objetivo de lectura (IDB del agente)
// Cuando los dos están, la tarjeta ni se renderiza: ya no hay nada que enseñar.
//
// «Configura tu clave de IA» era el paso del medio y ya no lo es: sin clave, el agente
// arranca con la demo, que se pide sola al usarlo (llm.js · ensureKey). Un paso que
// mandaba a Ajustes a pegar una API key era el peor primer contacto posible. Sin clave,
// la tarjeta solo lo dice, para que nadie lo busque.
async function firstStepsHtml(books) {
  const hasBooks = books.length > 0;
  let hasKey = false;
  try { hasKey = (Storage.get('ai_key', '') || '').trim().length > 0; } catch (e) { /* sin storage: como sin clave */ }
  let hasGoal = false;
  try {
    const convos = await AiDB.getAll('convos');
    hasGoal = (convos || []).some((c) => c && c.goal);
  } catch (e) { /* IDB no disponible: se muestra pendiente */ }
  if (hasBooks && hasGoal) return '';

  const step = (done, label, act, cta) => `
    <li class="lib-step${done ? ' done' : ''}">
      <span class="lib-step-mark" aria-hidden="true">${done ? icon('check', { size: 'sm' }) : ''}</span>
      <span class="lib-step-label">${escapeHtml(label)}${!done && act ? ` <button class="lib-step-go" data-act="${act}">${escapeHtml(cta)}</button>` : ''}</span>
    </li>`;
  return `
    <div class="lib-steps">
      <div class="lib-steps-head">${t('Primeros pasos')}</div>
      <ol>
        ${step(hasBooks, t('Importa un libro'), 'add', t('Subir archivos'))}
        ${step(hasGoal, t('Dale un objetivo a tu primer libro'), 'openbook', t('Abrir un libro'))}
      </ol>
      ${hasKey ? '' : `<p class="lib-steps-note">${t('No hace falta configurar nada: el agente arranca con una demo gratuita. Tu propia API key, cuando quieras, en Ajustes.')}</p>`}
    </div>`;
}

function emptyHtml(noBooksAtAll) {
  return `<div class="lib-empty">
    <div class="lib-empty-icon">${icon('library', { size: 'hero' })}</div>
    <p>${noBooksAtAll ? t('Tu biblioteca está vacía.') : t('No hay libros aquí.')}</p>
    ${noBooksAtAll ? `<button class="btn btn--primary lib-upload" data-act="add">${icon('upload', { size: 'lg' })}<span>${t('Subir tu primer libro')}</span></button>` : ''}
  </div>`;
}

// ---- filtros / orden -------------------------------------------------------

// Miembros de una estantería, cacheados por render. Una estantería INTELIGENTE
// no guarda miembros: los calcula recorriendo la biblioteca. Sin caché eso se
// repetiría por cada contador del rail y por cada libro de la rejilla —O(n·m) en
// cada tecleo del buscador—; con ella se evalúa una vez por estantería.
let memberCache = new Map();
function membersOf(id) {
  let set = memberCache.get(id);
  if (!set) {
    const sh = allShelves.find(s => s.id === id);
    set = new Set(Shelves.booksIn(allBooks, sh).map(b => b.id));
    memberCache.set(id, set);
  }
  return set;
}
// Unión de varias estanterías (una fila del rail arrastra a sus descendientes).
function memberIdsOf(ids) {
  const out = new Set();
  for (const id of ids) for (const bid of membersOf(id)) out.add(bid);
  return out;
}

// Cada entrada de la selección se resuelve en O (la rama y todo lo que cuelga de
// ella) y las entradas entre sí en Y u O según el conmutador.
function matchShelf(b) {
  if (!selection.size) return true;
  if (selection.has('none')) return !(b.shelfIds && b.shelfIds.length);
  const entries = [...selection.values()];
  const inEntry = (e) => e.ids.some(id => membersOf(id).has(b.id));
  return matchAllShelves ? entries.every(inEntry) : entries.some(inEntry);
}
function matchFilter(b) {
  if (filterProgress === 'all') return true;
  return (b.status || 'unread') === filterProgress;
}
// Normaliza para buscar sin acentos/mayúsculas (mismo criterio que js/search.js).
function norm(s) { return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
function matchQuery(b) {
  const q = norm(query.trim());
  if (!q) return true;
  // También por el título y el autor del fichero, si el usuario los cambió.
  return [b.title, b.author, b.origTitle, b.origAuthor].some(v => norm(v).includes(q));
}
// Lista visible = estantería · progreso · búsqueda, ordenada. Compartida por el
// render completo y el refiltrado en vivo del buscador.
function computeList() {
  return sortBooks(allBooks.filter(matchShelf).filter(matchFilter).filter(matchQuery));
}
// Rejilla (o estado vacío contextual) para la lista dada.
function resultsHtml(list) {
  if (list.length) return `<div class="lib-grid">${list.map(cardHtml).join('')}</div>`;
  if (query.trim()) {
    return `<div class="lib-empty"><div class="lib-empty-icon">${icon('search', { size: 'hero' })}</div>
      <p>${t('Ningún libro coincide con «{q}».', { q: escapeHtml(query.trim()) })}</p></div>`;
  }
  return emptyHtml(allBooks.length === 0);
}
// Re-pinta SOLO la rejilla (el input vive en la toolbar, intacto → no pierde el foco).
function paintResults() {
  const wrap = host && host.querySelector('.lib-results');
  if (wrap) {
    wrap.innerHTML = resultsHtml(computeList());
    paintMastery();
  }
}

// Dominio por libro (T2 retención): una sola pasada por TODOS los mazos, agrupados por
// libro. Es la visualización que un SRS genérico no puede dar — pero un lector sí: conecta
// el repaso diario con el objetivo real («¿cuánto de este libro dominó?»). Sin mazo, oculta.
let masterySeq = 0;
async function paintMastery() {
  const seq = ++masterySeq;
  let decks;
  try { decks = await AiDB.getAllDecks(); } catch { return; }
  const byBook = new Map();
  for (const d of decks || []) {
    if (!d?.bookId) continue;
    const cur = byBook.get(d.bookId) || [];
    cur.push(...(d.cards || []));
    byBook.set(d.bookId, cur);
  }
  const wrap = host && host.querySelector('.lib-results');
  if (!wrap) return;
  for (const el of wrap.querySelectorAll('[data-mastery]')) {
    if (seq !== masterySeq || !el.isConnected) return;   // llegó otro render: la vista manda
    const m = Srs.deckMastery(byBook.get(el.dataset.mastery) || []);
    if (!m.total) { el.hidden = true; continue; }
    const pct = Math.round(m.mastery * 100);
    el.hidden = false;
    el.querySelector('.lib-mastery-fill').style.width = `${pct}%`;
    el.querySelector('.lib-mastery-lbl').textContent = t('{n}% dominado', { n: pct });
    el.title = t('{a} maduras · {b} aprendiendo · {c} nuevas', { a: m.maduras, b: m.aprendiendo, c: m.nuevas });
  }
}
function sortBooks(list) {
  if (sortBy === 'title') return list.sort((a, b) => (a.title || '').localeCompare(b.title || '', getLang()));
  if (sortBy === 'author') return list.sort((a, b) => (a.author || '').localeCompare(b.author || '', getLang()));
  return list; // 'recent': ya viene ordenado por lastOpenedAt desc
}

// ---- eventos ---------------------------------------------------------------

// Buscador de la estantería: refiltra en vivo sin re-render completo (mantiene el foco).
function onInput(e) {
  if (!e.target.closest('.lib-search')) return;
  query = e.target.value;
  paintResults();
}

async function onClick(e) {
  if (e.target.closest('.lib-upload, [data-act="add"]')) { onAddBook(); return; }

  // Desplegables (orden / progreso)
  const ddBtn = e.target.closest('.lib-dd-btn');
  if (ddBtn) {
    const dd = ddBtn.closest('.lib-dd');
    const wasOpen = dd.classList.contains('open');
    host.querySelectorAll('.lib-dd.open').forEach(d => d.classList.remove('open'));
    dd.classList.toggle('open', !wasOpen);
    return;
  }
  const opt = e.target.closest('.lib-dd-opt');
  if (opt) {
    const key = opt.closest('.lib-dd').dataset.dd;
    if (key === 'sort') sortBy = opt.dataset.ddVal; else filterProgress = opt.dataset.ddVal;
    await render();
    return;
  }

  if (e.target.closest('[data-act="settings"]')) { onOpenSettings(); return; }
  const more = e.target.closest('[data-act="more"]');
  if (more) { openMoreSheet(more); return; }
  if (e.target.closest('[data-act="shelfsheet"]')) { await openShelfSheet(); return; }
  // P30 F3: el paso "dale un objetivo a tu primer libro" abre el libro más reciente.
  if (e.target.closest('[data-act="openbook"]')) {
    track('steps:go', 'openbook');
    const b = allBooks[0];
    if (b) { onOpenBook(b); return; }
  }
  // Carga perezosa: el Análisis arrastra el registro de lectura, la libreta y el SRS, y
  // nada de eso hace falta para pintar la estantería (que es la pantalla de arranque).
  if (e.target.closest('[data-act="analysis"]')) {
    import('../analysis.js').then(m => m.open()).catch(err => console.warn('analysis:', err));
    return;
  }
  // El gestor de mazos también entra perezoso: agrupa IndexedDB + biblioteca y
  // nada de eso hace falta para pintar la estantería.
  if (e.target.closest('[data-act="decks"]')) {
    import('../decks.js').then(m => m.open()).catch(err => console.warn('decks:', err));
    return;
  }

  // Crear estantería: un solo botón con las dos variantes dentro. Eran dos
  // enlaces en color de acento compitiendo con la fila seleccionada — que es lo
  // único que el acento debería señalar en el rail.
  const createBtn = e.target.closest('[data-act="newshelfmenu"]');
  if (createBtn) { e.stopPropagation(); openCreateMenu(createBtn); return; }

  // Plegar/desplegar una rama del árbol (no cambia el filtro).
  const twisty = e.target.closest('[data-collapse]');
  if (twisty) {
    e.stopPropagation();
    const path = twisty.dataset.collapse;
    if (collapsed.has(path)) collapsed.delete(path); else collapsed.add(path);
    saveCollapsed();
    await render();
    return;
  }

  // Chips del filtro: quitar una estantería, alternar Y/O, limpiar.
  const unsel = e.target.closest('[data-unselect]');
  if (unsel) { selection.delete(unsel.dataset.unselect); await render(); return; }
  if (e.target.closest('[data-act="togglemode"]')) { matchAllShelves = !matchAllShelves; await render(); return; }
  if (e.target.closest('[data-act="clearsel"]')) { selection.clear(); await render(); return; }

  // Menú de estantería (renombrar / regla / mover / borrar)
  const shelfMenu = e.target.closest('.lib-rail-kebab');
  if (shelfMenu) { e.stopPropagation(); await openShelfMenu(shelfMenu.dataset.shelfMenu, shelfMenu); return; }

  // Seleccionar estantería / grupo / "Libros"
  const railItem = e.target.closest('.lib-rail-item, .lib-schip[data-shelf], .lib-schip[data-row-key]');
  if (railItem && !e.target.closest('.lib-rail-create')) { await selectRail(railItem, e); return; }

  // Botón de descarga de una ficha fantasma (no abre el libro)
  const dl = e.target.closest('[data-download]');
  if (dl) { e.stopPropagation(); await startDownload(dl.dataset.download); return; }

  // Menú de libro
  const kebab = e.target.closest('.lib-kebab');
  if (kebab) { e.stopPropagation(); await openBookMenu(kebab.dataset.id, kebab); return; }

  const card = e.target.closest('.lib-card');
  if (card) await openCard(card.dataset.id);
}

// ---- arrastrar un libro al rail --------------------------------------------

function onDragStart(e) {
  const card = e.target.closest('.lib-card');
  if (!card) return;
  dragBookId = card.dataset.id;
  card.classList.add('is-dragging');
  host.querySelector('.lib-rail')?.classList.add('is-dropping');
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'copy';
    try { e.dataTransfer.setData('text/plain', dragBookId); } catch (err) { /* Safari con datos vacíos */ }
  }
}

function endDrag() {
  dragBookId = null;
  dropRow?.classList.remove('is-drop-target');
  dropRow = null;
  host.querySelector('.lib-rail')?.classList.remove('is-dropping');
  host.querySelector('.lib-card.is-dragging')?.classList.remove('is-dragging');
}

// ¿Trae ficheros de FUERA (el escritorio, el Finder)? Distinto del arrastre de una
// ficha al rail, que es interno y lleva `dragBookId`.
const bringsFiles = (e) => !dragBookId && !!e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');

function onDragOver(e) {
  if (bringsFiles(e)) {
    // Soltar un EPUB, un PDF o un dossier en cualquier punto de la biblioteca.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    host.classList.add('is-file-over');
    return;
  }
  if (!dragBookId) return;
  const row = e.target.closest('[data-drop-shelf]');
  if (!row) { if (dropRow) { dropRow.classList.remove('is-drop-target'); dropRow = null; } return; }
  e.preventDefault();                    // sin esto el navegador no deja soltar
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  if (dropRow !== row) {
    dropRow?.classList.remove('is-drop-target');
    dropRow = row;
    row.classList.add('is-drop-target');
  }
}

function onDragLeave(e) {
  if (!e.relatedTarget || !host.contains(e.relatedTarget)) host.classList.remove('is-file-over');
  if (!dropRow) return;
  if (!e.relatedTarget || !dropRow.contains(e.relatedTarget)) {
    dropRow.classList.remove('is-drop-target');
    dropRow = null;
  }
}

async function onDrop(e) {
  host.classList.remove('is-file-over');
  const files = e.dataTransfer?.files;
  if (!dragBookId && files && files.length) {
    e.preventDefault();
    // Uno a uno y en orden: abrir un libro o importar un dossier son pantallas, no se
    // pueden solapar. Lo que no sea EPUB/PDF/dossier lo rechaza el propio loadFile.
    for (const f of files) await onDropFile(f);
    return;
  }
  const row = e.target.closest('[data-drop-shelf]');
  const id = dragBookId || (e.dataTransfer ? e.dataTransfer.getData('text/plain') : '');
  endDrag();
  if (!row || !id) return;
  e.preventDefault();
  // Se AÑADE, no se mueve: una estantería es una etiqueta y un libro está en
  // varias a la vez (ver library/shelves.js). Soltarlo donde ya está no hace nada.
  const book = await Store.getBook(id);
  if (!book || (book.shelfIds || []).includes(row.dataset.dropShelf)) return;
  await Store.toggleBookShelf(id, row.dataset.dropShelf, true);
  await render();
}

// Abrir una tarjeta. Si el fichero no está aquí, pulsar la portada equivale a
// pedir la descarga: es lo que espera cualquiera que venga de Play Books, y
// mejor que un "no se pudo abrir" sobre un libro que sí es suyo.
async function openCard(id) {
  const book = await Store.getBook(id);
  if (!book) return;
  if (Store.hasFile(book)) { onOpenBook(book); return; }
  if (book.blob && book.blob.path) await startDownload(id, { open: true });
  else await alertBox(t('Este libro se sincronizó desde otro dispositivo, pero su archivo aún no está en Drive. Ábrelo allí una vez para subirlo.'), { title: t('Archivo no disponible') });
}

// Descarga con las tres puertas en orden: Drive conectado, licencia Pro y cola.
async function startDownload(id, { open = false } = {}) {
  if (Blobs.isQueued(id)) return;
  if (!DriveAuth.isConnected()) {
    await alertBox(t('Conecta con Google Drive en Ajustes para descargar tus libros en este dispositivo.'), { title: t('Sincronización') });
    return;
  }
  if (!(await ensurePro('files'))) return;
  // Un libro de cientos de MB no es una descarga cualquiera: son minutos de
  // datos y un buen mordisco al almacenamiento del móvil. Se pregunta, como
  // hace Play Books, en vez de empezar y que el usuario lo descubra por la
  // barra.
  const book = await Store.getBook(id);
  const size = (book && book.size) || 0;
  if (size > BIG_DOWNLOAD) {
    const ok = await confirmBox(
      t('«{title}» ocupa {size}. Descargarlo puede tardar y llenar el almacenamiento de este dispositivo.',
        { title: (book && book.title) || '', size: humanSize(size) }),
      { title: t('Descarga grande'), okText: t('Descargar') });
    if (!ok) return;
  }
  await Blobs.requestDownload(id);
  const fresh = await Store.getBook(id);
  if (open && fresh && Store.hasFile(fresh)) onOpenBook(fresh);
}

// Pulsar una fila del rail. Clic normal = ver SOLO eso (lo de siempre).
// ⌘/Ctrl/Mayús+clic = añadir o quitar del cruce sin salir del rail; en táctil,
// donde no hay modificador, lo mismo se hace desde el menú de la estantería.
async function selectRail(el, ev) {
  const fixed = el.dataset.shelf;          // "Libros" y "Sin estantería"
  if (fixed === 'all') { selection.clear(); await render(); return; }
  if (fixed === 'none') { selection = new Map([['none', { label: t('Sin estantería'), ids: [] }]]); await render(); return; }

  const key = el.dataset.rowKey;
  const entry = { label: el.dataset.rowLabel || '', ids: (el.dataset.shelfIds || '').split(',').filter(Boolean) };
  rememberRecent(key);   // la tira móvil enseña las últimas usadas
  if (ev && (ev.metaKey || ev.ctrlKey || ev.shiftKey)) {
    selection.delete('none');
    if (selection.has(key)) selection.delete(key); else selection.set(key, entry);
  } else {
    selection = new Map([[key, entry]]);
  }
  await render();
}

// Las dos formas de crear, con la diferencia dicha en una línea: en la manual
// eliges tú los libros, en la inteligente los elige una regla.
function openCreateMenu(anchor) {
  closeMenu();
  buildMenu(anchor, `
    <div class="lib-menu-label">${t('Nueva estantería')}</div>
    <button class="lib-menu-item" data-act="manual">${icon('pencil', { size: 'md' })}
      <span>${t('Estantería')}<small>${t('Eliges tú los libros')}</small></span></button>
    <button class="lib-menu-item" data-act="smart">${icon('funnel', { size: 'md' })}
      <span>${t('Inteligente')}<small>${t('Los elige una regla')}</small></span></button>
  `, async (act) => {
    if (act === 'manual') await createShelf();
    else if (act === 'smart') await createSmartShelf();
  });
}

async function createShelf() {
  const name = (await promptBox('Nombre de la nueva estantería:', { title: 'Nueva estantería',
    placeholder: 'Técnico/Machine Learning' }) || '').trim();
  if (!name) return;
  const sh = await Store.addShelf(name);
  selection = new Map([[sh.id, { label: Shelves.segments(sh.name).pop(), ids: [sh.id] }]]);
  await render();
}

async function createSmartShelf() {
  const sh = await editSmartShelf(null);
  if (sh) selection = new Map([[sh.id, { label: Shelves.segments(sh.name).pop(), ids: [sh.id] }]]);
  await render();
}

// ---- estanterías inteligentes ----------------------------------------------

// Editor de la regla. Devuelve la estantería creada/actualizada, o null.
//
// Los campos son los SINCRONIZADOS del libro a propósito: una regla sobre
// "abierto por última vez" o sobre si el fichero está descargado daría
// resultados distintos en cada dispositivo (ver library/shelves.js).
async function editSmartShelf(shelf) {
  const rule = (shelf && shelf.rule) || {};
  const manual = allShelves.filter(s => !Shelves.isSmart(s) && s.id !== (shelf && shelf.id));
  const res = await formBox({
    title: shelf ? 'Editar estantería inteligente' : 'Nueva estantería inteligente',
    message: 'Los libros entran solos cuando cumplen la regla.',
    fields: [
      { name: 'name', label: 'Nombre', type: 'text', value: shelf ? shelf.name : '', placeholder: 'Pendientes técnicos' },
      { name: 'status', label: 'Estado', type: 'select', value: rule.status || '',
        options: { '': 'Cualquiera', unread: 'Sin empezar', reading: 'Leyendo', finished: 'Terminados' } },
      { name: 'format', label: 'Formato', type: 'select', value: rule.format || '',
        options: { '': 'Cualquiera', epub: 'EPUB', pdf: 'PDF' } },
      { name: 'author', label: 'Autor contiene', type: 'text', value: rule.author || '' },
      { name: 'title', label: 'Título contiene', type: 'text', value: rule.title || '' },
      { name: 'addedWithinDays', label: 'Añadido hace menos de', type: 'select', value: String(rule.addedWithinDays || ''),
        options: { '': 'Cualquier fecha', 7: '7 días', 30: '30 días', 90: '90 días', 365: 'Un año' } },
      { name: 'shelfIds', label: 'En alguna de estas estanterías', type: 'checks', value: rule.shelfIds || [],
        emptyText: 'Aún no hay estanterías', options: manual.map(s => ({ value: s.id, label: s.name })) },
    ],
  });
  if (!res) return null;

  const name = (res.name || '').trim();
  if (!name) { await alertBox(t('La estantería necesita un nombre.'), { title: t('Nueva estantería inteligente') }); return null; }
  const next = Shelves.cleanRule({
    status: res.status, format: res.format, author: res.author, title: res.title,
    addedWithinDays: parseInt(res.addedWithinDays, 10) || 0, shelfIds: res.shelfIds || [],
  });
  // Sin ninguna condición la estantería contendría la biblioteca entera y no se
  // podría meter nada a mano (los miembros se calculan): mejor decirlo que
  // guardar una estantería que parece rota.
  if (!Shelves.hasRule(next)) {
    await alertBox(t('Pon al menos una condición: si no, la estantería contendría todos los libros.'),
      { title: t('Nueva estantería inteligente') });
    return null;
  }
  if (shelf) return Store.updateShelf(shelf.id, { name, rule: next });
  return Store.addShelf(name, { rule: next });
}

// ---- menú de estantería ----------------------------------------------------

async function openShelfMenu(id, anchor) {
  closeMenu();
  const shelves = await Store.getShelves();
  const shelf = shelves.find(s => s.id === id);
  if (!shelf) return;
  const smart = Shelves.isSmart(shelf);
  const inFilter = selection.has(id);
  // P24 · ¿Llegó material ajeno a esta estantería (un dossier importado)? Leer la base del
  // carril ajeno aquí es barato: son unos pocos registros, sin binarios.
  let dossiers = [];
  try { dossiers = await (await import('../share/store.js')).dossiersForShelf(id); } catch (e) { /* sin base */ }
  // P24 F4 · Enlaces que creaste desde ESTE dispositivo para esta estantería (y siguen vivos).
  let myLinks = [];
  try { myLinks = (await import('../share/link.js')).linksFor(id); } catch (e) { /* sin storage */ }
  const dossierItems = dossiers.map((d, i) => `<button class="lib-menu-item danger" data-act="unshare" data-i="${i}">${icon('xmark', { size: 'md' })}<span>${
    d.from ? t('Quitar lo de {name}…', { name: escapeHtml(d.from) }) : t('Quitar lo compartido…')}</span></button>`).join('');
  buildMenu(anchor, `
    <button class="lib-menu-item" data-act="filter">${icon(inFilter ? 'xmark' : 'plus', { size: 'md' })}<span>${inFilter ? t('Quitar del filtro') : t('Añadir al filtro')}</span></button>
    <div class="lib-menu-sep"></div>
    <button class="lib-menu-item" data-act="rename">${icon('pencil', { size: 'md' })}<span>${t('Renombrar')}</span></button>
    ${smart ? `<button class="lib-menu-item" data-act="rule">${icon('funnel', { size: 'md' })}<span>${t('Editar regla')}</span></button>` : ''}
    ${isMobile()
      // En la tira horizontal «Subir/Bajar» significaba izquierda/derecha. En móvil, lo que
      // ordena la tira es fijar.
      ? `<button class="lib-menu-item" data-act="pin">${icon(pinnedShelves().includes(id) ? 'xmark' : 'pin', { size: 'md' })}<span>${pinnedShelves().includes(id) ? t('Quitar de la tira') : t('Fijar en la tira')}</span></button>`
      : `<button class="lib-menu-item" data-act="up">${icon('arrow-up', { size: 'md' })}<span>${t('Subir')}</span></button>
    <button class="lib-menu-item" data-act="down">${icon('arrow-down', { size: 'md' })}<span>${t('Bajar')}</span></button>`}
    <div class="lib-menu-sep"></div>
    <button class="lib-menu-item" data-act="share">${icon('share', { size: 'md' })}<span>${t('Compartir estantería…')}</span></button>
    ${myLinks.length ? `<button class="lib-menu-item" data-act="links">${icon('xmark', { size: 'md' })}<span>${t('Retirar enlaces ({n})…', { n: myLinks.length })}</span></button>` : ''}
    <div class="lib-menu-sep"></div>
    ${dossierItems}
    <button class="lib-menu-item danger" data-act="delete">${icon('trash', { size: 'md' })}<span>${t('Eliminar estantería')}</span></button>
  `, async (act, item) => {
    if (act === 'unshare') {
      const d = dossiers[Number(item.dataset.i)];
      const who = d.from || t('otra persona');
      const ok = await confirmBox(d.books === 1
        ? t('Se quitan los subrayados, libretas, artefactos y mazos de {name} en este libro. El libro sigue en tu biblioteca, y los mazos que ya añadiste a los tuyos se quedan.', { name: who })
        : t('Se quitan los subrayados, libretas, artefactos y mazos de {name} en estos {n} libros. Los libros siguen en tu biblioteca, y los mazos que ya añadiste a los tuyos se quedan.', { name: who, n: d.books }),
        { title: t('Quitar lo de {name}', { name: who }), okText: 'Quitar', danger: true });
      if (ok) await (await import('../share/store.js')).removeDossier(d.key);
      return;
    }
    if (act === 'filter') {
      // La vía táctil para cruzar estanterías: en el rail eso es ⌘/Ctrl+clic,
      // que en un móvil no existe.
      selection.delete('none');
      if (inFilter) selection.delete(id);
      else selection.set(id, { label: Shelves.segments(shelf.name).pop(), ids: [id] });
    } else if (act === 'rename') {
      // El nombre ES la jerarquía: renombrar a "Técnico/ML" la mueve bajo
      // "Técnico" (y lo crea como grupo si no existe). De ahí la pista.
      const name = (await promptBox('Nuevo nombre (usa «/» para anidar, p. ej. Técnico/ML):',
        { title: 'Renombrar estantería', value: shelf.name }) || '').trim();
      if (name) await Store.renameShelf(id, name);
    } else if (act === 'rule') {
      await editSmartShelf(shelf);
    } else if (act === 'up' || act === 'down') {
      await Store.moveShelf(id, act === 'up' ? -1 : 1);
    } else if (act === 'share') {
      await shareShelf(shelf);
      return;
    } else if (act === 'links') {
      await revokeLinks(shelf.name, myLinks);
      return;
    } else if (act === 'pin') {
      togglePinned(id);
    } else if (act === 'delete') {
      const msg = smart
        ? t('¿Eliminar la estantería inteligente "{name}"? Los libros no se borran.', { name: shelf.name })
        : t('¿Eliminar la estantería "{name}"? Los libros no se borran.', { name: shelf.name });
      if (await confirmBox(msg, { title: 'Eliminar estantería', okText: 'Eliminar', danger: true })) {
        await Store.deleteShelf(id);
        selection.delete(id);
      }
    }
    await render();
  });
}

// ---- compartir: estantería o libro (P24) -----------------------------------

// Pasarle a otra persona un libro o una estantería con lo que has sacado de ellos:
// subrayados, libretas, artefactos y mazos, y los libros si caben. Por enlace (cifrado, F4)
// o como fichero `.bookreader`. `target`: { kind: 'shelf' | 'book', id, name }. Un libro
// suelto es el mismo dossier con un solo libro (`scope: 'book'`): quien lo recibe no tiene
// que cargar con una estantería «Título · de X». Los módulos se cargan al pulsar.
const SHARE_TXT = {
  shelf: {
    title: () => t('Compartir estantería'),
    empty: () => t('Ningún libro de esta estantería tiene todavía nada de lo elegido.'),
    asFile: (code) => code === 'too_large' ? t('Es demasiado grande para un enlace. ¿La mando como fichero?')
      : code === 'capacity' ? t('Ahora mismo no se pueden crear más enlaces. ¿La mando como fichero?')
        : t('No se pudo crear el enlace. ¿La mando como fichero?'),
    text: (name) => t('Te paso mi estantería «{name}» de BookReader, con mis notas:', { name }),
    copied: (date) => t('Enlace copiado. Pégalo donde quieras: quien lo abra verá la estantería y podrá guardarla. Caduca el {date}; puedes retirarlo antes desde el menú de la estantería.', { date }),
  },
  book: {
    title: () => t('Compartir libro'),
    empty: () => t('Este libro no tiene todavía nada de lo elegido.'),
    asFile: (code) => code === 'too_large' ? t('Es demasiado grande para un enlace. ¿Lo mando como fichero?')
      : code === 'capacity' ? t('Ahora mismo no se pueden crear más enlaces. ¿Lo mando como fichero?')
        : t('No se pudo crear el enlace. ¿Lo mando como fichero?'),
    text: (name) => t('Te paso «{name}» en BookReader, con mis notas:', { name }),
    copied: (date) => t('Enlace copiado. Pégalo donde quieras: quien lo abra tendrá el libro con tus notas. Caduca el {date}; puedes retirarlo antes desde el menú del libro.', { date }),
  },
};

async function shareShelf(shelf) {
  return shareDossier({ kind: 'shelf', id: shelf.id, name: shelf.name });
}

// Un libro suelto (menú del libro y «Más» del lector).
export async function shareBook(bookId) {
  const rec = (await Store.getAllRecords()).find(r => r.id === bookId && !r.deleted);
  if (!rec) return;
  return shareDossier({ kind: 'book', id: rec.id, name: rec.title || t('Libro') });
}

async function shareDossier(target) {
  const T = SHARE_TXT[target.kind];
  const Share = await import('../share/export.js');
  const Bundle = await import('../share/bundle.js');
  let books;
  if (target.kind === 'book') {
    books = (await Store.getAllRecords()).filter(r => r.id === target.id && !r.deleted);
  } else {
    ({ books } = await Share.shelfBooks(target.id));
    if (!books.length) {
      await alertBox(t('Esta estantería no tiene libros.'), { title: T.title() });
      return;
    }
  }
  // Lo que pesa son los libros: el tamaño va en la casilla, antes de mandar 400 MB por
  // error. Las fichas fantasma (el fichero solo está en Drive) no pueden ir en el paquete.
  const local = books.filter(b => Store.hasFile(b));
  const ghosts = books.length - local.length;
  const bytes = local.reduce((n, b) => n + (b.size || 0), 0);
  let filesLabel = (target.kind === 'book' ? t('El libro (PDF/EPUB)') : t('Los libros (PDF/EPUB)')) + (bytes ? ' · ' + humanSize(bytes) : '');
  if (ghosts) filesLabel += ' · ' + (target.kind === 'book' ? t('sin fichero en este dispositivo') : t('{n} sin fichero en este dispositivo', { n: ghosts }));
  const res = await formBox({
    title: T.title(),
    message: books.length === 1
      ? t('Se comparte el libro con lo que has sacado de él. Quien lo reciba lo abre en BookReader y ve tus notas en su sitio.')
      : t('Se comparten {n} libros con lo que has sacado de ellos. Quien lo reciba lo abre en BookReader y ve tus notas en su sitio.', { n: books.length }),
    fields: [
      { name: 'parts', label: 'Incluir', type: 'checks', value: [...(local.length ? ['files'] : []), 'highlights', 'notebooks', 'artifacts', 'decks'],
        options: [
          ...(local.length ? [{ value: 'files', label: filesLabel }] : []),
          { value: 'highlights', label: t('Subrayados y notas') },
          { value: 'notebooks', label: t('Libretas') },
          { value: 'chat', label: t('Conversaciones con el agente') },
          { value: 'artifacts', label: t('Artefactos (resúmenes, mapas, infografías…)') },
          { value: 'decks', label: t('Mazos de tarjetas (sin tu progreso)') },
        ] },
      { name: 'author', label: 'Tu nombre (opcional)', type: 'text', value: Share.getAuthor(),
        placeholder: 'Así verá quién se lo manda' },
      // P24 F4: el enlace se abre con un toque en cualquier móvil; el fichero hay que guardarlo
      // y subirlo. El fichero sigue para quien no quiera que pase por un servidor (aunque
      // vaya cifrado) o no tenga red.
      { name: 'how', label: 'Cómo', type: 'select', value: 'link',
        options: { link: 'Enlace (se abre con un toque, caduca en 7 días)', file: 'Fichero .bookreader' } },
    ],
    okText: t('Compartir'),
  });
  if (!res) return;
  let parts = res.parts || [];
  if (!parts.length) return;
  Share.setAuthor(res.author);
  const pack = (opts) => (target.kind === 'book' ? Share.packBook(target.id, opts) : Share.packShelf(target.id, opts));
  let pkg = await pack({ parts, author: res.author });
  if (Bundle.counts(pkg.bundle).empty) {
    await alertBox(T.empty(), { title: T.title() });
    return;
  }
  const event = target.kind === 'book' ? 'share_book' : 'share_shelf';
  if (res.how === 'link') {
    const Link = await import('../share/link.js');
    // Con los libros puede pasar del tope del enlace (100 MB): enlace sin libros, o fichero.
    if (pkg.blob.size > Link.MAX_LINK_BYTES && parts.includes('files')) {
      const alt = await formBox({
        title: T.title(),
        message: t('Con los libros pesa {size}, más de lo que cabe en un enlace (100 MB).', { size: humanSize(pkg.blob.size) }),
        fields: [{ name: 'alt', label: 'Qué hago', type: 'select', value: 'nobooks',
          options: { nobooks: 'Enlace sin los libros (notas, libretas y artefactos)', file: 'Fichero con los libros' } }],
        okText: t('Continuar'),
      });
      if (!alt) return;
      if (alt.alt === 'file') { const how = await Share.deliver(pkg); if (how !== 'cancelled') track(event, how); return; }
      parts = parts.filter(x => x !== 'files');
      pkg = await pack({ parts, author: res.author });
    }
    await shareLink(Link, pkg, target, Share);
    return;
  }
  const how = await Share.deliver(pkg);
  if (how !== 'cancelled') track(event, how);
}

// Retirar enlaces de una estantería o un libro: se borran del servidor al momento (quien los
// tenga ya no puede abrirlos). Lo ya importado por otros se queda en sus bibliotecas.
async function revokeLinks(name, links) {
  const day = (ts) => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
  const res = await formBox({
    title: t('Enlaces de «{name}»', { name }),
    message: t('Quien tenga el enlace puede abrir la estantería hasta que caduque. Al retirarlo se borra al momento; lo que ya hayan importado se queda en su biblioteca.'),
    fields: [{ name: 'ids', label: 'Retirar', type: 'checks', value: links.map(l => l.id),
      options: links.map(l => ({ value: l.id, label: t('Creado el {a} · caduca el {b}', { a: day(l.createdAt), b: day(l.expiresAt) }) })) }],
    okText: t('Retirar'),
  });
  if (!res || !(res.ids || []).length) return;
  const Link = await import('../share/link.js');
  let failed = 0;
  for (const l of links.filter(x => res.ids.includes(x.id))) {
    try { await Link.revokeLink(l); } catch { failed++; }
  }
  if (failed) await alertBox(t('No se pudo retirar {n} enlace(s). Comprueba la conexión y vuelve a probar.', { n: failed }), { title: t('Enlaces compartidos') });
  else track('share_link_revoke', String(res.ids.length));
}

// Sube el dossier cifrado y entrega el enlace: hoja de compartir del sistema en móvil
// (WhatsApp, Telegram…), portapapeles en escritorio.
async function shareLink(Link, pkg, target, Share) {
  const T = SHARE_TXT[target.kind];
  const event = target.kind === 'book' ? 'share_book' : 'share_shelf';
  const { toast } = await import('../ai/toast.js');
  const dismiss = toast({ message: t('Preparando el enlace…'), timeout: 0 });
  let out;
  try {
    out = await Link.createLink(pkg.blob, { kind: target.kind });
  } catch (e) {
    dismiss();
    if (e.code === 'rate_limited') {
      await alertBox(t('Has creado muchos enlaces seguidos. Espera un minuto y vuelve a probar.'), { title: T.title() });
      return;
    }
    // Sin enlace (sin red, servidor caído o demasiado grande): el paquete ya está hecho, se
    // ofrece mandarlo como fichero en vez de obligar a empezar de nuevo.
    const asFile = await confirmBox(T.asFile(e.code), { title: T.title(), okText: t('Mandar fichero') });
    if (!asFile) return;
    const how = await Share.deliver(pkg);
    if (how !== 'cancelled') track(event, how);
    return;
  }
  dismiss();
  Link.rememberLink(out, target.kind === 'book'
    ? { kind: 'book', bookId: target.id, shelfName: target.name }
    : { kind: 'shelf', shelfId: target.id, shelfName: target.name });
  const text = T.text(target.name);
  const date = new Date(out.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  if (coarse && navigator.share) {
    try {
      await navigator.share({ title: target.name, text, url: out.url });
      track(event, 'link');
      return;
    } catch (e) {
      if (e?.name === 'AbortError') return;
    }
  }
  let copied = false;
  try { await navigator.clipboard.writeText(`${text} ${out.url}`); copied = true; } catch { /* sin permiso */ }
  track(event, 'link');
  await alertBox(copied
    ? T.copied(date)
    : t('Este es el enlace (caduca el {date}): {url}', { date, url: out.url }),
  { title: T.title() });
}

// ---- menú de libro ---------------------------------------------------------

// Nombre del fichero que se exporta. `fileName` puede venir vacío en una ficha
// que llegó por sync (library-sync.js propaga lo que tuviera el origen, y los
// libros viejos no lo guardaban), así que hay plan B con el título. Se limpian
// los caracteres que no valen en un nombre de fichero: el nombre sale del
// título del EPUB, que es texto libre.
function exportName(record) {
  const ext = record.format === 'pdf' ? 'pdf' : 'epub';
  const raw = (record.fileName || `${record.title || 'libro'}.${ext}`).replace(/[\\/:*?"<>|]/g, '_').trim();
  const safe = raw || `libro.${ext}`;
  return new RegExp(`\\.${ext}$`, 'i').test(safe) ? safe : `${safe}.${ext}`;
}

const mimeFor = (format) => (format === 'pdf' ? 'application/pdf' : 'application/epub+zip');

// ¿Sabe este navegador compartir FICHEROS? El móvil sí (hoja del sistema:
// AirDrop, WhatsApp…), el Chrome de escritorio no. Decide el VERBO del menú:
// "Compartir" abre la hoja y "Exportar" deja el fichero en Descargas, y ofrecer
// uno para hacer el otro sería mentir sobre lo que va a pasar al pulsar.
//
// Se prueba con un fichero de juguete porque `canShare` exige un File real, y
// del mismo tipo porque el soporte depende de la extensión: Android comparte
// PDF y rechaza EPUB. Por eso la pregunta es por formato y no global.
function canShareFile(format) {
  if (!navigator.canShare) return false;
  const type = mimeFor(format);
  try {
    return navigator.canShare({ files: [new File([new Uint8Array(1)], 'probe.' + (format === 'pdf' ? 'pdf' : 'epub'), { type })] });
  } catch (_) {
    return false;
  }
}

// Saca el ARCHIVO del libro de la biblioteca: Web Share con el fichero donde lo
// haya (el camino real para mandárselo a alguien desde el móvil) y descarga en
// el resto. Es la ÚNICA vía de recuperar el binario una vez importado: la copia
// de Drive vive en el appDataFolder, que no se ve en drive.google.com ni se
// puede compartir (ver sync/drive-provider.js).
async function exportBook(id) {
  const record = await Store.getRaw(id);
  if (!record || !Store.hasFile(record)) {
    await alertBox(t('El archivo no está en este dispositivo. Descárgalo primero y vuelve a intentarlo.'),
      { title: t('Exportar archivo') });
    return;
  }
  const type = mimeFor(record.format);
  // El binario se guarda como Blob desde la migración; los libros importados
  // antes siguen con ArrayBuffer hasta que se abren (app.js · migrateFileToBlob).
  const blob = record.file instanceof Blob ? record.file : new Blob([record.file], { type });
  const name = exportName(record);
  const file = new File([blob], name, { type });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      // Cancelar es una respuesta, no un fallo: no se cae a la descarga.
      if (e && e.name === 'AbortError') return;
      console.warn('No se pudo compartir el archivo, se descarga:', e);
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Libera el archivo de ESTE dispositivo dejando la ficha fantasma. Si todavía no
// está en Drive, lo sube primero: quitarlo sin copia no sería liberar espacio,
// sería borrar el libro. Devuelve si se llegó a liberar.
async function freeDownload(book) {
  const size = humanSize(book.size);
  const uploaded = !!(book.blob && book.blob.path);
  const msg = uploaded
    ? t('Se liberará el archivo de este dispositivo. Seguirá en tu biblioteca y podrás volver a descargarlo desde Drive.')
    : t('Primero se subirá a Drive ({size}) y luego se liberará de este dispositivo. Seguirá en tu biblioteca y podrás volver a descargarlo.', { size });
  if (!(await confirmBox(msg, { title: t('Quitar descarga'), okText: t('Quitar') }))) return false;

  if (!uploaded) {
    // markManualUpload por si supera el techo de subida automática: aquí lo ha
    // pedido el usuario, que es justo la excepción que ese techo contempla.
    Blobs.markManualUpload(book.id);
    await Blobs.flush();
    const fresh = await Store.getBook(book.id);
    if (!(fresh && fresh.blob && fresh.blob.path)) {
      await alertBox(t('No se pudo subir el archivo a Drive, así que no se ha quitado de aquí: sin copia en Drive, quitarlo sería perderlo.'),
        { title: t('Quitar descarga') });
      return false;
    }
  }
  await Store.removeDownload(book.id);
  return true;
}

// Eliminar de la biblioteca. Con sync activo el borrado NO es local: viaja al
// resto de dispositivos y se lleva la copia de Drive.
//
// Por eso, cuando el archivo se puede recuperar después, el diálogo pregunta el
// ALCANCE en vez de dar por hecho el borrado total. La papeleta es la puerta por
// la que se entra buscando hacer hueco en un dispositivo, y sin esa pregunta la
// única salida visible era borrar el libro en todos.
async function removeBook(book, canFree) {
  if (canFree) {
    const choice = await formBox({
      title: t('Eliminar libro'),
      message: t('¿Qué quieres hacer con "{title}"?', { title: book.title }),
      fields: [{
        name: 'scope', label: 'Alcance', type: 'select', value: 'device',
        options: {
          device: t('Quitar la descarga solo de este dispositivo ({size})', { size: humanSize(book.size) }),
          all: t('Eliminarlo de la biblioteca y de todos mis dispositivos'),
        },
      }],
      okText: t('Continuar'),
    });
    if (!choice) return false;
    if (choice.scope === 'device') return freeDownload(book);
  }
  const msg = DriveAuth.isConnected()
    ? t('¿Eliminar "{title}" de la biblioteca? Se borrará en todos tus dispositivos sincronizados, junto con la copia de Drive.', { title: book.title })
    : t('¿Eliminar "{title}" de la biblioteca? Esto borra el archivo guardado.', { title: book.title });
  if (!(await confirmBox(msg, { title: t('Eliminar libro'), okText: t('Eliminar'), danger: true }))) return false;
  await Store.deleteBook(book.id);
  Blobs.schedule();   // libera también el binario de Drive
  return true;
}

async function openBookMenu(id, anchor) {
  closeMenu();
  const [book, shelves] = await Promise.all([Store.getBook(id), Store.getShelves()]);
  if (!book) return;
  const inShelf = new Set(book.shelfIds || []);
  // Solo las MANUALES se marcan: en una inteligente la pertenencia la decide la
  // regla, y ofrecer una casilla que no hace nada sería mentir. Las que ya
  // contienen el libro se dicen abajo, para que no parezca que faltan.
  const manualShelves = shelves.filter(s => !Shelves.isSmart(s));
  const smartShelves = shelves.filter(s => Shelves.isSmart(s) && Shelves.booksIn([book], s).length);
  const finished = book.status === 'finished';
  const local = Store.hasFile(book);
  // P24 · Compartido como libro suelto: tus enlaces de este libro y lo que otros te pasaron.
  let bookLinks = [], bookDossiers = [];
  try { bookLinks = (await import('../share/link.js')).linksForBook(id); } catch (e) { /* sin storage */ }
  try { bookDossiers = await (await import('../share/store.js')).bookDossiersFor(id); } catch (e) { /* sin base */ }
  const uploaded = !!(book.blob && book.blob.path);

  // Bloque de almacenamiento: traer el fichero, liberarlo de este dispositivo o
  // —para los libros grandes que no se suben solos— subirlo a mano.
  //
  // "Quitar descarga" se ofrece también cuando el archivo AÚN no está en Drive
  // pero puede estarlo (conectado y Pro): se sube y luego se libera. Antes, en
  // ese caso el menú no ofrecía nada y la única salida para hacer hueco era
  // "Eliminar", que borra en todos los dispositivos. Lo que no se ofrece nunca
  // es quitarlo sin copia en Drive: eso no es liberar espacio, es borrar.
  const canFree = local && (uploaded || Blobs.canTransfer());
  let storage = '';
  if (!local && uploaded) {
    storage = `<button class="lib-menu-item" data-act="download">${icon('download', { size: 'md' })}<span>${t('Descargar a este dispositivo')}</span></button>`;
  } else if (local) {
    const size = humanSize(book.size);
    const label = canShareFile(book.format)
      ? (size ? t('Compartir archivo ({size})…', { size }) : t('Compartir archivo…'))
      : (size ? t('Exportar archivo ({size})…', { size }) : t('Exportar archivo…'));
    storage += `<button class="lib-menu-item" data-act="export">${icon('share', { size: 'md' })}<span>${label}</span></button>`;
    if (!uploaded && (book.size || 0) > Blobs.MAX_AUTO_UPLOAD) {
      storage += `<button class="lib-menu-item" data-act="upload">${icon('cloud', { size: 'md' })}<span>${t('Subir a Drive ({size})', { size: humanSize(book.size) })}</span></button>`;
    }
    if (canFree) {
      storage += `<button class="lib-menu-item" data-act="undownload">${icon('xmark', { size: 'md' })}<span>${t('Quitar descarga de este dispositivo')}</span></button>`;
    }
  }

  buildMenu(anchor, `
    <button class="lib-menu-item" data-act="open">${icon('book', { size: 'md' })}<span>${local ? t('Abrir') : t('Descargar y abrir')}</span></button>
    <button class="lib-menu-item" data-act="finish">${icon('check', { size: 'md' })}<span>${finished ? t('Marcar como no leído') : t('Marcar como terminado')}</span></button>
    <button class="lib-menu-item" data-act="meta">${icon('pencil', { size: 'md' })}<span>${t('Editar título y autor')}</span></button>
    <button class="lib-menu-item" data-act="sharebook">${icon('share', { size: 'md' })}<span>${t('Compartir libro…')}</span></button>
    ${bookLinks.length ? `<button class="lib-menu-item" data-act="booklinks">${icon('xmark', { size: 'md' })}<span>${t('Retirar enlaces ({n})…', { n: bookLinks.length })}</span></button>` : ''}
    ${bookDossiers.map((d, i) => `<button class="lib-menu-item danger" data-act="unsharebook" data-i="${i}">${icon('xmark', { size: 'md' })}<span>${
      d.from ? t('Quitar lo de {name}…', { name: escapeHtml(d.from) }) : t('Quitar lo compartido…')}</span></button>`).join('')}
    ${storage ? `<div class="lib-menu-sep"></div>${storage}` : ''}
    <div class="lib-menu-sep"></div>
    <div class="lib-menu-label">${t('Estanterías')}</div>
    ${manualShelves.length
      ? manualShelves.map(s => `<button class="lib-menu-item" data-act="shelf" data-shelf="${s.id}">
          <span class="lib-menu-check">${inShelf.has(s.id) ? icon('check', { size: 'md' }) : ''}</span><span>${escapeHtml(s.name)}</span></button>`).join('')
      : `<div class="lib-menu-empty">${t('Aún no hay estanterías')}</div>`}
    ${smartShelves.length
      ? `<div class="lib-menu-note">${icon('funnel', { size: 'sm' })}<span>${t('En {names} entra solo, por su regla.', { names: smartShelves.map(s => s.name).join(', ') })}</span></div>`
      : ''}
    <button class="lib-menu-item" data-act="newshelf">${icon('plus', { size: 'md' })}<span>${t('Nueva estantería…')}</span></button>
    <div class="lib-menu-sep"></div>
    <button class="lib-menu-item danger" data-act="delete">${icon('trash', { size: 'md' })}<span>${t('Eliminar')}</span></button>
  `, async (act, item) => {
    if (act === 'open') { await openCard(id); return; }
    if (act === 'meta') { if (await editBookMeta(book)) await render(); return; }
    if (act === 'sharebook') { await shareBook(id); return; }
    if (act === 'booklinks') { await revokeLinks(book.title || t('Libro'), bookLinks); return; }
    if (act === 'unsharebook') {
      const d = bookDossiers[Number(item.dataset.i)];
      const who = d.from || t('otra persona');
      const ok = await confirmBox(t('Se quitan los subrayados, libretas, artefactos y mazos de {name} en este libro. El libro sigue en tu biblioteca, y los mazos que ya añadiste a los tuyos se quedan.', { name: who }),
        { title: t('Quitar lo de {name}', { name: who }), okText: 'Quitar', danger: true });
      if (ok) await (await import('../share/store.js')).removeDossier(d.key);
      return;
    }
    if (act === 'download') { await startDownload(id); return; }
    if (act === 'export') { await exportBook(id); return; }
    if (act === 'upload') {
      if (!DriveAuth.isConnected()) {
        await alertBox(t('Conecta con Google Drive en Ajustes para subir tus libros.'), { title: t('Sincronización') });
        return;
      }
      if (!(await ensurePro('files'))) return;
      Blobs.markManualUpload(id);
      Blobs.schedule();
      return;
    }
    if (act === 'undownload') {
      if (await freeDownload(book)) await render();
      return;
    }
    if (act === 'finish') {
      await Store.updateBook(id, { status: finished ? (book.progress > 0 ? 'reading' : 'unread') : 'finished' });
    } else if (act === 'shelf') {
      await Store.toggleBookShelf(id, item.dataset.shelf, !inShelf.has(item.dataset.shelf));
    } else if (act === 'newshelf') {
      const name = (await promptBox('Nombre de la nueva estantería:', { title: 'Nueva estantería' }) || '').trim();
      if (name) { const sh = await Store.addShelf(name); await Store.toggleBookShelf(id, sh.id, true); }
    } else if (act === 'delete') {
      if (!(await removeBook(book, canFree))) return;
    }
    await render();
  });
}

// ---- popover genérico ------------------------------------------------------

function buildMenu(anchor, innerHtml, onAct) {
  menuEl = document.createElement('div');
  menuEl.className = 'lib-menu';
  menuEl.innerHTML = innerHtml;
  document.body.appendChild(menuEl);
  positionMenu(anchor);
  menuEl.addEventListener('click', async (ev) => {
    const item = ev.target.closest('.lib-menu-item');
    if (!item) return;
    const keep = item.dataset.act === 'open' ? false : false; // siempre cerramos
    closeMenu();
    await onAct(item.dataset.act, item);
  });
}

function positionMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  menuEl.style.visibility = 'hidden';
  menuEl.style.display = 'block';
  const mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
  let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
  left = Math.max(8, left);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  menuEl.style.left = left + 'px';
  menuEl.style.top = top + 'px';
  menuEl.style.visibility = 'visible';
}

function closeMenu() {
  if (menuEl) { menuEl.remove(); menuEl = null; }
}

// ---- util ------------------------------------------------------------------

function initials(title) {
  return (title || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase();
}
