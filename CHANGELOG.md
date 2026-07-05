# CHANGELOG — BookReader

Registro histórico de lo entregado. Lo **pendiente** vive en [`BACKLOG.md`](BACKLOG.md).
Los IDs (`E*`, `F*`, `T*`, `B*`) se conservan para trazar con el histórico de git.

---

## 2026-07-05 — Zoom de PDF fluido tipo Adobe (sin re-render, paginado + scroll)

El pinch re-renderizaba el canvas al soltar (la "recarga") y el preview salía borroso. Rework del zoom
(ver [DECISIONS.md ADR-019](DECISIONS.md)):
- **Oversample:** el canvas se pinta ~2.5× su tamaño (con tope de memoria) → ampliar sigue nítido
  **sin re-rasterizar**.
- **Zoom en el layout:** `.pdf-page` es una caja de tamaño `fit·zoom` (→ **paneo nativo**) con un
  `.pdf-scaler` que escala canvas + capa de texto. Las páginas viven en `#pdf-zoom-layer`.
- **Pinch (2 dedos):** transform en vivo del layer (GPU, mantecoso), anclado al punto focal; **al soltar
  se "hornea"** en el layout y se ancla el scroll. **1 dedo = scroll/selección nativos**. Ctrl/⌘+rueda en
  escritorio.
- Funciona en **paginado y scroll** (leer PDFs técnicos en móvil/tablet). Subrayados en % (escalan solos).
- Verificado: **cero re-render** (mismo canvas, backing intacto), nítido a 2×, anclaje focal, ambos modos.
  Tests en [`tests/pdf.spec.ts`](tests/pdf.spec.ts).

## 2026-07-05 — Brillo y luz nocturna (ajustes de pantalla, tipo Play Books)

Dos controles nuevos en Ajustes (pestaña de lectura), como en Play Books. La web no puede tocar el brillo
ni la temperatura reales del dispositivo, así que se emulan con overlays a pantalla completa que **no
capturan eventos** (`pointer-events:none`):
- **Brillo:** slider que atenúa con una capa negra (0.35–1.0).
- **Luz nocturna:** slider que aplica un filtro **cálido ámbar** en `multiply` (reduce la luz azul).
  Es distinto del tema oscuro: entibia la pantalla sin invertir colores.
- Persisten en `settings` y se reaplican al cargar. Nuevos `brightness`/`nightLight` en
  [`js/settings.js`](js/settings.js). Test en [`tests/display.spec.ts`](tests/display.spec.ts).

## 2026-07-05 — PDF: el pinch-zoom se ancla al punto focal (ya no salta)

En móvil, al hacer pinch sobre una zona, el PDF re-renderizaba al nuevo tamaño pero **saltaba a otra
parte** de la página: el zoom no se anclaba al punto entre los dedos y el commit no ajustaba el scroll.
- **Zoom-a-punto** ([`pdf-reader.js`](js/pdf-reader.js)): se captura el foco (punto medio de los dedos, o
  el cursor en Ctrl/⌘+rueda); el preview escala con `transform-origin` en ese foco y, tras el re-render,
  el scroll se reposiciona para mantener bajo el foco el mismo punto del contenido (el padding no escala).
- Test en [`tests/pdf.spec.ts`](tests/pdf.spec.ts): tras un pinch anclado, la fracción del canvas bajo el
  foco se conserva (no salta). Verificado además con un pinch simulado (invariante Δ≈0).

## 2026-07-05 — Retrieval: capítulos en números romanos ("capítulo 3" → "III")

Pedir "resumen del capítulo 3" en un libro con capítulos en **romanos** (Lituma: I, II, III…) fallaba:
el agente decía no tener ese capítulo y pedía abrirlo. Causa: el router de capítulos
([`retrieval.js`](js/ai/retrieval.js)) solo entendía números **árabes**, así que "3" no casaba con "III".
- `leadingNum` y el router (`matchChapters`) ahora convierten **romano↔árabe** (`romanToInt` +
  validación), tanto en la etiqueta del TOC como en la pregunta ("capítulo 3" o "capítulo III").
- Arregla el router inicial y la herramienta agéntica `read_chapter`. Los capítulos árabes siguen igual.
- Test en [`tests/retrieval.spec.ts`](tests/retrieval.spec.ts).

## 2026-07-04 — Bug crítico: el agente respondía de OTRO libro (carrera al segmentar)

Con un libro abierto, el agente contestaba con contenido de otro (citas de otro libro incluidas). Causa:
`prepareBook()` en [`panel.js`](js/ai/panel.js) segmenta de forma **asíncrona** (lenta si no está cacheado)
y al terminar asignaba `annotatedText`/`anchors` **sin comprobar que el libro no había cambiado**. Si abrías
el libro A (arranca su segmentación), cambiabas al B, y la de A terminaba **después**, sobrescribía el
contexto de B → el agente respondía de A. El bump de `segVersion` (fix anterior de citas) forzó
re-segmentar todos los libros → **ensanchó justo esa ventana**, por eso saltó ahora.

- **Guard de libro en `prepareBook`:** captura `bookId`/`book`/formato al empezar y descarta el resultado
  (sin tocar `annotatedText`/`anchors`/estado) si el usuario cambió de libro mientras segmentaba. Los
  `setStatus` de progreso también se silencian si ya no es el libro actual.
- **Guard de secuencia en `setBook`:** nº de apertura incremental; la cola asíncrona (migrar/cargar
  conversaciones) aborta si otra apertura la adelanta → evita mezclar conversaciones entre libros.
- **Purga de la caché envenenada (`segVersion` 2→3):** el guard evita NUEVAS contaminaciones, pero la
  re-segmentación disparada por el fix anterior (sin el guard aún) pudo **guardar contenido cruzado bajo
  el id equivocado**; esa caché mala persistía («sigue el error»). Subir la versión la descarta → los
  libros se re-segmentan y ahora se guardan bien (con el guard). Tests deterministas en
  [`tests/book-switch.spec.ts`](tests/book-switch.spec.ts): el solape no cruza cachés y una entrada de
  versión anterior se descarta.

## 2026-07-04 — Citas del chat: arreglo de enlaces huérfanos + señalar el pasaje

**Bug — citas que salían crudas `[[aN]]`.** En EPUB, el ancla solo se registraba en el mapa si
`cfiFromElement` devolvía un CFI; cuando fallaba (en algunos libros, hasta en TODOS los bloques), el id
quedaba en el texto pero no en el mapa → el agente lo citaba y se pintaba el marcado crudo.
- [`segment.js`](js/ai/segment.js): el ancla se registra **siempre**, con `href`/capítulo de fallback
  (`cfi` opcional). La cita navega al menos al **capítulo** aunque no haya CFI puntual.
- [`db.js`](js/ai/db.js): **versión de segmentación** (`segVersion`), las cacheadas antiguas se ignoran →
  los libros ya abiertos se **re-segmentan** con el mapa arreglado.
- [`render.js`](js/ai/render.js): una cita entre corchetes inexistente/inventada ahora **se elimina**
  (no se deja `[[aN]]` crudo); un `aN` suelto en prosa se respeta. [`panel.js`](js/ai/panel.js)/
  [`search.js`](js/search.js) usan el fallback `cfi ?? href ?? page`. Test en
  [`tests/render.spec.ts`](tests/render.spec.ts).

**Señalar el pasaje citado.** Al pulsar una cita:
- EPUB: resaltado **transitorio** del pasaje (emerald, se retira solo ~2.8 s). Antes se acumulaban
  indefinidamente; ahora se limpia el anterior.
- PDF: **flash** de la página de destino (no tenemos los rects del pasaje, así que se señala la página).

## 2026-07-04 — Buscar libro en la estantería

- Buscador en la barra de la biblioteca que **filtra por título y autor** (insensible a acentos/mayúsculas,
  mismo `norm` que [`js/search.js`](js/search.js)). Refiltra **en vivo** re-pintando solo la rejilla
  (`.lib-results`) para no perder el foco del input al teclear; estado vacío contextual si no hay match.
  Toca [`js/library/view.js`](js/library/view.js) + estilo pill coherente con la toolbar.

## 2026-07-04 — PDF en móvil: ajuste a ancho + pinch-zoom

El PDF se pintaba a un `scale` **fijo de 1.5**, así que en móvil la página se salía de pantalla
(no cabía) y no había forma de hacer zoom. Ahora:

- **Ajuste a ancho:** el scale se calcula del ancho del contenedor (`computeScale`), con tope 1.5 para
  que en escritorio conserve el tamaño de lectura de antes. En móvil la **página cabe entera**.
- **Zoom:** **pinch** con dos dedos (preview con transform CSS en vivo + **re-render nítido** al soltar,
  no borroso) y **Ctrl/⌘ + rueda** en escritorio (incluye el pinch de trackpad). Rango 1×–5×.
- **Paneo:** contenedor `overflow: auto` + `justify/align: safe center` → con zoom se puede desplazar a
  cualquier borde. `touch-action: pan-x pan-y` (el paneo de 1 dedo es nativo; el pinch lo gestiona el JS).
- **Re-fit** automático al rotar/redimensionar. El zoom se resetea a "ajuste" al abrir otro libro.
- Funciona en ambos modos (paginado y scroll). Test:
  [`tests/pdf.spec.ts`](tests/pdf.spec.ts) (la página cabe a lo ancho en móvil; el zoom la agranda).

## 2026-07-04 — Cabecera estilo Play Books: buscador + logo como "inicio"

- **Título del libro centrado** en la cabecera (antes pegado a la izquierda flotando en un hueco),
  15px/600, con las dos islas de iconos balanceadas a los lados y ancho a prueba de solapes
  (`min(calc(100% - 260px), 460px)`; trunca con elipsis en móvil).
- **Buscador en la cabecera** (icono lupa, `#header-search`): abre la sidebar en la pestaña *Buscar* y
  enfoca el campo, reutilizando el corpus de búsqueda existente (EPUB y PDF). Nuevo glifo `search`.
- **El botón de biblioteca es el imagotipo** de la app (nuevo glifo `logo` en la rejilla 24×24), teñido
  de **emerald** (`.brand-btn`) como marca/inicio —igual que el logo coloreado de Play Books entre iconos
  neutros— y movido al extremo izquierdo. Vuelve a la biblioteca al pulsarlo.
- Sin archivos nuevos en el precache → sin bump de `sw.js`.

## 2026-07-04 — Identidad Fase 3: componentes + imagotipo

Cierre de la identidad visual (dirección "herramienta de ingeniería, silenciosa y precisa";
referencias Linear/GitHub/Warp/Ghostty).

- **Imagotipo nuevo** (`icons/icon.svg`): página con esquina doblada + prompt `>_` (lectura +
  ingeniería), line-art **emerald** sobre **charcoal**. Reemplaza el icono azul iOS. La marca se
  usa también inline en el **landing** (en emerald, sin recuadro, adaptándose al tema).
- **Iconos PWA regenerados** desde el SVG con Chromium
  ([`scripts/rasterize-icons.mjs`](scripts/rasterize-icons.mjs), sin depender de rsvg/magick):
  `icon-192`, `icon-512`, `maskable-512` (a sangre, safe-zone) y `apple-touch-icon` (180). `manifest.json`
  `theme_color`/`background_color` → `#111418` (splash cohesionado con el icono).
- **Radios a 8px**: se elimina el look "píldora/iOS". `.primary-btn`, `.icon-btn` y `.nav-btn` pasan de
  `--r-pill` a `--r-sm` (8px); normalizados también `select`, `.toc-list a`, footer de sidebar. Chips y
  FAB siguen redondos (intencional).
- **Foco = borde verde, sin glow**: se quita el `box-shadow` de halo en inputs/textarea/select; el foco
  es un borde de acento limpio.
- **Tooltips propios** (`[data-tip]`, CSS puro sin JS): fondo charcoal `#232A31`, radio 8px, aparición
  con leve retardo, variantes de alineación (izq/dcha) para botones pegados al borde; ocultos en táctil.
  Aplicados a los botones de la cabecera (sustituyen al `title` nativo; se conserva `aria-label`). La
  cabecera sube a `z-index: 40` (su `backdrop-filter` crea contexto de apilamiento) para que el tooltip
  se pinte sobre el viewport.
- **Barra de progreso** más fina y redondeada (4px, radio pill).
- Sin archivos nuevos en el precache → sin bump de `sw.js` (los cambios de contenido propagan por SWR).

## 2026-07-04 — Identidad Fase 2: tipografía (Inter en la UI; Source Serif 4 opcional)

- **Inter** como fuente de la **UI** (`--font-ui`), self-hosted y subsetada (latin, pesos 400/500/600).
- **Source Serif 4** para **lectura**, pero **como OPCIÓN, no por defecto**: se añade al selector de
  fuente (Ajustes → Fuente) y la lectura por defecto **sigue siendo la serif actual** (`'Literata',
  ui-serif, Georgia`), por preferencia expresa.
- Fuentes servidas desde el propio origen (`css/fonts.css` + `fonts/*.woff2`), cumpliendo la CSP
  (`font-src 'self'`) y funcionando **offline**; `font-display: swap`. Peso total ~116KB.
