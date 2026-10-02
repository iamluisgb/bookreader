// Selectores dentro del composer (perfil · modelo) y el botón de saltar al inicio de la
// última respuesta. Inspirado en la web de Hermes: lo que se cambia A MITAD de una
// conversación se cambia donde se escribe, sin salir a Ajustes. Ajustes sigue siendo el
// sitio de configurar (proveedor, key, crear perfiles); aquí solo se ELIGE entre lo que
// ya hay, y cada menú lleva al final el atajo a Ajustes para lo demás.
//
// Los cambios se aplican al siguiente mensaje: el perfil y el modelo se leen al construir
// cada petición (systemPrompt · getModel), así que no hay estado que propagar.
import { t } from '../i18n.js';
import * as LLM from './llm.js';
import * as Profiles from './profiles.js';
import { icon } from '../ui/icons.js';
import { escapeHtml } from '../ui/escape.js';

let menuEl = null;
let host = null;
let openSettings = () => {};

function closeMenu() {
  menuEl?.remove();
  menuEl = null;
  document.removeEventListener('mousedown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
}
function onOutside(e) { if (menuEl && !menuEl.contains(e.target) && !e.target.closest?.('.ai-pick')) closeMenu(); }
function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeMenu(); } }

// El composer está abajo: el menú se abre HACIA ARRIBA del botón, alineado a su izquierda.
function openMenu(anchor, html, onPick) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'lib-menu ai-pick-menu';
  menu.innerHTML = html;
  // .lib-menu nace oculto (es el menú de la biblioteca, que lo muestra al posicionarlo).
  menu.style.display = 'block';
  document.body.appendChild(menu);
  menuEl = menu;
  const r = anchor.getBoundingClientRect();
  const w = Math.max(220, menu.offsetWidth);
  menu.style.position = 'fixed';
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
  menu.style.bottom = (window.innerHeight - r.top + 6) + 'px';
  menu.addEventListener('click', (ev) => {
    const item = ev.target.closest('.lib-menu-item');
    if (!item) return;
    closeMenu();
    onPick(item.dataset);
  });
  setTimeout(() => {
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
  });
}

const check = (on) => `<span class="lib-menu-check">${on ? icon('check', { size: 16 }) : ''}</span>`;

// ---- Perfil ------------------------------------------------------------------

function openProfileMenu(anchor) {
  const all = Profiles.getAll();
  const active = Profiles.getActiveId();
  openMenu(anchor, `
    ${all.map(p => `<button class="lib-menu-item" data-profile="${escapeHtml(p.id)}">${check(p.id === active)}<span>${escapeHtml(p.name)}</span></button>`).join('')}
    <button class="lib-menu-item" data-profile="">${check(!active)}<span>${t('Sin perfil')}</span></button>
    <div class="lib-menu-sep"></div>
    <button class="lib-menu-item" data-go="profiles">${icon('gear', { size: 16 })}<span>${all.length ? t('Gestionar perfiles…') : t('Crear un perfil…')}</span></button>
  `, (d) => {
    if (d.go) { openSettings(d.go); return; }
    Profiles.setActiveId(d.profile || null);
    // El mismo aviso que Ajustes: quien pinta el perfil (aquí y en el panel) se entera.
    window.dispatchEvent(new CustomEvent('appsettings:profile-changed'));
  });
}

// ---- Modelo ------------------------------------------------------------------

// «google/gemini-2.5-flash» → «gemini-2.5-flash»: en un botón estrecho, el proveedor
// sobra (ya se sabe cuál es).
const short = (m) => String(m || '').split('/').pop();

function modelLabel() {
  return LLM.isDemo() ? t('Demo') : short(LLM.getModel());
}

function modelOptions() {
  const p = LLM.currentProvider();
  const list = [...(p?.models || [])];
  const cur = LLM.getModel();
  if (cur && !list.includes(cur)) list.unshift(cur);   // uno elegido en avanzadas también sale
  return list;
}

