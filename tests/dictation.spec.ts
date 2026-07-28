// Dictado del modo Feynman. Lo que hay que blindar es lo que se rompió en móvil: el
// navegador CORTA el reconocimiento en cada pausa (en Android ignora `continuous`), y la
// versión anterior lo daba por terminado —el micro se moría a media explicación sin decir
// nada—. También que los errores dejen de ser todos iguales y que el acumulado sobreviva a
// los reinicios, que es donde se perdía lo ya dictado.
import { test, expect, Page } from '@playwright/test';
import path from 'path';

async function openApp(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => !!document.getElementById('landing'));
}

// Reconocedor falso: registra arranques y deja disparar los eventos a mano.
const installFakeRecognition = (page: Page) => page.evaluate(() => {
  const w = window as any;
  w.__starts = 0;
  w.__instances = [];
  class FakeRecognition {
    continuous = false; interimResults = false; lang = '';
    onresult: any = null; onend: any = null; onerror: any = null;
    constructor() { w.__instances.push(this); }
    start() { w.__starts++; w.__last = this; }
    stop() { /* el test dispara `onend` cuando quiere */ }
  }
  w.SpeechRecognition = FakeRecognition;
  delete w.webkitSpeechRecognition;
});

test.describe('dictado del navegador', () => {
  test('una pausa NO termina el dictado: se rearranca solo', async ({ page }) => {
    await openApp(page);
    await installFakeRecognition(page);
    const out = await page.evaluate(async () => {
      const F: any = await import('/js/ai/feynman.js');
      const w = window as any;
      let ended = 0;
      const d = F.createDictation({ onText: () => {}, onEnd: () => { ended++; } });
      d.start();
      const afterStart = w.__starts;
      w.__last.onend();          // el navegador corta por silencio
      const afterSilence = w.__starts;
      d.stop();                  // ahora sí: el usuario para
      w.__last.onend();
      return { afterStart, afterSilence, endedAfterStop: ended, startsTotal: w.__starts };
    });
    expect(out.afterStart).toBe(1);
    expect(out.afterSilence).toBe(2);      // se rearrancó solo
    expect(out.endedAfterStop).toBe(1);    // y solo terminó cuando el usuario paró
    expect(out.startsTotal).toBe(2);       // parar NO vuelve a arrancar
  });

  test('lo ya dictado sobrevive al rearranque', async ({ page }) => {
    await openApp(page);
    await installFakeRecognition(page);
    const texts = await page.evaluate(async () => {
      const F: any = await import('/js/ai/feynman.js');
      const w = window as any;
      const seen: string[] = [];
      const d = F.createDictation({ onText: (txt: string) => seen.push(txt) });
      d.start();
      const fire = (transcript: string) => w.__last.onresult({
        resultIndex: 0,
        results: [{ 0: { transcript }, isFinal: true, length: 1 }],
      });
      fire('el mecanismo de atención');
      w.__last.onend();          // pausa para pensar → nuevo reconocedor
      fire('usa query key y value');
      return seen;
    });
    // El segundo reconocedor empieza con su `finalText` vacío: si el acumulado viviera
    // dentro, aquí se habría perdido la primera frase.
    expect(texts[0]).toContain('mecanismo de atención');
    expect(texts[1]).toContain('mecanismo de atención');
    expect(texts[1]).toContain('query key y value');
  });

  test('un error fatal avisa y NO reintenta; una pausa no avisa', async ({ page }) => {
    await openApp(page);
    await installFakeRecognition(page);
    const out = await page.evaluate(async () => {
      const F: any = await import('/js/ai/feynman.js');
      const w = window as any;
      const errs: string[] = [];
      const d = F.createDictation({ onText: () => {}, onError: (m: string) => errs.push(m) });
      d.start();
      w.__last.onerror({ error: 'no-speech' });     // inofensivo
      const afterNoSpeech = { errs: errs.length };
      w.__last.onend();                             // reanuda
      const startsAfterResume = w.__starts;
      w.__last.onerror({ error: 'not-allowed' });   // permiso denegado
      w.__last.onend();
      return { afterNoSpeech, startsAfterResume, errs, startsFinal: w.__starts };
    });
    expect(out.afterNoSpeech.errs).toBe(0);      // `no-speech` no es un error de cara al usuario
    expect(out.startsAfterResume).toBe(2);       // y sí reanuda
    expect(out.errs).toHaveLength(1);
    expect(out.errs[0]).toMatch(/permiso/i);
    expect(out.startsFinal).toBe(2);             // tras un fatal no se reintenta contra el muro
  });

  test('cada código de error dice algo distinto', async ({ page }) => {
    await openApp(page);
    const msgs = await page.evaluate(async () => {
      const F: any = await import('/js/ai/feynman.js');
      return {
        notAllowed: F.speechErrorMessage('not-allowed'),
        network: F.speechErrorMessage('network'),
        noMic: F.speechErrorMessage('audio-capture'),
        noSpeech: F.speechErrorMessage('no-speech'),
        aborted: F.speechErrorMessage('aborted'),
      };
    });
    expect(msgs.noSpeech).toBe('');    // no son errores: son pausas
    expect(msgs.aborted).toBe('');
    expect(msgs.notAllowed).not.toBe(msgs.network);
    expect(msgs.notAllowed).not.toBe(msgs.noMic);
    expect(msgs.network).toMatch(/conexión/i);
  });

  test('el idioma NO lo decide la UI: se elige y se recuerda', async ({ page }) => {
    await openApp(page);
    await installFakeRecognition(page);
    const out = await page.evaluate(async () => {
      const F: any = await import('/js/ai/feynman.js');
      const w = window as any;
      F.setDictationLang('en');
      const d = F.createDictation({ onText: () => {} });
      d.start();
      const langEn = w.__last.lang;
      F.setDictationLang('es');
      const d2 = F.createDictation({ onText: () => {} });
      d2.start();
      return { langEn, langEs: w.__last.lang, saved: F.dictationLang() };
    });
    expect(out.langEn).toBe('en-US');
    expect(out.langEs).toBe('es-ES');
    expect(out.saved).toBe('es');
  });
});

