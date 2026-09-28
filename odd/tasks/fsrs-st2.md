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

- Commits: `feat(srs)` P19 · `feat(study)` ST2 · `docs` (ver `git log` del proyecto).
- Verificación: 18/18 tests SRS/estudio OK; suite completa 539 passed / 9 failed
  (6 también fallan en HEAD limpio: `@live`/modelo, `@race`; 3 flaky de carga: `perf`,
  `pdf-touch-select`, `segment-pdf` — pasan aisladas con los cambios); eslint sin errores.
- Deploy: `wrangler pages deploy dist --project-name bookreader --branch main` + `@smoke`.

## Notas

- `.claude/RESUME.md` es de una sesión vieja (2026-08-19), no corresponde a este trabajo.
- Cobertura pendiente (follow-up): tests para `cardFromSelection`, modo de notas simple/full,
  `bookLook`, log/racha/heatmap.
