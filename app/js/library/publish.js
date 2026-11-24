// Perfil público (experimento, paso 1; ver «Perfil público» en DECISIONS cuando haya ADR).
//
// Ajustes → Perfil público configura QUÉ se ve en la página pública (`/@<handle>/`): qué
// estanterías, en qué orden y con qué nombre, qué libros de cada una, si se enseña el progreso y
// cuál se está leyendo. La configuración se GUARDA (clave `public_profile`, viaja en el sync con
// «gana el cambio más reciente», ver sync/layout.js) para no elegirlo todo cada vez.
//
// Al publicar, la app arma la FOTO de lo elegido —título, autor, estado, progreso y una portada en
// miniatura de los libros marcados— y nada más: ni ficheros, ni notas, ni las estanterías que no
// sean públicas. El sync sigue cifrado; lo publicado es otra cosa, explícita y aparte.
//
// Paso 1, sin servidor: «Descargar» deja un `perfil-<handle>.json` que `scripts/publicar-perfil.mjs`
// convierte en la página, y «Vista previa» deja la foto en localStorage y abre la página con
// `?draft=1` (mismo origen), que la pinta en lugar de su `perfil.json`.
//
// Un libro que entra en una estantería pública DESPUÉS de configurarla queda OCULTO hasta que se
// marque: nunca se publica algo que no se haya visto.
//
// Oculto salvo con `?perfil-preview=1` (`=0` lo quita).
import * as Store from './store.js';
import * as Shelves from './shelves.js';
import * as Storage from '../storage.js';
import { withoutSubtitle } from './book-meta.js';
import { t } from '../i18n.js';
import { escapeHtml } from '../ui/escape.js';
import { alertBox } from '../ui/dialog.js';

const FLAG = 'perfil_preview';
export const CONFIG_KEY = 'public_profile';
export const DRAFT_KEY = 'bookreader_perfil_draft';
const COVER_W = 320;

try {
  const q = new URLSearchParams(location.search).get('perfil-preview');
  if (q === '1') Storage.set(FLAG, true);
  if (q === '0') Storage.remove(FLAG);
} catch { /* sin localStorage: sin la opción */ }

export function available() {
  return Storage.get(FLAG, false) === true;
}

// ---- configuración -----------------------------------------------------------

// { updatedAt, enabled, handle, showProgress, now: 'auto'|'none'|<bookId>,
//   shelves: [{ id, name, books: [{ id, show, style }] }] }   (shelves: solo las públicas, en orden)
export function emptyConfig() {
  return { updatedAt: 0, enabled: false, handle: 'luis', showProgress: true, now: 'auto', styleAuto: true, shelves: [] };
}
export function getConfig() {
  const c = Storage.get(CONFIG_KEY, null);
  if (!c || typeof c !== 'object') return emptyConfig();
  const out = { ...emptyConfig(), ...c, shelves: Array.isArray(c.shelves) ? c.shelves : [] };
  // Antes de existir «automático», 'plain' era el valor por defecto y no una elección: pasa a 'auto'.
  if (!c.styleAuto) {   // la guardada, no la mezcla: emptyConfig() ya trae styleAuto
    out.shelves = out.shelves.map(s => ({ ...s, books: (s.books || []).map(b => ({ ...b, style: !b.style || b.style === 'plain' ? 'auto' : b.style })) }));
    out.styleAuto = true;
  }
  return out;
}
export function saveConfig(c) {
  Storage.set(CONFIG_KEY, { ...c, updatedAt: Date.now() });
}

