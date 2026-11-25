// «Añadir un dispositivo» (docs/PROPUESTA_EMPAREJAR_DISPOSITIVOS.md, F2).
//
// Crea un código de emparejamiento de un solo uso y 10 minutos (BRAuth.createPairCode), lo
// enseña como QR y como enlace para copiar, cuenta atrás y consulta su estado cada 2 s: cuando
// el otro dispositivo lo reclama, dice cuál. Al cerrar sin usarlo, el código se anula.
//
// Si el Worker no puede crear el código, se dice y NO se vuelve al enlace permanente de antes.

import * as BRAuth from '../sync/bookreader-auth.js';
import { loadQrCode } from '../vendor-loader.js';
import { escapeHtml } from './escape.js';
import { t } from '../i18n.js';

const POLL_MS = 2000;

// QR como SVG: módulos negros sobre blanco SIEMPRE (también en tema oscuro), con margen de 4
// módulos: es lo que leen bien las cámaras.
export async function qrSvg(text) {
  const qrcode = await loadQrCode();
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const q = 4;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + q} ${r + q}h1v1h-1z`;
  }
  const size = n + q * 2;
  return `<svg class="pair-qr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="${escapeHtml(t('Código QR para añadir un dispositivo'))}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

export function openPairDialog({ onPaired } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'dlg-overlay';
  overlay.innerHTML = `
    <div class="dlg-card pair-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(t('Añadir un dispositivo'))}">
      <h2 class="dlg-title">${escapeHtml(t('Añadir un dispositivo'))}</h2>
      <div class="dlg-msg pair-msg">${escapeHtml(t('Escanea este código con el otro dispositivo, o ábrele el enlace. Vale para un solo dispositivo durante 10 minutos.'))}</div>
      <div class="pair-qr-box" aria-live="polite"></div>
      <p class="pair-timer" aria-live="off"></p>
      <p class="pair-state" role="status"></p>
      <div class="dlg-actions">
        <button type="button" class="dlg-btn pair-copy" hidden>${escapeHtml(t('Copiar enlace'))}</button>
        <button type="button" class="dlg-btn pair-again" hidden>${escapeHtml(t('Crear otro'))}</button>
        <button type="button" class="btn btn--primary dlg-btn pair-close">${escapeHtml(t('Cerrar'))}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const $ = (sel) => overlay.querySelector(sel);
  const box = $('.pair-qr-box');
  const timer = $('.pair-timer');
  const stateEl = $('.pair-state');
  const copyBtn = $('.pair-copy');
  const againBtn = $('.pair-again');
  let code = null;
  let tick = null;
  let poll = null;
  let closed = false;
  const prevFocus = document.activeElement;

  const stop = () => { clearInterval(tick); clearTimeout(poll); tick = poll = null; };

  const expired = () => {
    stop();
    code = null;
    box.innerHTML = '';
    timer.textContent = '';
    copyBtn.hidden = true;
    againBtn.hidden = false;
    stateEl.textContent = t('El código ha caducado. Crea otro cuando tengas el dispositivo a mano.');
  };

  const paired = (device) => {
    stop();
    code = null;
    box.innerHTML = '';
    timer.textContent = '';
    copyBtn.hidden = true;
    againBtn.hidden = true;
    stateEl.textContent = t('Listo: {device} ya sincroniza contigo.', { device: device || t('el otro dispositivo') });
    onPaired?.(device);
  };

  const paintTimer = () => {
    if (!code) return;
    const left = Math.max(0, code.expiresAt - Date.now());
    if (!left) { expired(); return; }
    const s = Math.ceil(left / 1000);
    timer.textContent = t('Caduca en {min}:{seg}', { min: Math.floor(s / 60), seg: String(s % 60).padStart(2, '0') });
  };

  const check = async () => {
    if (!code || closed) return;
    try {
      const st = await BRAuth.pairStatus(code.id);
      if (closed || !code) return;
      if (st.state === 'claimed') { paired(st.device); return; }
      if (st.state === 'expired') { expired(); return; }
    } catch { /* un fallo de red no cierra nada: se reintenta */ }
    if (!closed && code) poll = setTimeout(check, POLL_MS);
  };

  const create = async () => {
    stop();
    againBtn.hidden = true;
    copyBtn.hidden = true;
    stateEl.textContent = '';
    timer.textContent = '';
    box.innerHTML = `<p class="appset-muted">${escapeHtml(t('Creando el código…'))}</p>`;
    try {
      code = await BRAuth.createPairCode();
      if (closed) { BRAuth.cancelPairCode(code.id); return; }
      box.innerHTML = await qrSvg(code.link);
      box.dataset.link = code.link;
      copyBtn.hidden = false;
      paintTimer();
      tick = setInterval(paintTimer, 1000);
      poll = setTimeout(check, POLL_MS);
    } catch {
      code = null;
      box.innerHTML = '';
      stateEl.textContent = t('No se pudo crear el código. Comprueba la conexión e inténtalo otra vez.');
      againBtn.hidden = false;
    }
  };

  const close = () => {
    if (closed) return;
    closed = true;
    stop();
    if (code) BRAuth.cancelPairCode(code.id);
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    try { prevFocus?.focus?.(); } catch { /* ya no existe */ }
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  $('.pair-close').addEventListener('click', close);
  againBtn.addEventListener('click', create);
  copyBtn.addEventListener('click', async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.link);
      stateEl.textContent = t('Enlace copiado. Ábrelo en el otro dispositivo antes de 10 minutos.');
    } catch {
      stateEl.textContent = code.link;
    }
  });
  $('.pair-close').focus();
  create();
  return { close };
}
