# Feature: Dominio del concepto vs dominio del ejemplo (flashcards)

Estado: **implementación en curso**. Rama `feat/flashcards-dominio`.

## Problema

Libros con case studies de un dominio ajeno al tema del libro (p. ej.
*Knowledge Graphs and LLMs in Action*, de Alessandro Negro, usa ejemplos
biomédicos: genómica, transcriptoma) generan tarjetas **fieles pero fuera de
objetivo**: preguntan el dominio del ejemplo (biología) en vez del dominio del
concepto (grafos, LLMs). No es un fallo de fuentes: el prompt de
`flashcards.js` tiene FIDELIDAD ESTRICTA al pasaje y los pasajes SON biológicos.
El problema es de relevancia para el lector.

## Decisión de alcance (usuario: «1 + 3 juntas»)

1. **Enseñar el objetivo en el onboarding** (remedio inmediato, sin tocar el
   prompt): el prompt ya inyecta «OBJETIVO DEL LECTOR … descarta lo que no
   ayude». Falta enseñarlo: hint con ejemplo de exclusión de dominio bajo el
   textarea del goal.
2. **Post-filtro de dominio en la revisión** (no toca el prompt ni el baseline
   EV5): etiquetado de dominio por tarjeta (pasada LLM **iniciada por el
   usuario**, barata, sobre frentes+capítulos) + chips de dominio con descarte
   por lote en `renderReview`.

**NO se toca** `cardsPrompt` ni retrieval ni modelo: contrato EV5 intacto. La
pasada de etiquetado es nueva, opt-in y fuera del camino del eval; se documenta
en el código como tal.

## Tareas

- [x] **WU1 · Hint de objetivo** — `panel.js` `renderGoal()`: `<p class="ai-ob-sub">` (clase existente, sin CSS nuevo) bajo el textarea con ejemplo de exclusión de dominio. Strings por `t()` con par ES→EN en `i18n.js`.
- [x] **WU2a · Módulo puro de dominios** — nuevo `app/js/ai/domain-tags.js`: `normalizeDomain`, `parseDomainSuggestions(raw, n)` (tolerante como `balancedObjects`: nunca lanza, `[]` en fallo), `groupCardsByDomain(cards)`, `domainTagMessages(fronts, chapters, lang)` (datos del prompt, sin importar llm.js). Spec puro `tests/domain-tags.spec.ts`.
- [x] **WU2b · UI de dominios en revisión** — `flashcards.js` `renderReview`: botón «Agrupar por dominio» → 1 llamada LLM (patrón existente, tool no necesario, JSON en texto) → `card.domain` persistido con `DB.updateDeck` → fila de chips `Dominio (n)` con «×» que descarta todas las tarjetas de ese dominio (persistiendo tombstones vía `syncFromDom`/`updateDeck`). Errores → `toast`, sin cambio de estado. Todo escapado con `escapeHtml`.
- [x] **WU2c · i18n + CHANGELOG** — strings es→en; entrada en `CHANGELOG.md`.

## Verificación

- `npx playwright test tests/domain-tags.spec.ts` verde (funciones puras).
- `npm test` completo verde (19 E2E deterministas) y `npm run lint` limpio.
- Evidencia de commits por work unit en esta tabla:

| WU | Commit | Nota |
|---|---|---|
| WU1 | `943aae7` | hint de objetivo en onboarding (panel.js + i18n) |
| WU2a | `eebd264` | módulo puro domain-tags.js + spec (RED→GREEN) |
| WU2b/c | `bc7d6cf` | UI de revisión (chips + descarte), whitelist `domain` en `sameCard`, i18n, CHANGELOG |

Verificación: spec de dominios 5/5 y suites de mazos 18/18 · `npm run lint` 0 errores
(6 warnings pre-existentes) · `npm test` completo: 685/691; los 6 fallos se auditados
contra `main`: los 2 de preset de modelo (`llm.spec`, `model-probe`) son pre-existentes
en main; los otros 4 pasan al repetirse con este árbol (flaky por carga paralela).
**Regresión neta del cambio: 0.**

## Pendientes / no-goals

- No se modifica el prompt de generación (EV5).
- No se etiqueta automáticamente tras generar (coste sorpresa): es acción
  explícita del usuario en la revisión.
- No agrupa dominios en `decks.js` (vista estantería): alcance revisión.