// Pura (la usan los tests). Pone la configuración al día con la biblioteca:
//   - quita las estanterías públicas que ya no existen;
//   - en cada una, quita los libros que ya no están y AÑADE los nuevos al final, ocultos y con
//     `fresh: true` (no se guarda: solo marca «Nuevo» en la pantalla).
// `members(shelf)` devuelve los libros de la rama (con sus subestanterías).
export function reconcile(config, shelves, members) {
  const byId = new Map(shelves.map(s => [s.id, s]));
  const out = { ...config, shelves: [] };
  for (const entry of config.shelves || []) {
    const shelf = byId.get(entry.id);
    if (!shelf) continue;
    const recs = members(shelf);
    const ids = new Set(recs.map(r => r.id));
    const kept = (entry.books || []).filter(b => ids.has(b.id)).map(b => ({ id: b.id, show: !!b.show, style: b.style || 'auto' }));
    const known = new Set(kept.map(b => b.id));
    const fresh = recs.filter(r => !known.has(r.id)).map(r => ({ id: r.id, show: false, style: 'auto', fresh: true }));
    out.shelves.push({ id: entry.id, name: entry.name || Shelves.segments(shelf.name).pop(), books: [...kept, ...fresh] });
  }
  return out;
}

// Al hacer pública una estantería, sus libros de ese momento salen VISIBLES: se acaba de elegir
// y se ve la lista entera. Lo que llegue después entra oculto (reconcile).
export function addShelf(config, shelf, recs) {
  if (config.shelves.some(s => s.id === shelf.id)) return config;
  return { ...config, shelves: [...config.shelves, {
    id: shelf.id, name: Shelves.segments(shelf.name).pop(),
    books: recs.map(r => ({ id: r.id, show: true, style: 'auto' })),
  }] };
}

const stripFresh = (c) => ({ ...c, shelves: c.shelves.map(s => ({ ...s, books: s.books.map(({ fresh, ...b }) => b) })) });

// ---- piezas puras del lomo (las usan los tests) ------------------------------

// Apellidos para el lomo: «Maarten Grootendorst, Jay Alammar» → «Grootendorst & Alammar»;
// con tres o más, el primero y «et al.».
export function spineAuthor(author) {
  const people = String(author || '').split(/\s*(?:,|;|&|\by\b|\band\b)\s*/i).map(s => s.trim()).filter(Boolean);
  const last = (p) => p.split(/\s+/).pop();
  if (!people.length) return '';
  if (people.length === 1) return last(people[0]);
  if (people.length === 2) return `${last(people[0])} & ${last(people[1])}`;
  return `${last(people[0])} et al.`;
}

// Título del lomo: sin subtítulo, que en vertical no cabe.
export function spineTitle(title) {
  return withoutSubtitle(title) || String(title || '').trim();
}

// No sabemos las páginas (el lector no las guarda): se estiman por tamaño, solo para el grosor
// del libro. La página pública no las enseña cuando van estimadas.
export function estimatePages(rec) {
  const bytes = rec.size || 0;
  const per = rec.format === 'pdf' ? 30000 : 5000;
  return Math.max(40, Math.min(900, Math.round(bytes / per) || 200));
}

// Tinta legible sobre un fondo: negro o blanco según la luminancia.
export function inkFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return L > 0.4 ? { ink: '#1d1d1f', muted: '#4a4a4f' } : { ink: '#ffffff', muted: '#d9d9de' };
}

export function spineFor(rec, style, bg) {
  const title = spineTitle(rec.title);
  const author = spineAuthor(rec.author);
  if (style === 'oreilly') return { style: 'oreilly', bg: '#ffffff', ink: '#1d1d1f', muted: '#1d1d1f', title, author };
  return { style: 'plain', bg, ...inkFor(bg), title, author };
}

// ¿Es una portada de O'Reilly? Fondo blanco en el borde izquierdo y el logotipo rojo arriba a la
// izquierda. Medido con las portadas reales (24-nov-2026), en la franja del 7 % superior y la mitad
// izquierda: las de O'Reilly dan 2,4–3,2 % de píxeles rojos; un paper de arXiv (rojo más abajo),
// Packt o una portada oscura, 0 %. `px` son los RGBA de la miniatura de `w`×`h`.
export function looksOReilly(px, w, h) {
  let red = 0, n = 0, edge = 0, en = 0;
  for (let y = 0; y < Math.round(h * 0.07); y++) for (let x = 0; x < Math.round(w * 0.5); x++) {
    const i = (y * w + x) * 4; const r = px[i], g = px[i + 1], b = px[i + 2];
    n++; if (r > 140 && r - g > 70 && r - b > 50) red++;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < Math.max(1, Math.round(w * 0.06)); x++) {
    const i = (y * w + x) * 4; edge += (px[i] + px[i + 1] + px[i + 2]) / 3; en++;
  }
  return n > 0 && red / n > 0.01 && edge / en > 220;
}

