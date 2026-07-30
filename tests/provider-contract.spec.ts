import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

// CONTRATO CON EL PROVEEDOR (@live) · Verifica, contra la API REAL, las afirmaciones sobre
// el proveedor que hoy viven como comentarios en el código y de las que cuelgan decisiones
// de arquitectura enteras:
//
//   «nan rechaza peticiones concurrentes a la misma key»   → premisa de ADR-027
//   «qwen3.6 responde rápido y soporta tools»              → ADR-022 (routing lite)
//   «mimo-v2.5 interpreta imágenes»                        → slot de visión
//   «/models está bloqueado por CORS»                      → el fallback manual de Ajustes
//
// Eso es lo que se pudre en silencio: el proveedor cambia y nuestros presets mienten sin
// que nada se ponga rojo. Y hay premio en el otro sentido — si nan arregla la concurrencia,
// este test lo detecta y podemos poner `concurrent: true` y ganar paralelismo real.
//
// REGLA DE DISEÑO, y es la que hace viable un test contra un modelo real:
//   SE AFIRMAN CAPACIDADES, NUNCA CONTENIDO.
// Nada de "la respuesta menciona X": eso es flaky por construcción y además ya lo mide el
// juez de la batería @eval. Aquí se afirma "devolvió un tool_call", "aceptó una imagen",
// "el segundo request concurrente falló". Estable, barato (max_tokens mínimos) y es lo que
// mantiene honesto a `PROVIDERS`.
//
// Se lanza con `npm run test:provider`. Sin NAN_API_KEY se salta entero.

const KEY = process.env.NAN_API_KEY;
const BASE = process.env.PROVIDER_BASE_URL || 'https://api.nan.builders/v1';
const MODEL = process.env.PROVIDER_MODEL || 'deepseek-v4-flash';
const LITE = process.env.PROVIDER_LITE_MODEL || 'qwen3.6';
const VISION = process.env.PROVIDER_VISION_MODEL || 'mimo-v2.5';

// Matriz de capacidades: cada test apunta aquí y al final se imprime junta. El valor de
// esta suite no es el semáforo, es enterarse de QUÉ ha cambiado en el proveedor.
type Cap = { capacidad: string; modelo: string; resultado: string; detalle: string };
const matriz: Cap[] = [];
const anota = (capacidad: string, modelo: string, ok: boolean, detalle = '') =>
  matriz.push({ capacidad, modelo, resultado: ok ? '✓' : '✗', detalle });

