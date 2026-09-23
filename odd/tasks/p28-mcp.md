# P28 — MCP: que un agente externo lea tu biblioteca

Unidad de trabajo (ODD) de la misión del 2026-09-23 sobre la rama `feat/p28-mcp`.
Alcance: **F1** (backup) + **F2** (Drive, fuente viva). **F3 (escritura) queda fuera.**

Documento de referencia: [`BACKLOG.md` · P28](../../BACKLOG.md). Decisiones: `ADR-036`/`ADR-037`
en [`DECISIONS.md`](../../DECISIONS.md).

## Restricciones de la unidad

- No se toca una línea de la app (`app/`, `index.html`, `sw.js`, `css/`). El MCP vive en `mcp/`.
- Sin escritura: el MCP solo lee, y F3 no se implementa.
- Lista explícita en código de lo que el MCP nunca lee ni devuelve (`ai_key`,
  `drive_refresh_token`, `device_id`) con test que lo demuestre.
- Tests con `node --test`; `npm run lint` y `npm test` siguen verdes.
- Un commit por unidad, y push después de cada commit.

## Tareas

- [x] T1 — Paquete `mcp/` y arranque por argumentos (`src/config.mjs`).
- [x] T2 — Lista en código de lo vetado y su saneado (`src/redact.mjs`).
- [x] T3 — Servidor MCP por stdio y las cuatro tools de F1 (`server.mjs`, `cli.mjs`, `src/tools.mjs`,
  `src/model.mjs`, `src/sources/backup-file.mjs`).
- [x] T4 — Fixtures realistas y tools probadas de punta a punta por stdio (F1).
- [x] T5 — README del MCP: limitación del backup y registro en Claude Desktop / Claude Code / pi.
- [x] T6 — Fuente viva sobre el layout de sync y proveedores (memoria, disco, Google) + auth.
- [x] T7 — `reading_stats(range)` sobre `settings.reading_days`.
- [x] T8 — Paridad de las dos fuentes, redacción y Drive simulado (tests).
- [x] T9 — README de F2: OAuth y qué falta para probar contra Drive real.
- [x] T10 — `lint` + `test:mcp` en el paquete raíz; `npm run lint` verde.
- [x] T11 — ADRs en `DECISIONS.md`, estado en `BACKLOG.md` y `CHANGELOG.md`.

## Evidencia

Los commits de la rama son la evidencia, con el mensaje convencional de cada unidad. Los tests
viven en `mcp/test/` y se ejecutan con `npm run test:mcp` desde la raíz (o `npm test` dentro de
`mcp/`). El informe de la misión queda fuera del repo, en `~/work/P28-STATUS.md`.
