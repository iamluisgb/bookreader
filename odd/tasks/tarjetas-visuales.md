# Feature: Tarjetas visuales (P1–P3 del plan de retención)

Rama: `feat/tarjetas-visuales`. Estado: **implementación en curso** — spec cerrada y
riesgo crítico validado (2025). Demo de referencia: `demo/book-cards.html`.

## Alcance

Tres tipos de tarjeta de estudio que se suman a `basic`/`cloze`:

| Tipo | Qué es | Evidencia |
|---|---|---|
| `occlusion` | Figura real del libro con un componente tapado; al voltear se resalta y se explica | Estándar de industria (Anki 23.10 nativo, IO Enhanced). Diferenciador: BookReader ya localiza la página de la figura |
| `diagram` | SVG generado por código con un nodo en blanco; al voltear se resalta la respuesta | Paivio 1971/1986; Mayer d=1,39 (multimedia) y d=0,86 (coherencia); EduVisBench arXiv 2505.16832 |
| `drawing` | Canvas «dibujá de memoria» + revisión con visión contra la rúbrica del capítulo | Wammes 2016 QJEP; Fernandes et al. 2018; Yang et al. 2014 (Picmonic RCT) |

## Evidencia del experimento de grounding (riesgo crítico — VALIDADO)

Figuras de prueba: `demo/assets/fig-{mq,metrics,lbs,datastore}.jpg` (crops reales del PDF).

| Hallazgo | Resultado |
|---|---|
| Las figuras del libro son **raster embebido** (1 imagen por página, sin capa de texto) | PyMuPDF/OCR del PDF **no** sirve: la localización debe ser con visión |
| `deepseek-v4-flash` para grounding | ❌ labels correctos pero **cajas desplazadas verticalmente** (overlays contra medidas manuales) |
| `glm5.3-flash` para grounding | ✅ **52/52 labels verificados** por cross-check (recorte del bbox → transcripción por otro modelo → coincide con el texto declarado): mq 6/6, metrics 12/12, lbs 18/18, datastore 16/16, 0 cajas fuera de límites |
| Presupuesto de tokens | ⚠️ `glm5.3-flash` razona: con `max_tokens=1500` la respuesta **se trunca** a mitad de JSON. Con `max_tokens≥4000` cierra (`finish_reason=stop`) |

**Guardas obligatorias derivadas del experimento**:
1. `max_tokens ≥ 4000` en la llamada de grounding.
2. Detectar truncamiento (`finish_reason == 'length'` o JSON desbalanceado) → 1 reintento con más presupuesto.
3. Parseo tolerante (patrón `balancedObjects`) — probado: el formato exacto no está garantizado.
4. Descartar bboxes fuera de límites o degenerados (w/h < 5 px) y deduplicar labels repetidos.

**Arquitectura**: dos modelos — visión (`glm5.3-flash`) localiza, texto (`deepseek-v4-flash`)
hace pedagogía (selección de oclusión, diagramas, revisión de bocetos). En la app esto sale
del par `ai_vision_model` / `ai_model` que ya existe (BYOK).

## Anclajes de código (del mapeo read-only)

| Necesidad | Dónde |
|---|---|
| Llamada multimodal | `LLM.chatVision({messages, signal, maxTokens})` — `app/js/ai/llm.js:572`, gate `hasVision()` `:83`; ejemplo de uso `app/js/ai/panel.js:1476` |
| Recorte de figura del PDF | `captureRegionImage(page, rect, maxPx)` — `app/js/pdf-reader.js:1496` (rect fraccional 0..1, JPEG data URL) |
| Persistencia de figuras | Store `artifacts` (`key = ${bookId}:${kind}:${id}`, validado contra `SEG_VERSION`) — `app/js/ai/db.js:589`; sin migración nueva |
| Modelo de tarjeta | `sanitizeCards` — `app/js/ai/flashcards.js:439`; mazo `db.js:376`; **`sameCard` `db.js:424` (lista blanca del merge LWW: campos nuevos deben entrar acá o el sync los pisa)** |
| Generación | `renderSetup()` (menú de tipos) `flashcards.js:85`; `onGenerate()` `:567`; prompts `cardsPrompt()` `:356` / `cardsTool()` `:407`; reintentos `generateChunk()` `:518` |
| Render en estudio | `frontHtml`/`backHtml` `study.js:395/403`; `flip()` `:743`; `renderCard()` `:531`; **`buildQueue()` `:194` filtra por `c.front` → hoy excluiría tarjetas visuales** |
| Export Anki | `anki-export.js` asume front/back texto → las tarjetas visuales saldrían vacías |

## Los 4 prompts

### 1. Grounding de labels — `glm5.3-flash`, `max_tokens ≥ 4000`

