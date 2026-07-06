# DECISIONS.md — BookReader (IA / Agente)

Registro de decisiones de arquitectura (ADR ligero) del **agente de IA**: el _qué_ y,
sobre todo, el _porqué_. Lo pendiente vive en [`BACKLOG.md`](BACKLOG.md); lo entregado, en
[`CHANGELOG.md`](CHANGELOG.md). Aquí se documenta el razonamiento para no re-litigar
decisiones ni perder el contexto que llevó a ellas.

Formato de cada entrada: **Contexto → Decisión → Porqué → Consecuencias**. Estado:
`ACEPTADA` · `SUPERADA por ADR-N` · `PENDIENTE` (decidida pero no implementada).

---

## ADR-001 — Retrieval a nivel de PASAJE, no de capítulo · `ACEPTADA`

**Contexto.** La primera versión (IA1) recortaba el contexto por **capítulo**: puntuaba
cada capítulo del TOC contra el _objetivo_ de la conversación y metía capítulos enteros
hasta un presupuesto de tokens. Falló en un caso real (DDIA, "flashcards del capítulo 9"):
el capítulo más relevante del libro (0.95) quedó fuera porque, siendo grande, el
empaquetado codicioso metió varios capítulos pequeños en su lugar.

**Decisión.** Recuperar **pasajes** (los bloques `[[aN]]` que ya produce
[`segment.js`](js/ai/segment.js)), no capítulos.

**Porqué.** El capítulo (~30k tokens) es una unidad demasiado gruesa: entra entero o no
entra. A nivel de pasaje nunca "no cabe un capítulo"; se meten los N mejores párrafos de
donde sea, con recall mucho mayor y sin que un capítulo grande expulse a otros. Es la
granularidad estándar de cualquier RAG serio.

**Consecuencias.** Índice por pasaje ([`js/ai/retrieval.js`](js/ai/retrieval.js)). Cada
pasaje conserva su CFI (cita) y su capítulo (metadato). Ver ADR-006 para la atribución de
capítulo. IA1/[`context.js`](js/ai/context.js) queda superado para la selección de _libro_
(la selección de _historial_ de IA1 se mantiene).

---

## ADR-002 — Recuperar por PREGUNTA, no una vez por objetivo · `ACEPTADA`

**Contexto.** IA1 seleccionaba el contexto **una sola vez por conversación** contra el
objetivo. Preguntar por el capítulo 9 no lo traía: solo se forzaba el capítulo donde estaba
el lector.

**Decisión.** Recuperar en **cada turno**, con la pregunta como query.

**Porqué.** El objetivo es estable pero cada pregunta pide cosas distintas. Un sistema
ciego a la query no puede servir "explícame el consenso" si el objetivo no lo priorizó.
Recuperar por pregunta es el comportamiento esperable de un asistente sobre un documento.

**Consecuencias.** `buildContext(question)` en [`js/ai/panel.js`](js/ai/panel.js) corre en
cada `deliver()`. Coste: un pase BM25 en memoria por turno (milisegundos, sin red).

---

## ADR-003 — BM25 primero; embeddings después · `ACEPTADA` (embeddings `PENDIENTE`, Fase 2)

**Contexto.** El retrieval semántico "de libro" usa embeddings. Pero somos **BYOK**: no
todos los proveedores exponen `/embeddings`, y no queremos un backend (la app es
local-first, GitHub Pages).

**Decisión.** Empezar con **BM25 léxico** en el navegador. Los embeddings (+ fusión híbrida)
son una **fase posterior**, activada solo si el proveedor los expone.

**Porqué.**
- BM25 sirve a **cualquier** proveedor, es determinista, gratis y sin dependencias.
- Es **fuerte justo donde fallaba** el recorte por objetivo: nombres propios y locators
  ("capítulo 9", "Raft", "consensus", "linearizability").
- Los embeddings mejoran el _recall_ semántico (paráfrasis), pero es un refinamiento, no un
  prerrequisito: entregan ~20% extra sobre el 80% que ya da BM25 + router.

