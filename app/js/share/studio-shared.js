// P24 F2 · Lo ajeno en el Studio del agente: artefactos, libretas y mazos que llegaron en
// un dossier para el libro abierto, agrupados por quién los manda. Todo de solo lectura:
//   - artefactos → se abren con el MISMO visor que los tuyos (resumen, mapa, infografía).
//     Sus citas [[aN]] caen bien porque el libro es el mismo fichero (mismo hash) y por
//     tanto la misma segmentación; si el dossier viene de otra versión de la segmentación
//     (`segVersion`), se avisa en la tarjeta.
//   - libretas → visor propio de solo lectura (no entran en tus conversaciones: su
//     plantilla podría inyectar texto en el prompt de tu agente).
//   - mazos → «Añadir a mis mazos» los copia como mazo tuyo, con calendario nuevo.
import { t } from '../i18n.js';
import * as DB from '../ai/db.js';
import { SEG_VERSION } from '../ai/db.js';
import { getTemplate } from '../ai/templates.js';
import { renderWithCitations } from '../ai/render.js';
import { icon } from '../ui/icons.js';
import { escapeHtml } from '../ui/escape.js';
import { toast } from '../ai/toast.js';

const KIND_NAME = { summary: 'Resumen', mindmap: 'Mapa mental', infographic: 'Infografía' };
const VIEWABLE = new Set(Object.keys(KIND_NAME));

let records = [];   // los del último render, para resolver los clics

async function load(bookId) {
  try {
    const Shared = await import('./store.js');
    return await Shared.forBook(bookId);
  } catch (e) {
    console.warn('No se pudo leer lo compartido:', e);
    return [];
  }
}

function find(sid) {
  const [ri, idx] = String(sid).split(':').map(Number);
  return { rec: records[ri], idx };
}

function templateOf(rec, templateId) {
  return (rec.templates || []).find(x => x.id === templateId) || getTemplate(templateId) || null;
}

function artifactCard(rec, ri, a, i) {
  const bits = [];
  if (a.params?.scopeName) bits.push(escapeHtml(a.params.scopeName));
  if (a.segVersion != null && a.segVersion !== SEG_VERSION) bits.push(t('citas de otra versión'));
  return `<div class="studio-card studio-generated">
    <button class="studio-card-main" data-act="shared-open" data-sid="${ri}:${i}">
      <span class="studio-deck-name">${escapeHtml(t(KIND_NAME[a.kind]))}</span>
      ${bits.length ? `<span class="studio-meta">${bits.join(' · ')}</span>` : ''}
    </button>
  </div>`;
}

function notebookCard(rec, ri, nb, i) {
  const tpl = templateOf(rec, nb.templateId);
  const n = nb.notes.length;
  return `<div class="studio-card studio-generated">
    <button class="studio-card-main" data-act="shared-notebook" data-sid="${ri}:${i}">
      <span class="studio-deck-name">${escapeHtml(tpl?.name || t('Libreta'))}</span>
      <span class="studio-meta">${[nb.goal && escapeHtml(nb.goal), n === 1 ? t('1 nota') : t('{n} notas', { n })].filter(Boolean).join(' · ')}</span>
    </button>
  </div>`;
}

function deckCard(rec, ri, d, i) {
  const n = d.cards.length;
  return `<div class="studio-card studio-generated">
    <div class="studio-card-main">
      <span class="studio-deck-name">${escapeHtml(d.scope || d.name || t('Mazo'))}</span>
      <span class="studio-meta">${n === 1 ? t('1 tarjeta') : t('{n} tarjetas', { n })}</span>
    </div>
    <button class="btn btn--secondary studio-new studio-adopt" data-act="shared-adopt" data-sid="${ri}:${i}">${icon('plus', { size: 'sm' })} ${t('Añadir a mis mazos')}</button>
  </div>`;
}