```
Detecta las etiquetas de texto de este diagrama técnico. Devuelve SOLO JSON sin markdown:
{"labels":[{"text":"<texto exacto>","bbox":[x,y,w,h]}]}
con bbox en PÍXELES de la imagen (x,y = arriba-izquierda), encerrando SOLO el texto
(no el ícono ni la forma completa). La imagen mide <W>×<H> píxeles.
Omite las etiquetas de las que no estés seguro.
```
Ejemplo oro (fig-mq, 810×130): `Producer → [71,56,66,15]`, `Message queue → [350,30,111,16]`,
`Consumer → [668,55,73,16]`.

### 2. Selección de oclusión — `deepseek-v4-flash`

Entrada: labels del prompt 1 + texto del capítulo. Salida (SOLO JSON):
`{"cards":[{"occludedLabel","question","contextFact","difficulty"}]}`, máx 3 por figura,
`contextFact` rastreable al texto del capítulo, todo en español. Regla Mayer: ocluir solo
elementos que portan información; si ningún label vale la pena → `{"cards":[]}`.

### 3. Generación de diagrama SVG — `deepseek-v4-flash`

Gate primero: solo si el concepto tiene estructura relacional (secuencia, flujo, comparación,
jerarquía); si no → `{"usable":false,"reason"}`. Si sí: SVG autocontenido, `viewBox="0 0 720 H"`
(H 180–280), clases `d-box`/`d-txt`/`d-cap`/`d-line`, el nodo objetivo en `?` en el frente y
resaltado (`is-fill` + `is-strong`) en el dorso, texto en español. Salida:
`{"usable":true,"svg","answerNodeId","question","contextFact"}`.
**Validación post-generación (código, no prompt)**: parsear XML, verificar `answerNodeId`,
rechazar `<script>`/`on*=`; si falla → 1 regeneración → descarte.

### 4. Revisión de boceto — `deepseek-v4-flash` (validado end-to-end en la demo)

JPEG del canvas (máx 640 px) + metadatos de trazos (índice, bbox) + rúbrica de pasos.
Salida: `{steps[{name, detected, stroke}], extraCount, comment}`.

## API de `app/js/ai/figures.js` (WU2, entregado)

| Función | Contrato |
|---|---|
| `clampBbox(bbox, {width,height,minSize=5,tolerance=2})` | Salida canónica `{x,y,w,h}` enteros dentro de la imagen, o `null` (inválido, degenerado o >2px fuera) |
| `normalizeText(s)` | minúsculas, sin tildes, solo alfanuméricos con espacios colapsados |
| `dedupeLabels(labels, {iouThreshold=0.55})` | Filtra/deduplica por texto normalizado o IoU; **preserva la forma de `bbox` de la entrada** (array del modelo → array) |
| `parseLabelsResponse(text, {width,height})` | Tolerante (fences, prosa, truncado); NUNCA lanza; salida con **bbox canónico `{x,y,w,h}`** |
| `figureRectToBox(rect, {pageWidth,pageHeight})` | rect fraccional 0..1 → box `{x,y,w,h}` en píxeles (clampea, no descarta) |
| `saveFigure({bookId,page,rect,dataUrl,labels,caption,source})` | Artefacto `kind:'figures'` en el store `artifacts`; devuelve la clave |
| `getFigures(bookId)` | Figuras del libro, más nuevas primero, como `{key, page, rect, dataUrl, labels, caption, source}` |
| `deleteFigure(key)` | Tombstone (se propaga por sync) |

**Regla para WU3/WU5**: los labels que llegan del modelo y se consumen en la UI pasan por
`parseLabelsResponse` → **bbox canónico `{x,y,w,h}` en píxeles de la imagen recortada**.
`dedupeLabels` conserva la forma de entrada (es un filtro, no un normalizador).

**Validación con pdf.js real (WU4)**: el fixture `tests/test-figure.pdf` tiene una imagen
insertada en el rect (120,300,480,525) con origen arriba-izquierda. El módulo devuelve
`{x: 120/612, y: 300/792, w: 360/612, h: 225/792}` y `[]` en la página sin imágenes — confirmado
con el operator list real de pdf.js 3.11.174, no solo con listas sintéticas.

**Hueco conocido**: la extracción cubre `painted image objects` del PDF. Un EPUB con figuras
como `<img>` no tiene camino todavía (fuera del alcance de la primera entrega).

## Tareas de implementación (ODD, work units)

