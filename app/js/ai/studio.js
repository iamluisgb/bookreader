// ai/studio.js — "Studio": galería per-libro de los artefactos generados por el agente
// (resumen, mapa mental) + invitación a los tipos aún sin generar, al estilo del panel Studio
// de NotebookLM. Da una casa VISIBLE y navegable a lo que antes solo se lanzaba desde iconos
// sueltos: se ve TODO el historial, se abre cualquiera, se genera uno nuevo o se borra.
//
// HISTORIAL: cada generación es un artefacto propio (clave `${bookId}:${kind}:${id}`); se
// conservan todos hasta que el usuario los borra. Reusa el job runner (jobs.js) para el estado
// en vivo y la persistencia en IndexedDB; no añade modelo de datos.
//
// El panel monta el Studio con `mount(container, { open, getContext })`:
//   open(kind, opts?) → reabre el modal del artefacto. opts.mode='setup' fuerza el setup
//                       (generar uno NUEVO); opts.artifact abre un artefacto CONCRETO del historial.
//   getContext()      → { bookId, bookTitle, segReady }  (el libro abierto ahora mismo).

import { t } from '../i18n.js';
import * as Jobs from './jobs.js';
import { icon } from '../ui/icons.js';
import { escapeHtml } from '../ui/escape.js';
import { confirmBox } from '../ui/dialog.js';

// Tipos de artefacto. `stateful` = participa del historial de jobs (resumen/mapa). Flashcards no
// es un artefacto persistido: es una acción (genera un mazo Anki), así que va como invitación.
const TYPES = [
  { kind: 'summary',    ico: 'note',    name: t('Resumen'),      value: t('TL;DR e ideas clave por capítulo, cada una con su cita al pasaje.'), stateful: true },
  { kind: 'mindmap',    ico: 'columns', name: t('Mapa mental'),  value: t('Mapa radial navegable de los conceptos del libro.'),              stateful: true },
  { kind: 'flashcards', ico: 'cards',   name: t('Flashcards'),   value: t('Tarjetas de repaso espaciado para exportar a Anki.'),              stateful: false },
];

let container = null;
let openFn = () => {};
let getCtx = () => ({ bookId: null, bookTitle: '', segReady: false });

export function mount(el, { open, getContext }) {
  container = el;
  openFn = open || openFn;
  getCtx = getContext || getCtx;
  container.addEventListener('click', onClick);
  // Repinta en vivo cuando cambia un job (progreso, fin, error) SI el Studio está visible.
  Jobs.subscribe(() => { if (isVisible()) render(); });
}

function isVisible() {
  return !!container && container.classList.contains('active');
}

function ago(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return t('hace un momento');
  if (s < 3600) return t('hace {n} min', { n: Math.round(s / 60) });
  if (s < 86400) return t('hace {n} h', { n: Math.round(s / 3600) });
  const d = Math.round(s / 86400);
  return d === 1 ? t('hace {n} día', { n: d }) : t('hace {n} días', { n: d });
}

// Metadatos de un artefacto: ámbito + (citas, solo resumen) + antigüedad. Distingue los del
// historial entre sí.
function metaLine(kind, e) {
  const bits = [];
  if (e.params && e.params.scopeName) bits.push(escapeHtml(e.params.scopeName));
  if (kind === 'summary') {
    const cites = (String(e.result || '').match(/\[\[a\d+\]\]/g) || []).length;
    if (cites) bits.push(`${cites} citas`);
  }
  const when = ago(e.at);
  if (when) bits.push(when);
  return bits.join(' · ') || 'Generado';
}

function runningCard(job) {
  const p = job.progress || {};
  const pct = p.n ? Math.round((p.i / p.n) * 100) : 0;
  return `<div class="studio-card studio-running">
    <div class="studio-progress"><div class="studio-bar" style="width:${pct}%"></div></div>
    <p class="studio-meta">${escapeHtml(p.phase || 'Generando…')} <button class="studio-link" data-act="cancel">Cancelar</button></p>
  </div>`;
}

function errorCard(t) {
  return `<div class="studio-card studio-error">
    <p class="studio-meta studio-errmsg">⚠ No se pudo generar. <button class="studio-link" data-act="retry">Reintentar</button></p>
  </div>`;
}

function artifactCard(t, e) {
  return `<div class="studio-card studio-generated">
    <button class="studio-card-main" data-act="open" data-kind="${t.kind}" data-key="${escapeHtml(e.key)}">
      <span class="studio-meta">${metaLine(t.kind, e)}</span>
    </button>
    <button class="studio-del" data-act="del" data-key="${escapeHtml(e.key)}" title="Borrar" aria-label="Borrar este artefacto">${icon('trash', { size: 15 })}</button>
  </div>`;
}

function emptyCard(t) {
  return `<div class="studio-card studio-empty">
    <p class="studio-value">${escapeHtml(t.value)}</p>
    <button class="studio-gen" data-act="gen" data-kind="${t.kind}">${icon('plus', { size: 15 })} ${t.stateful ? 'Generar' : 'Crear'}</button>
  </div>`;
}

function group(t, ctx, job) {
  const mine = job && job.kind === t.kind && job.bookId === ctx.bookId;
  const running = mine && job.status === 'running';
  const errored = mine && job.status === 'error';
  const items = t.stateful ? Jobs.list(ctx.bookId, t.kind) : [];

  const head = `<div class="studio-group-head">
    <span class="studio-ico">${icon(t.ico, { size: 16 })}</span>
    <span class="studio-group-name">${escapeHtml(t.name)}</span>
    ${t.stateful && (items.length || running) ? `<button class="studio-new" data-act="gen" data-kind="${t.kind}">${icon('plus', { size: 13 })} Nuevo</button>` : ''}
  </div>`;

  let bodyHtml = '';
  if (running) bodyHtml += runningCard(job);
  else if (errored) bodyHtml += errorCard(t);
  if (items.length) bodyHtml += items.map(e => artifactCard(t, e)).join('');
  else if (!running && !errored) bodyHtml += emptyCard(t);

  return `<div class="studio-group">${head}${bodyHtml}</div>`;
}

export function render() {
  if (!container) return;
  const ctx = getCtx();
  if (!ctx.bookId && !ctx.bookTitle) {
    container.innerHTML = `<p class="studio-hint">Abre un libro para generar y ver sus artefactos.</p>`;
    return;
  }
  const job = Jobs.activeJob();
  container.innerHTML =
    `<div class="studio-book">${escapeHtml(ctx.bookTitle || 'Libro')}</div>` +
    (ctx.segReady ? '' : `<p class="studio-hint">${t('Preparando el libro… la generación estará lista en unos segundos.')}</p>`) +
    TYPES.map(t => group(t, ctx, job)).join('');
}

async function onClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const kind = btn.dataset.kind;
  const key = btn.dataset.key;
  const ctx = getCtx();

  if (act === 'open') {
    const entry = Jobs.list(ctx.bookId, kind).find(x => x.key === key);
    openFn(kind, entry ? { artifact: entry } : {});
    return;
  }
  if (act === 'gen') { openFn(kind, { mode: 'setup' }); return; }
  if (act === 'cancel') { Jobs.cancel(); render(); return; }
  if (act === 'retry') { const j = Jobs.activeJob(); if (j) Jobs.retry(j); return; }
  if (act === 'del') {
    const yes = await confirmBox(
      'Se borrará este artefacto. Los demás se conservan y podrás generar nuevos cuando quieras.',
      { title: 'Borrar artefacto', okText: 'Borrar', cancelText: 'Cancelar', danger: true }
    );
    if (yes) { Jobs.remove(key); render(); }
    return;
  }
}