**Consecuencias.** Cero coste/latencia añadidos hoy. Cuando lleguen embeddings: calcular una
vez por libro, cachear en IndexedDB, coseno en JS, fusión RRF con BM25. Ver IA5 Fase 2 en el
[`BACKLOG.md`](BACKLOG.md).

---

## ADR-004 — Router de capítulo determinista · `ACEPTADA`

**Contexto.** "flashcards del capítulo 9" no tiene palabras de contenido: BM25 no encuentra
nada relevante con esa query. La intención es estructural, no semántica.

**Decisión.** Un **router** ([`retrieval.js`](js/ai/retrieval.js) `matchChapters`) detecta
referencias estructurales explícitas (número: "capítulo 9"/"chapter 9"; o título) y trae ese
capítulo entero, además de expandir la query BM25 con el **título** del capítulo.

**Porqué.** Resolver el caso reportado de forma **determinista** (no dependiente del azar
léxico). La expansión por título recupera el contenido del capítulo por tema aunque la
etiqueta variara.

**Consecuencias.** El caso "dame el capítulo N" funciona siempre que el capítulo esté bien
atribuido (ADR-006). Prioridad de relleno en `buildContext`: (1) capítulos nombrados →
(2) BM25 de todo el libro → (3) capítulo del lector.

---

## ADR-005 — Grounding honesto: el modelo sabe que ve un EXTRACTO · `ACEPTADA`

**Contexto.** Con el recorte, al modelo se le entregaba el texto como "LIBRO ANOTADO" sin
avisar de que era parcial. Ante una pregunta cuyo capítulo no estaba en el recorte, el modelo
**inventaba** que el usuario le había pegado un texto incompleto y **pedía que pegara más** —
absurdo en una app donde el libro entero ya está cargado.

**Decisión.** El system prompt ([`panel-template.js`](js/ai/panel-template.js)) recibe el
**TOC completo como mapa** y declara explícitamente que el texto es un **extracto recuperado**.
Si falta algo: que lo diga y sugiera abrir/nombrar el capítulo — **nunca** pedir que peguen
texto.

**Porqué.** Un modelo que no sabe que su contexto está filtrado alucina explicaciones
falsas. Darle el mapa del libro le permite saber que el capítulo _existe_ aunque no esté en
el extracto, y comportarse con coherencia con el producto.

**Consecuencias.** Requiere pasar `tocLabels` al prompt en cada turno (barato).

---

## ADR-006 — La atribución de capítulo usa SOLO etiquetas del TOC · `ACEPTADA`

**Contexto.** `segment.js` emite un marcador `## X` por **cada encabezado** (H1–H6), no solo
por capítulo. La primera versión de `parsePassages` tomaba todo `## ` como frontera de
capítulo, así que los pasajes del cap. 9 quedaban atribuidos a sus **subtítulos**
("Linearizability", "Total Order Broadcast"…) y `passagesByChapter("9. …")` devolvía casi
nada. Este fue el bug que hizo que el agente siguiera "sin ver" el capítulo 9 tras el fix
inicial.

**Decisión.** `parsePassages(annotated, anchors, tocLabels)` solo **abre capítulo** cuando la
etiqueta está en el TOC; los subtítulos heredan el capítulo en curso (igual que ya hacía
[`context.js`](js/ai/context.js)). Complemento: `passagesByChapter` con matching tolerante
(por número o núcleo del título).

**Porqué.** El "capítulo" de un pasaje debe ser su capítulo del TOC, no el subtítulo más
cercano. Sin esto, todo el retrieval por capítulo (ADR-004) es inútil en libros con muchos
encabezados.

**Consecuencias.** Verificado sobre el DDIA real: el cap. 9 pasa de un puñado de pasajes a
543. Test de regresión determinista en [`tests/retrieval.spec.ts`](tests/retrieval.spec.ts).

---

## ADR-007 — Presupuesto de contexto adaptativo · `ACEPTADA`

**Contexto.** Presupuesto fijo de 60k tokens de libro por turno. Un capítulo grande (DDIA
cap. 9 ≈ 60k) lo llena entero, sin margen; capítulos aún más largos se truncarían al pedir
"dame el capítulo entero".

