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
import * as DriveAuth from '../sync/drive-auth.js';
import * as DriveSync from '../sync/drive-sync.js';
import * as SyncEngine from '../sync/engine.js';
import * as Recovery from '../sync/recovery.js';
import * as Profiles from '../ai/profiles.js';
import * as Backup from '../backup.js';
import * as License from '../license.js';
import { ensurePro } from './paywall.js';
import { icon } from './icons.js';
import { escapeHtml } from './escape.js';
import { confirmBox } from './dialog.js';
import { t, getLang, setLang } from '../i18n.js';

const SECTIONS = [
  { id: 'agent',     label: () => t('Agente'),     ico: 'sparkles' },
  { id: 'app',       label: () => t('Aplicación'), ico: 'gear' },
  { id: 'profiles',  label: () => t('Perfiles'),   ico: 'note' },
  { id: 'templates', label: () => t('Plantillas'), ico: 'note' },
  { id: 'data',      label: () => t('Datos'),      ico: 'share' },
  { id: 'license',   label: () => t('Licencia'),   ico: 'shield' },
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
    <div class="appset-card" role="dialog" aria-modal="true" aria-label="${t('Ajustes generales')}">
      <button class="appset-close" title="${t('Cerrar')}" aria-label="${t('Cerrar')}">${icon('xmark')}</button>
      <h2 class="appset-h2">${icon('gear', { size: 20 })} ${t('Ajustes generales')}</h2>
      <div class="appset-body">
        <nav class="appset-nav">
          ${SECTIONS.map(s => `<button class="appset-nav-item" data-section="${s.id}">${icon(s.ico, { size: 16 })}<span>${s.label()}</span></button>`).join('')}
        </nav>
        <div class="appset-content"></div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  // Cerrar: botón, click en el fondo, Escape.
  overlay.querySelector('.appset-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => {
    // El historial se apila encima y gestiona su propio Escape (retroceder/cerrar).
    if (e.key === 'Escape' && overlay.style.display !== 'none' && !historyIsOpen()) close();
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
  if (id === 'app') wireApp(content);
  if (id === 'data') wireData(content);
  if (id === 'license') wireLicense(content);
}

function renderSection(id) {
  if (id === 'agent') return agentHtml();
  if (id === 'app') return appHtml();
  if (id === 'data') return dataHtml();
  if (id === 'license') return licenseHtml();
  return '';
}

function modelDatalist(models) {
  return models.map(m => `<option value="${escapeHtml(m)}"></option>`).join('');
}

function agentHtml() {
  const cur = LLM.currentProvider();
  const provOpts = LLM.PROVIDERS.map(p =>
    `<option value="${p.id}"${cur && cur.id === p.id ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join('')
    + `<option value="custom"${cur ? '' : ' selected'}>${t('Personalizado')}</option>`;
  const suggested = (cur || LLM.PROVIDERS[0]).models;
  const demoBlock = LLM.hasKey() ? '' : `
    <div class="appset-demo">
      <button id="appset-demo-btn" class="primary-btn appset-save">${icon('sparkles', { size: 15 })} ${t('Probar la demo (sin API key)')}</button>
      <p class="appset-muted">${t('Un cupo de llamadas de prueba con el modelo de la casa, sin registro. Cuando se acabe, pon tu propia key (BYOK) — o configúrala ya abajo.')}</p>
      <p class="appset-model-hint" id="appset-demo-hint" hidden></p>
    </div>`;
  return `<div class="appset-section">
    <h3 class="appset-h3">${t('Agente')}</h3>
    ${demoBlock}
    <label class="appset-label" for="appset-provider">${t('Proveedor')}</label>
    <select id="appset-provider" class="appset-input">${provOpts}</select>
    <label class="appset-label" for="appset-baseurl">Base URL (endpoint OpenAI-compatible)</label>
    <input id="appset-baseurl" class="appset-input" value="${escapeHtml(LLM.getBaseUrl())}" placeholder="https://…/v1" autocomplete="off" spellcheck="false" />
    <label class="appset-label" for="appset-model">${t('Modelo')}</label>
    <div class="appset-model-row">
      <input id="appset-model" class="appset-input" list="appset-model-list" value="${escapeHtml(LLM.getModel())}" placeholder="id-del-modelo" autocomplete="off" spellcheck="false" />
      <button type="button" id="appset-model-discover" class="appset-discover">${t('Descubrir')}</button>
    </div>
    <datalist id="appset-model-list">${modelDatalist(suggested)}</datalist>
    <div id="appset-model-chips" class="appset-chips"></div>
    <p class="appset-muted appset-model-manual">${t('Escribe el id del modelo a mano o elige uno de los sugeridos. «Descubrir» los lista automáticamente si el proveedor lo permite (nan no lo permite desde el navegador).')}</p>
    <p id="appset-model-hint" class="appset-model-hint" hidden></p>
    <label class="appset-label" for="appset-vmodel">${t('Modelo de visión (opcional)')}</label>
    <input id="appset-vmodel" class="appset-input" value="${escapeHtml(LLM.getVisionModel())}" placeholder="p. ej. mimo-v2.5" autocomplete="off" spellcheck="false" />
    <p class="appset-muted">${t('Para explicar figuras y páginas de un libro (multimodal). En nan, <code>mimo-v2.5</code> funciona. Déjalo vacío si tu modelo no interpreta imágenes; entonces "Explicar lo que veo" queda desactivado.')}</p>
    <label class="appset-label" for="appset-lmodel">${t('Modelo rápido (opcional)')}</label>
    <input id="appset-lmodel" class="appset-input" value="${escapeHtml(LLM.getLiteModelSetting())}" placeholder="${escapeHtml(t('vacío = automático'))}" autocomplete="off" spellcheck="false" />
    <p class="appset-muted">${t('Para las llamadas auxiliares del agente (preparar búsquedas, puntuar capítulos): un modelo pequeño responde igual de bien y mucho más rápido. Vacío = automático (en nan usa <code>qwen3.6</code>; en otros proveedores, el modelo principal).')}</p>
    <label class="appset-label" for="appset-key">API key</label>
    <input id="appset-key" class="appset-input" type="password" placeholder="sk-..." autocomplete="off" value="${escapeHtml(LLM.getKey())}" />
    <label class="appset-check"><input type="checkbox" id="appset-auto"${LLM.getAutoExtract() ? ' checked' : ''} /> ${t('Rellenar la libreta automáticamente')}</label>
    <button id="appset-save" class="primary-btn appset-save">${t('Guardar')}</button>
    <p class="appset-saved" id="appset-saved" hidden>${icon('check', { size: 14 })} ${t('Guardado')}</p>
    <p class="appset-privacy">${icon('shield', { size: 13 })} ${t('Tu API key se guarda solo en este navegador. Para responder, el contenido del libro se envía al proveedor que configures.')}</p>
  </div>`;
}

function wireAgent(content) {
  // F3 · demo self-service: pide token al gateway, autoconfigura y refresca la sección.
  const demoBtn = content.querySelector('#appset-demo-btn');
  if (demoBtn) demoBtn.addEventListener('click', async () => {
    const hint = content.querySelector('#appset-demo-hint');
    demoBtn.disabled = true;
    hint.hidden = false; hint.classList.remove('is-error');
    hint.textContent = t('Creando tu demo…');
    try {
      const r = await LLM.requestDemoToken();
      window.dispatchEvent(new CustomEvent('appsettings:agent-saved'));
      selectSection('agent');   // re-render: campos rellenos, botón fuera
      const ok = overlay.querySelector('#appset-saved');
      if (ok) { ok.hidden = false; setTimeout(() => { ok.hidden = true; }, 2500); }
      void r;
    } catch (e) {
      hint.classList.add('is-error');
      hint.textContent = t('No se pudo activar la demo: {msg}', { msg: e.message });
      demoBtn.disabled = false;
    }
  });

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
    hint.textContent = t('Buscando modelos…'); discover.disabled = true;
    try {
      const models = await LLM.listModels({ baseUrl: baseUrl.value, key: keyEl.value });
      if (!models.length) { hint.textContent = t('El proveedor no devolvió modelos. Escribe el id del modelo a mano.'); return; }
      dl.innerHTML = modelDatalist(models);
      renderChips(models);
      hint.textContent = t('{n} modelos disponibles — pulsa uno para elegirlo.', { n: models.length });
    } catch (e) {
      // El discovery puede fallar por CORS (el proveedor no expone /models al navegador)
      // o por key inválida. En ambos casos el camino es escribir el modelo a mano: lo
      // decimos claramente y dejamos los chips sugeridos para elegir con un toque.
      hint.classList.add('is-error');
      hint.textContent = e.cors
        ? t('Este proveedor no permite descubrir modelos desde el navegador. Escribe el id del modelo a mano o elige uno de los sugeridos abajo.')
        : t('No se pudieron descubrir los modelos: {msg} Escribe el id a mano o elige uno de los sugeridos.', { msg: e.message });
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
    LLM.setLiteModel(content.querySelector('#appset-lmodel').value);
    LLM.setAutoExtract(content.querySelector('#appset-auto').checked);
    const ok = content.querySelector('#appset-saved');
    if (ok) { ok.hidden = false; setTimeout(() => { ok.hidden = true; }, 1800); }
    window.dispatchEvent(new CustomEvent('appsettings:agent-saved'));
  });
}

// ---- Sección Aplicación (P15: idioma) ---------------------------------------
// El idioma vive en localStorage ('bookreader_lang'); cambiarlo recarga la app para
// re-evaluar todo el chrome (los módulos leen t() al renderizar; sin re-render en caliente).

function appHtml() {
  const lang = getLang();
  return `<div class="appset-section">
    <h3 class="appset-h3">${t('Aplicación')}</h3>
    <label class="appset-label" for="appset-lang">${t('Idioma')} · Language</label>
    <select id="appset-lang" class="appset-input">
      <option value="en"${lang === 'en' ? ' selected' : ''}>English</option>
      <option value="es"${lang === 'es' ? ' selected' : ''}>Español</option>
    </select>
    <p class="appset-muted">${t('Idioma de la interfaz. El agente responde en el idioma en el que le escribas. Cambiarlo recarga la app.')}</p>
  </div>`;
}

function wireApp(content) {
  content.querySelector('#appset-lang').addEventListener('change', (e) => {
    setLang(e.target.value);
    location.reload();
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
    const items = allTemplates().filter(x => x.block === bl.id);
    return `<div class="appset-tpl-block">
      <div class="appset-tpl-block-h">${icon(bl.icon, { size: 15 })} ${escapeHtml(bl.label)}</div>
      ${items.map(tp => `
        <div class="appset-tpl-row">
          <div class="appset-tpl-meta">
            <span class="appset-tpl-name">${escapeHtml(tp.name)}</span>
            <span class="appset-tpl-ideal">${escapeHtml(tp.ideal || '')}</span>
          </div>
          ${tp.custom
            ? `<div class="appset-tpl-acts">
                 <button class="icon-btn appset-tpl-edit" data-id="${tp.id}" title="${t('Editar')}">${icon('pencil', { size: 15 })}</button>
                 <button class="icon-btn appset-tpl-del" data-id="${tp.id}" title="${t('Eliminar')}">${icon('trash', { size: 15 })}</button>
               </div>`
            : `<span class="appset-tpl-tag">${t('de fábrica')}</span>`}
        </div>`).join('')}
    </div>`;
  }).join('');
  return `<div class="appset-section">
    <h3 class="appset-h3">${t('Plantillas de libreta')}</h3>
    <p class="appset-muted">${t('Las plantillas de fábrica no se editan. Crea las tuyas: aparecerán en el onboarding del agente junto a ellas.')}</p>
    ${byBlock}
    <button id="appset-tpl-new" class="primary-btn appset-save">${icon('plus', { size: 15 })} ${t('Crear plantilla')}</button>
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

function templateFormHtml(tp) {
  const blockOpts = Object.values(BLOCKS).map(bl =>
    `<option value="${bl.id}"${tp.block === bl.id ? ' selected' : ''}>${escapeHtml(bl.label)}</option>`).join('');
  return `<div class="appset-section">
    <h3 class="appset-h3">${tp.id ? t('Editar plantilla') : t('Nueva plantilla')}</h3>
    <label class="appset-label" for="tpl-name">${t('Nombre')}</label>
    <input id="tpl-name" class="appset-input" value="${escapeHtml(tp.name)}" placeholder="${t('Mi plantilla')}" />
    <label class="appset-label" for="tpl-block">${t('Enfoque')}</label>
    <select id="tpl-block" class="appset-input">${blockOpts}</select>
    <label class="appset-label" for="tpl-ideal">${t('Ideal para')}</label>
    <input id="tpl-ideal" class="appset-input" value="${escapeHtml(tp.ideal)}" placeholder="${t('Para qué sirve esta lectura')}" />
    <label class="appset-label" for="tpl-goal">${t('Pregunta de objetivo')}</label>
    <input id="tpl-goal" class="appset-input" value="${escapeHtml(tp.goalPrompt)}" placeholder="${t('¿Qué quieres lograr con este libro?')}" />
    <label class="appset-label" for="tpl-role">${t('Rol del agente')}</label>
    <textarea id="tpl-role" class="appset-input" rows="3" placeholder="${t('Cómo debe ayudarte el agente con esta plantilla')}">${escapeHtml(tp.agentRole)}</textarea>
    <label class="appset-label">${t('Campos de la libreta')}</label>
    <div class="appset-tpl-fields">
      ${tp.fields.map(f => templateFieldRow(f)).join('')}
    </div>
    <button id="tpl-add-field" class="appset-tpl-addfield">${icon('plus', { size: 14 })} ${t('Añadir campo')}</button>
    <p class="appset-err" id="tpl-err" hidden></p>
    <div class="appset-tpl-formacts">
      <button id="tpl-cancel" class="appset-tpl-cancel">${t('Cancelar')}</button>
      <button id="tpl-save" class="primary-btn">${t('Guardar plantilla')}</button>
    </div>
  </div>`;
}

function templateFieldRow(f = { key: '', label: '', type: 'text', fill: 'agent' }) {
  const cog = f.fill === 'user';
  return `<div class="appset-tpl-field-row" data-key="${escapeHtml(f.key || '')}">
    <input class="appset-input appset-tpl-field-label" value="${escapeHtml(f.label || '')}" placeholder="${t('Etiqueta del campo')}" />
    <select class="appset-input appset-tpl-field-type">
      <option value="text"${f.type !== 'list' ? ' selected' : ''}>${t('Texto')}</option>
      <option value="list"${f.type === 'list' ? ' selected' : ''}>${t('Lista')}</option>
    </select>
    <select class="appset-input appset-tpl-field-fill" title="${t('Quién rellena el campo')}">
      <option value="agent"${!cog ? ' selected' : ''}>${t('IA (info)')}</option>
      <option value="user"${cog ? ' selected' : ''}>${t('Tú (cognición)')}</option>
    </select>
    <button class="icon-btn appset-tpl-field-del" title="${t('Quitar campo')}">${icon('xmark', { size: 15 })}</button>
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
    <h3 class="appset-h3">${t('Perfiles del agente')}</h3>
    <p class="appset-muted">${t('Persona del agente + quién eres + notas permanentes, reutilizables entre libros. El perfil activo se antepone al prompt en cada respuesta.')}</p>
    <p class="appset-prof-active">${t('Activo:')} <strong>${active ? escapeHtml(active.name) : t('ninguno')}</strong></p>
    ${profiles.length ? profiles.map(p => `
      <div class="appset-tpl-row${p.id === activeId ? ' is-active' : ''}">
        <div class="appset-tpl-meta">
          <span class="appset-tpl-name">${escapeHtml(p.name)}</span>
          <span class="appset-tpl-ideal">${escapeHtml(snippet(p)) || t('Sin contenido')}</span>
        </div>
        <div class="appset-tpl-acts">
          <button class="appset-prof-activate" data-id="${p.id}">${p.id === activeId ? t('Activo ✓') : t('Activar')}</button>
          <button class="icon-btn appset-prof-edit" data-id="${p.id}" title="${t('Editar')}">${icon('pencil', { size: 15 })}</button>
          <button class="icon-btn appset-prof-del" data-id="${p.id}" title="${t('Eliminar')}">${icon('trash', { size: 15 })}</button>
        </div>
      </div>`).join('') : `<p class="appset-muted">${t('Aún no hay perfiles.')}</p>`}
    <button id="appset-prof-new" class="primary-btn appset-save">${icon('plus', { size: 15 })} ${t('Crear perfil')}</button>
  </div>`;
}

function notifyProfileChange() {
  window.dispatchEvent(new CustomEvent('appsettings:profile-changed'));
}

function wireProfilesList(content) {
  content.querySelector('#appset-prof-new').addEventListener('click', async () => {
    // Gate Pro (MON2): crear perfiles es Pro; usar/activar los ya existentes sigue libre
    // (nadie pierde lo que ya tenía si su licencia caduca).
    if (!(await ensurePro('profiles'))) return;
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
    <h3 class="appset-h3">${p.id ? t('Editar perfil') : t('Nuevo perfil')}</h3>
    <label class="appset-label" for="prof-name">${t('Nombre')}</label>
    <input id="prof-name" class="appset-input" value="${escapeHtml(p.name)}" placeholder="${t('Mi perfil de lectura')}" />
    <label class="appset-label" for="prof-soul">${t('Personalidad y rol del agente')}</label>
    <textarea id="prof-soul" class="appset-input" rows="3" placeholder="${t('Cómo debe comportarse y con qué tono')}">${escapeHtml(p.soul)}</textarea>
    <label class="appset-label" for="prof-user">${t('Sobre ti (perfil de usuario)')}</label>
    <textarea id="prof-user" class="appset-input" rows="3" placeholder="${t('Quién eres, tu nivel, tus intereses')}">${escapeHtml(p.userProfile)}</textarea>
    <label class="appset-label" for="prof-notes">${t('Notas permanentes')}</label>
    <textarea id="prof-notes" class="appset-input" rows="3" placeholder="${t('Algo que el agente deba tener siempre en cuenta')}">${escapeHtml(p.notes)}</textarea>
    <p class="appset-err" id="prof-err" hidden></p>
    <div class="appset-tpl-formacts">
      <button id="prof-cancel" class="appset-tpl-cancel">${t('Cancelar')}</button>
      <button id="prof-save" class="primary-btn">${t('Guardar perfil')}</button>
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
    <h3 class="appset-h3">${t('Datos')}</h3>
    <p class="appset-muted">${t('Copia de seguridad de tus datos para guardarla o migrar a otro dispositivo: ajustes, subrayados, marcadores, plantillas propias, conversaciones y libretas. <strong>No</strong> incluye la API key ni los archivos de los libros.')}</p>
    <button id="appset-export-json" class="primary-btn appset-save">${icon('share', { size: 15 })} ${t('Descargar backup (JSON)')}</button>
    <button id="appset-export-md" class="appset-tpl-cancel appset-data-md">${icon('note', { size: 15 })} ${t('Descargar resumen (Markdown)')}</button>

    <label class="appset-label" style="margin-top:18px">${t('Importar backup')}</label>
    <p class="appset-muted">${t('Restaura desde un JSON. Fusiona: sobrescribe lo que coincida, no borra el resto.')}</p>
    <input type="file" id="appset-import-file" class="appset-input" accept="application/json,.json" />

    <label class="appset-label" style="margin-top:18px">Google Drive</label>
    <p class="appset-muted">${t('Guarda tus datos en una carpeta privada de tu propio Drive. El único servidor implicado solo renueva tu permiso de Google: tus libros y notas van directos de tu navegador a tu Drive.')}</p>
    <div id="appset-drive-off">
      <button id="appset-drive-connect" class="primary-btn appset-save">${icon('upload', { size: 15 })} ${t('Conectar con Google Drive')}</button>
    </div>
    <div id="appset-drive-on" hidden>
      <button id="appset-drive-save" class="primary-btn appset-save">${icon('upload', { size: 15 })} ${t('Guardar en Drive')}</button>
      <button id="appset-drive-restore" class="appset-tpl-cancel appset-data-md">${icon('download', { size: 15 })} ${t('Restaurar desde Drive')}</button>
      <button id="appset-drive-history" class="appset-tpl-cancel appset-data-md">${icon('sort', { size: 15 })} ${t('Historial de versiones')}</button>
      <button id="appset-drive-purge" class="appset-tpl-cancel appset-data-md">${icon('trash', { size: 15 })} ${t('Limpiar entradas huérfanas')}</button>
      <button id="appset-drive-disconnect" class="appset-tpl-cancel appset-data-md">${t('Desconectar')}</button>
    </div>
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
    Backup.downloadBackup().catch(e => show(t('No se pudo exportar: {msg}', { msg: e.message }), true));
  });
  content.querySelector('#appset-export-md').addEventListener('click', () => {
    Backup.downloadMarkdown().catch(e => show(t('No se pudo exportar: {msg}', { msg: e.message }), true));
  });

  content.querySelector('#appset-import-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const obj = JSON.parse(await file.text());
      const r = await Backup.importBackup(obj);
      show(`${icon('check', { size: 14 })} ${t('Importado: {a} ajustes y {b} registros.', { a: r.localKeys, b: r.aiRecords })} <button id="appset-reload" class="appset-data-reload">${t('Recargar para aplicar')}</button>`);
      content.querySelector('#appset-reload').addEventListener('click', () => location.reload());
    } catch (err) {
      show(t('No se pudo importar: {msg}', { msg: err.message }), true);
    } finally {
      e.target.value = '';   // permitir reimportar el mismo archivo
    }
  });

  wireDrive(content, show);
}

// ---- Google Drive (sync Fase 1: guardar/restaurar manual) -------------------

function wireDrive(content, show) {
  const offBlock = content.querySelector('#appset-drive-off');
  const onBlock = content.querySelector('#appset-drive-on');
  const refresh = () => {
    const on = DriveAuth.isConnected();
    offBlock.hidden = on;
    onBlock.hidden = !on;
  };
  refresh();

  // El error 'reconnect' (token revocado/caducado) degrada a "conectar de nuevo".
  const fail = (prefix) => (err) => {
    if (err.message === 'reconnect') {
      refresh();
      show(t('El permiso de Google caducó o fue revocado. Vuelve a conectar con Drive.'), true);
    } else {
      show(t(prefix) + ': ' + err.message, true);
    }
  };

  content.querySelector('#appset-drive-connect').addEventListener('click', () => {
    show(t('Abriendo la ventana de Google…'));
    DriveAuth.connect()
      .then(() => {
        refresh();
        show(`${icon('check', { size: 14 })} ${t('Drive conectado. La sincronización automática queda activada.')}`);
        SyncEngine.refreshConnection(); // primer sync inmediato
      })
      .catch(fail('No se pudo conectar'));
  });

  content.querySelector('#appset-drive-disconnect').addEventListener('click', () => {
    DriveAuth.disconnect();
    SyncEngine.refreshConnection();
    refresh();
    show(t('Drive desconectado. Tus datos siguen en tu Drive y en este dispositivo.'));
  });

  content.querySelector('#appset-drive-save').addEventListener('click', () => {
    show(t('Guardando en Drive…'));
    DriveSync.saveToDrive((done, total) => show(`${t('Guardando en Drive…')} ${done}/${total}`))
      .then(r => show(`${icon('check', { size: 14 })} ${t('Guardado en Drive ({n} {libros}).', { n: r.books, libros: r.books === 1 ? t('libro') : t('libros') })}`))
      .catch(fail('No se pudo guardar'));
  });

  content.querySelector('#appset-drive-restore').addEventListener('click', () => {
    show(t('Restaurando desde Drive…'));
    DriveSync.restoreFromDrive((done, total) => show(`${t('Restaurando…')} ${done}/${total}`))
      .then(r => {
        if (!r) return show(t('No hay nada guardado en Drive todavía.'), true);
        show(`${icon('check', { size: 14 })} ${t('Restaurado: {a} ajustes y {b} registros.', { a: r.keys, b: r.records })} <button id="appset-drive-reload" class="appset-data-reload">${t('Recargar para aplicar')}</button>`);
        content.querySelector('#appset-drive-reload').addEventListener('click', () => location.reload());
      })
      .catch(fail('No se pudo restaurar'));
  });

  content.querySelector('#appset-drive-purge').addEventListener('click', async () => {
    const yes = await confirmBox(
      'Quita del historial de Drive las entradas “Sin título” bajo identidades viejas (de epub.js o del nombre de fichero), restos de versiones anteriores. No toca tus libros actuales. Es irreversible y puede perder subrayados muy antiguos que nunca se migraron. Te recomiendo “Descargar backup (JSON)” antes.',
      { title: 'Limpiar entradas huérfanas', okText: 'Limpiar', cancelText: 'Cancelar', danger: true }
    );
    if (!yes) return;
    show(t('Limpiando…'));
    try {
      const r = await Recovery.purgeOrphans();
      SyncEngine.syncNow();   // propaga el manifest limpio al resto de dispositivos
      show(`${icon('check', { size: 14 })} ${t('Limpieza hecha: {n} {entradas}.', { n: r.removed, entradas: r.removed === 1 ? t('entrada quitada') : t('entradas quitadas') })}`);
    } catch (e) { fail('No se pudo limpiar')(e); }
  });

  wireRecovery(content, show, fail);
}

// ---- Sección Licencia (MON2: BookReader Pro vía Polar) ----------------------
// Estados: Free (input para activar + compra), Pro (key enmascarada + gestión de
// dispositivos en el portal), revocada (aviso + reactivar). Los datos nunca se tocan.

function maskKey(key) {
  return key.length > 9 ? `${key.slice(0, 5)}…${key.slice(-4)}` : key;
}

function licenseHtml() {
  const s = License.getState();
  const mockNote = License.isMock()
    ? `<p class="appset-muted appset-lic-mock">${icon('shield', { size: 13 })} ${t('Modo simulado (aún sin plataforma de pagos): cualquier clave <code>BKRD-…</code> activa Pro para probar.')}</p>`
    : '';

  if (s && s.key && !s.revoked) {
    const since = s.validatedAt ? new Date(s.validatedAt).toLocaleDateString(getLang()) : '';
    return `<div class="appset-section">
      <h3 class="appset-h3">${t('Licencia')}</h3>
      <p class="appset-lic-state is-pro">${icon('check', { size: 15 })} ${t('BookReader Pro activo')}</p>
      <p class="appset-muted">${t('Clave {key} · última verificación: {date}. Sin conexión, tu licencia sigue activa hasta 30 días.', { key: escapeHtml(maskKey(s.key)), date: escapeHtml(since) })}</p>
      <button id="appset-lic-portal" class="primary-btn appset-save">${icon('user', { size: 15 })} ${t('Gestionar dispositivos y recibos')}</button>
      <button id="appset-lic-remove" class="appset-tpl-cancel appset-data-md">${t('Quitar la licencia de este navegador')}</button>
      <p class="appset-muted">${t('Quitar la licencia aquí no libera el hueco de dispositivo: eso se hace en el portal.')}</p>
      ${mockNote}
    </div>`;
  }

  const revokedNote = s && s.revoked
    ? `<p class="appset-err">${t('Tu licencia dejó de ser válida (¿reembolso o revocación?). Tus datos siguen intactos; la app vuelve al plan Free.')}</p>`
    : '';
  return `<div class="appset-section">
    <h3 class="appset-h3">${t('Licencia')}</h3>
    ${revokedNote}
    <p class="appset-muted">${t('BookReader Pro desbloquea flashcards con export a Anki, repaso espaciado, mapas mentales, plantillas avanzadas y perfiles. {price}, sin suscripción.', { price: escapeHtml(License.CONFIG.price) })}</p>
    <label class="appset-label" for="appset-lic-key">${t('Clave de licencia')}</label>
    <input id="appset-lic-key" class="appset-input" placeholder="BKRD-XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false" />
    <button id="appset-lic-activate" class="primary-btn appset-save">${t('Activar en este dispositivo')}</button>
    ${License.CONFIG.checkoutUrl ? `<button id="appset-lic-buy" class="appset-tpl-cancel appset-data-md">${t('Conseguir BookReader Pro')}</button>` : ''}
    <p class="appset-err" id="appset-lic-err" hidden></p>
    <p class="appset-muted">${t('La clave llega por email al comprar y siempre puedes recuperarla en el portal de cliente.')}</p>
    ${mockNote}
  </div>`;
}

function wireLicense(content) {
  const portal = content.querySelector('#appset-lic-portal');
  if (portal) {
    portal.addEventListener('click', () => window.open(License.CONFIG.portalUrl, '_blank', 'noopener'));
    content.querySelector('#appset-lic-remove').addEventListener('click', async () => {
      if (await confirmBox(
        'La app volverá al plan Free en este navegador. Tus datos no se tocan y podrás reactivar con la misma clave.',
        { title: 'Quitar licencia', okText: 'Quitar' })) {
        License.removeLocal();
        selectSection('license');
      }
    });
    return;
  }

  const keyEl = content.querySelector('#appset-lic-key');
  const err = content.querySelector('#appset-lic-err');
  const btn = content.querySelector('#appset-lic-activate');
  btn.addEventListener('click', async () => {
    err.hidden = true;
    btn.disabled = true; btn.textContent = t('Activando…');
    try {
      await License.activate(keyEl.value);
      selectSection('license');
    } catch (e) {
      // El límite de activaciones nunca es un callejón sin salida: la causa típica es
      // una purga de storage del navegador; el portal libera el hueco fantasma.
      err.innerHTML = e.code === 'limit'
        ? `${escapeHtml(e.message)} ${t('¿Borraste datos de navegación o reinstalaste? Libera un dispositivo en')}
           <a href="${escapeHtml(License.CONFIG.portalUrl)}" target="_blank" rel="noopener">${t('el portal de cliente')}</a> ${t('y reintenta')}.`
        : escapeHtml(e.message);
      err.hidden = false;
      btn.disabled = false; btn.textContent = t('Activar en este dispositivo');
    }
  });
  content.querySelector('#appset-lic-buy')?.addEventListener('click', () =>
    window.open(License.CONFIG.checkoutUrl, '_blank', 'noopener'));
}

// ---- Historial de versiones (Fase 3: recuperación) --------------------------
//
// Overlay DEDICADO a pantalla completa (no un panel inline al fondo de Ajustes: eso
// enterraba un scroll anidado dentro de otro scroll — la queja del usuario). Una sola
// zona scrollable de altura completa (flex:1), cabecera sticky, buscador en vivo y
// drill-down libros→versiones que REEMPLAZA el contenido en vez de anexarlo. Se apila
// encima del overlay de Ajustes; al cerrar devuelve el foco al botón que lo abrió.

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString(getLang()); } catch { return iso; }
}

