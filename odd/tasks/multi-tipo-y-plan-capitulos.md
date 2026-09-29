# Feature: Multi-tipo de tarjetas + plan de tarjetas por capítulo

Estado: **diseño cerrado, implementación pendiente**. Alcance acordado por el usuario:
- Tipos de texto multi-selección (P→R **y** Cloze a la vez) con **dos pasadas** (una por tipo) y
  además **arbitraje del agente** sobre qué formato encaja mejor con cada concepto.
- **Plan de tarjetas por capítulo sugerido por el agente**, **editable**, con **generación por
  capítulo** (un trabajo por capítulo con su cupo).

## A. Multi-tipo de texto

### Por qué hoy es un radio
El pipeline de texto genera **un tipo por pasada**: `cardsPrompt(count, type, …)` lleva el tipo
fijo (`flashcards.js:403`) y el mazo se crea con ese `cardType`. Las familias visuales sí son
multi-selección porque cada una es una llamada aparte (`buildVisualCards`).

### Diseño
1. **Dos pasadas**: por cada tipo de texto elegido (orden estable: basic, cloze) se corre el
   map-reduce completo con su propio cupo (`allocateCounts` por trozo, con el déficit arrastrado
   que ya existe). Cupos predecibles por tipo; el mazo pasa a `cardType: 'mixed'` cuando hay más
   de un tipo (ya soportado desde WU5e).
2. **Arbitraje del agente por concepto**: cada pasada recibe la instrucción de generar **solo**
   conceptos cuyo formato natural sea el de esa pasada («si el concepto funciona mejor como
   hueco, omitilo en esta pasada y dejaselo a la otra»). Es decir: el modelo no fuerza un formato
   sobre un concepto que no le sienta.
3. **Sin repetir conceptos entre pasadas**: la segunda pasada recibe los frentes ya generados como
   `prevFronts` (mecanismo que ya existe para no duplicar contra el mazo existente). Así el
   arbitraje no produce el mismo concepto en los dos formatos.

### Coste y límites
- Tiempo y coste de la fase de texto ≈ ×(tipos elegidos). La UI debe decirlo.
- Si las pasadas "omiten" mucho, el mazo sale corto: el trabajo ya reporta `generated` vs
  `requested` y el déficit se arrastra **dentro** de cada pasada, no entre pasadas (se acepta y se
  avisa; forzar cupos cruzados reintroduce el problema de monotema que cazó EV1).

### ⚠️ Contrato de eval obligatorio (EV5)
La instrucción de arbitraje **modifica un prompt existente** (`cardsPrompt`), y la regla del repo
([`docs/EVALS.md` § EV5](docs/EVALS.md)) es que todo ítem que toque la calidad del agente abre con
el contrato **antes** de la primera línea de código:

**Contrato (antes de implementar) — MEDIDO el 2026-09-29.**

- **Batería**: `p1-estudiante` (física/relatividad, `p1-relativity.epub`) y `p4-noficcion`
  (Pedro Páramo). Son las dos que corren en este entorno; el golden IA7 se salta por falta de
  `evals/fixtures/ddia.pdf`.
- **Métrica primaria**: tarjetas — `fidelidad` · `atomicidad` · `utilidad` (juez, escala 5) y
  `cobertura` de conceptos oro. **Determinista además de juez**: número de tarjetas generadas,
  anclas válidas y duplicados.
- **Baseline** (run `2026-09-29-12-18-deepseek-v4-flash`, generador `deepseek-v4-flash`):

  | Batería | fidelidad | atomicidad | utilidad | cobertura | determinista |
  |---|---|---|---|---|---|
  | p1-estudiante | 4,8 | 4,8 | 4,6 | 6/9 | 15 tarjetas, 15 anclas válidas, 0 dupes |
  | p4-noficcion | 4,3 | 4,7 | 4,3 | 7/8 | 15 tarjetas, 15 anclas válidas, 0 dupes |

  **Caveat honesto — juez sustituido**: el juez por defecto (`mimo-v2.5`) devuelve 401 con la key
  disponible («does not have access to the requested model»), así que el baseline se midió con
  `EVAL_JUDGE=glm5.3-flash`. Los números son **comparables entre corridas con ese mismo juez**, no
  con los runs históricos (que usaron otro). Toda comparación de esta feature se hace dentro de
  este régimen.
