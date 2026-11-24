// Publicar una estantería como perfil público (experimento, paso 1; ver «Perfil público» en
// DECISIONS cuando haya ADR). La app arma la FOTO de lo que el usuario elige enseñar —título,
// autor, estado, progreso y una portada en miniatura— y nada más: ni el fichero, ni subrayados,
// ni notas. El sync sigue cifrado; lo publicado es otra cosa, explícita y aparte.
//
// En este paso no hay servidor: «Descargar» deja un `perfil-<estantería>.json` que
// `scripts/publicar-perfil.mjs` convierte en la página `/@luis/`, y «Vista previa» guarda el
// borrador en localStorage y abre esa misma página con `?draft=1` (mismo origen), que lo pinta en
// lugar de su `perfil.json`. Así la vista previa es la estantería real, no una imitación.
//
// Oculto salvo con `?perfil-preview=1` (`=0` lo quita): para el resto sería prometer algo que aún
// no existe.
import * as Store from './store.js';
import * as Shelves from './shelves.js';
import * as Storage from '../storage.js';
import { withoutSubtitle } from './book-meta.js';
import { t } from '../i18n.js';
import { escapeHtml } from '../ui/escape.js';
import { alertBox } from '../ui/dialog.js';

const FLAG = 'perfil_preview';
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

// ---- piezas puras (las usan los tests) --------------------------------------

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

// ---- portada ---------------------------------------------------------------

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
    ctx.drawImage(im, 0, 0, canvas.width, canvas.height);
    const strip = ctx.getImageData(0, 0, Math.max(4, Math.round(canvas.width * 0.06)), canvas.height).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < strip.length; i += 4) { r += strip[i]; g += strip[i + 1]; b += strip[i + 2]; n++; }
    const bg = hex(r / n, g / n, b / n);
    return { coverData: toWebp(canvas), bg };
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
  return { coverData: toWebp(canvas), bg };
}

function toWebp(canvas) {
  try { const u = canvas.toDataURL('image/webp', 0.82); if (u.startsWith('data:image/webp')) return u; } catch { /* sin webp */ }
  return canvas.toDataURL('image/jpeg', 0.85);
}

// ---- foto ------------------------------------------------------------------

