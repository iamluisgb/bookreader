# BACKLOG — BookReader

Único backlog de lo **pendiente**. Lo entregado vive en [`CHANGELOG.md`](CHANGELOG.md).
Referencia: [`AGENTS.md`](AGENTS.md) (guía), [`DESIGN.md`](DESIGN.md) (diseño),
[`templates.md`](templates.md) (plantillas de libreta).

**Leyenda esfuerzo:** S < 0.5d · M ~1d · L ~2–3d. Los IDs entre paréntesis son los
históricos que cada ítem absorbe (trazabilidad con git).

---

## 🤖 IA / Agente

### IA1 — Recorte de contexto y de historial al LLM · **fase 1+2 ✓** _(ex T5, E3.2, E3.3)_
**Hecho (ver CHANGELOG):** retrieval por capítulo con presupuesto de tokens (60k), ventana de
historial (6 mensajes), guard de tokens (~120k), fallback a libro entero sin ratings, prefijo estable
para caching. Módulo [`js/ai/context.js`](js/ai/context.js) + integración en `send()`.

Pendiente (fases futuras, menor prioridad):
- **Fase 3 — resumen rodante del historial · _no planificado (bajo ROI)_:** resumir los turnos que salen
  de la ventana añade una llamada LLM por turno y solo aporta en conversaciones larguísimas (minoría).
  Ver [DECISIONS.md ADR-010](DECISIONS.md). Se retomará solo si aparece la necesidad real.
