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

## Tareas de implementación (ODD, work units)

- [x] **WU1** Spec + evidencia de grounding + anclajes → `odd/tasks/tarjetas-visuales.md` (`7152577`)
- [x] **WU2** `app/js/ai/figures.js` + `tests/figures.spec.ts` (5 tests, eslint limpio)
- [ ] **WU3** `app/js/ai/visual-cards.js`: prompts 1–3 + parsers/validadores puros
      (incluye validador de SVG) + tests con `fetch` stubbeado
- [ ] **WU4** Menú de tipos en `renderSetup()` (`flashcards.js`) + ramificación de generación
- [ ] **WU5** Render por tipo en estudio (`study.js`): oclusión (overlay %), diagrama (SVG),
      dibujo (canvas) + arreglar `buildQueue` para tarjetas sin `front`
- [ ] **WU6** Revisión del boceto con `chatVision` + pintado por colores de trazo
- [ ] **WU7** Sync/export: campos visuales en `sameCard`; comportamiento definido en export Anki
- [ ] **WU8** Docs: CHANGELOG, BACKLOG, DECISIONS + evals/check determinista si aplica

## Riesgos abiertos

- `sameCard` (LWW por tarjeta): todo campo nuevo debe enumerarse o el sync lo pisa entre dispositivos.
- `buildQueue` filtra por `c.front`: sin arreglo, las tarjetas visuales no entran a la sesión.
- Payload de imagen: reusar el tope `maxPx` de `captureRegionImage` (1024) — sin guard hoy en `_chatVision`.
- Export Anki: decidir si las tarjetas visuales se exportan como texto o se omiten con aviso.
