#!/usr/bin/env node
// EV1 · Juez LLM sobre un run de evals (docs/EVALS.md): puntúa lo que exige criterio
// (fidelidad, atomicidad, pertinencia de citas, cobertura de conceptos dorados) con el
// pasaje fuente delante. Juez de OTRA familia que el generador (sesgo de auto-
// preferencia); temperature 0. Los checks duros ya los hizo check.mjs.
//
// Uso: node evals/judge.mjs [run]   · Env: EVAL_JUDGE (default mimo-v2.5)
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, resolveRunDir, loadBatteries, summaryOf, cardsOf, citesOf, nanChat, lastJsonObject, avg } from './lib.mjs';

loadEnv();
const JUDGE = process.env.EVAL_JUDGE || 'mimo-v2.5';
const MAX_CARDS = 12;      // muestra de tarjetas juzgadas una a una (coste/estabilidad)
const MAX_CITES = 15;      // puntos citados del resumen que se verifican contra su pasaje

const runDir = resolveRunDir();
const out = { judge: JUDGE, date: new Date().toISOString(), batteries: {} };

for (const b of loadBatteries(runDir)) {
  const id = b.battery.id;
  if (b.meta?.model === JUDGE) console.warn(`⚠ ${id}: juez y generador son el mismo modelo (${JUDGE}) — sesgo de auto-preferencia`);
  const byId = new Map((b.passages || []).map(p => [p.id, p]));
  // El resumen sigue el idioma de la UI (P15); las tarjetas, el del libro.
  const langName = (b.meta?.uiLang || 'es') === 'es' ? 'español' : 'inglés';
  console.log(`\n${id} — juzgando con ${JUDGE}…`);

  // ---- Tarjetas: fidelidad/atomicidad/utilidad, cada una CON su pasaje fuente ----
  const cards = cardsOf(b).slice(0, MAX_CARDS);
  const cardsPayload = cards.map((c, i) => ({
    n: i + 1, front: c.front, back: c.back,
    pasaje_fuente: byId.get(c.src)?.text?.slice(0, 900) || '(sin ancla válida)',
  }));
  const rawCards = await nanChat({
    model: JUDGE,
    messages: [
      { role: 'system', content:
`Eres un evaluador RIGUROSO de flashcards de estudio. Para cada tarjeta puntúa de 1 a 5:
- "fidelidad": la respuesta (back) está respaldada por el pasaje_fuente. 5 = todo respaldado; 3 = mezcla
  respaldado con extrapolación; 1 = contradice el pasaje o se lo inventa. Si el pasaje es "(sin ancla
  válida)", juzga solo la plausibilidad interna y anótalo.
- "atomicidad": una sola idea por tarjeta. 5 = un hecho/concepto; 1 = pregunta múltiple o respuesta-párrafo.
- "utilidad": ¿un examen sobre este material la preguntaría así? 5 = pregunta de examen natural; 1 = trivial
  (fechas de edición, metadatos) o imposible de responder sin ver la tarjeta.
Sé exigente: 5 es excepcional. Responde SOLO un objeto JSON:
{"cards":[{"n":1,"fidelidad":N,"atomicidad":N,"utilidad":N,"nota":"máx 15 palabras"}...]}` },
      { role: 'user', content: `PERFIL DEL USUARIO: ${b.battery.persona}\nOBJETIVO: ${b.battery.goal}\n\nTARJETAS:\n${JSON.stringify(cardsPayload, null, 1)}` },
    ],
    maxTokens: 8192,   // mimo razona antes de responder: el razonamiento consume el mismo cupo
  });
  const cardsRes = lastJsonObject(rawCards);
  if (!cardsRes?.cards) console.warn(`  ⚠ tarjetas: respuesta no parseable (${rawCards.length} chars): ${rawCards.slice(0, 200).replace(/\n/g, ' ')}…`);

  // ---- Cobertura: conceptos dorados vs el mazo completo -------------------------
  const fronts = cardsOf(b).map((c, i) => `${i + 1}. ${c.front} → ${c.back}`.slice(0, 220));
  const coverRes = lastJsonObject(await nanChat({
    model: JUDGE,
    messages: [
      { role: 'system', content:
`Evalúas la COBERTURA de un mazo de flashcards frente a una lista dorada de conceptos que el estudiante
DEBE dominar. Un concepto está "cubierto" si alguna tarjeta lo pregunta o lo explica de forma que
estudiarla lo fija (no basta una mención de pasada). Responde SOLO JSON:
{"conceptos":[{"concepto":"...","cubierto":true|false,"tarjeta":N|null}...]}` },
      { role: 'user', content: `CONCEPTOS DORADOS:\n${b.battery.goldenConcepts.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\nMAZO:\n${fronts.join('\n')}` },
    ],
  }));

  // ---- Resumen: fidelidad + pertinencia de citas + cobertura + concisión --------
  const summary = summaryOf(b) || '';
  // Muestra REPARTIDA de citas (no las N primeras: un resumen largo cita por secciones y
  // truncar por delante deja secciones enteras sin pasaje que verificar).
  const allCited = [...new Set(citesOf(summary))];
  const step = Math.max(1, Math.ceil(allCited.length / MAX_CITES));
  const citedIds = allCited.filter((_, i) => i % step === 0).slice(0, MAX_CITES);
  const citedPassages = citedIds.map(cid => `[[${cid}]] ${byId.get(cid)?.text?.slice(0, 700) || '(ancla inválida)'}`);
  const rawSum = !summary ? '' : await nanChat({
    model: JUDGE,
    messages: [
      { role: 'system', content:
`Eres un evaluador RIGUROSO de resúmenes citados de libros. El resumen cita pasajes con marcadores [[aN]];
te doy el texto real de una MUESTRA de esos pasajes. Evalúa las citas SOLO contra los pasajes
proporcionados; si un marcador citado no está en la muestra, ignóralo (NO lo penalices como
"no verificable"). Puntúa de 1 a 5:
- "fidelidad": lo que afirma el resumen está en el libro (según los pasajes). 1 = inventa o distorsiona.
- "pertinencia_citas": cada punto cita un pasaje que RESPALDA ESE punto (no uno cualquiera del tema).
  Es el criterio más importante: verifica punto a punto.
- "cobertura": el resumen toca los conceptos dorados listados. 5 = casi todos; 1 = deja fuera lo central.
- "concision": sin relleno; cada frase aporta. 1 = un tercio de la longitud diría lo mismo.
- "idioma": escrito con naturalidad en ${langName}. 5 = nativo; 1 = idioma equivocado.
Sé exigente: 5 es excepcional. Responde SOLO JSON:
{"fidelidad":N,"pertinencia_citas":N,"cobertura":N,"concision":N,"idioma":N,
 "peores_puntos":["máx 3, cita el punto y qué falla"]}` },
      { role: 'user', content:
`PERFIL: ${b.battery.persona}\nOBJETIVO: ${b.battery.goal}\n\nCONCEPTOS DORADOS:\n${b.battery.goldenConcepts.join(' · ')}\n\nRESUMEN:\n${summary.slice(0, 9000)}\n\nPASAJES CITADOS (texto real):\n${citedPassages.join('\n\n')}` },
    ],
    maxTokens: 8192,
  });
  const sumRes = rawSum ? lastJsonObject(rawSum) : null;
  if (summary && !sumRes) console.warn(`  ⚠ resumen: respuesta no parseable (${rawSum.length} chars): ${rawSum.slice(0, 200).replace(/\n/g, ' ')}…`);

  // ---- F2 · Chat: grounding y honestidad (pregunta trampa) ----------------------
  const v2 = (b.meta?.evalVersion || 1) >= 2;
  let chatRes = null;
  if (v2 && (b.chat || []).length) {
    chatRes = lastJsonObject(await nanChat({
      model: JUDGE,
      messages: [
        { role: 'system', content:
`Eres un evaluador RIGUROSO de un tutor de lectura que responde SOLO desde el libro del usuario.
Para cada par pregunta/respuesta puntúa de 1 a 5:
- "fundamento": la respuesta se apoya en contenido concreto del libro (usa los CONCEPTOS DORADOS
  como referencia de qué contiene). 5 = específica y anclada; 1 = genérica, podría venir de cualquier sitio.
- "honestidad": SOLO para preguntas marcadas trap=true — cuya respuesta NO está en el libro.
  5 = dice con claridad que el libro no lo trata (aunque añada contexto general marcándolo como
  externo); 1 = responde como si el libro lo dijera. En preguntas no-trampa, pon null.
- "claridad": pedagogía y estructura de la respuesta.
Responde SOLO JSON: {"turnos":[{"n":1,"fundamento":N,"honestidad":N|null,"claridad":N,"nota":"máx 12 palabras"}...]}` },
        { role: 'user', content:
`PERFIL: ${b.battery.persona}\nLIBRO: ${b.meta?.fixture}\nCONCEPTOS DORADOS DEL LIBRO:\n${b.battery.goldenConcepts.join(' · ')}\n\nTURNOS:\n${JSON.stringify(b.chat.map((c, i) => ({ n: i + 1, trap: c.trap, pregunta: c.q, respuesta: c.answer.slice(0, 1800) })), null, 1)}` },
      ],
      maxTokens: 8192,
    }));
    if (!chatRes?.turnos) console.warn('  ⚠ chat: respuesta del juez no parseable');
  }

  // ---- F2 · Mindmap: jerarquía, cobertura, invención ----------------------------
  const mmArt = (b.artifacts || []).filter(a => a.kind === 'mindmap').pop();
  let mmRes = null;
  if (v2 && mmArt?.result) {
    mmRes = lastJsonObject(await nanChat({
      model: JUDGE,
      messages: [
        { role: 'system', content:
`Eres un evaluador RIGUROSO de mapas mentales de libros. Puntúa de 1 a 5:
- "jerarquia": cada hijo pertenece de verdad a su rama padre; la estructura refleja la del material.
- "cobertura": las ramas principales cubren los conceptos dorados listados.
- "no_invencion": nada del árbol es ajeno al libro (usa los conceptos dorados y el título como referencia).
Sé exigente. Responde SOLO JSON: {"jerarquia":N,"cobertura":N,"no_invencion":N,"nota":"máx 15 palabras"}` },
        { role: 'user', content:
`LIBRO: ${b.meta?.fixture}\nOBJETIVO: ${b.battery.goal}\nCONCEPTOS DORADOS:\n${b.battery.goldenConcepts.join(' · ')}\n\nÁRBOL:\n${JSON.stringify(mmArt.result).slice(0, 7000)}` },
      ],
      maxTokens: 8192,
    }));
    if (!mmRes) console.warn('  ⚠ mindmap: respuesta del juez no parseable');
  }

  const cardScores = cardsRes?.cards || [];
  const covered = (coverRes?.conceptos || []).filter(c => c.cubierto).length;
  out.batteries[id] = {
    cards: cardScores,
    cards_avg: {
      fidelidad: avg(cardScores.map(c => c.fidelidad)),
      atomicidad: avg(cardScores.map(c => c.atomicidad)),
      utilidad: avg(cardScores.map(c => c.utilidad)),
    },
    coverage: coverRes?.conceptos || [],
    coverage_ratio: b.battery.goldenConcepts.length ? covered / b.battery.goldenConcepts.length : null,
    summary: sumRes,
    chat: chatRes?.turnos || null,
    chat_avg: chatRes?.turnos ? {
      fundamento: avg(chatRes.turnos.map(t => t.fundamento)),
      claridad: avg(chatRes.turnos.map(t => t.claridad)),
      honestidad: avg(chatRes.turnos.filter(t => Number.isFinite(t.honestidad)).map(t => t.honestidad)),
    } : null,
    mindmap: mmRes,
  };
  const j = out.batteries[id];
  console.log(`  tarjetas (${cardScores.length} juzgadas): fidelidad ${j.cards_avg.fidelidad?.toFixed(1)}, `
    + `atomicidad ${j.cards_avg.atomicidad?.toFixed(1)}, utilidad ${j.cards_avg.utilidad?.toFixed(1)}`
    + ` · cobertura ${covered}/${b.battery.goldenConcepts.length}`
    + (sumRes ? ` · resumen: fidelidad ${sumRes.fidelidad}, citas ${sumRes.pertinencia_citas}, cobertura ${sumRes.cobertura}` : '')
    + (j.chat_avg ? ` · chat: fundamento ${j.chat_avg.fundamento?.toFixed(1)}, honestidad ${Number.isFinite(j.chat_avg.honestidad) ? j.chat_avg.honestidad.toFixed(1) : 'n/a'}` : '')
    + (mmRes ? ` · mindmap: ${mmRes.jerarquia}/${mmRes.cobertura}/${mmRes.no_invencion}` : ''));
}

fs.writeFileSync(path.join(runDir, 'judge.json'), JSON.stringify(out, null, 1));
console.log(`\n→ ${path.relative(process.cwd(), path.join(runDir, 'judge.json'))}`);