- `sw.js` v49→v50 (nuevos assets en el precache). Tests:
  [`tests/fonts.spec.ts`](tests/fonts.spec.ts) (las fuentes cargan; el default de lectura no cambia).

## 2026-07-03 — Visión: "Ver" adjunta la página y tú personalizas el mensaje

Refinamiento de la visión (ADR-018) a partir de uso real. Antes "Ver" enviaba de inmediato con el texto
del input, y si la respuesta se cortaba, pedir "continúa" caía en el modelo de texto (sin imagen) → "no
tengo el extracto". Ahora:

- **"Ver" ADJUNTA la captura** de la página actual al composer (chip "📷 Página N"), **no envía**. Escribes
  o ajustas tu pregunta y, al pulsar **Enviar**, ese turno va con imagen al modelo de visión. Control
  total del mensaje.
- **Menos cortes:** el turno de visión sube a `max_tokens` 2048 (antes 1024). El prompt fija el número de
  página correcto (el modelo ya no lo cambia).
- El chip se limpia al enviar o con su ✕, y al cambiar de libro.
- Verificado en vivo (mimo-v2.5): adjuntar la pág. 151 + pregunta propia → describe la Figura 6.3 real
  (nodos, entidades, relaciones) en ~2k caracteres, sin cortarse. Test E2E actualizado
  ([`tests/pdf.spec.ts`](tests/pdf.spec.ts)). Sin archivos nuevos → sin bump de `sw.js`.

## 2026-07-03 — P5: búsqueda de texto en el libro (EPUB y PDF)

Nueva pestaña **Buscar** en el sidebar. Un solo camino para ambos formatos.

- **Reutiliza el corpus segmentado del agente** (`annotatedText` con pasajes `[[aN]]` + anclas), así
  que no re-indexa nada: EPUB salta por **CFI**, PDF por **página**, con la misma función pura
  ([`js/search.js`](js/search.js) · `searchPassages`).
- Insensible a **acentos y mayúsculas**; muestra un fragmento con el match resaltado + capítulo/página;
  clic → navega a la coincidencia (reutiliza `goToLocator`, compartido con las citas del agente).
- El corpus se carga de IndexedDB al buscar (`AiDB.loadSegmented`); si el libro aún se está segmentando,
  avisa. Debounce de 200ms.
- Nuevo archivo `js/search.js` → `sw.js` v48→v49. Tests: [`tests/search.spec.ts`](tests/search.spec.ts)
  (unidad EPUB/PDF, acentos, y E2E que teclea y navega). Verificado sobre PDF real (120 hits de
  "knowledge" → salto a su página).

## 2026-07-03 — P8: exportar una conversación (libreta + chat) a Markdown

Antes solo existía un volcado global (Ajustes → Datos) que **omitía el chat** y aplanaba las notas.
Ahora se exporta **una** conversación concreta **desde el panel**, legible y con formato.

- **Botón "Exportar"** en la barra de conversación del panel → descarga un `.md` de la conversación
  activa (`backup.js · buildConvoMarkdown`). Nombre con libro + sesión + fecha.
- **Incluye el chat:** transcripción de los mensajes (🧑 Tú / 🤖 Agente), que el volcado global no tenía.
  La función admite `includeChat`/`includeNotebook` por separado.
- **Preserva el formato** de notas y mensajes (sin aplanar con `oneLine`) y **resuelve las citas**
  `[[aN]]` a `(pág. N)`/`(capítulo)` usando las anclas del libro segmentado (best-effort).
- Reutiliza el `download()` CSP-safe (nuevo `downloadText` exportado). Tests:
  [`tests/export.spec.ts`](tests/export.spec.ts) (contenido, solo-libreta, y descarga E2E). Sin archivos
  nuevos → sin bump de `sw.js`.

## 2026-07-03 — Estantería: portada real de los PDF (página 1)

Los PDF mostraban una portada genérica; ahora se ve su **página 1** como el EPUB muestra la suya.

- `PdfReader.renderCoverDataUrl()` renderiza la página 1 en un canvas propio y devuelve un JPEG
  reescalado (lado largo ~400px). `persistToLibrary` la guarda al abrir un PDF desde archivo.
- **Backfill:** los PDF ya guardados sin portada la generan al reabrirlos desde la estantería
  (`updateBook` + re-render de la biblioteca), así que no hay que re-importarlos.
- Test: [`tests/pdf.spec.ts`](tests/pdf.spec.ts) (la portada guardada es un `data:image/…`). Sin
  archivos nuevos → sin bump de `sw.js`.

## 2026-07-03 — Visión: "Explicar lo que veo" (figuras/diagramas de un PDF)

El agente ya puede **ver** una página del PDF, no solo su texto. Resuelve el caso "explícame la Figure
6.2" (una figura son píxeles, no está en el extracto). Ver [`DECISIONS.md`](DECISIONS.md) · ADR-018.

- **Modelo de visión configurable e independiente** del de texto (Ajustes → Agente → «Modelo de visión»,
  `ai_vision_model`). El RAG/chat sigue en el modelo de texto barato; solo el turno que necesita ver una
  página escala al de visión (enrutado por capacidad).
- **Acción "Ver"** en el composer del panel (solo PDF): captura la **página actual** del canvas ya
  renderizado (`PdfReader.capturePageImage`, reescalada a ~1024px JPEG), adjunta el texto extraído de esa
  página como contexto y hace **un turno multimodal** (`content` con `image_url`, OpenAI-compatible vía
  `LLM.chatVision`). Usa lo que haya en el input como petición; la respuesta cae en el mismo chat.
- **Degradación honesta:** sin modelo de visión configurado, guía a configurarlo en vez de fingir que ve
  la figura (coherente con el grounding existente).
- Es también el camino natural para **PDFs escaneados** (sin texto, la visión es la única vía).
- Test determinista: [`tests/pdf.spec.ts`](tests/pdf.spec.ts) (verifica que "Ver" envía la imagen al
  modelo de visión). Sin archivos nuevos → sin bump de `sw.js`.

## 2026-07-03 — PDF: índice (TOC) y marcadores en el sidebar

Cierra dos huecos de paridad PDF↔EPUB (los otros dos, tipografía y modo oscuro del contenido, son
límites de formato — PDF5).

- **Índice del PDF en el sidebar:** `PdfReader.getOutlineItems()` resuelve el `getOutline()` a
  `[{label, page, subitems}]` (páginas ya resueltas vía `getPageIndex`); `loadPdfTOC()` lo pinta con
  las subentradas indentadas (p. ej. capítulos dentro de una *Part*). Cada entrada salta a su página.
  Si el PDF no trae outline, se muestra "Este PDF no tiene índice".
- **Marcadores en PDF:** el botón de marcar (antes deshabilitado en PDF) ahora marca la **página
  actual** con un id sintético `page:N`, reutilizando la API de `bookmarks.js` sin tocar el modelo. La
  lista lateral y el estado del botón se actualizan al cambiar de página.
- Tests: [`tests/pdf.spec.ts`](tests/pdf.spec.ts) (marcadores; estado vacío del índice). Sin archivos
  nuevos → sin bump de `sw.js`.

## 2026-07-03 — PDF4: modo scroll continuo en PDF

El toggle **Páginas/Scroll** (pestaña Ajustes del lector) ya funciona en PDF, no solo en EPUB. Ver
[`DECISIONS.md`](DECISIONS.md) · ADR-017.

- **Render por-wrapper con `data-page`** común a ambos modos (`renderInto`): en paginado se reutiliza un
  wrapper; en scroll se apilan todas las páginas. Conserva PDF3 (los subrayados se anclan y re-pintan
  por página).
- **Scroll con render perezoso:** un `IntersectionObserver` pinta solo las páginas cercanas al viewport
  y **libera** las lejanas (canvas a 0, capas limpias) → memoria acotada. Verificado sobre un PDF de 355
  páginas: ~2-3 canvas vivos a la vez. La página actual se deriva de la posición de scroll.
- **Modo recordado por libro** (`Storage` por fingerprint), como en EPUB. Navegación (`prev/next/goTo`,
  barra de progreso) unificada: en scroll desplaza, en paginado re-renderiza.
- **Robustez:** la cancelación del `RenderTask` pasa a ser **por wrapper** (varios renders en vuelo en
  scroll no chocan). Test: [`tests/pdf.spec.ts`](tests/pdf.spec.ts). Sin archivos nuevos → sin bump de `sw.js`.

## 2026-07-03 — PDF3: subrayados/anotaciones en PDF

Subrayar en un PDF ahora funciona como en el EPUB: seleccionar → color/nota, se pinta sobre la página,
se guarda y se re-pinta al volver. Ver [`DECISIONS.md`](DECISIONS.md) · ADR-016.

- **Modelo de ancla `{página, rects}`** en [`highlights.js`](js/highlights.js) (`addPdf`, `getByPage`,
  `removeById`), conviviendo con el modelo CFI del EPUB (identidad genérica `id ?? cfi`). Los `rects`
  se guardan en **coordenadas fraccionales (0..1)** de la página, así se re-pintan nítidos a cualquier
  escala/HiDPI (el canvas se re-renderiza al cambiar de zoom/página).
- **Overlay `.pdf-hl-layer`** (multiply, `pointer-events:none`) sobre el canvas; se re-pinta en cada
  `onPage` y al crear/borrar. La lista lateral y el borrado se generalizan a PDF (navegan a la página).
- La barra de selección del PDF recupera Subrayar y Nota (PDF2 solo dejaba Preguntar/Copiar).
- **Robustez:** `renderPage` cancela el `RenderTask` en curso antes de empezar otro → se elimina el
  crash *"Cannot use the same canvas during multiple render()"* al pasar páginas rápido (lo destapó el
  test de aislamiento sobre PDF real).
- Tests: [`tests/pdf.spec.ts`](tests/pdf.spec.ts) (subrayar → overlay → persistir → re-pintar).
  Sin archivos nuevos → sin bump de `sw.js`.

## 2026-07-03 — PDF2: selección→agente en PDF

Seleccionar texto en un PDF ahora ofrece **"Preguntar al agente"** (y "Copiar"), reutilizando la misma
barra de selección del EPUB.

- **`setupPdfSelection()` en [`highlights-ui.js`](js/highlights-ui.js):** escucha `mouseup`/`touchend`
  sobre `#pdf-container`; si la selección cae en la capa de texto del PDF, muestra `#highlight-tooltip`
  en **modo PDF**. La capa de texto vive en el documento padre (sin iframe), así que se usa
  `window.getSelection()` directo.
- **Modo PDF del tooltip:** se ocultan Subrayar (colores) y Nota —dependen del ancla CFI del EPUB— y se
  dejan solo "Preguntar al agente" (`AiPanel.quoteSelection`) y "Copiar". El subrayado real llega en PDF3.
- Refactor: posicionamiento del tooltip extraído a `positionTooltip()` (compartido EPUB/PDF); la
  selección nativa del PDF se limpia al ocultar la barra.
- Cableado en `loadPdf`. Test: [`tests/pdf.spec.ts`](tests/pdf.spec.ts) (selección → barra en modo PDF →
  abre el panel). Sin archivos nuevos → sin bump de `sw.js`.

## 2026-07-03 — PDF1: el agente lee PDFs (mismo pipeline de retrieval)

El salto de "visor de PDF" a "BookReader con PDF": el agente lee los PDF con **el mismo motor** que
los EPUB (BM25 + router + sentence-window + agéntico). Ver [`DECISIONS.md`](DECISIONS.md) · ADR-015.

- **`js/ai/segment-pdf.js` (nuevo):** recorre el PDF con `getTextContent()` por página y produce el
  mismo "libro anotado" que el EPUB (`## capítulo` + `[[aN]] texto`), pero con **locator de página**.
  Trocea en pasajes de ~400 caracteres cortando en fin de frase.
- **Capítulos por `getOutline()`:** solo el **nivel superior abre capítulo**; las subsecciones son
  marcadores `##` que heredan el padre (mismo criterio que el TOC del EPUB → evita el bug de
  atribución "capítulo 9"). Verificado sobre un PDF real (Albada: 355 pág → 13 capítulos, 1505 pasajes).
- **PDF escaneado:** se detecta por la media de caracteres/página; si no hay texto seleccionable se
  avisa y no se indexa (sin OCR).
- **De-hyphenation:** une los guiones de corte de línea (`over-\nall` → `overall`).
- **Citas navegables en PDF:** al pulsar `[[aN]]`, `onCite` salta a la página con `PdfReader.goTo`.
- **Cableado:** `AiPanel.setBook(doc, id, title, {format:'pdf'})` ramifica el segmentador sin tocar el
  camino EPUB; `loadPdf` habilita el panel del agente y `PdfReader.getDocument()` expone el documento.
- Tests deterministas: [`tests/segment-pdf.spec.ts`](tests/segment-pdf.spec.ts) (atribución, herencia
  de subsección, escaneado, de-hyphenation). `sw.js` v47→v48 (nuevo módulo en el precache).

## 2026-07-03 — TEC1: revisión del lector PDF (arranca el track PDF)

Prerrequisito de la épica PDF. El visor pasa de **0 cobertura E2E** a tener tests con fixture propia
([`tests/pdf.spec.ts`](tests/pdf.spec.ts), `tests/test.pdf`).