**Decisión.** Presupuesto **por turno según la intención**: turnos normales mantienen el
límite lean (60k, baratos); cuando el usuario **nombra un capítulo** (intención de leerlo
entero) se amplía el margen hasta un techo (~110k) para que quepa completo. El guard de
tokens (aviso "esto es grande/caro") se mantiene como red para casos patológicos.

**Porqué.** No inflar el coste de cada pregunta por un caso minoritario. El coste extra solo
se paga cuando el usuario pide explícitamente un capítulo completo, que es cuando lo vale.

**Consecuencias.** Constantes `CTX_BUDGET` / `CTX_BUDGET_CHAPTER` en
[`panel.js`](js/ai/panel.js). Alternativa descartada: subir el base a 100k para todos
(encarece cada turno sin necesidad).

---

## ADR-008 — Reintentos con backoff en errores transitorios (IA3) · `ACEPTADA`

**Contexto.** Ante 429 (rate limit) o 5xx del proveedor, o un fallo de red puntual, la app
solo mostraba el error. Los proveedores BYOK (nan, OpenRouter…) dan 429/503 transitorios con
frecuencia.

**Decisión.** `fetchRetrying` en [`llm.js`](js/ai/llm.js): reintenta ante red caída y estados
retryables (408, 425, 429, 500, 502, 503, 504) con **backoff exponencial + jitter**,
honrando la cabecera **`Retry-After`** cuando viene. 3 reintentos. Respeta `AbortSignal`. El
reintento ocurre **antes** de empezar a consumir el stream (no se re-emiten tokens ya
mostrados).

**Porqué.** La mayoría de estos fallos se resuelven solos en segundos; reintentar con backoff
es el patrón estándar y evita que un hipo del proveedor rompa la conversación. Honrar
`Retry-After` es cortés con el rate limit y más efectivo que un backoff ciego.

**Consecuencias.** Helpers puros y testables (`isRetryableStatus`, `parseRetryAfter`,
`backoffDelay`). Usado por `chatStream` y `chatTools`. Las llamadas ya estaban serializadas
(nan rechaza concurrencia), así que el backoff no solapa peticiones.

---

## ADR-009 — Retrieval agéntico (herramientas), gateado, sin perder streaming · `ACEPTADA`

**Contexto.** El retrieval por defecto es **pre-inyección**: `buildContext` decide el contexto
y se streamea la respuesta. La alternativa **agéntica** expone `search_book`/`read_chapter` y
deja que el modelo pida lo que necesita — pero añade round-trips/latencia y, en BYOK, los
`tool_calls` solo son fiables **sin streaming** (nan/DeepSeek).

**Decisión (diseño final).** Recolección agéntica **en dos fases, gateada**:
1. **Fase de recolección** (no-streaming, `chatToolsLoop` en [`llm.js`](js/ai/llm.js)): el
   modelo llama a `search_book`/`read_chapter`; ejecutamos el retrieval local y le devolvemos
   pasajes citables. Su único trabajo es **reunir contexto**, no responder.
2. **Fase de respuesta** (streaming, como siempre): se streamea la respuesta con el contexto
   inicial **fusionado** con lo que el agente recolectó.
   
   La Fase 1 **solo se activa en turnos difíciles**: sin capítulo nombrado (router) y con pocos
   aciertos BM25 (`bm25Count < AGENTIC_MIN_HITS`). Los turnos normales van directos a streaming.

**Porqué.** Este diseño concilia las tres restricciones: (a) **preserva el streaming** en el
90% de turnos (los normales); (b) respeta que los `tool_calls` BYOK van sin streaming (la fase
de recolección lo es); (c) solo paga la latencia extra cuando el retrieval léxico es débil, que
es justo cuando aporta. Se descartó "tools siempre en cada turno" (rompería el streaming en
todos) y "un único paso streaming con tools" (no fiable en BYOK).

