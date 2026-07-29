// Micro en la barra del chat del agente. Lo que hay que blindar es lo que hace que dictar
// desde el móvil sirva de algo: que el texto se acumule sin pisar lo escrito a mano, y sobre
// todo que ENVIAR mientras grabas espere a la transcripción — con el motor del proveedor el
// texto llega al soltar el botón, así que leer el textarea antes manda el mensaje a medias.
import { test, expect, Page } from '@playwright/test';

async function openApp(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => !!document.getElementById('landing'));
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