- **Bug crítico del ArrayBuffer *detached* (pérdida de datos):** pdf.js **transfiere** (detacha) el
  buffer que le pasas a `getDocument`; luego `persistToLibrary` hacía `buffer.slice(0)` sobre el buffer
  ya detached → excepción → **el PDF no se guardaba en la biblioteca**. Fix: `PdfReader.load`
  ([`pdf-reader.js`](js/pdf-reader.js)) clona el buffer antes de `getDocument`, dejando intacto el del
  llamador. Verificado con un test que **falla sin el fix**.
- **Nitidez HiDPI/retina:** el canvas se pinta a `scale · devicePixelRatio` (píxeles reales) y se muestra
  al tamaño lógico vía CSS; antes salía borroso en pantallas 2×. Test con `deviceScaleFactor:2`.
- **Limpieza:** `onProgress` de `load()` (antes muerto) cableado al `loadingTask`; catch del `destroy`
  con `warn`. La navegación por teclado/botones/barra ya estaba cableada para PDF.

34/34 E2E. Bump `sw.js` v46→v47. Con TEC1 cerrado, siguiente en la épica: **PDF1** (IA/agente sobre PDF).

---

## 2026-07-03 — TEC2: tests deterministas del panel IA (+ fix de gating)

El panel IA solo tenía cobertura `@live` (no determinista). Se añaden tests deterministas que fijan su
comportamiento como red de regresión — y escribirlos **destapó un bug** que se corrige.

- **[`tests/panel.spec.ts`](tests/panel.spec.ts)** (integración con `fetch` stubbeado): onboarding →
  sesión lista; envío → respuesta pintada; y el **gating del retrieval agéntico** (Fase 1b): una pregunta
  con buen match léxico NO dispara herramientas; una pregunta vaga (sin match) SÍ activa `search_book`.
- **[`tests/render.spec.ts`](tests/render.spec.ts)** (unit): `renderWithCitations` solo convierte en chip
  las anclas que existen (no inventa citas).
- **Fix de gating** ([`panel.js`](js/ai/panel.js)): la recolección agéntica se gateaba con `picked>0`, así
  que el retrieval **vacío** (0 aciertos) —el caso más débil, donde el agente MÁS debe buscar— no la
  disparaba. Ahora se gatea con `segReady` (libro indexado). Lo detectó el test de la pregunta vaga.

31/31 E2E. Bump `sw.js` v45→v46. Cierra TEC2 del backlog.

---

## 2026-07-03 — IA2: interrupción de repaso al terminar capítulo

Con la plantilla **HQ&A** activa, al entrar en un capítulo nuevo el agente **interrumpe** con una
pregunta de recuerdo activo sobre el capítulo recién terminado (sin dar la respuesta — la escribe el
lector). Diseño y alternativas en [`DECISIONS.md`](DECISIONS.md) · ADR-013.

- **Disparador** ([`epub-reader.js`](js/epub-reader.js)): evento `reader:chapter-changed` emitido **solo
  en cambio real** de capítulo (no en cada render).
- **Repaso** ([`panel.js`](js/ai/panel.js)): gateado por plantilla HQ&A + key + no-ocupado; una pregunta
  por capítulo, solo hacia delante (no al volver atrás). Respeta INFO/COGNICIÓN (no responde).
- Test de emisión del evento en [`tests/chapter-event.spec.ts`](tests/chapter-event.spec.ts). 27/27 E2E.
  Bump `sw.js` v44→v45.

Cierra la sección **IA / Agente** del backlog salvo lo aplazado por decisión: IA5 Fase 2 (embeddings,
[ADR-014](DECISIONS.md)) e IA1 Fase 3 (resumen rodante, bajo ROI, [ADR-010](DECISIONS.md)).

---

## 2026-07-03 — IA5 Fase 3: sentence-window + evaluación (recall@k)

- **Sentence-window** ([`retrieval.js`](js/ai/retrieval.js) `withNeighbors`, ADR-011): cada acierto BM25
  arrastra sus **vecinos inmediatos** en orden de lectura (mismo capítulo) antes del empaquetado, para
  que el modelo lea contexto coherente alrededor de cada pasaje en vez de fragmentos sueltos. `buildIndex`
  guarda un mapa de posiciones; radio 1.
- **Evaluación recall@k** ([`tests/retrieval.spec.ts`](tests/retrieval.spec.ts), ADR-012): arné mínimo
  con conjunto dorado (pregunta → pasaje esperado) y la métrica recall@k como **suelo de regresión**
  (hoy sobre corpus sintético; ampliable a libros reales con la Fase 2). recall@3 = 1 en el corpus actual.

26/26 E2E. Bump `sw.js` v43→v44. Con esto IA5 queda en Fase 1a+1b+3; pendiente Fase 2 (embeddings, solo
con proveedor que exponga `/embeddings`).

---

## 2026-07-03 — IA5 Fase 1b: retrieval agéntico (herramientas)

El agente puede ahora **reunir contexto por sí mismo** con herramientas cuando el retrieval por pregunta
es débil. Diseño y razonamiento en [`DECISIONS.md`](DECISIONS.md) · ADR-009.

- **`chatToolsLoop`** ([`llm.js`](js/ai/llm.js)) — bucle multi-turno de tool-use (no-streaming, fiable en
  BYOK): ejecuta las herramientas vía callback preservando `tool_call_id`, hasta que el modelo deja de
  pedirlas o se agotan las rondas (la última fuerza `tool_choice:'none'`).
- **Herramientas** ([`panel.js`](js/ai/panel.js)): `search_book(query)` (BM25 en todo el libro) y
  `read_chapter(nº|título)` (pasajes de un capítulo). Ejecutor local que acumula los pasajes hallados.
- **Gateado + streaming preservado:** la recolección agéntica **solo** corre en turnos difíciles (sin
  capítulo nombrado por el router y con pocos aciertos BM25). Los turnos normales van directos a
  streaming. Tras recolectar, se **fusiona** con el contexto inicial y se **streamea** la respuesta.
  Degrada con gracia: si la recolección falla, responde con el contexto inicial.

24/24 E2E (nuevo test del bucle de herramientas en [`tests/llm.spec.ts`](tests/llm.spec.ts)). Bump
`sw.js` v42→v43. Cierra IA5 Fase 1a+1b; quedan Fase 2 (embeddings) y Fase 3 (eval) en el BACKLOG.

---

## 2026-07-03 — IA/Agente: robustez + decisiones documentadas (ADR)

Lote de la sección IA del backlog, con el _porqué_ de cada decisión documentado en el nuevo
[`DECISIONS.md`](DECISIONS.md) (ADR ligero, enlazado desde `AGENTS.md`).

- **DECISIONS.md** — registro de decisiones del agente (ADR-001…010): retrieval por pasaje, por
  pregunta, BM25-antes-de-embeddings, router de capítulo, grounding honesto, atribución por TOC,
  presupuesto adaptativo, reintentos, retrieval agéntico (diferido) y ventana de historial. El objetivo
  es no re-litigar decisiones ni perder el razonamiento que llevó a ellas.

- **IA3 — Reintentos con backoff** ([`llm.js`](js/ai/llm.js), ADR-008). `fetchRetrying` reintenta ante
  red caída y estados transitorios (408/425/429/5xx) con backoff exponencial + jitter, honrando
  `Retry-After`. Respeta `AbortSignal` y reintenta ANTES de consumir el stream (no re-emite tokens).
  Usado por `chatStream` y `chatTools`. Helpers puros testados en [`tests/llm.spec.ts`](tests/llm.spec.ts)
  (+ test funcional: 503 ×2 → éxito).

- **Presupuesto de contexto adaptativo** ([`panel.js`](js/ai/panel.js), ADR-007). Turnos normales van
  lean (60k, baratos); si el usuario NOMBRA un capítulo (intención de leerlo entero), el margen sube a
  ~110k para que quepa completo, sin encarecer cada pregunta. Guard de tokens subido a 180k.

23/23 E2E. Bump `sw.js` v41→v42. Pendiente en la sección IA (siguiente lote): IA5 Fase 1b (retrieval
agéntico, ADR-009), Fase 2 (embeddings), IA2 (interrupción), IA1 Fase 3 (resumen rodante).

---

## 2026-07-03 — IA5 Fase 1a (fix): la atribución de capítulo por pasaje era errónea

**Síntoma.** Tras desplegar IA5, el agente seguía diciendo que no tenía el Capítulo 9 (pese al prompt
honesto ya activo). Reproducido con el EPUB real de DDIA.

**Causa.** `segment.js` emite un marcador `## ` por CADA encabezado (H1–H6), no solo por capítulo.
`parsePassages` trataba todos como frontera de capítulo, así que los pasajes del Cap. 9 quedaban
atribuidos a sus SUBTÍTULOS ("Linearizability", "Total Order Broadcast"…) y
`passagesByChapter("9. Consistency and Consensus")` devolvía casi nada → el router no aportaba el
capítulo y, como "capítulo 9" no tiene palabras de contenido, BM25 tampoco.

**Fix.** ([`js/ai/retrieval.js`](js/ai/retrieval.js)) `parsePassages` recibe ahora `tocLabels` y solo
ABRE capítulo cuando la etiqueta está en el TOC (los subtítulos heredan el capítulo en curso), igual
que hace `context.js`. Además: `passagesByChapter` con matching tolerante (por número o núcleo del
título) y una expansión de query — al nombrar un capítulo se busca también por su TÍTULO en BM25, para
recuperar su contenido por tema aunque la etiqueta variara.

**Verificado.** Sobre el DDIA real, "flashcards del capítulo 9" ahora mete **543 pasajes del Cap. 9**
en el contexto (Linearizability, consenso, Paxos/Raft/2PC) — antes, un puñado. Nuevo test determinista
[`tests/retrieval.spec.ts`](tests/retrieval.spec.ts) que fija la atribución por TOC y el router. 21/21
E2E. Bump `sw.js` v40→v41.

---

## 2026-07-02 — Fix (definitivo): la posición se perdía al girar el móvil

**Síntoma.** Al rotar horizontal↔vertical, el libro "caminaba hacia atrás" varias páginas. Fixes
previos lo mitigaron con una ventana temporal de 800 ms que ignoraba las `relocated` del re-anclaje,
pero en móviles lentos el reflow asienta MÁS TARDE: un `relocated` que llega pasado ese margen reporta
el inicio de página y arrastraba la posición atrás, giro tras giro. **Reproducido** con Playwright
(emitiendo un `relocated` tardío tras el giro: `…/20/1:175` → `…/2/1:0`).

**Fix.** Se sustituye la supresión por TIEMPO por un **PIN de posición** en
[`js/epub-reader.js`](js/epub-reader.js): al empezar un giro se fija el CFI real y, mientras el pin
esté puesto, el handler `relocated` NO mueve `currentCfi` (ni el `rendered`). El pin se libera solo
cuando el usuario NAVEGA de verdad (`next`/`prev`/`goTo` y el swipe) — en paginado, entre giros la
posición no cambia por ninguna otra vía. Al ser un estado (no un plazo fijo), es inmune a la latencia
del dispositivo. El cambio de modo de lectura usa el mismo pin.

**Verificado.** Nuevo test en [`tests/rotate.spec.ts`](tests/rotate.spec.ts) que asserta la POSICIÓN
(no solo dimensiones): 4 giros seguidos la conservan, un `relocated` tardío no la mueve, y la
navegación tras girar sigue avanzando (el pin no la congela). 20/20 E2E. Bump `sw.js` v39→v40.

---

## 2026-07-02 — IA5 Fase 1a: retrieval por pregunta a nivel de pasaje (RAG)

**Motivación (caso real).** Con *Designing Data-Intensive Applications* y el objetivo "System Design para
entrevistas MAANG", el agente negó tener el Capítulo 9 y pidió al usuario que se lo pegara — cuando ese
capítulo tenía la relevancia MÁS ALTA del libro (0.95, verificado en backup). Lo expulsó el recorte por
objetivo/capítulo de IA1: ciego a la pregunta, con granularidad de capítulo y empaquetado codicioso que
descarta un capítulo grande y relevante en favor de otros más pequeños.

**Qué se hizo.** Nuevo módulo [`js/ai/retrieval.js`](js/ai/retrieval.js): índice **BM25** en el navegador
sobre los pasajes `[[aN]]` que ya produce [`segment.js`](js/ai/segment.js) (cero API, cero coste, sirve a
cualquier proveedor BYOK). En cada turno, `buildContext(question)` en [`js/ai/panel.js`](js/ai/panel.js)
recupera **por pregunta y a nivel de pasaje** con esta prioridad hasta el presupuesto: (1) capítulos que la
pregunta NOMBRA explícitamente (router determinista por número/título — "capítulo 9" / "chapter 9" / el
título), (2) mejores pasajes BM25 de TODO el libro, (3) capítulo donde está el lector; luego reordena en
orden de lectura. Sustituye a `selectContext` (IA1) en el `send()`.

El **system prompt** ([`js/ai/panel-template.js`](js/ai/panel-template.js)) ahora recibe el **mapa del
libro** (TOC completo) y se le dice que el texto es un EXTRACTO recuperado (no el libro entero): si le
falta un capítulo, que lo diga y sugiera abrirlo/nombrarlo — **nunca** pedir que peguen texto, porque el
libro completo ya está en la app.

