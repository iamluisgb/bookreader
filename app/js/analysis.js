// analysis.js — la sección de Análisis (P25 F2): qué se ha leído esta semana o este mes.
//
// Todo lo que enseña sale de datos que YA existen: el registro de lectura
// (`reading-log.js`, P25 F1), los subrayados (localStorage, con `timestamp`), las notas de
// la libreta (IndexedDB, con `ts`) y la racha de estudio (`ai/srs.js`). Aquí no se mide
// nada nuevo: se junta y se cuenta.
//
// UNA SOLA CIFRA DE TIEMPO, y es la validada. La tentación es enseñar al lado el "tiempo
// con el libro abierto", que siempre es mayor y siempre es más halagador; puesto al lado,
// el usuario se queda con el grande y la sección deja de significar nada. Por eso el rato
// que el libro estuvo abierto sin leerse no aparece: ni como dato, ni como nota al pie.
//
// El desglose se ordena por TIEMPO y no por páginas: un libro técnico de 40 páginas puede
// haber costado más que una novela de 200, y lo que la pantalla responde es "en qué se te
// fue la semana".
import * as ReadingLog from './reading-log.js';
import * as Store from './library/store.js';
import * as Storage from './storage.js';
import * as AiDB from './ai/db.js';
import * as Srs from './ai/srs.js';
import { icon } from './ui/icons.js';
import { escapeHtml } from './ui/escape.js';
import { t } from './i18n.js';
import { loadAgentCss } from './css-loader.js';

const DAY_MS = 86400000;
const RANGES = [
  { id: 'week', days: 7, label: () => t('Semana') },
  { id: 'month', days: 30, label: () => t('Mes') },
];

let overlay = null;
let range = 'week';

// ---- Datos -----------------------------------------------------------------

// Todo lo del rango, en una sola pasada. `now` inyectable para los tests.
export async function collect(days, now = Date.now()) {
  // Inicio del PRIMER día del rango (medianoche local), no "hace 7×24 h": los
  // subrayados y las notas se cuentan por día natural, igual que la lectura.
  const first = ReadingLog.dayKey(now - (days - 1) * DAY_MS).split('-').map(Number);
  const from = new Date(first[0], first[1] - 1, first[2]).getTime();

  const [read, books, notes] = await Promise.all([
    ReadingLog.summary(days, now),
    Store.getAllBooks().catch(() => []),
    AiDB.getAll('notes').catch(() => []),
  ]);

  const meta = new Map(books.map(b => [b.id, b]));
  const byBook = Object.entries(read.books)
    .map(([id, v]) => ({
      id,
      title: meta.get(id)?.title || t('Libro sin título'),
      author: meta.get(id)?.author || '',
      cover: meta.get(id)?.cover || '',
      ms: v.ms, words: v.words, units: v.units,
    }))
    .sort((a, b) => b.ms - a.ms);

  // Serie diaria COMPLETA, con los días a cero incluidos: una semana con dos días de
  // lectura son cinco huecos, y verlos es parte de la respuesta.
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = ReadingLog.dayKey(now - i * DAY_MS);
    series.push({ day, ms: read.byDay[day]?.ms || 0, units: read.byDay[day]?.units || 0 });
  }

  return {
    days,
    ms: read.ms,
    words: read.words,
    units: read.units,
    activeDays: series.filter(d => d.ms > 0).length,
    books: byBook,
    series,
    highlights: countHighlights(from),
    notes: (notes || []).filter(n => !n.deleted && (n.ts || 0) >= from).length,
    streak: Srs.currentStreak(Storage.get('study_streak'), now),
  };
}

// Los subrayados viven en localStorage, una clave por libro (`highlights_<bookId>`), así
// que se cuentan barriendo el prefijo. Los tombstones no cuentan: un subrayado borrado no
// es trabajo hecho esta semana.
function countHighlights(from) {
  let n = 0;
  const all = Storage.getAll('highlights_');
  for (const list of Object.values(all)) {
    if (!Array.isArray(list)) continue;
    for (const h of list) if (h && !h.deleted && (h.timestamp || 0) >= from) n++;
  }
  return n;
}

// ---- Formato ---------------------------------------------------------------

export function humanTime(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return t('{n} min', { n: min });
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? t('{h} h {m} min', { h, m }) : t('{h} h', { h });
}

function dayLabel(day, days) {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  // En una semana caben las iniciales del día; en un mes, solo el número, y aun así
  // uno de cada cinco (ver renderChart).
  return days <= 7
    ? date.toLocaleDateString(undefined, { weekday: 'narrow' })
    : String(d);
}

