// Dictado enganchado a un <textarea> + un botón. Nace de la barra del chat (escribirle al
// agente desde el móvil con el pulgar es el cuello de botella real), pero no sabe nada de
// quién lo usa: recibe los dos elementos y ya. Lo comparten el chat y el modo Feynman.
//
// Los motores y su porqué están en dictation-engine.js; aquí está la UI que los envuelve
// (barra de grabación, acumulado, papelera). Resumen: si hay modelo de transcripción
// configurado (BYOK) se graba con
// MediaRecorder y se transcribe al soltar — acierta mucho más con vocabulario técnico y NO
// se corta solo por silencio, que es el fallo nº1 del dictado del navegador en móvil. Si no,
// se cae al reconocedor del navegador, que sí da texto en vivo.
import { t } from '../i18n.js';
import * as LLM from './llm.js';
import {
  speechSupported, createDictation, recorderSupported, createRecorder, dictationLang,
} from './dictation-engine.js';

export function micAvailable() { return speechSupported() || (LLM.hasStt() && recorderSupported()); }
function useProviderStt() { return LLM.hasStt() && recorderSupported(); }

// ---- barra de grabación (patrón WhatsApp) ------------------------------------
// Mientras grabas, el textarea se sustituye por una barra con punto latiendo, cronómetro y
// papelera. De WhatsApp se copia el chasis; el medidor de nivel es añadido nuestro y es lo
// que de verdad hace falta aquí: con el motor del proveedor no hay texto en vivo, así que sin
// nivel "te estoy oyendo" y "el micro está mudo" se ven exactamente igual — y no te enteras
// hasta 30 segundos después, cuando vuelve vacío.
function buildBar({ onCancel }) {
  const bar = document.createElement('div');
  bar.className = 'mic-bar';
  bar.hidden = true;
  bar.innerHTML = `
    <button type="button" class="mic-bar-cancel" title="${t('Descartar')}" aria-label="${t('Descartar')}">
      <svg class="icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 7 20 7"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7"/><path d="M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7"/></svg>
    </button>
    <span class="mic-bar-dot" aria-hidden="true"></span>
    <span class="mic-bar-time" role="timer">0:00</span>
    <span class="mic-bar-level" aria-hidden="true">${'<i></i>'.repeat(14)}</span>
    <span class="mic-bar-hint">${t('Pulsa el micro para terminar')}</span>`;
  bar.querySelector('.mic-bar-cancel').addEventListener('click', onCancel);
  return bar;
}

const mmss = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// Nivel de entrada en [0..1] a partir del stream. Se usa RMS y no el pico: el pico se dispara
// con cualquier chasquido y el medidor parece vivo aunque no se te oiga.
// El medidor es un ADORNO: si falla, se graba igual. Por eso va entero en try/catch — sin él,
// un AudioContext que no arranca (Safari con la pestaña en segundo plano, un stream que el
// navegador no acepta como fuente) tiraba la excepción por onStream y se llevaba por delante
// la grabación completa: el micro se quedaba encendido y la promesa nunca resolvía.
function createMeter(stream) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  let ctx;
  let analyser, buf;
  try {
    ctx = new Ctx();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    buf = new Uint8Array(analyser.fftSize);
  } catch (e) {
    try { ctx?.close(); } catch (e2) { /* ni llegó a abrirse */ }
    return null;
  }
  return {
    read: () => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      // ×3.2 porque el habla normal a medio metro da un RMS de ~0,05–0,15: sin escalar, las
      // barras no se moverían y el medidor mentiría diciendo que no se te oye.
      return Math.min(1, Math.sqrt(sum / buf.length) * 3.2);
    },
    close: () => { try { ctx.close(); } catch (e) { /* ya cerrado */ } },
  };
}

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
 * @param {(msg: string, code?: string) => void} [o.onError]  `code` solo con el motor del
 *                                       navegador; Feynman lo usa para ofrecer Ajustes
 * @returns {{ start: () => void, stop: () => Promise<void>, recording: () => boolean }}
 */
