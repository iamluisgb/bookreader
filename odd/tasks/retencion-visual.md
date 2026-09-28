# Feature: retencion-visual (visualización de retención — racha, dominio, meta, hitos, true retention)

Origen: investigación de industria (memoria Engram id 96, topic_key `bookreader/retention-research`).
Autorizada por el usuario: «Adelante, implementa todo el plan».

## Objetivo

Hacer visible lo que hoy es invisible: la racha (fuera de la pantalla final), el conocimiento
dominado por libro (no solo actividad), la meta diaria elegida por el usuario y la calidad
real del repaso (retención verdadera). Sin cambiar el scheduler (FSRS-5 ya es vanguardia).

## Tareas

### T1 · Chip de racha persistente + estado en riesgo
- `study.js`: chip `.study-streakchip` en `.study-head` (línea ~249), actualizado por
  `refreshHead()` llamado desde `renderCard()`; clase `is-risky` mientras `reviewsToday()==0`.
- `library/view.js`: slot `.lib-streak-slot` en `.lib-top` (línea 239), pintado por
  `paintStreakChip()` desde `paintStudyChip()` (que ya computa la racha, línea 411).
- Regla Duolingo: la racha se ve en los primeros 3 segundos de sesión.
- Commit: `feat(study): persistent streak chip with at-risk state`

### T2 · Barra de dominio por libro
- `srs.js`: helper puro `deckMastery(cards)` → `{total, mastery, maduras, aprendiendo, nuevas}`;
  peso = `min(1, interval/21)` (madura ≥ 21d, criterio Anki ya usado en `deckStats`);
  suspendidas cuentan con su peso (material aprendido, solo aparcado).
- `view.js`: `.lib-mastery` bajo `.lib-progressbar` en `cardHtml()` (línea 538); pintado async
  por `paintMastery()` tras el render de la grilla (decks agrupados por `bookId` vía
  `DB.getAll('decks')`). Oculta cuando el libro no tiene mazo.
- Commit: `feat(library): per-book mastery bar weighted by FSRS stability`

### T3 · Meta diaria elegible + anillo de progreso
- `study.js`: `GOAL_KEY='study_goal'`, default 20, `dailyGoal()/setDailyGoal(n)` (5–200, paso 5);
  anillo `.study-goal` (SVG dasharray) en el header, cuenta `reviewsToday()` del día completo
  (sobrevive a cerrar la sesión); popover −/+ al click. Decisión de producto (resuelta): meta
  ELEGIDA con default 20, no fija — ownership de Duolingo.
- Commit: `feat(study): user-chosen daily goal with progress ring`

### T4 · Celebración de hitos + tarjeta compartible
- `study.js`: `MILESTONES=[7,30,100,365]`; `streakAtStart` capturado en `open()`; en
  `renderDone()` (línea 860), si `streak >= m && streakAtStart < m` → bloque
  `.study-milestone` animado + botón compartir.
- `share-card.js`: `buildStreakCard({streak, bookTitle, cover})` + `shareStreak()` reutilizando
  roundRect/wrapLines/Web Share con fallback a descarga (mismo patrón que `shareQuote`).
- Commit: `feat(study): streak milestone celebration with shareable card`

### T5 · Heatmap coloreado por acierto (true retention)
- `study.js`: `readLog()` migra on-read el log legacy (número plano → `{n, ok: null}`);
  `bumpLog(delta, okDelta)` escribe `{n, ok}`; `gradeCurrent` pasa `okDelta = rating==='again' ? 0 : 1`
  (aproximación: cada evento de repaso cuenta, «otra vez» no es acierto); `undo` calcula
  `okDelta = firstTry > u.firstTry ? -1 : 0` antes de restaurar. `heatmapHtml`: subrayado por
  retención (≥85% verde / 70–85 ámbar / <70 rojo), sin subrayado en días legacy; tooltip «n · pct%».
- Commit: `feat(study): heatmap underlined by true retention`

### T6 · Docs + deploy
- CHANGELOG (entrada «Retención visible»), odd/tasks, `npm run deploy:pages` + smoke + verificación.

## Convenciones
- i18n: strings ES fuente + mapa EN en `app/js/i18n.js` (zona `// study.js`).
- Tests: `tests/study-retention.spec.ts` (Playwright, Chromium); patrón de seeding de
  `tests/study-source.spec.ts` (IndexedDB con `/js/ai/db.js`) + `seedProLicense`.
- Los commits de work-unit llevan tests y CSS/i18n en el mismo commit que el comportamiento.

## Evidencia
| Tarea | Commit | Tests |
|---|---|---|
| T1 | `935a68a` feat(study): persistent streak chip with at-risk state | tests/study-retention.spec.ts · 1 test (chip biblioteca → sesión, riesgo → encendida) + 14 vecinos |
| T2 | `a276a09` feat(library): per-book mastery bar weighted by FSRS stability | · mastery 58% con 2 maduras / 1 aprendiendo / 1 nueva; tooltip · nota: primer intento falló por ediciones de un lote que no entraron (import de Srs + paintResults) — corregido y verificado en navegador |
| T3 | `25ef968` feat(study): user-chosen daily goal with progress ring | · default 0/20, popover ±5, persistencia, anillo llena tras repasar |
| T4 | `926cb01` feat(study): streak milestone celebration with shareable card | · hito exacto a 7 (racha cruda 6), PNG 1080×1080 real · 7 tests pasando (incl. share-card P11) |
| T5 | `75c3a15` feat(study): heatmap underlined by true retention | · verde 90% / rojo 50% / hoy muta a 9·56% / legacy sin subrayado; log migrado · nota: día sembrado con clave UTC no matcheaba dayOf (local) — corregido; el segundo .study-flip era «Cerrar» |
| T6 | (este commit de docs) | suites vecinas: 22 passed |