**Verificado.** Test de escenario DDIA: "flashcards del capítulo 9" ahora incluye los pasajes del cap. 9
(router) más los de consenso (BM25). 19/19 E2E; `retrieval.js` carga sin errores de consola. Bump
`sw.js` v38→v39.

Pendiente en IA5: Fase 1b (retrieval como herramienta agéntica `search_book`/`read_chapter`), Fase 2
(embeddings híbridos), Fase 3 (sentence-window + evaluación recall@k). Ver [`BACKLOG.md`](BACKLOG.md).

---

## 2026-07-02 — Fix: las sidebars de lectura se veían sobre la biblioteca

Al volver a la estantería con el índice o el panel del agente abiertos, esos paneles seguían visibles
por encima de la biblioteca (van en z-index alto).

**Qué se hizo**: `goToLibrary()` ([`js/app.js`](js/app.js)) ahora cierra ambas sidebars al entrar en la
biblioteca (`#sidebar.open` y `AiPanel.setOpen(false)`), y un respaldo en CSS
([`css/main.css`](css/main.css)) las mantiene fuera de pantalla en `body.in-library` (el id gana en
especificidad a `.open`/`.ai-open`).

Sin bump de `sw.js`. Verificado con Playwright (abrir ambas sidebars leyendo → ir a biblioteca: quedan
cerradas y fuera de pantalla) y 19/19 E2E.

---

## 2026-07-02 — URLs tipo Play Books (deep-links a libro + posición)

La URL refleja ahora **qué libro** y **en qué posición** estás: `#book=<id>&loc=<cfi|página>`. Recargar
o relanzar la PWA reabre el libro donde ibas, y el enlace sirve de marcador.

**Diferencia con Play Books**: allí el libro vive en servidores; aquí vive en IndexedDB (local). Por eso
los deep-links funcionan **en este navegador**: si el `id` no está en tu biblioteca, se avisa y se abre
la biblioteca. Compartir entre dispositivos exigiría alojar los libros (fuera de alcance).

**Qué se hizo** (todo en [`js/app.js`](js/app.js), sin archivos nuevos):
- Router por hash: `parseRoute` / `writeRoute` (push vs replace) / `applyRoute` / `seekTo`. `id` =
  hash de contenido del libro (`record.id`); `loc` = CFI (epub, URL-encoded) o página (pdf).
- Abrir un libro (biblioteca o archivo) hace `pushState` (atrás → biblioteca). La posición se
  actualiza mientras lees con `replaceState` (no ensucia el historial), enganchado a los callbacks de
  progreso ya existentes (`onProgress`/`onPage`).
- Al arrancar, `applyRoute()` resuelve la URL: abre el libro del enlace o muestra la biblioteca. En
  `popstate`/`hashchange` reconcilia estado ↔ URL (mismo libro → solo salta de posición; otro →
  abre; sin `id` → biblioteca; `id` inexistente → aviso + biblioteca).
- Refactor menor: `openLibraryBook` → `openBookRecord(record, { fromRoute, loc })`; `goToLibrary`
  acepta `{ fromRoute }` y limpia `currentBook`.

Sin bump de `sw.js`. Verificado con Playwright (la URL refleja libro+posición y se actualiza con
replaceState sin crecer el historial; recargar restaura la posición exacta; atrás→biblioteca,
adelante→reabre; `id` inexistente→aviso+biblioteca; 0 errores de consola) y 19/19 E2E.

---

## 2026-07-02 — Fixes: pestañas de la sidebar al estrechar + objetivo de la libreta

Dos ajustes visuales tras hacer las sidebars redimensionables:
- **Pestañas de la sidebar** ([`css/main.css`](css/main.css)): al estrechar la sidebar, la fila
  «Contenido · Marcadores · Subrayados · Ajustes» se salía por el borde. Ahora `flex-wrap: wrap` +
  `.tab-btn { flex: 1 0 auto; white-space: nowrap }`: las pestañas pasan a 2 filas en vez de
  desbordarse, cada etiqueta entera.
- **Objetivo en la libreta** ([`js/ai/panel.js`](js/ai/panel.js), [`css/main.css`](css/main.css)): la
  etiqueta «Objetivo» quedaba pegada al valor («Objetivotest») porque una regla agrupada la ponía en
  `inline-flex`. El valor va ahora en su propio `.ai-nb-goal-value` y `.ai-nb-goal` es columna
  (etiqueta arriba, valor debajo).

Sin bump de `sw.js`. Verificado con Playwright (a 240px las 4 pestañas en 2 filas sin desbordar; el
objetivo apilado y legible; 0 errores de consola) y 19/19 E2E.

---

## 2026-07-02 — Fix: los bordes con `var(--border)` desaparecían en tema claro

Las sidebars (índice y agente) no mostraban su borde separador en tema claro (y sistema-claro).

**Causa** ([`css/themes.css`](css/themes.css)): en el bloque de alias del `:root` había
`--border: var(--border);` — una **autorreferencia cíclica**. Eso deja `--border` **inválido** en el
tema claro, así que **cualquier** `border: … var(--border)` computa a ancho 0 (y color `currentColor`).
No afectaba solo a las sidebars: era un bug latente en todos los bordes que usan `var(--border)` en
claro (los headers se salvaban porque usan `var(--border-soft)`, que sí es válido).

**Qué se hizo**: eliminar esa línea espuria; el valor real de `--border` ya está definido antes en el
mismo `:root` (`#d1d1d6`). Con eso vuelven los bordes en toda la app.

Sin bump de `sw.js`. Verificado con Playwright (en claro `--border` = `#d1d1d6` y las tres superficies
—`.sidebar`, `.sidebar-header`, `#ai-panel`— con borde de 1px; en oscuro `#38383a`, intactos) y 19/19 E2E.

---

## 2026-07-02 — Paneles redimensionables + cabeceras alineadas

Las dos sidebars (índice y agente) ahora se pueden **redimensionar** en escritorio, útil para leer
técnico con el chat abierto al lado y ajustar cuánto sitio le das a cada uno.

**Qué se hizo**:
- [`js/app.js`](js/app.js): `initPanelResize()` añade un tirador (`.panel-resizer`) en el borde interior
  de cada panel. Arrastrar actualiza la variable CSS de anchura (`--ai-panel-width` / `--sidebar-width`);
  como el margen del lector usa esa misma variable, el texto **reflowea** en vivo (acompasado a rAF). La
  anchura se **persiste** (preferencia global de UI) con límites (agente 320–760px/60vw, índice
  240–560px/50vw). Captura de puntero para arrastrar aunque el cursor pase sobre el iframe. Doble clic en
  el tirador restablece el ancho por defecto.
- [`css/main.css`](css/main.css): estilo del tirador (`col-resize`, línea acento al hover/arrastre); solo
  escritorio (oculto en ≤1023px, donde los paneles son drawers). Durante el arrastre se desactiva la
  transición de márgenes y la selección de texto.
- **Cabeceras alineadas**: la del índice y la del agente usaban `padding` sin altura fija (~44px) y no
  cuadraban con la del lector (52px). Ahora las tres usan `height: var(--header-height)`, así el borde
  inferior queda a la misma altura.

Solo escritorio (en móvil los paneles siguen como drawers/bottom sheet). Sin bump de `sw.js`. Verificado
con Playwright (las 3 cabeceras a 52px con el borde alineado; ambos paneles crecen al arrastrar con el
margen del lector siguiéndolos; anchura persistida; 0 errores de consola) y 19/19 E2E.

---

## 2026-07-02 — Lectura: modo scroll continuo (mejor para libros técnicos)

Nuevo **modo de lectura scroll** conmutable (Ajustes → Modo de lectura: Páginas / Scroll), además del
paginado. En scroll se recorre todo el capítulo de un tirón — mejor para técnico (code blocks, tablas,
figuras sin cortes de página). Se **recuerda por libro** (`readingMode_<book.key()>`, como la posición
y los marcadores); default Páginas.

**Qué se hizo**:
- [`js/epub-reader.js`](js/epub-reader.js): `getReadingMode`/`setReadingMode`/`applyReadingMode`. El
  cambio es **en caliente** con `rendition.flow('scrolled-doc'|'paginated')` (epub.js 0.3.93): se
  conserva el rendition, sus listeners y los subrayados; se re-ancla al CFI actual. La rendition se crea
  ya con el flujo guardado del libro. El swipe horizontal y la escala móvil (`updateReaderScale`) se
  desactivan en scroll (mandan el desplazamiento vertical nativo).
- [`js/app.js`](js/app.js): cableado del toggle Páginas/Scroll, reflejo del modo al abrir el libro, y
  redibujo de subrayados al cambiar de flujo (`reader:flow-changed`).
- [`index.html`](index.html): grupo "Modo de lectura" en Ajustes.
- [`css/main.css`](css/main.css): control segmentado; en scroll el viewport alinea arriba y, con barras
  overlay visibles (móvil no inmersivo), reserva su alto para no ocultar la primera/última línea.

Solo afecta al EPUB (en PDF es no-op). Sin bump de `sw.js`. Verificado con Playwright (el flujo cambia
paginated→scrolled-doc→paginated en caliente, posición conservada, persistencia por libro, 0 errores de
consola) y 19/19 E2E.

**Corrección (mismo día):** el scroll no se movía en escritorio. Causa: las reglas
`.epub-container > div` y `.epub-container .epub-view` con `height: 100% !important` (necesarias en
paginado para llenar el viewport) aplastaban la vista a la altura del viewport, así que el contenedor
scrollable de epub.js no tenía nada que desplazar. Se gatean a `body:not(.scroll-mode)`; en scroll la
vista conserva su altura de contenido. Verificado que la rueda del ratón desplaza de verdad
(scrollHeight 1229 > 596, scrollTop responde).

---

## 2026-07-02 — Plantillas: 5 por objetivo + onboarding de una pregunta (fase 2)

Consolidación de **6 plantillas en 2 bloques (técnico/humanista)** → **5 plantillas por objetivo**
(T1–T5), con un onboarding de **una sola pregunta**: «¿Qué quieres conseguir con este libro?».

**Qué se hizo**:
- [`js/ai/templates.js`](js/ai/templates.js): nuevo array T1–T5 (Extracción para Proyectos · HQ&A ·
  Juicio Analítico · Sabiduría Aplicada [fusión de biografías + filosofía] · Lectura Inmersiva), cada
  campo con su `fill`. El **Artesano** se conserva como modo opt-in (no como objetivo). Nuevo
  `objectiveTemplates()`; `objective` por plantilla para el onboarding.
- [`js/ai/panel.js`](js/ai/panel.js): onboarding de un paso (`renderObjectives`) en vez de bloque →
  plantilla → meta; casilla **«Leo para aprender a escribir (modo Artesano)»** solo en la Lectura
  Inmersiva; T5 no exige objetivo (es lectura por placer). Degradación elegante: una conversación con
  una plantilla ya inexistente no rompe, muestra un aviso para elegir un objetivo nuevo.
- [`css/main.css`](css/main.css): estilos de la casilla Artesano y del aviso de conversación huérfana.
- [`tests/ai.spec.ts`](tests/ai.spec.ts): flujo `@live` actualizado al onboarding de una pregunta.

**Datos**: borrón y cuenta nueva — solo existen T1–T5; las conversaciones antiguas no rompen la app
(degradación elegante), pero su libreta con la plantilla vieja ya no se renderiza.

Sin bump de `sw.js`. Verificado con Playwright (5 objetivos en un paso, opt-in Artesano solo en T5,
la libreta pasa al Artesano al marcarlo, distintivos INFO/COGNICIÓN visibles, 0 errores de consola) y
19/19 E2E.

---

## 2026-07-02 — Agente: distinción INFO / COGNICIÓN en la libreta (fase 1)

Principio rector: el agente debe **ayudar a aprender, no sustituir el aprendizaje**. Hasta ahora el
auto-relleno de la libreta y el flujo HQ&A escribían **todos** los campos, incluidos los que dan
retención solo si los generas tú (la «Answer», el «espejo», el «experimento»).

**Modelo de datos**: cada campo de plantilla gana `fill: 'agent' | 'user'` — INFO (lo rellena la IA)
vs COGNICIÓN (lo genera el usuario). Un campo sin `fill` se trata como `'agent'` (compatibilidad).

**Qué se hizo**:
- [`js/ai/templates.js`](js/ai/templates.js): `fill` en las 6 plantillas (cognición = Answer, espejo,
  experimento(s), juicio, «¿y qué?», plan de acción, problema/artefacto) + helpers `agentFields`,
  `isAgentFillable`, `isCognitionField`.
- [`js/ai/panel.js`](js/ai/panel.js): `notebookTool` y `extractToNotebook` solo operan sobre campos
  INFO (la IA ni siquiera puede dirigirse a los de cognición); `generateHQA` genera solo la Pregunta y
  deja la Respuesta para el usuario; la libreta marca cada campo con «IA» o «tú» y añade microcopy en
  los de cognición.
