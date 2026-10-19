// P43 · Tipo 2: «Rellena la matriz». Filas = conceptos que se confunden entre sí; columnas =
// atributos con respuestas cerradas. Algunas celdas vienen dadas (como los mapas parcialmente
// rellenos, que reducen el tedio) y el lector rellena el resto antes de ver nada. Se corrige
// celda a celda, sin juez: la respuesta de cada celda es una de las opciones de su columna.
//
// Por qué este tipo primero: construir una matriz de conceptos × atributos tiene la mediana más
// alta de las estrategias generativas (d = 1.07, Fiorella y Mayer 2016) y obliga a comparar lo
// parecido, que es donde intercalar ayuda (Brunmair y Richter 2019). Ver
// docs/INVESTIGACION_WIDGETS.md.
//
// Spec (además de lo común de core.js):
//   rows:    [{ id, label }]                       2–8
//   columns: [{ id, label, options: [texto] }]     2–5, cada una con 2–5 opciones
//   cells:   [{ row, col, answer, given?, why, cite: { quote, src? } }]   una por fila × columna
//
// Lo puro (validateMatrix, matrixCites, scoreMatrix, matrixCards) no toca el DOM y se prueba
// sin navegador; renderMatrix es la única parte con DOM.

import { validateCommon, citeErrors, missCard } from './core.js';
import { escapeHtml } from '../../ui/escape.js';
import { t } from '../../i18n.js';

export const MATRIX_LIMITS = { rows: [2, 8], columns: [2, 5], options: [2, 5], label: 80, why: 240 };

const key = (row, col) => `${row}|${col}`;

export function validateMatrix(spec) {
  const errors = validateCommon(spec);
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return errors;
  const { rows, columns, cells } = spec;
  const L = MATRIX_LIMITS;

  const checkList = (list, name, [min, max]) => {
    if (!Array.isArray(list)) { errors.push(`falta ${name}`); return []; }
    if (list.length < min || list.length > max) errors.push(`${name}: entre ${min} y ${max} (hay ${list.length})`);
    const ids = new Set();
    for (const [i, it] of list.entries()) {
      const id = it && typeof it.id === 'string' ? it.id.trim() : '';
      if (!id) errors.push(`${name}[${i}]: falta id`);
      else if (ids.has(id)) errors.push(`${name}: id repetido «${id}»`);
      else ids.add(id);
      if (!it || typeof it.label !== 'string' || !it.label.trim()) errors.push(`${name}[${i}]: falta label`);
      else if (it.label.length > L.label) errors.push(`${name}[${i}]: label pasa de ${L.label}`);
    }
    return ids;
  };
  const rowIds = checkList(rows, 'rows', L.rows);
  const colIds = checkList(columns, 'columns', L.columns);

  const optionsOf = new Map();
  for (const [i, c] of (Array.isArray(columns) ? columns : []).entries()) {
    const opts = Array.isArray(c && c.options) ? c.options : null;
    if (!opts) { errors.push(`columns[${i}]: faltan options`); continue; }
    if (opts.length < L.options[0] || opts.length > L.options[1]) errors.push(`columns[${i}]: entre ${L.options[0]} y ${L.options[1]} opciones`);
    if (opts.some((o) => typeof o !== 'string' || !o.trim())) errors.push(`columns[${i}]: opción vacía`);
    if (new Set(opts.map((o) => String(o).trim().toLowerCase())).size !== opts.length) errors.push(`columns[${i}]: opciones repetidas`);
    if (c && c.id) optionsOf.set(c.id, opts);
  }

  if (!Array.isArray(cells)) { errors.push('faltan cells'); return errors; }
  const seen = new Set();
  let given = 0;
  for (const [i, cell] of cells.entries()) {
    const where = `cells[${i}]`;
    if (!cell || !rowIds.has(cell.row) || !colIds.has(cell.col)) { errors.push(`${where}: fila o columna desconocida`); continue; }
    const k = key(cell.row, cell.col);
    if (seen.has(k)) { errors.push(`${where}: celda repetida ${k}`); continue; }
    seen.add(k);
    const opts = optionsOf.get(cell.col) || [];
    if (!opts.includes(cell.answer)) errors.push(`${where}: answer «${String(cell.answer)}» no es una opción de su columna`);
    if (cell.given) { given++; continue; }
    if (typeof cell.why !== 'string' || !cell.why.trim()) errors.push(`${where}: falta why`);
    else if (cell.why.length > L.why) errors.push(`${where}: why pasa de ${L.why}`);
    errors.push(...citeErrors(cell.cite, where));
  }
  const total = rowIds.size * colIds.size;
  if (rowIds.size && colIds.size && seen.size !== total) errors.push(`faltan celdas: hay ${seen.size} de ${total}`);
  // Dadas, como mucho la mitad: si no, el lector ya no construye, completa un hueco.
  if (given > Math.floor(total / 2)) errors.push(`demasiadas celdas dadas: ${given} de ${total}`);
  if (seen.size - given < 2) errors.push('hacen falta al menos 2 celdas por rellenar');
  return errors;
}

