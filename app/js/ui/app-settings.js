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
import { confirmBox } from './dialog.js';

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

function modelDatalist(models) {
  return models.map(m => `<option value="${escapeHtml(m)}"></option>`).join('');
}

function agentHtml() {
  const cur = LLM.currentProvider();
  const provOpts = LLM.PROVIDERS.map(p =>
    `<option value="${p.id}"${cur && cur.id === p.id ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join('')
    + `<option value="custom"${cur ? '' : ' selected'}>Personalizado</option>`;
  const suggested = (cur || LLM.PROVIDERS[0]).models;
  return `<div class="appset-section">
    <h3 class="appset-h3">Agente</h3>
    <label class="appset-label" for="appset-provider">Proveedor</label>
    <select id="appset-provider" class="appset-input">${provOpts}</select>
    <label class="appset-label" for="appset-baseurl">Base URL (endpoint OpenAI-compatible)</label>
    <input id="appset-baseurl" class="appset-input" value="${escapeHtml(LLM.getBaseUrl())}" placeholder="https://…/v1" autocomplete="off" spellcheck="false" />
    <label class="appset-label" for="appset-model">Modelo</label>
    <div class="appset-model-row">
      <input id="appset-model" class="appset-input" list="appset-model-list" value="${escapeHtml(LLM.getModel())}" placeholder="id-del-modelo" autocomplete="off" spellcheck="false" />
      <button type="button" id="appset-model-discover" class="appset-discover">Descubrir</button>
    </div>
    <datalist id="appset-model-list">${modelDatalist(suggested)}</datalist>
    <div id="appset-model-chips" class="appset-chips"></div>
    <p class="appset-muted appset-model-manual">Escribe el id del modelo a mano o elige uno de los sugeridos. «Descubrir» los lista automáticamente si el proveedor lo permite (nan no lo permite desde el navegador).</p>
    <p id="appset-model-hint" class="appset-model-hint" hidden></p>
    <label class="appset-label" for="appset-vmodel">Modelo de visión (opcional)</label>
    <input id="appset-vmodel" class="appset-input" value="${escapeHtml(LLM.getVisionModel())}" placeholder="p. ej. mimo-v2.5" autocomplete="off" spellcheck="false" />
    <p class="appset-muted">Para explicar figuras y páginas de un libro (multimodal). En nan, <code>mimo-v2.5</code> funciona. Déjalo vacío si tu modelo no interpreta imágenes; entonces "Explicar lo que veo" queda desactivado.</p>
    <label class="appset-label" for="appset-key">API key</label>
    <input id="appset-key" class="appset-input" type="password" placeholder="sk-..." autocomplete="off" value="${escapeHtml(LLM.getKey())}" />
    <label class="appset-check"><input type="checkbox" id="appset-auto"${LLM.getAutoExtract() ? ' checked' : ''} /> Rellenar la libreta automáticamente</label>
    <button id="appset-save" class="primary-btn appset-save">Guardar</button>
    <p class="appset-saved" id="appset-saved" hidden>${icon('check', { size: 14 })} Guardado</p>
    <p class="appset-privacy">${icon('shield', { size: 13 })} Tu API key se guarda solo en este navegador. Para responder, el contenido del libro se envía al proveedor que configures.</p>
  </div>`;
}

function wireAgent(content) {
  const prov = content.querySelector('#appset-provider');
  const baseUrl = content.querySelector('#appset-baseurl');
  const model = content.querySelector('#appset-model');
  const dl = content.querySelector('#appset-model-list');
  const chips = content.querySelector('#appset-model-chips');
  const hint = content.querySelector('#appset-model-hint');
  const discover = content.querySelector('#appset-model-discover');
  const keyEl = content.querySelector('#appset-key');

  // Lista visible de modelos (chips clicables). En escritorio el datalist no se
  // despliega si el input ya tiene valor, así que estos chips son el modo fiable de
  // ver y elegir modelos. El activo se marca según el valor del input.
  const markActiveChip = () => {
    const v = model.value.trim();
    chips.querySelectorAll('.appset-chip').forEach(c =>
      c.classList.toggle('active', c.dataset.model === v));
  };
  const renderChips = (list) => {
    chips.innerHTML = (list || []).map(m =>
      `<button type="button" class="appset-chip" data-model="${escapeHtml(m)}">${escapeHtml(m)}</button>`).join('');
    markActiveChip();
  };
  chips.addEventListener('click', (e) => {
    const c = e.target.closest('.appset-chip');
    if (!c) return;
    model.value = c.dataset.model;
    markActiveChip();
  });
  model.addEventListener('input', markActiveChip);

  const suggested = (LLM.currentProvider() || LLM.PROVIDERS[0]).models;
  renderChips(suggested);

  // Al elegir un preset: rellena Base URL + sugerencias de modelo (chips + datalist).
  // "Personalizado" deja los campos como están para editarlos a mano.
  prov.addEventListener('change', () => {
    const p = LLM.PROVIDERS.find(x => x.id === prov.value);
    if (!p) return;
    baseUrl.value = p.baseUrl;
    dl.innerHTML = modelDatalist(p.models);
    renderChips(p.models);
    hint.hidden = true;
    if (!p.models.includes(model.value.trim())) { model.value = p.models[0]; markActiveChip(); }
  });

  // Descubrir modelos reales del proveedor (GET /models) con los valores actuales del
  // formulario (aún sin guardar), y rellenar los chips + el datalist.
  discover.addEventListener('click', async () => {
    hint.hidden = false; hint.classList.remove('is-error');
    hint.textContent = 'Buscando modelos…'; discover.disabled = true;
    try {
      const models = await LLM.listModels({ baseUrl: baseUrl.value, key: keyEl.value });
      if (!models.length) { hint.textContent = 'El proveedor no devolvió modelos. Escribe el id del modelo a mano.'; return; }
      dl.innerHTML = modelDatalist(models);
      renderChips(models);
      hint.textContent = `${models.length} modelos disponibles — pulsa uno para elegirlo.`;
    } catch (e) {
      // El discovery puede fallar por CORS (el proveedor no expone /models al navegador)
      // o por key inválida. En ambos casos el camino es escribir el modelo a mano: lo
      // decimos claramente y dejamos los chips sugeridos para elegir con un toque.
      hint.classList.add('is-error');
      hint.textContent = e.cors
        ? 'Este proveedor no permite descubrir modelos desde el navegador. Escribe el id del modelo a mano o elige uno de los sugeridos abajo.'
        : `No se pudieron descubrir los modelos: ${e.message} Escribe el id a mano o elige uno de los sugeridos.`;
      renderChips((LLM.PROVIDERS.find(p => p.baseUrl.replace(/\/+$/, '') === baseUrl.value.trim().replace(/\/+$/, '')) || LLM.PROVIDERS[0]).models);
      model.focus();
    } finally {
      discover.disabled = false;
    }
  });

  content.querySelector('#appset-save').addEventListener('click', () => {
    LLM.setKey(content.querySelector('#appset-key').value.trim());
    LLM.setBaseUrl(baseUrl.value);
    LLM.setModel(model.value);
    LLM.setVisionModel(content.querySelector('#appset-vmodel').value);
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
    b.addEventListener('click', async () => {
      if (await confirmBox('¿Eliminar esta plantilla? Las conversaciones que la usen perderán su estructura de libreta.',
          { title: 'Eliminar plantilla', okText: 'Eliminar', danger: true })) {
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

function templateFieldRow(f = { key: '', label: '', type: 'text', fill: 'agent' }) {
  const cog = f.fill === 'user';
  return `<div class="appset-tpl-field-row" data-key="${escapeHtml(f.key || '')}">
    <input class="appset-input appset-tpl-field-label" value="${escapeHtml(f.label || '')}" placeholder="Etiqueta del campo" />
    <select class="appset-input appset-tpl-field-type">
      <option value="text"${f.type !== 'list' ? ' selected' : ''}>Texto</option>
      <option value="list"${f.type === 'list' ? ' selected' : ''}>Lista</option>
    </select>
    <select class="appset-input appset-tpl-field-fill" title="Quién rellena el campo">
      <option value="agent"${!cog ? ' selected' : ''}>IA (info)</option>
      <option value="user"${cog ? ' selected' : ''}>Tú (cognición)</option>
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
    fill: row.querySelector('.appset-tpl-field-fill').value,
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
    b.addEventListener('click', async () => {
      if (await confirmBox('¿Eliminar este perfil? Si estaba activo, el agente quedará sin perfil.',
          { title: 'Eliminar perfil', okText: 'Eliminar', danger: true })) {
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