test.describe('Contrato con el proveedor @live', () => {
  test.skip(!KEY, 'NAN_API_KEY no definido (crea .env a partir de .env.example)');
  // A propósito NO se usa `mode: 'serial'`: aborta el resto en cuanto uno falla, y aquí eso
  // sería justo lo contrario de lo que se busca — una capacidad rota escondería el estado de
  // las otras cinco, que es la información que da valor a la matriz. La ejecución ya es
  // secuencial (un worker, mismo fichero), que es lo único que necesitamos para no dispararle
  // peticiones concurrentes a un proveedor que puede rechazarlas.

  // Configura la app con el proveedor bajo prueba y devuelve el módulo LLM ya listo.
  const conProveedor = async (page) => {
    await page.goto('/');
    await page.evaluate(({ k, b, m }) => {
      localStorage.setItem('bookreader_ai_key', JSON.stringify(k));
      localStorage.setItem('bookreader_ai_base_url', JSON.stringify(b));
      localStorage.setItem('bookreader_ai_model', JSON.stringify(m));
    }, { k: KEY, b: BASE, m: MODEL });
    await page.reload();
  };

  test('streaming SSE: el modelo principal emite tokens que sabemos parsear', async ({ page }) => {
    test.setTimeout(120000);
    await conProveedor(page);
    const r = await page.evaluate(async (model) => {
      const L: any = await import('/js/ai/llm.js');
      let contenido = 0, razonamiento = 0;
      const t0 = Date.now();
      // CUPO GENEROSO a propósito. El modelo por defecto RAZONA: con un cupo pequeño se lo
      // gasta entero pensando y emite CERO contenido visible — con `max_tokens: 16` este
      // test daba 0 trozos y parecía que el streaming estaba roto, cuando lo roto era el
      // test. El repo ya lo sabía (mindmap.js pide 5000 "porque los modelos de razonamiento
      // gastan miles de tokens pensando antes del JSON"). Es el error clásico al escribir
      // tests contra un modelo real, y merece quedar escrito.
      const full = await L.chatStream({
        messages: [{ role: 'user', content: 'Di "ok" y nada más.' }],
        model, maxTokens: 800,
        onToken: () => { contenido++; },
        onReasoning: () => { razonamiento++; },
      });
      return { contenido, razonamiento, largo: String(full || '').length, ms: Date.now() - t0 };
    }, MODEL);
    // Lo que se afirma es que SABEMOS PARSEAR su stream, no que diga algo concreto: sirve
    // igual un delta de contenido que uno de razonamiento (ambos salen de nuestro parser SSE).
    const trozos = r.contenido + r.razonamiento;
    anota('streaming SSE', MODEL, trozos > 0,
      `${r.contenido} contenido + ${r.razonamiento} razonamiento · ${r.ms} ms`);
    expect(trozos, 'el stream debe emitir deltas parseables').toBeGreaterThan(0);
  });

  // Las flashcards piden tool-calling y caen a texto plano si el proveedor no lo soporta
  // (fallback documentado). Que el fallback exista no significa que el camino bueno funcione:
  // si el tool-calling se rompe, TODAS las generaciones bajan de calidad en silencio.
  test('tool-calling: el modelo principal devuelve un tool_call', async ({ page }) => {
    test.setTimeout(120000);
    await conProveedor(page);
    const r = await page.evaluate(async (model) => {
      const L: any = await import('/js/ai/llm.js');
      const tools = [{
        type: 'function',
        function: {
          name: 'guardar_dato',
          description: 'Guarda un dato numérico.',
          parameters: { type: 'object', properties: { valor: { type: 'number' } }, required: ['valor'] },
        },
      }];
      const t0 = Date.now();
      const { toolCalls } = await L.chatTools({
        messages: [{ role: 'user', content: 'Guarda el número 42 usando la herramienta.' }],
        tools, toolChoice: 'auto', model, maxTokens: 256,
      });
      return { n: (toolCalls || []).length, nombre: toolCalls?.[0]?.name || '(sin nombre)', ms: Date.now() - t0 };
    }, MODEL);
    anota('tool-calling', MODEL, r.n > 0, r.n > 0 ? `${r.nombre} · ${r.ms} ms` : 'sin tool_calls (se usaría el fallback de texto)');
    expect(r.n, 'el modelo principal debe soportar tool-calling').toBeGreaterThan(0);
  });

  // ADR-022 declara `liteModel: 'qwen3.6'` con dos requisitos: rápido Y con tools (la
  // expansión de consulta y la atenuación lo necesitan). Verificado a mano una vez, en 2026.
  test('el modelo LITE del preset sigue soportando tools, y sigue siendo rápido', async ({ page }) => {
    test.setTimeout(120000);
    await conProveedor(page);
    const r = await page.evaluate(async (lite) => {
      const L: any = await import('/js/ai/llm.js');
      const tools = [{
        type: 'function',
        function: {
          name: 'buscar',
          description: 'Busca términos.',
          parameters: { type: 'object', properties: { terminos: { type: 'array', items: { type: 'string' } } }, required: ['terminos'] },
        },
      }];
      const t0 = Date.now();
      const { toolCalls } = await L.chatTools({
        messages: [{ role: 'user', content: 'Busca los términos "consenso" y "réplica".' }],
        tools, toolChoice: 'auto', model: lite, maxTokens: 256,
      });
      return { n: (toolCalls || []).length, ms: Date.now() - t0 };
    }, LITE);
    anota('tool-calling (lite)', LITE, r.n > 0, `${r.ms} ms`);
    expect(r.n, `${LITE} debe soportar tools (lo asume ADR-022)`).toBeGreaterThan(0);
    // No es una aserción de rendimiento dura (la red varía): es un aviso si el modelo lite
    // deja de ser lite, que es el único motivo por el que lo elegimos.
    if (r.ms > 6000) console.warn(`[contrato] ${LITE} tardó ${r.ms} ms — el routing lite (ADR-022) deja de tener sentido si no es rápido.`);
  });

  test('visión: el modelo declarado acepta una imagen', async ({ page }) => {
    test.setTimeout(120000);
    await conProveedor(page);
    const r = await page.evaluate(async (vision) => {
      const L: any = await import('/js/ai/llm.js');
      L.setVisionModel(vision);
      // Un PNG de 2×2 mitad negro mitad blanco: mínimo, pero no degenerado.
      const img = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAF0lEQVR4nGP8//8/AzbAxIAD0FKCgQEAOnwCAempTgoAAAAASUVORK5CYII=';
      const t0 = Date.now();
      try {
        const out = await L.chatVision({
          messages: [{ role: 'user', content: [
            { type: 'text', text: '¿Ves una imagen? Responde sí o no.' },
            { type: 'image_url', image_url: { url: img } },
          ] }],
          maxTokens: 16,
        });
        return { ok: true, largo: String(out || '').length, ms: Date.now() - t0, err: '' };
      } catch (e: any) {
        return { ok: false, largo: 0, ms: Date.now() - t0, err: String(e.message).slice(0, 160) };
      }
    }, VISION);
    anota('visión (image_url)', VISION, r.ok, r.ok ? `${r.ms} ms` : r.err);
    expect(r.ok, `${VISION} debe aceptar contenido multimodal`).toBe(true);
  });

  // LA PREMISA DE ADR-027. Si esto empieza a pasar (= nan acepta concurrencia), el ADR
  // puede relajarse: `concurrent: true` en el preset y se acabó la serialización.
  test('concurrencia: ¿sigue rechazando dos peticiones a la vez con la misma key?', async ({ page }) => {
    test.setTimeout(120000);
    await conProveedor(page);
    const r = await page.evaluate(async (model) => {
      // A PROPÓSITO sin pasar por llm.js: la cola de ADR-027 serializa, que es justo lo que
      // queremos saltarnos para medir el comportamiento CRUDO del proveedor.
      const key = JSON.parse(localStorage.getItem('bookreader_ai_key') || '""');
      const base = JSON.parse(localStorage.getItem('bookreader_ai_base_url') || '""');
      const uno = () => fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'di ok' }], stream: false, max_tokens: 4 }),
      }).then(res => ({ ok: res.ok, status: res.status }), e => ({ ok: false, status: 0, err: String(e).slice(0, 80) }));
      // VARIAS RONDAS. Con una sola muestra de 3, un "salió bien" no distingue "el proveedor
      // acepta concurrencia" de "hoy había poca carga". Cambiar `concurrent` afecta a TODAS
      // las llamadas del proveedor por defecto, así que la evidencia tiene que dar para eso.
      const out: any[] = [];
      for (let ronda = 0; ronda < 3; ronda++) {
        out.push(...await Promise.all([uno(), uno(), uno(), uno()]));
        await new Promise((res) => setTimeout(res, 300));
      }
      return out;
    }, MODEL);
    const okN = r.filter((x: any) => x.ok).length;
    const rechaza = okN < r.length;
    anota('rechaza concurrencia', MODEL, rechaza,
      rechaza ? `${okN}/${r.length} salieron bien → la serialización de ADR-027 sigue haciendo falta`
              : `${okN}/${r.length} salieron bien (3 rondas de 4) → se puede revisar concurrent:true`);
    // NO se afirma un resultado: las dos respuestas son información útil, y fallar cuando el
    // proveedor MEJORA sería absurdo. El valor está en la matriz y en el aviso.
    if (!rechaza) {
      console.warn(`[contrato] El proveedor aceptó ${okN}/${r.length} peticiones concurrentes. Revisar ADR-027: ` +
                   'puede que `concurrent: true` en el preset sea ya correcto (paralelismo gratis).');
    }
    expect(r.length, 'las 3 rondas de 4 deben haberse ejecutado').toBe(12);
  });

  test('/models: ¿sigue bloqueado por CORS desde el navegador?', async ({ page }) => {
    test.setTimeout(60000);
    await conProveedor(page);
    const r = await page.evaluate(async () => {
      const L: any = await import('/js/ai/llm.js');
      try {
        const ids = await L.listModels();
        return { ok: true, n: ids.length, cors: false, err: '' };
      } catch (e: any) {
        return { ok: false, n: 0, cors: !!e.cors, err: String(e.message).slice(0, 120) };
      }
    });
    anota('/models enumerable', BASE, r.ok,
      r.ok ? `${r.n} modelos` : (r.cors ? 'bloqueado por CORS (la UI ofrece el modo manual)' : r.err));
    // Tampoco se afirma: si un día deja de estar bloqueado, la UI de Ajustes puede dejar de
    // insistir en escribir el id a mano. Lo que importa es enterarse.
    if (r.ok) console.warn(`[contrato] /models ya responde (${r.n} modelos): el aviso de CORS de Ajustes puede sobrar.`);
    expect(typeof r.ok).toBe('boolean');
  });

  // La matriz se imprime al final y se deja en disco: es el entregable de esta suite.
  test.afterAll(async () => {
    if (!matriz.length) return;
    const ancho = (k: keyof Cap) => Math.max(k.length, ...matriz.map(f => String(f[k]).length));
    const w = { capacidad: ancho('capacidad'), modelo: ancho('modelo'), resultado: 9, detalle: ancho('detalle') };
    const fila = (c: string, m: string, r: string, d: string) =>
      `│ ${c.padEnd(w.capacidad)} │ ${m.padEnd(w.modelo)} │ ${r.padEnd(w.resultado)} │ ${d.padEnd(w.detalle)} │`;
    const linea = (l: string, x: string, rr: string) =>
      l + '─'.repeat(w.capacidad + 2) + x + '─'.repeat(w.modelo + 2) + x + '─'.repeat(w.resultado + 2) + x + '─'.repeat(w.detalle + 2) + rr;
    const out = [
      '', `CONTRATO DEL PROVEEDOR · ${BASE}`,
      linea('┌', '┬', '┐'), fila('capacidad', 'modelo', 'resultado', 'detalle'), linea('├', '┼', '┤'),
      ...matriz.map(f => fila(f.capacidad, f.modelo, f.resultado, f.detalle)),
      linea('└', '┴', '┘'), '',
    ].join('\n');
    console.log(out);
    const dir = path.resolve(__dirname, '..', 'evals', 'runs');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'provider-contract.json'),
        JSON.stringify({ base: BASE, at: new Date().toISOString(), matriz }, null, 2));
    } catch { /* sin disco: la matriz por consola ya cumple */ }
  });
});