export const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'shelf';

// ---- portada ------------------------------------------------------------------

function loadImage(src) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
}

const hex = (r, g, b) => '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');

// Miniatura en webp (320 px de ancho) y el color de su borde izquierdo, que es lo más parecido
// al lomo que tenemos. Sin portada, se dibuja una tipográfica con el color del libro.
async function coverAndColor(rec) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let im = null;
  if (rec.cover) { try { im = await loadImage(rec.cover); } catch { im = null; } }
  if (im) {
    canvas.width = COVER_W; canvas.height = Math.round(COVER_W * im.naturalHeight / im.naturalWidth);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(im, 0, 0, canvas.width, canvas.height);
    const strip = ctx.getImageData(0, 0, Math.max(4, Math.round(canvas.width * 0.06)), canvas.height).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < strip.length; i += 4) { r += strip[i]; g += strip[i + 1]; b += strip[i + 2]; n++; }
    const oreilly = looksOReilly(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
    return { coverData: toWebp(canvas), bg: hex(r / n, g / n, b / n), oreilly };
  }
  const bg = '#2b3a4a';
  canvas.width = COVER_W; canvas.height = Math.round(COVER_W * 1.5);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff'; ctx.font = '600 26px Georgia, serif'; ctx.textBaseline = 'top';
  let y = 60; let line = '';
  for (const w of spineTitle(rec.title).split(/\s+/)) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > canvas.width - 56 && line) { ctx.fillText(line, 28, y); y += 34; line = w; } else line = test;
  }
  if (line) ctx.fillText(line, 28, y);
  ctx.font = '400 16px Georgia, serif'; ctx.fillStyle = '#d9d9de';
  ctx.fillText(String(rec.author || '').slice(0, 40), 28, canvas.height - 56);
  return { coverData: toWebp(canvas), bg, oreilly: false };
}

function toWebp(canvas) {
  try { const u = canvas.toDataURL('image/webp', 0.82); if (u.startsWith('data:image/webp')) return u; } catch { /* sin webp */ }
  return canvas.toDataURL('image/jpeg', 0.85);
}

// ---- foto -----------------------------------------------------------------------

const statusOf = (rec) => rec.status === 'finished' ? 'finished'
  : (rec.status === 'reading' || (rec.progress || 0) > 0) ? 'reading' : 'unread';

// Libro que se está leyendo, según la configuración: el elegido si sigue visible; con «auto», el
// visible a medias que se abrió más tarde; con «none», ninguno.
export function pickNow(config, recsById) {
  const visible = config.shelves.flatMap(s => s.books.filter(b => b.show).map(b => b.id));
  if (config.now === 'none') return null;
  if (config.now && config.now !== 'auto') return visible.includes(config.now) ? config.now : null;
  const reading = [...new Set(visible)].map(id => recsById.get(id)).filter(r => r && statusOf(r) === 'reading');
  reading.sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));
  return reading[0] ? reading[0].id : null;
}