- [`js/ai/panel-template.js`](js/ai/panel-template.js): el `systemPrompt` separa campos INFO de
  COGNICIÓN e instruye al agente a **no escribir** los de cognición (pregunta socrática + revisión).
- [`js/ai/custom-templates.js`](js/ai/custom-templates.js) + [`js/ui/app-settings.js`](js/ui/app-settings.js):
  el editor de plantillas propias permite marcar cada campo como IA (info) o Tú (cognición).
- [`css/main.css`](css/main.css): distintivo INFO/COGNICIÓN y microcopy.

Sin bump de `sw.js`. Verificado con Playwright (la IA no puede rellenar campos de cognición; el
`systemPrompt` los lista aparte con la instrucción de no escribirlos) y 19/19 E2E.

---

## 2026-07-02 — Marcadores: muestran el número de página

Cada marcador de la sidebar muestra ahora **«Pág. X / Y»** (misma numeración que la barra de progreso,
por localizaciones de epub.js).

**Qué se hizo**:
- [`js/epub-reader.js`](js/epub-reader.js): nuevo `getPageInfo(cfi)` → `{ page, total }` desde un CFI
  (`locations.locationFromCfi`, con estimación por porcentaje si no hay índice directo).
- [`js/bookmarks.js`](js/bookmarks.js): se guarda `page`/`total` al crear el marcador.
- [`js/bookmarks-ui.js`](js/bookmarks-ui.js): se muestra la página; para marcadores antiguos sin ella se
  calcula al vuelo desde el CFI.
- [`css/main.css`](css/main.css): estilo `.bookmark-page`.

Sin bump de `sw.js`. Verificado con Playwright (la página del marcador coincide con la barra de
progreso) y 19/19 E2E.

---

## 2026-07-02 — Agente: descubrir modelos falla en nan (CORS) → modo manual claro

«Descubrir» (Ajustes → Agente) no listaba modelos con el proveedor **nan**.

**Causa**: el endpoint `GET /models` de nan **no envía cabeceras CORS** (a diferencia de
`/chat/completions`, que sí trae `access-control-allow-origin: *`). El navegador hace preflight por la
cabecera `Authorization`, no encuentra `Access-Control-Allow-Origin` y **bloquea** la petición. No es
arreglable desde el cliente: depende del servidor del proveedor.

**Qué se hizo**:
- [`js/ai/llm.js`](js/ai/llm.js): `listModels` distingue el fallo de red/CORS (marca `err.cors`) y el
  401/403 (key inválida) de un error genérico, con mensajes específicos.
- [`js/ui/app-settings.js`](js/ui/app-settings.js): al fallar el descubrimiento se explica que ese
  proveedor no lo permite desde el navegador y se **guía al modo manual** (mensaje en rojo, se
  reponen los chips sugeridos y se enfoca el campo de modelo). Ayuda **siempre visible** bajo el campo:
  se puede escribir el id del modelo a mano o elegir un sugerido.
- [`css/main.css`](css/main.css): estilo del hint de error y del texto de ayuda.

Sin bump de `sw.js`. Verificado con Playwright (discovery abortado → mensaje de modo manual + chips
sugeridos; escribir un modelo a mano y guardar lo persiste) y 19/19 E2E.

---

## 2026-07-02 — Móvil: al girar la pantalla ya no salta de página

Al cambiar entre vertical y horizontal, a veces la lectura **saltaba varias páginas atrás**.

**Causa** ([`js/epub-reader.js`](js/epub-reader.js)): en modo paginado, `rendition.resize()` re-pagina
pero epub.js conserva el *offset visual*, no la posición; a otro ancho ese mismo offset cae en otro
punto del texto. Además, un giro real dispara una **ráfaga** de eventos `resize`/`orientationchange`
(animación + barra del navegador), y cada reflow intermedio dejaba `currentCfi` ya derivado, por lo que
la deriva se **acumulaba** giro a giro.

**Qué se hizo**: fijamos el CFI al **inicio** de la ráfaga (`resizeAnchor`) y, cuando se estabiliza el
tamaño (debounce 250 ms), re-anclamos con `rendition.display(anchor)` a esa posición original. Así el
texto se re-pagina para el nuevo ancho pero te quedas donde estabas.

Faltaba un detalle clave del arrastre: `display(anchor)` muestra la página que contiene el ancla, pero
su `relocated` reporta el **inicio de esa página** (antes del ancla), y ese evento llega *después* de
que resuelve `display`. Si lo dejábamos sobrescribir `currentCfi`, cada giro partía de una posición ya
retrasada y la lectura **caminaba hacia atrás** giro tras giro. Se silencian esas relocations con una
**ventana temporal** (`suppressRelocateUntil`, 800 ms) y se fija `currentCfi` al ancla.

Sin bump de `sw.js`. Verificado con Playwright: 6 giros seguidos mantienen la posición constante
(deriva 0; control sin arreglo: 33→31→30→29, arrastre acumulativo) y 19/19 E2E.

---

## 2026-07-01 — Móvil: el agente no abre el teclado al abrirlo

Al abrir el panel del agente (o al llegar al paso de objetivo del onboarding) se auto-enfocaba el campo
de texto, y en móvil eso **abría el teclado** sin que el usuario lo pidiera.

**Qué se hizo** ([`js/ai/panel.js`](js/ai/panel.js)): nuevo `focusInput()` que solo enfoca en punteros
**no táctiles**; aplicado en `setOpen` (abrir panel), `setRef` (adjuntar cita) y el textarea de objetivo
del onboarding. En móvil el teclado sale solo al tocar el campo para escribir; en escritorio, sin cambios.

Sin bump de `sw.js`. Verificado con Playwright (escritorio: se enfoca objetivo e input; móvil: no se
enfoca ninguno) y 19/19 E2E.

---

## 2026-07-01 — Móvil: barras que encogen el texto en vez de taparlo (estilo Play Books)

En móvil, con las barras visibles (no inmersivo), el overlay **tapaba las primeras/últimas líneas**. En
escritorio se resolvió con barras en flujo, pero en móvil eso re-paginaría en cada toque (y el usuario
pierde por dónde iba). Solución fiel a Play Books: **al mostrar las barras, el texto se ENCOGE para
caber** (misma página, mismas palabras) en vez de taparse o reflujar.

**Qué se hizo** ([`js/epub-reader.js`](js/epub-reader.js) `updateReaderScale`, [`js/app.js`](js/app.js),
[`css/main.css`](css/main.css)):
- **`updateReaderScale()`**: en móvil, cuando las barras están visibles, aplica un `transform: scale`
  (con `translateY` del alto de cabecera) al **`#reader-viewport`** para que la página quepa entre las
  barras. Al ser **solo transform**, epub.js **NO re-pagina** → el texto de la página no cambia y no se
  pierde la posición. Va en el viewport (ancestro), no en `#epub-container`, para no chocar con la
  animación de swipe. Se recalcula al alternar barras, al cargar y al rotar/redimensionar.
- **Por defecto sin barras en móvil:** al abrir un libro en punteros *coarse* se arranca en `immersive`
  (texto a pantalla completa). Tocar el centro las muestra (encogiendo) y vuelve a ocultarlas.
- Transición suave del encogido (solo `transform`, sin reflujo). Escritorio sin cambios (allí no aplica).

Sin bump de `sw.js`. Verificado con Playwright (contexto móvil *coarse*: por defecto `immersive` y sin
transform; tocar el centro → barras + `scale(0.88)` con `#epub-container` a **850px constante en todos
los estados = sin re-paginar**; volver a tocar → pantalla completa; 0 errores), capturas y 19/19 E2E.

---

## 2026-07-01 — Zoom en imágenes del libro (lightbox)

En libros técnicos (diagramas, tablas como imagen…) no se podía ampliar una figura, y menos en
inmersivo: tocar la imagen solo pasaba página o alternaba barras.

**Qué se hizo** (nuevo [`js/image-zoom.js`](js/image-zoom.js) + integración):
- **Tocar/clicar una imagen abre un lightbox** a pantalla completa. Zoom con **pinch** (táctil),
  **rueda** (escritorio) y **doble toque/clic** (alterna 1×↔2.5×); se **desplaza arrastrando** al estar
  ampliada; se cierra con la **✕**, **Escape** o tocando el fondo.
- **Detección del toque:** en móvil, un toque en la **zona central** sobre una `<img>` abre el zoom
  ([`js/touch-select.js`](js/touch-select.js)); los toques en los bordes siguen pasando página (para
  páginas que son una imagen a sangre completa). En escritorio, clic sobre la imagen
  ([`js/epub-reader.js`](js/epub-reader.js) `registerTapHandler`). Nuevo `EpubReader.onImageTap`.
- La imagen del iframe de lectura es same-origin (el lector le inyecta estilos), así que el lightbox
  reutiliza su `src` (blob:) directamente.

`sw.js` → **v38** (nuevo fichero en el precache). Verificado con Playwright (clic en la portada → abre
el lightbox; doble clic → 2.5×; rueda → reduce; doble clic → 1×; ✕ → cierra; 0 errores), captura visual
y 19/19 E2E.

**Fix móvil (mismo día):** en táctil el visor abría y se cerraba solo. Dos causas de los eventos
sintéticos del toque: (1) el **click "fantasma"** ~300 ms tras el toque caía en el fondo (imagen aún
sin cargar) y cerraba el visor → se ignora un breve margen tras abrir (`openedAt`); (2) el **dblclick
fantasma** del doble-toque deshacía el zoom que ya había aplicado `onUp` → se ignora el `dblclick` si
viene justo tras un toque (`lastTouchUp`). Verificado en contexto móvil *coarse* (abre y se queda;
doble-toque → 2.5×; ✕ cierra; 0 errores).

---

## 2026-07-01 — Inmersivo en móvil: pantalla completa real + borde a borde

En móvil, el modo inmersivo solo ocultaba nuestras barras (CSS), no las del sistema: quedaban la
**barra de estado** arriba y franjas negras en el **recorte de cámara** (izquierda en landscape) y en
la **barra de gestos** (abajo).

**Qué se hizo** ([`js/app.js`](js/app.js) `initImmersive`, [`css/main.css`](css/main.css)):
- **Pantalla completa nativa desde el botón ⤢** (no desde el toque central). En móvil el botón de la
  cabecera alterna `requestFullscreen`/`exitFullscreen`, ocultando la barra de estado y la de gestos y
  dibujando de borde a borde (con `viewport-fit=cover`). El toque central sigue alternando solo las
  barras. `fullscreenchange` oculta/muestra las barras y sincroniza el icono ⤢/⤡, y salir a la
  biblioteca cierra el fullscreen. iOS Safari (sin Fullscreen API) mantiene el overlay de barras.
- **Safe-area izquierdo/derecho:** el área de lectura reserva `env(safe-area-inset-left/right)` en
  móvil, así el fondo de página rellena la franja del recorte de cámara (adiós al borde negro) y el
  texto no queda debajo de la cámara. En portrait los insets son 0 → sin efecto.

**Por qué desde el botón y no desde el toque central** (corrige el primer intento, que no funcionaba):
el toque en el texto ocurre DENTRO del iframe de lectura, que es *sandbox* de **origen opaco** (sin
`allow-same-origin`, para que el libro no lea la API key del localStorage). Chrome/Android **rechaza
`requestFullscreen()` iniciado por un gesto de un iframe cross-origin así**, y el rechazo era silencioso
→ "no funcionaba". El botón ⤢ vive en el documento padre, así que su gesto sí puede iniciar fullscreen.

Sin bump de `sw.js`. Verificado con Playwright (contexto móvil *coarse*, Fullscreen API stubbeada: botón
→ `requestFullscreen` + barras ocultas + icono ⤡; salir del sistema → barras vuelven; reentrar → vuelve
a pedirlo; ir a la biblioteca → `exitFullscreen`; 0 errores) y 19/19 E2E.

Había un handler de teclado en el `document`, pero al leer el **foco está dentro del iframe** de
epub.js, cuyas teclas no llegan al documento padre, así que las flechas no pasaban página (mismo motivo
que el `mousemove` del auto-ocultar).

**Qué se hizo** ([`js/epub-reader.js`](js/epub-reader.js), [`js/app.js`](js/app.js)):
- Listener `keydown` dentro de cada iframe de sección (hook de contenido) que reenvía **←/→** a
  `prev()`/`next()`. Se ignora con modificadores (Alt+← = atrás del navegador, Shift+← = selección).
- El handler del `document` padre (que cubre foco fuera del iframe y el PDF) gana el mismo guard de
  modificadores y también ignora `TEXTAREA`.

Sin bump de `sw.js`. Verificado con Playwright (foco dentro del iframe: `→→→` avanza de página y `←←`
retrocede; 0 errores) y 19/19 E2E.

El pie del lector solo mostraba el %; el tiempo restante estaba escondido en un popup que se abría al
pulsar la barra, y no había forma de saltar a una parte del libro desde ahí.

**Qué se hizo** ([`index.html`](index.html), [`css/main.css`](css/main.css),
[`js/epub-reader.js`](js/epub-reader.js), [`js/pdf-reader.js`](js/pdf-reader.js),
[`js/progress.js`](js/progress.js), [`js/app.js`](js/app.js)):
- **Info siempre visible** sobre la barra: **página** (izq.) · **%** (centro) · **tiempo restante**
  (der.). En EPUB la página sale de las localizaciones de epub.js (`location.start.location` /
  `locations.length()`); en PDF, de `currentPage/totalPages`.
