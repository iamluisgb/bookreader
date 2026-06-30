// Ajustes generales: overlay global de la app (ver decisión de diseño en BACKLOG,
// "Ajustes generales", hogar de P1–P3). Config que NO depende del libro abierto:
// el Agente (API key/modelo/auto-rellenar, antes en #ai-config del panel) y, en el
// futuro, Perfiles (P1), Plantillas (P2) y Datos/export-import (P3). Las settings de
// LECTURA (tema/fuente/ancho) NO viven aquí: siguen en la sidebar, contextual del libro.
//
// Patrón: overlay tipo #ai-onboarding, construido bajo demanda y montado en <body>.
// Punto de entrada desde la estantería y desde el pie de la sidebar. Al guardar la
// config del agente se emite 'appsettings:agent-saved' para que el panel se refresque.
import * as LLM from '../ai/llm.js';
import { icon } from './icons.js';

const SECTIONS = [
  { id: 'agent',     label: 'Agente',     ico: 'sparkles' },
  { id: 'profiles',  label: 'Perfiles',   ico: 'note' },
  { id: 'templates', label: 'Plantillas', ico: 'note' },
  { id: 'data',      label: 'Datos',      ico: 'share' },
];

let overlay = null;

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'app-settings';
  overlay.className = 'appset';
  overlay.style.display = 'none';
  overlay.innerHTML = `
    <div class="appset-card" role="dialog" aria-modal="true" aria-label="Ajustes generales">
      <button class="appset-close" title="Cerrar" aria-label="Cerrar">${icon('xmark')}</button>
      <h2 class="appset-h2">${icon('gear', { size: 20 })} Ajustes generales</h2>
      <div class="appset-body">
        <nav class="appset-nav">
          ${SECTIONS.map(s => `<button class="appset-nav-item" data-section="${s.id}">${icon(s.ico, { size: 16 })}<span>${s.label}</span></button>`).join('')}
        </nav>
        <div class="appset-content"></div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  // Cerrar: botón, click en el fondo, Escape.
  overlay.querySelector('.appset-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.style.display !== 'none') close();
  });

  overlay.querySelector('.appset-nav').addEventListener('click', (e) => {
    const b = e.target.closest('.appset-nav-item');
    if (b) selectSection(b.dataset.section);
  });
  return overlay;
}

function selectSection(id) {
  overlay.querySelectorAll('.appset-nav-item').forEach(b =>
    b.classList.toggle('active', b.dataset.section === id));
  const content = overlay.querySelector('.appset-content');
  content.innerHTML = renderSection(id);
  if (id === 'agent') wireAgent(content);
}

function renderSection(id) {
  if (id === 'agent') return agentHtml();
  const stub = {
    profiles:  ['Perfiles del agente', 'Personalidad, perfil de usuario y notas persistentes reutilizables entre libros.', 'P1'],
    templates: ['Plantillas de libreta', 'Crear y editar tus propios tipos de libreta, además de las de fábrica.', 'P2'],
    data:      ['Datos', 'Exportar e importar todo (subrayados, libretas, perfiles, conversaciones, ajustes).', 'P3'],
  }[id];
  return `<div class="appset-section">
    <h3 class="appset-h3">${stub[0]}</h3>
    <p class="appset-muted">${stub[1]}</p>
    <p class="appset-soon">Próximamente · <code>${stub[2]}</code></p>
  </div>`;
}

function agentHtml() {
  const opts = LLM.MODELS.map(m =>
    `<option value="${m.id}"${m.id === LLM.getModel() ? ' selected' : ''}>${m.name}</option>`).join('');
  return `<div class="appset-section">
    <h3 class="appset-h3">Agente</h3>
    <label class="appset-label" for="appset-key">API key de nan</label>
    <input id="appset-key" class="appset-input" type="password" placeholder="sk-..." autocomplete="off" value="${LLM.getKey()}" />
    <label class="appset-label" for="appset-model">Modelo</label>
    <select id="appset-model" class="appset-input">${opts}</select>
    <label class="appset-check"><input type="checkbox" id="appset-auto"${LLM.getAutoExtract() ? ' checked' : ''} /> Rellenar la libreta automáticamente</label>
    <button id="appset-save" class="primary-btn appset-save">Guardar</button>
    <p class="appset-saved" id="appset-saved" hidden>${icon('check', { size: 14 })} Guardado</p>
    <p class="appset-privacy">${icon('shield', { size: 13 })} Tu API key se guarda solo en este navegador. Para responder, el contenido del libro se envía al proveedor del modelo (nan).</p>
  </div>`;
}

function wireAgent(content) {
  content.querySelector('#appset-save').addEventListener('click', () => {
    LLM.setKey(content.querySelector('#appset-key').value.trim());
    LLM.setModel(content.querySelector('#appset-model').value);
    LLM.setAutoExtract(content.querySelector('#appset-auto').checked);
    const ok = content.querySelector('#appset-saved');
    if (ok) { ok.hidden = false; setTimeout(() => { ok.hidden = true; }, 1800); }
    window.dispatchEvent(new CustomEvent('appsettings:agent-saved'));
  });
}

export function open(section = 'agent') {
  ensureOverlay();
  overlay.style.display = 'flex';
  selectSection(SECTIONS.some(s => s.id === section) ? section : 'agent');
}

export function close() {
  if (overlay) overlay.style.display = 'none';
}

export function isOpen() {
  return !!overlay && overlay.style.display !== 'none';
}
