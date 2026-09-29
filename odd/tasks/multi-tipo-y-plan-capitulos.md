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

```markdown
**Contrato (antes de implementar).**
- Batería: `p1` (flashcards) + gate determinista de anclas/cloze — es la batería que ya cubre esta ruta.
- Métrica primaria: `cobertura`/`fidelidad` de la batería EV1 (la que gatea hoy). Determinista + juez.
- Baseline: PENDIENTE DE MEDIR (`npm run eval`, requiere key real y fixtures; el golden IA7 necesita `evals/fixtures/ddia.pdf`).
- Secundaria (tendencia, no gate): proporción de tarjetas cloze vs básicas realmente generadas.
- Time-box: 2 ciclos. Si no se mueve, se clasifica el fallo y se cierra con el hallazgo.
```

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
- [ ] **WU2** Contrato EV5 + baseline medido del prompt de flashcards (`npm run eval` con key real
  y fixtures) antes de tocar `cardsPrompt`.
- [ ] **WU3** Cláusula de arbitraje de formato en la pasada + dedupe cruzado por `prevFronts` +
  tests.
- [ ] **WU4** Planificador por capítulo: prompt + validador determinista + fallback proporcional +
  tests con `fetch` stubbeado.
- [ ] **WU5** UI del plan editable + generación por capítulo bajo `Jobs` + tests de pantalla.
- [ ] **WU6** Docs (CHANGELOG/BACKLOG/DECISIONS) + precache + bump de caché.

## Fuera de alcance
- Crear tarjetas visuales a mano (BACKLOG P36).
- Presupuesto de coste en dinero (solo se avisa el número de llamadas estimadas).