// HTML de la sección (vacío si no hay nada ajeno para este libro).
export async function sectionHtml(bookId) {
  records = await load(bookId);
  return records.map((rec, ri) => {
    const arts = (rec.artifacts || []).map((a, i) => [a, i]).filter(([a]) => VIEWABLE.has(a.kind));
    const nbs = rec.notebooks || [];
    const decks = rec.decks || [];
    if (!arts.length && !nbs.length && !decks.length) return '';
    const from = rec.from ? t('De {name}', { name: rec.from }) : t('Compartidos');
    return `<div class="studio-group studio-shared" data-from="${escapeHtml(rec.from || '')}">
      <div class="studio-group-head"><span class="studio-ico">${icon('users', { size: 'md' })}</span>
        <span class="studio-group-name">${escapeHtml(from)}</span></div>
      ${arts.map(([a, i]) => artifactCard(rec, ri, a, i)).join('')}
      ${nbs.map((nb, i) => notebookCard(rec, ri, nb, i)).join('')}
      ${decks.map((d, i) => deckCard(rec, ri, d, i)).join('')}
    </div>`;
  }).join('');
}

// Devuelve true si el clic era suyo.
export async function onClick(btn, { bookId, open, anchors, onCite, rerender }) {
  const act = btn.dataset.act;
  if (!act || !act.startsWith('shared-')) return false;
  const { rec, idx } = find(btn.dataset.sid);
  if (!rec) return true;
  if (act === 'shared-open') {
    const a = rec.artifacts[idx];
    // Mismo shape que una entrada de Jobs.list: es lo que espera `viewArtifact`.
    open(a.kind, { artifact: { key: `shared:${rec.id}:${idx}`, result: a.result, params: a.params || {}, at: a.createdAt } });
  } else if (act === 'shared-notebook') {
    openNotebook(rec, rec.notebooks[idx], { anchors, onCite });
  } else if (act === 'shared-adopt') {
    const d = rec.decks[idx];
    const name = d.name || d.scope || t('Mazo');
    await DB.addDeck({
      bookId, name: rec.from ? `${name} · ${rec.from}` : name,
      cardType: d.cardType, scope: d.scope ? (rec.from ? `${d.scope} · ${rec.from}` : d.scope) : null,
      cards: d.cards.map(c => ({ ...c })),
    });
    toast({ message: t('Mazo añadido: ya puedes estudiarlo.') });
    rerender();
  }
  return true;
}

// ---- Visor de libreta ajena (solo lectura) ---------------------------------------

let overlay = null;

function close() {
  document.removeEventListener('keydown', onKey);
  overlay?.remove();
  overlay = null;
}
function onKey(e) { if (e.key === 'Escape') close(); }

function openNotebook(rec, nb, { anchors, onCite }) {
  close();
  const tpl = templateOf(rec, nb.templateId);
  const fields = tpl?.fields || [];
  const byField = new Map();
  for (const n of nb.notes) {
    if (!byField.has(n.fieldKey)) byField.set(n.fieldKey, []);
    byField.get(n.fieldKey).push(n);
  }
  const order = [...new Set([...fields.map(f => f.key), ...byField.keys()])].filter(k => byField.has(k));
  const label = (k) => fields.find(f => f.key === k)?.label || k;
  const cites = anchors instanceof Map ? anchors : new Map();
  overlay = document.createElement('div');
  overlay.id = 'shared-notebook';
  overlay.className = 'ai-onboarding';
  overlay.innerHTML = `
    <div class="ai-ob-card sum-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(tpl?.name || t('Libreta'))}">
      <button class="ai-ob-close" title="${t('Cerrar')}" aria-label="${t('Cerrar')}">${icon('xmark', { size: 'lg' })}</button>
      <div class="ai-ob-body">
        <h2>${escapeHtml(tpl?.name || t('Libreta'))}</h2>
        <p class="ai-ob-sub">${escapeHtml([rec.from && t('De {name}', { name: rec.from }), nb.goal].filter(Boolean).join(' · '))}</p>
        ${order.map(k => `<section class="shared-nb-field">
          <h3>${escapeHtml(label(k))}</h3>
          ${byField.get(k).map(n => `<div class="shared-nb-note">${renderWithCitations(n.content, cites)}</div>`).join('')}
        </section>`).join('')}
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.ai-ob-close').addEventListener('click', close);
  // Las citas son las del libro abierto (mismo fichero): llevan al pasaje como en las tuyas.
  overlay.addEventListener('click', (e) => {
    const chip = e.target.closest('.ai-cite');
    if (chip && onCite) { close(); onCite(chip.dataset.id); }
  });
  document.addEventListener('keydown', onKey);
}
