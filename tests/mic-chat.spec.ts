// Micro en la barra del chat del agente. Lo que hay que blindar es lo que hace que dictar
// desde el móvil sirva de algo: que el texto se acumule sin pisar lo escrito a mano, y sobre
// todo que ENVIAR mientras grabas espere a la transcripción — con el motor del proveedor el
// texto llega al soltar el botón, así que leer el textarea antes manda el mensaje a medias.
import { test, expect, Page } from '@playwright/test';

async function openApp(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => !!document.getElementById('library'));
}

// MediaRecorder falso: graba "audio" sin micro real y deja controlar cuándo para.
const installFakeRecorder = (page: Page) => page.evaluate(() => {
  const w = window as any;
  w.__recStarts = 0;
  class FakeRecorder {
    mimeType = 'audio/webm';
    ondataavailable: any = null; onstop: any = null;
    start() { w.__recStarts++; w.__lastRec = this; }
    stop() {
      this.ondataavailable?.({ data: new Blob(['x'.repeat(4000)], { type: 'audio/webm' }) });
      this.onstop?.();
    }
  }
  w.MediaRecorder = FakeRecorder;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [] }) },
  });
});

test('el micro solo aparece si hay dictado disponible', async ({ page }) => {
  await openApp(page);
  const hidden = await page.evaluate(async () => {
    const w = window as any;
    delete w.SpeechRecognition; delete w.webkitSpeechRecognition; delete w.MediaRecorder;
    const M: any = await import('/js/ai/mic.js');
    return M.micAvailable();
  });
  expect(hidden).toBe(false);

  const shown = await page.evaluate(async () => {
    const w = window as any;
    w.SpeechRecognition = class { start() {} stop() {} };
    const M: any = await import('/js/ai/mic.js');
    return M.micAvailable();
  });
  expect(shown).toBe(true);
});

test('el texto dictado se acumula sin pisar lo escrito a mano', async ({ page }) => {
  await openApp(page);
  const out = await page.evaluate(async () => {
    const w = window as any;
    w.SpeechRecognition = class {
      continuous = false; interimResults = false; lang = '';
      onresult: any = null; onend: any = null; onerror: any = null;
      start() { w.__last = this; }
      stop() {}
    };
    const M: any = await import('/js/ai/mic.js');
    const input = document.createElement('textarea');
    const btn = document.createElement('button');
    btn.innerHTML = '<span></span>';
    document.body.append(input, btn);
    M.attachMic({ input, btn });
    btn.click();

    const say = (text: string) => w.__last.onresult({
      resultIndex: 0,
      results: Object.assign([[{ transcript: text }]].map((r: any) => Object.assign(r, { isFinal: true })), { length: 1 }),
    });
    say('hola ');
    const tras1 = input.value;
    // El usuario corrige a mano lo dictado y sigue hablando: la corrección debe sobrevivir.
    input.value = 'HOLA ';
    say('que tal ');
    return { tras1, final: input.value, grabando: btn.getAttribute('aria-pressed') };
  });
  expect(out.tras1.trim()).toBe('hola');
  expect(out.final).toContain('HOLA');       // la corrección manual no se pisó
  expect(out.final).toContain('que tal');
  expect(out.grabando).toBe('true');
});