// La foto (formato 2): estanterías con los ids de sus libros, y cada libro una sola vez aunque
// esté en varias. El lomo de un libro es el que se eligió donde aparece primero.
async function snapshot(config) {
  const recsById = new Map((await Store.getAllRecords()).filter(r => !r.deleted).map(r => [r.id, r]));
  const books = new Map();
  const shelves = [];
  const usedSlugs = new Set();
  for (const s of config.shelves) {
    const ids = [];
    for (const b of s.books) {
      const rec = recsById.get(b.id);
      if (!b.show || !rec) continue;
      const short = rec.id.slice(0, 12);
      ids.push(short);
      if (books.has(short)) continue;
      const { coverData, bg, oreilly } = await coverAndColor(rec);
      // «Automático»: O'Reilly si la portada lo es; si no, el color de la portada.
      const style = b.style === 'auto' || !b.style ? (oreilly ? 'oreilly' : 'plain') : b.style;
      books.set(short, {
        bookId: rec.id, id: short,
        title: rec.title || '', author: rec.author || '',
        status: statusOf(rec),
        progress: config.showProgress ? Math.round(rec.progress || 0) : null,
        pages: estimatePages(rec), pagesEstimated: true,
        spine: spineFor(rec, style, bg),
        // Elegido por la app, no a mano: el script no lo deja pisar un lomo hecho a mano.
        ...(b.style === 'auto' || !b.style ? { spineAuto: true } : {}),
        coverData,
      });
    }
    if (!ids.length) continue;
    let id = slug(s.name); let k = 2;
    while (usedSlugs.has(id)) id = `${slug(s.name)}-${k++}`;
    usedSlugs.add(id);
    shelves.push({ id, name: s.name, books: ids });
  }
  const nowId = pickNow(config, recsById);
  return { format: 'bookreader-perfil', version: 2, exportedAt: new Date().toISOString(),
    handle: config.handle, showProgress: config.showProgress,
    now: nowId && books.has(nowId.slice(0, 12)) ? nowId.slice(0, 12) : null,
    shelves, books: [...books.values()] };
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ---- Ajustes → Perfil público ---------------------------------------------------

let focusShelf = null;   // la estantería desde cuyo menú se llegó: se añade y se despliega
const expanded = new Set();

// Desde el menú de una estantería: la hace pública (si no lo era) y abre Ajustes en esta sección.
export async function openFor(shelfId) {
  focusShelf = shelfId;
  expanded.add(shelfId);
  (await import('../ui/app-settings.js')).open('public');
}

async function load() {
  const [shelves, records] = await Promise.all([Store.getShelves(), Store.getAllRecords()]);
  const recs = records.filter(r => !r.deleted);
  const members = (shelf) => Shelves.booksInBranch(recs, shelves, shelf);
  let config = reconcile(getConfig(), shelves, members);
  let lastFocus = null;
  if (focusShelf) {
    const shelf = shelves.find(s => s.id === focusShelf);
    if (shelf) {
      if (!config.shelves.some(s => s.id === shelf.id)) config = addShelf(config, shelf, members(shelf));
      // Llegar desde el menú de una estantería es querer publicarla: el perfil se activa.
      config.enabled = true;
      saveConfig(stripFresh(config));
      lastFocus = shelf.id;
    }
    focusShelf = null;
  }
  return { shelves, recs, recsById: new Map(recs.map(r => [r.id, r])), members, config, lastFocus };
}

const pageUrl = (handle) => `https://bookreader.raiatech.com/@${handle}/`;

function sectionHtml(st) {
  const { config, shelves, recsById } = st;
  const publicIds = new Set(config.shelves.map(s => s.id));
  const others = Shelves.shelfRows(shelves).filter(r => r.shelf && !publicIds.has(r.shelf.id));
  const visible = [...new Set(config.shelves.flatMap(s => s.books.filter(b => b.show).map(b => b.id)))].map(id => recsById.get(id)).filter(Boolean);
  const shelfCard = (s, i) => {
    const shelf = shelves.find(x => x.id === s.id);
    const shown = s.books.filter(b => b.show).length;
    const fresh = s.books.filter(b => b.fresh).length;
    const open = expanded.has(s.id);
    return `<li class="pp-shelf" data-shelf="${escapeHtml(s.id)}">
      <div class="pp-shelf-head">
        <input class="appset-input pp-name" data-k="name" value="${escapeHtml(s.name)}" aria-label="${escapeHtml(t('Nombre público de {name}', { name: shelf.name }))}">
        <span class="pub-move">
          <button type="button" class="dlg-btn" data-k="sup" ${i === 0 ? 'disabled' : ''} aria-label="${escapeHtml(t('Subir'))}">↑</button>
          <button type="button" class="dlg-btn" data-k="sdown" ${i === config.shelves.length - 1 ? 'disabled' : ''} aria-label="${escapeHtml(t('Bajar'))}">↓</button>
          <button type="button" class="dlg-btn" data-k="sremove" aria-label="${escapeHtml(t('Dejar de publicar {name}', { name: s.name }))}">${escapeHtml(t('Quitar'))}</button>
        </span>
      </div>
      <button type="button" class="pp-toggle" data-k="expand" aria-expanded="${open}">
        <span class="pp-toggle-txt">${escapeHtml(shelf.name)} · ${escapeHtml(t('{shown} de {n} libros visibles', { shown, n: s.books.length }))}</span>
        ${fresh ? `<span class="pp-fresh">${escapeHtml(t('{n} nuevos sin revisar', { n: fresh }))}</span>` : ''}
        <span aria-hidden="true">${open ? '▴' : '▾'}</span>
      </button>
      ${open ? `<ol class="pub-list">${s.books.map((b, j) => {
        const r = recsById.get(b.id) || {};
        return `<li class="pub-row${b.show ? '' : ' is-off'}" data-i="${j}" data-book="${escapeHtml(b.id)}">
          <input type="checkbox" data-k="show" ${b.show ? 'checked' : ''} aria-label="${escapeHtml(t('Mostrar {title}', { title: r.title || '' }))}">
          <span class="pub-cover" style="${r.cover ? `background-image:url('${escapeHtml(r.cover)}')` : ''}" aria-hidden="true"></span>
          <span class="pub-meta"><b>${escapeHtml(r.title || '')}</b><small>${b.fresh ? `<span class="pp-fresh">${escapeHtml(t('Nuevo'))}</span> ` : ''}${escapeHtml(r.author || '')}</small></span>
          <select class="dlg-input pub-style" data-k="style" aria-label="${escapeHtml(t('Lomo'))}">
            <option value="auto" data-auto ${b.style === 'auto' || !b.style ? 'selected' : ''}>${escapeHtml(t('Lomo: automático'))}</option>
            <option value="plain" ${b.style === 'plain' ? 'selected' : ''}>${escapeHtml(t('Lomo: color de la portada'))}</option>
            <option value="oreilly" ${b.style === 'oreilly' ? 'selected' : ''}>${escapeHtml(t('Lomo: O’Reilly'))}</option>
          </select>
          <span class="pub-move">
            <button type="button" class="dlg-btn" data-k="up" ${j === 0 ? 'disabled' : ''} aria-label="${escapeHtml(t('Subir'))}">↑</button>
            <button type="button" class="dlg-btn" data-k="down" ${j === s.books.length - 1 ? 'disabled' : ''} aria-label="${escapeHtml(t('Bajar'))}">↓</button>
          </span></li>`;
      }).join('')}</ol>` : ''}
    </li>`;
  };
  return `<div class="appset-section pp">
    <h3 class="appset-h3">${escapeHtml(t('Perfil público'))}</h3>
    <p class="appset-muted">${escapeHtml(t('Una página con las estanterías que elijas. Solo se publican el título, el autor, el estado y la portada de los libros que marques. Los ficheros, tus subrayados y tus notas no salen del dispositivo.'))}</p>
    <label class="appset-check"><input type="checkbox" id="pp-enabled" ${config.enabled ? 'checked' : ''}> ${escapeHtml(t('Perfil público activado'))}</label>
    <div class="pp-body"${config.enabled ? '' : ' hidden'}>
      <label class="appset-label" for="pp-handle">${escapeHtml(t('Dirección'))}</label>
      <div class="pp-handle"><span>bookreader.raiatech.com/@</span><input id="pp-handle" class="appset-input" value="${escapeHtml(config.handle)}" autocomplete="off" spellcheck="false"></div>
      <label class="appset-check"><input type="checkbox" id="pp-progress" ${config.showProgress ? 'checked' : ''}> ${escapeHtml(t('Enseñar el progreso de lectura'))}</label>
      <label class="appset-label" for="pp-now">${escapeHtml(t('Leyendo ahora'))}</label>
      <select id="pp-now" class="appset-input">
        <option value="auto" ${config.now === 'auto' ? 'selected' : ''}>${escapeHtml(t('Automático: el último que abriste'))}</option>
        <option value="none" ${config.now === 'none' ? 'selected' : ''}>${escapeHtml(t('No enseñarlo'))}</option>
        ${visible.map(r => `<option value="${escapeHtml(r.id)}" ${config.now === r.id ? 'selected' : ''}>${escapeHtml(r.title || '')}</option>`).join('')}
      </select>

      <label class="appset-label">${escapeHtml(t('Estanterías públicas'))}</label>
      ${config.shelves.length
        ? `<ol class="pp-shelves">${config.shelves.map(shelfCard).join('')}</ol>`
        : `<p class="appset-muted">${escapeHtml(t('Todavía no hay ninguna. Añade una abajo.'))}</p>`}
      ${others.length ? `<div class="pp-add">
        <select id="pp-add" class="appset-input" aria-label="${escapeHtml(t('Estantería que añadir'))}">
          ${others.map(r => `<option value="${escapeHtml(r.shelf.id)}">${escapeHtml(r.shelf.name)}</option>`).join('')}
        </select>
        <button type="button" class="dlg-btn" id="pp-add-btn">${escapeHtml(t('Añadir'))}</button>
      </div>` : ''}
      <p class="appset-muted">${escapeHtml(t('Los libros que añadas después a una estantería pública entran ocultos hasta que los marques.'))}</p>

      <div class="pp-actions">
        <button type="button" class="dlg-btn" data-act="preview">${escapeHtml(t('Vista previa'))}</button>
        <button type="button" class="btn btn--primary dlg-btn" data-act="download">${escapeHtml(t('Descargar para publicar'))}</button>
      </div>
      <p class="appset-muted">${escapeHtml(t('Tu página:'))} <a href="${escapeHtml(pageUrl(config.handle))}" target="_blank" rel="noopener">${escapeHtml(pageUrl(config.handle).replace('https://', ''))}</a></p>
    </div>
  </div>`;
}

// Qué decide «automático» para cada libro, a la vista en el selector: así se ve sin publicar si
// la portada se reconoce como de O'Reilly, y si no, se elige a mano. Se calcula una vez por libro.
const detected = new Map();   // bookId → Promise<boolean>
function detectFor(rec) {
  if (!detected.has(rec.id)) detected.set(rec.id, coverAndColor(rec).then(r => r.oreilly).catch(() => false));
  return detected.get(rec.id);
}
function labelAuto(host, recsById) {
  for (const row of host.querySelectorAll('.pub-row[data-book]')) {
    const rec = recsById.get(row.dataset.book); const opt = row.querySelector('option[data-auto]');
    if (!rec || !opt) continue;
    detectFor(rec).then(o => {
      if (!opt.isConnected) return;
      opt.textContent = `${t('Lomo: automático')} · ${o ? 'O’Reilly' : t('color de la portada')}`;
    });
  }
}

export async function renderSettings(content) {
  const st = await load();
  // Contenedor propio: `content` es de Ajustes y se reutiliza al cambiar de sección. Los listeners
  // van en `host`, que se tira con la sección, así que no se acumulan al volver a abrirla.
  content.innerHTML = '<div class="pp-host"></div>';
  const host = content.firstElementChild;
  const paint = () => {
    host.innerHTML = sectionHtml(st);
    labelAuto(host, st.recsById);
    if (st.lastFocus) host.querySelector(`.pp-shelf[data-shelf="${CSS.escape(st.lastFocus)}"]`)?.scrollIntoView({ block: 'nearest' });
  };
  // Cada cambio se guarda al momento. `fresh` es solo de pantalla y no se guarda; un libro nuevo
  // deja de serlo en cuanto se toca su fila.
  const commit = (repaint) => { saveConfig(stripFresh(st.config)); if (repaint) paint(); };
  paint();

  host.addEventListener('change', (e) => {
    const el = e.target;
    if (el.id === 'pp-enabled') { st.config.enabled = el.checked; commit(true); return; }
    if (el.id === 'pp-progress') { st.config.showProgress = el.checked; commit(false); return; }
    if (el.id === 'pp-now') { st.config.now = el.value; commit(false); return; }
    if (el.id === 'pp-handle') { st.config.handle = slug(el.value) || 'luis'; commit(true); return; }
    const card = el.closest('.pp-shelf'); if (!card) return;
    const s = st.config.shelves.find(x => x.id === card.dataset.shelf);
    if (el.dataset.k === 'name') { s.name = el.value.trim() || s.name; commit(false); return; }
    const row = el.closest('.pub-row'); if (!row) return;
    const b = s.books[+row.dataset.i];
    delete b.fresh;
    if (el.dataset.k === 'show') { b.show = el.checked; st.lastFocus = s.id; commit(true); }
    if (el.dataset.k === 'style') { b.style = el.value; commit(false); }
  });

  host.addEventListener('click', async (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    if (btn.id === 'pp-add-btn') {
      const shelf = st.shelves.find(x => x.id === host.querySelector('#pp-add').value);
      if (!shelf) return;
      st.config = addShelf(st.config, shelf, st.members(shelf));
      expanded.add(shelf.id); st.lastFocus = shelf.id;
      commit(true); return;
    }
    const act = btn.dataset.act;
    if (act === 'preview' || act === 'download') { await publish(act, btn, st.config); return; }
    const card = btn.closest('.pp-shelf'); if (!card) return;
    const i = st.config.shelves.findIndex(x => x.id === card.dataset.shelf);
    const s = st.config.shelves[i];
    const k = btn.dataset.k;
    st.lastFocus = s.id;
    if (k === 'expand') { if (expanded.has(s.id)) expanded.delete(s.id); else expanded.add(s.id); paint(); return; }
    if (k === 'sremove') { st.config.shelves.splice(i, 1); commit(true); return; }
    if (k === 'sup' || k === 'sdown') {
      const j = k === 'sup' ? i - 1 : i + 1;
      [st.config.shelves[i], st.config.shelves[j]] = [st.config.shelves[j], st.config.shelves[i]];
      commit(true); return;
    }
    if (k === 'up' || k === 'down') {
      const a = +btn.closest('.pub-row').dataset.i, z = k === 'up' ? a - 1 : a + 1;
      [s.books[a], s.books[z]] = [s.books[z], s.books[a]];
      commit(true);
      host.querySelector(`.pp-shelf[data-shelf="${CSS.escape(s.id)}"] .pub-row[data-i="${z}"] button[data-k="${k}"]`)?.focus();
    }
  });
}

async function publish(act, btn, config) {
  // La pestaña se abre YA, en el gesto del usuario: después del await el navegador la bloquea.
  const tab = act === 'preview' ? window.open('', '_blank') : null;
  btn.disabled = true;
  try {
    const snap = await snapshot(config);
    if (!snap.shelves.length) {
      tab?.close();
      await alertBox(t('No hay nada que publicar: añade una estantería y marca algún libro.'), { title: t('Perfil público') });
      return;
    }
    if (act === 'preview') {
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify(snap)); }
      catch { tab?.close(); await alertBox(t('No cabe en el almacenamiento del navegador. Quita algún libro y vuelve a probar.')); return; }
      const url = new URL(`../@${config.handle}/?draft=1`, location.href).href;
      if (tab) tab.location.href = url; else window.open(url, '_blank');
    } else {
      download(`perfil-${config.handle}.json`, JSON.stringify(snap, null, 2));
    }
  } finally { btn.disabled = false; }
}