function openModelMenu(anchor) {
  if (LLM.isDemo()) {
    // La demo trae su propio modelo y no se elige: lo útil aquí es la salida.
    openMenu(anchor, `
      <div class="ai-pick-note">${t('Estás usando la demo gratuita.')}</div>
      <button class="lib-menu-item" data-go="agent">${icon('gear', { size: 16 })}<span>${t('Usar mi propia API key…')}</span></button>
    `, (d) => openSettings(d.go));
    return;
  }
  const cur = LLM.getModel();
  const name = LLM.currentProvider()?.name;
  openMenu(anchor, `
    ${name ? `<div class="ai-pick-note">${escapeHtml(name)}</div>` : ''}
    ${modelOptions().map(m => `<button class="lib-menu-item" data-model="${escapeHtml(m)}">${check(m === cur)}<span>${escapeHtml(m)}</span></button>`).join('')}
    <div class="lib-menu-sep"></div>
    <button class="lib-menu-item" data-go="agent">${icon('gear', { size: 16 })}<span>${t('Más modelos y proveedores…')}</span></button>
  `, (d) => {
    if (d.go) { openSettings(d.go); return; }
    LLM.setModel(d.model);
    window.dispatchEvent(new CustomEvent('appsettings:agent-saved'));
  });
}

// ---- Montaje -----------------------------------------------------------------

export function render() {
  if (!host) return;
  const prof = host.querySelector('[data-pick="profile"] .ai-pick-label');
  const model = host.querySelector('[data-pick="model"] .ai-pick-label');
  // Sin perfil, solo el icono: «Sin perfil» ocupaba media fila para no decir nada, y el
  // modelo —que sí cambia cosas— se quedaba cortado en un panel de 380 px.
  const active = Profiles.getActive();
  if (prof) { prof.textContent = active ? active.name : ''; prof.hidden = !active; }
  const pb = host.querySelector('[data-pick="profile"]');
  if (pb) pb.title = active ? t('Perfil: {name}', { name: active.name }) : t('Perfil del agente: ninguno');
  if (model) model.textContent = LLM.hasKey() ? modelLabel() : t('Sin modelo');
  pb?.classList.toggle('is-set', !!active);
}

export function mount(el, { settings }) {
  host = el;
  openSettings = settings || openSettings;
  host.innerHTML = `
    <button type="button" class="ai-pick" data-pick="profile" title="${t('Perfil del agente')}">${icon('user', { size: 14 })}<span class="ai-pick-label"></span>${icon('chevron-down', { size: 12 })}</button>
    <button type="button" class="ai-pick" data-pick="model" title="${t('Modelo')}">${icon('sparkles', { size: 14 })}<span class="ai-pick-label"></span>${icon('chevron-down', { size: 12 })}</button>`;
  host.addEventListener('click', (e) => {
    const b = e.target.closest('.ai-pick');
    if (!b) return;
    if (menuEl) { closeMenu(); return; }
    if (b.dataset.pick === 'profile') openProfileMenu(b);
    else openModelMenu(b);
  });
  for (const ev of ['appsettings:agent-saved', 'appsettings:profile-changed', 'llm:demo-auto']) {
    window.addEventListener(ev, render);
  }
  render();
}

// ---- Saltar al inicio de la última respuesta ---------------------------------
// El botón redondo de la derecha. Las respuestas del agente son largas y con citas, y se
// leen desde arriba: al terminar de llegar, el chat queda al FINAL y el principio fuera de
// la vista. El botón aparece cuando ese principio no se ve y lleva a él; la flecha apunta
// hacia donde está.

export function mountJump(messages, btn) {
  const last = () => {
    const all = messages.querySelectorAll('.ai-msg-assistant');
    return all[all.length - 1] || null;
  };
  const update = () => {
    const a = last();
    if (!a) { btn.hidden = true; return; }
    const top = a.offsetTop;   // .ai-messages es position:relative (agent.css)
    const view = messages.scrollTop;
    const above = top < view - 24;
    const below = top > view + messages.clientHeight - 48;
    btn.hidden = !(above || below);
    btn.classList.toggle('is-down', below);
    // Pegado a la esquina inferior derecha de la LISTA (no del panel): debajo está el
    // composer, cuya altura cambia al escribir varias líneas.
    btn.style.top = (messages.offsetTop + messages.clientHeight - 52) + 'px';
  };
  btn.addEventListener('click', () => {
    const a = last();
    if (!a) return;
    messages.scrollTo({ top: a.offsetTop - 8, behavior: 'smooth' });
  });
  messages.addEventListener('scroll', update, { passive: true });
  // Llegan mensajes y crecen mientras se escriben: se recalcula sin sondear.
  new MutationObserver(() => requestAnimationFrame(update)).observe(messages, { childList: true, subtree: true, characterData: true });
  window.addEventListener('resize', update);
  update();
}
