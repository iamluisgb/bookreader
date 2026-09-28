# Feature: P19+ST2 — «Estudiar»: FSRS-5 y sesión de repaso rediseñada

Trabajo heredado de una sesión externa (Claude Code, sin créditos), auditado, documentado,
commiteado y desplegado por el orchestrator el 2026-09-28.

## Contexto

- **P19** — migrar el scheduler de SM-2 a FSRS-5 (`app/js/ai/srs.js`), con conversión en vivo
  de las tarjetas ya programadas.
- **ST2** — rediseño de la sesión de repaso (`app/js/ai/study.js` + soporte en biblioteca,
  panel de selección, ajustes, i18n, CSS) y color de acento por libro (`app/js/ui/book-accent.js`).

## Tareas

- [x] Auditoría del trabajo heredado (tests, lint, suite completa; 9 fallos analizados: 6 preexistentes en HEAD, 3 flaky aislados)
- [x] CHANGELOG: entrada P19+ST2 (2026-09-28)
- [x] BACKLOG: P19 marcada ✓ con nota de entrega; ficha ST2 entregada
- [x] Commit P19 — scheduler FSRS-5 + `tests/srs.spec.ts` (commit: ver abajo)
- [x] Commit ST2 — sesión rediseñada + tests (commit: ver abajo)
- [x] Commit docs — CHANGELOG + BACKLOG
- [x] Push a origin/main
- [x] Deploy a Cloudflare Pages (`npm run deploy:pages`) + smoke contra lo desplegado

## Evidencia

- Commits: `f1ebbaf` feat(srs) P19 · `17f0652` feat(study) ST2 · `956b829` docs.
- Verificación: 18/18 tests SRS/estudio OK; suite completa 539 passed / 9 failed
  (6 también fallan en HEAD limpio: `@live`/modelo, `@race`; 3 flaky de carga: `perf`,
  `pdf-touch-select`, `segment-pdf` — pasan aisladas con los cambios); eslint sin errores.
- Deploy: `https://5c91d394.bookreader-2h5.pages.dev` (prod por rama main); @smoke 3/3 OK
  contra `956b829` (commit servido, arranque de app, estanterías).

## Notas

- `.claude/RESUME.md` es de una sesión vieja (2026-08-19), no corresponde a este trabajo.
- Cobertura pendiente (follow-up): tests para `cardFromSelection`, modo de notas simple/full,
  `bookLook`, log/racha/heatmap.

## Hotfix post-entrega (2026-09-28)
Reporte del usuario en producción (mazos reales): (1) la tarjeta 3D no giraba —`rotate(calc(px/30))` es inválido, transform computado `none`; fix: `--drag` unitless + `calc(x * 1px / x * 1deg)`— y (2) el deckname nowrap se derramaba fuera de la tarjeta —fix: track `minmax(0,1fr)` + `.study-face { min-width:0; overflow:hidden }`. Regresión: `tests/study-overflow.spec.ts` (Chromium y WebKit con `playwright.webkit.config.ts`). Commit `b36840d`.

## Hotfix #2 (2026-09-28): «Ver en el libro» en silencio con mazos sincronizados
El sync mueve mazos pero no `bookText`/`anchors`: sin segmentación local el botón no hacía nada y no había pasaje. Fix: `ensureSegmented` genera la segmentación a demanda (local, sin IA, persistente), `showPassage` reintenta, y `goToSource` nunca falla en silencio (fallback a abrir el libro + toast; fantasma → toast y seguir). Regresión: `tests/study-source.spec.ts`. Commit `1b76934`.
