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
import { BLOCKS, allTemplates } from '../ai/templates.js';
import * as CustomTpl from '../ai/custom-templates.js';
import { icon } from './icons.js';
import { escapeHtml } from './escape.js';

const SECTIONS = [
  { id: 'agent',     label: 'Agente',     ico: 'sparkles' },
  { id: 'profiles',  label: 'Perfiles',   ico: 'note' },
  { id: 'templates', label: 'Plantillas', ico: 'note' },
  { id: 'data',      label: 'Datos',      ico: 'share' },
];

let overlay = null;
let tplDraft = null;   // borrador en edición de la sección Plantillas (null = lista)

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
  if (id === 'templates') { tplDraft = null; renderTemplates(content); return; }
  content.innerHTML = renderSection(id);
  if (id === 'agent') wireAgent(content);
}

function renderSection(id) {
  if (id === 'agent') return agentHtml();
  const stub = {
    profiles:  ['Perfiles del agente', 'Personalidad, perfil de usuario y notas persistentes reutilizables entre libros.', 'P1'],
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

// ---- Sección Plantillas (P2) ----------------------------------------------
// Lista (fábrica de solo lectura + propias editables) y formulario de crear/editar.
// `tplDraft` distingue el modo: null = lista, objeto = formulario.

function renderTemplates(content) {
  if (tplDraft) { content.innerHTML = templateFormHtml(tplDraft); wireTemplateForm(content); }
  else { content.innerHTML = templatesListHtml(); wireTemplatesList(content); }
}

function templatesListHtml() {
  const byBlock = Object.values(BLOCKS).map(bl => {
    const items = allTemplates().filter(t => t.block === bl.id);
    return `<div class="appset-tpl-block">
      <div class="appset-tpl-block-h">${icon(bl.icon, { size: 15 })} ${escapeHtml(bl.label)}</div>
      ${items.map(t => `
        <div class="appset-tpl-row">
          <div class="appset-tpl-meta">
            <span class="appset-tpl-name">${escapeHtml(t.name)}</span>
            <span class="appset-tpl-ideal">${escapeHtml(t.ideal || '')}</span>
          </div>
          ${t.custom
            ? `<div class="appset-tpl-acts">
                 <button class="icon-btn appset-tpl-edit" data-id="${t.id}" title="Editar">${icon('pencil', { size: 15 })}</button>
                 <button class="icon-btn appset-tpl-del" data-id="${t.id}" title="Eliminar">${icon('trash', { size: 15 })}</button>
               </div>`
            : '<span class="appset-tpl-tag">de fábrica</span>'}
        </div>`).join('')}
    </div>`;
  }).join('');
  return `<div class="appset-section">
    <h3 class="appset-h3">Plantillas de libreta</h3>
    <p class="appset-muted">Las plantillas de fábrica no se editan. Crea las tuyas: aparecerán en el onboarding del agente junto a ellas.</p>
    ${byBlock}
    <button id="appset-tpl-new" class="primary-btn appset-save">${icon('plus', { size: 15 })} Crear plantilla</button>
  </div>`;
}

function wireTemplatesList(content) {
  content.querySelector('#appset-tpl-new').addEventListener('click', () => {
    tplDraft = CustomTpl.blank(); renderTemplates(content);
  });
  content.querySelectorAll('.appset-tpl-edit').forEach(b =>
    b.addEventListener('click', () => { tplDraft = CustomTpl.get(b.dataset.id) || CustomTpl.blank(); renderTemplates(content); }));
  content.querySelectorAll('.appset-tpl-del').forEach(b =>
    b.addEventListener('click', () => {
      if (confirm('¿Eliminar esta plantilla? Las conversaciones que la usen perderán su estructura de libreta.')) {
        CustomTpl.remove(b.dataset.id); renderTemplates(content);
      }
    }));
}

function templateFormHtml(t) {
  const blockOpts = Object.values(BLOCKS).map(bl =>
    `<option value="${bl.id}"${t.block === bl.id ? ' selected' : ''}>${escapeHtml(bl.label)}</option>`).join('');
  return `<div class="appset-section">
    <h3 class="appset-h3">${t.id ? 'Editar plantilla' : 'Nueva plantilla'}</h3>
    <label class="appset-label" for="tpl-name">Nombre</label>
    <input id="tpl-name" class="appset-input" value="${escapeHtml(t.name)}" placeholder="Mi plantilla" />
    <label class="appset-label" for="tpl-block">Enfoque</label>
    <select id="tpl-block" class="appset-input">${blockOpts}</select>
    <label class="appset-label" for="tpl-ideal">Ideal para</label>
    <input id="tpl-ideal" class="appset-input" value="${escapeHtml(t.ideal)}" placeholder="Para qué sirve esta lectura" />
    <label class="appset-label" for="tpl-goal">Pregunta de objetivo</label>
    <input id="tpl-goal" class="appset-input" value="${escapeHtml(t.goalPrompt)}" placeholder="¿Qué quieres lograr con este libro?" />
    <label class="appset-label" for="tpl-role">Rol del agente</label>
    <textarea id="tpl-role" class="appset-input" rows="3" placeholder="Cómo debe ayudarte el agente con esta plantilla">${escapeHtml(t.agentRole)}</textarea>
    <label class="appset-label">Campos de la libreta</label>
    <div class="appset-tpl-fields">
      ${t.fields.map(f => templateFieldRow(f)).join('')}
    </div>
    <button id="tpl-add-field" class="appset-tpl-addfield">${icon('plus', { size: 14 })} Añadir campo</button>
    <p class="appset-err" id="tpl-err" hidden></p>
    <div class="appset-tpl-formacts">
      <button id="tpl-cancel" class="appset-tpl-cancel">Cancelar</button>
      <button id="tpl-save" class="primary-btn">Guardar plantilla</button>
    </div>
  </div>`;
}

function templateFieldRow(f = { key: '', label: '', type: 'text' }) {
  return `<div class="appset-tpl-field-row" data-key="${escapeHtml(f.key || '')}">
    <input class="appset-input appset-tpl-field-label" value="${escapeHtml(f.label || '')}" placeholder="Etiqueta del campo" />
    <select class="appset-input appset-tpl-field-type">
      <option value="text"${f.type !== 'list' ? ' selected' : ''}>Texto</option>
      <option value="list"${f.type === 'list' ? ' selected' : ''}>Lista</option>
    </select>
    <button class="icon-btn appset-tpl-field-del" title="Quitar campo">${icon('xmark', { size: 15 })}</button>
  </div>`;
}

// Vuelca el formulario al borrador (antes de re-render, para no perder lo escrito).
function readTemplateForm(content) {
  tplDraft.name = content.querySelector('#tpl-name').value;
  tplDraft.block = content.querySelector('#tpl-block').value;
  tplDraft.ideal = content.querySelector('#tpl-ideal').value;
  tplDraft.goalPrompt = content.querySelector('#tpl-goal').value;
  tplDraft.agentRole = content.querySelector('#tpl-role').value;
  tplDraft.fields = [...content.querySelectorAll('.appset-tpl-field-row')].map(row => ({
    key: row.dataset.key || '',
    label: row.querySelector('.appset-tpl-field-label').value,
    type: row.querySelector('.appset-tpl-field-type').value,
  }));
}

function wireTemplateForm(content) {
  content.querySelector('#tpl-add-field').addEventListener('click', () => {
    readTemplateForm(content);
    tplDraft.fields.push({ key: '', label: '', type: 'text' });
    renderTemplates(content);
  });
  content.querySelectorAll('.appset-tpl-field-del').forEach(b =>
    b.addEventListener('click', () => {
      readTemplateForm(content);
      const row = b.closest('.appset-tpl-field-row');
      const rows = [...content.querySelectorAll('.appset-tpl-field-row')];
      tplDraft.fields.splice(rows.indexOf(row), 1);
      if (!tplDraft.fields.length) tplDraft.fields.push({ key: '', label: '', type: 'text' });
      renderTemplates(content);
    }));
  content.querySelector('#tpl-cancel').addEventListener('click', () => {
    tplDraft = null; renderTemplates(content);
  });
  content.querySelector('#tpl-save').addEventListener('click', () => {
    readTemplateForm(content);
    const err = CustomTpl.validate(tplDraft);
    if (err) {
      const el = content.querySelector('#tpl-err');
      el.textContent = err; el.hidden = false;
      return;
    }
    CustomTpl.save(tplDraft);
    tplDraft = null; renderTemplates(content);
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
