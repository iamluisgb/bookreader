// ai/jobs-ui.js — UI global de los trabajos de IA en segundo plano: un CHIP flotante de
// progreso/reapertura y el TOAST de aviso al terminar. Suscribe a jobs.js. Los "openers"
// (reabrir el modal de cada tipo) los registra el panel, que sabe construir el contexto.
import * as Jobs from './jobs.js';
import { toast } from './toast.js';
import { icon } from '../ui/icons.js';
import { t } from '../i18n.js';

const openers = {};                                         // kind -> fn() que reabre el modal
const NAMES = { summary: t('Resumen'), mindmap: t('Mapa mental'), flashcards: t('Flashcards') };
let chip = null, lastNotifiedId = 0, started = false;

export function setOpener(kind, fn) { openers[kind] = fn; }

export function init() {
  if (started) return;
  started = true;
  Jobs.subscribe(render);
}

function modalOpen(kind) {
  return !!document.getElementById(kind === 'summary' ? 'ai-summary' : 'ai-mindmap');
}

// Leyendo, el texto es intocable: ni chip flotante ni toast encima. La señal viaja como
// un PUNTO al botón del agente (#ai-toggle/.ai-fab, CSS en modern.css) — pulso mientras
// genera, verde al terminar, rojo si falló. Fuera del lector, chip y toast como siempre.
function isReading() { return document.body.classList.contains('reading'); }

function render(job) {
  renderChip(job);
  const reading = isReading();
  document.body.classList.toggle('ai-jobs-busy', reading && job?.status === 'running');
  // Sin lastNotifiedId (se asigna recién abajo): con un solo job activo, el status basta
  // para el punto de "listo/error sin abrir"; el próximo job lo apaga al empezar.
  document.body.classList.toggle('ai-jobs-unread', reading && job?.status === 'done');
  document.body.classList.toggle('ai-jobs-err', reading && job?.status === 'error');
  if (!job || job.status === 'running' || job.id === lastNotifiedId) return;
  // Aviso una sola vez por job. Si su modal ya está abierto, él mismo muestra el resultado.
  lastNotifiedId = job.id;
  if (modalOpen(job.kind)) return;
  const name = NAMES[job.kind] || t('Documento');
  if (job.status === 'done') {
    try { navigator.vibrate?.(30); } catch { /* sin soporte */ }
    if (!reading) toast({ message: t('{name} listo', { name }), actionLabel: `${t('Ver')} ${name.toLowerCase()}`, kind: 'success', onAction: () => openers[job.kind]?.() });
  } else if (job.status === 'error') {
    if (!reading) toast({ message: t('No se pudo generar {name}', { name: name.toLowerCase() }), actionLabel: t('Reintentar'), kind: 'error', onAction: () => Jobs.retry(job) });
  }
}

function renderChip(job) {
  if (!job) { chip?.remove(); chip = null; document.body.classList.remove('has-taskchip'); return; }
  if (!chip) { chip = document.createElement('div'); document.body.appendChild(chip); document.body.classList.add('has-taskchip'); }
  const name = NAMES[job.kind] || 'IA';
  chip.className = `ai-taskchip is-${job.status}`;
  if (job.status === 'running') {
    const p = job.progress;
    const label = p.phase === 'reduce' ? `${name} · ${t('redactando…')}` : (p.n ? `${name} ${p.i}/${p.n}` : `${name}…`);
    chip.innerHTML = `<span class="ai-taskchip-spin" aria-hidden="true"></span><span class="ai-taskchip-label"></span><button class="ai-taskchip-x" title="${t('Cancelar')}" aria-label="${t('Cancelar')}">${icon('xmark', { size: 'sm' })}</button>`;
    chip.querySelector('.ai-taskchip-label').textContent = label;
    chip.querySelector('.ai-taskchip-x').onclick = (e) => { e.stopPropagation(); Jobs.cancel(); };
    chip.onclick = () => openers[job.kind]?.();
  } else if (job.status === 'done') {
    chip.innerHTML = `<span class="ai-taskchip-dot" aria-hidden="true">${icon('check', { size: 'sm' })}</span><span class="ai-taskchip-label"></span>`;
    chip.querySelector('.ai-taskchip-label').textContent = `${t('Ver')} ${name.toLowerCase()}`;
    chip.onclick = () => openers[job.kind]?.();
  } else if (job.status === 'error') {
    chip.innerHTML = `<span class="ai-taskchip-dot" aria-hidden="true">!</span><span class="ai-taskchip-label"></span>`;
    chip.querySelector('.ai-taskchip-label').textContent = `${name}: ${t('reintentar')}`;
    chip.onclick = () => Jobs.retry(job);
  }
}