test('stop() espera a la transcripción del proveedor antes de resolver', async ({ page }) => {
  await openApp(page);
  await installFakeRecorder(page);

  // Transcripción LENTA de verdad (se responde cuando el test lo diga): es justo el hueco
  // donde se perdía el último tramo si enviar no esperaba.
  let responder: () => void;
  const enVuelo = new Promise<void>((r) => { responder = r; });
  await page.route('**/audio/transcriptions', async (route) => {
    await enVuelo;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: 'la ultima frase' }) });
  });
  await page.exposeFunction('__responder', () => responder());

  const out = await page.evaluate(async () => {
    const w = window as any;
    delete w.SpeechRecognition; delete w.webkitSpeechRecognition;
    const LLM: any = await import('/js/ai/llm.js');
    const M: any = await import('/js/ai/mic.js');
    // Motor BYOK: hace falta key + modelo de transcripción configurados.
    LLM.setKey('test-key');
    LLM.setSttModel('whisper-1');
    if (!LLM.hasStt()) return { skip: true };

    const input = document.createElement('textarea');
    const btn = document.createElement('button');
    btn.innerHTML = '<span></span>';
    document.body.append(input, btn);
    const mic = M.attachMic({ input, btn });

    btn.click();
    await new Promise((r) => setTimeout(r, 50));   // `start` pide permiso (async)
    const arrancó = w.__recStarts;

    const stopped = mic.stop();
    let resueltoAntes = false;
    stopped.then(() => { resueltoAntes = true; });
    await new Promise((r) => setTimeout(r, 30));
    const antesDeResponder = { resueltoAntes, texto: input.value };

    w.__responder();
    await stopped;
    return { skip: false, arrancó, antesDeResponder, textoFinal: input.value };
  });

  if (out.skip) test.skip(true, 'el motor BYOK no quedó configurado en este entorno');
  expect(out.arrancó).toBe(1);
  // Mientras la transcripción está en vuelo, stop() NO ha resuelto y el textarea sigue vacío.
  expect(out.antesDeResponder.resueltoAntes).toBe(false);
  expect(out.antesDeResponder.texto).toBe('');
  // Al resolver, el texto YA está puesto: quien esperó a stop() lee el mensaje completo.
  expect(out.textoFinal).toContain('la ultima frase');
});

// ---- barra de grabación (patrón WhatsApp) -----------------------------------

test('la barra sustituye al textarea, cuenta el tiempo y el vúmetro sigue al nivel', async ({ page }) => {
  await openApp(page);
  await installFakeRecorder(page);
  // Stream sintético con nivel controlable: es lo que distingue "te oigo" de "micro mudo".
  await page.evaluate(() => {
    const w = window as any;
    w.__nivel = 0;
    class FakeAnalyser {
      fftSize = 512;
      getByteTimeDomainData(buf: Uint8Array) { buf.fill(128 + Math.round(w.__nivel * 127)); }
    }
    w.AudioContext = class {
      createMediaStreamSource() { return { connect() {} }; }
      createAnalyser() { return new FakeAnalyser(); }
      close() {}
    };
  });

  const out = await page.evaluate(async () => {
    const w = window as any;
    delete w.SpeechRecognition; delete w.webkitSpeechRecognition;
    const LLM: any = await import('/js/ai/llm.js');
    const M: any = await import('/js/ai/mic.js');
    LLM.setKey('test-key'); LLM.setSttModel('whisper-1');

    const wrap = document.createElement('div');
    const input = document.createElement('textarea');
    const btn = document.createElement('button');
    btn.innerHTML = '<span></span>';
    wrap.append(input); document.body.append(wrap, btn);
    M.attachMic({ input, btn });

    const bar = wrap.querySelector('.mic-bar') as HTMLElement;
    const oculta = bar.hidden;

    btn.click();
    await new Promise((r) => setTimeout(r, 60));
    const grabando = { barra: !bar.hidden, textarea: input.classList.contains('is-recording'), provider: bar.classList.contains('is-provider') };

    // Nivel alto → se encienden barras; silencio → se apagan.
    w.__nivel = 0.9;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const conVoz = wrap.querySelectorAll('.mic-bar-level i.on').length;
    w.__nivel = 0;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const enSilencio = wrap.querySelectorAll('.mic-bar-level i.on').length;

    return { oculta, grabando, conVoz, enSilencio, reloj: bar.querySelector('.mic-bar-time')!.textContent };
  });

  expect(out.oculta).toBe(true);              // en reposo no ocupa nada
  expect(out.grabando).toEqual({ barra: true, textarea: true, provider: true });
  expect(out.conVoz).toBeGreaterThan(0);      // el vúmetro reacciona a la voz…
  expect(out.enSilencio).toBe(0);             // …y delata el micro mudo
  expect(out.reloj).toMatch(/^\d:\d\d$/);
});

