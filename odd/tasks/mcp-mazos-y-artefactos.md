# Extensión del MCP: mazos de flashcards y artefactos del Studio

Estado: **implementación en curso**. Paquete: `mcp/` (servidor MCP local stdio, solo lectura).

## Contexto

El MCP expone hoy 4 tools (`list_books`, `get_highlights`, `get_notes`, `search_highlights`) y
`reading_stats` cuando la fuente lleva el registro de lectura. Pero el layout de sync que ya sabe
leer **contiene más**: `books/<id>.json` lleva `decks` (mazos con su estado de repaso),
`artifacts` (resúmenes, mapas mentales, infografías), `convos`, `messages` y `ratings`
(ver `app/js/sync/layout.js`). El MCP simplemente no los expone.

**El backup NO sirve para esto**: `app/js/backup.js` exporta `convos, messages, notes, ratings,
books` — sin `decks` ni `artifacts`. Por eso las tools nuevas se anuncian **solo con la fuente
viva** (mismo criterio que `reading_stats`: una tool que siempre contesta «no hay datos» es peor
que una tool que no existe).

## Diseño

### Capacidad en la fuente (patrón existente)
1. `app/js/../mcp/src/sources/drive.mjs`: nueva capacidad `hasAgentData: true` (cubre `--dir` con el
   proveedor de disco Y Drive real, porque el proveedor es el IO, no la fuente) y métodos
   `decks(bookId)` / `artifacts(bookId)` que leen `entry.decks` / `entry.artifacts` filtrando
   tombstones con el helper `liveItems` que ya existe.
2. `mcp/src/sources/backup-file.mjs`: `hasAgentData: false`.

### Tools nuevas (mcp/src/tools.mjs), anunciadas solo si `source.hasAgentData`
1. **`list_decks`** — `{ bookId? }`. Sin `bookId`, resume todos los libros (nombre del mazo,
   `scope`, `cardType`, nº de tarjetas, vencidas hoy, suspendidas, nuevas, `createdAt`). Con
   `bookId`, solo ese libro. **No devuelve el texto de las tarjetas**: es el resumen para saber
   cómo va el repaso.
2. **`get_deck`** — `{ bookId, deckId? , scope? }` (identifica por `deckId` o por `scope`). Devuelve
   las tarjetas con `uid`, `type`, `front`, `back`, `chapter`, `src`, `suspended` y el `srs`
   relevante (`due`, `reps`, `stability`, `difficulty`), con `limit` (def. 100, máx 500) y
   `truncated: true/false`. `due` se calcula comparando `srs.due` con `now` (no hace falta FSRS).
3. **`list_artifacts`** — `{ bookId?, kind? }` con `kind` ∈ `summary|mindmap|infographic|figures|*`.
   Devuelve metadatos: `key`, `bookId`, `kind`, `createdAt`, `updatedAt`, y un `preview` corto
   (≤ 200 caracteres) del contenido, **nunca** el contenido entero.
4. **`get_artifact`** — `{ bookId, key }`. Devuelve el `result` del artefacto con un tope de
   tamaño (si excede, se trunca con `truncated: true` y se dice cuánto se recortó).

Reglas de la casa que se mantienen: nada de escritura; un error previsto (libro o mazo
desconocido, límite inválido) se devuelve como resultado con `isError`, no revienta la sesión;
el payload va como JSON en un bloque de texto.

### Seguridad (no negociable)
5. Los payloads nuevos pasan por el `scrub()` que ya existe (veta `ai_key`,
   `drive_refresh_token`, `device_id`, `license`, `sync_*`) y el test de redacción debe cubrirlos:
   plantar un secreto dentro de un `deck` y de un `artifact` y verificar que ninguna tool nueva lo
   devuelve.

### Documentación
6. `mcp/README.md`: tabla de tools actualizada, la columna de «de qué fuente viene cada una» y una
   línea explicando que los mazos/artefactos exigen fuente viva.

## Lo que esta extensión NO hace (y por qué)

**El MCP no puede hacer que la app sincronice con Drive.** Es un proceso aparte, de solo lectura,
que lee lo que ya está en Drive; la sincronización de la app corre **en el navegador** (IndexedDB ↔
Drive, con `syncNow()` disparado al abrir y ante cambios locales). Nada que el MCP haga cambia el
estado del navegador. Consecuencia práctica: **la frescura de lo que yo leo = la última subida de
la app**. Si querés datos al día, abrí la app (sincroniza sola) y después consulto.

## Work units

- [ ] **WU1** Capacidad `hasAgentData` + `decks()`/`artifacts()` en la fuente viva y `false` en la
  del backup; tests de la fuente.
- [ ] **WU2** Las 4 tools en `tools.mjs` con gating por capacidad, límites y formas de payload;
  tests de cada tool (incluye libros/mazos desconocidos y límites inválidos).
- [ ] **WU3** Test de redacción sobre mazos y artefactos + README + `npm test` del paquete en verde.

## Fuera de alcance
- Escritura (crear/editar mazos o artefactos desde el MCP): P28 la excluye explícitamente.
- Exponer `convos`/`messages` completos (la libreta ya se lee vía `get_notes`).
- Estadísticas de repaso agregadas (racha, retención): se puede sumar después como `study_stats`,
  con el mismo criterio de capacidad.
