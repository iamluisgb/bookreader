# BACKLOG — Lectura Orientada a Objetivos con Agente de IA

Feature: panel lateral con un agente que lee el libro **completo** (contexto 1M) según el
**objetivo** del usuario y rellena una **libreta estructurada** por plantilla.

**Arquitectura acordada (Fase 1):**
- Stack actual: vanilla JS ES6 modules, sin build, `epub.js`/`pdf.js` por CDN, GitHub Pages.
- **Contexto completo, no RAG.** El libro entero va como prefijo cacheable; sin embeddings,
  sin vector store, sin `transformers.js`.
- **Citas vía anclas→CFI**: el DOM se anota con `[[anchorId]]`, mapeadas a CFIs, para que el
  agente cite y el eReader salte al pasaje.
- **LLM**: BYOK contra nan (`https://api.nan.builders/v1`, OpenAI-compatible). Default
  **DeepSeek V4 Flash** (1M ctx, text). Modelo seleccionable.
- **Persistencia**: IndexedDB (no localStorage).
- **Alcance v1**: solo EPUB. 2 bloques → 6 plantillas (`templates.md`).

**Leyenda esfuerzo:** S < 0.5d · M ~1d · L ~2-3d.

## Progreso (2026-06-28)
Entregado y verificado E2E contra la API real de nan (19/19 tests verdes):
- **E0** spikes (caching + ancla→CFI). **E1** `LLMProvider` (streaming + tool-use no-streaming).
- **E2** segmentación + anclas. **E3** prompt orientado a objetivo + extracción con tool-use.
- **E4** IndexedDB v2 (libro cacheado por hash, chat, sesión, notas persistidos).
- **E5** las 6 plantillas, onboarding (bloque→plantilla→objetivo), libreta con `upsert_note`.
- **E6** split-screen, panel chat+libreta, citas clicables que navegan el lector.

Pendiente principal: resumen rodante para chats largos (E3.3), interrupción "Pepito Grillo"
(E5.2), edición manual del objetivo. El núcleo de `templates.md` está completo.

Añadido 2026-06-29: render de **Markdown** en respuestas/notas (`js/ai/markdown.js`, seguro,
sin deps) + botón **Copiar** + **auto-extracción** a la libreta (toggle ON) + **libreta
editable** (añadir/editar/borrar) + **atenuación de capítulos** en el índice (E6.4) +
serialización de llamadas a nan. Verificado (19/19).

---

## E0 — Spike / De-risk (hacer ANTES de comprometerse)

### E0.1 — Verificar prompt caching en nan/LiteLLM · `S` ✅ HECHO (2026-06-28)
- [x] Mismo prefijo grande (67k–190k tokens) enviado varias veces; medida latencia y `usage`.
- [x] Revisado `usage.prompt_tokens_details`.
- **Resultado:** el caching de prefijo **SÍ funciona a nivel de inferencia** (repetición
  exacta: 13s→0.9s, 14×). Pero nan **NO lo reporta** (`cached_tokens` siempre 0) ni
  **descuenta** el `cost` (da igual; nan es **tarifa plana**, el coste/llamada no es tu
  factura). Latencia turno-a-turno con libro caliente y pregunta cambiante: **mediana ~5s,
  rango 3–15s**; primer turno frío de un libro: **~13–26s**. **Decisión:** seguimos con
  contexto-completo, pero la UX **debe** asumir latencia variable de varios segundos →
  streaming obligatorio + estado "el agente está leyendo…". Mantener E7.2 como palanca si
  libros grandes hacen la latencia inaceptable.

### E0.2 — Probar CFI desde Range del DOM de un spine item · `S` ✅ HECHO (2026-06-28)
- [x] Cargado `test.epub`, recorrido el DOM de un spine item, generado CFI con
      `section.cfiFromElement(el)` y navegado con `rendition.display(cfi)`.
- **Resultado:** funciona de punta a punta. `cfiFromElement` → `epubcfi(/6/4!/4/2[epi]/6/10)`,
  parsea con `new ePub.CFI()`, `display(cfi)` aterriza en la sección correcta y la página
  renderizada contiene el texto del párrafo objetivo. El mecanismo **ancla→CFI** de E2.2
  queda de-risked. (`section.cfiFromRange(range)` también disponible para anclas sub-párrafo.)
- **AC:** ✅ un anchor resuelve a un CFI navegable.

---

## E1 — Capa de proveedores (adaptadores)

