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
import { escapeHtml } from './escape.js';
import { t } from '../i18n.js';

let openDialog = null;   // solo un diálogo a la vez

function build({ kind, title, message, value, placeholder, okText, cancelText, danger }) {
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
    overlay.innerHTML = `
      <div class="dlg-card" role="${isAlert ? 'alertdialog' : 'dialog'}" aria-modal="true" aria-label="${escapeHtml(title || t('Aviso'))}">
        ${title ? `<h2 class="dlg-title">${escapeHtml(title)}</h2>` : ''}
        <div class="dlg-msg">${escapeHtml(message || '')}</div>
        ${isPrompt ? `<input class="dlg-input" type="text" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(placeholder || '')}" />` : ''}
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
    const onCancel = () => done(isPrompt ? null : false);
    const onOk = () => done(isPrompt ? (input ? input.value : '') : (isAlert ? undefined : true));

    // openDialog cierra el actual como cancelación (usado si se abre otro encima).
    openDialog = onCancel;

    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); return; }
      if (e.key === 'Enter' && (isAlert || isPrompt || document.activeElement === okBtn)) {
        // En prompt/alert, Enter confirma (salvo que el foco esté en Cancelar).
        if (document.activeElement !== cancelBtn) { e.preventDefault(); onOk(); return; }
      }
      if (e.key !== 'Tab') return;
      const f = [...card.querySelectorAll('button, input')].filter(el => el.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);

    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) onCancel(); });
    okBtn.addEventListener('click', onOk);
    cancelBtn?.addEventListener('click', onCancel);

    // Foco inicial: el input en prompt, si no el botón principal.
    (input || okBtn).focus();
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