- **Tiempo restante movido del popup a la barra**: `updateProgressDetail` ahora escribe en
  `#progress-time` y se actualiza en cada `relocated`. Se eliminó el panel `#progress-detail`.
- **Pulsar la barra salta** a esa parte del libro: se calcula la fracción del clic y se convierte a
  posición — EPUB `seekToFraction` (`locations.cfiFromPercentage` → `display`), PDF `seekToFraction`
  (fracción → `goTo(página)`). La zona de pulsación se amplía con un `::before` para acertar fácil.

Sin bump de `sw.js`. Verificado con Playwright (EPUB: "Pág. 1/191 · 0% · ~2 h 36 min"; clic al 75% de la
barra → salta a "Pág. 129/191 · 68%"; 0 errores) y 19/19 E2E.

Al subrayar, salir del libro y volver a entrar, el resaltado **no se veía sobre el texto** (aunque
seguía guardado y en la lista "Subrayados"). Causa: `applyHighlightToRendition` solo se llamaba al
**crear** un subrayado; al reabrir, epub.js crea un `rendition` nuevo con el set de anotaciones vacío y
**nada volvía a añadir** los guardados.

**Qué se hizo** ([`js/highlights-ui.js`](js/highlights-ui.js), [`js/app.js`](js/app.js)):
- Nueva **`applyStoredHighlights()`**: recorre `Highlights.getAll()` y re-dibuja cada uno en el
  rendition (`annotations.highlight`). Se llama en `loadEpub()` tras `setupHighlights()`, así cubre
  tanto abrir como reabrir desde la biblioteca (ambos pasan por `loadEpub`).

Sin bump de `sw.js`. Verificado con Playwright (creando un subrayado real con CFI válido: se dibuja en
la sesión y **sigue dibujado tras salir a la biblioteca y reabrir**; 0 errores) y 19/19 E2E.

Las respuestas largas del agente (análisis del Artesano del Texto, etc.) se cortaban en mitad de una
frase. Causa: `max_tokens: 2048` (~1500 palabras) y, peor, el parser **ni miraba `finish_reason`**, así
que el corte por longitud era **silencioso** (sin aviso ni recurso).

**Qué se hizo** ([`js/ai/llm.js`](js/ai/llm.js), [`js/ai/panel.js`](js/ai/panel.js)):
- **Tope subido a 4096** tokens (~3000 palabras): cabe casi cualquier respuesta.
- **Detección del corte:** `_chatStream` captura `finish_reason` y lo emite por `onDone({ truncated })`.
- **Botón "Continuar":** si el proveedor cortó por longitud (`finish_reason: 'length'`), la respuesta
  muestra un botón que **retoma exactamente donde se cortó** y streamea el resto en una nueva burbuja.
  No añade una burbuja de usuario (el modelo ya ve su parte previa en el historial); el botón se
  deshabilita al pulsarlo. El núcleo del turno se extrajo a `deliver()`, reutilizado por `send()` y por
  la continuación.

**Decisión:** botón manual en vez de auto-continuar sin límite — respeta el coste (BYOK) y evita bucles;
el usuario decide si quiere el resto. Sin bump de `sw.js`. Verificado con Playwright (stream mockeado con
`finish_reason: 'length'` → aparece "Continuar"; al pulsarlo, continuación en burbuja nueva sin turno de
usuario, botón deshabilitado, la parte con `stop` no reofrece continuar; 0 errores) y 19/19 E2E.

En escritorio el campo Modelo era un `<input list=datalist>`, y el datalist **no se despliega si el
input ya tiene valor**: parecía que "no dejaba cambiar el modelo" (en móvil el navegador sí lo muestra
como selector, de ahí que allí funcionara). Además no había forma de saber **qué modelos** ofrece el
proveedor.

**Qué se hizo** ([`js/ai/llm.js`](js/ai/llm.js), [`js/ui/app-settings.js`](js/ui/app-settings.js),
[`css/main.css`](css/main.css)):
- **`LLM.listModels({ baseUrl, key })`**: `GET /models` (OpenAI-compatible, `{ data: [{ id }] }`),
  devuelve los ids ordenados. Acepta base URL/key sueltos para consultarlos con lo que hay en el
  formulario **antes de guardar**. Misma política CORS que `/chat/completions`.
- **Botón "Descubrir"** junto al campo Modelo: consulta `/models` del proveedor y rellena la lista.
- **Chips de modelos** clicables debajo del campo (el activo, resaltado): modo fiable de ver y elegir
  el modelo en escritorio y móvil, sin depender del datalist. Al cambiar de proveedor se actualizan a
  sus modelos sugeridos; "Descubrir" los reemplaza por los reales.

**Decisión:** no forzar un `<select>` cerrado (rompería modelos personalizados): se mantiene el input
libre para escribir cualquier id, y los chips + Descubrir aportan la parte de descubrimiento. Errores
de `/models` se muestran como pista (algunos proveedores requieren key o no permiten `/models` desde el
navegador). Sin bump de `sw.js`. Verificado con Playwright (`/models` mockeado: chips iniciales y activo,
clic de chip cambia el modelo, Descubrir repuebla con los reales, cambio de proveedor actualiza; 0
errores) y 19/19 E2E.

Ahora puedes **enviar una pregunta al agente, cerrar el panel y seguir leyendo**: cuando llega la
respuesta, un **punto** en el botón del agente te avisa. (El stream ya sobrevivía al cierre del panel
—`abortCtrl.abort()` no se llama en ningún sitio—, así que la respuesta se completaba y guardaba en
segundo plano; solo faltaba el aviso.)

**Qué se hizo** ([`js/ai/panel.js`](js/ai/panel.js) + [`css/main.css`](css/main.css)):
- Dos clases en `body`: **`ai-busy`** (generando) y **`ai-unread`** (respuesta lista), aplicadas solo
  con el panel **cerrado**. Pintan un punto sobre el **punto de entrada visible**: `#ai-toggle` (header,
  escritorio) o `.ai-fab` (móvil) — el otro es `display:none` y no pinta.
- **`ai-busy`**: punto en color de acento con **pulso** mientras el agente genera. **`ai-unread`**:
  punto rojo fijo al terminar. Se **limpia al abrir** el panel (`setOpen`), como el patrón `ai-tab-unread`.

**Decisión:** aviso **in-app** (punto en el botón), no notificación del sistema. Es una app de lectura
que tienes en la misma ventana, las respuestas son rápidas (streaming), y evita el permiso de
notificaciones (que muchos navegadores limitan). Además, en pantalla completa el panel del agente no
es accesible, así que el chat ocurre en modo ventana, donde el botón —y su punto— sí se ven; no hay
hueco. Sin bump de `sw.js`. Verificado con Playwright (LLM mockeado: cerrar mientras genera → `ai-busy`;
al terminar → `ai-unread`; reabrir → limpio; 0 errores) y 19/19 E2E.

Dos problemas relacionados en PC. (1) El botón ⤢ entraba en el overlay inmersivo propio pero **no
había forma de salir** (el botón se ocultaba con las barras, el toque-al-centro es solo táctil, `Esc`
no lo gestionaba). (2) Más de fondo: en modo lectura las barras son un **overlay** sobre un área a
altura completa (para no re-paginar al ocultarlas), pero en escritorio nunca se ocultaban, así que
**tapaban siempre la 1ª/última línea** — nunca se veía la página entera, ni en ventana ni en fullscreen.

**Qué se hizo** ([`js/app.js`](js/app.js) `initImmersive`, [`css/main.css`](css/main.css),
[`js/epub-reader.js`](js/epub-reader.js), icono `compress` en [`js/ui/icons.js`](js/ui/icons.js)):
- **Overlay de barras solo donde SÍ se ocultan.** El `position:absolute` de cabecera/pie pasa a
  depender del puntero: en **móvil** (`pointer: coarse`) siempre (se ocultan tocando el centro); en
  **escritorio** (`pointer: fine`) **solo en pantalla completa** (`body.fs`). En **ventana de
  escritorio** las barras vuelven al **flujo normal** (flex) y el área de lectura se ajusta entre
  ellas → se ve **todo el texto** sin gestos.
- **Escritorio → pantalla completa nativa.** El botón ⤢ usa la **Fullscreen API** (`requestFullscreen`
  /`exitFullscreen`, con fallback `webkit*`): llena el monitor y oculta el chrome del navegador/SO. Se
  **sale con `Esc`/F11**; un listener de `fullscreenchange` sincroniza icono (⤢ ⇄ ⤡) y estado.
- **Auto-ocultar en fullscreen (Play Books), sin tapar texto.** En pantalla completa las barras
  arrancan ocultas y **reaparecen solo al llevar el ratón al borde superior/inferior** (no con
  cualquier movimiento). Además el texto **reserva la franja** de las barras (`padding` = alto de
  cabecera/pie), de modo que la barra revelada nunca se dibuja sobre el texto: así se puede
  **seleccionar/subrayar también la 1ª y la última línea**. Como el texto vive en un iframe (sus
  `mousemove` no llegan al document), `EpubReader.onActivity` reemite la actividad sobre la página para
  ocultar las barras cuando lees.
- **Móvil:** sin cambios (overlay + toque central).

**Decisiones:** ventana de escritorio con barras fijas (acceso a menús sin gestos, esperado en una
ventana) y fullscreen con auto-ocultar por borde (máxima lectura sin perder acceso a menús ni a la
selección en los bordes) — elegido por el usuario. Reveal **por borde** en vez de por cualquier
movimiento tras detectar que este último hacía imposible subrayar la 1ª/última línea. Sin bump de
`sw.js` (cambio de contenido, sin ficheros nuevos). Verificado con Playwright (Fullscreen API
stubbeada: ventana → barras en flujo con hueco; fullscreen → oculto con franja reservada de 52px, ratón
al borde revela sin pisar texto, ratón sobre el texto oculta, Esc sale al flujo; 0 errores) y 19/19 E2E.

---

## 2026-07-01 — Recorte de contexto e historial al LLM (IA1, fase 1+2, ex T5/E3.2/E3.3)

El agente dejaba de mandar el **libro anotado entero + todo el historial** en *cada* turno (caro y
lento; un libro de ~100k palabras ≈ ~125k tokens de input por mensaje). Ahora manda solo los
**capítulos relevantes** al objetivo y una **ventana de historial**.

**Qué se hizo** (nuevo [`js/ai/context.js`](js/ai/context.js), integrado en `send()` de
[`js/ai/panel.js`](js/ai/panel.js)):
- **Retrieval por capítulo:** reusa la relevancia por capítulo que ya se calcula y cachea por
  conversación (`DB.getRatings(convo.id)`, la misma que atenúa el índice). `selectContext` trocea el
  libro por sus marcadores `## capítulo` y selecciona por **presupuesto de tokens** (60k), añadiendo
  capítulos de mayor a menor relevancia hasta el tope.
- **Ventana de historial:** solo se reenvían los **últimos 6 mensajes** (el chat completo sigue
  guardado y visible; solo no se manda entero cada turno).
- **Guard de tokens:** si el prompt final supera **~120k tokens**, se avisa/confirma antes de enviar
  (absorbe E2.3) en vez de fallar de forma opaca.

**Decisiones y porqué:**
- **Por objetivo, no por pregunta.** NotebookLM hace retrieval por *pregunta* con embeddings; aquí se
  hace por *objetivo* (una selección por conversación) reusando los ratings existentes. Da ~80% del
  beneficio **sin necesidad de un endpoint de embeddings** (el BYOK actual solo asume chat). El
  retrieval por pregunta con `/embeddings` queda como fase futura opcional.
- **Presupuesto de tokens, no umbral fijo.** Con un umbral duro, un rating malo dejaría fuera algo
  útil; con presupuesto, si "sobra sitio" entran más capítulos igualmente. Degradación amable.
- **Inclusiones forzadas:** el **capítulo actual** (donde está el lector) y el **front matter** van
  siempre, aunque puntúen bajo, para no perder el contexto inmediato. Los subtítulos que no están en
  el TOC se **pliegan a su capítulo** (heredan su relevancia), no se tratan como capítulos sueltos.
- **Sin regresión:** si aún no hay puntuaciones (conversación recién creada; el rating es asíncrono),
  `selectContext` devuelve el **libro entero** —comportamiento anterior— y el siguiente turno ya
  filtra. Un capítulo del TOC que el modelo no llegó a puntuar también se conserva (no se descarta lo
  que no se puede juzgar).
- **Orden y caching intactos:** los capítulos se reensamblan en su orden original (anclas `[[aN]]`
  intactas) y el prompt mantiene el prefijo estable `[system][libro]` primero para el prompt caching.
- **Historial: ventana, no resumen (aún).** La ventana de N mensajes es gratis y sin coste extra; el
  **resumen rodante** (fase 3) añadiría una llamada por turno, así que se deja para después.
- Impacto esperado: reducción típica **~2–3×** de tokens de input por turno en objetivos enfocados,
  y respuestas más rápidas. SW: `context.js` al precache, `CACHE_NAME` → v37.