// Las citas a comprobar contra el texto del capítulo (core.verifyQuotes).
export function matrixCites(spec) {
  return spec.cells.filter((c) => !c.given && c.cite).map((c) => ({ where: key(c.row, c.col), cite: c.cite }));
}

// answers: { 'fila|col': { value, unsure? } }. Una celda sin responder cuenta como fallo.
// confidentMisses: fallos marcados como seguros. Son los que más se corrigen si se repasan
// (hipercorrección, Metcalfe 2017), así que van primero.
export function scoreMatrix(spec, answers = {}) {
  const out = [];
  for (const cell of spec.cells) {
    if (cell.given) continue;
    const a = answers[key(cell.row, cell.col)] || {};
    const ok = a.value === cell.answer;
    out.push({ row: cell.row, col: cell.col, value: a.value ?? null, answer: cell.answer, ok, unsure: !!a.unsure });
  }
  const correct = out.filter((c) => c.ok).length;
  const confidentMisses = out.filter((c) => !c.ok && c.value != null && !c.unsure).length;
  return { cells: out, correct, total: out.length, confidentMisses };
}

// Una tarjeta por celda fallada (o acertada con duda): la pregunta nombra fila y columna y da
// las opciones; el dorso trae la respuesta, el porqué y la cita.
export function matrixCards(spec, result) {
  const label = (list, id) => (list.find((x) => x.id === id) || {}).label || id;
  const byKey = new Map(spec.cells.map((c) => [key(c.row, c.col), c]));
  const cards = [];
  for (const r of result.cells) {
    if (r.ok && !r.unsure) continue;
    const cell = byKey.get(key(r.row, r.col));
    const col = spec.columns.find((c) => c.id === r.col);
    cards.push(missCard({
      front: `${label(spec.rows, r.row)} · ${label(spec.columns, r.col)} (${col.options.join(' / ')})`,
      back: cell.answer,
      why: cell.why,
      cite: cell.cite,
      chapter: spec.chapter,
    }));
  }
  return cards;
}

