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
import * as Profiles from '../ai/profiles.js';
import * as Backup from '../backup.js';
import { icon } from './icons.js';
import { escapeHtml } from './escape.js';

const SECTIONS = [
  { id: 'agent',     label: 'Agente',     ico: 'sparkles' },
  { id: 'profiles',  label: 'Perfiles',   ico: 'note' },
  { id: 'templates', label: 'Plantillas', ico: 'note' },
  { id: 'data',      label: 'Datos',      ico: 'share' },
];

let overlay = null;
let tplDraft = null;    // borrador en edición de la sección Plantillas (null = lista)
let profDraft = null;   // borrador en edición de la sección Perfiles (null = lista)

const oneLine = (s) => (s || '').replace(/\s+/g, ' ').trim();

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
  if (id === 'profiles') { profDraft = null; renderProfiles(content); return; }
  content.innerHTML = renderSection(id);
  if (id === 'agent') wireAgent(content);
  if (id === 'data') wireData(content);
}

function renderSection(id) {
  if (id === 'agent') return agentHtml();
  if (id === 'data') return dataHtml();
  return '';
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

// ---- Sección Perfiles (P1) -------------------------------------------------
// Lista de perfiles reutilizables (persona + contexto del usuario + notas) con uno
// activo, y formulario de crear/editar. `profDraft`: null = lista, objeto = formulario.

function renderProfiles(content) {
  if (profDraft) { content.innerHTML = profileFormHtml(profDraft); wireProfileForm(content); }
  else { content.innerHTML = profilesListHtml(); wireProfilesList(content); }
}

function profilesListHtml() {
  const profiles = Profiles.getAll();
  const activeId = Profiles.getActiveId();
  const active = profiles.find(p => p.id === activeId);
  const snippet = (p) => oneLine([p.soul, p.userProfile, p.notes].filter(Boolean).join(' · '));
  return `<div class="appset-section">
    <h3 class="appset-h3">Perfiles del agente</h3>
    <p class="appset-muted">Persona del agente + quién eres + notas permanentes, reutilizables entre libros.
      El perfil activo se antepone al prompt en cada respuesta.</p>
    <p class="appset-prof-active">Activo: <strong>${active ? escapeHtml(active.name) : 'ninguno'}</strong></p>
    ${profiles.length ? profiles.map(p => `
      <div class="appset-tpl-row${p.id === activeId ? ' is-active' : ''}">
        <div class="appset-tpl-meta">
          <span class="appset-tpl-name">${escapeHtml(p.name)}</span>
          <span class="appset-tpl-ideal">${escapeHtml(snippet(p)) || 'Sin contenido'}</span>
        </div>
        <div class="appset-tpl-acts">
          <button class="appset-prof-activate" data-id="${p.id}">${p.id === activeId ? 'Activo ✓' : 'Activar'}</button>
          <button class="icon-btn appset-prof-edit" data-id="${p.id}" title="Editar">${icon('pencil', { size: 15 })}</button>
          <button class="icon-btn appset-prof-del" data-id="${p.id}" title="Eliminar">${icon('trash', { size: 15 })}</button>
        </div>
      </div>`).join('') : '<p class="appset-muted">Aún no hay perfiles.</p>'}
    <button id="appset-prof-new" class="primary-btn appset-save">${icon('plus', { size: 15 })} Crear perfil</button>
  </div>`;
}

function notifyProfileChange() {
  window.dispatchEvent(new CustomEvent('appsettings:profile-changed'));
}

function wireProfilesList(content) {
  content.querySelector('#appset-prof-new').addEventListener('click', () => {
    profDraft = Profiles.blank(); renderProfiles(content);
  });
  content.querySelectorAll('.appset-prof-activate').forEach(b =>
    b.addEventListener('click', () => {
      // Toggle: si ya es el activo, lo desactiva (queda sin perfil).
      Profiles.setActiveId(Profiles.getActiveId() === b.dataset.id ? null : b.dataset.id);
      notifyProfileChange();
      renderProfiles(content);
    }));
  content.querySelectorAll('.appset-prof-edit').forEach(b =>
    b.addEventListener('click', () => { profDraft = Profiles.get(b.dataset.id) || Profiles.blank(); renderProfiles(content); }));
  content.querySelectorAll('.appset-prof-del').forEach(b =>
    b.addEventListener('click', () => {
      if (confirm('¿Eliminar este perfil? Si estaba activo, el agente quedará sin perfil.')) {
        Profiles.remove(b.dataset.id); notifyProfileChange(); renderProfiles(content);
      }
    }));
}

function profileFormHtml(p) {
  return `<div class="appset-section">
    <h3 class="appset-h3">${p.id ? 'Editar perfil' : 'Nuevo perfil'}</h3>
    <label class="appset-label" for="prof-name">Nombre</label>
    <input id="prof-name" class="appset-input" value="${escapeHtml(p.name)}" placeholder="Mi perfil de lectura" />
    <label class="appset-label" for="prof-soul">Personalidad y rol del agente</label>
    <textarea id="prof-soul" class="appset-input" rows="3" placeholder="Cómo debe comportarse y con qué tono">${escapeHtml(p.soul)}</textarea>
    <label class="appset-label" for="prof-user">Sobre ti (perfil de usuario)</label>
    <textarea id="prof-user" class="appset-input" rows="3" placeholder="Quién eres, tu nivel, tus intereses">${escapeHtml(p.userProfile)}</textarea>
    <label class="appset-label" for="prof-notes">Notas permanentes</label>
    <textarea id="prof-notes" class="appset-input" rows="3" placeholder="Algo que el agente deba tener siempre en cuenta">${escapeHtml(p.notes)}</textarea>
    <p class="appset-err" id="prof-err" hidden></p>
    <div class="appset-tpl-formacts">
      <button id="prof-cancel" class="appset-tpl-cancel">Cancelar</button>
      <button id="prof-save" class="primary-btn">Guardar perfil</button>
    </div>
  </div>`;
}

function readProfileForm(content) {
  profDraft.name = content.querySelector('#prof-name').value;
  profDraft.soul = content.querySelector('#prof-soul').value;
  profDraft.userProfile = content.querySelector('#prof-user').value;
  profDraft.notes = content.querySelector('#prof-notes').value;
}

function wireProfileForm(content) {
  content.querySelector('#prof-cancel').addEventListener('click', () => {
    profDraft = null; renderProfiles(content);
  });
  content.querySelector('#prof-save').addEventListener('click', () => {
    readProfileForm(content);
    const err = Profiles.validate(profDraft);
    if (err) {
      const el = content.querySelector('#prof-err');
      el.textContent = err; el.hidden = false;
      return;
    }
    const saved = Profiles.save(profDraft);
    // Primer perfil creado: actívalo automáticamente (atajo razonable).
    if (!Profiles.getActiveId() && Profiles.getAll().length === 1) Profiles.setActiveId(saved.id);
    notifyProfileChange();   // refresca el chip (p. ej. si se renombró el activo)
    profDraft = null; renderProfiles(content);
  });
}

// ---- Sección Datos (P3) ----------------------------------------------------

function dataHtml() {
  return `<div class="appset-section">
    <h3 class="appset-h3">Datos</h3>
    <p class="appset-muted">Copia de seguridad de tus datos para guardarla o migrar a otro dispositivo:
      ajustes, subrayados, marcadores, plantillas propias, conversaciones y libretas.
      <strong>No</strong> incluye la API key ni los archivos de los libros.</p>
    <button id="appset-export-json" class="primary-btn appset-save">${icon('share', { size: 15 })} Descargar backup (JSON)</button>
    <button id="appset-export-md" class="appset-tpl-cancel appset-data-md">${icon('note', { size: 15 })} Descargar resumen (Markdown)</button>

    <label class="appset-label" style="margin-top:18px">Importar backup</label>
    <p class="appset-muted">Restaura desde un JSON. Fusiona: sobrescribe lo que coincida, no borra el resto.</p>
    <input type="file" id="appset-import-file" class="appset-input" accept="application/json,.json" />
    <p class="appset-data-msg" id="appset-data-msg" hidden></p>
  </div>`;
}

function wireData(content) {
  const msg = content.querySelector('#appset-data-msg');
  const show = (html, error = false) => {
    msg.innerHTML = html;
    msg.classList.toggle('is-error', error);
    msg.hidden = false;
  };

  content.querySelector('#appset-export-json').addEventListener('click', () => {
    Backup.downloadBackup().catch(e => show('No se pudo exportar: ' + e.message, true));
  });
  content.querySelector('#appset-export-md').addEventListener('click', () => {
    Backup.downloadMarkdown().catch(e => show('No se pudo exportar: ' + e.message, true));
  });

  content.querySelector('#appset-import-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const obj = JSON.parse(await file.text());
      const r = await Backup.importBackup(obj);
      show(`${icon('check', { size: 14 })} Importado: ${r.localKeys} ajustes y ${r.aiRecords} registros. <button id="appset-reload" class="appset-data-reload">Recargar para aplicar</button>`);
      content.querySelector('#appset-reload').addEventListener('click', () => location.reload());
    } catch (err) {
      show('No se pudo importar: ' + err.message, true);
    } finally {
      e.target.value = '';   // permitir reimportar el mismo archivo
    }
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
