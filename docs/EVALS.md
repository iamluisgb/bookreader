# EVALS — Batería de calidad por persona (LLM-as-judge)

> **F1 implementada (2026-07-16).** Cómo se usa:
> ```
> npm run eval:fixtures   # descarga los libros (evals/fetch-fixtures.mjs)
> npm run eval            # genera (@eval, Playwright + API real) y puntúa (checks + juez + informe)
> ```
> Piezas: `evals/batteries.mjs` (personas/objetivos/conceptos dorados) ·
> `tests/evals.spec.ts` (generación con la app real) · `evals/check.mjs` (deterministas) ·
> `evals/judge.mjs` (juez, `EVAL_JUDGE`, default mimo-v2.5) · `evals/report.mjs` (REPORT.md) ·
> `evals/compare.mjs` (tabla entre runs, p. ej. comparativo de modelos).
> Variables: `EVAL_MODEL` (modelo a evaluar), `EVAL_PHASE` (1|2), `EVAL_RUN` (nombre del run).
> Salidas en `evals/runs/<run>/` (gitignored).

> Plan (2026-07-16). Objetivo: medir la calidad REAL de los artefactos del agente
> (flashcards, resumen citado, mapa mental, chat) por **caso de uso/cliente ideal**, con
> rúbricas y juez LLM — para decidir mejoras de prompt/modelo con datos y detectar
> regresiones antes de tocar nada. Complementa el golden set determinista de retrieval
> (`tests/retrieval-golden.spec.ts`, ADR-013) — aquello mide *recuperar*, esto mide *generar*.

## Por qué así

- **Por persona, no por feature.** Un mismo artefacto tiene criterios de éxito distintos
  según quién lo usa: las flashcards de un opositor (memorizar literal, cloze, volumen)
  no se evalúan igual que las de un lector técnico (conceptos, trade-offs). Evaluar "las
  flashcards en general" promedia hasta no ver nada.
- **Determinista primero, juez después.** Todo lo que se puede comprobar con código se
  comprueba con código (anclas `[[aN]]` válidas, JSON bien formado, cloze parseable,
  duplicados, idioma). El juez LLM solo puntúa lo que exige criterio (fidelidad,
  cobertura, pertinencia). Es más barato, más estable y el juez no "perdona" errores duros.
- **Juez de otra familia.** Genera `deepseek-v4-flash` (el default) → juzga `mimo-v2.5`
  (y viceversa cuando comparemos modelos): el sesgo de auto-preferencia está documentado
  y en nan tenemos dos familias fuertes gratis-de-infra.

## Las 4 personas (del LAUNCH_PLAN) y sus baterías

Cada batería = 1 libro fixture (con licencia que permita redistribuir) + 1 objetivo
declarado + artefactos generados + rúbrica ponderada para esa persona.

### P1 · Estudiante con Anki
- **Fixture:** capítulo(s) de un textbook CC-BY (OpenStax, p. ej. *Psychology 2e*), EPUB.
- **Objetivo:** "aprobar el parcial del tema X".
- **Artefactos:** flashcards (básicas + cloze) → export Anki, resumen del capítulo, quiz.
- **Qué pesa más:** atomicidad y fidelidad de las tarjetas; cobertura de los conceptos
  evaluables del capítulo; cloze bien formado; cero tarjetas inventadas.

### P2 · Lector técnico (certificación / libro denso)
- **Fixture:** libro técnico con licencia libre (p. ej. *Pro Git*, CC-BY-NC-SA), EPUB.
- **Objetivo:** "prepararme la certificación / entender consenso distribuido".
- **Artefactos:** chat con citas (preguntas conceptuales + de localización), atenuación
  del TOC por objetivo, resumen de libro entero, mindmap.