// ─── DOM ─────────────────────────────────────────────────────────────────────
// renderMatrix(root, spec, { onCommit(result, answers), onCite(src) }) pinta el widget en `root`
// y devuelve { answers, commit }. El spec se valida antes: aquí se da por bueno, pero TODO texto
// del spec se escapa (viene del modelo).
export function renderMatrix(root, spec, { onCommit, onCite } = {}) {
  const answers = {};
  const fillable = spec.cells.filter((c) => !c.given);
  const cellOf = new Map(spec.cells.map((c) => [key(c.row, c.col), c]));
  let committed = false;

  const optionButtons = (cell, col) => col.options.map((o) =>
    `<button type="button" class="segmented-btn" data-k="${escapeHtml(key(cell.row, cell.col))}" data-v="${escapeHtml(o)}" aria-pressed="false">${escapeHtml(o)}</button>`).join('');

  const head = spec.columns.map((c) => `<th scope="col">${escapeHtml(c.label)}</th>`).join('');
  const body = spec.rows.map((r) => {
    const tds = spec.columns.map((c) => {
      const cell = cellOf.get(key(r.id, c.id));
      if (cell.given) {
        return `<td class="wgt-cell wgt-given" data-label="${escapeHtml(c.label)}"><span class="wgt-val">${escapeHtml(cell.answer)}</span><span class="wgt-tag">${escapeHtml(t('Dada'))}</span></td>`;
      }
      const k = escapeHtml(key(r.id, c.id));
      return `<td class="wgt-cell" data-k="${k}" data-label="${escapeHtml(c.label)}">
        <div class="segmented wgt-opts" role="group" aria-label="${escapeHtml(`${r.label} · ${c.label}`)}">${optionButtons(cell, c)}</div>
        <label class="wgt-unsure"><input type="checkbox" data-unsure="${k}"> ${escapeHtml(t('Dudo'))}</label>
        <div class="wgt-fix" hidden></div>
      </td>`;
    }).join('');
    return `<tr><th scope="row">${escapeHtml(r.label)}</th>${tds}</tr>`;
  }).join('');

  root.classList.add('wgt', 'wgt-matrix');
  root.innerHTML = `
    <h3 class="wgt-title">${escapeHtml(spec.title)}</h3>
    <p class="wgt-prompt">${escapeHtml(spec.prompt)}</p>
    <div class="wgt-scroll"><table class="wgt-grid"><thead><tr><td></td>${head}</tr></thead><tbody>${body}</tbody></table></div>
    <div class="wgt-actions">
      <button type="button" class="btn btn--primary primary-btn wgt-commit" disabled>${escapeHtml(t('Comprobar'))}</button>
      <span class="wgt-hint">${escapeHtml(t('Rellena todas las celdas para comprobar'))}</span>
    </div>
    <div class="wgt-result" hidden></div>`;

  const commitBtn = root.querySelector('.wgt-commit');
  const hint = root.querySelector('.wgt-hint');
  const refresh = () => {
    const done = fillable.every((c) => answers[key(c.row, c.col)]?.value != null);
    commitBtn.disabled = !done || committed;
    hint.hidden = done || committed;
  };

  root.addEventListener('click', (e) => {
    const cite = e.target.closest('.ai-cite');
    if (cite && onCite) { e.preventDefault(); onCite(cite.dataset.id); return; }
    const b = e.target.closest('.wgt-opts .segmented-btn');
    if (!b || committed) return;
    const k = b.dataset.k;
    answers[k] = { ...(answers[k] || {}), value: b.dataset.v };
    for (const sib of b.parentElement.children) {
      const on = sib === b;
      sib.classList.toggle('active', on);
      sib.setAttribute('aria-pressed', String(on));
    }
    refresh();
  });
  root.addEventListener('change', (e) => {
    const k = e.target.dataset && e.target.dataset.unsure;
    if (!k || committed) return;
    answers[k] = { ...(answers[k] || {}), unsure: e.target.checked };
  });

  function commit() {
    if (committed) return null;
    committed = true;
    const result = scoreMatrix(spec, answers);
    for (const r of result.cells) {
      const td = root.querySelector(`td[data-k="${CSS.escape(key(r.row, r.col))}"]`);
      td.classList.add(r.ok ? 'wgt-ok' : 'wgt-ko');
      td.querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
      if (!r.ok) {
        const fix = td.querySelector('.wgt-fix');
        fix.textContent = t('Era: {answer}', { answer: r.answer });
        fix.hidden = false;
      }
    }
    const label = (list, id) => (list.find((x) => x.id === id) || {}).label || id;
    const misses = result.cells.filter((r) => !r.ok)
      // Primero los fallos seguros: son los que más se corrigen al repasarlos.
      .sort((a, b) => Number(a.unsure) - Number(b.unsure));
    const items = misses.map((r) => {
      const cell = cellOf.get(key(r.row, r.col));
      const src = cell.cite && cell.cite.src;
      return `<li class="wgt-miss">
        <div class="wgt-miss-h">${escapeHtml(label(spec.rows, r.row))} · ${escapeHtml(label(spec.columns, r.col))}: <strong>${escapeHtml(r.answer)}</strong>${r.unsure ? '' : ` <span class="wgt-sure">${escapeHtml(t('Ibas seguro'))}</span>`}</div>
        <p>${escapeHtml(cell.why)}</p>
        <blockquote class="wgt-quote">«${escapeHtml(cell.cite.quote.trim())}»${src ? ` <a class="ai-cite" href="#" data-id="${escapeHtml(src)}">${escapeHtml(src)}</a>` : ''}</blockquote>
      </li>`;
    }).join('');
    const res = root.querySelector('.wgt-result');
    const summary = t('{n} de {total} bien', { n: result.correct, total: result.total });
    const sureNote = result.confidentMisses
      ? `<p class="wgt-note">${escapeHtml(t('Fallaste {n} estando seguro. Son los que más se corrigen al repasarlos: van primero.', { n: result.confidentMisses }))}</p>` : '';
    res.innerHTML = `<p class="wgt-score">${escapeHtml(summary)}</p>${sureNote}${items ? `<ul class="wgt-misses">${items}</ul>` : `<p>${escapeHtml(t('Todo bien.'))}</p>`}`;
    res.hidden = false;
    refresh();
    if (onCommit) onCommit(result, JSON.parse(JSON.stringify(answers)));
    return result;
  }
  commitBtn.addEventListener('click', commit);
  refresh();
  return { answers, commit };
}
