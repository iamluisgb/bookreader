// ai/studio.js — "Studio": galería per-libro de los artefactos generados por el agente
// (resumen, mapa mental) + invitación a los aún no generados, al estilo del panel Studio de
// NotebookLM. Da una casa VISIBLE y navegable a lo que antes solo se lanzaba desde iconos
// sueltos: se ve qué hay generado, se abre, se regenera o se borra. Reusa el job runner
// (jobs.js) para el estado en vivo y la persistencia en IndexedDB; no añade modelo de datos.
//
// El panel monta el Studio con `mount(container, { open, getContext })`:
//   open(kind, opts?) → reabre el modal del artefacto (routea a resultado o setup; opts.mode
//                       = 'setup' fuerza el setup para "Regenerar").
//   getContext()      → { bookId, bookTitle, segReady }  (el libro abierto ahora mismo).

import * as Jobs from './jobs.js';
import { icon } from '../ui/icons.js';
import { escapeHtml } from '../ui/escape.js';
import { confirmBox } from '../ui/dialog.js';

// Tipos de artefacto. `stateful` = participa del cache de jobs (resumen/mapa). Flashcards no
// es un artefacto persistido: es una acción (genera un mazo Anki), así que va como invitación.
const TYPES = [
  { kind: 'summary',    ico: 'note',    name: 'Resumen',      value: 'TL;DR e ideas clave por capítulo, cada una con su cita al pasaje.', stateful: true },
  { kind: 'mindmap',    ico: 'columns', name: 'Mapa mental',  value: 'Mapa radial navegable de los conceptos del libro.',              stateful: true },
  { kind: 'flashcards', ico: 'cards',   name: 'Flashcards',   value: 'Tarjetas de repaso espaciado para exportar a Anki.',              stateful: false },
];

let container = null;
let openFn = () => {};
let getCtx = () => ({ bookId: null, bookTitle: '', segReady: false });
let openKebab = null;   // kind cuyo menú kebab está abierto (uno a la vez)

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
  if (s < 60) return 'hace un momento';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86400);
  return `hace ${d} ${d === 1 ? 'día' : 'días'}`;
}

// Metadatos de una tarjeta generada: ámbito + (citas, solo resumen) + antigüedad.
function metaLine(kind, c) {
  const bits = [];
  if (c.params && c.params.scopeName) bits.push(`Ámbito: ${c.params.scopeName}`);
  if (kind === 'summary') {
    const cites = (String(c.result || '').match(/\[\[a\d+\]\]/g) || []).length;
    if (cites) bits.push(`${cites} citas`);
  }
  const when = ago(c.at);
  if (when) bits.push(when);
  return bits.join(' · ');
}

function kebab(kind) {
  const open = openKebab === kind;
  return `<div class="studio-kebab-wrap">
    <button class="studio-kebab" data-act="kebab" data-kind="${kind}" title="Más acciones" aria-label="Más acciones" aria-expanded="${open}">${icon('ellipsis', { size: 16 })}</button>
    <div class="studio-menu${open ? ' open' : ''}">
      <button data-act="regen" data-kind="${kind}">${icon('sparkles', { size: 14 })} Regenerar…</button>
      <button class="studio-menu-del" data-act="del" data-kind="${kind}">${icon('trash', { size: 14 })} Borrar</button>
    </div>
  </div>`;
}

