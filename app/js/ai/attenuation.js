// Atenuación de capítulos según el objetivo: puntúa cada capítulo del TOC (0..1)
// con el modelo y tiñe los enlaces del índice (alto/medio/bajo). Extraído de
// panel.js (T8, ver CHANGELOG). Funciones puras/parametrizadas: el orquestador
// (maybeAttenuate, con su flag y caché en DB) se queda en panel.js.
import * as LLM from './llm.js';

// Pide al modelo que puntúe los capítulos del TOC para el objetivo dado.
// Devuelve { [títuloCapítulo]: score 0..1 } o null si no hay puntuaciones.
export async function computeChapterRelevance(toc, annotatedText, goal) {
  const chapters = toc.map(t => t.label.trim()).filter(Boolean);
  const tools = [{
    type: 'function',
    function: {
      name: 'rate_chapters',
      description: 'Puntúa la relevancia de cada capítulo para el objetivo del usuario.',
      parameters: {
        type: 'object',
        properties: {
          ratings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                chapter: { type: 'string', description: 'Título exacto del capítulo.' },
                score: { type: 'number', description: 'Relevancia 0 (irrelevante) a 1 (muy relevante).' },
              },
              required: ['chapter', 'score'],
            },
          },
        },
        required: ['ratings'],
      },
    },
  }];
  const messages = [
    { role: 'system', content:
`Evalúas qué capítulos de un libro sirven al OBJETIVO del usuario. Usa la herramienta
rate_chapters una sola vez, puntuando TODOS los capítulos de la lista de 0 a 1 según su
relevancia para el objetivo (1 = central, 0 = paja/introducción/anécdota).` },
    { role: 'user', content: 'LIBRO ANOTADO:\n\n' + annotatedText },
    { role: 'user', content:
`OBJETIVO: ${goal}\n\nCAPÍTULOS A PUNTUAR (usa estos títulos exactos):\n` +
      chapters.map(c => `- ${c}`).join('\n') },
  ];
  // maxTokens holgado: rate_chapters devuelve una entrada por capítulo en una sola tool-call;
  // con el tope por defecto (1024) un libro con muchos capítulos truncaba la lista → los
  // últimos capítulos quedaban sin puntuar (atenuación incompleta). ~120 tok/capítulo de margen.
  const maxTokens = Math.min(8192, 512 + chapters.length * 120);
  const { toolCalls } = await LLM.chatTools({
    messages, tools, toolChoice: 'auto', maxTokens,
    model: LLM.getLiteModel(),   // auxiliar: puntuar el TOC no necesita el modelo grande
  });
  const call = toolCalls.find(t => t.name === 'rate_chapters');
  if (!call || !Array.isArray(call.args.ratings)) return null;
  const scores = {};
  for (const r of call.args.ratings) {
    if (typeof r.chapter === 'string' && typeof r.score === 'number') {
      scores[r.chapter.trim()] = Math.max(0, Math.min(1, r.score));
    }
  }
  return Object.keys(scores).length ? scores : null;
}

export function applyChapterAttenuation(scores) {
  const links = document.querySelectorAll('#toc-list a');
  links.forEach(a => {
    const label = a.textContent.trim();
    if (!(label in scores)) return;
    const s = scores[label];
    a.classList.remove('ai-toc-low', 'ai-toc-mid', 'ai-toc-high');
    if (s >= 0.66) a.classList.add('ai-toc-high');
    else if (s >= 0.33) a.classList.add('ai-toc-mid');
    else a.classList.add('ai-toc-low');
    a.title = `Relevancia para tu objetivo: ${Math.round(s * 100)}%`;
  });
}

export function clearChapterAttenuation() {
  document.querySelectorAll('#toc-list a').forEach(a => {
    a.classList.remove('ai-toc-low', 'ai-toc-mid', 'ai-toc-high');
    a.removeAttribute('title');
  });
}