- Verificado: lint 0 errores · 19/19 E2E · **11/11** casos de `selectContext` (sin scores→libro
  entero, presupuesto amplio/medio/0, capítulo actual forzado, front matter, subtítulos plegados,
  capítulo sin puntuar conservado, orden y anclas) · integración en la app (petición de chat con
  `[system, libro, …, pregunta]`, fallback a libro completo sin ratings, historial acotado ≤6) sin
  errores de consola.

---

## 2026-07-01 — Proveedor de LLM configurable (BYOK a cualquier OpenAI-compatible) (TEC3, ex E1.2)

El agente deja de estar atado a nan: el usuario puede apuntar a **cualquier proveedor
OpenAI-compatible** (OpenAI, OpenRouter, Groq, un endpoint propio…) desde *Ajustes → Agente*.

- [`js/ai/llm.js`](js/ai/llm.js): `getBaseUrl/setBaseUrl` (default nan, se normaliza sin barra
  final), el modelo pasa a **texto libre** (cada proveedor usa IDs distintos), `PROVIDERS` con
  presets (nan, OpenAI, OpenRouter, Groq) y `currentProvider()`. Errores genéricos (ya no dicen
  "nan"). El resto ya era OpenAI-compatible.
- UI *Agente* ([`js/ui/app-settings.js`](js/ui/app-settings.js)): selector **Proveedor** (presets +
  *Personalizado*) que prefija Base URL + sugerencias de modelo (datalist), con **Base URL y Modelo
  editables** y la API key. La base URL se incluye en el backup global (P3); la key no.
- **CSP:** `connect-src` pasa de `… https://api.nan.builders` a `'self' blob: https:` para permitir
  cualquier endpoint HTTPS. La protección clave (`script-src 'self'`, que impide scripts inyectados
  y por tanto la exfiltración de la key) **se mantiene intacta**. Decisión de seguridad tomada por el
  usuario. Los modelos locales (Ollama/LM Studio) por `http://localhost` no funcionan desde una PWA
  servida por HTTPS (mixed-content del navegador), aparte del CSP.
- Verificado: lint 0 errores · 19/19 E2E · prueba manual (defaults nan, preset OpenAI prefija
  baseURL/modelo, config personalizada round-trip, `currentProvider()=null` en personalizado, y que
  el CSP **no bloquea** un host HTTPS distinto de nan) sin errores de consola.

---

## 2026-07-01 — Deslizamiento al pasar página en móvil (efecto tipo Kindle)

Al arrastrar con el dedo para pasar página, la página ahora **sigue al dedo** y **gira con una
animación de deslizamiento** (no el curl 3D de Play Books —inviable sobre epub.js porque no se puede
"fotografiar" el contenido de sus iframes a una textura sin *tainting* del canvas— pero sí un
deslizamiento tipo Kindle, robusto).

- [`js/touch-select.js`](js/touch-select.js): el arrastre horizontal dominante (sin selección en
  curso) emite `onSwipeMove(dx)` en vivo y `onSwipeEnd(dx)` al soltar. Sigue coexistiendo con el
  long-press (selección) y con los toques de navegación por zonas.
- [`js/epub-reader.js`](js/epub-reader.js): traslada `#epub-container` (nuestro; epub.js pinta
  dentro) siguiendo al dedo. Al soltar, si se supera el umbral (~18% del ancho) la página termina de
  salir, se cambia con epub.js **fuera de pantalla** y la nueva **entra desde el lado contrario**; si
  no, vuelve (*bounce*). Guard `swipeBusy` contra swipes solapados.
- **Sin franja de color:** el fondo del viewport en modo lectura usa `--page-bg` (fondo real de la
  página según el tema, fijado por epub-reader), así el hueco que se revela al arrastrar no muestra
  otro color (importaba en oscuro/sepia). Los toques en los bordes siguen pasando página al instante.
- **Fix parpadeo:** con el dedo quieto a media transición, los micro-`touchmove` (jitter sub-píxel)
  repintaban el iframe cada frame → el texto parpadeaba. Ahora se traslada con `translate3d` (capa
  GPU) redondeando a píxeles enteros y con *dedupe* (si el entero no cambia, no se repinta); además
  una animación en curso ya no se interrumpe por un segundo gesto.
- Verificado: lint 0 errores · 19/19 E2E · prueba manual con emulación táctil (sigue el dedo, giro al
  superar el umbral en ambos sentidos, *bounce* por debajo, transform reseteado, `--page-bg` fijado)
  sin errores de consola.

---

## 2026-06-30 — Perfil de agente: nombre en el prompt + chip visible (P1)

Dos retoques sobre los perfiles (P1) para que el perfil activo sea visible y coherente:

- **El agente conoce su nombre:** `promptBlock` ([`js/ai/profiles.js`](js/ai/profiles.js)) antepone
  ahora *"Te llamas {nombre}; preséntate por ese nombre si te lo preguntan."* Sigue siendo prefijo
  estable (no rompe el prompt caching).
- **Chip del perfil activo en el panel:** bajo la barra de estado, un chip clicable con icono +
  nombre del perfil (nuevo icono `user` en [`js/ui/icons.js`](js/ui/icons.js)). Solo visible si hay
  perfil activo; al tocarlo abre *Ajustes → Perfiles*. Se actualiza en vivo: activar/desactivar/editar
  un perfil emite `appsettings:profile-changed` y el panel refresca el chip.
- Verificado: lint 0 errores · 19/19 E2E · prueba manual (nombre en `systemPrompt`, chip con el
  nombre, ocultar/mostrar en vivo al desactivar/reactivar) sin errores de consola.

---

## 2026-06-30 — Modo inmersivo estilo Play Books (las barras no mueven el texto)

Al tocar el centro en modo lectura para mostrar/ocultar las barras, el texto **ya no salta**.
Antes, el inmersivo sacaba cabecera y pie del flujo → el área de lectura crecía → epub.js
re-paginaba → el texto se recolocaba.

- Las barras pasan a ser un **overlay** (`position:absolute`) sobre un área de lectura que ocupa
  **siempre toda la altura**, pero solo con un libro abierto (nueva clase `body.reading`, para no
  afectar a biblioteca/landing). Mostrar/ocultar las barras ya no cambia el tamaño del contenedor,
  así que epub.js no re-pagina y el texto permanece fijo.
- `setImmersive()` ([`js/app.js`](js/app.js)) ya no llama a `resize()` (la geometría no cambia al
  alternar). `body.reading` se añade al abrir EPUB/PDF y se quita al volver a la biblioteca.
- Contrapartida (como en Play Books): mientras las barras están visibles tapan una franja fina del
  texto en el borde superior/inferior; al ocultarlas se ve a altura completa. El re-paginado por
  cambio de ancho (sidebar/panel) y por rotación sigue igual.
- Verificado: lint 0 errores · 19/19 E2E · prueba manual en viewport móvil (altura del contenedor y
  posición del texto idénticas al alternar; capturas con/sin barras) sin errores de consola.

---

## 2026-06-30 — Perfiles de agente (P1, ex B1) — overlay completo

Sección **Perfiles** de *Ajustes generales* funcional: persona del agente reutilizable **entre
libros** (a diferencia de las convos, que son por libro). Con esto el overlay de Ajustes generales
queda completo (Agente · Perfiles · Plantillas · Datos).

- Nuevo módulo [`js/ai/profiles.js`](js/ai/profiles.js): un perfil = `soul` (personalidad/rol) +
  `userProfile` (quién es el usuario) + `notes` (notas permanentes). CRUD + un perfil **activo**
  (puntero `active_profile`). Persistencia en **localStorage** (no IndexedDB): `systemPrompt()` se
  construye de forma **síncrona**, así que un store síncrono evita caché en memoria y carreras de
  arranque; además el backup global (P3) lo incluye sin tocar nada.
- **Inyección en el prompt:** el bloque del perfil activo se antepone al system prompt
  ([`js/ai/panel-template.js`](js/ai/panel-template.js), `systemPrompt(goal, template, profile)`),
  **primero** por ser lo más estable (reutilizable entre libros/convos) → mejor prefijo para el
  prompt caching del proveedor. Único call site en [`js/ai/panel.js`](js/ai/panel.js) pasa
  `Profiles.getActive()`.
- UI en [`js/ui/app-settings.js`](js/ui/app-settings.js): lista con perfil activo, botón
  activar/desactivar (toggle), editar/borrar, y formulario (nombre + 3 campos). El primer perfil
  creado se activa solo; borrar el activo deja al agente sin perfil. Validación (nombre + ≥1 campo).
- SW: `profiles.js` al precache, `CACHE_NAME` → v36.
- Verificado: lint 0 errores · 19/19 E2E · prueba manual (crear/auto-activar/persistir, **inyección
  real en `systemPrompt`** con soul/usuario/notas, toggle off lo quita, editar, validar, borrar →
  limpia el activo) sin errores de consola.

---

## 2026-06-30 — Export / import global (P3, ex B3)

Sección **Datos** de *Ajustes generales* funcional: backup round-trip de los datos del usuario
para guardarlos o migrar entre dispositivos (la PWA es local-first, sin servidor). Cierra la última
sección pendiente del overlay salvo Perfiles (P1).

- Nuevo módulo [`js/backup.js`](js/backup.js): `buildBackup`/`importBackup` (JSON round-trip),
  `buildMarkdown` (resumen legible) y descargas (mismo patrón CSP-safe que la exportación de
  subrayados). `getAll(store)` genérico añadido a [`js/ai/db.js`](js/ai/db.js).
- **Incluye:** todo `localStorage` (ajustes, subrayados, marcadores, plantillas propias, posiciones,
  modelo/auto) + IndexedDB IA (conversaciones, mensajes, notas, relevancia, metadatos de libros).
- **Excluye a propósito:** la **API key** (`ai_key`, secreto — no se escribe a un fichero descargable),
  el texto segmentado/anclas (`bookText`/`anchors`, voluminoso y regenerable) y los archivos de los
  libros (binarios fuera de alcance).
- **Import** fusiona (sobrescribe lo que coincida, no borra el resto); valida el `format` y avisa con
  un botón de recarga para aplicar. Markdown: libretas por conversación/campo + subrayados por libro.
- SW: `backup.js` al precache, `CACHE_NAME` → v35.
- Verificado: lint 0 errores · 19/19 E2E · prueba manual del round-trip (exportar JSON+MD con
  descargas reales, comprobar que la key se excluye, mutar estado, reimportar y verificar restauración
  de ajuste/convo/nota, y archivo inválido → error controlado) sin errores de consola.

---

## 2026-06-30 — Plantillas de libreta propias (P2, ex B2)

Sección **Plantillas** de *Ajustes generales* ya funcional: CRUD de plantillas de libreta del
usuario, además de las 6 de fábrica.

- Nuevo módulo [`js/ai/custom-templates.js`](js/ai/custom-templates.js): persistencia en
  **localStorage** (no IndexedDB) — la API de plantillas es **síncrona** (`getTemplate`/`isValidField`
  se llaman en caliente durante el streaming), así que un store síncrono encaja sin caché en memoria
  ni carrera de arranque; el payload es diminuto. Normaliza el borrador (bloque válido, defaults) y
  genera **claves de campo únicas** slugificando la etiqueta (preserva la clave al editar para no
  huérfanar notas).
- [`js/ai/templates.js`](js/ai/templates.js) fusiona fábrica + propias vía `allTemplates()`;
  `getTemplate`/`templatesByBlock` (y, colgando de ellas, `isValidField`/`fieldLabel`) las incluyen.
  **El onboarding del agente las muestra automáticamente** junto a las de fábrica, sin tocarlo
  (definir-vs-usar: se crean en Ajustes, se eligen en el onboarding).
- UI en [`js/ui/app-settings.js`](js/ui/app-settings.js): lista por enfoque (fábrica con etiqueta
  *de fábrica* de solo lectura; propias con editar/borrar) + formulario (nombre, enfoque, ideal,
  pregunta de objetivo, rol del agente y campos dinámicos texto/lista con añadir/quitar). Validación
  (nombre + ≥1 campo) y aviso al borrar (las convos que la usen pierden su estructura).
- SW: `custom-templates.js` al precache, `CACHE_NAME` → v34.
- Verificado: lint 0 errores · 19/19 E2E · prueba manual (crear con 2 campos, persistencia, presencia
  en `getTemplate`/`templatesByBlock`, editar, validación, borrar) sin errores de consola.

---

## 2026-06-30 — Base de "Ajustes generales" (overlay global, hogar de P1–P3)

Fundación de la decisión de diseño homónima del BACKLOG. Nuevo overlay global
[`js/ui/app-settings.js`](js/ui/app-settings.js) (`#app-settings`), mismo patrón modal que el
onboarding, montado en `<body>` bajo demanda. Cuatro secciones: **Agente**, **Perfiles** (P1),
**Plantillas** (P2), **Datos** (P3); las tres últimas son placeholders a la espera de su feature.

- **Config del agente movida** fuera del panel: key/modelo/auto-rellenar salen de `#ai-config`
  ([`js/ai/panel-template.js`](js/ai/panel-template.js)) a la sección *Agente*. Sigue respaldada
  por el módulo `LLM` (localStorage), así que es la **misma fuente de verdad**, sin duplicar estado.
  Al guardar se emite `appsettings:agent-saved` y el panel refresca su estado.