- [x] **WU1** Spec + evidencia de grounding + anclajes (`7152577`)
- [x] **WU2** `app/js/ai/figures.js` + `tests/figures.spec.ts` — 5 tests (`ea017e1`)
- [x] **WU3** `app/js/ai/visual-cards.js` + `tests/visual-cards.spec.ts` — 8 tests incl. abort (`e0f6196`)
- [x] **WU4** `app/js/ai/figures-pdf.js` + `tests/figures-pdf.spec.ts` — 10 tests (9 sintéticos +
      1 de integración contra pdf.js real con el fixture `tests/test-figure.pdf`) (`44036d3`)
- [x] **WU5a** Lote de diagramas con regeneración única + tarjetas de dibujo con rúbrica de ≥3
      pasos en `visual-cards.js`; 13 tests (`662ce34`)
- [x] **WU4b** `app/js/ai/figures-epub.js` + `tests/figures-epub.spec.ts` — detección de imágenes
      en el zip del EPUB, resolución de hrefs con `../`, lectores de zip y pipelines de
      colección/guardado con IO inyectada; 7 tests incl. integración contra `tests/test.epub` (`7d6854c`)
- [x] **WU5b** `app/js/ai/visual-deck.js` — contrato de tarjeta visual (occlusion/diagram/drawing),
      mapeo etiqueta→bbox, sanitizador y `buildVisualCards` (familias secuenciales, resultado
      parcial ante fallos, abort propaga); 8 tests (`a594bd3`)
- [x] **WU5c** Bug latente corregido: el modelo de figura no persiste dimensiones, así que el
      grounding recibía 0 y `clampBbox` descartaba todas las etiquetas (cero tarjetas de oclusión
      en producción). `figureSize()` usa las dimensiones si están y si no decodifica el dataUrl;
      figura sin tamaño resoluble se saltea sin gastar visión (`9b9b3f4`); 13 tests en el spec
- [x] **WU5d** `app/js/ai/visual-figures.js` — render offscreen de páginas + recorte (misma
      semántica que `captureRegionImage`), `figuresForPdf` (renderiza SOLO páginas con imágenes,
      pasa los píxeles reales del recorte) y `figuresForEpub` (JSZip sobre el blob de la
      biblioteca), más `ensureBookFigures` (store primero, extracción después); 8 tests.
      `figures.js` persiste `width`/`height` para no re-decodificar (`b1df59a`)
- [x] **WU5e** Menú multi-tipo en `flashcards.js` (radio de texto + `none` + checkboxes visuales,
      botón deshabilitado sin selección) y wiring bajo `Jobs` con `ensureBookFigures` +
      `buildVisualCards`; `PdfReader.getBookId()` evita extraer del documento de otro libro;
      mazo con `cardType` efectivo (`mixed` al combinar) y migración a `mixed` al fusionar;
      20 tests en `flashcards.spec.ts` (`1fac7c1`)
- [x] **WU6** Render por tipo en estudio (`study.js`): oclusión (overlay %), diagrama (SVG),
      dibujo (canvas) + arreglar `buildQueue` para tarjetas sin `front`
- [x] **WU7** Revisión del boceto con `chatVision` + pintado por colores de trazo
- [x] **WU8** Sync/export: campos visuales en `sameCard`; comportamiento definido en export Anki
- [x] **WU9** Docs: CHANGELOG, BACKLOG, DECISIONS + evals/check determinista si aplica

## Estado del árbol de tests (checkpoint final, WU9)

Suite completa: **603 passed / 4 failed**. Ninguna falla es de esta feature:

| Falla | Estado |
|---|---|
| `llm.spec.ts:149` getLiteModel | Preexistente — falla igual con los cambios de la feature fuera del árbol |
| `model-probe.spec.ts:67` | Preexistente — ídem |
| `pdf-scroll-ghost.spec.ts:47`, `reanchor-position.spec.ts:117` | Flaky por carga: pasan aislados (3/3); el par que falla cambia entre corridas (en la corrida anterior fueron `sw-precache` y `pdf-touch-select`) |
| `sw-precache` (gap de `ui/book-accent.js`) | Preexistente y **corregido** en `ef56473` |

Tests nuevos de la feature: **72** (66 en siete specs nuevos + 3 en `flashcards.spec.ts` + 3 en
`sync-decks.spec.ts`), todos en verde. Lint: sin hallazgos en los módulos nuevos; la rama además
deja el repo más limpio que `main` (elimina el error de clave duplicada de `i18n.js`).

## Riesgos abiertos

- `sameCard` (LWW por tarjeta): todo campo nuevo debe enumerarse o el sync lo pisa entre dispositivos.
- `buildQueue` filtra por `c.front`: sin arreglo, las tarjetas visuales no entran a la sesión.
- Payload de imagen: reusar el tope `maxPx` de `captureRegionImage` (1024) — sin guard hoy en `_chatVision`.
- Export Anki: decidir si las tarjetas visuales se exportan como texto o se omiten con aviso.