**Consecuencias.** `chatToolsLoop` preserva `tool_call_id` y hace hasta N rondas; la última
fuerza `tool_choice:'none'` para cerrar. Degrada con gracia: si la recolección falla, se
responde con el contexto inicial. Constantes `AGENTIC_MIN_HITS`, `AGENTIC_MAX_ROUNDS` en
[`panel.js`](js/ai/panel.js). Tests en [`tests/llm.spec.ts`](tests/llm.spec.ts).

---

## ADR-010 — Ventana de historial fija; resumen rodante diferido · `ACEPTADA` (resumen `PENDIENTE`)

**Contexto.** El chat completo puede crecer mucho; reenviarlo entero cada turno es caro.

**Decisión.** Reenviar solo los **últimos N mensajes** (ventana, hoy 6). El resumen rodante
de lo que sale de la ventana queda **diferido** (IA1 Fase 3).

**Porqué.** La ventana da el 90% del beneficio con cero coste extra. El resumen rodante añade
una llamada LLM por turno; solo compensa en conversaciones muy largas, que son minoría.

**Consecuencias.** `HISTORY_MSGS` en [`panel.js`](js/ai/panel.js). El chat completo sigue
guardado y visible; solo no se manda entero al modelo.

---

## ADR-011 — Sentence-window: expandir vecinos del pasaje · `ACEPTADA`

**Contexto.** El retrieval por pasaje puede devolver fragmentos **sueltos** (un párrafo cuyo
sentido depende del anterior/siguiente), lo que degrada la coherencia de lo que lee el modelo.

**Decisión.** Cada acierto BM25 arrastra sus **vecinos inmediatos** en orden de lectura (±1,
mismo capítulo) antes del empaquetado por presupuesto. `withNeighbors` en
[`retrieval.js`](js/ai/retrieval.js).

**Porqué.** Es el patrón _sentence-window / small-to-big_ de RAG: recuperar preciso (el pasaje
relevante) pero **entregar con contexto** (sus vecinos). Barato (un `Map` de posiciones) y
mejora la coherencia sin inflar demasiado el presupuesto. No cruza frontera de capítulo (un
vecino de otro capítulo no aporta contexto local).

**Consecuencias.** `buildIndex` guarda `pos` (id → índice). Solo se aplica a los aciertos BM25
(los capítulos nombrados ya vienen enteros). Radio 1 por defecto.

---

## ADR-012 — Evaluación del retrieval (recall@k) · `ACEPTADA`

**Contexto.** "Mejoré el retrieval" sin medir es fe. Cada cambio (BM25, router, vecinos,
futuros embeddings) puede subir o bajar la calidad sin que se note.

**Decisión.** Un arné de evaluación mínimo: un conjunto **dorado** (pregunta → pasaje esperado)
y la métrica **recall@k** (¿está el pasaje esperado en el top-k?). Hoy sobre corpus sintético
en [`tests/retrieval.spec.ts`](tests/retrieval.spec.ts), como **suelo de regresión** (falla el
test si el recall baja).

**Porqué.** Convierte la calidad del retrieval en un número reproducible y en una red de
seguridad. Es el paso que separa ingeniería de tuneo a ojo (lo que ya avisaba ADR-003).

**Consecuencias.** Ampliable a conjuntos dorados por libro real cuando haya embeddings (Fase 2)
para comparar BM25 vs híbrido con la misma vara.

---

## ADR-013 — IA2: interrupción al TERMINAR capítulo (no en "puntos de quiebre") · `ACEPTADA`

**Contexto.** IA2 ("Pepito Grillo", modelado de comportamiento) quería que el agente interrumpa
para forzar recuerdo activo. El backlog lo planteaba como "puntos de quiebre" del libro.

**Decisión.** El disparador es **el fin de capítulo**: al ENTRAR en un capítulo nuevo (no
visto), el anterior se da por terminado y, **con la plantilla HQ&A activa**, el agente
interrumpe con **UNA** pregunta de recuerdo sobre ese capítulo (sin dar la respuesta). Solo
hacia delante (no al volver atrás) y una vez por capítulo.