- **Entradas:** rail de la estantería ([`js/library/view.js`](js/library/view.js)) y pie de la
  sidebar (`#open-app-settings`). El engranaje del panel del agente ahora también abre aquí.
- **Separación de ámbitos respetada:** las settings de *lectura* (tema/fuente/ancho) siguen en la
  sidebar (contextual del libro); las *globales* viven en este overlay.
- Cierre por botón, click en el fondo y `Escape`. SW: `app-settings.js` al precache, `CACHE_NAME` → v33.
- Verificado: lint 0 errores · 19/19 E2E (los selectores `name: 'Ajustes'` de los tests pasan a
  `exact: true` por el nuevo botón "Ajustes generales") · prueba manual del overlay (abrir, guardar
  + persistencia + evento, cambiar de sección, cerrar) sin errores de consola.

---

## 2026-06-30 — Swipe para pasar página en móvil (P4, ex B5)

Gesto de swipe horizontal en el lector táctil ([`js/touch-select.js`](js/touch-select.js)),
estilo Play Books: deslizar a la izquierda = página siguiente, a la derecha = anterior.
Reutiliza el callback `onTap` (`prev`/`next`), sin tocar `app.js`. Coexistencia de gestos
resuelta por el long-press existente (380 ms), que intercepta los "mantener pulsado" antes de
que un arrastre llegue a contarse como swipe; además se exige dominancia horizontal
(`|dx| ≥ 45px` y `|dx| > 1.2·|dy|`) para no confundir un scroll vertical con un cambio de
página. Los toques cortos en los bordes y el toque central (inmersivo) siguen igual.

---

## 2026-06-30 — Endurecimiento técnico y refactor (T1–T10, T8)

Auditoría de buenas prácticas, seguridad, performance y arquitectura → backlog técnico
ejecutado. Cada cambio verificado con **19/19 E2E + lint 0 errores**.

### Seguridad
- **T1 — SRI en libs de CDN:** `integrity` sha384 + `crossorigin` en jszip/epub.js/pdf.js.
  Eliminado el `<link>` muerto a `epub.min.css` (404: epubjs 0.3.93 no publica CSS).
  *(Superado luego por T6: las libs se vendorizaron.)*
- **T2 — CSP:** meta `Content-Security-Policy`. `script-src 'self'` (protege la API key en
  localStorage) + `connect-src` limitado a `self`/`blob:`/`api.nan.builders`. Estilos/fuentes/
  imágenes permisivos para render fiel del EPUB; `worker-src`/`frame-src` con `blob:`.
- **T3 — Escapado centralizado:** nuevo [`js/ui/escape.js`](js/ui/escape.js) (`escapeHtml`
  escapa también comillas, válido en contenido y atributos). Borradas las 3 copias locales;
  `src` del cover escapado; corregido un hueco en `data-cfi` de panel.js.
- **T4 — Aviso de privacidad** en la config del agente (la key vive solo en el navegador; el
  libro se envía al proveedor). Icono `shield` nuevo.

### Performance / PWA
- **T6 — PWA offline real:** jszip, epub.js, pdf.js **y el worker de pdf.js** vendorizados a
  [`vendor/`](vendor/); HTML y `workerSrc` a local; los 4 al precache del SW. Sin dependencia
  de CDN. Habilita la CSP estricta de T2.
- **T7 — Service worker stale-while-revalidate:** sirve de caché y refresca en segundo plano
  (GET mismo origen); ya no hace falta bumpear `CACHE_NAME` para propagar cambios.

### Arquitectura — T8 (trocear app.js / panel.js)
Extracción de 6 módulos de bajo acoplamiento. **`app.js` 848→451 · `panel.js` 920→782.**
- [`js/progress.js`](js/progress.js) — progreso detallado + estimación de palabras (de app.js).
- [`js/highlights-ui.js`](js/highlights-ui.js) — selección + barra de acciones + lista de
  subrayados (de app.js).
- [`js/bookmarks-ui.js`](js/bookmarks-ui.js) — botón de marcar + lista de marcadores (de app.js).
- [`js/ai/render.js`](js/ai/render.js) — `renderWithCitations` (Markdown + chips de cita).
- [`js/ai/attenuation.js`](js/ai/attenuation.js) — relevancia/atenuación de capítulos.
- [`js/ai/panel-template.js`](js/ai/panel-template.js) — `TEMPLATE` (HTML) + `systemPrompt`.
- **Decisión arquitectónica:** el núcleo de `panel.js` se deja entero por cohesión (`convo`
  75×, `els` 65×); no se trocea con estado mutable compartido. Si hiciera falta: store con API
  explícita y solo con tests del panel IA. Ver [`BACKLOG.md`](BACKLOG.md).

### Buenas prácticas
- **T9 — Lint + formatter:** ESLint flat ([`eslint.config.mjs`](eslint.config.mjs)) + Prettier;
  scripts `lint`/`format`. `npm run lint` en 0 errores.
- **T10 — Metadatos de `package.json`** + `"private": true`.
- **B4 — Borrar un subrayado:** el botón ✕ refresca la lista y quita el resaltado pintado
  (`rendition.annotations.remove(cfi, 'highlight')`). Verificado E2E.

---

## 2026-06-29 — Rediseño visual (F1–F5) y mejoras del agente

### Rediseño (estética NotebookLM → Apple/SF Symbols)
- **F1 · Tokens y primitivas:** `themes.css` reescrito (paleta neutra + acento, oscuro menos
  saturado, sepia; escalas de radio/espaciado/sombra/tipografía). Tema por defecto = sistema
  (`prefers-color-scheme`) con override claro/oscuro/sepia.
- **F2 · Responsive / móvil:** breakpoints (≥1024 empuja, <1024 superpone, <768 sheets).
  Agente y onboarding como **bottom sheets**; índice como drawer; scrim; FAB; safe-areas
  (`env(...)`) + `100dvh`.
- **F3 · Restyle de componentes:** chat estilo NotebookLM, **chips de cita pill**, pestañas
  segmented control, header translúcido, botones pill, libreta con eyebrow, shimmer de estado.
- **F4 · PWA + lector inmersivo:** `manifest.json` completo + iconos 192/512/maskable/apple,
  theme-color dinámico, SW cachea módulos IA. Modo inmersivo (oculta header/footer; zonas
  táctiles izq/centro/der).
- **F5 · Estilo Apple + SF Symbols:** se eliminan TODOS los emojis. Sistema de iconos de línea
  SVG ([`js/ui/icons.js`](js/ui/icons.js), ~24 glifos, `currentColor`, hidratados vía
  `[data-icon]`). Paleta iOS (acento azul Apple), serif New York para el libro, selector de
  tema como muestras de color.

Verificado en cada fase: 18/19 E2E + screenshots desktop (1200px) y móvil (390×844), claro/oscuro.
Decisiones de diseño y tokens vivos: ver [`DESIGN.md`](DESIGN.md).

### Agente
- Render de **Markdown** en respuestas/notas ([`js/ai/markdown.js`](js/ai/markdown.js), seguro,
  sin deps) + botón **Copiar** + **auto-extracción** a la libreta (toggle ON) + **libreta
  editable** (añadir/editar/borrar) + **atenuación de capítulos** en el índice (E6.4).
- Serialización de todas las llamadas a nan (`llm.js`) — nan da "network error" con peticiones
  concurrentes a la misma key.

---

## 2026-06-28 — Feature de IA: Lectura Orientada a Objetivos (E0–E7)

Agente que lee el libro **completo** (contexto 1M, sin RAG) según el **objetivo** del usuario
y rellena una **libreta estructurada** por plantilla. Citas vía anclas→CFI. BYOK contra nan
(OpenAI-compatible, default DeepSeek V4 Flash). Persistencia en IndexedDB. Verificado E2E
contra la API real (19/19).

### E0 — Spikes / de-risk
- **E0.1 — Prompt caching en nan:** el caching de prefijo **funciona a nivel de inferencia**
  (repetición exacta 13s→0.9s) pero nan **no lo reporta** (`cached_tokens` 0) ni lo descuenta
  (tarifa plana). Latencia turno-a-turno con libro caliente: mediana ~5s (3–15s); frío ~13–26s.
  Decisión: seguir con contexto-completo + streaming obligatorio + estado "leyendo…".
- **E0.2 — Ancla→CFI:** `section.cfiFromElement(el)` → CFI navegable con `display(cfi)`,
  verificado de punta a punta. Mecanismo de citas de-risked.

### E1 — Proveedores
- **E1.1 — `LLMProvider` (nan):** [`js/ai/llm.js`](js/ai/llm.js): `fetch` + `Bearer`, streaming
  SSE (`chatStream`), tool-calling no-streaming (`chatTools`), errores 401/429/5xx + abort.
- **E1.2 — Config BYOK:** key + modelo en localStorage (no se loguea); modelos en `MODELS`.
  🟡 `baseURL` fijo (no editable en UI).

### E2 — Segmentación + anclas (reemplaza chunking/embeddings)
- **E2.1** recorrido estructural del spine ([`js/ai/segment.js`](js/ai/segment.js)).
- **E2.2** anclas `[[a<n>]]` por bloque + mapa ancla→CFI.
- **E2.3** cacheo del libro por hash SHA-256 en IndexedDB; no re-segmenta; `tokenEstimate`.
  🟡 Pendiente el aviso si supera el contexto → ver [`BACKLOG.md`](BACKLOG.md).

### E3 — Motor del agente
- **E3.1** system prompt orientado a objetivo + contrato de citas (prefijo cacheable).
- **E3.2** ensamblado de contexto por turno. 🟡 Sin presupuesto de tokens ni recorte de turnos
  → ver [`BACKLOG.md`](BACKLOG.md).
- **E3.4** tool `upsert_note` (valida campo contra plantilla, persiste, libreta en vivo) +
  auto-extracción tras cada respuesta.

### E4 — Persistencia (IndexedDB)
- **E4.1** [`js/ai/db.js`](js/ai/db.js): apertura versionada; stores `books`, `bookText`,
  `anchors`, `messages`, `sessions`/`convos`, `notes`, `ratings`; `hashBuffer`. Cacheo
  verificado (reabrir = "Listo (cacheado)").
- **E4.2** modelo de sesión/convo: reabrir reanuda objetivo + plantilla + notas + chat.

### E5 — Plantillas
- **E5.1** las 6 plantillas ([`js/ai/templates.js`](js/ai/templates.js) / [`templates.md`](templates.md)).
- **E5.2** roles por plantilla: 🟢 HQ&A al subrayar (genera Pregunta + Respuesta a la libreta).
  🟡 Falta "Pepito Grillo" → ver [`BACKLOG.md`](BACKLOG.md).

### E6 — UI
- **E6.1** onboarding (bloque→plantilla→objetivo). **E6.2** split-screen colapsable.
- **E6.3** panel chat (streaming + citas clicables) + libreta editable (CRUD persistente).
- **E6.4** atenuación de capítulos en el TOC (una llamada `rate_chapters`, perezosa, cacheada).

### E7 — Robustez / tests
- **E7.1** estados de error/vacío (key ausente/inválida, 401/429, segmentando). 🟡 Sin reintentos.
- **E7.3** tests E2E de la IA ([`tests/ai.spec.ts`](tests/ai.spec.ts), `@live` contra API real),
  separados del suite determinista. Tests "no JS errors" endurecidos (capturan `pageerror`).

### Decisiones cerradas
BYOK + selector de modelo (nan) · contexto-completo + anclas-CFI (sin RAG) · IndexedDB ·
2 bloques → 6 plantillas · EPUB primero · default DeepSeek V4 Flash.

---

## 2026-06-28 — Bugs del lector resueltos (ex ISSUES.md)

- **CRÍTICO — Layout a 2 columnas:** `#epub-container` medía el viewport completo mientras a
  `renderTo()` se le pasaba un `width` menor → el offset de página se colaba. Fix:
  `sizeContainer()` fija el contenedor al ancho del render (`columnWidth + 60`), `max-width:100%`,
  centrado; se quitó `display:flex` del contenedor; la inyección de tema ya no toca
  `max-width/margin/padding` del `body`. ([`js/epub-reader.js`](js/epub-reader.js) + `main.css`).
- **MEDIO — Themes en el iframe:** una sola estrategia de inyección
  (`injectThemeIntoContent()` en `rendition.hooks.content` + reaplicado vía `getContents()`);
  se eliminó `injectThemeIntoAllFrames()` y `themes.default/override`.
- **MEDIO — Botón de bookmark con estado obsoleto:** en `rendered` se refresca `currentCfi`
  con `rendition.currentLocation()` antes de notificar.
- **BAJO — PDF texto seleccionable:** text layer de pdf.js sobre el canvas
  (`page.getTextContent()` + `renderTextLayer`) en wrapper `.pdf-page` con `--scale-factor`;
  CSS `.textLayer` transparente. *(Highlights persistentes en PDF siguen pendientes → BACKLOG.)*
- **BAJO — Reabrir el mismo EPUB:** `fileInput.value = ''` tras cargar
  ([`js/app.js`](js/app.js)).
