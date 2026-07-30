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

**Consecuencias.** Más allá de ~OVERSAMPLE× el bitmap se ablanda. Esa consecuencia queda **resuelta en
[ADR-025](#adr-025)**, que añade una segunda capa de detalle y permite abaratar el base. Tests en
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

## ADR-021 — Gateway de tokens propios: Worker+D1, alias de modelos, 403 al agotar · `ACEPTADA`

**Contexto.** MON1 F1: primer backend del proyecto — un proxy OpenAI-compatible para la demo sin
fricción del LAUNCH_PLAN (probar el agente sin conseguir API key). El cliente no cambia: base URL
y key ya son configurables.

**Decisiones.**
1. **Vive en `workers/gateway/` de este repo** (no repo propio): mismo patrón que `workers/auth`
   (sync). Un solo repo mientras una sola persona lo opere; separarlo es barato después.
2. **Contadores en D1, no Durable Objects.** El decremento atómico con
   `UPDATE … WHERE remaining > 0 RETURNING` elimina la carrera leer-escribir sin serializar
   nada; a escala demo, D1 sobra y es más simple de inspeccionar (SQL directo por CLI).
3. **Alias propios desde el día uno** (`bookreader-fast`, `bookreader-vision`) con tabla de
   routing de una fila por alias → `{provider, model, caps}`. El usuario nunca ve nombres del
   proveedor: cambiar de proveedor no rompe ninguna config guardada. Barato ahora, caro de
   retrofitear.
4. **Demo agotada → HTTP 403, no 429** (desviación consciente de la spec del BACKLOG): el
   cliente (IA3, `fetchRetrying`) reintenta los 429 con backoff — reintentar una cuota agotada
   solo quema tiempo; el 403 aflora el mensaje ("añade tu propia key, BYOK") a la primera.
5. **Retención cero**: el body upstream se devuelve en streaming sin parsearlo ni registrarlo;
   observability solo captura errores del propio Worker. Coherente con el posicionamiento
   privacy-first (y con lo que promete la landing).
6. **Riesgo aceptado F1 — key única compartida**: nan rechaza concurrencia por key; los
   reintentos del cliente absorben transitorios a tráfico demo. Pool de keys / cola (F2) solo
   si la telemetría muestra colisiones reales.

**Consecuencias.** MON2 puede emitir tokens Pro contra esta misma tabla (columna `license_key`
ya existe). El `X-Quota-Remaining` habilita UI de "te quedan N" en F3 (demo self-service).
Verificado end-to-end el 2026-07-15: modelos, chat, streaming SSE, agotamiento, revocación y
la app real respondiendo vía gateway (tests/gateway.spec.ts @live).

## ADR-022 — Routing de modelo por tarea: modelo lite para llamadas auxiliares · `ACEPTADA`

**Contexto.** Todas las llamadas de texto usaban UN modelo global (`ai_model`). Pero hay dos
clases de llamada con necesidades opuestas: las de **valor** (chat, resumen, flashcards,
mindmap — la calidad se nota y se cita) y las **auxiliares** (query-expand/HyDE y atenuación
del TOC — baratas, estructuradas y sensibles a latencia). Sondeo sobre nan (2026-07-16):
`deepseek-v4-flash` tarda ~2-4s porque razona incluso en tareas triviales; `qwen3.6` responde
en ~0.8s y soporta tools. La expansión además compite contra su propio timeout de 7s: cada
segundo de "pensar" es recall perdido.

**Decisiones.**
1. **`model` opcional en `chatStream`/`chatTools`** (fallback: `getModel()`). Las tareas de
   valor no pasan nada — siguen con el modelo principal.
2. **Resolución del modelo lite** (`getLiteModel()`): ajuste explícito del usuario
   (`ai_model_lite`, campo opcional en Ajustes) → `liteModel` del preset del proveedor →
   alias `bookreader-lite` si la base URL es el gateway → modelo principal. Solo el preset
   de nan declara `liteModel` (`qwen3.6`, verificado); en proveedores no verificados el
   comportamiento no cambia (cero regresión BYOK).
3. **Alias `bookreader-lite` en el gateway** (→ `qwen3.6`), siguiendo ADR-021: el cliente
   demo nunca ve nombres del proveedor.
4. **Fallo blando ya cubierto**: si un lite mal configurado no soporta tools o falla,
   query-expand devuelve `null` (búsqueda cruda) y attenuation devuelve `null` (sin teñir) —
   los dos caminos ya eran tolerantes a fallo por diseño (IA7, T8).

**Consecuencias.** Expansión y atenuación ~3-4x más rápidas en nan sin tocar la calidad de los
artefactos. Nuevo ajuste opcional "Modelo rápido" en Ajustes → Agente. La misma palanca sirve
para futuros usos auxiliares (rerank LLM, clasificar intención). De paso, `.appset-card` gana
`max-height` + scroll en escritorio: la sección Agente ya superaba la altura de viewports bajos
y el tope del modal quedaba inalcanzable (lo destapó gateway.spec.ts).

---

## ADR-023 — No adoptar LangGraph: la orquestación se mantiene hand-rolled · `ACEPTADA`

**Contexto.** El agente no usa ningún framework: la orquestación es control de flujo en
`panel.js` (contexto → ronda agéntica condicional con `chatToolsLoop` → streaming) sobre un
endpoint OpenAI-compatible vía `llm.js`. Recurrente la pregunta de si deberíamos montarlo sobre
**LangGraph**. Aclaración técnica primero: **LangGraph (Python) no corre en el navegador**;
**LangGraph.js** (`@langchain/langgraph`) sí —es JS, agnóstico del entorno—, así que "sin
backend" es viable. Pero orquestar no es llamar al modelo: la llamada al LLM seguiría saliendo
por `fetch` con la **key en el navegador**, igual que ahora (LangGraph no cambia ese perfil).

**Decisión.** **No adoptar LangGraph** por ahora; la orquestación sigue hand-rolled. Si en algún
momento se quiere más estructura sin la dependencia, adoptar el **patrón `StateGraph`** (estado
explícito + nodos + transiciones) en código propio, no la librería.

**Porqué.**
- **El flujo actual ya *es* el grafo, y más ligero.** Es casi lineal con una sola bifurcación
  (la puerta de retrieval débil, ADR-009) y una ronda de herramientas. LangGraph brilla en
  grafos de verdad —multi-agente, ciclos de auto-corrección, ramas densas— que hoy no tenemos.
- **Choca con la línea "lean, cero build".** Servimos **ES modules planos sin bundler**;
  LangChain.js + LangGraph.js pesa y obligaría a un pipeline de build. Cambiaríamos simplicidad
  por una abstracción que no explotamos.
- **Persistencia = trabajo extra.** El core corre en navegador, pero los checkpointers con
  estado (SQLite/Postgres) son solo-Node; `MemorySaver` no persiste. Para sobrevivir a recargas
  habría que escribir un checkpointer propio sobre IndexedDB.
- **Reconocer dónde SÍ pagaría** (para no re-litigar a ciegas): su `interrupt()` + checkpointer
  es exactamente el patrón human-in-the-loop que montamos a mano en `resolveBookScope` (pausar →
  pedir permiso con `confirmBox` → reanudar). Con UN solo punto de interrupción y sin necesidad
  de persistirlo entre sesiones, hacerlo a pelo es más barato que traer el framework.

**Reconsiderar si** el agente evoluciona hacia: varios sub-agentes coordinados, ciclos de
auto-corrección, o human-in-the-loop **con estado que deba sobrevivir a recargas**. En ese
escenario, el `interrupt`/checkpointing de LangGraph.js ahorra código real y justificaría montar
el bundler + un checkpointer sobre IndexedDB.

**Consecuencias.** El agente permanece sin dependencias de framework, en ES modules planos y sin
build step. La deuda que asumimos es que cualquier orquestación nueva (p. ej. el human-in-the-loop
de ADR sobre `resolveBookScope`) se implementa a mano; si se acumulan varios de esos patrones, se
reevalúa `StateGraph` propio antes que LangGraph.

---

## ADR-024 — Sync de biblioteca en dos ficheros y de binarios write-once, fuera del lock de sync · `ACEPTADA`

**Contexto.** El sync (Fases 0-2) llevaba anotaciones pero no la biblioteca ni los ficheros. Eso
producía un estado sin sentido: en el segundo dispositivo llegaban subrayados de libros que no
existían allí. Faltaba decidir tres cosas: qué estructura tiene la biblioteca en el proveedor, cómo
se sincronizan binarios de decenas de MB, y dónde va la línea de Pro.

**Decisión.**

1. **Dos ficheros para la biblioteca, separados por ritmo de escritura, no por tipo de dato.**
   `library.json` (fichas + estanterías) es ligero y se reescribe constantemente porque el progreso
   de lectura cambia mientras lees. `covers.json` (portadas en miniatura, JPEG a 200px) es ~90% del
   peso y solo cambia al añadir o quitar libros. En un único fichero, cada avance de página habría
   subido cientos de KB. El manifest lleva `libraryUpdatedAt`/`coversUpdatedAt` para no descargar
   ninguno de los dos cuando no han cambiado.

2. **Los binarios son write-once, sin merge ni concurrencia.** El `bookId` ya era el SHA-256 del
   fichero, así que `files/<bookId>` es contenido direccionable: si existe en remoto, es byte a byte
   el que subiríamos. Eso elimina etags, `ifMatch` y el bucle de 412 para los blobs, permite
   verificar la descarga re-hasheando, y hace que las anotaciones enganchen solas —el dispositivo
   que descarga obtiene el mismo hash, sin pasar por la reconciliación por título de `aliases.js`.

3. **Cola de ficheros con lock propio, fuera del ciclo de sync.** El ciclo corre bajo el Web Lock
   `bookreader-sync`; una descarga de 50 MB dentro de él dejaría a todas las pestañas sin
   sincronizar anotaciones durante minutos. `js/sync/blobs.js` tiene su propio lock
   (`bookreader-blobs`), es serie, prioriza descargas (el usuario las está esperando) sobre subidas
   (trabajo de fondo), y el engine solo la despierta al terminar.

4. **La línea de Pro va entre metadatos y bytes.** La Fase A (biblioteca, estanterías, portadas) es
   gratis: es barata y sin ella el sync de anotaciones está roto. Los ficheros son Pro: son lo que
   consume cuota de Drive y ancho de banda, y "tu biblioteca en todos tus dispositivos" es un
   argumento de compra más fuerte que "tus subrayados sincronizados".

5. **Techo de subida automática en 50 MB.** Por encima, el libro se sube solo si el usuario lo pide
   desde su menú. Gastar varios cientos de MB de la cuenta de Google de alguien sin que lo haya
   pedido no es una decisión que nos corresponda tomar por defecto.

**Alternativas descartadas.**
- *Un solo blob de biblioteca con las portadas dentro*: simple, pero convierte cada avance de página
  en una subida de cientos de KB. Es el error que ya cometía arete a otra escala.
- *Portadas como ficheros sueltos (`covers/<id>.jpg`)*: el ritmo de escritura sería óptimo, pero un
  dispositivo nuevo con 100 libros necesitaría 200 peticiones (buscar + descargar por portada) solo
  para pintar la rejilla. Un único `covers.json` cuesta una.
- *Subir los binarios dentro del ciclo de sync*: menos código, pero bloquea el sync de anotaciones
  de todas las pestañas durante toda la transferencia.
- *Sync de ficheros gratis y solo la IA de pago*: deja fuera el argumento de conversión más claro y
  regala la parte que cuesta ancho de banda.

**Consecuencias.** Aparece el estado "ficha fantasma" (libro en la biblioteca sin binario local),
que la UI tiene que representar y todo el código que abre libros tiene que contemplar
(`LibStore.hasFile`). El borrado pasa a ser lógico (tombstone) porque ahora se propaga. Y
`getAllBooks()` deja de devolver el binario —cargaba en memoria el de todos los libros para pintar
la rejilla—, así que quien necesite el fichero pide `getRaw(id)` explícitamente.

<a id="adr-025"></a>
## ADR-025 — PDF a zoom alto: capa de detalle bajo demanda (base barata + parche nítido) · `ACEPTADA`

**Contexto.** [ADR-019](#adr-019--zoom-fluido-de-pdf-oversample--transform-sin-re-render--aceptada) dejó
la nitidez atada al oversample del canvas base, y ese único bitmap tenía que servir para todo el rango
`ZOOM_MIN..ZOOM_MAX` (1..6). Con `OVERSAMPLE = 2.5` y tope `MAX_BACKING_PX = 3800`, una A4 salía a
~10 Mpx = **~40 MB de backing por página**; con el lazy de scroll (`rootMargin: 150%`) hay ~4 páginas
montadas a la vez, o sea **~150 MB solo en canvas** — medido: 148,7 MB en un viewport de 390×780 a
dpr 3. Ese es territorio donde iOS Safari descarta la pestaña, que el usuario vive como perder la
sesión de estudio. Y aun pagándolo, más allá de ~2,5× (en escritorio, donde el tope recortaba, ~1,5×)
la página seguía blanda: precisamente en figuras, tablas y fórmulas, lo único por lo que se amplía.
Subir el oversample no era salida: el coste crece con el zoom **y** con las páginas montadas.

**Decisión.** **Dos capas, como MuPDF/PDF.js.** El canvas base baja a `OVERSAMPLE = 1.5` /
`MAX_BACKING_PX = 3000` y deja de ser el responsable de la nitidez a zoom alto; encima, al **quedarse
quieto** (`DETAIL_IDLE_MS = 220`, tras zoom o paneo), se rasteriza **solo el trozo visible** a la
resolución exacta del zoom y se superpone como `canvas.pdf-detail` dentro del `.pdf-scaler` (recorte
vía `transform` en `page.render`, no reescalado). El parche está acotado por lado y por área
(`DETAIL_MAX_PX`, `DETAIL_MAX_AREA` ≈ 18 MB), así que **su memoria no crece con el zoom**: a más zoom,
menos página cabe en el mismo viewport.

**Porqué.**
1. **La base nunca se retira.** El parche solo AÑADE nitidez, así que en ningún instante del gesto hay
   hueco en blanco — el fallo clásico de los visores que re-rasterizan la vista al hacer zoom.
2. **El parche sobrevive al zoom.** Vive dentro del `.pdf-scaler` posicionado en **unidades fit**, así
   que sigue siendo geométricamente correcto a cualquier zoom posterior: al ampliar más se ablanda (y
   se repinta al parar), al reducir sobra resolución (y se suelta). Por eso **no hay que esconderlo
   durante el pinch**: escala con todo lo demás y el gesto sigue siendo compositor puro.
3. **Memoria: −64% medido.** 148,7 MB → **53,5 MB** (móvil dpr 3, 4 páginas montadas). Y el pico no
   empeora al ampliar: a zoom 4 y 6, **38,9 MB** incluido el parche (menos páginas visibles y patch
   acotado). De paso, cada página se rasteriza más rápido → menos placeholders vacíos en scroll rápido.
4. **Nitidez real de 1,5× a 6×**, que antes no existía a ningún precio razonable.

**Alternativas descartadas.**
- *Subir `OVERSAMPLE`*: paga la nitidez en TODAS las páginas montadas y en todo el rango de zoom, para
  un caso que solo ocurre parado y en un trozo de una página. Es justo el intercambio que este ADR
  invierte.
- *Jerarquía de tiles multi-resolución (SumatraPDF)*: correcta para un visor de escritorio nativo con
  zoom arbitrario sobre documentos enormes; aquí un solo parche por página visible cubre el caso real
  y evita gestionar una caché de tiles con invalidación propia.
- *Re-renderizar el base a la escala del zoom al soltar*: vuelve a meter pdf.js en el camino del gesto
  (lo que ADR-019 sacó) y el coste crece con el zoom sin tope.

**Consecuencias.** El preview EN VIVO durante el pinch ahora se ablanda antes (a partir de ~1,5×, y
en escritorio antes por el tope) porque el base es más barato; se resuelve solo al parar los dedos. Los
parches se sueltan en `refit` (cambia `fit` → las unidades dejan de encajar), en `freeWrapper` y en
`rerender`, y no se piden mientras hay un gesto en curso (`zoomPreviewing`), donde las medidas son las
del transform en vivo y no las del zoom horneado. Test en
[`tests/pdf.spec.ts`](tests/pdf.spec.ts): el parche aparece a zoom alto, es más denso que el base, el
base queda intacto, el orden es base → parche → capa de texto (seleccionable), el área está acotada y
al volver a zoom bajo el parche se suelta.

<a id="adr-026"></a>
## ADR-026 — Papel del PDF: tinte en multiply y noche por inversión, resueltos en CSS · `ACEPTADA`

**Contexto.** La app tiene tres temas (`light`/`sepia`/`dark`) y el PDF era la **única superficie
que los ignoraba**: el contenedor se teñía (`--surface-3`) pero la página seguía blanca. Leer de
noche en tema oscuro significaba un folio deslumbrando dentro de un marco negro. PDF5 había cerrado
el debate de "tema en PDF" concluyendo que el reflow es imposible y que el máximo alcanzable es zoom
+ un `invert`; esta decisión ejecuta ese máximo, sin reabrir el reflow.

**Decisión.** **Una sola palanca y todo el pintado en CSS.** `settings.js` resuelve el ajuste
`pdfPaper` (`auto` sigue al tema; si no, valor explícito) a un valor concreto y lo publica como
`data-pdf-paper` en `<html>`. Nadie más decide el papel. `pdf-reader.js` **no se toca**.

Debajo hay **dos mecanismos distintos**, y esa es la parte no obvia:
- **Tintes claros** (crema, sepia, gris) → capa en `multiply` (`.pdf-page::after`). Multiplicar solo
  puede **oscurecer**, que es exactamente lo que hace falta: papel blanco × crema = crema, y la tinta
  (ya negra) no se mueve.
- **Noche** → `invert(1) hue-rotate(180deg) contrast(0.88)` sobre los canvas. Un tinte **no sirve**:
  multiplicar por negro deja la página entera en negro, tinta incluida. Por eso «Noche» se presenta
  separada en la UI y no como un color más de la paleta.

**Porqué.**
1. **CSS y no rasterizado.** El cambio es instantáneo, no vuelve a pdf.js y no re-rasteriza nada, así
   que respeta ADR-019/025: el zoom sigue siendo compositor puro. La alternativa (`background` en
   `page.render`) obligaría a repintar **las dos capas** de cada página en cada cambio de color.
2. **El agente de visión sigue viendo la página real.** `capturePageImage`/`captureRegionImage` leen
   el canvas, que no se toca: teñir en CSS no contamina lo que se le manda al modelo. Con tinte al
   rasterizar, el modelo recibiría páginas sepia o en negativo. Hay un test que lo fija comparando
   la captura byte a byte entre papeles.
3. **Cero DOM nuevo por página.** El tinte es un `::after` del wrapper que ya existe, y solo se pinta
   cuando hay tinte (`display:none` por defecto): con papel blanco no se paga ni un contexto de mezcla.
4. **`hue-rotate` en noche.** Sin él, invertir gira el tono: un diagrama azul sale naranja. Con él,
   los colores se reconocen (verificado sobre el PDF del BOE: el logo sigue azul).
5. **`contrast(0.88)`.** Evita el par negro puro / blanco puro, que es agresivo en la sesión larga
   que es justo cuando se usa este modo.

**Consecuencias.**
- **Los subrayados conmutan de blend.** `.pdf-hl-group` usa `multiply`; sobre papel negro, color ×
  negro = negro y desaparecerían. En noche pasan a `screen`. Es una línea, pero sin ella el bug se
  reporta como "se me borraron los subrayados por la noche".
- **`.pdf-page` gana `isolation: isolate`**, para que el tinte y los subrayados se mezclen con el
  papel y entre sí, nunca con el fondo de la app ni con la sombra de la caja.
- **En noche las fotos salen en negativo.** El `hue-rotate` salva diagramas y texto de color; una
  fotografía o un escaneado no tiene arreglo barato. Es la contrapartida que PDF5 ya anticipaba, se
  asume a conciencia y **se avisa en la propia UI** bajo el selector.
- El ajuste es **global**, no por libro: es una preferencia de confort visual (como el brillo), no
  una propiedad del documento.
- `theme: 'system'` ahora reacciona **en caliente** a `prefers-color-scheme` (antes solo se leía al
  arrancar). Sin eso, `auto` no cumple lo que promete: quien lee de noche con el tema del sistema se
  quedaba con papel claro hasta recargar.

Tests en [`tests/pdf.spec.ts`](tests/pdf.spec.ts) (`PDF papel`): tinte solo en los claros, inversión
solo en noche, conmutación del blend de subrayados, captura de visión idéntica entre papeles, y
`auto` siguiendo al tema.

<a id="adr-027"></a>
## ADR-027 — Cola de llamadas al LLM: prioridad para lo interactivo, serialización solo donde hace falta · `ACEPTADA`

**Contexto.** nan rechaza peticiones concurrentes contra la misma key (devuelve "network error"),
así que `llm.js` serializaba **todas** las llamadas de la app con una cadena de promesas. Eso trajo
dos problemas. Uno menor: es un límite de UN proveedor aplicado a todos, y en OpenAI/Groq/OpenRouter
estábamos regalando paralelismo. Y uno grave: **el chat quedaba detrás de los trabajos en segundo
plano**. Un resumen es un map-reduce de muchas llamadas; preguntarle algo al agente durante esa
generación encolaba la pregunta detrás de **todos** los trozos pendientes.
[`jobs.js`](app/js/ai/jobs.js) promete *"puede seguir leyendo"*, y era cierto — pero el agente
quedaba inutilizable durante minutos, sin explicación visible. El propio código ya tenía el
argumento escrito: `transcribe` estaba fuera de la cola porque *"el usuario espera con el modal
delante"*. El chat es **la** interacción donde el usuario espera mirando.

**Decisión.** Una cola con **dos carriles** y un límite de concurrencia **por proveedor**.
- `INTERACTIVE` (por defecto) y `BACKGROUND` (`background: true` en las opciones de la llamada).
  Al liberarse un hueco se despacha primero el carril interactivo; FIFO dentro de cada carril.
- `maxConcurrent()` lee `concurrent` del preset del proveedor: declarado solo donde está
  verificado (OpenAI, OpenRouter, Groq). **Sin declarar → serializa**, que es el comportamiento
  que había: ningún proveedor BYOK personalizado puede empeorar con este cambio.
- `Jobs.start` pasa `background: true` al `run` de cada trabajo, y summary/mindmap/flashcards lo
  propagan a sus llamadas. Explícito en el sitio de la llamada, no un flag ambiental global.

**Porqué.**
1. **El default correcto es "interactivo".** Si alguien añade una ruta nueva y olvida marcarla, el
   fallo es que va rápida — no que el usuario se queda esperando. El fallo por omisión debe ser el
   benigno.
2. **No hay preempción, y está bien.** Una llamada en vuelo se termina (abortarla desperdicia
   tokens ya pagados y deja el artefacto a medias). Lo que se gana es no esperar a los trozos **que
   faltan**, que es donde estaba el minuto de espera.
3. **El paralelismo es del proveedor, no de la app.** Codificarlo en `PROVIDERS`, junto a
   `liteModel`, mantiene en un solo sitio lo que sabemos de cada uno.

**Consecuencias.** `queueState()` expone el estado para tests y diagnóstico. `transcribe` sigue
fuera de la cola por su propio motivo (documentado); en nan eso implica que transcribir durante una
generación puede chocar con el límite de concurrencia — es previo a este ADR y no lo empeora, pero
queda anotado. Tests en [`tests/llm.spec.ts`](tests/llm.spec.ts): el chat adelanta a dos trabajos
encolados antes que él, y un proveedor concurrente despacha en paralelo.

<a id="adr-028"></a>
## ADR-028 — El gate de la expansión de consulta lo decide el idioma · `ACEPTADA`

**Contexto.** [IA7](BACKLOG.md) expandía la consulta (HyDE-lite) solo cuando **no** se nombraba un
capítulo: si lo nombras, la intención ya es explícita. La fase F2 midió sobre el DDIA real que ese
criterio deja fuera el caso que importa. Mismo idioma (EN→EN): BM25 crudo ya recupera 6/6 a top-40 y
la expansión no mejora el recall (aunque por la unión tampoco lo empeora nunca). **Cruzado (ES→EN):
crudo 0/5 → con expansión 4/5.** Y el cruzado es el caso real del usuario: lee libros técnicos en
inglés y pregunta en español. El BACKLOG dejaba abierta la pregunta de si subir el gate al idioma.

**Decisión.** Sí. `QueryExpand.shouldExpand({ question, chapterNamed })` devuelve `true` **siempre**
que el idioma de la pregunta difiera del idioma del libro; si coinciden, se mantiene el criterio
anterior. La política vive en `query-expand.js` —es de IA7, no de `panel.js`, que solo comprueba sus
precondiciones (turno normal, con key, libro listo, sin fragmento adjunto).

**Porqué.** Cruzando idiomas BM25 no tiene **nada** que emparejar: da igual lo explícita que sea la
intención o que se nombre el capítulo, sin puente léxico no hay aciertos. El idioma no es una señal
más dentro del gate, es la que lo domina. Además la decisión es barata: `detectLang` es una
heurística de stopwords, y no podía ser otra cosa — decidir el idioma no puede costar una llamada al
LLM, porque justo sirve para decidir si merece la pena hacerla.

**Consecuencias.** `detectLang` se mueve de `flashcards.js` a
[`retrieval.js`](app/js/ai/retrieval.js) (ahora tiene dos consumidores, y quien sabe qué texto
tenemos es el índice); flashcards lo re-exporta por compatibilidad. Nuevo `Retrieval.indexLang()`,
cacheado por índice y medido sobre una **muestra repartida** del libro: las primeras páginas
(portada, créditos, cita inicial) mienten sobre el idioma del cuerpo. Sin libro indexado el gate cae
al criterio de siempre. Más llamadas de expansión en sesiones cruzadas — es el coste que la medición
justifica, y va con el modelo lite ([ADR-022](#adr-022)). Tests deterministas en
[`tests/query-gate.spec.ts`](tests/query-gate.spec.ts); el golden con modelo real sigue en
`retrieval-hyde.spec.ts` (@live).

<a id="adr-029"></a>
## ADR-029 — Probar un slot de modelo desde Ajustes · `ACEPTADA`

**Contexto.** Hay **cuatro** slots de modelo (principal, rápido, visión, transcripción) y los cuatro
son texto libre, porque en BYOK no siempre se pueden enumerar (`/models` existe, pero nan —el
proveedor por defecto— lo bloquea por CORS). Un id mal escrito no se nota al guardar: se nota mucho
después y en otro sitio. `hasVision()` solo comprueba que la cadena no esté vacía, así que un typo
deja "Explicar lo que veo" **aparentemente activado** y fallando en el momento de usarlo.

**Decisión.** Un botón **Probar** por slot. `LLM.probeModel({ kind, model, baseUrl, key })` hace la
llamada mínima **del tipo que le corresponde**: texto → `/chat/completions` con `max_tokens: 1`;
visión → el mismo endpoint con un PNG de 1×1; transcripción → `/audio/transcriptions` con un WAV de
silencio. Prueba con los valores **del formulario**, no con los guardados.

**Porqué.**
1. **Del tipo que le corresponde, o no prueba nada.** Verificar el slot de visión con una llamada de
   texto suelto no distingue un modelo multimodal de uno que no lo es — que es justo el error que se
   quiere cazar. Hay un test que falla si el probe de visión deja de mandar imagen.
2. **Antes de guardar.** Igual que `listModels`: la gracia es comprobar antes de comprometerse.
3. **"Vacío = automático" deja de ser una caja negra.** Al probar el modelo rápido en blanco, se
   resuelve el que se usaría de verdad (el `liteModel` del preset) y **se dice cuál es**.

**Consecuencias.** El probe va por el carril interactivo de [ADR-027](#adr-027), no fuera de la cola:
en nan una llamada suelta durante una generación chocaría con el límite de concurrencia. Un WAV de
silencio que transcribe a cadena vacía **es un éxito**: lo que se verifica es que la llamada no
revienta (endpoint, id de modelo y key), no el contenido. Tests en
[`tests/model-probe.spec.ts`](tests/model-probe.spec.ts).
