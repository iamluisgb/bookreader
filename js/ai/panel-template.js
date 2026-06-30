// Plantillas del panel del agente: el HTML del panel (TEMPLATE) y el prompt de
// sistema (systemPrompt). Extraído de panel.js (T8, ver CHANGELOG) — solo strings,
// sin estado: el prompt recibe goal/template por parámetro.
import { icon } from '../ui/icons.js';

export const TEMPLATE = `
  <div class="ai-header">
    <span class="ai-title">${icon('sparkles', { size: 19 })} Agente</span>
    <button id="ai-edit-cfg" class="icon-btn" title="Configuración">${icon('gear')}</button>
    <button id="ai-close" class="icon-btn" title="Cerrar">${icon('xmark')}</button>
  </div>
  <div id="ai-config" class="ai-config">
    <label>API key de nan</label>
    <input id="ai-key" type="password" placeholder="sk-..." autocomplete="off" />
    <label>Modelo</label>
    <select id="ai-model"></select>
    <label class="ai-check"><input type="checkbox" id="ai-auto" /> Rellenar la libreta automáticamente</label>
    <button id="ai-save-cfg" class="primary-btn ai-save">Guardar</button>
    <p class="ai-privacy">${icon('shield', { size: 13 })} Tu API key se guarda solo en este navegador. Para responder, el contenido del libro se envía al proveedor del modelo (nan).</p>
  </div>
  <div id="ai-status" class="ai-status">Abre un EPUB para empezar.</div>
  <div id="ai-convobar" class="ai-convobar" style="display:none">
    <button id="ai-convo-btn" class="ai-convo-btn" title="Cambiar de conversación">
      ${icon('bubble', { size: 15 })}<span id="ai-convo-label" class="ai-convo-label">Conversación</span>${icon('chevron-down', { size: 14 })}
    </button>
    <button id="ai-convo-new" class="icon-btn" title="Nueva conversación">${icon('plus', { size: 18 })}</button>
  </div>
  <div id="ai-tabs" class="ai-tabs" style="display:none">
    <button class="ai-tab active" data-view="chat">${icon('bubble', { size: 16 })} Chat</button>
    <button class="ai-tab" data-view="notebook">${icon('note', { size: 16 })} Libreta</button>
  </div>
  <div id="ai-view-chat" class="ai-view active">
    <div id="ai-messages" class="ai-messages"></div>
    <div id="ai-ref" class="ai-ref" style="display:none">
      <span class="ai-ref-ico">${icon('note', { size: 15 })}</span>
      <span id="ai-ref-text" class="ai-ref-text"></span>
      <button id="ai-ref-clear" class="ai-ref-clear" title="Quitar referencia">${icon('xmark', { size: 15 })}</button>
    </div>
    <div class="ai-composer">
      <textarea id="ai-input" rows="2" placeholder="Pregunta sobre el libro..."></textarea>
      <button id="ai-send" class="primary-btn ai-send">Enviar</button>
    </div>
  </div>
  <div id="ai-view-notebook" class="ai-view"></div>
`;

// Prompt de sistema del agente. `goal` es el objetivo de la conversación y
// `template` la plantilla de libreta activa (ambos pueden ser null/undefined).
export function systemPrompt(goal, template) {
  const fields = template ? template.fields.map(f => `- ${f.key}: ${f.label}`).join('\n') : '';
  return `Eres un lector experto que ayuda a sacar provecho de un libro según un OBJETIVO concreto.
Respondes en español, conciso y sin paja, basándote ÚNICAMENTE en el libro entregado.

OBJETIVO DEL USUARIO: ${goal || '(sin definir)'}
PLANTILLA: ${template?.name || '—'} — ${template?.agentRole || ''}
Filtra el contenido hacia ese objetivo: ignora lo anecdótico, resalta lo aplicable.

CITAS (obligatorio): el libro viene troceado en pasajes precedidos por anclas [[aN]].
Cada afirmación basada en el libro debe llevar su cita [[aN]] usando identificadores reales del texto.
Incluye al menos una cita por respuesta sobre el contenido. No inventes anclas.

La libreta del usuario tiene estos campos (no los rellenas tú aquí, solo respondes):
${fields}`;
}