export function attachMic({ input, btn, getPrompt = () => '', onError = () => {} }) {
  let active = null;    // motor en marcha (null = parado)
  let done = null;      // promesa de la transcripción en vuelo (motor del proveedor)
  let discard = false;  // la papelera: parar SIN transcribir (ni gastar la llamada)
  let meter = null;
  let raf = 0;

  const bar = buildBar({ onCancel: () => { discard = true; stop(); } });
  input.parentNode?.insertBefore(bar, input);
  const timeEl = bar.querySelector('.mic-bar-time');
  const bars = [...bar.querySelectorAll('.mic-bar-level i')];

  // El cronómetro y el nivel van en el MISMO rAF: son la misma pregunta ("¿sigue vivo
  // esto?") y dos temporizadores desincronizados se notan.
  function startTicking() {
    const t0 = Date.now();
    const tick = () => {
      timeEl.textContent = mmss(Date.now() - t0);
      if (meter) {
        const lvl = meter.read();
        // Las barras se encienden de dentro afuera, como un vúmetro: cuántas se encienden es
        // el nivel, y que se muevan es la prueba de que entra audio.
        bars.forEach((el, i) => el.classList.toggle('on', lvl > (i + 1) / (bars.length + 1)));
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
  }

  function stopTicking() {
    cancelAnimationFrame(raf);
    raf = 0;
    meter?.close();
    meter = null;
    bars.forEach((el) => el.classList.remove('on'));
    timeEl.textContent = '0:00';
  }

  const ui = (state) => {
    const label = state === 'rec' ? t('Parar') : state === 'busy' ? t('Transcribiendo…') : t('Dictar');
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', state === 'rec' ? 'true' : 'false');
    btn.classList.toggle('ai-mic-on', state === 'rec');
    btn.disabled = state === 'busy';
    const span = btn.querySelector('span');
    if (span) span.textContent = label;
    // La barra sustituye al textarea mientras grabas (WhatsApp): el composer ya va justo de
    // alto en móvil y apilarla encima empujaba el chat.
    bar.hidden = state !== 'rec';
    input.classList.toggle('is-recording', state === 'rec');
    if (state === 'rec') startTicking(); else stopTicking();
  };

  function startBrowser() {
    const append = makeAppender(input);
    const d = createDictation({
      lang: dictationLang(),
      onText: append,
      onEnd: () => { active = null; ui('idle'); },
      // El `code` se pasa tal cual: Feynman lo usa para distinguir un fallo de red del
      // reconocedor —que SÍ tiene arreglo, configurar el motor del proveedor— y ofrecer
      // abrir Ajustes en vez de un mensaje que solo describe el problema.
      onError: (msg, code) => { active = null; ui('idle'); onError(msg, code); },
    });
    if (!d) return null;
    d.start();
    return d;
  }

  function startProvider() {
    let resolveDone;
    done = new Promise((r) => { resolveDone = r; });
    const rec = createRecorder({
      onStream: (stream) => { meter = createMeter(stream); },
      onStop: async (blob) => {
        active = null;
        try {
          if (discard) return;                     // papelera: ni se envía ni se cobra
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

  function start() {
    if (active) return;
    discard = false;
    const provider = useProviderStt();
    // Nivel y papelera solo tienen sentido con el motor del proveedor: el del navegador no da
    // stream que medir, y su texto ya está escrito en el textarea, así que "descartar" no
    // podría deshacer nada. Enseñar controles que no hacen lo que prometen es peor que no
    // enseñarlos.
    bar.classList.toggle('is-provider', provider);
    bar.querySelector('.mic-bar-hint').textContent = provider
      ? t('Pulsa el micro para terminar')
      : t('Escuchando…');
    active = provider ? startProvider() : startBrowser();
    if (active) ui('rec');
  }

  btn.addEventListener('click', () => { if (active) stop(); else start(); });

  ui('idle');
  // `start` lo necesita Feynman para rearrancar tras cambiar el idioma del dictado; el chat
  // solo usa el botón.
  return { start, stop, recording: () => !!active };
}