let histOverlay = null;
let histReturnFocus = null;

function historyIsOpen() {
  return histOverlay && histOverlay.style.display !== 'none';
}

function ensureHistoryOverlay() {
  if (histOverlay) return histOverlay;
  histOverlay = document.createElement('div');
  histOverlay.id = 'appset-history-overlay';
  histOverlay.className = 'appset histov';
  histOverlay.style.display = 'none';
  histOverlay.innerHTML = `
    <div class="histov-card" role="dialog" aria-modal="true" aria-labelledby="histov-title">
      <div class="histov-head">
        <button class="histov-back" type="button" hidden>${icon('chevron-left', { size: 16 })}<span>${t('Volver')}</span></button>
        <div class="histov-titles">
          <h2 class="histov-title" id="histov-title">${t('Historial de versiones')}</h2>
          <p class="histov-sub"></p>
        </div>
        <button class="histov-close" type="button" title="${t('Cerrar')}" aria-label="${t('Cerrar')}">${icon('xmark')}</button>
      </div>
      <div class="histov-search-wrap"><input type="search" class="histov-search" placeholder="${t('Buscar libro…')}" aria-label="${t('Buscar libro')}" /></div>
      <div class="histov-list"></div>
      <p class="histov-foot appset-muted">${t('Drive conserva las copias de cada libro unos 30 días.')}</p>
    </div>`;
  document.body.appendChild(histOverlay);
  histOverlay.querySelector('.histov-close').addEventListener('click', closeHistory);
  histOverlay.addEventListener('click', (e) => { if (e.target === histOverlay) closeHistory(); });
  return histOverlay;
}