- **El retrieval de contenido (por objetivo, a nivel de capítulo) se rehace en [IA5](#ia5--retrieval-profesional-rag-por-pasaje-agéntico--l--sustituye-a-ia4).** La
  selección de historial de IA1 se mantiene; IA5 sustituye la selección de *libro*.

### IA2 — Interrupción "Pepito Grillo" · **✓** _(ex E5.2)_
**Hecho** (ver CHANGELOG · [DECISIONS.md ADR-013](DECISIONS.md)): repaso **al terminar capítulo** — con
la plantilla HQ&A activa, al entrar en un capítulo nuevo el agente interrumpe con una pregunta de
recuerdo sobre el anterior (sin darla respuesta; solo hacia delante; una vez por capítulo). Se descartó
"puntos de quiebre" (difuso/caro) frente al fin de capítulo (frontera natural y barata).

### IA3 — Reintentos automáticos en errores transitorios · **✓** _(ex E7.1)_
**Hecho** (ver CHANGELOG · [DECISIONS.md ADR-008](DECISIONS.md)): `fetchRetrying` en
[`llm.js`](js/ai/llm.js) reintenta ante red caída y 408/425/429/5xx con backoff exponencial + jitter,
honrando `Retry-After`. Usado por `chatStream` y `chatTools`. Tests en [`tests/llm.spec.ts`](tests/llm.spec.ts).

### IA4 — Retrieval por pregunta con embeddings · ~~`M`~~ · **absorbido por [IA5](#ia5--retrieval-profesional-rag-por-pasaje-agéntico--l--sustituye-a-ia4)** _(ex E7.2)_
Era "añadir embeddings al retrieval por capítulo". El rediseño correcto no es *añadir embeddings* sino
*cambiar de granularidad y de disparo* (pasaje + por pregunta + agéntico); los embeddings son la Fase 2
de IA5, no una feature suelta.

### IA6 — Visión: "Explicar lo que veo" (figuras) · **fase 1 ✓** `M`
Fase 1 hecha (ver CHANGELOG · ADR-018): modelo de visión configurable e independiente + acción "Ver" que
manda la **página actual del PDF** (imagen reescalada + texto de la página) al modelo de visión, con
degradación honesta si no hay VL configurado.
- **v2 pendiente:**
  - Auto-detectar "Figure/Figura N.M" en la pregunta y **localizar su página por el índice BM25** →
    mandar esa página aunque no estés en ella (sin acción manual).
  - Recorte de la **región de la figura** (no toda la página) para bajar tokens y mejorar el foco.
  - "Explicar lo que veo" en **EPUB** (requiere rasterizar el iframe de contenido).
  - **PDF escaneado:** usar el modelo de visión como lector cuando no hay capa de texto (OCR-por-VLM).

### IA5 — Retrieval profesional (RAG por pasaje, agéntico) · `L` · **sustituye a IA4**
**Motivación (caso real, verificado en backup del 2026-07-02).** Con DDIA y el objetivo *"System Design
senior-staff para entrevistas MAANG"*, el agente dijo no tener el Capítulo 9 y **pidió al usuario que se
lo pegara**. Pero en las puntuaciones guardadas, *"9. Consistency and Consensus"* tenía **0.95 — la
relevancia MÁS ALTA de todo el libro**. No se descartó por irrelevante: lo expulsó el empaquetado.

**Diagnóstico — 3 pecados del retrieval actual** ([`js/ai/context.js`](js/ai/context.js)):
1. **Ciego a la query:** selecciona una vez por conversación contra el *objetivo*, no por cada pregunta.
   Preguntar por el cap. 9 no lo trae al contexto (solo se fuerza el capítulo donde está el lector).
2. **Granularidad tosca:** la unidad es el *capítulo* (~30k tokens → entra entero o nada). Con el
   presupuesto de 60k y el empaquetado codicioso ([context.js L68-72](js/ai/context.js#L68-L72), `continue`
   en vez de `break`), un capítulo grande y muy relevante pierde frente a varios pequeños y menos
   relevantes → justo lo que pasó con el 9.
3. **Framing deshonesto:** al modelo se le entrega el recorte como *"LIBRO ANOTADO"*
   ([panel.js L567](js/ai/panel.js#L567)) sin decirle que es parcial → inventa que el usuario pegó un texto
   incompleto y pide que pegue más. Sin sentido en una app donde el libro entero ya está cargado.

**Solución — RAG por pasaje, agéntico, cacheado en el cliente.** Aprovecha dos activos ya montados:
las anclas `[[aN]]` a nivel de bloque ([`js/ai/segment.js`](js/ai/segment.js)) = pasajes con CFI listos
para indexar y citar, y el function-calling (`chatTools`, ya usado en
[`attenuation.js`](js/ai/attenuation.js)).

- **Índice de pasajes por libro** (keyed por hash, en IndexedDB):
  - **BM25 léxico** siempre (índice invertido en el navegador; cero API, cero coste). Fuerte en nombres
    propios y locators ("capítulo 9", "Raft", "consensus").
  - **Embeddings** cuando el proveedor BYOK expone `/embeddings`: se calculan una vez, se cachean, y la
    similitud coseno se hace en JS (miles de vectores → ms, sin servidor).
- **Retrieval como herramienta del agente** (no pre-inyección fija):
  `search_book(query)` (top-k híbrido, fusión RRF) y `read_chapter(n|título)` (filtro por metadato del
  TOC). Así *"flashcards del capítulo 9"* dispara `read_chapter(9)` automáticamente.
- **Router de query:** referencia estructural → `read_chapter`; conceptual → `search_book`. Resuelve el
  caso reportado de forma determinista.
- **Grounding honesto:** pasar el **TOC completo como mapa** + decirle que el texto es un extracto
  recuperado; si le falta algo, que llame a la herramienta o pida abrir el capítulo, **nunca** que peguen
  texto. (Toca [`js/ai/panel-template.js`](js/ai/panel-template.js) `systemPrompt`.)
- **Evaluación (no opcional):** ~15-20 preguntas doradas por libro (pregunta → ancla esperada) y medir
  *recall@k*. Sin eso, "mejoré el retrieval" es fe.

**Fases (por ROI):**
- **Fase 1a ✓** _(entregada, ver CHANGELOG 2026-07-02)_ — retrieval **por pregunta** a nivel de **pasaje**
  con BM25 ([`js/ai/retrieval.js`](js/ai/retrieval.js)) + router de capítulo (número/título) + prompt
  honesto con mapa TOC. Inyección (mantiene streaming), sin bucle de herramientas. **Arregla el bug
  reportado.**
- **Fase 1b ✓** _(entregada, ver CHANGELOG · [DECISIONS.md ADR-009](DECISIONS.md))_ — retrieval como
  **herramienta agéntica** (`search_book` + `read_chapter`) vía `chatToolsLoop` (bucle multi-turno en
  [`llm.js`](js/ai/llm.js)). Recolección gateada (solo turnos difíciles: sin capítulo nombrado + BM25
  débil), fusión con el contexto inicial y respuesta en streaming. Degrada con gracia si falla.
- **Fase 2** `M` · **aplazada** _(decisión, [DECISIONS.md ADR-014](DECISIONS.md))_ — embeddings cacheados
  (si hay `/embeddings`), fusión híbrida BM25+semántica, rerank LLM opcional. Se aplaza: BM25+router+vecinos
  ya cubren la mayoría, depende del proveedor y no es verificable end-to-end aquí. Se retoma midiendo con
  el arné de ADR-012.
- **Fase 3 ✓** _(entregada, ver CHANGELOG · [DECISIONS.md ADR-011/012](DECISIONS.md))_ — *sentence-window*
  (`withNeighbors`, cada acierto arrastra sus vecinos del mismo capítulo) + arné de **evaluación recall@k**
  ([`tests/retrieval.spec.ts`](tests/retrieval.spec.ts)) como suelo de regresión.

**Prerrequisito — ✓ verificado** (2026-07-03, sobre el EPUB real de DDIA): la segmentación **sí** emite
`## 9. Consistency and Consensus` idéntico al TOC. El bug real era otro (atribución por subtítulos, ver
[DECISIONS.md ADR-006](DECISIONS.md) y CHANGELOG), ya corregido. Presupuesto de contexto ahora adaptativo
([ADR-007](DECISIONS.md)): 60k normal, ~110k al nombrar un capítulo.

---

## 🎨 Producto / UX

> **Decisión de diseño — "Ajustes generales" (hogar de P1–P3).** P1, P2 y P3 son config
> **global de la app** (no dependen del libro abierto), así que NO van en la sidebar *Ajustes*
> (que es contextual de lectura: tema/fuente/ancho). Su hogar es un **overlay de ajustes
> generales** —como el patrón ya existente `#ai-onboarding`— anclado a la **estantería**
> (`#library`, el estado *home* sin libro), con dos puntos de entrada: un engranaje en la
> cabecera de la estantería **y** otro en el pie de la sidebar mientras se lee (accesible desde
> ambos contextos sin acoplarlo al DOM de `#library`).
>
> Estructura: **Agente** · **Perfiles** (P1) · **Plantillas** (P2) · **Datos** (P3). Principio
> clave: **definir vs usar** — en Ajustes generales se *gestiona* el catálogo (CRUD de perfiles y
> plantillas); en el **onboarding del panel se sigue *eligiendo*** cuál usar para cada conversación
> (no duplicar la elección).
>
> **✅ Completo** (ver CHANGELOG): existe el overlay [`js/ui/app-settings.js`](js/ui/app-settings.js)
> con las 4 secciones funcionales, entradas desde estantería + pie de la sidebar: **Agente**
> (key/modelo/auto, movido desde `#ai-config`), **Perfiles** (P1 ✓), **Plantillas** (P2 ✓) y **Datos**
> (P3 ✓). El principio *definir-vs-usar* se cumple: el catálogo se gestiona aquí y se elige en el
> onboarding/runtime.

### P5 — Búsqueda de texto en el libro · `M`
Buscar y saltar a coincidencias dentro del EPUB.

### P6 — Mejoras de subrayados · `S`–`M`
- Exportar por color (solo amarillos, etc.); copiar el texto de un highlight al portapapeles.
- Confirmación al borrar y borrar desde el propio resaltado en el lector.
- _(El backup/restore de highlights y bookmarks ya lo cubre P3, ver CHANGELOG.)_

### P7 — Sync entre dispositivos · `L`
Requiere backend (hoy todo es local-first: IndexedDB + localStorage).

### P8 — Exportar libretas y conversaciones · `M`
**Qué falta hoy.** El único export "legible" es [`buildMarkdown()`](js/backup.js) en Ajustes → Datos
(P3): un **volcado global** de TODAS las libretas + subrayados que, además, **omite el chat** (nunca lee
el store `messages`) y aplana las notas con `oneLine()` (pierde el formato/markdown). No hay forma de
exportar **una** conversación o **una** libreta concreta, ni desde donde se usan (el panel).

Distinguir de lo existente: **P3 = backup/restore** (JSON completo, cifra-nada, para *migrar* de
dispositivo, ida y vuelta). **P8 = export legible y selectivo** (para *compartir/archivar/estudiar*, solo
salida). No lo reinventa: reutiliza el patrón `download()` CSP-safe de backup.js.

- **Export por conversación desde el panel** (botón en la cabecera de Chat/Libreta), no solo el volcado
  global de Ajustes.
- **Incluir el chat:** transcripción de `messages` (rol + contenido), que hoy no se exporta. Opción de
  exportar *solo libreta*, *solo chat* o *ambos*.
- **Preservar formato:** no aplanar con `oneLine()`; respetar markdown de notas y las citas `[[aN]]`
  (idealmente resueltas a "cap. · pág." con `EpubReader.getPageInfo`).
- **Formatos:** Markdown de serie; valorar **PDF** (print-to-PDF del navegador, sin dependencias) y
  copia al portapapeles.
- Refactor menor: generalizar `buildMarkdown()` para aceptar un scope (`{ convoId }` | global) y una
  opción `includeChat`, en vez de duplicar lógica.

---

## 📄 PDF — paridad de features con EPUB

> **Contexto.** Hoy el PDF es solo *visor*: navega, guarda página, progreso, marcadores con nº de
> página y deep-links por URL. Todo lo que da valor a BookReader —**IA/chat, subrayados,
> selección→agente, modo scroll, tipografía**— es hoy **solo-EPUB** porque se construye sobre epub.js
> (`book.spine`, CFIs, `rendition.annotations`). El PDF es raster fijo (`<canvas>`) con una capa de
> texto invisible encima ([`js/pdf-reader.js`](js/pdf-reader.js)).
>
> **Raíz del problema:** el modelo de ancla es `cfi` (EPUB). Para PDF hay que anclar por
> `{página, rects}`. Ese es el cambio transversal que habilita subrayados e IA con enlace al pasaje.
>
> **Prueba real** (Michael Albada, *Building Applications with AI Agents*, O'Reilly, 355 pág.):
> PDF **digital, no escaneado** (0/12 páginas sin texto), con **outline completo** (capítulos +
> subsecciones vía `getOutline()`) y extracción de prosa **limpia y en orden** (código incluido,
> legible). Conclusión: para un PDF así el agente leería con **calidad equivalente a EPUB**,
> capítulos incluidos. La estructura NO se pierde cuando hay outline → el recorte de contexto de IA1
> funciona igual. Artefactos menores: guiones de corte de línea (`over‐ all`) y código aplanado sin
> saltos.
>
> **Prerrequisito:** los bugs de bajo nivel de **TEC1** (ArrayBuffer *detached* al guardar, HiDPI,
> teclado, errores). Conviene cerrar TEC1 antes o a la par de PDF1.

### PDF1 — IA/agente sobre PDF (fase 1, mayor impacto) · **✓** `L`
Es el salto de "visor de PDF" a "BookReader con PDF". El agente lee los PDF con **el mismo pipeline de
retrieval** que los EPUB (BM25 + router + vecinos + agéntico). Entregado (ver ADR-015):
- ✓ Extracción por página con `page.getTextContent()` → `js/ai/segment-pdf.js` produce el mismo "libro
  anotado" (`[[aN]]`) que el EPUB, pero con locator de **página** (la cita salta a la página).
- ✓ **Detección de PDF escaneado:** media de caracteres/página en la muestra inicial; si es ~0 se avisa
  («este PDF no tiene texto seleccionable…») y no se indexa. (Sin OCR; fuera de alcance.)
- ✓ Capítulos por `pdf.getOutline()`: `## capítulo` con **solo el nivel superior abriendo capítulo**
  (subsecciones heredan → evita el bug de atribución tipo "capítulo 9"). Verificado sobre PDF real
  (Albada, 355 pág, 1505 pasajes, 13 capítulos).
- ✓ De-hyphenation de guiones de corte de línea (`over-\nall` → `overall`).
- ✓ Segmentador por formato: `setBook(doc, id, title, {format:'pdf'})` ramifica a `segmentPdf` sin
  tocar el camino EPUB. Tests: [`tests/segment-pdf.spec.ts`](tests/segment-pdf.spec.ts).

### PDF2 — Selección→agente en PDF · **✓** `M`
Seleccionar texto en la capa del PDF (documento padre, sin iframe) muestra la barra de selección en
**modo PDF**: solo "Preguntar al agente" (`AiPanel.quoteSelection`) y "Copiar". Subrayar/Nota se ocultan
porque dependen del modelo de ancla CFI (llegan en PDF3). Reutiliza el mismo `#highlight-tooltip` y su
posicionamiento; wiring en [`highlights-ui.js`](js/highlights-ui.js) (`setupPdfSelection`) llamado desde
`loadPdf`. Test en [`tests/pdf.spec.ts`](tests/pdf.spec.ts). _(HQ&A al subrayar en PDF → depende de PDF3.)_

### PDF3 — Subrayados/anotaciones en PDF · **✓** `L`
- ✓ **Modelo de ancla nuevo `{página, rects}`** en `js/highlights.js` (`addPdf`, `getByPage`,
  `removeById`) conviviendo con el modelo CFI del EPUB (identidad genérica `id ?? cfi`). Los `rects`
  se guardan en **coordenadas fraccionales (0..1)** de la página → nítidos a cualquier escala/HiDPI.
- ✓ Overlay `<div>` (`.pdf-hl-layer` con multiply) sobre el canvas, `pointer-events:none` para no
  romper la selección de texto. Se re-pinta en cada `onPage` y al crear/borrar.
- ✓ Persistencia + re-pintado al volver a la página; lista lateral y borrado generalizados a PDF/EPUB.
- ✓ Barra de selección con Subrayar/Nota/Preguntar/Copiar (completa lo que PDF2 dejó a medias).
- ✓ **Bonus (robustez):** `renderPage` cancela el `RenderTask` en curso → arreglado el crash "Cannot
  use the same canvas during multiple render()" al pasar páginas rápido. Ver ADR-016.
- Tests: [`tests/pdf.spec.ts`](tests/pdf.spec.ts) (crear/persistir/re-pintar). _(HQ&A al subrayar en PDF
  queda como mejora futura: hoy HQ&A está atado al evento `selected` de epub.js.)_

### PDF4 — Modo scroll (capítulo continuo) en PDF · **✓** `M`
Toggle **Páginas/Scroll** (pestaña Ajustes del lector) ahora también en PDF. En scroll se apilan
todas las páginas con **render perezoso** (IntersectionObserver: solo se pintan las cercanas al
viewport, las lejanas se liberan → memoria acotada; verificado con Albada: ~2-3 canvas vivos de 355).
La página actual se deriva del scroll; el modo se recuerda por libro. Render por-wrapper con `data-page`
(común a ambos modos) que conserva PDF3 (subrayados por página). Ver ADR-017. Test en
[`tests/pdf.spec.ts`](tests/pdf.spec.ts).

### PDF5 — Tipografía / tema en PDF · límite de formato
**No portable de raíz:** el texto del PDF es layout fijo (imagen), no reflowable. No hay tamaño de
fuente, ni reflow, ni recolorear texto. Máximo alcanzable: **zoom** y, para modo oscuro, un filtro
`invert` sobre el canvas (funciona pero degrada figuras/colores). Reflow real exigiría reconvertir el
PDF a HTML → **fuera de alcance**. Documentado aquí para no reabrir el debate.

---

## 🔧 Técnico (calidad / seguridad / perf / bugs)

### TEC1 — Revisar el lector PDF · **✓** _(ex T11)_
**Hecho** (ver CHANGELOG). Desbloquea la épica [PDF — paridad de features](#-pdf--paridad-de-features-con-epub).
Antes 0 cobertura E2E; ahora [`tests/pdf.spec.ts`](tests/pdf.spec.ts) con fixture propia (`tests/test.pdf`).
- **✓ Bug del ArrayBuffer *detached*** (crítico, pérdida de datos): pdf.js transfería el buffer y
  `persistToLibrary` petaba en `slice` → el PDF **no se guardaba**. Fix: `PdfReader.load` clona el buffer
  antes de `getDocument`. Test que **falla sin el fix**.
- **✓ Nitidez HiDPI:** el canvas se pinta a `scale·devicePixelRatio` y se muestra al tamaño lógico → nítido
  en retina. Test con `deviceScaleFactor:2`.
- **✓ Navegación por teclado / botones / barra de progreso** en PDF: ya estaba cableada en `app.js`.
- **✓ Limpieza:** `onProgress` de `load()` cableado al `loadingTask`; catch del `destroy` con `warn`;
  `loadPdf` ya surface error (alert). _(Subrayados/selección/IA en PDF → épica PDF1–PDF3.)_
- _Nota:_ **acoplamiento a pdf.js 3.11** (`renderTextLayer` cambia en 4.x) se documenta; no bloquea.

### TEC2 — Tests del panel IA (characterization) · **✓** _(recomendación staff)_
**Hecho** (ver CHANGELOG): tests deterministas del panel con `fetch` stubbeado
([`tests/panel.spec.ts`](tests/panel.spec.ts)): onboarding→sesión lista, envío→respuesta, y el **gating
del retrieval agéntico** (pregunta con match no dispara herramientas; pregunta vaga sí). Unit de citas en
[`tests/render.spec.ts`](tests/render.spec.ts). Escribir los tests **destapó y corrigió** un fallo del
gating (el retrieval vacío no disparaba el agéntico). Complementan a los ya existentes de `llm.spec.ts`,
`retrieval.spec.ts` y `chapter-event.spec.ts`.

