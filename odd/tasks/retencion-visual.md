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
- `study.js`: `bumpLog(delta, okDelta)` — entradas nuevas `{n, ok}` (migración on-write desde
  número); `gradeCurrent` pasa `ok = (rating!=='again' && !failedOnce.has(key))`; `undo`
  calcula `okDelta = firstTry - u.firstTry` antes de restaurar. `heatmapHtml`: días con datos
  de acierto llevan subrayado por retención (≥85% verde / 70–85 ámbar / <70 rojo) y tooltip
  «N repasos · X% a la primera».
- Commit: `feat(study): heatmap shows true retention per day`

### T6 · Docs + deploy
- CHANGELOG (entrada bajo las de hoy), odd/tasks, `npm run deploy:pages` + smoke + verificación.

## Convenciones
- i18n: strings ES fuente + mapa EN en `app/js/i18n.js` (zona `// study.js`).
- Tests: `tests/study-retention.spec.ts` (Playwright, Chromium); patrón de seeding de
  `tests/study-source.spec.ts` (IndexedDB con `/js/ai/db.js`) + `seedProLicense`.
- Los commits de work-unit llevan tests y CSS/i18n en el mismo commit que el comportamiento.

## Evidencia
| Tarea | Commit | Tests |
|---|---|---|
| T1 | (pendiente) | (pendiente) |