**Porqué.** "Punto de quiebre" es difuso, caro (requiere análisis semántico continuo) y
propenso a interrumpir de más. El fin de capítulo es una frontera **natural, barata y
predecible** (ya tenemos el evento de capítulo), y es justo el momento pedagógico para
consolidar (efecto de test). Se ata a **HQ&A** porque es la plantilla de recuerdo activo; en
otras no encaja. Elegido por el usuario frente a "puntos de quiebre" / "solo a petición".

**Consecuencias.** epub-reader emite `reader:chapter-changed` solo en cambio real; el panel
([`panel.js`](js/ai/panel.js)) gatea por plantilla HQ&A + key + no-ocupado y genera la pregunta
con los pasajes del capítulo. Respeta INFO/COGNICIÓN (no responde). Test de emisión en
[`tests/chapter-event.spec.ts`](tests/chapter-event.spec.ts). Extensible a otras plantillas o
a un modo "solo a petición" si se pide.

---

## ADR-014 — Embeddings (Fase 2) aplazados · `PENDIENTE` (decisión: no ahora)

**Contexto.** La Fase 2 de IA5 añadiría retrieval semántico (embeddings) + fusión híbrida con
BM25.

**Decisión.** **Aplazar.** No se construye por ahora.

**Porqué.** (1) BM25 + router + sentence-window ya cubren la mayoría de casos (ADR-003 lo
estimaba en ~80%); (2) depende de que el proveedor BYOK exponga `/embeddings`, que no está
garantizado; (3) no es verificable de extremo a extremo sin un proveedor real, así que
entregarlo sería enviar código no probado del todo. El coste/riesgo supera al beneficio
marginal hoy. Decidido con el usuario.

**Consecuencias.** Queda documentado en el [`BACKLOG.md`](BACKLOG.md) como IA5 Fase 2. Cuando se
retome: calcular embeddings una vez por libro, cachear en IndexedDB, coseno en JS, fusión RRF
con BM25, y medir con el arné de ADR-012 (BM25 vs híbrido) para justificar el cambio.

---

## ADR-015 — PDF: mismo pipeline de retrieval, locator de página · `ACEPTADA`

