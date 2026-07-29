// Plantillas del panel del agente: el HTML del panel (TEMPLATE) y el prompt de
// sistema (systemPrompt). Extraído de panel.js (T8, ver CHANGELOG) — solo strings,
// sin estado: el prompt recibe goal/template por parámetro.
import { icon } from '../ui/icons.js';
import { promptBlock } from './profiles.js';
import { isCognitionField } from './templates.js';
import { t, uiLangName } from '../i18n.js';

export const TEMPLATE = () => `
  <!-- Tirador del sheet (solo visible en móvil). Es un ELEMENTO REAL y no un ::before porque
       los pseudo-elementos no reciben eventos: sin nodo no hay arrastre posible. -->
  <button id="ai-sheet-grab" class="ai-sheet-grab" aria-label="${t('Ajustar alto del panel')}"></button>
  <!-- Toolbar único (una sola fila de chrome): todo lo que hay aquí es de la CONVERSACIÓN
       (perfil, selector, nueva, exportar) más ajustes/cerrar. Los artefactos (resumen, mapa,
       flashcards) vivían también aquí como iconos sueltos y se quitaron: su casa es el Studio,
       que además muestra su estado e historial —cosas que un icono no puede decir— y ya era el
       único sitio de los tipos nuevos ("Explícamelo tú" nació sin icono). Sustituye a la antigua cabecera "Agente" (redundante) para dar el máximo
       alto al chat. El grupo de conversación (#ai-convobar) se oculta sin libro; ⚙ y ✕ siempre
       visibles (por eso ⚙ lleva margin-left:auto para quedar a la derecha cuando el grupo falta). -->
  <div class="ai-toolbar">
    <div id="ai-convobar" class="ai-convobar" style="display:none">
      <button id="ai-profile-chip" class="ai-profile-chip" style="display:none" title="${t('Perfil del agente')}"></button>
      <button id="ai-convo-btn" class="ai-convo-btn" title="${t('Cambiar de conversación')}">
        ${icon('bubble', { size: 15 })}<span id="ai-convo-label" class="ai-convo-label">${t('Conversación')}</span>${icon('chevron-down', { size: 14 })}
      </button>
      <button id="ai-convo-new" class="icon-btn" title="${t('Nueva conversación')}">${icon('plus', { size: 18 })}</button>
      <button id="ai-convo-export" class="icon-btn" title="${t('Exportar esta conversación (libreta + chat) a Markdown')}">${icon('share', { size: 17 })}</button>
    </div>
    <button id="ai-edit-cfg" class="icon-btn ai-toolbar-cfg" title="${t('Ajustes del agente')}">${icon('gear')}</button>
    <button id="ai-close" class="icon-btn" title="${t('Cerrar')}">${icon('xmark')}</button>
  </div>
  <div id="ai-status" class="ai-status">${t('Abre un EPUB para empezar.')}</div>
  <div id="ai-tabs" class="ai-tabs" style="display:none">
    <button class="ai-tab active" data-view="chat">${icon('bubble', { size: 16 })} Chat</button>
    <button class="ai-tab" data-view="notebook">${icon('note', { size: 16 })} ${t('Libreta')}</button>
    <button class="ai-tab" data-view="studio">${icon('sparkles', { size: 16 })} Studio</button>
  </div>
  <div id="ai-view-chat" class="ai-view active">
    <div id="ai-messages" class="ai-messages" role="log" aria-live="polite" aria-relevant="additions text" aria-label="${t('Conversación con el agente')}"></div>
    <div id="ai-ref" class="ai-ref" style="display:none">
      <span class="ai-ref-ico">${icon('note', { size: 15 })}</span>
      <span id="ai-ref-text" class="ai-ref-text"></span>
      <button id="ai-ref-clear" class="ai-ref-clear" title="${t('Quitar referencia')}">${icon('xmark', { size: 15 })}</button>
    </div>
    <div id="ai-imgref" class="ai-ref ai-imgref" style="display:none">
      <span class="ai-ref-ico">📷</span>
      <span id="ai-imgref-text" class="ai-ref-text"></span>
      <button id="ai-imgref-clear" class="ai-ref-clear" title="${t('Quitar imagen')}">${icon('xmark', { size: 15 })}</button>
    </div>
    <!-- Zonas recortadas de la página (IA6 v2). Se ven ANTES de enviar: el usuario comprueba
         qué va a mirar el modelo, y puede añadir otra para preguntar por la relación. -->
    <div id="ai-zones" class="ai-zones" style="display:none"></div>
    <div class="ai-composer">
      <textarea id="ai-input" rows="2" placeholder="${t('Pregunta sobre el libro...')}"></textarea>
      <div class="ai-composer-btns">
        <button id="ai-see" class="ai-see" title="${t('Explicar lo que veo en la página (figuras, diagramas)')}" style="display:none">${icon('sparkles', { size: 15 })}<span>${t('Ver')}</span></button>
        <button id="ai-zone" class="ai-see" title="${t('Marcar una zona de la página (una figura, una ecuación) y preguntar por ella')}" style="display:none">${icon('crop', { size: 15 })}<span>${t('Zona')}</span></button>
        <!-- Micro y Enviar comparten fila: en PDF la botonera ya lleva "Ver" y "Zona", y una
             cuarta fila apilada se comía el alto del composer justo en móvil, que es donde el
             dictado importa. Solo icono, y el estado (grabando) se ve por el color. -->
        <div class="ai-composer-row">
          <button id="ai-mic" class="ai-see ai-mic" title="${t('Dictar')}" aria-label="${t('Dictar')}" aria-pressed="false" style="display:none">${icon('mic', { size: 15 })}</button>
          <button id="ai-send" class="primary-btn ai-send">${t('Enviar')}</button>
        </div>
      </div>
    </div>
  </div>
  <div id="ai-view-notebook" class="ai-view"></div>
  <div id="ai-view-studio" class="ai-view"></div>
`;