test('la papelera descarta sin gastar la llamada a Whisper', async ({ page }) => {
  await openApp(page);
  await installFakeRecorder(page);

  let llamadas = 0;
  await page.route('**/audio/transcriptions', async (route) => {
    llamadas++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: 'no deberia salir' }) });
  });

  const out = await page.evaluate(async () => {
    const w = window as any;
    delete w.SpeechRecognition; delete w.webkitSpeechRecognition;
    const LLM: any = await import('/js/ai/llm.js');
    const M: any = await import('/js/ai/mic.js');
    LLM.setKey('test-key'); LLM.setSttModel('whisper-1');

    const wrap = document.createElement('div');
    const input = document.createElement('textarea');
    const btn = document.createElement('button');
    btn.innerHTML = '<span></span>';
    wrap.append(input); document.body.append(wrap, btn);
    const mic = M.attachMic({ input, btn });

    btn.click();
    await new Promise((r) => setTimeout(r, 60));
    (wrap.querySelector('.mic-bar-cancel') as HTMLElement).click();
    await mic.stop();
    await new Promise((r) => setTimeout(r, 120));

    const bar = wrap.querySelector('.mic-bar') as HTMLElement;
    return { texto: input.value, barraOculta: bar.hidden, grabando: mic.recording() };
  });

  expect(llamadas).toBe(0);                   // ni se transcribe ni se cobra
  expect(out.texto).toBe('');
  expect(out.barraOculta).toBe(true);         // la UI vuelve a reposo
  expect(out.grabando).toBe(false);
});

// Parar la grabación solo se podía volviendo a pulsar el botón del micro, que mientras grabas
// queda fuera de donde miras (la barra sustituye al textarea) y sigue enseñando un icono de
// micro. La pista "Pulsa el micro para terminar" tapaba ese hueco... salvo con el motor del
// proveedor, donde se ocultaba para dejar sitio al vúmetro: ahí no quedaba ninguna indicación.
// Ahora hay botón de parar en la propia barra, y transcribe igual que el micro.
test('el botón de parar de la barra termina la grabación y transcribe', async ({ page }) => {
  await openApp(page);
  await installFakeRecorder(page);

  let llamadas = 0;
  await page.route('**/audio/transcriptions', async (route) => {
    llamadas++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: 'dictado con el boton de parar' }) });
  });

  const out = await page.evaluate(async () => {
    const w = window as any;
    delete w.SpeechRecognition; delete w.webkitSpeechRecognition;
    const LLM: any = await import('/js/ai/llm.js');
    const M: any = await import('/js/ai/mic.js');
    LLM.setKey('test-key'); LLM.setSttModel('whisper-1');

    const wrap = document.createElement('div');
    const input = document.createElement('textarea');
    const btn = document.createElement('button');
    btn.innerHTML = '<span></span>';
    wrap.append(input); document.body.append(wrap, btn);
    const mic = M.attachMic({ input, btn });

    const bar = wrap.querySelector('.mic-bar') as HTMLElement;
    const stop = wrap.querySelector('.mic-bar-stop') as HTMLElement;
    const enReposo = { existe: !!stop, barraOculta: bar.hidden };

    btn.click();
    await new Promise((r) => setTimeout(r, 60));
    const visibleAlGrabar = !!stop && getComputedStyle(stop).display !== 'none';

    stop.click();                 // ← lo que antes solo hacía el botón del micro
    await mic.stop();
    await new Promise((r) => setTimeout(r, 150));

    return { enReposo, visibleAlGrabar, texto: input.value, barraOculta: bar.hidden, grabando: mic.recording() };
  });

  expect(out.enReposo).toEqual({ existe: true, barraOculta: true });
  expect(out.visibleAlGrabar).toBe(true);
  expect(llamadas).toBe(1);                             // sí transcribe (la papelera no)
  expect(out.texto).toBe('dictado con el boton de parar');
  expect(out.barraOculta).toBe(true);                   // la UI vuelve a reposo
  expect(out.grabando).toBe(false);
});