**Contexto.** El agente ya leía EPUB (segmentación → anclas `[[aN]]`→CFI → BM25/router/vecinos). Para
que lea PDF (los O'Reilly del usuario) había dos caminos: (a) un pipeline nuevo específico de PDF, o
(b) reusar el existente produciendo el mismo "libro anotado" desde el PDF.

**Decisión.** (b). `js/ai/segment-pdf.js` emite el **mismo formato** que `segment.js` (`## capítulo` +
`[[aN]] texto`), cambiando solo el **locator de la ancla: número de página** en vez de CFI. `setBook`
recibe `{format}` y ramifica el segmentador; el resto del pipeline (BM25, router, sentence-window,
agéntico, MAPA, grounding) es idéntico. La cita clicable navega con `PdfReader.goTo(page)`.

**Porqué.**
1. **Una sola fuente de verdad de retrieval.** Todo lo probado y afinado para EPUB (ADR-002..012)
   aplica tal cual; no se duplica lógica ni tests.
2. **Página como locator es lo honesto en PDF.** El PDF no tiene DOM estable ni CFIs; la página es la
   unidad navegable real. Basta para citar y saltar.
3. **Capítulos por `getOutline()` con solo nivel superior abriendo capítulo.** Mismo criterio que el
   TOC del EPUB: las subsecciones son marcadores `##` que **heredan** el capítulo padre, evitando el
   bug de atribución que ya nos mordió con "capítulo 9" en DDIA (ADR-006). Verificado sobre el PDF de
   Albada (355 pág → 13 capítulos limpios, 1505 pasajes).
4. **PDF escaneado se detecta, no se finge.** Si la muestra inicial no tiene texto, se avisa y no se
   indexa (coherente con ADR-005: no inventar contexto). OCR queda fuera de alcance.

**Consecuencias.** La caché de segmentación (`db.js`) es agnóstica (`entries` genéricos), así que el
`{page,chapter}` persiste sin cambios de esquema. La atenuación por capítulo (ADR-oriented a EPUB)
degrada limpia en PDF (sin `navigation.toc` → no-op). PDF2/PDF3 (selección→agente, subrayados)
construirán sobre esto.

---

## ADR-016 — Subrayados de PDF: ancla `{página, rects}` en coords fraccionales · `ACEPTADA`

**Contexto.** Los subrayados del EPUB se anclan por CFI y se pintan con `rendition.annotations`
(epub.js). El PDF no tiene ni CFI ni ese sistema de anotaciones: es un canvas rasterizado con una capa
de texto transparente encima.

**Decisión.** Modelo de ancla propio para PDF: `{page, rects}`, donde `rects` son los rectángulos de la
selección en **coordenadas fraccionales (0..1)** relativas a la página. Se dibujan como un overlay de
`<div>`s (`.pdf-hl-layer`, `mix-blend-mode: multiply`, `pointer-events:none`) sobre el canvas, re-pintado
en cada render de página. Conviven con el modelo CFI: identidad genérica `id ?? cfi`; `highlights.js`
gana `addPdf/getByPage/removeById` sin tocar el camino EPUB.

**Porqué.**
1. **Fraccional, no píxeles.** El canvas se re-renderiza a distinto tamaño según zoom/HiDPI (ADR-oriented
   a TEC1). Guardar píxeles ataría el subrayado a una escala concreta; las fracciones se re-escalan al
   tamaño actual del wrapper y quedan siempre nítidas y alineadas.
2. **Overlay propio, no `annotations`.** `rendition.annotations` es de epub.js; el PDF necesita su
   propia capa. `pointer-events:none` mantiene la capa de texto de encima seleccionable.
3. **Convivencia sin refactor arriesgado.** El EPUB (muy probado) no se toca; solo se generaliza la
   identidad y el render de la lista.

**Consecuencias.** El export ya contemplaba `page`, así que sale gratis. HQ&A al subrayar sigue atado al
evento `selected` de epub.js (mejora futura para PDF). **Efecto colateral positivo:** al probar el
re-pintado se destapó una re-entrancia de `renderPage` (dos `render()` sobre el mismo canvas al pasar
páginas rápido); se arregla cancelando el `RenderTask` en curso antes de iniciar otro.

---

## ADR-017 — Modo scroll de PDF: render por-wrapper + lazy con IntersectionObserver · `ACEPTADA`

**Contexto.** El EPUB ya tiene modo scroll (epub.js `scrolled-doc`). El PDF renderizaba una sola página
reutilizando un `.pdf-page`. Para el modo continuo hay que montar muchas páginas; un PDF de O'Reilly
ronda las 300-500. Pintarlas todas a la vez (canvas HiDPI) reventaría la memoria del navegador.

**Decisión.** Render **por wrapper** con `data-page` (común a paginado y scroll: `renderInto(wrapper,
n)`). En scroll se crean N placeholders dimensionados con el aspecto de la página 1, y un
**IntersectionObserver** (root = contenedor, `rootMargin` amplio) pinta las páginas al acercarse al
viewport y **libera** (canvas 0×0, capas vacías) las que se alejan. La página actual se deriva de la
posición de scroll (la más centrada). El modo se recuerda por libro.

**Porqué.**
1. **Memoria acotada.** Solo ~2-3 canvas vivos a la vez, sin importar el nº de páginas (verificado:
   355 páginas → 2-3 renderizadas). Es la única forma sostenible de scroll continuo en PDF.
2. **Placeholders dimensionados por adelantado.** Da la altura total correcta (scroll y observer
   funcionan) sin cargar las N páginas; se asume aspecto uniforme (cierto en la práctica; si una
   difiere, se re-dimensiona al pintarse).
3. **Un solo camino de render (`renderInto`).** Paginado y scroll comparten HiDPI, capa de texto y la
   cancelación de `RenderTask` —ahora **por wrapper**— así que PDF3 (subrayados por `data-page`) y el
   fix de re-entrancia (ADR-016) siguen valiendo en ambos modos sin duplicar lógica.

**Consecuencias.** La selección/subrayado usa el `data-page` del wrapper que contiene la selección
(correcto con varias páginas montadas). Zoom por pinch/tipografía siguen fuera de alcance (PDF5, límite
de formato). Si aparecieran PDFs con páginas de tamaños muy dispares, habría que medir cada página para
el placeholder (hoy no compensa).

---

## ADR-018 — Visión: enrutado por capacidad (modelo de texto + modelo de visión) · `ACEPTADA`

**Contexto.** El agente lee el PDF por su TEXTO (`getTextContent`), pero una **figura/diagrama es
píxeles**: no está en el extracto y el modelo por defecto (`deepseek-v4-flash`) es solo-texto. Ante
"explícame la Figure 6.2" lo honesto era decir "no la veo" (grounding, ADR-005), pero el usuario quiere
una respuesta. nan ofrece modelos con visión, así que la capacidad está disponible en el mismo BYOK.

**Decisión.** **Enrutado por capacidad, no un único modelo multimodal para todo.** Se añade un
**modelo de visión configurable e independiente** (`ai_vision_model`) del modelo de texto. El RAG/chat
sigue en el modelo de texto barato; **solo el turno que necesita ver una página** se manda al modelo de
visión. Disparador explícito: acción **"Explicar lo que veo"** en el composer (solo PDF) que captura la
**página actual** del canvas ya renderizado (`capturePageImage`, reescalada a ~1024px JPEG), adjunta el
texto extraído de esa página como contexto, y hace **un** turno multimodal (`content` con `image_url`,
formato OpenAI-compatible). La respuesta cae en el mismo chat/libreta.

**Porqué.**
1. **Coste/latencia acotados.** El 95% de turnos son texto; pagar visión en todos (modelo único
   multimodal) sería más caro y lento sin beneficio. Se escala solo cuando hay una figura de por medio.
2. **Separación de capacidades y agnosticismo.** Texto y visión son ejes independientes; cualquier VL
   OpenAI-compatible (nan, gpt-4o, gemini…) encaja sin tocar el RAG ya afinado (capa aditiva).
3. **Explícito antes que mágico.** Un botón discoverable, el usuario controla cuándo se envía la imagen
   (coste/privacidad). La localización automática por "Figure N.M" queda como v2.
4. **Se descarta la visión como *tool* del bucle agéntico:** los `role:'tool'` de la API OpenAI son
   solo-texto; devolver una imagen como resultado de tool no es portable → inyectamos la imagen en el
   turno de usuario.

**Consecuencias.** Sin modelo de visión configurado, la acción **degrada honesto** (guía a configurarlo,
no finge ver). Reescalar la imagen acota tokens. **Bonus:** es el camino natural para leer **PDFs
escaneados** (sin texto, la visión es la única vía). Pendiente v2: auto-detectar "Figure N.M" y localizar
su página por el índice BM25; y "explicar lo que veo" en EPUB (necesitaría rasterizar el iframe).

---

## ADR-019 — Zoom fluido de PDF: oversample + transform, sin re-render · `ACEPTADA`

**Contexto.** El pinch-zoom en móvil re-renderizaba el canvas con pdf.js al soltar (la "recarga" que
notaba el usuario) y el preview salía borroso (el canvas estaba pintado solo al zoom actual). Se pedía
fluidez tipo Adobe —zoom sin re-rasterizar— y en **ambos modos** (paginado y scroll), porque el scroll
continuo es la forma natural de leer PDFs técnicos en móvil/tablet.

**Decisión.** **El zoom vive en el layout, no en pdf.js.** El canvas se pinta **oversampleado**
(`fit·OVERSAMPLE·dpr`, con tope `MAX_BACKING_PX`), así ampliar hasta ~OVERSAMPLE× sigue nítido escalando
el bitmap por CSS, **sin volver a rasterizar**. Estructura por página:
`.pdf-page` = caja de tamaño **fit·zoom** (define el área de scroll → **paneo nativo**) que contiene un
`.pdf-scaler` (tamaño fit, `transform: scale(zoom)`) con el canvas + la capa de texto. Las páginas viven
dentro de `#pdf-zoom-layer`.
- **Durante el pinch** (2 dedos, touch events): escalamos EN VIVO el `#pdf-zoom-layer` (`transform`, GPU,
  mantecoso), anclado al punto medio de los dedos. **1 dedo = scroll/selección nativos** (no se tocan).
- **Al soltar, "horneo":** cada caja pasa a fit·zoom y su scaler a `scale(zoom)` (una operación de layout),
  y se reposiciona el scroll para mantener el foco bajo los dedos. **Cero llamadas a pdf.js.**
- Subrayados PDF pasan a **porcentajes** → escalan solos con la caja, sin recalcular.

**Porqué.**
1. **Fluidez real.** El zoom/paneo es compositor puro (transform + scroll nativo); nunca toca CPU/render.
2. **Sin "recarga".** El canvas no se recrea ni se re-rasteriza al hacer zoom (verificado: mismo canvas,
   `backing` intacto).
3. **Unificado.** Mismo modelo en paginado y scroll; el paneo es siempre scroll nativo → **conserva
   selección de texto, subrayados e inercia** sin lógica de paneo propia.
4. **Nitidez acotada por memoria.** Oversample con tope del lado mayor del canvas; el lazy de scroll
   (ADR-017) mantiene ~2-3 canvas vivos.

**Consecuencias.** Más allá de ~OVERSAMPLE× el bitmap se ablanda (aceptable en el rango de lectura); un
**re-render progresivo** al quedarse quieto a zoom alto queda como mejora futura (F4). Tests en
[`tests/pdf.spec.ts`](tests/pdf.spec.ts): anclaje focal, cero re-render (canvas/backing intactos) y zoom
en modo scroll.

## ADR-020 — Export a Anki: .apkg client-side con sql.js (+ 'wasm-unsafe-eval' en CSP) · `ACEPTADA`

**Contexto.** La feature estrella del plan de lanzamiento es exportar flashcards a Anki. El formato
nativo `.apkg` (un zip con una SQLite `collection.anki2`) es lo que da la experiencia "doble clic y
las tarjetas aparecen en Anki" en Desktop/AnkiDroid/AnkiMobile; el import de texto exige pasos manuales.
Generar una SQLite en el navegador requiere WebAssembly (sql.js) y la CSP era `script-src 'self'` a secas.

**Decisión.** **Builder propio de `.apkg` (esquema legacy v11, el que siguen genanki y aceptan todos los
clientes) sobre sql.js vendorizado** (`vendor/sql-wasm-1.13.0.*`), cargado **perezosamente** solo al
exportar (660 KB de wasm fuera del arranque). El zip lo hace JSZip (ya vendorizado). Se añade
**`'wasm-unsafe-eval'` a `script-src`**: permite únicamente compilar wasm **de mismo origen**, no habilita
`eval()` de JS — la protección de la API key (bloquear JS inyectado) queda intacta. Modelos propios con
id fijo ("BookReader Basic"/"BookReader Cloze") para no chocar con los del usuario y que re-importar
actualice en vez de duplicar. Se ofrece además **`.txt`** (cabeceras `#separator/#notetype column/#deck`)
como fallback sin wasm.

**Porqué.** (1) Sin backend: todo local, coherente con el posicionamiento privacy-first. (2) Escribir el
esquema a mano (~150 líneas) evita depender de genanki-js (licencia/peso) manteniendo compatibilidad
verificada: el paquete se valida en tests con un round-trip real (unzip + abrir la SQLite + consultas)
y con `sqlite3` nativo (integrity_check ok). (3) La carga perezosa mantiene el TTI y el precache PWA
sirve el wasm offline.

**Consecuencias.** El esquema legacy no incluye scheduling moderno (irrelevante: se exportan tarjetas
nuevas). Si Anki retirase el import legacy (no anunciado), habría que emitir `collection.anki21b`.
Tests en [`tests/flashcards.spec.ts`](tests/flashcards.spec.ts).