### E1.1 — `LLMProvider` OpenAI-compatible (nan) · `M` ✅ HECHO
- [x] `js/ai/llm.js` (no `llm-provider.js`): `fetch` contra `baseURL`, `Bearer <key>`.
- [x] Streaming SSE → `chatStream({onToken})`.
- [x] Tool calling vía `chatTools()` **no-streaming** (nan solo emite tool_calls sin streaming, ver spike E5).
- [x] Errores 401/429/5xx + `AbortController`.
- 🟡 Sin test unitario con `fetch` mockeado; cubierto por E2E real (`tests/ai.spec.ts`).

### E1.2 — Config de credenciales y modelo (BYOK) · `S` ✅ HECHO
- [x] Key + modelo en **localStorage** (vía `Storage`), no IndexedDB. La key no se loguea.
- [x] Modelos nan en `llm.js MODELS` (DeepSeek V4 Flash default), seleccionables en el panel.
- 🟡 `baseURL` fijo (no editable en UI todavía).

---

## E2 — Pipeline de segmentación + anclas (reemplaza al chunking/embeddings)

### E2.1 — Recorrido estructural del libro · `M` ✅ HECHO
- [x] `js/ai/segment.js` (no `segmenter.js`): recorre cada `spineItem`, breadcrumb de
      headings, `chapterTitle` vía TOC con fallback al heading.

### E2.2 — Anotación con anclas y mapa anchor→CFI · `M` ✅ HECHO
- [x] Marcadores `[[a<n>]]` por bloque; CFI por ancla con `section.cfiFromElement`; mapa `anchors`.
- [x] `anchorId → cfi` para navegar/resaltar (verificado E2E).

### E2.3 — Construcción y cacheo del libro por hash · `M` ✅ HECHO (parcial)
- [x] `bookId = SHA-256`; cache en IndexedDB (`bookText` + `anchors`); no re-segmenta.
- [x] `tokenEstimate` calculado y mostrado en el status.
- 🟡 Falta el **aviso si supera el contexto** del modelo (+ plan B E7.2).

---

## E3 — Motor del agente (prompts + contexto + tool-use)

### E3.1 — System prompt orientado a objetivo + contrato de anclas · `M` ✅ HECHO
- [x] En `panel.js systemPrompt()` (no `prompt.js`): rol filtro-por-objetivo + plantilla +
      contrato de citas `[[aN]]`. Prefijo cacheable = `system` + LIBRO anotado.

### E3.2 — Ensamblado de contexto por turno · `M` 🟡 PARCIAL
- [x] Prefijo estable (system + libro) + historia + consulta → cache-friendly.
- ⬜ Sin presupuesto de tokens ni recorte de turnos (se manda toda la historia). Ver E3.3.

### E3.3 — Resumen rodante del historial · `S` ⬜ PENDIENTE
- Al superar N turnos, resumir lo viejo y descartar crudos.

### E3.4 — Tool `upsert_note` (libreta estructurada) · `M` ✅ HECHO
- [x] Tool `upsert_note({fieldKey, content, sourceCfis})`, valida campo contra la plantilla,
      persiste en `notes`, actualiza la libreta en vivo (con citas).
- [x] **Auto-extracción** tras cada respuesta (toggle "Rellenar la libreta automáticamente",
      ON por defecto): indicador "📓 N a la libreta" + aviso (dot) en la pestaña sin saltar
      del chat. Botón manual "📓 A la libreta" cuando el toggle está OFF.

---

## E4 — Persistencia (IndexedDB)

### E4.1 — Capa de acceso a IndexedDB · `M` ✅ HECHO (2026-06-28)
- [x] `js/ai/db.js`: apertura versionada + `onupgradeneeded`. Stores creados:
      `books`, `bookText`, `anchors`, `messages`, y en **v2** `sessions` + `notes`
      (índices por `bookId`). Falta `summaries` (llega con E3.3).
- [x] Helpers: `loadSegmented`/`saveSegmented`, `getMessages`/`addMessage`/`clearMessages`,
      `hashBuffer` (SHA-256 del fichero → bookId estable).
- **Resultado:** verificado E2E — primera carga segmenta (1495 pasajes), tras recargar y
  reabrir el mismo EPUB el status es "Listo (cacheado)" (no re-segmenta) y el chat se
  restaura con sus citas clicables. 19/19 tests verdes.

### E4.2 — Modelo de sesión · `S` ✅ HECHO
- [x] `session {bookId, templateId, goal, createdAt}`, 1 por libro; reabrir reanuda objetivo
      + plantilla + notas + chat (verificado E2E).

