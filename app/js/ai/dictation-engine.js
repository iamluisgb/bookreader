// Motores de dictado. Vive aparte de feynman.js (donde nació) porque ahora lo usan dos sitios
// —el modo Feynman y la barra del chat (mic.js)— y tenerlo en feynman.js obligaba a un ciclo
// de imports. Aquí solo están los MOTORES; la UI que los envuelve es de cada consumidor.
//
// Dos motores, y la diferencia importa:
//   · navegador (SpeechRecognition): texto en vivo, pero se corta en cada pausa (en Android
//     ignora `continuous`) y acierta poco con vocabulario técnico.
//   · proveedor (MediaRecorder + POST /audio/transcriptions): sin texto en vivo —llega al
//     soltar—, pero no se corta solo y se puede sesgar con un `prompt`.
import { t, uiLangName } from '../i18n.js';
import * as Storage from '../storage.js';

// Explicar EN VOZ ALTA es el ejercicio de Feynman; teclear un párrafo es otra cosa y casi
// nadie lo hace. `SpeechRecognition` es del navegador (nada sale de la máquina salvo lo que
// el propio navegador haga), pero su soporte es irregular: si no está, no se enseña el botón
// y el textarea es el camino normal, no un consuelo.
export function speechSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

// Idioma del dictado. NO se deduce de la UI: se lee en inglés con la interfaz en español
// más veces de las que parece, y meterle "attention"/"embeddings" a un reconocedor `es-ES`
// da puré justo en el vocabulario que importa. Se elige a mano y se recuerda.
const LANGS = { es: 'es-ES', en: 'en-US' };
export function dictationLang() {
  const v = Storage.get('fey_dictation_lang', '');
  return LANGS[v] ? v : (uiLangName() === 'español' ? 'es' : 'en');
}
export function setDictationLang(l) { if (LANGS[l]) Storage.set('fey_dictation_lang', l); }

// Mensaje por código de error del reconocedor. Antes TODOS terminaban igual —el botón se
// apagaba sin decir nada—, así que "permiso denegado" y "he dejado de oírte" eran
// indistinguibles de "no funciona". `no-speech` y `aborted` no son errores: son el caso
// normal de una pausa, y deben reintentar en silencio.
export function speechErrorMessage(code) {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return t('No hay permiso para usar el micrófono. Habilítalo en los ajustes del navegador para este sitio.');
    case 'audio-capture':
      return t('No se encuentra ningún micrófono.');
    case 'network':
      return t('El dictado del navegador necesita conexión (envía el audio a un servicio externo).');
    case 'no-speech':
    case 'aborted':
      return '';        // no es un error: se reintenta
    default:
      return t('El dictado se ha detenido ({code}).', { code: code || '?' });
  }
}

// El navegador CORTA el reconocimiento solo tras unos segundos de silencio —y en Android
// ignora `continuous` casi por completo, terminando en cada frase—. Explicar algo con tus
// palabras está lleno de pausas para pensar, así que el micro se moría a media explicación
// y el usuario ni se enteraba. La corrección es distinguir "ha terminado el reconocedor" de
// "el usuario ha pulsado parar": mientras `wantsRunning`, se vuelve a arrancar.
export function createDictation({ onText, onEnd, onError, lang } = {}) {
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Ctor) return null;
  const code = LANGS[lang] || LANGS[dictationLang()];
  let rec = null;
  let wantsRunning = false;
  let retriedNetwork = false;
  // Acumulado FUERA del reconocedor: cada reinicio crea uno nuevo y su `finalText` empieza
  // vacío. Si viviera dentro, cada pausa borraría todo lo dicho hasta entonces.
  let finalText = '';

  const build = () => {
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = code;
    r.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (res.isFinal) finalText += res[0].transcript + ' ';
        else interim += res[0].transcript;
      }
      onText?.(finalText + interim, finalText);
    };
    r.onerror = (ev) => {
      const code = ev?.error;
      const msg = speechErrorMessage(code);
      if (!msg) return;                 // pausa: `onend` se encarga de reanudar
      // `network` puede ser transitorio (el servicio de voz del navegador tarda en responder
      // al arrancar). Se le da UNA segunda oportunidad; si vuelve, es que no hay servicio y
      // se avisa. Los demás fatales —permiso, sin micro— no se reintentan: no van a cambiar.
      if (code === 'network' && !retriedNetwork) { retriedNetwork = true; return; }
      wantsRunning = false;
      onError?.(msg, code);
    };
    r.onend = () => {
      if (wantsRunning) { try { r.start(); } catch (e) { /* aún cerrando: lo reintenta el próximo onend */ } return; }
      onEnd?.(finalText);
    };
    return r;
  };

  return {
    start: () => {
      wantsRunning = true;
      rec = build();
      // Un `start()` que falla de verdad (sin permiso) lanza igual que un doble arranque.
      // Se distingue por `wantsRunning`: si estamos arrancando, el fallo es real.
      try { rec.start(); } catch (e) { wantsRunning = false; onError?.(speechErrorMessage('not-allowed'), 'not-allowed'); }
    },
    stop: () => { wantsRunning = false; try { rec?.stop(); } catch (e) { /* ya parado */ } },
  };
}

// ---- dictado por proveedor (BYOK) ---------------------------------------------

export function recorderSupported() {
  return !!(window.MediaRecorder && navigator.mediaDevices?.getUserMedia);
}

// Graba con MediaRecorder y transcribe al parar. Frente al dictado del navegador: no hay
// corte automático por silencio (el fallo nº1 en móvil), acierta mucho más con vocabulario
// técnico, y se puede sesgar con el `prompt`. A cambio NO hay texto en vivo: el resultado
// llega al soltar el botón. Medido: ~2,3 s para 8 s de audio; 4-9 s para 25 s.
//
// Formato: se deja elegir al navegador (webm/opus en Chrome, mp4 en Safari). Opus pesa
// ~30× menos que WAV, que en móvil con datos no es un detalle.
// `onStream` recibe el MediaStream en cuanto hay permiso: es lo único con lo que se puede
// medir el nivel de entrada (ver mic.js), y sin él "grabando" y "grabando pero sordo" se ven
// igual. Opcional: quien no lo pase se comporta como antes.
export function createRecorder({ onStop, onError, onStream } = {}) {
  if (!recorderSupported()) return null;
  let rec = null;
  let stream = null;
  const chunks = [];
  const release = () => { stream?.getTracks().forEach((tr) => tr.stop()); stream = null; };

  return {
    start: async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        onError?.(t('No hay permiso para usar el micrófono. Habilítalo en los ajustes del navegador para este sitio.'));
        return false;
      }
      try {
        rec = new MediaRecorder(stream);
      } catch (e) {
        release();
        onError?.(t('Este navegador no puede grabar audio.'));
        return false;
      }
      onStream?.(stream);
      rec.ondataavailable = (ev) => { if (ev.data?.size) chunks.push(ev.data); };
      rec.onstop = () => {
        release();
        onStop?.(chunks.length ? new Blob(chunks, { type: rec.mimeType || 'audio/webm' }) : null);
      };
      rec.start();
      return true;
    },
    stop: () => { try { rec?.stop(); } catch (e) { release(); } },
  };
}
