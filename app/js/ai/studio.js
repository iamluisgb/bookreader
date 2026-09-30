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
import * as DB from './db.js';
import { deckSummary } from './deck-manager.js';
import { open as openStudy, openToday as openStudyToday } from './study.js';
import { icon } from '../ui/icons.js';
import { escapeHtml } from '../ui/escape.js';
import { confirmBox } from '../ui/dialog.js';
import { ago } from '../ui/when.js';

// Tipos de artefacto. `stateful` = participa del historial de jobs (resumen/mapa). Flashcards
// no es un artefacto persistido, pero SÍ tiene estado propio: los mazos del libro viven en el
// store `decks` de IndexedDB (db.js), así que su tile lista esos mazos (ver group/decksBody).
const TYPES = [
  { kind: 'summary',    ico: 'note',    name: t('Resumen'),      value: t('TL;DR e ideas clave por capítulo, cada una con su cita al pasaje.'), stateful: true },
  { kind: 'mindmap',    ico: 'columns', name: t('Mapa mental'),  value: t('Mapa por ramas navegable de los conceptos del libro.'),              stateful: true },
  { kind: 'infographic', ico: 'poster', name: t('Infografía'),   value: t('Un póster del libro —tesis, ideas clave y cita— listo para descargar.'), stateful: true },
  { kind: 'flashcards', ico: 'cards',   name: t('Flashcards'),   value: t('Tarjetas de repaso espaciado para exportar a Anki.'),              stateful: false },
  // P18 · El único que NO produce un artefacto: lo produces tú. Va aquí igualmente porque
  // es donde el lector busca "qué puedo hacer con este libro".
  { kind: 'feynman',    ico: 'bubble',  name: t('Explícamelo tú'), value: t('Explicas un concepto con tus palabras y el libro te pregunta hasta que lo construyes.'), stateful: false },
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

// Metadatos de un artefacto: ámbito + (citas, solo resumen) + antigüedad. Distingue los del
// historial entre sí.
function metaLine(kind, e) {
  const bits = [];
  if (e.params && e.params.scopeName) bits.push(escapeHtml(e.params.scopeName));
  if (kind === 'summary') {
    const cites = (String(e.result || '').match(/\[\[a\d+\]\]/g) || []).length;
    if (cites) bits.push(t('{n} citas', { n: cites }));
  }
  const when = ago(e.at);
  if (when) bits.push(when);
  return bits.join(' · ') || t('Generado');
}

function runningCard(job) {
  const p = job.progress || {};
  const pct = p.n ? Math.round((p.i / p.n) * 100) : 0;
  return `<div class="studio-card studio-running">
    <div class="studio-progress"><div class="studio-bar" style="width:${pct}%"></div></div>
    <p class="studio-meta">${escapeHtml(p.phase || t('Generando…'))} <button class="studio-link" data-act="cancel">${t('Cancelar')}</button></p>
  </div>`;
}

function errorCard() {
  return `<div class="studio-card studio-error">
    <p class="studio-meta studio-errmsg">⚠ ${t('No se pudo generar.')} <button class="studio-link" data-act="retry">${t('Reintentar')}</button></p>
  </div>`;
}

function artifactCard(ty, e) {
  return `<div class="studio-card studio-generated">
    <button class="studio-card-main" data-act="open" data-kind="${ty.kind}" data-key="${escapeHtml(e.key)}">
      <span class="studio-meta">${metaLine(ty.kind, e)}</span>
    </button>
    <button class="studio-del" data-act="del" data-key="${escapeHtml(e.key)}" title="${t('Borrar')}" aria-label="${t('Borrar este artefacto')}">${icon('trash', { size: 15 })}</button>
  </div>`;
}

function emptyCard(ty) {
  return `<div class="studio-card studio-empty">
    <p class="studio-value">${escapeHtml(ty.value)}</p>
    <button class="studio-gen" data-act="gen" data-kind="${ty.kind}">${icon('plus', { size: 15 })} ${ty.stateful ? t('Generar') : t('Crear')}</button>
  </div>`;
}

function deckRow(d) {
  const s = deckSummary(d);
  const label = d.scope || d.name || t('Mazo');
  const meta = t(s.total === 1 ? '{n} tarjeta · {m} para hoy' : '{n} tarjetas · {m} para hoy', { n: s.total, m: s.due });
  return `<div class="studio-card studio-generated">
    <button class="studio-card-main" data-act="study" data-deck="${escapeHtml(String(d.id))}" title="${t('Estudiar')}">
      <span class="studio-deck-name">${escapeHtml(label)}</span>
      <span class="studio-meta">${meta}</span>
      <span class="studio-deck-go">${icon('cards', { size: 13 })} ${t('Estudiar')}</span>
    </button>
    <button class="studio-del" data-act="del-deck" data-deck="${escapeHtml(String(d.id))}" title="${t('Borrar')}" aria-label="${t('Borrar este mazo')}">${icon('trash', { size: 15 })}</button>
  </div>`;
}

// Cuerpo del grupo Flashcards cuando el libro YA tiene mazos: línea resumen, una fila por
// mazo (clic = estudiar, papelera = borrar) y acceso al gestor de mazos. Mismo lenguaje
// visual que las filas de artefactos (.studio-card.studio-generated).
function decksBody(decks) {
  let cards = 0, due = 0;
  for (const d of decks) { const s = deckSummary(d); cards += s.total; due += s.due; }
  const summary = `<p class="studio-meta studio-deck-summary">${t('Mazos: {n} · Tarjetas: {c} · Para hoy: {d}', { n: decks.length, c: cards, d: due })}</p>`;
  // Acción primaria del tile con algo vencido hoy: repasa TODO el libro de una vez.
  // Mismo mecanismo que la biblioteca (Study.openToday con scope de libro): alias-aware,
  // tope de nuevas y gate Pro incluidos. Sin vencidas no se ofrece: no hay sesión vacía.
  const studyAll = due
    ? `<button class="studio-gen studio-all" data-act="study-book">${icon('cards', { size: 15 })} ${t('Estudiar todo · {n}', { n: due })}</button>`
    : '';
  const manage = `<button class="studio-manage" data-act="manage">${t('Gestionar mazos')}</button>`;
  return summary + studyAll + decks.map(deckRow).join('') + manage;
}

function group(ty, ctx, job, decks) {
  const mine = job && job.kind === ty.kind && job.bookId === ctx.bookId;
  const running = mine && job.status === 'running';
  const errored = mine && job.status === 'error';
  const items = ty.stateful ? Jobs.list(ctx.bookId, ty.kind) : [];
  const mineDecks = ty.kind === 'flashcards' ? (decks || []) : [];

  const head = `<div class="studio-group-head">
    <span class="studio-ico">${icon(ty.ico, { size: 16 })}</span>
    <span class="studio-group-name">${escapeHtml(ty.name)}</span>
    ${(ty.stateful && (items.length || running)) || mineDecks.length ? `<button class="studio-new" data-act="gen" data-kind="${ty.kind}">${icon('plus', { size: 13 })} ${t('Nuevo')}</button>` : ''}
  </div>`;

  let bodyHtml = '';
  if (mineDecks.length) bodyHtml = decksBody(mineDecks);
  else {
    if (running) bodyHtml += runningCard(job);
    else if (errored) bodyHtml += errorCard();
    if (items.length) bodyHtml += items.map(e => artifactCard(ty, e)).join('');
    else if (!running && !errored) bodyHtml += emptyCard(ty);
  }

  // UI3 · Mosaico: cada tipo es una baldosa; con historial (o mazos) ocupa el ancho entero.
  const wide = items.length || running || errored || mineDecks.length;
  return `<div class="studio-group${wide ? ' studio-group--wide' : ''}" data-kind="${ty.kind}">${head}${bodyHtml}</div>`;
}

// Los mazos viven en IndexedDB (store `decks`), no en el historial de jobs: cada render los
// carga y pinta al llegar. Los callers llaman render() sin await (showView, Jobs.subscribe,
// los handlers); el contador `renderSeq` descarta la repintada si un render más nuevo mandó.
let renderSeq = 0;

export function render() {
  if (!container) return;
  const seq = ++renderSeq;
  const ctx = getCtx();
  if (!ctx.bookId && !ctx.bookTitle) {
    container.innerHTML = `<p class="studio-hint">${t('Abre un libro para generar y ver sus artefactos.')}</p>`;
    return;
  }
  DB.getDecks(ctx.bookId)
    .catch(() => [])            // sin mazos legibles, el tile cae a la invitación vacía
    .then(decks => {
      if (seq !== renderSeq) return;
      const job = Jobs.activeJob();
      container.innerHTML =
        `<div class="studio-book">${escapeHtml(ctx.bookTitle || t('Libro'))}</div>` +
        (ctx.segReady ? '' : `<p class="studio-hint">${t('Preparando el libro… la generación estará lista en unos segundos.')}</p>`) +
        `<div class="studio-grid">${TYPES.map(ty => group(ty, ctx, job, decks)).join('')}</div>`;
    });
}

async function onClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const kind = btn.dataset.kind;
  const key = btn.dataset.key;
  const deckId = Number(btn.dataset.deck);
  const ctx = getCtx();

  if (act === 'open') {
    const entry = Jobs.list(ctx.bookId, kind).find(x => x.key === key);
    openFn(kind, entry ? { artifact: entry } : {});
    return;
  }
  if (act === 'gen') { openFn(kind, { mode: 'setup' }); return; }
  if (act === 'cancel') { Jobs.cancel(); render(); return; }
  if (act === 'retry') { const j = Jobs.activeJob(); if (j) Jobs.retry(j); return; }
  if (act === 'study') {
    // Se relee el mazo de IndexedDB (fresco, con el SRS al día) y se estudia SOLO ese.
    DB.getDecks(ctx.bookId).then(list => {
      const deck = list.find(x => x.id === deckId);
      if (deck) openStudy({ decks: [deck], title: deck.scope || deck.name || t('Mazo'), onClose: () => render() });
    });
    return;
  }
  if (act === 'study-book') {
    // «Estudiar todo»: lo vencido de TODOS los mazos del libro, resuelto por Study.openToday.
    openStudyToday({ scope: { type: 'book', bookId: ctx.bookId }, title: ctx.bookTitle || t('Libro'), onClose: () => render() });
    return;
  }
  if (act === 'del-deck') {
    const yes = await confirmBox(
      'Se borrará este mazo con todas sus tarjetas y su estado de repaso. Esta acción no se puede deshacer.',
      { title: 'Borrar mazo', okText: 'Borrar', cancelText: 'Cancelar', danger: true }
    );
    if (yes) { await DB.deleteDeck(deckId); render(); }
    return;
  }
  if (act === 'manage') { import('../decks.js').then(m => m.open()); return; }
  if (act === 'del') {
    const yes = await confirmBox(
      'Se borrará este artefacto. Los demás se conservan y podrás generar nuevos cuando quieras.',
      { title: 'Borrar artefacto', okText: 'Borrar', cancelText: 'Cancelar', danger: true }
    );
    if (yes) { Jobs.remove(key); render(); }
    return;
  }
}
