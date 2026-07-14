// ai/jobs-ui.js — UI global de los trabajos de IA en segundo plano: un CHIP flotante de
// progreso/reapertura y el TOAST de aviso al terminar. Suscribe a jobs.js. Los "openers"
// (reabrir el modal de cada tipo) los registra el panel, que sabe construir el contexto.
import * as Jobs from './jobs.js';
import { toast } from './toast.js';
import { icon } from '../ui/icons.js';

const openers = {};                                         // kind -> fn() que reabre el modal
const NAMES = { summary: 'Resumen', mindmap: 'Mapa mental' };
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

function render(job) {
  renderChip(job);
  if (!job || job.status === 'running' || job.id === lastNotifiedId) return;
  // Aviso una sola vez por job. Si su modal ya está abierto, él mismo muestra el resultado.
  lastNotifiedId = job.id;
  if (modalOpen(job.kind)) return;
  const name = NAMES[job.kind] || 'Documento';
  if (job.status === 'done') {
    toast({ message: `${name} listo`, actionLabel: `Ver ${name.toLowerCase()}`, kind: 'success', onAction: () => openers[job.kind]?.() });
    try { navigator.vibrate?.(30); } catch { /* sin soporte */ }
  } else if (job.status === 'error') {
    toast({ message: `No se pudo generar ${name.toLowerCase()}`, actionLabel: 'Reintentar', kind: 'error', onAction: () => Jobs.retry(job) });
  }
}

function renderChip(job) {
  if (!job) { chip?.remove(); chip = null; document.body.classList.remove('has-taskchip'); return; }
  if (!chip) { chip = document.createElement('div'); document.body.appendChild(chip); document.body.classList.add('has-taskchip'); }
  const name = NAMES[job.kind] || 'IA';
  chip.className = `ai-taskchip is-${job.status}`;
  if (job.status === 'running') {
    const p = job.progress;
    const label = p.phase === 'reduce' ? `${name} · redactando…` : (p.n ? `${name} ${p.i}/${p.n}` : `${name}…`);
    chip.innerHTML = `<span class="ai-taskchip-spin" aria-hidden="true"></span><span class="ai-taskchip-label"></span><button class="ai-taskchip-x" title="Cancelar" aria-label="Cancelar">${icon('xmark', { size: 14 })}</button>`;
    chip.querySelector('.ai-taskchip-label').textContent = label;
    chip.querySelector('.ai-taskchip-x').onclick = (e) => { e.stopPropagation(); Jobs.cancel(); };
    chip.onclick = () => openers[job.kind]?.();
  } else if (job.status === 'done') {
    chip.innerHTML = `<span class="ai-taskchip-dot" aria-hidden="true">${icon('check', { size: 13 })}</span><span class="ai-taskchip-label"></span>`;
    chip.querySelector('.ai-taskchip-label').textContent = `Ver ${name.toLowerCase()}`;
    chip.onclick = () => openers[job.kind]?.();
  } else if (job.status === 'error') {
    chip.innerHTML = `<span class="ai-taskchip-dot" aria-hidden="true">!</span><span class="ai-taskchip-label"></span>`;
    chip.querySelector('.ai-taskchip-label').textContent = `${name}: reintentar`;
    chip.onclick = () => Jobs.retry(job);
  }
}