function closeHistory() {
  if (histOverlay) histOverlay.style.display = 'none';
  const el = histReturnFocus; histReturnFocus = null;
  if (el && el.focus) el.focus();
}

function wireRecovery(content, show, fail) {
  const btn = content.querySelector('#appset-drive-history');
  btn.addEventListener('click', () => openHistory(btn, show, fail));
}

function openHistory(trigger, show, fail) {
  const ov = ensureHistoryOverlay();
  histReturnFocus = trigger || null;
  ov.style.display = 'flex';

  const backBtn = ov.querySelector('.histov-back');
  const titleEl = ov.querySelector('.histov-title');
  const subEl = ov.querySelector('.histov-sub');
  const searchWrap = ov.querySelector('.histov-search-wrap');
  const search = ov.querySelector('.histov-search');
  const list = ov.querySelector('.histov-list');
  let books = [];               // {id, title(raw|null), clean}
  let onBack = null;            // handler del nivel actual (null en el nivel raíz)

  // Esc: primero retrocede un nivel; si ya estás en la raíz, cierra.
  const onKey = (e) => {
    if (e.key !== 'Escape' || !historyIsOpen()) return;
    e.stopPropagation();        // que Ajustes no se cierre por debajo
    if (onBack) onBack(); else closeHistory();
  };
  ov.onkeydown = onKey;

  const setHead = (title, sub, back) => {
    titleEl.textContent = title;
    subEl.textContent = sub || '';
    onBack = back || null;
    backBtn.hidden = !back;
  };
  backBtn.onclick = () => { if (onBack) onBack(); };

  // --- Nivel 1: libros ---
  async function renderBooks() {
    setHead(t('Historial de versiones'), '', null);
    searchWrap.hidden = true;
    search.value = '';
    list.innerHTML = `<p class="appset-muted histov-pad">${t('Cargando libros…')}</p>`;
    try {
      books = (await Recovery.listBooks()).map(b => ({ ...b, clean: Recovery.cleanTitle(b.title) }));
      if (!books.length) {
        list.innerHTML = `<p class="appset-muted histov-empty">${t('Aún no hay copias en Drive. Pulsa “Guardar en Drive” para empezar a tener historial.')}</p>`;
        return;
      }
      searchWrap.hidden = books.length < 8;   // buscador solo cuando de verdad hace falta
      subEl.textContent = t('{n} {libros} con copias en Drive', { n: books.length, libros: books.length === 1 ? t('libro') : t('libros') });
      paintBooks('');
      (searchWrap.hidden ? list.querySelector('.histov-book') : search)?.focus();
    } catch (e) { fail('No se pudo cargar el historial')(e); closeHistory(); }
  }

  function paintBooks(q) {
    const needle = q.trim().toLowerCase();
    const shown = needle
      ? books.filter(b => (b.clean + ' ' + (b.title || '') + ' ' + b.id).toLowerCase().includes(needle))
      : books;
    if (!shown.length) {
      list.innerHTML = `<p class="appset-muted histov-empty">${t('Ningún libro coincide con «{q}».', { q: escapeHtml(q.trim()) })}</p>`;
      return;
    }
    const label = (b) => b.clean
      ? `<span class="histov-book-title">${escapeHtml(b.clean)}</span>`
      : `<span class="histov-book-title histov-untitled">${t('Sin título')}</span><span class="histov-book-id">${escapeHtml(b.id.slice(0, 16))}…</span>`;
    list.innerHTML = shown.map(b =>
      `<button class="histov-book" type="button" data-id="${escapeHtml(b.id)}" data-title="${escapeHtml(b.clean || t('Sin título'))}" title="${escapeHtml(b.clean || b.id)}">${label(b)}</button>`
    ).join('');
    list.querySelectorAll('.histov-book').forEach(el =>
      el.addEventListener('click', () => renderVersions(el.dataset.id, el.dataset.title)));
  }

  search.oninput = () => { if (!searchWrap.hidden) paintBooks(search.value); };

  // --- Nivel 2: versiones de un libro ---
  async function renderVersions(bookId, title) {
    setHead(title, t('Cargando…'), renderBooks);
    searchWrap.hidden = true;
    list.innerHTML = `<p class="appset-muted histov-pad">${t('Cargando versiones…')}</p>`;
    backBtn.focus();
    try {
      const versions = await Recovery.listVersions(bookId);
      if (!versions.length) {
        subEl.textContent = '';
        list.innerHTML = `<p class="appset-muted histov-empty">${t('Este libro solo tiene la versión actual.')}</p>`;
        return;
      }
      subEl.textContent = t('{n} {versiones}', { n: versions.length, versiones: versions.length === 1 ? t('versión guardada') : t('versiones guardadas') });
      list.innerHTML = versions.map((v, i) =>
        `<div class="histov-ver" data-file="${escapeHtml(v.fileId)}" data-rev="${escapeHtml(v.id)}">
          <div class="histov-ver-info">
            <span class="histov-ver-date">${fmtDate(v.modifiedTime)}${i === 0 ? t(' · actual') : ''}</span>
          </div>
          <button class="histov-ver-btn" type="button" ${i === 0 ? 'disabled' : ''}>${t('Restaurar')}</button>
        </div>`).join('');
      list.querySelectorAll('.histov-ver').forEach(row => {
        const rbtn = row.querySelector('.histov-ver-btn');
        if (rbtn.disabled) return;
        rbtn.addEventListener('click', () => restore(bookId, row.dataset.file, row.dataset.rev, title));
      });
    } catch (e) { fail('No se pudieron cargar las versiones')(e); }
  }

  async function restore(bookId, fileId, revisionId, title) {
    const yes = await confirmBox(
      t('Se re-añadirán los subrayados y marcadores de «{title}» que se hubieran borrado tras esa fecha. Lo que hayas añadido después se conserva.', { title }),
      { title: 'Recuperar esta versión', okText: 'Recuperar', cancelText: 'Cancelar' }
    );
    if (!yes) return;
    try {
      const r = await Recovery.restoreVersion(bookId, fileId, revisionId);
      SyncEngine.syncNow(); // propaga la recuperación al resto de dispositivos
      closeHistory();
      show(`${icon('check', { size: 14 })} ${t('Recuperados {n} elementos.', { n: r.recovered })} <button id="appset-rec-reload" class="appset-data-reload">${t('Recargar para aplicar')}</button>`);
      document.querySelector('#appset-rec-reload')?.addEventListener('click', () => location.reload());
    } catch (e) { fail('No se pudo recuperar')(e); }
  }

  renderBooks();
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
