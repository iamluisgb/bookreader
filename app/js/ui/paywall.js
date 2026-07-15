// ui/paywall.js — gate de BookReader Pro (MON2). `ensurePro(feature)` es la única
// puerta: si la licencia está activa devuelve true sin tocar el DOM; si no, muestra el
// paywall EN EL MOMENTO DE INTENCIÓN (el usuario acaba de pedir la feature) y devuelve
// false. Comprar o activar la key pasa por Ajustes/checkout; el usuario reintenta la
// acción después — sin estados intermedios que mantener.
//
// Reusa las clases .dlg-* de dialog.js (mismo lenguaje visual); solo añade la lista
// de features y el precio (.pw-*).
import * as License from '../license.js';
import { icon } from './icons.js';
import { escapeHtml } from './escape.js';

// Features Pro (LAUNCH_PLAN): el chat con el libro y el resumen quedan gratis — son la
// demo. Se cobra el "convertir el libro en conocimiento": tarjetas, repaso, mapas,
// plantillas avanzadas y perfiles.
const FEATURES = {
  flashcards: 'Flashcards con export a Anki',
  study: 'Repaso espaciado (quizzes)',
  mindmap: 'Mapas mentales navegables',
  hqa: 'Plantilla HQ&A y plantillas avanzadas',
  profiles: 'Perfiles del agente reutilizables',
};

export async function ensurePro(feature) {
  if (License.isPro()) return true;
  return openPaywall(feature);
}

function openPaywall(feature) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'dlg-overlay pw-overlay';
    const rows = Object.entries(FEATURES).map(([id, label]) =>
      `<li class="pw-feat${id === feature ? ' pw-feat-hot' : ''}">${icon('check', { size: 14 })}<span>${escapeHtml(label)}</span></li>`).join('');
    overlay.innerHTML = `
      <div class="dlg-card pw-card" role="dialog" aria-modal="true" aria-label="BookReader Pro">
        <h2 class="dlg-title">${escapeHtml(FEATURES[feature] || 'Esta función')} es de BookReader Pro</h2>
        <ul class="pw-list">${rows}</ul>
        <p class="pw-price">${escapeHtml(License.CONFIG.price)} — sin suscripción, tus datos siguen en tu máquina.</p>
        <div class="dlg-actions">
          <button class="dlg-btn dlg-cancel pw-havekey">Ya tengo una licencia</button>
          <button class="dlg-btn dlg-ok pw-buy">Conseguir Pro</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const done = (result) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(result);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(false); } };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(false); });

    overlay.querySelector('.pw-buy').addEventListener('click', () => {
      if (License.CONFIG.checkoutUrl) window.open(License.CONFIG.checkoutUrl, '_blank', 'noopener');
      done(false);   // la compra sigue fuera; al volver activará la key en Ajustes
    });
    overlay.querySelector('.pw-havekey').addEventListener('click', async () => {
      done(false);
      // Import dinámico: app-settings importa este módulo (gate de Perfiles); estático
      // sería un ciclo.
      const AppSettings = await import('./app-settings.js');
      AppSettings.open('license');
    });
    overlay.querySelector('.pw-buy').focus();
  });
}