---

## E5 — Plantillas (motor de templates.md)

### E5.1 — Definición declarativa de las 6 plantillas · `M` ✅ HECHO
- [x] `js/ai/templates.js`: las 6 plantillas (bloque, campos, tipo, `agentRole`, `goalPrompt`).

### E5.2 — Roles especiales del agente por plantilla · `M` 🟡 PARCIAL
- [x] **HQ&A al subrayar**: con la plantilla HQ&A activa, subrayar en el lector genera
      Pregunta + borrador de Respuesta (`> highlight / **P:** / **R:**`) y lo guarda en la
      libreta con botón ↗ al pasaje. panel.js escucha `rendition.on('selected')` (sin tocar
      app.js). Verificado E2E.
- [x] Atenuación de capítulos para todas las plantillas (E6.4).
- ⬜ Interrupción "Pepito Grillo" (Modelado de Comportamiento) en puntos de quiebre.

---

## E6 — UI

### E6.1 — Onboarding modal (objetivo + plantilla) · `M` ✅ HECHO
- [x] Bloque → plantilla → objetivo; persiste `session`; abre el panel. Aparece al pulsar 🤖
      (no en cada carga, para no tapar el lector).

### E6.2 — Layout split-screen · `M` ✅ HECHO
- [x] Panel derecho colapsable; lector intacto sin sesión. Los 18 tests previos siguen verdes.

### E6.3 — Panel del agente: chat + libreta · `L` ✅ HECHO
- [x] Chat streaming; citas `[[aN]]` → `display(cfi)` + highlight. **Markdown** + **Copiar**.
- [x] Libreta por plantilla: el agente rellena (auto/manual) y el usuario **añade, edita y
      borra** sus propias notas (persisten). Verificado E2E (CRUD + recarga).

### E6.4 — Atenuación de capítulos en el TOC · `S` ✅ HECHO (2026-06-29)
- [x] Una llamada `rate_chapters` (tool-use) puntúa cada capítulo vs objetivo; el `#toc-list`
      se decora (atenuado/★ relevante) sin tocar `app.js`. **Perezoso**: se calcula al abrir
      el índice; cacheado por libro+objetivo. Verificado E2E (1 ★ / 7 atenuados en test.epub).
- **Nota infra:** todas las llamadas a nan se **serializan** (`llm.js`) — nan da "network
  error" con peticiones concurrentes a la misma key.

---

## E7 — Robustez / pulido

### E7.1 — Estados de error y vacío en el panel · `S` 🟡 PARCIAL
- [x] Key ausente/inválida, 401/429, libro segmentándose.
- ⬜ Sin reintentos automáticos.

### E7.2 — Plan B: retrieval a nivel de capítulo (si E0.1 falla) · `M` ⬜ PENDIENTE
- No urgente: el caching funciona (E0.1). Palanca para libros enormes / sin caching.

### E7.3 — Tests E2E de la feature IA · `M` ✅ HECHO
- [x] `tests/ai.spec.ts` (etiquetado `@live`) contra la **API real**: onboarding → pregunta
      → cita navega. Separado del suite determinista: `npm test` (18, sin API, siempre verde)
      vs `npm run test:ai` (live, no determinista). Key desde `.env`.
- [x] Tests "no JS errors" endurecidos: capturan `pageerror` + navegan (habrían cazado el
      crash de `book.spine`).
- 🟡 El spec live no cubre extracción/persistencia (verificadas en scripts manuales).

---

## Orden sugerido de construcción

```
E0 (spikes)  →  E4 (db)  →  E1 (providers)  →  E2 (segmentación+anclas)
   →  E3 (motor agente)  →  E5 (plantillas)  →  E6 (UI)  →  E7 (robustez+tests)
```

## Decisiones cerradas
- BYOK + selector de modelo (nan). · Contexto-completo + anclas-CFI (sin RAG). ·
  IndexedDB. · 2 bloques → 6 plantillas. · EPUB primero. · Default DeepSeek V4 Flash.

## Riesgos abiertos
- ~~Prompt caching en nan (E0.1)~~ → **resuelto**: caching funciona pero latencia variable
  (3–15s caliente, 13–26s frío). Riesgo residual: **UX de latencia**, no de viabilidad.
  Mitigación: streaming + estado de carga; E7.2 si molesta en libros grandes.
- **"Lost in the middle"** en citas muy puntuales con contexto enorme — mitigado por anclas
  explícitas y, si hace falta, E7.2.