// Prompt de sistema del agente. `goal` es el objetivo de la conversación, `template`
// la plantilla de libreta activa y `profile` el perfil de agente activo (P1). Todos
// pueden ser null/undefined. El bloque del perfil va PRIMERO: es lo más estable
// (reutilizable entre libros/convos), buen prefijo para el prompt caching.
export function systemPrompt(goal, template, profile, opts = {}) {
  const tocLabels = Array.isArray(opts.tocLabels) ? opts.tocLabels.filter(Boolean) : [];
  const info = template ? template.fields.filter(f => !isCognitionField(f)) : [];
  const cog  = template ? template.fields.filter(f =>  isCognitionField(f)) : [];
  const fmt = (arr) => arr.map(f => `- ${f.key}: ${f.label}`).join('\n');
  // INFO vs COGNICIÓN: la libreta se auto-rellena solo en los campos INFO. Los de
  // cognición los genera el usuario (efecto de generación); ahí el agente NO escribe la
  // respuesta: pregunta al estilo socrático y, si el usuario aporta la suya, la revisa.
  const notebook = [
    info.length ? `Campos INFO (recuperación; se rellenan aparte, no en el chat):\n${fmt(info)}` : '',
    cog.length ? `Campos de COGNICIÓN (los genera el USUARIO; TÚ NO los escribes):\n${fmt(cog)}\nEn estos campos no des la respuesta hecha: haz preguntas socráticas que ayuden al usuario a generarla, y cuando la escriba, revísala y señala huecos o errores.` : '',
  ].filter(Boolean).join('\n\n');
  // MAPA DEL LIBRO: el índice completo de capítulos (TOC). Sirve para que el modelo sepa
  // que el libro SÍ tiene un capítulo aunque no esté en el extracto de este turno, y así
  // no niegue su existencia ni pida que se lo peguen.
  const bookMap = tocLabels.length
    ? `\nMAPA DEL LIBRO (índice completo de capítulos):\n${tocLabels.map(t => `- ${t}`).join('\n')}\n`
    : '';
  // ALCANCE del contexto de este turno. Por defecto es un extracto local (RAG por
  // relevancia) y el agente debe avisar si le falta algo. Pero cuando la pregunta es
  // de LIBRO ENTERO, el sistema le adjunta o bien una SÍNTESIS del libro completo, o
  // bien un EXTRACTO TRANSVERSAL (muestra de todos los capítulos): en esos casos SÍ
  // tiene base para hablar del conjunto y NO debe abrir disculpándose por no tener
  // todo el libro —eso es justo lo que chirría en preguntas de visión global—.
  const hasSummary = !!opts.hasBookSummary;
  const transversal = !!opts.transversal;
  const sourceLine = hasSummary
    ? `basándote en la SÍNTESIS del libro completo y en el EXTRACTO que se te entregan en este turno.`
    : transversal
      ? `basándote en el EXTRACTO que se te entrega, que es una MUESTRA TRANSVERSAL de todo el libro.`
      : `basándote ÚNICAMENTE en el EXTRACTO del libro que se te entrega en cada turno.`;
  const scopeNote = hasSummary
    ? `CONTEXTO (importante): además del extracto, recibes una SÍNTESIS del libro completo (con sus
anclas [[aN]] reales). Para preguntas de conjunto —lo más importante, la tesis, cómo se estructura—
responde con criterio APOYÁNDOTE en esa síntesis; NO abras diciendo que solo tienes extractos ni te
disculpes por no haber leído todo. Cita [[aN]] igual. El usuario lee el libro completo dentro de la
app: nunca le pidas que copie o pegue texto.`
    : transversal
      ? `CONTEXTO (importante): el extracto es una MUESTRA TRANSVERSAL del libro entero (pasajes de todos
los capítulos), no una selección local. Tienes base para hablar del CONJUNTO; hazlo con criterio y sin
disculparte por tener "solo unos extractos". Si un punto concreto pide más detalle de un capítulo,
dilo con naturalidad. Cita [[aN]]. El usuario lee el libro completo en la app: no le pidas texto.`
      : `CONTEXTO RECUPERADO (importante): el texto que recibes NO es el libro entero, sino un EXTRACTO
seleccionado automáticamente por relevancia para la pregunta actual; puede no incluir todos los
capítulos. El usuario está leyendo el libro completo DENTRO de la app: nunca le pidas que copie ni
pegue texto. Si para responder te falta un capítulo o pasaje que no está en el extracto, dilo con
naturalidad y sugiere abrir/nombrar ese capítulo (aparece en el mapa de arriba) o reformular la
pregunta para traerlo — pero no afirmes que el capítulo "no existe" o "no te lo han dado".`;
  return `${promptBlock(profile)}Eres un lector experto que ayuda a sacar provecho de un libro según un OBJETIVO concreto.
Respondes SIEMPRE en el idioma en el que el usuario escribe sus mensajes (si no está claro, en ${uiLangName()}), conciso y sin paja, ${sourceLine}

OBJETIVO DEL USUARIO: ${goal || '(sin definir)'}
PLANTILLA: ${template?.name || '—'} — ${template?.agentRole || ''}
Filtra el contenido hacia ese objetivo: ignora lo anecdótico, resalta lo aplicable.
${bookMap}
${scopeNote}

CITAS (obligatorio): el extracto viene troceado en pasajes precedidos por anclas [[aN]].
Cada afirmación basada en el libro debe llevar su cita [[aN]] usando identificadores reales del texto.
Incluye al menos una cita por respuesta sobre el contenido. No inventes anclas.

FORMATO: usa Markdown (negritas, listas, tablas, encabezados) — se renderiza con estilo en la app.
Para comparar o estructurar, usa TABLAS o listas Markdown. NUNCA dibujes diagramas, cajas, flechas ni
árboles con caracteres ASCII (│ ┌ └ → ---): se ven crudos y rompen la lectura. Un flujo o jerarquía se
expresa mejor como lista anidada o pasos numerados.

Principio rector — información ≠ cognición. Ayuda a APRENDER, no sustituyas el aprendizaje.
La libreta del usuario tiene estos campos:
${notebook}`;
}