// Lo que se publica. `rows` llega ya en el orden y con las elecciones del panel.
async function snapshot({ shelfName, rows, nowId, showProgress }) {
  const books = [];
  for (const row of rows) {
    if (!row.on) continue;
    const rec = row.rec;
    const { coverData, bg } = await coverAndColor(rec);
    books.push({
      bookId: rec.id,
      id: rec.id.slice(0, 12),
      title: rec.title || '',
      author: rec.author || '',
      status: rec.status === 'finished' ? 'finished' : (rec.status === 'reading' || (rec.progress || 0) > 0) ? 'reading' : 'unread',
      progress: showProgress ? Math.round(rec.progress || 0) : null,
      pages: estimatePages(rec),
      pagesEstimated: true,
      spine: spineFor(rec, row.style, bg),
      coverData,
    });
  }
  const now = books.find(b => b.bookId === nowId);
  return { format: 'bookreader-perfil', version: 1, exportedAt: new Date().toISOString(),
    shelf: shelfName, now: now ? now.id : null, showProgress, books };
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'estanteria';

// ---- panel -----------------------------------------------------------------

export async function openPublish(shelfId) {
  const shelves = await Store.getShelves();
  const shelf = shelves.find(s => s.id === shelfId);
  if (!shelf) return;
  // Una inteligente se publica con los libros que tenga ahora: la foto no guarda la regla.
  // Con sus subestanterías: publicar «Técnico» saca también lo de «Técnico/Agentes».
  const members = Shelves.booksInBranch((await Store.getAllRecords()).filter(r => !r.deleted), shelves, shelf);
  if (!members.length) { await alertBox(t('Esta estantería no tiene libros.'), { title: t('Publicar estantería') }); return; }

  // Leyendo ahora: el que esté a medias y se abriera más tarde.
  const reading = members.filter(r => r.status === 'reading' || ((r.progress || 0) > 0 && (r.progress || 0) < 100));
  const nowGuess = reading.sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0))[0];
  const state = {
    name: Shelves.segments(shelf.name).pop(),
    showProgress: true,
    nowId: nowGuess ? nowGuess.id : '',
    rows: members.map(rec => ({ rec, on: true, style: 'plain' })),
  };

  const overlay = document.createElement('div');
  overlay.className = 'dlg-overlay';
  overlay.innerHTML = `
    <div class="dlg-card dlg-card--form pub-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(t('Publicar estantería'))}">
      <h2 class="dlg-title">${escapeHtml(t('Publicar estantería'))}</h2>
      <div class="dlg-msg">${escapeHtml(t('Solo se publican el título, el autor, el estado y la portada de cada libro. Los libros, tus subrayados y tus notas no salen del dispositivo.'))}</div>
      <div class="dlg-form">
        <div class="dlg-field"><label class="dlg-field-lbl" for="pub-name">${escapeHtml(t('Nombre público'))}</label>
          <input class="dlg-input" id="pub-name" type="text" value="${escapeHtml(state.name)}"></div>
        <label class="dlg-check"><input type="checkbox" id="pub-progress" checked><span>${escapeHtml(t('Enseñar el progreso de lectura'))}</span></label>
        <div class="dlg-field"><span class="dlg-field-lbl">${escapeHtml(t('Libros'))}</span><ol class="pub-list" id="pub-list"></ol></div>
      </div>
      <div class="dlg-actions">
        <button class="dlg-btn dlg-cancel" data-act="cancel">${escapeHtml(t('Cancelar'))}</button>
        <button class="dlg-btn" data-act="preview">${escapeHtml(t('Vista previa'))}</button>
        <button class="btn btn--primary dlg-btn dlg-ok" data-act="download">${escapeHtml(t('Descargar'))}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const card = overlay.querySelector('.pub-card');
  const list = card.querySelector('#pub-list');

  const renderList = () => {
    list.innerHTML = state.rows.map((row, i) => {
      const r = row.rec;
      return `<li class="pub-row${row.on ? '' : ' is-off'}" data-i="${i}">
        <input type="checkbox" data-k="on" ${row.on ? 'checked' : ''} aria-label="${escapeHtml(t('Publicar {title}', { title: r.title || '' }))}">
        <span class="pub-cover" style="${r.cover ? `background-image:url('${escapeHtml(r.cover)}')` : ''}" aria-hidden="true"></span>
        <span class="pub-meta"><b>${escapeHtml(r.title || '')}</b><small>${escapeHtml(r.author || '')}</small>
          <label class="pub-now"><input type="radio" name="pub-now" data-k="now" ${state.nowId === r.id ? 'checked' : ''}>${escapeHtml(t('Leyendo ahora'))}</label></span>
        <select class="dlg-input pub-style" data-k="style" aria-label="${escapeHtml(t('Lomo'))}">
          <option value="plain" ${row.style === 'plain' ? 'selected' : ''}>${escapeHtml(t('Lomo: color de la portada'))}</option>
          <option value="oreilly" ${row.style === 'oreilly' ? 'selected' : ''}>${escapeHtml(t('Lomo: O’Reilly'))}</option>
        </select>
        <span class="pub-move">
          <button type="button" class="dlg-btn" data-k="up" ${i === 0 ? 'disabled' : ''} aria-label="${escapeHtml(t('Subir'))}">↑</button>
          <button type="button" class="dlg-btn" data-k="down" ${i === state.rows.length - 1 ? 'disabled' : ''} aria-label="${escapeHtml(t('Bajar'))}">↓</button>
        </span></li>`;
    }).join('');
  };
  renderList();

  list.addEventListener('change', (e) => {
    const li = e.target.closest('.pub-row'); if (!li) return;
    const row = state.rows[+li.dataset.i];
    const k = e.target.dataset.k;
    if (k === 'on') { row.on = e.target.checked; li.classList.toggle('is-off', !row.on); }
    if (k === 'now') state.nowId = row.rec.id;
    if (k === 'style') row.style = e.target.value;
  });
  list.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-k]'); if (!b) return;
    const i = +b.closest('.pub-row').dataset.i;
    const j = b.dataset.k === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= state.rows.length) return;
    [state.rows[i], state.rows[j]] = [state.rows[j], state.rows[i]];
    renderList();
    list.querySelector(`.pub-row[data-i="${j}"] button[data-k="${b.dataset.k}"]`)?.focus();
  });

  const close = () => { document.removeEventListener('keydown', onKey, true); overlay.remove(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });

  const build = async () => {
    const rows = state.rows.filter(r => r.on);
    if (!rows.length) { await alertBox(t('Elige al menos un libro.'), { title: t('Publicar estantería') }); return null; }
    return snapshot({
      shelfName: card.querySelector('#pub-name').value.trim() || state.name,
      rows: state.rows, nowId: state.nowId,
      showProgress: card.querySelector('#pub-progress').checked,
    });
  };

  card.querySelector('.dlg-actions').addEventListener('click', async (e) => {
    const act = e.target.closest('button[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'cancel') { close(); return; }
    // La pestaña se abre YA, en el gesto del usuario: si se abre después del await, el navegador
    // la trata como ventana emergente y la bloquea.
    const tab = act === 'preview' ? window.open('', '_blank') : null;
    e.target.disabled = true;
    try {
      const snap = await build();
      if (!snap) { tab?.close(); return; }
      if (act === 'preview') {
        try { localStorage.setItem(DRAFT_KEY, JSON.stringify(snap)); }
        catch { tab?.close(); await alertBox(t('No cabe en el almacenamiento del navegador. Quita algún libro y vuelve a probar.')); return; }
        const url = new URL('../@luis/?draft=1', location.href).href;
        if (tab) tab.location.href = url; else window.open(url, '_blank');
      } else {
        download(`perfil-${slug(snap.shelf)}.json`, JSON.stringify(snap, null, 2));
      }
    } finally { e.target.disabled = false; }
  });

  card.querySelector('#pub-name').focus();
}
