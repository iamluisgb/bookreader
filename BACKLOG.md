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
  - **Seleccionar el pie de una figura → botón "Ver figura":** al seleccionar texto tipo "Figure/Figura
    N.M …" en la barra de selección, ofrecer una acción que **adjunte la página de esa figura** (la
    actual, o la localizada por el pie) al composer —reutilizando el flujo "Ver" ya existente
    (`pendingImage`)— para que preguntes por la figura sin buscar el botón. Evita el camino solo-texto
    que hoy responde a ciegas al preguntar por una figura desde la selección.

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

### IA7 — Reescritura de consulta por defecto (HyDE-lite) · `M` · **en curso**

> **Estado: en implementación (2026-07-06).** La mejora de retrieval de mayor ROI sin embeddings (que se
> aplazaron en [ADR-014](DECISIONS.md)): entender la pregunta **antes** de buscar, no como fallback.

**Problema.** BM25 falla en preguntas **conceptuales/parafraseadas** (las palabras de la pregunta no están
en el texto) y devuelve pasajes de alta coincidencia léxica pero sentido equivocado. La expansión agéntica
(Fase 1b de [IA5](#ia5--retrieval-profesional-rag-por-pasaje-agéntico--l--sustituye-a-ia4)) solo salta en
retrieval débil (sin capítulo nombrado + pocos aciertos BM25), así que ese caso se cuela.

**Solución — unión, no sustitución.** Una llamada barata al LLM (BYOK, sin infra nueva) genera una
**expansión** de la pregunta: `{ terms: [palabras clave en el idioma del libro], hypothetical: "respuesta
plausible de 1-2 frases" }` (HyDE). El retrieval hace BM25 sobre la pregunta **cruda ∪ la expansión** y
une (dedup) los aciertos. La unión conserva la precisión léxica de BM25 en nombres/términos y **suma**
recall conceptual → riesgo de regresión mínimo (en el peor caso no ayuda, nunca quita).

**Integración** ([`js/ai/query-expand.js`](js/ai/query-expand.js) nuevo + `deliver`/`buildContext` en
[`panel.js`](js/ai/panel.js)): la expansión se genera en `deliver` (estado "entendiendo la pregunta…"),
con **gate** (solo si hay key, libro listo y NO se nombró capítulo — ahí la intención ya es explícita),
**timeout + fallback** a la pregunta cruda ante cualquier fallo. El router y el capítulo actual siguen
sobre la pregunta cruda; solo el paso BM25 usa la unión.

**Fases:** F1 ✓ (módulo + integración con unión y fallback) · F2 ✓ (golden @live sobre DDIA real,
[`tests/retrieval-hyde.spec.ts`](tests/retrieval-hyde.spec.ts)) · F3 opcional (caché por pregunta, afinar
el gate del agéntico ahora que la 1ª recuperación es mejor).

**Hallazgo de F2 (medido, DDIA real, `npm run test:ai`):**
- **Mismo idioma (EN):** BM25 crudo ya recupera **6/6** a top-40; la expansión **no mejora el recall**
  (coherente con [ADR-014](DECISIONS.md): BM25 es fuerte en consultas léxicas) pero **nunca empeora**
  (invariante de la unión, verificado).
- **Cross-lingüe (ES→EN, el caso real del usuario):** crudo **0/5** → con expansión **4/5**. Aquí HyDE
  **mueve la aguja de verdad**: el usuario lee libros técnicos en inglés preguntando en español, y sin la
  expansión BM25 no cruza la barrera del idioma. Este es el valor principal de IA7, no el mismo-idioma.

**Abiertas:** ¿subir el gate al idioma (activar siempre que la pregunta no coincida con el idioma del
libro)? · reducir los `null` de expansión (variación del modelo reasoning; el fallback ya lo cubre) ·
presupuesto de latencia (max_tokens/timeout).

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

### P5 — Búsqueda de texto en el libro · **✓** `M`
**Hecho** (ver CHANGELOG): pestaña "Buscar" en el sidebar sobre el corpus segmentado del agente
(pasajes `[[aN]]` + anclas) → EPUB por CFI, PDF por página, un solo camino ([`js/search.js`](js/search.js)).
Insensible a acentos/mayúsculas, fragmento con match resaltado, clic → navega.
_(v2 posible: match exacto a nivel de palabra con `section.find` de epub.js, y navegación entre
resultados con ↑/↓.)_

### P6 — Mejoras de subrayados · `S`–`M`
- Exportar por color (solo amarillos, etc.); copiar el texto de un highlight al portapapeles.
- Confirmación al borrar y borrar desde el propio resaltado en el lector.
- _(El backup/restore de highlights y bookmarks ya lo cubre P3, ver CHANGELOG.)_

### P7 — Sync entre dispositivos · **fases 0-2 ✓** `L`
Plan completo en [`SYNC_PLAN.md`](SYNC_PLAN.md). **Fase 0**: modelo mergeable
(uid/updatedAt/tombstones) + migración. **Fase 1**: DriveProvider (PKCE + Worker +
appDataFolder + etag/412) y Guardar/Restaurar manual. **Fase 2** (ver CHANGELOG): merge por
item (unión por uid + LWW + tombstones) y **SyncEngine automático** — pull→merge→push con
triggers (arranque/debounce/periódico/visibilitychange), 412-retry, multi-pestaña (Web
Locks), badge de estado, posición de lectura sincronizada. Sync sin botones al conectar Drive.
**Infra**: Worker desplegado, OAuth de Google en producción (sin caducidad de tokens).
**Fase 3 en curso**: recuperación de versiones ✓ (`recovery.js` + Ajustes → Datos →
Historial). **Pendiente de Fase 3**: WebDAV como 2º proveedor (sync sin Worker, público
r/selfhosted); manejo fino de errores de usuario (sin conexión, cuota llena); opcional:
sincronizar los ficheros de libro.
- **Pulir la vista de histórico de versiones (`recovery.js` · `listBooks`):** hoy la lista de
  libros sale fea — **nombres repetidos** (mismo título en varios `id`, p. ej. re-importados o
  datos de prueba) y **algunos son solo el hash/UUID** (cuando el libro no tiene título en los
  metadatos, cae a `info.title || id` → muestra el SHA-256). Mejoras: agrupar/deduplicar por
  título, mostrar el título real (buscar en la biblioteca local si el manifest no lo trae),
  y para los sin título usar un nombre legible + fecha en vez del hash crudo.

### P8 — Exportar libretas y conversaciones · **fase 1 ✓** `M`
**Fase 1 hecha** (ver CHANGELOG): botón "Exportar" en el panel → `.md` de la conversación activa
(`buildConvoMarkdown`), **incluye el chat**, preserva formato y resuelve citas a pág./capítulo.
**v2 pendiente:** elegir *solo libreta / solo chat / ambos* desde un menú; formato **PDF** (print) y
copia al portapapeles; export desde la lista de conversaciones (no solo la activa).

<details><summary>Spec original</summary>
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
</details>

### P9 — Skills + Artefactos (plataforma extensible de salidas del agente) · `L` · **futuro**
> **Estado: idea en discusión (2026-07-04).** Capturada para abordarla más adelante. Las decisiones
> abiertas están al final, sin resolver.
> **Nota (2026-07-06):** las **flashcards** ya se entregaron como feature dedicada con export a Anki
> (.apkg/.txt) — ver CHANGELOG y [ADR-020](DECISIONS.md); cuando esta épica arranque, el skill de
> flashcards debería absorber/reusar [`js/ai/flashcards.js`](js/ai/flashcards.js) en vez de duplicarlo.

**Visión.** Pasar de "ofrecer N artefactos sueltos" a **una plataforma de _skills_**: una primitiva que
**unifica plantilla + artefacto + formato de salida**, con skills de fábrica y **creados/compartidos por
el usuario**, y un **visor de artefactos** (al estilo de los *Artifacts* de Claude). Construye sobre lo que
ya existe: [`custom-templates.js`](js/ai/custom-templates.js) (plantillas del usuario) y el hogar
*definir-vs-usar* de Ajustes generales.

**Qué artefactos pide la gente** (catálogo de la ideación, por intención de lectura):
- **Comprender/estudiar:** resumen progresivo (1 línea → detallado), **flashcards**, **quiz/autoevaluación**,
  guía de estudio / chuleta, esquema del argumento.
- **Referencia:** **glosario citado**, índice temático, **mapa de personajes** (ficción),
  **cronología/timeline** (historia/biografía/novela).
- **Análisis:** mapa del argumento (tesis→evidencia→contra), supuestos del autor + crítica, comparación con
  otras obras.
- **Acción (no ficción):** **takeaways/checklist** (el "artefacto de salida" que T1 ya nombra), frameworks y
  modelos extraídos, ejercicios resueltos (técnico).
- **Compartir:** borrador de **reseña**, digest de subrayados, preguntas de club de lectura, ELI5.
- **Meta/decisión:** **"¿me interesa este libro?"** (en la estantería, antes de abrir), **plan de lectura**
  según objetivo+tiempo, **recap desde la última sesión**.
- **Visual:** **mapa mental** (jerarquía radial), luego mapa conceptual (grafo) y timeline visual.

**La primitiva _skill_ (dato declarativo, NUNCA código):**
```
{ name, icon, whenToUse,                 // el agente lo autosugiere por género/objetivo
  scope: book|chapter|here|selection,
  spoilerSafe: true,
  prompt,                                // instrucciones curadas
  output: 'markdown'|'html'|'flashcards'|'svg',
  cite: true }                           // exige anclas [[aN]]
```
Que el skill sea **datos** (no JS) es lo que hace **seguro compartirlo**: importar un skill ajeno = importar
un JSON, no ejecutar código.

**Decisión de arquitectura crítica — output HTML = seguridad.** La CSP actual (`script-src 'self'`) existe
para proteger la **API key BYOK** en localStorage; renderizar HTML del LLM en la app la rompería. Modelo
(como los Artifacts de Claude):
- El artefacto HTML se pinta en un **`<iframe sandbox>`** con `allow-scripts` pero **sin `allow-same-origin`**
  → no accede a localStorage/key ni al DOM padre.
- **CSP del iframe sin red** (`default-src 'none'; connect-src 'none'`) → aunque el LLM emita HTML malicioso,
  no exfiltra ni llama a casa. Contenido **autocontenido** (CSS/JS inline).
- **Dos fronteras de confianza:** (1) *definición del skill* = datos → importar es seguro; (2) *artefacto
  generado* = sandbox aislado → seguro aunque el prompt sea malicioso.
- **Interactividad citada a través del sandbox:** canal **`postMessage` mínimo** — el artefacto solo emite
  intenciones `{navigate:{page|cfi}}`, el host **valida** y navega. Nada más cruza. Así los mapas/glosarios
  siguen siendo clicables→saltan a la página sin abrir el sandbox. **Requerirá su propio ADR de seguridad.**

**Compartir sin backend (local-first):** v1 = **export/import de un skill como JSON** (archivo o pega-enlace),
offline, cero servidor. Galería pública de descubrimiento = necesita backend (ligado a [P7](#p7--sync-entre-dispositivos--l)), fase posterior.

**Visor de artefactos:** galería en IndexedDB (por libro o global): miniatura, tipo, fecha, libro; reabrir ·
regenerar · exportar (reusa [P8](#p8--exportar-libretas-y-conversaciones--fase-1--m)) · borrar. Superficie nueva (¿pestaña "Artefactos" en la sidebar o
sección por-libro en la estantería? → pregunta abierta).

**Género-consciente:** el agente **sugiere** 2-3 skills pertinentes según género (técnico/humanista, ya en
las plantillas) + objetivo, en vez de un menú plano.

**Fases (épica muy derisk-able):**
- **F1 — Runtime + skills de fábrica (texto):** motor "correr skill" (prompt+scope → retrieval → bloque en la
  libreta), 5-6 skills built-in en markdown (resumen sin spoilers, flashcards, glosario citado, quiz,
  takeaways, "¿me interesa?"). Reusa casi todo lo existente. **Alcance común:** selector libro/capítulo/hasta
  aquí/selección + política de spoilers (por defecto: hasta donde voy).
- **F2 — Skills editables por el usuario:** CRUD en Ajustes generales (evolución de `custom-templates`),
  autosugeridos por género/objetivo.
- **F3 — Artefactos HTML sandbox + visor:** el iframe seguro + CSP sin red + canal `postMessage` de
  navegación + la galería. El **mapa mental** cae aquí (`output: html|svg`; o renderer JSON→SVG citado como
  caso especial, reutilizando el rasterizado SVG→PNG del pipeline de iconos).
- **F4 — Compartir:** export/import JSON de skills.
- **F5 — Galería remota (descubrir skills de otros):** requiere backend → fuera de alcance inicial.

**❓ Preguntas abiertas (a resolver antes de arrancar):**
1. **¿El HTML sandbox (F3) entra en esta épica o se separa como épica propia** por su peso de seguridad?
   _(voto inicial: misma épica, pero F3 con su ADR de seguridad explícito.)_
2. **¿El visor de artefactos es pestaña en la sidebar o vive en la estantería (por libro)?**
3. ¿La salida de un skill es **un formato** (md|html|svg|flashcards) o puede declarar varios?
4. ¿Los artefactos generados viven **en la libreta** como bloques o en un **espacio propio** ("Artefactos")?

### P10 — Modo Estudiar (repetición espaciada in-app) · `M`–`L` · **✓ (F1–F3)**

> **Estado: entregado (2026-07-08, F1–F3; ver CHANGELOG).** La feature nueva de mayor impacto tras
> las flashcards: convertir las tarjetas que ya se generan en un **hábito de repaso dentro de la
> app**, no solo un export a Anki.

**Problema que resuelve.** Un lector con IA es intrínsecamente de *uso único por libro* (abres, preguntas,
no vuelves): **no hay bucle de retención**, hoy el punto más débil del producto. Y el export a Anki, aunque
es la feature estrella para ese nicho, **deja fuera a la mayoría** (no usa Anki ni quiere su curva) y saca
al usuario de BookReader en vez de retenerlo.

**Qué es.** Un modo **"Estudiar"** sobre los mazos que ya viven en IndexedDB (`decks`, ver
[`flashcards.js`](js/ai/flashcards.js)/[`db.js`](js/ai/db.js)): voltear tarjeta, autoevaluación
(otra vez / difícil / bien / fácil) y **agendado por repetición espaciada** (SM-2 o FSRS, ~100 líneas,
**sin backend** — el estado de scheduling vive en IndexedDB junto a cada tarjeta). Cola diaria de repaso
("tienes N tarjetas hoy") como bucle de retorno.

**Por qué impacta (en orden):**
1. **Retención** — crea el hábito diario que hoy no existe; es lo más difícil de conseguir para este tipo
   de herramienta.
2. **Amplía el mercado** más allá del nicho Anki (estudiantes/oposiciones/certificaciones que no usan Anki):
   un botón "Estudiar" elimina la barrera de instalar y configurar otra app.
3. **Sostiene la monetización**: uso diario > compra de una vez. Gates Pro naturales (repaso ilimitado,
   todos los mazos, estadísticas/racha).
4. **On-brand**: 100% local, sin backend, privacy-first.

**El moat (lo que ni Anki ni ChatGPT+PDF ni Readwise pueden):** **repaso citado**. Las tarjetas salen del
libro y la capa de retrieval tiene anclas a página/CFI; al repasar, **"saltar a la fuente"** reabre la
página exacta de origen. Hoy la tarjeta guarda solo el capítulo (en la generación se quitaron las anclas
para ahorrar tokens): incluir el ancla de origen al generar es un cambio pequeño y es lo que lo vuelve
único. Reusa la navegación de citas que ya existe en el panel.

**Fases:** F1 ✓ (repaso básico: [`srs.js`](js/ai/srs.js) SM-2 + [`study.js`](js/ai/study.js) overlay +
botón por mazo + chip estantería) · F2 ✓ (fuente citada: ancla `src` en generación + "Ver en el libro"
vía deep-link) · F3 ✓ (racha + mini-stats por mazo). Ver CHANGELOG 2026-07-08.
- **Pendiente (fuera de alcance de F3):** gate Pro (repaso ilimitado / todos los mazos / estadísticas)
  — requiere infra de licencias/monetización que hoy no existe; retomar cuando esa infra llegue.

**Decisiones (2026-07-08, resueltas al planificar):**
- **SM-2, no FSRS.** ~40 líneas puras y testables; FSRS solo rinde con historial largo que nadie tendrá
  en meses. El estado `srs` por tarjeta guarda `reps/lapses/ease/interval/due/lastReview` → migrable a
  FSRS después sin romper.
- **Overlay a pantalla completa, no pestaña de sidebar.** La sidebar es contextual de lectura; el hábito
  empieza SIN libro abierto. Dos puertas: botón "Estudiar" por mazo (modal de flashcards) + chip
  "Repasar hoy (N)" en la estantería (el bucle de retorno).
- **Por-libro Y global, misma UI.** Desde el modal se estudia ese mazo; desde la estantería, la cola une
  lo vencido de todos los mazos.
- **Datos sin bump de esquema:** `card.srs` inline en `deck.cards` (sin `srs` = nueva); `updateDeck` ya
  persiste y el editor conserva el campo (spread). `due` en días (medianoche local).

### P11 — Compartir frase subrayada en redes (tarjeta-cita) · **✓** `M` · **distribución**
**Hecho** (ver CHANGELOG): botón Compartir → tarjeta-cita PNG (canvas, estilo content-engine, con portada). Web Share o descarga.
Al subrayar (o desde un highlight existente), botón "Compartir" que genera una **tarjeta-cita**
(imagen PNG, canvas, CSP-safe) con la frase + título/autor + marca discreta "hecho con BookReader",
para postear en redes. Reusar el enfoque del **content-engine**. Temas claro/oscuro.
- **Por qué:** acción viral natural (la gente comparte citas de libros) → marketing gratis, ataca la
  debilidad de distribución. Coherente con privacy: la imagen se genera en local, el usuario elige
  compartir, nada se sube solo.
- Prioridad alta como jugada de distribución. Ver también [P6](#p6--mejoras-de-subrayados--sm).

### P12 — Flashcards por libro y por estantería (selector de repaso) · **✓** `S`–`M`
**Hecho** (ver CHANGELOG): chip "Repasar hoy" abre selector Todo/estantería; `study.js` filtra por ámbito.
Hoy "Repasar hoy" mezcla los mazos de todos los libros. Añadir un **selector**: repasar todo / este
libro / esta estantería. Quita la fricción ("está todo mezclado") que **bloquea el hábito de repaso**.
- **Infra casi toda existe:** mazos ya son por `bookId`; las **estanterías ya existen**
  ([`library/store.js`](js/library/store.js): `shelves` + `shelfIds`); el modo Estudiar ya acepta un
  subconjunto (`Study.open({ decks })`). Falta sobre todo el **selector** (UI) que filtre los mazos por
  libro/estantería antes de pasarlos a `Study.open`.
- Habilita gate Pro natural (repaso por estantería). Empezar por aquí (mejor ratio esfuerzo/valor).

### P13 — Resumen elegante citado · **✓** `M` · **artefacto**
**Hecho** (ver CHANGELOG): `summary.js` — TL;DR + puntos citados clicables, export Markdown.
Resumen del libro/capítulo bonito y **citado** (cada punto enlaza a su pasaje `[[aN]]`), compartible.
Sirve al pitch "entender más rápido" y explota el foso citado (Atlas no puede saltar a la frase exacta).

### P14 — Mapa mental · **✓** `L` · **artefacto de marketing**
**Hecho** (ver CHANGELOG): `mindmap.js` — mapa radial SVG citado, export PNG/SVG.
Mapa mental (jerarquía radial, render SVG/HTML) del libro/capítulo, exportable/compartible. El artefacto
con mayor techo de marketing (la gente postea mapas mentales), pero el más caro (layout + render). Hacer
**después** de las victorias baratas (P11/P12/P13).

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

## 💰 Monetización / Infra

### MON1 — Gateway de tokens propios (proxy OpenAI-compatible sobre nan) · `M`–`L` · **planificado**

> **Estado: planificado (2026-07-10).** Primera pieza con **backend** del proyecto. No rompe el
> posicionamiento local-first: el cliente sigue siendo 100% estático (GitHub Pages); el gateway es un
> servicio aparte con su propio repo/despliegue, y **BYOK sigue existiendo tal cual** — esto es una
> *tercera vía* (demo/tokens gestionados), no un sustituto.

**Motivación (3 en 1):**
1. **Demo sin fricción** — [LAUNCH_PLAN](LAUNCH_PLAN.md): *"la fricción 'sube un EPUB + pon tu key' mata
   la conversión"*. Un token demo de ~100 llamadas elimina la barrera de conseguir una API key para
   probar el agente.
2. **Control de límites** — tokens emitidos por nosotros, con cuota, revocables, con allowlist de modelos
   y tope de `max_tokens` para acotar coste.
3. **Seguridad** — la key real de nan vive como secret del gateway; **nunca llega al navegador**.

**Arquitectura — proxy OpenAI-compatible (Cloudflare Worker + D1):**
```
bookreader ──Bearer br-demo-x8f──▶ gateway ──routing──▶ nan / opencode / <proveedor N>
           model: bookreader-fast  valida token · cuota · CORS
                                   alias → {proveedor, modelo, key}
                                   decrementa contador (D1)
                                   passthrough del stream SSE
```
- Endpoints: `/v1/chat/completions` y `/v1/models` (passthrough transparente, streaming incluido).
- Tokens `br-…` en D1: `{ token, remaining, active, created, note }`. Decremento atómico por petición;
  a 0 → `429` con mensaje claro ("demo agotada" + CTA a conseguir su propia key / Pro).
- **Cero cambios necesarios en el cliente**: base URL y key ya son configurables
  ([llm.js](js/ai/llm.js)). Opcional: preset en `PROVIDERS` (F3).
- **Bonus CORS:** controlamos las cabeceras → `/models` funciona desde el navegador, arreglando la
  limitación documentada en [llm.js L66-70](js/ai/llm.js#L66-L70) para quien use el gateway.

**Propiedad de diseño — routing multi-proveedor con alias propios (desde F1).** El gateway NO expone
nombres de modelos del proveedor: expone **alias nuestros** (`bookreader-fast`, `bookreader-smart`,
`bookreader-vision`) que una **tabla de routing** traduce a `{proveedor, modelo, key, capacidades}`.
Mismo modelo que OpenRouter, en miniatura. Consecuencias:
- **Proveedor intercambiable sin que el usuario note nada**: si nan sube precios o se cae, se cambia una
  fila (→ opencode o quien convenga) y nadie reconfigura. `/v1/models` devuelve los alias, así que la UI
  los lista sola.
- **Routing por regla**: por tier del token (demo → proveedor barato, Pro → el bueno), por fallback ante
  5xx del primario, o por coste.
- **La tabla existe desde el día uno aunque solo tenga una fila (nan)**: barato ahora, caro de
  retrofitear si los usuarios ya vieron nombres de modelos del proveedor en su config.
- **Caveats**: la tabla debe declarar **capacidades** por backend (function calling —lo usa el retrieval
  agéntico vía `chatTools`—, visión, `/embeddings`) para no rutar una llamada con tools a un modelo que
  no las soporta; y para tokens de pago, los alias deben apuntar a modelos de nivel equivalente (cambiar
  la inferencia cambia la calidad de las respuestas — en demo da igual, en Pro no).

**Punto de diseño delicado — concurrencia sobre una sola key.** nan rechaza peticiones concurrentes a
la misma key ([llm.js L88-89](js/ai/llm.js#L88-L89)); hoy se serializa **en el cliente**, pero tras el
gateway todos los usuarios comparten la key → dos usuarios simultáneos colisionan. Opciones: cola global
con **Durable Object** (serializa; añade latencia bajo carga), **pool de N keys** de nan (round-robin),
o **desbordar al segundo proveedor** de la tabla de routing (el multi-proveedor relaja el problema).
F1 lo asume como riesgo aceptado (tráfico demo bajo + los reintentos de IA3 en el cliente absorben
transitorios); F2 lo resuelve de verdad **si la medición lo pide**.

**Anti-abuso:** además del contador por token — rate-limit por token (rpm), límite por IP en la emisión
self-service (F3), Turnstile si hiciera falta, allowlist de modelos y tope de `max_tokens` server-side.

**Fases:**
- **F1 — Worker MVP** `M`: passthrough streaming + validación de token + contador atómico en D1 +
  **tabla de routing con alias** (una fila: nan) + emisión/revocación por CLI (`wrangler d1 execute` o
  script). Verificar end-to-end con bookreader apuntando la base URL al gateway.
- **F2 — Concurrencia** `S`–`M`: cola (Durable Object) o pool de keys. Solo si F1 muestra colisiones
  reales.
- **F3 — Demo self-service** `M`: botón "Probar la demo" en el onboarding del panel → `POST /demo-token`
  (limitado por IP) → autoconfigura base URL + token sin que el usuario vea nada. Preset en `PROVIDERS`.
  Este es el que mueve la métrica de activación del LAUNCH_PLAN.
- **F4 — Gestión** `S`: listar tokens, uso, revocar (CLI ampliada o mini-admin).

**Requiere ADR al arrancar:** primer backend del proyecto (dónde vive, repo propio vs `gateway/` aquí),
esquema de contadores (D1 vs Durable Object), política de límites y de datos (el gateway ve los prompts →
declarar retención cero y logging mínimo, coherente con el posicionamiento privacy-first).

**❓ Abiertas:** ¿cuota total (100 llamadas) o diaria? · ¿tokens de pago post-demo ligados a Pro/Lemon
Squeezy o solo demo? · ¿cuenta de Cloudflare disponible (si no: Deno Deploy / VPS)? · medir el coste por
llamada real en nan para dimensionar la demo sin sustos.

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