- **Qué pesa más:** grounding del chat (cita el pasaje correcto, admite "no está en el
  libro" ante la pregunta trampa); atenuación que coincide con el juicio de un experto;
  el resumen no aplana los trade-offs.

### P3 · Opositor / temario en PDF
- **Fixture:** temario público en PDF (BOE / temario libre), con estructura pobre
  (sin TOC real) — es EL caso duro de segmentación.
- **Objetivo:** "memorizar el tema N para el examen".
- **Artefactos:** flashcards en volumen (¿degrada la calidad al pedir muchas?), cloze
  sobre literales (fechas, plazos, artículos), resumen.
- **Qué pesa más:** exactitud LITERAL (una fecha mal = suspenso), anclas que caen en la
  página correcta del PDF, comportamiento con texto mal segmentado.

### P4 · Lector de no-ficción/ensayo (y literatura)
- **Fixture:** `tests/test.epub` (Pedro Páramo) — ya es fixture del repo.
- **Objetivo:** "entender la estructura y los temas de la obra".
- **Artefactos:** chat conceptual (aquí ya hay stub en `query-expand.spec.ts` — esta
  batería lo hace en vivo), mindmap temático, resumen.
- **Qué pesa más:** que el mindmap capture estructura no lineal sin inventar; que el
  resumen no convierta ambigüedad literaria en afirmaciones falsas.

## Rúbricas

Cada criterio se puntúa 1-5 por el juez (con el pasaje fuente delante), salvo los `[det]`,
que son checks de código pass/fail. Nota final = media ponderada; los `[det]` en rojo
**capan** la nota (un artefacto con anclas rotas no puede sacar >2 aunque el texto sea bonito).

**Flashcards** — `[det]` ancla `src` existe en el libro · `[det]` cloze parseable ·
`[det]` sin duplicados (similitud) · `[det]` idioma = idioma del libro · fidelidad (la
respuesta está respaldada por el pasaje anclado) · atomicidad (una idea por tarjeta) ·
cobertura (¿están los N conceptos clave del capítulo? — lista dorada por fixture) ·
utilidad de estudio (¿pregunta algo que un examen preguntaría?).

**Resumen citado (P13)** — `[det]` toda cita `[[aN]]` existe · fidelidad · **pertinencia
de cita** (el pasaje citado respalda ESE punto, no otro — es el foso del producto, se
evalúa aparte) · cobertura · concisión (¿un tercio de la longitud aporta lo mismo?) ·
idioma.

**Mindmap** — `[det]` árbol válido y sin nodos vacíos · jerarquía con sentido (hijos
pertenecen al padre) · cobertura de ramas principales · cero invención.

**Chat/tutor** — grounding (responde desde pasajes recuperados) · cita pertinente ·
**honestidad** (cada batería incluye 1-2 preguntas trampa cuya respuesta NO está en el
libro; responderlas "de memoria" es fallo grave) · claridad pedagógica.

**Atenuación TOC** — correlación (Spearman) contra un ranking dorado de capítulos por
objetivo, anotado a mano una vez por fixture. Determinista tras la anotación.

## Arnés (reutiliza lo que hay)

1. **Generación** — proyecto Playwright con tag `@eval` (patrón `@live` de
   `npm run test:ai`): carga el fixture en la app real, genera los artefactos con los
   módulos reales (mismos prompts, mismo retrieval, mismo parsing que producción — cero
   drift entre eval y realidad) y vuelca cada salida + metadatos (modelo, fecha, git sha,
   latencia, tokens) a `evals/runs/<fecha>-<modelo>/*.json`.
2. **Checks deterministas** — script Node sobre los JSON del run (anclas, cloze, dedupe,
   idioma). Sin API.
3. **Juez** — script Node contra nan: por artefacto, prompt con la rúbrica de su persona
   + el artefacto + los pasajes fuente anclados; salida JSON `{criterio: {score, evidencia}}`,
   temperature 0. Juez ≠ generador. En el primer run, doble juez (mimo + deepseek) sobre
   una muestra para medir acuerdo entre jueces antes de fiarnos de uno.
4. **Informe** — `evals/runs/<run>/REPORT.md`: tabla por persona × artefacto × criterio,
   deltas contra el run anterior, y los 5 peores ejemplos con su evidencia (el material de
   mejora está ahí, no en la media).

Coste estimado por run completo (4 baterías × ~6 artefactos × generación+juicio, modelos
nan): céntimos. Se corre a mano antes de cambiar prompt/modelo y antes de cada release;
no va en CI.

## Primer uso previsto

Validar ADR-022 y la propuesta de modelos: correr la batería completa con
`deepseek-v4-flash` vs `qwen3.6` vs `mimo-v2.5` como modelo principal. Hipótesis a
confirmar: (1) deepseek gana en flashcards/resumen (las tareas de valor), (2) qwen
empata en expansión/atenuación siendo 3-4x más rápido, (3) dónde queda mimo en texto puro.

### Resultado del comparativo (2026-07-16, 1 run/modelo, P1+P4; `node evals/compare.mjs`)

| Modelo principal | Juez | P1 | P4 | Incidencias |
|---|---|---|---|---|
| `deepseek-v4-flash` | mimo | **4.4** | **4.0** | ninguna — el único consistente |
| `qwen3.6` | mimo | 3.5* | 3.4 | ver abajo: el * es un deck inútil con nota inflada |
| `mimo-v2.5` | deepseek | 2.0† | 3.6 | † capada por gate de idioma; sin capar ~4.6 |

- **`deepseek-v4-flash` confirma la hipótesis (1):** decks temáticos repartidos por
  capítulos, resúmenes fiables, cero incidencias en 2 baterías. Sigue de principal.
- **`qwen3.6` queda descartado para artefactos de valor** (confirma la (2) por el lado
  malo): en P1 generó **las 15 tarjetas sobre la licencia de Project Gutenberg**
  (fidelidad 5.0 — ¡bien ancladas a la licencia! — utilidad 1.0, cobertura 0/9: la
  rúbrica cazó exactamente esto, una media simple lo habría tapado); y el resumen de P4
  falló 2 de 3 intentos con "El modelo no devolvió puntos". En su papel ADR-022
  (expansión/atenuación) funcionó sin incidencias en los 3 runs.
- **`mimo-v2.5`, la sorpresa:** tarjetas al nivel de deepseek según el juez cruzado
  (4.8/4.8/4.8) y **el más rápido** (64-121s vs 110-133s), pero indisciplinado: mezcló
  idiomas (4/14 tarjetas en español en un libro EN → gate rojo) y el resumen de P4 salió
  débil (fidelidad 2, citas 2). Candidato a principal SI se le fija el idioma por prompt;
  de momento se queda en visión.
- **Derivados para el producto:** (a) el colapso de qwen sugiere que el reparto de cupo
  por chunks no es robusto cuando un modelo responde mal en bloques intermedios —
  revisar `allocateCounts`/reasignación en flashcards.js; (b) la licencia Gutenberg es
  back matter y el muestreo la trata como capítulo — extender `isFrontMatter` o filtrar
  back matter al trocear.
- **Caveats:** 1 run por modelo (variancia del juez ±0.4), mimo juzgado por otro juez
  (cross-familia obliga), 2 de 4 baterías. Filas de jueces distintos no se comparan
  directamente.

## Fases

- **F1** `S` — Fixtures P1+P4 (OpenStax + Pedro Páramo), runner `@eval` para flashcards
  y resumen, checks deterministas, juez simple, primer REPORT.
- **F2** `M` — P2+P3 (Pro Git + PDF de temario), mindmap/chat/atenuación, preguntas
  trampa, listas doradas de conceptos y ranking dorado de TOC por fixture.
- **F3** `S` — Informe comparativo de modelos (el "primer uso" de arriba), doble juez y
  medición de acuerdo, deltas entre runs.

## Primeros hallazgos (run F1, 2026-07-16, `deepseek-v4-flash` + juez `mimo-v2.5`)

Notas: p1-estudiante **4.4** · p4-noficcion **4.0** (entre pasadas del juez la media por
criterio varía ±0.4 — la medición de acuerdo entre jueces de F3 pondrá barras de error).
Todos los gates deterministas pasan (anclas 100% válidas, 0 duplicados, citas del resumen
100% resolubles). Lo accionable:

1. **Anclaje de tarjetas, el fallo nº1.** Las anclas son *válidas* pero a veces apuntan a
   un pasaje que NO respalda la tarjeta (p. ej. la tarjeta sobre Galileo/el cuñado en
   Pedro Páramo ancla a un pasaje de otra escena). Es el fallback BM25 de
   `attachSources` (P10 F2) eligiendo el mejor *léxico*, no el mejor *semántico*. Las
   fidelidades bajas del juez son en parte esto (ancla equivocada) y en parte
   extrapolación real del modelo — la taxonomía del bucle debe separar ambos.
2. **Cobertura floja (5/9 y 4/8 conceptos dorados).** El muestreo por capítulos trata
   igual el prólogo ("Asombro por Juan Rulfo") que el texto, y nada orienta las tarjetas
   al objetivo declarado. Mejora candidata: pasar el objetivo/conceptos al prompt de
   flashcards y saltar front matter (`isFrontMatter` ya existe en retrieval.js).
3. **Pertinencia de citas del resumen: 3-4/5.** Válidas pero no siempre respaldan *ese*
   punto. Es el foso del producto: subir esto es prioridad de prompt (pedir cita que
   contenga la afirmación, no el tema).
4. **Del arnés:** el idioma esperado difiere por artefacto (resumen = idioma UI por P15;
   tarjetas = idioma del libro) — ya calibrado. El juez recibe una muestra repartida de
   pasajes citados y no penaliza los no incluidos.

## Mejora continua (el bucle)

fallo detectado → clasificar (prompt / retrieval / modelo / parsing) → arreglo → re-run
de SU batería → si mejora sin degradar el resto, entra; el ejemplo que falló se queda en
la batería como caso de regresión. Las listas doradas crecen con los fallos reales de
usuarios (cuando haya feedback), no especulando.

### Primer ciclo completado (2026-07-16): 7 mejoras + 1 regresión cazada

Se implementaron las mejoras de §Primeros hallazgos (validación semántica de anclas,
back matter fuera del muestreo, tope al déficit por chunk, objetivo e idioma en el
prompt de tarjetas, pertinencia de citas en el de puntos, reintento del chunk vacío) y
se re-corrió la batería con deepseek:

- **p1-estudiante: 4.4 → 4.8** — cobertura dorada 5/9 → 7/9, pertinencia de citas 4 → 5,
  anclas 15/15 y ahora validadas semánticamente. Con soporte determinista, no solo juez.
- **p4-noficcion: sin cambio medible** — el MISMO artefacto puntuó 4.2 y 3.7 en dos
  pasadas del juez; su cobertura también subió (4/8 → 5-7/8). Deltas < ±0.5 no son señal
  con un solo juez: refuerza el doble juez de F3.
- **La regresión que el bucle cazó:** el objetivo del lector (en español) prominente en
  el prompt arrastró a deepseek a escribir tarjetas en ESPAÑOL sobre el libro inglés; la
  validación de anclas las vetó (3/15) y saltaron DOS gates. Fix: `detectLang` nombra el
  idioma del material en el prompt (la instrucción relativa "el idioma de los pasajes"
  no bastaba). Sin la batería, esa regresión llegaba a producción invisible.
