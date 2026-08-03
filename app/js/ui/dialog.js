// Diálogos propios (alert/confirm/prompt) que reemplazan a los nativos del navegador.
// Motivo: los nativos rompen la dirección de diseño ("silenciosa y precisa"), no son
// estilables, bloquean el hilo y se ven fuera de lugar en la PWA instalada. Estos son
// modales accesibles (role=dialog, aria-modal, foco atrapado, Escape/backdrop) y usan los
// tokens de tema. Sin dependencias; devuelven una promesa.
//
// API (async):
//   await alertBox(message, { title?, okText? })            -> void
//   await confirmBox(message, { title?, okText?, cancelText?, danger? }) -> boolean
//   await promptBox(message, { value?, title?, okText?, cancelText?, placeholder? }) -> string|null
//   await formBox({ title, message?, fields, okText?, cancelText? })  -> {name: valor}|null
import { escapeHtml } from './escape.js';
import { t } from '../i18n.js';

let openDialog = null;   // solo un diálogo a la vez

// Un campo de formBox: { name, label, type, value, options?, placeholder? }.
// type: 'text' | 'select' ({options: {valor: etiqueta}}) | 'checks' ({options: [{value,label}]}).
function fieldHtml(f) {
  const id = 'dlgf_' + f.name;
  const label = `<label class="dlg-field-lbl" for="${id}">${escapeHtml(t(f.label))}</label>`;
  if (f.type === 'select') {
    const opts = Object.entries(f.options || {}).map(([v, lbl]) =>
      `<option value="${escapeHtml(v)}"${v === String(f.value ?? '') ? ' selected' : ''}>${escapeHtml(t(lbl))}</option>`).join('');
    return `<div class="dlg-field">${label}<select class="dlg-input" id="${id}" data-field="${f.name}">${opts}</select></div>`;
  }
  if (f.type === 'checks') {
    const on = new Set(f.value || []);
    const opts = (f.options || []).map(o =>
      `<label class="dlg-check"><input type="checkbox" data-check="${f.name}" value="${escapeHtml(o.value)}"${on.has(o.value) ? ' checked' : ''}>
        <span>${escapeHtml(o.label)}</span></label>`).join('');
    return `<div class="dlg-field">${label}<div class="dlg-checks">${opts || `<span class="dlg-field-empty">${escapeHtml(t(f.emptyText || 'Nada que elegir'))}</span>`}</div></div>`;
  }
  return `<div class="dlg-field">${label}<input class="dlg-input" id="${id}" type="text" data-field="${f.name}"
    value="${escapeHtml(f.value == null ? '' : String(f.value))}" placeholder="${escapeHtml(t(f.placeholder || ''))}"></div>`;
}

function build({ kind, title, message, value, placeholder, okText, cancelText, danger, fields }) {
  // i18n (P15): las cadenas constantes de los llamadores se traducen aquí (la clave es el
  // propio texto español); los mensajes interpolados llegan ya traducidos con t(..., params).
  title = title && t(title); message = message && t(message);
  okText = okText && t(okText); cancelText = cancelText && t(cancelText);
  placeholder = placeholder && t(placeholder);
  return new Promise((resolve) => {
    // Si ya hay uno abierto, ciérralo cancelando (evita apilar overlays).
    if (openDialog) { try { openDialog(); } catch (e) {} openDialog = null; }

    const prevFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'dlg-overlay';
    const isPrompt = kind === 'prompt';
    const isAlert = kind === 'alert';
    const isForm = kind === 'form';
    overlay.innerHTML = `
      <div class="dlg-card${isForm ? ' dlg-card--form' : ''}" role="${isAlert ? 'alertdialog' : 'dialog'}" aria-modal="true" aria-label="${escapeHtml(title || t('Aviso'))}">
        ${title ? `<h2 class="dlg-title">${escapeHtml(title)}</h2>` : ''}
        ${message ? `<div class="dlg-msg">${escapeHtml(message)}</div>` : (isForm ? '' : '<div class="dlg-msg"></div>')}
        ${isPrompt ? `<input class="dlg-input" type="text" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(placeholder || '')}" />` : ''}
        ${isForm ? `<div class="dlg-form">${(fields || []).map(fieldHtml).join('')}</div>` : ''}
        <div class="dlg-actions">
          ${isAlert ? '' : `<button class="dlg-btn dlg-cancel">${escapeHtml(cancelText || t('Cancelar'))}</button>`}
          <button class="dlg-btn dlg-ok${danger ? ' dlg-danger' : ''}">${escapeHtml(okText || t('Aceptar'))}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const card = overlay.querySelector('.dlg-card');
    const input = overlay.querySelector('.dlg-input');
    const okBtn = overlay.querySelector('.dlg-ok');
    const cancelBtn = overlay.querySelector('.dlg-cancel');

    const cleanup = () => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      openDialog = null;
      try { prevFocus?.focus?.(); } catch (e) { /* ya no existe */ }
    };
    const done = (result) => { cleanup(); resolve(result); };
    const onCancel = () => done(isPrompt || isForm ? null : false);
    const collect = () => {
      const out = {};
      for (const el of card.querySelectorAll('[data-field]')) out[el.dataset.field] = el.value;
      for (const f of (fields || [])) {
        if (f.type !== 'checks') continue;
        out[f.name] = [...card.querySelectorAll(`[data-check="${f.name}"]:checked`)].map(el => el.value);
      }
      return out;
    };
    const onOk = () => done(isForm ? collect() : isPrompt ? (input ? input.value : '') : (isAlert ? undefined : true));

    // openDialog cierra el actual como cancelación (usado si se abre otro encima).
    openDialog = onCancel;

    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); return; }
      if (e.key === 'Enter' && (isAlert || isPrompt || isForm || document.activeElement === okBtn)) {
        // En prompt/alert, Enter confirma (salvo que el foco esté en Cancelar).
        if (document.activeElement !== cancelBtn) { e.preventDefault(); onOk(); return; }
      }
      if (e.key !== 'Tab') return;
      const f = [...card.querySelectorAll('button, input, select')].filter(el => el.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);

    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) onCancel(); });
    okBtn.addEventListener('click', onOk);
    cancelBtn?.addEventListener('click', onCancel);

    // Foco inicial: el input en prompt, el primer campo en form, si no el botón principal.
    const firstField = isForm ? card.querySelector('.dlg-form [data-field], .dlg-form [data-check]') : null;
    (input || firstField || okBtn).focus();
    if (input) input.select();
  });
}

export function alertBox(message, opts = {}) {
  return build({ kind: 'alert', message, title: opts.title, okText: opts.okText || 'Entendido' });
}

export function confirmBox(message, opts = {}) {
  return build({ kind: 'confirm', message, title: opts.title, okText: opts.okText,
    cancelText: opts.cancelText, danger: opts.danger });
}

export function promptBox(message, opts = {}) {
  return build({ kind: 'prompt', message, title: opts.title, value: opts.value,
    placeholder: opts.placeholder, okText: opts.okText, cancelText: opts.cancelText });
}

// Formulario corto en modal. Devuelve un objeto {name: valor} o null si se
// cancela. Los valores llegan siempre como string (o array de strings en
// 'checks'): interpretarlos es cosa del llamador.
export function formBox(opts = {}) {
  return build({ kind: 'form', title: opts.title, message: opts.message, fields: opts.fields,
    okText: opts.okText, cancelText: opts.cancelText });
}