function card(t) {
  const ctx = getCtx();
  const head = (extra = '') => `<div class="studio-card-head">
    <span class="studio-ico">${icon(t.ico, { size: 18 })}</span>
    <span class="studio-name">${escapeHtml(t.name)}</span>
    ${extra}
  </div>`;

  // Job en curso / con error para ESTE tipo y libro (el runner es de uno-a-la-vez).
  const job = Jobs.activeJob();
  const mine = job && job.kind === t.kind && job.bookId === ctx.bookId;
  if (mine && job.status === 'running') {
    const p = job.progress || {};
    const pct = p.n ? Math.round((p.i / p.n) * 100) : 0;
    return `<div class="studio-card studio-running">${head()}
      <div class="studio-progress"><div class="studio-bar" style="width:${pct}%"></div></div>
      <p class="studio-meta">${escapeHtml(p.phase || 'Generando…')} <button class="studio-link" data-act="cancel" data-kind="${t.kind}">Cancelar</button></p>
    </div>`;
  }
  if (mine && job.status === 'error') {
    return `<div class="studio-card studio-error">${head()}
      <p class="studio-meta studio-errmsg">⚠ No se pudo generar. <button class="studio-link" data-act="retry" data-kind="${t.kind}">Reintentar</button></p>
    </div>`;
  }

  // Artefacto persistido ya generado.
  const c = t.stateful ? Jobs.cached(ctx.bookId, t.kind) : null;
  if (c) {
    return `<div class="studio-card studio-generated">${head(kebab(t.kind))}
      <p class="studio-meta">${escapeHtml(metaLine(t.kind, c))}</p>
      <div class="studio-actions"><button class="primary-btn studio-open" data-act="open" data-kind="${t.kind}">Abrir</button></div>
    </div>`;
  }

  // Vacío: invitación a generarlo.
  return `<div class="studio-card studio-empty">${head()}
    <p class="studio-value">${escapeHtml(t.value)}</p>
    <div class="studio-actions"><button class="studio-gen" data-act="gen" data-kind="${t.kind}">${icon('plus', { size: 15 })} ${t.stateful ? 'Generar' : 'Crear'}</button></div>
  </div>`;
}

export function render() {
  if (!container) return;
  const ctx = getCtx();
  if (!ctx.bookId && !ctx.bookTitle) {
    container.innerHTML = `<p class="studio-hint">Abre un libro para generar y ver sus artefactos.</p>`;
    return;
  }
  // "En curso/con error" solo cuenta un job vivo (running/error) de este libro; un job 'done'
  // ya vive como artefacto cacheado, así que no se duplica.
  const job = Jobs.activeJob();
  const busyKind = job && job.bookId === ctx.bookId && (job.status === 'running' || job.status === 'error') ? job.kind : null;
  const inBook = TYPES.filter(t => t.kind === busyKind || (t.stateful && Jobs.cached(ctx.bookId, t.kind)));
  const available = TYPES.filter(t => !inBook.includes(t));
  const section = (title, list) => list.length
    ? `<div class="studio-section-label">${title}</div>${list.map(card).join('')}`
    : '';
  container.innerHTML =
    `<div class="studio-book">${escapeHtml(ctx.bookTitle || 'Libro')}</div>` +
    (ctx.segReady ? '' : `<p class="studio-hint">Preparando el libro… la generación estará lista en unos segundos.</p>`) +
    section('En este libro', inBook) +
    section('Disponibles', available);
}

async function onClick(e) {
  const btn = e.target.closest('[data-act]');
  // Clic fuera de un kebab abierto → ciérralo.
  if (openKebab && !e.target.closest('.studio-kebab-wrap')) { openKebab = null; render(); }
  if (!btn) return;
  const kind = btn.dataset.kind;
  const act = btn.dataset.act;
  if (act === 'kebab') { openKebab = openKebab === kind ? null : kind; render(); return; }
  openKebab = null;

  if (act === 'open') { openFn(kind); return; }
  if (act === 'gen') { openFn(kind); return; }
  if (act === 'cancel') { Jobs.cancel(); render(); return; }
  if (act === 'retry') { const j = Jobs.activeJob(); if (j) Jobs.retry(j); return; }
  if (act === 'regen') {
    const t = TYPES.find(x => x.kind === kind);
    const yes = await confirmBox(
      `Se generará de nuevo ${t ? t.name.toLowerCase() : 'el artefacto'} y sustituirá al actual. Podrás elegir el ámbito y la profundidad.`,
      { title: 'Regenerar', okText: 'Regenerar', cancelText: 'Cancelar' }
    );
    if (yes) openFn(kind, { mode: 'setup' });
    return;
  }
  if (act === 'del') {
    const ctx = getCtx();
    const t = TYPES.find(x => x.kind === kind);
    const yes = await confirmBox(
      `Se borrará ${t ? t.name.toLowerCase() : 'el artefacto'} de este libro. Podrás volver a generarlo cuando quieras.`,
      { title: 'Borrar artefacto', okText: 'Borrar', cancelText: 'Cancelar', danger: true }
    );
    if (yes) { Jobs.remove(ctx.bookId, kind); render(); }
    return;
  }
}