// El `select` global lleva `width: 100%`: sin anularlo, el selector de idioma partía la fila
// de acciones en TRES líneas (122 px de alto en escritorio, medido).
test('el selector de idioma no rompe la fila de acciones', async ({ page }) => {
  test.setTimeout(60000);
  await page.addInitScript(() => {
    localStorage.setItem('bookreader_ai_key', JSON.stringify('k-test'));
    localStorage.setItem('bookreader_ai_stt_model', JSON.stringify('whisper'));
  });
  await page.goto('/');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Abrir archivo' }).click(),
  ]);
  await chooser.setFiles(path.join(__dirname, 'test.epub'));
  await expect(page.locator('#reader-title')).toHaveText('Pedro Páramo', { timeout: 15000 });
  await page.evaluate(async () => {
    const F: any = await import('/js/ai/feynman.js');
    F.open({ bookId: 'x', bookTitle: 'Pedro Páramo', tocLabels: [], ensureIndex: () => {}, anchors: new Map() });
    F.__renderSessionForTest(F.newSession('la muerte en Comala', {
      expectations: [{ id: 'e1', text: 'Comala está poblada de muertos', src: 'a1' }],
      misconceptions: [],
    }), 'x');
  });
  await expect(page.locator('#fey-mic')).toBeVisible();
  const sel = page.locator('#fey-mic-lang');
  await expect(sel).toBeVisible();
  const [row, box] = await Promise.all([
    page.locator('.fey-actions').boundingBox(),
    sel.boundingBox(),
  ]);
  expect(row!.height).toBeLessThan(60);      // una sola fila
  expect(box!.width).toBeLessThan(100);      // el selector no se come el ancho
});

test.describe('dictado por proveedor (BYOK)', () => {
  // La razón de ser de este motor: sesgar la transcripción con el vocabulario del capítulo,
  // que la sesión YA tiene calculado. Medido el 2026-07-28 sobre la misma grabación,
  // sin prompt Whisper transcribió "o sea IV" donde el audio decía "o sea A y B".
  test('el prompt sale del concepto y las expectativas de la sesión', async ({ page }) => {
    await openApp(page);
    const prompt = await page.evaluate(async () => {
      const F: any = await import('/js/ai/feynman.js');
      const s = F.newSession('LoRA', {
        expectations: [
          { id: 'e1', text: 'congela los pesos del modelo base', src: 'a1' },
          { id: 'e2', text: 'entrena dos matrices de bajo rango A y B', src: 'a2' },
        ],
        misconceptions: [],
      });
      return F.sttPrompt(s);
    });
    expect(prompt).toContain('LoRA');
    expect(prompt).toContain('bajo rango A y B');
  });

  test('sttPrompt aguanta una sesión vacía', async ({ page }) => {
    await openApp(page);
    const out = await page.evaluate(async () => {
      const F: any = await import('/js/ai/feynman.js');
      return [F.sttPrompt(null), F.sttPrompt({ concept: 'x' })];
    });
    expect(out[0]).toBe('');
    expect(out[1]).toBe('x');
  });

  test('transcribe envía multipart con modelo, prompt e idioma', async ({ page }) => {
    await openApp(page);
    await page.route('**/audio/transcriptions', async (route) => {
      const req = route.request();
      const body = req.postData() || '';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          text: 'dos matrices de bajo rango, o sea A y B',
          __seen: { hasModel: body.includes('whisper'), hasPrompt: body.includes('LoRA'), hasLang: body.includes('name="language"') },
        }),
      });
    });
    const out = await page.evaluate(async () => {
      const LLM: any = await import('/js/ai/llm.js');
      LLM.setKey('k-test');
      LLM.setSttModel('whisper');
      const seen: any = {};
      const orig = window.fetch;
      window.fetch = async (...args: any[]) => {
        const res = await orig.apply(window, args as any);
        const clone = res.clone();
        try { Object.assign(seen, (await clone.json()).__seen); } catch { /* no json */ }
        return res;
      };
      const blob = new Blob([new Uint8Array(4096)], { type: 'audio/webm' });
      const text = await LLM.transcribe({ blob, prompt: 'LoRA, bajo rango', language: 'es' });
      window.fetch = orig;
      return { text, seen };
    });
    expect(out.text).toBe('dos matrices de bajo rango, o sea A y B');
    expect(out.seen.hasModel).toBe(true);
    expect(out.seen.hasPrompt).toBe(true);
    expect(out.seen.hasLang).toBe(true);
  });

  test('sin modelo de transcripción, transcribe falla con un mensaje claro', async ({ page }) => {
    await openApp(page);
    const msg = await page.evaluate(async () => {
      const LLM: any = await import('/js/ai/llm.js');
      LLM.setKey('k-test');
      LLM.setSttModel('');
      try {
        await LLM.transcribe({ blob: new Blob(['x'], { type: 'audio/webm' }) });
        return 'sin error';
      } catch (e: any) { return e.message; }
    });
    expect(msg).toMatch(/transcripción/i);
  });
});
