# Oclusiones: validador determinista + filtro de figuras

Estado: **implementación en curso**. Rama: `fix/oclusiones-calidad` (a crear).

## Qué se vio en los datos reales (backup del 2026-09-30)

De las 144 tarjetas del usuario, las 6 de oclusión tienen dos defectos distintos:

1. **El dorso no responde**: 0 de 6 mencionan el contenido de la etiqueta tapada. Ejemplos:
   - «¿Qué capacidad máxima tiene la barca?» → dorso: «El granjero no puede dejar a la oveja sola…»
     (lo tapado era *«The boat can hold one person and one animal»*).
   - «¿Qué relación indica subclase?» → dorso: «El capítulo explica que el grafo de conocimiento
     *contains entities and relationships*…» (lo tapado era `SUBCLASSOF`).
   - Dos tarjetas distintas comparten **exactamente el mismo dorso genérico**.
2. **La selección de figuras no distingue qué tipo de figura es.** Se extraen TODAS las imágenes
   del PDF: la de la página 59 es una captura del experimento con el acertijo del granjero y la
   barca (sección *2.4 Reasoning*), que existe en el libro pero **no es contenido para estudiar**.
   En cambio la de la página 84 (esquema de ontologías) sí lo es. La app las trató igual.

## Diseño

### A. Validador determinista de oclusiones (no toca prompts)
En `app/js/ai/visual-deck.js`, al construir cada tarjeta de oclusión, antes de aceptarla:

- **La respuesta tiene que estar en el dorso**: normalizar el dorso y la etiqueta tapada y exigir
  que (a) el dorso contenga la etiqueta normalizada, o (b) al menos la mitad de las palabras clave
  de la etiqueta (tokens ≥ 3 caracteres, sin palabras vacías) aparezcan en el dorso. Si no → la
  tarjeta se descarta y suma a `stats.rejectedFacts`.
- **Dorsos repetidos**: dos tarjetas con el mismo dorso normalizado no aportan dos veces; se queda
  la primera y la otra se descarta (mismo contador).
- El conteo queda en `stats` para que la UI pueda decir por qué salió menos de lo pedido.

**Consecuencia esperada y honesta**: con el prompt actual, la mayoría de las oclusiones se van a
descartar. Es preferible cero tarjetas a tarjetas que no se pueden contestar; el arreglo de fondo
del prompt va en el punto B.

### B. Filtro por tipo de figura (prompt de visión + persistencia + filtro)
- El prompt de grounding (`visual-cards.js`) devuelve además del listado de etiquetas un veredicto
  `kind` ∈ `diagram | illustration | screenshot | code | other`, con la instrucción explícita de
  que **solo un diagrama** (esquema, flujo, jerarquía, grafo, tabla con estructura) sirve para
  ocluir; una captura, una foto, un fragmento de código o una anécdota ilustrada no.
- `groundFigure` devuelve `{ labels, kind, attempts, truncated }` (nuevo `parseGroundingResponse`;
  `parseLabelsResponse` queda como está para no romper a sus consumidores).
- El `kind` y las etiquetas se **persisten en el artefacto de la figura** (`DB.updateArtifact`), así
  una figura ya clasificada no paga otra llamada de visión y el filtro es gratis en la próxima
  generación.
- `buildVisualCards` usa **solo** figuras `kind === 'diagram'`. Las demás se cuentan en
  `stats.skipped` con un motivo, sin gastar cuota.

### C. Cláusula en el prompt de oclusión
El `contextFact` pasa a exigirse explícitamente: **tiene que responder la pregunta y nombrar el
contenido de la etiqueta tapada, sin frases genéricas ni repetidas**. Esto toca un prompt, pero
**del camino visual, que la batería de eval NO mide** (mide flashcards de texto): el gate real acá
es el validador determinista del punto A, y el camino de texto queda intacto (el baseline medido
sigue válido).

## Work units

- [x] **WU1** `app/js/ai/visual-deck.js`: validador (respuesta en el dorso + dorsos repetidos) y
  contadores en `stats`; tests con los 6 casos reales del backup (5 rechazados, 1 aceptado).
- [x] **WU2** `visual-cards.js` (prompt `kind` + `parseGroundingResponse` + `groundFigure`) y
  `visual-deck.js` (filtro por `kind` + persistencia con `DB.updateArtifact`); tests: ilustración
  descartada sin pagar cuota extra, diagrama aceptado, `kind` persistido.
- [x] **WU3** Cláusula del `contextFact` en el prompt de oclusión + tests del texto del prompt.
- [ ] **WU4** Docs (CHANGELOG/BACKLOG/DECISIONS) y precache si hace falta.

## Fuera de alcance
- Regenerar las 6 tarjetas ya creadas (requiere autorización explícita: gasta cuota y toca datos).
- Anti-enumeración y estilo de cloze del camino de texto (van en otro ítem, con su contrato EV5).