- **Estado del árbol de calidad en el baseline**: **2/17 presupuestos ya rotos** antes de tocar
  nada — `p1 · cards.utilidad = 4,58` (mín 4,6) y `p4 · chat.honestidad = 4` (mín 4,5) — y el gate
  de densidad de infografía falla en las dos baterías. Son preexistentes y **fuera del alcance de
  este ítem**: la vara es **no empeorarlos**.
- **Secundaria (tendencia, no gate)**: proporción real de cloze vs básicas generadas por pasada
  (hoy el eval no la mide; se agrega como dato del run).
- **Time-box**: 2 ciclos. Si la cláusula de arbitraje no mueve nada, se clasifica el fallo y se
  cierra con el hallazgo (regla de EV5).

**Consecuencia de secuencia**: el arbitraje de formato se implementa **después** del baseline. Si
el baseline no se puede correr (falta de key/fixtures), la entrega se hace sin la cláusula de
arbitraje (dos pasadas puras) y el arbitraje queda como ítem aparte con su contrato.

## B. Plan de tarjetas por capítulo (agente + editable + generación por capítulo)

### Lo que ya existe (invisible)
`allocateCounts(chunks, total)` reparte el total **proporcional a los tokens** de cada trozo
(`flashcards.js:378`). Es gratis y ya funciona, pero el usuario no lo ve ni puede ajustarlo.

### Diseño
1. **Planificador (prompt nuevo, no modifica prompts existentes)**: entrada = libro + objetivo +
   lista de capítulos **con contenido** (título, tokens estimados, y una muestra corta de cada
   uno), más el total deseado. Salida SOLO JSON:
   `{"chapters":[{"name":"<título exacto>","cards":N,"reason":"<una frase>"}],"total":M}`.
2. **Validación determinista** (código, no prompt): los nombres deben existir en la lista del
   libro; cada capítulo con contenido ≥ 1; `cards` entero y con tope (≤ 3× su reparto
   proporcional, para que el agente no concentre todo en un capítulo); la suma se ajusta al total
   pedido (si no cuadra, se normaliza proporcionalmente y se avisa). Si la respuesta no valida →
   1 reintento → **fallback al reparto proporcional actual** (nunca bloquea la generación).
3. **UI editable**: en el setup de flashcards, botón «Sugerir cantidades» → tabla capítulo → N
   (input numérico) + motivo del agente como texto secundario, total vivo, y un aviso del coste
   (`capítulos × tipos` llamadas estimadas). Se puede editar cada número; «Generar» usa el plan.
4. **Generación por capítulo**: un `Jobs.run` que itera el plan; por cada capítulo con N > 0 corre
   las pasadas de tipo elegidas sobre los trozos de ESE capítulo con su cupo, y **fusiona** en el
   mazo de ese capítulo (mismo criterio de `mergeInto` por scope+tipo que ya existe; si no hay
   mazo, lo crea con `scope` = etiqueta del capítulo y `name` = título del capítulo).
5. **Progreso y parcial**: progreso por capítulo (`i/n`) y por fase; un capítulo fallido no tira el
   resto; al final, resumen (`generated`/`requested` por capítulo) — reusa el patrón actual.

### Límites
- El planificador **no lee el libro entero** (solo capítulos + tamaños + muestras): su juicio es
  sobre estructura, no sobre contenido profundo. Es una sugerencia, no una medida.
- Máximo de capítulos con generación en una corrida: **12** (libro grande = demasiadas llamadas
  pagas); el resto queda para una segunda pasada.

## Work units

- [ ] **WU1** Multi-selección de tipos de texto (radio → checkboxes) + dos pasadas por tipo +
  `cardType: 'mixed'` + tests (sin cláusula de arbitraje: no toca prompts).
- [x] **WU2** Contrato EV5 + baseline medido (`npm run eval:gen` + `eval:score` con `EVAL_JUDGE=glm5.3-flash`).
  Run `2026-09-29-12-18-deepseek-v4-flash`. 2/17 presupuestos ya rotos antes de tocar nada.
- [ ] **WU3** Cláusula de arbitraje de formato en la pasada + dedupe cruzado por `prevFronts` +
  tests.
- [ ] **WU4** Planificador por capítulo: prompt + validador determinista + fallback proporcional +
  tests con `fetch` stubbeado.
- [ ] **WU5** UI del plan editable + generación por capítulo bajo `Jobs` + tests de pantalla.
- [ ] **WU6** Docs (CHANGELOG/BACKLOG/DECISIONS) + precache + bump de caché.

## Fuera de alcance
- Crear tarjetas visuales a mano (BACKLOG P36).
- Presupuesto de coste en dinero (solo se avisa el número de llamadas estimadas).
