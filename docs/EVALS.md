# EVALS — Batería de calidad por persona (LLM-as-judge)

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

## Fases

- **F1** `S` — Fixtures P1+P4 (OpenStax + Pedro Páramo), runner `@eval` para flashcards
  y resumen, checks deterministas, juez simple, primer REPORT.
- **F2** `M` — P2+P3 (Pro Git + PDF de temario), mindmap/chat/atenuación, preguntas
  trampa, listas doradas de conceptos y ranking dorado de TOC por fixture.
- **F3** `S` — Informe comparativo de modelos (el "primer uso" de arriba), doble juez y
  medición de acuerdo, deltas entre runs.

## Mejora continua (el bucle)

fallo detectado → clasificar (prompt / retrieval / modelo / parsing) → arreglo → re-run
de SU batería → si mejora sin degradar el resto, entra; el ejemplo que falló se queda en
la batería como caso de regresión. Las listas doradas crecen con los fallos reales de
usuarios (cuando haya feedback), no especulando.
