// Dictado enganchado a un <textarea> + un botón. Nace de la barra del chat (escribirle al
// agente desde el móvil con el pulgar es el cuello de botella real), pero no sabe nada del
// panel: recibe los dos elementos y ya.
//
// Los motores y su porqué están en feynman.js, que es donde se estrenó el dictado; aquí solo
// se reutilizan. Resumen: si hay modelo de transcripción configurado (BYOK) se graba con
// MediaRecorder y se transcribe al soltar — acierta mucho más con vocabulario técnico y NO
// se corta solo por silencio, que es el fallo nº1 del dictado del navegador en móvil. Si no,
// se cae al reconocedor del navegador, que sí da texto en vivo.
import { t } from '../i18n.js';
import * as LLM from './llm.js';
import {
  speechSupported, createDictation, recorderSupported, createRecorder, dictationLang,
} from './feynman.js';

export function micAvailable() { return speechSupported() || (LLM.hasStt() && recorderSupported()); }
function useProviderStt() { return LLM.hasStt() && recorderSupported(); }

// Añade el texto dictado SIN pisar lo que el usuario haya escrito a mano: la base se
// recalcula quitando solo lo último que escribimos nosotros, así una corrección manual
// sobrevive al siguiente resultado parcial del reconocedor.
function makeAppender(input) {
  let last = '';
  return (text) => {
    const cur = input.value;
    const base = last && cur.endsWith(last) ? cur.slice(0, -last.length) : (cur ? cur + ' ' : '');
    input.value = base + text;
    last = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));   // que el composer se re-autoajuste
    input.scrollTop = input.scrollHeight;
  };
}

/**
 * Engancha el micro a un textarea.
 *
 * @param {object} o
 * @param {HTMLTextAreaElement} o.input  destino del texto dictado
 * @param {HTMLElement} o.btn            botón que alterna grabación
 * @param {() => string} [o.getPrompt]   vocabulario para sesgar la transcripción (título del
 *                                       libro, capítulo actual): sale gratis y arregla justo
 *                                       los nombres propios que Whisper se inventa
 * @param {(msg: string) => void} [o.onError]
 * @returns {{ stop: () => Promise<void>, recording: () => boolean }}
 */
export function attachMic({ input, btn, getPrompt = () => '', onError = () => {} }) {
  let active = null;    // motor en marcha (null = parado)
  let done = null;      // promesa de la transcripción en vuelo (motor del proveedor)

  const ui = (state) => {
    const label = state === 'rec' ? t('Parar') : state === 'busy' ? t('Transcribiendo…') : t('Dictar');
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', state === 'rec' ? 'true' : 'false');
    btn.classList.toggle('ai-mic-on', state === 'rec');
    btn.disabled = state === 'busy';
    const span = btn.querySelector('span');
    if (span) span.textContent = label;
  };

  function startBrowser() {
    const append = makeAppender(input);
    const d = createDictation({
      lang: dictationLang(),
      onText: append,
      onEnd: () => { active = null; ui('idle'); },
      onError: (msg) => { active = null; ui('idle'); onError(msg); },
    });
    if (!d) return null;
    d.start();
    return d;
  }

  function startProvider() {
    let resolveDone;
    done = new Promise((r) => { resolveDone = r; });
    const rec = createRecorder({
      onStop: async (blob) => {
        active = null;
        try {
          if (!blob || blob.size < 1200) return;   // pulsación accidental: nada que enviar
          ui('busy');
          const text = await LLM.transcribe({ blob, prompt: getPrompt(), language: dictationLang() });
          if (text) makeAppender(input)(text);
        } catch (e) {
          onError(e.message);
        } finally {
          ui('idle');
          resolveDone();
        }
      },
      onError: (msg) => { active = null; ui('idle'); onError(msg); resolveDone(); },
    });
    if (!rec) { resolveDone(); return null; }
    // `start` es asíncrono (pide permiso al usuario): si falla, su `onError` ya ha limpiado.
    rec.start().then((ok) => { if (!ok) { active = null; ui('idle'); resolveDone(); } });
    return rec;
  }

  // Con el motor del proveedor el texto llega DESPUÉS de soltar, así que quien vaya a leer el
  // textarea (enviar el mensaje) tiene que esperar a esta promesa o mandaría el turno sin el
  // último tramo dictado.
  function stop() {
    if (!active) return Promise.resolve();
    const d = active;
    d.stop();
    if (!useProviderStt()) { active = null; return Promise.resolve(); }
    return done || Promise.resolve();
  }

  btn.addEventListener('click', () => {
    if (active) { stop(); return; }
    active = useProviderStt() ? startProvider() : startBrowser();
    if (active) ui('rec');
  });

  ui('idle');
  return { stop, recording: () => !!active };
}