// ---- Pintado ---------------------------------------------------------------

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'analysis';
  overlay.className = 'appset';
  overlay.style.display = 'none';
  overlay.innerHTML = `
    <div class="appset-card anal-card" role="dialog" aria-modal="true" aria-label="${t('Análisis')}">
      <button class="appset-close" title="${t('Cerrar')}" aria-label="${t('Cerrar')}">${icon('xmark')}</button>
      <h2 class="appset-h2">${icon('chart', { size: 20 })} ${t('Análisis')}</h2>
      <div class="anal-body"></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.appset-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.style.display !== 'none') close();
  });
  overlay.addEventListener('click', (e) => {
    const b = e.target.closest('[data-range]');
    if (b) { range = b.dataset.range; paint(); }
  });
  return overlay;
}

export async function open() {
  loadAgentCss().catch(e => console.warn('agent.css:', e));
  ensureOverlay().style.display = 'flex';
  await paint();
}

export function close() {
  if (overlay) overlay.style.display = 'none';
}

export function isOpen() {
  return !!overlay && overlay.style.display !== 'none';
}

async function paint() {
  const body = overlay.querySelector('.anal-body');
  const days = RANGES.find(r => r.id === range).days;
  body.innerHTML = `<p class="anal-loading">${t('Contando…')}</p>`;
  const data = await collect(days);
  if (!isOpen()) return;
  body.innerHTML = renderTabs() + (data.ms ? renderData(data) : renderEmpty());
}

function renderTabs() {
  return `<div class="anal-tabs" role="tablist">
    ${RANGES.map(r => `<button class="anal-tab${r.id === range ? ' active' : ''}"
      role="tab" aria-selected="${r.id === range}" data-range="${r.id}">${r.label()}</button>`).join('')}
  </div>`;
}

// Sin un minuto validado no se pinta un cero con gráfica al lado: se explica qué se cuenta.
// Es la primera vez que alguien ve la sección y la pregunta que trae es justo esa.
function renderEmpty() {
  return `<div class="anal-empty">
    ${icon('chart', { size: 32 })}
    <p class="anal-empty-h">${t('Todavía no hay lectura que contar en este periodo')}</p>
    <p class="anal-empty-p">${t('Solo cuenta lo que se leyó a ritmo humano: pasar páginas buscando algo, o dejar el libro abierto, no suma.')}</p>
  </div>`;
}

function renderData(d) {
  return `
    <div class="anal-hero">
      <div class="anal-hero-n">${escapeHtml(humanTime(d.ms))}</div>
      <div class="anal-hero-l">${t('leyendo · {n} de {total} días', { n: d.activeDays, total: d.days })}</div>
    </div>
    <div class="anal-tiles">
      ${tile(t('Páginas'), String(d.units))}
      ${tile(t('Palabras'), compact(d.words))}
      ${tile(t('Subrayados'), String(d.highlights))}
      ${tile(t('Notas'), String(d.notes))}
      ${d.streak ? tile(t('Racha'), t('{n} d', { n: d.streak })) : ''}
    </div>
    ${renderChart(d)}
    ${renderBooks(d)}
    <p class="anal-note">${t('Solo cuenta lo que se leyó a ritmo humano: pasar páginas buscando algo, o dejar el libro abierto, no suma.')}</p>
  `;
}

function tile(label, value) {
  return `<div class="anal-tile"><div class="anal-tile-l">${escapeHtml(label)}</div>
    <div class="anal-tile-v">${escapeHtml(value)}</div></div>`;
}

function compact(n) {
  if (n < 1000) return String(n);
  if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1000000).toFixed(1)}M`;
}

// Columnas por día, una sola serie (por eso no hay leyenda: el título ya dice qué es). La
// altura es proporcional al MÁXIMO del periodo, no a un tope fijo: lo que se compara aquí
// son los días entre sí. Solo lleva etiqueta el día más alto — un número sobre cada
// columna es ruido que nadie lee, y el resto lo da el tooltip.
function renderChart(d) {
  const max = Math.max(...d.series.map(s => s.ms));
  const every = d.days <= 7 ? 1 : 5;
  const cols = d.series.map((s, i) => {
    // Un día sin lectura se queda VACÍO: un muñón de 2px al pie dice "poco" donde la
    // verdad es "nada", y los huecos son parte de lo que se viene a mirar.
    const pct = s.ms ? Math.max(4, Math.round((s.ms / max) * 100)) : 0;
    const label = (i % every === 0 || i === d.series.length - 1) ? dayLabel(s.day, d.days) : '';
    const top = s.ms === max && s.ms > 0 ? `<span class="anal-col-top">${escapeHtml(humanTime(s.ms))}</span>` : '';
    return `<div class="anal-col" title="${escapeHtml(s.day)} · ${escapeHtml(humanTime(s.ms))}"
        tabindex="0" aria-label="${escapeHtml(s.day)}: ${escapeHtml(humanTime(s.ms))}">
      ${top}
      <div class="anal-col-track">${pct ? `<div class="anal-col-fill" style="height:${pct}%"></div>` : ''}</div>
      <span class="anal-col-x">${escapeHtml(label)}</span>
    </div>`;
  }).join('');
  return `<div class="anal-chart" role="img" aria-label="${t('Tiempo leído por día')}">
    <div class="anal-chart-h">${t('Tiempo leído por día')}</div>
    <div class="anal-cols">${cols}</div>
  </div>`;
}

function renderBooks(d) {
  if (!d.books.length) return '';
  const rows = d.books.map(b => `
    <div class="anal-book">
      ${b.cover
        ? `<img class="anal-book-cover" src="${escapeHtml(b.cover)}" alt="">`
        : `<span class="anal-book-cover anal-book-cover--none">${icon('book', { size: 14 })}</span>`}
      <div class="anal-book-txt">
        <div class="anal-book-t">${escapeHtml(b.title)}</div>
        <div class="anal-book-s">${escapeHtml(t('{n} pág.', { n: b.units }))}</div>
      </div>
      <div class="anal-book-ms">${escapeHtml(humanTime(b.ms))}</div>
    </div>`).join('');
  return `<div class="anal-books"><div class="anal-chart-h">${t('Por libro')}</div>${rows}</div>`;
}
