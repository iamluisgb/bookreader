# CHANGELOG — BookReader

Registro histórico de lo entregado. Lo **pendiente** vive en [`BACKLOG.md`](BACKLOG.md).
Los IDs (`E*`, `F*`, `T*`, `B*`) se conservan para trazar con el histórico de git.

---

## 2026-07-16 — Plan de evals, prioridades 1-4: smoke+doble juez, flashcards por objetivo, mindmap F2, PDFs planos

Cuatro items del plan del BACKLOG en un ciclo (cada uno con su evidencia de eval detrás):

- **EV2 · Smoke + doble juez** — `npm run eval:smoke` (1 batería, 10 tarjetas, resumen
  breve, ~5 min con scoring) para iterar prompts barato; `EVAL_JUDGE2=<modelo>` juzga todo
  dos veces y mide el ACUERDO (|Δ| medio/máx + desacuerdos fuertes ≥1.5 en judge.json y el
  informe). Primer uso ya cazó uno real: fidelidad del resumen P4, 4 (mimo) vs 2 (deepseek).
  Fix de `resolveRunDir`: por mtime, no alfabético (los runs con nombre rompían "el último").
- **IA8 · Flashcards guiadas por objetivo** — los scores de ATENUACIÓN (cacheados por
  convo) ponderan el muestreo del libro entero: capítulos ≥0.66 muestrean al doble de ritmo
  (`scopeRotation`, pura). En libros grandes (muestreo <50% del texto) el selector sugiere
  30 tarjetas. Evidencia: cobertura 1/8 en Pro Git con reparto ciego.
- **P14 F2 · Mindmap** — map con tope de 3 llamadas (trozos más grandes: el DNF de Pro Git
  eran 4+ llamadas de ~90s), esqueleto de RAMAS desde los capítulos reales en el prompt del
  árbol, cap de viñetas JUSTO por capítulo (`capBulletsFair`: el uniforme dejaba capítulos
  sin representar) y árbol de 1 rama → fallback por capítulos (nunca un "mapa" de una rama).
- **PDF6 · PDFs planos** — sin outline, TOC SINTÉTICO detectando encabezados estructurales
  en el texto (`detectHeading`: TÍTULO/TEMA/PARTE/ANEXO/DISPOSICIONES abren capítulo;
  CAPÍTULO/SECCIÓN heredan salvo sin TÍTULO previo; las líneas de índice con nº de página
  se descartan). Desbloquea resumen coherente, atenuación y ámbito por tema en temarios
  BOE-style — el nicho opositor.

## 2026-07-16 — EV1 F2: chat con preguntas trampa, mindmap y atenuación en la batería; P2/P3 con libros reales

Fase 2 del arnés de [`docs/EVALS.md`](docs/EVALS.md) (`evalVersion: 2`, retrocompatible):

- **Runner** ([`tests/evals.spec.ts`](tests/evals.spec.ts)): tres artefactos nuevos por
  batería — chat (2 preguntas reales + 1 **trampa**: mide si el tutor admite lo que no
  está en el libro), mindmap y atenuación del TOC (abre el sidebar para dispararla; corre
  con el modelo lite de ADR-022). Cierre de modales entre artefactos + `actionTimeout`
  (un clic tapado por un overlay se comía 30 min de test).
- **Baterías P2 y P3 en vivo**: Pro Git (14MB) y Constitución del BOE (PDF legal).
- **Scoring**: rúbricas de chat (fundamento/honestidad/claridad) y mindmap
  (jerarquía/cobertura/no-invención) en el juez; atenuación medida como Δ entre capítulos
  dorados y el resto; gates nuevos solo para runs v2.
- **Resultados** (deepseek): chat sobresaliente — honestidad **5/5 en las 4 trampas**,
  fundamento 4.7-5.0; atenuación discrimina (Δ+0.65 en Pro Git); el PDF legal funciona
  (tarjetas 4.6/5.0/5.0). Material de mejora: el mindmap es el artefacto débil (DNF en
  Pro Git, cobertura 2/5) y la cobertura conceptual en libros grandes está limitada por
  el muestreo. Detalle en EVALS.md §Resultados F2.

## 2026-07-16 — Las 7 mejoras que destapó la batería de evals (anclaje, muestreo, prompts, reintentos)

Primer ciclo completo del bucle de mejora de [`docs/EVALS.md`](docs/EVALS.md): fallo
detectado → arreglo → re-run de la batería.

- **Validación semántica de anclas** ([`js/ai/flashcards.js`](app/js/ai/flashcards.js)):
  `anchorSupported` veta anclas que no RESPALDAN la tarjeta (solapamiento de términos
  significativos, con vía corta si el pasaje contiene la respuesta entera); se valida
  también el `src` que declaró el modelo, no solo la repesca BM25. Una tarjeta sin
  pasaje que la respalde queda SIN ancla (honesto) en vez de con ancla equivocada —
  "clic → salta a la fuente" es el foso; el eval cazó anclas de otra escena.
- **Back matter fuera del muestreo** ([`js/ai/retrieval.js`](app/js/ai/retrieval.js)):
  `isBackMatter`/`isBoilerplate` (licencias, notas del transcriptor, "elogios", "acerca
  del autor"…); flashcards, resumen y mindmap lo excluyen en ámbito libro. Caso real:
  un mazo entero sobre la licencia de Gutenberg. Conservador: apéndices y capítulos
  numerados NUNCA se vetan.
- **Tope al déficit arrastrado** entre trozos de flashcards: sin tope, varios trozos
  flojos volcaban el cupo entero en el último (así salió el mazo-licencia). Mejor mazo
  corto y repartido que completo y monotema.
- **Prompt de tarjetas**: el objetivo del lector pasa de sugerencia a criterio rector
  ("pregunta lo que un examen sobre ese objetivo preguntaría"), idioma como regla dura
  (nunca mezclar — mimo mezcló ES/EN), y veto explícito a material administrativo.
- **Prompt de puntos del resumen**: la cita debe CONTENER la afirmación, no ser del
  tema; un punto sin pasaje que lo respalde no se incluye (pertinencia 3-4/5 en evals).
- **Reintento del trozo de puntos vacío** en el resumen (1 reintento): "El modelo no
  devolvió puntos" era intermitente (2 de 3 con qwen).
- Checks del eval recalibrados: anclas presentes 100% válidas + tarjetas con ancla ≥70%
  (la validación puede dejar tarjetas sin ancla a propósito).
- Tests: `isBackMatter`/`isBoilerplate` (retrieval.spec) y `anchorSupported`/
  `attachSources` con veto y repesca (flashcards.spec).
- **Resultado del re-run** (deepseek): p1-estudiante **4.4 → 4.8** (cobertura 5/9 → 7/9,
  citas 4 → 5, anclas validadas); p4 dentro del ruido del juez (±0.5). **Y el bucle cazó
  una regresión de este mismo cambio**: el objetivo (en ES) prominente arrastró las
  tarjetas al español en un libro EN — dos gates en rojo. Fix: `detectLang` nombra el
  idioma del material en el prompt. Detalle en [`docs/EVALS.md`](docs/EVALS.md) §Primer ciclo.

## 2026-07-16 — EV1: comparativo de modelos con la batería — deepseek confirma, qwen descartado para artefactos

Primer uso real del arnés ([resultados en `docs/EVALS.md`](docs/EVALS.md)): la misma
batería (P1+P4) con `deepseek-v4-flash`, `qwen3.6` y `mimo-v2.5` como modelo principal.

- **deepseek 4.4/4.0, sin incidencias** — sigue de principal (hipótesis ADR-022 ✓).
- **qwen descartado para artefactos de valor**: generó las 15 tarjetas de Relativity
  sobre la LICENCIA de Gutenberg (utilidad 1.0, cobertura 0/9 — la rúbrica multicriterio
  lo cazó; una media simple lo tapaba) y el resumen le falló 2 de 3 intentos. En su
  papel de modelo lite (ADR-022) funcionó bien en los 3 runs.
- **mimo, la sorpresa**: tarjetas 4.8/4.8/4.8 con juez cruzado y el más rápido, pero
  mezcla idiomas (gate rojo) y resumen débil en P4. Se queda en visión.
- Arnés: `evals/compare.mjs` (tabla entre runs), runner tolerante a artefactos fallidos
  (el fallo queda como gate rojo + `summaryError`, no como crash), reintento de red en
  el cliente del juez y muestreo repartido de citas.
- Derivados a investigar: reparto de cupo por chunks en flashcards.js ante bloques
  fallidos; excluir back matter (licencia Gutenberg) del muestreo.

## 2026-07-16 — EV1 F1: batería de evals por persona, con fixtures reales y juez LLM

Primera fase del plan de [`docs/EVALS.md`](docs/EVALS.md): medir la calidad REAL de los
artefactos por persona del LAUNCH_PLAN, con libros de verdad y la app de verdad.

- **Fixtures con licencia libre** (`npm run eval:fixtures`): Einstein *Relativity*
  (Gutenberg, P1 estudiante), *Pro Git 2* (CC, P2 técnico), Constitución BOE en PDF
  (P3 opositor) y el Pedro Páramo del repo (P4). Fuentes/licencias en
  [`evals/fixtures/README.md`](evals/fixtures/README.md); no se versionan.
- **Runner de generación** ([`tests/evals.spec.ts`](tests/evals.spec.ts), tag `@eval`,
  fuera de `npm test`): recorre la app REAL contra la API real — onboarding con el
  objetivo de la persona, flashcards y resumen por la UI de producción — y vuelca
  artefactos + pasajes fuente a `evals/runs/<run>/`.
- **Scoring en dos capas** (`npm run eval:score`): checks deterministas que CAPAN la
  nota ([`evals/check.mjs`](evals/check.mjs): anclas, cloze, duplicados, idioma, citas)
  y juez LLM de otra familia con rúbrica por persona ([`evals/judge.mjs`](evals/judge.mjs):
  fidelidad/atomicidad/utilidad por tarjeta con su pasaje delante, cobertura contra
  conceptos dorados, pertinencia de citas del resumen).
- **Informe** ([`evals/report.mjs`](evals/report.mjs)): REPORT.md con nota por batería,
  gates y los peores ejemplos (el material de mejora).
- `npm run eval` = generar + puntuar. `EVAL_MODEL`/`EVAL_JUDGE`/`EVAL_PHASE` para el
  comparativo de modelos (primer uso previsto del arnés, ver EVALS.md).

## 2026-07-16 — Modelo lite para llamadas auxiliares (routing por tarea, ADR-022)

Las llamadas auxiliares del agente —expansión de consulta (IA7) y atenuación del TOC (T8)—
ya no usan el modelo principal: en nan van a `qwen3.6` (~0.8s con tools vs ~2-4s de
`deepseek-v4-flash`, que "razona" donde no aporta). Chat, resumen, flashcards y mindmap
siguen con el modelo principal. Ver [`DECISIONS.md` · ADR-022](DECISIONS.md).

- **`model` opcional** en `chatStream`/`chatTools` ([`js/ai/llm.js`](app/js/ai/llm.js));
  `getLiteModel()` resuelve: ajuste explícito → `liteModel` del preset (solo nan, verificado)
  → alias del gateway → modelo principal. En proveedores no verificados nada cambia.
- **Nuevo ajuste opcional** "Modelo rápido" en Ajustes → Agente
  ([`js/ui/app-settings.js`](app/js/ui/app-settings.js)), con i18n.
- **Alias `bookreader-lite`** (→ `qwen3.6`, tools) en el gateway de la demo
  ([`workers/gateway`](workers/gateway/src/index.js)).
- **Fix aparte que esto destapó**: `.appset-card` sin `max-height` en escritorio — si la
  sección crecía más que el viewport, el tope del modal (botón de demo incluido) quedaba
  inalcanzable. Ahora scroll interno ([`css/main.css`](app/css/main.css)).
- Tests: override de modelo y resolución del lite en [`tests/llm.spec.ts`](tests/llm.spec.ts).

## 2026-07-16 — El botón de volver a la biblioteca es visible durante toda la carga

Antes solo aparecía al TERMINAR la carga completa (render + locations + portada +
persistencia): en libros grandes tardaba, y si algo se colgaba no había forma de salir.

- **Visible desde el primer instante** de la apertura (desde biblioteca o desde archivo),
  en [`js/app.js`](app/js/app.js). `goToLibrary` lo oculta, como siempre.
- **Salir a mitad de carga es seguro**: guardas de aborto tras cada paso lento
  (`EpubReader.load`, `generateLocations`, `PdfReader.load`) — una carga abandonada no
  re-monta la UI de lectura sobre la biblioteca ni pisa al libro abierto después
  (contadores de generación `epubLoadSeq`/`pdfLoadSeq` + identidad de `currentBook`).
- **El libro queda guardado y segmentado aunque salgas a mitad**: la persistencia en
  biblioteca y el `AiPanel.setBook` se ejecutan nada más renderizar, ANTES del guard
  (el panel ya aísla segmentaciones tardías — cubierto por `book-switch.spec.ts`).
- **Carga fallida desde archivo** → se restaura la biblioteca (antes quedaba una vista
  de lectura vacía sin salida).

## 2026-07-15 — Gestos de página en móvil: sin parpadeo, flick y zonas de toque más estrechas

Tres mejoras del paso de página táctil en EPUB (feedback de uso real en móvil):

- **Anti-parpadeo al parar el dedo a mitad de arrastre**: banda muerta de 3 px (el jitter
  de ±1-2 px del sensor táctil ya no repinta el transform hasta 120 veces/s) + coalescencia
  a 1 repintado por frame con `requestAnimationFrame` (con cancelación del rAF rezagado al
  soltar, para que no pise la animación de giro). En [`js/epub-reader.js`](app/js/epub-reader.js).
- **Menos recorrido para pasar página (estilo Play Books)**: umbral de distancia de
  `min(90px, 18%)` → `min(60px, 15%)` del ancho, y nuevo **flick por velocidad** — un
  deslizamiento rápido (≥0,35 px/ms con ≥24 px en el mismo sentido) pasa página aunque el
  recorrido sea corto. La velocidad sale de una ventana de muestras de 160 ms; si el dedo
  se paró antes de soltar, decide solo la distancia.
- **Zonas de toque de bordes más estrechas**: pasar página por toque baja del 28% al **20%**
  de cada borde (el 60% central alterna las barras) — tocar cerca de la mitad ya no cambia
  de página. Aplicado en las dos copias de `tapZone` ([`js/touch-select.js`](app/js/touch-select.js)
  para táctil y `js/epub-reader.js` para escritorio).

## 2026-07-15 — MON1 F3 · Demo self-service ("Probar la demo sin API key")

La fase que ataca la métrica de activación del LAUNCH_PLAN: probar el agente sin conseguir
una API key. Verificado end-to-end (emisión real, límite de IP, token funcionando, contadores).

- **Gateway — `POST /demo-token`**: emite `br-demo-…` con 30 llamadas (`DEMO_QUOTA`). Guardas
  en capas (ver conversación de diseño en MON1): 1 demo por **IP hasheada** (SHA-256 + salt
  secreto `IP_HASH_SALT`; nunca se almacenan IPs) y día · **disyuntor de emisión**
  (`MAX_DAILY_TOKENS`, 200/día) · **disyuntor de consumo** del tier demo
  (`MAX_DAILY_CALLS`, 2000/día) que acota el gasto máximo diario aunque el abuso sea
  distribuido. Migración `0002_demo_selfservice.sql` (`demo_grants`, `daily_stats`).
- **Cliente — botón "Probar la demo (sin API key)"** en Ajustes → Agente, visible solo sin key:
  llama a `/demo-token` y **autoconfigura** base URL + token + modelo alias (`requestDemoToken`
  en [`js/ai/llm.js`](app/js/ai/llm.js)); el usuario no ve token ni URLs. Errores del gateway
  (agotado del día, red) se muestran en sitio con reintento.
- **Mensajes de error limpios**: los bodies con forma OpenAI (`{error:{message}}`) ahora
  muestran solo el mensaje (`apiErrMsg`), no el JSON crudo — aplica al gateway y a cualquier
  proveedor BYOK.
- Tests: 2 deterministas (stub del endpoint: autoconfiguración y 429 mostrado) en
  [`tests/gateway.spec.ts`](tests/gateway.spec.ts) + el @live existente. Suite completa verde (163).

## 2026-07-15 — MON1 F1 · Gateway de tokens propios (Cloudflare Worker + D1)

Primer backend del proyecto (ADR-021). Proxy OpenAI-compatible desplegado en
`bookreader-gateway.luisgonzalezb93.workers.dev`: la app apunta su Base URL ahí con un token
`br-…` como key y **cero cambios de código** (verificado con la app real, `tests/gateway.spec.ts`
@live).

- **[`workers/gateway/`](workers/gateway/)**: `/v1/models` + `/v1/chat/completions` con
  passthrough SSE, validación de token en D1 y **decremento atómico** de cuota
  (`RETURNING`), cabecera `X-Quota-Remaining`, CORS restringido, tope server-side de
  `max_tokens`, retención cero de prompts.
- **Alias propios** (`bookreader-fast` → deepseek-v4-flash · `bookreader-vision` → mimo-v2.5):
  el proveedor es intercambiable sin tocar configs de usuarios (ADR-021).
- **Demo agotada → 403** con CTA a BYOK (no 429: el cliente lo reintentaría, ADR-021).
- Operación por CLI (emitir/ver/revocar tokens) documentada en
  [`workers/gateway/README.md`](workers/gateway/README.md). Token demo inicial emitido
  (100 llamadas; `GW_TOKEN` en `.env` para el test @live).
- Verificado end-to-end: modelos, chat, streaming, alias→modelo real, cuota 100→99,
  agotamiento (403), revocación (401), app real respondiendo vía gateway.

## 2026-07-15 — P15 · i18n EN/ES (inglés por defecto) + P16 · landing EN y landings por nicho

Prerrequisito del [LAUNCH_PLAN](LAUNCH_PLAN.md): todos los canales de lanzamiento son
angloparlantes y la app/landing estaban 100% en español. Ver P15/P16 en BACKLOG.

- **[`js/i18n.js`](app/js/i18n.js)** (nuevo): i18n estilo gettext sin build — la clave es la
  cadena española original, diccionario EN (~540 entradas), fallback al español, interpolación
  `{x}`. Idioma: localStorage `bookreader_lang`; primera vez `navigator.language` (es\* → es,
  resto → **en**, el idioma de lanzamiento). `translateDom()` traduce el HTML estático
  (`data-i18n` / `data-i18n-attrs`) en el arranque y fija `<html lang>`.
- **~35 módulos cableados a `t()`**: chrome del lector, biblioteca, panel del agente,
  flashcards/estudio/resumen/mapa mental/studio, ajustes generales, licencia/paywall, sync/Drive,
  historial de versiones, backup y errores de `llm.js`. Los helpers comunes traducen en un solo
  punto (`setStatus`, `dialog.js`, `showError`). Plantillas de libreta (nombres+campos) traducidas
  — son UI y prompt a la vez.
- **Selector de idioma** en Ajustes generales → sección nueva "Aplicación" (cambiar = reload).
- **Prompts del agente conscientes del idioma** (sin reescribirlos, riesgo mínimo): el system
  prompt pasa de *"Respondes en español"* a *responde en el idioma del usuario (default: idioma
  de la UI)*; misma directiva en resumen (langRule), HQ&A (idioma del fragmento) y extracción a
  libreta. Los encabezados del resumen estructurado se generan y parsean en ambos idiomas.
- **Tests**: `locale: 'es-ES'` global en Playwright (los 155 E2E históricos siguen verdes tal
  cual) + [`tests/i18n.spec.ts`](tests/i18n.spec.ts) (default EN, interpolación, fallback,
  override por localStorage, camino es-ES). Verificación extra: cobertura del diccionario
  contra todas las llamadas `t()`/`data-i18n` (script ad-hoc, 0 claves huérfanas) y smoke EN
  de ajustes+panel sin errores de consola.
- **Landing (P16)**: raíz [`index.html`](index.html) reescrita en **inglés** con `hreflang`;
  la española vive en [`es/`](es/index.html). Dos landings de nicho en inglés para la ola de
  Reddit: [`anki/`](anki/index.html) (flashcards/estudio, tarjeta interactiva + "every card
  remembers its page") y [`privacy/`](privacy/index.html) (local-first verificable, BYOK, BYOS,
  self-host). CTAs → `app/`.
- `sw.js` de la app: `js/i18n.js` al precache (bump a v90).
- **Detección de idioma en la landing** (patrón "grandes empresas" sin servidor): script inline
  en la raíz — la **preferencia explícita** (`bookreader_lang`, la misma clave que la app) siempre
  gana; sin preferencia, `navigator.language` es\* redirige a `/es/` una vez. Conmutador
  Español/English visible en el nav de ambas landings (`?lang=` fija la preferencia, compartida
  con la app). El SEO ya lo cubría `hreflang`; esto cubre el tráfico directo.
  Test permanente [`tests/landing-lang.spec.ts`](tests/landing-lang.spec.ts) (2º webServer en
  Playwright sirviendo la raíz del repo).

## 2026-07-15 — MON2 · BookReader Pro: licencias Polar + gate de features (modo simulado)

Contraparte de código de [docs/GUIA_MONETIZACION.md](docs/GUIA_MONETIZACION.md). La API de Polar
va **simulada** mientras no existe la cuenta (cualquier key `BKRD-…` activa Pro; `-REVOKED`/`-LIMIT`
reproducen los errores reales); pasar a producción = rellenar `CONFIG` en `license.js`.

- **`js/license.js`** (nuevo): activate/validate contra el customer portal de Polar (CORS abierto,
  verificado — sin backend), ventana offline de **30 días**, degradación a Free sin tocar datos,
  label de activación legible («Chrome · Mac»), evento `license:changed`. El estado viaja en el
  backup y en el sync de Drive **a propósito**: restaurar no quema otra activación (mitiga la
  purga de storage de Safari/ITP).
- **`js/ui/paywall.js`** (nuevo): `ensurePro()` — gate en el momento de intención, modal con la
  familia visual de los diálogos propios.
- **Gates Pro**: flashcards/Anki, mapa mental (solo generar: ver artefactos existentes sigue
  libre), repaso diario (quizzes), plantilla HQ&A y crear perfiles. El chat con el libro y el
  resumen quedan gratis — son la demo (LAUNCH_PLAN).
- **Ajustes → Licencia**: activar key, estado con key enmascarada, portal de cliente, quitar
  licencia local. El error de límite de activaciones enlaza al portal para liberar huecos fantasma.
- **`app.js`**: validación en background al arrancar; toast solo en revocación remota.
- **Tests**: `license.spec.ts` (9 casos: mock, API real stubbeada, ventana 30d, revocación,
  paywall, round-trip de backup, sección de Ajustes) + `seedProLicense()` en los specs de
  features gateadas. 153/153. SW `v89` (precache de los módulos nuevos).

---

## 2026-07-14 — Mapa mental: el setup ya no sale estirado (ancho como el resumen)

El modal del mapa mental usaba 900px de ancho SIEMPRE (dimensionado para el SVG del resultado),
así que la pantalla de configuración —solo un selector y un botón— salía estirada y vacía, distinta
de la del resumen. Ahora la tarjeta arranca cómoda (680px, igual que `sum-card`) y **solo se ensancha
a 900px para el resultado** (donde el SVG lo pide).

- **`mindmap.js`**: `setWide(false)` en setup y "en curso"; `setWide(true)` en el resultado.
- **`main.css`**: `.mm-card` por defecto 680px; `.mm-card--wide` para el resultado. Además, aire
  entre el selector y el botón "Generar mapa" (`.mm-card .ai-ob-start { margin-top }`), que en el
  resumen daba el texto de ayuda y el mapa no tenía → salían pegados. SW `v88`.

---

## 2026-07-14 — Recuperación: purga de entradas huérfanas del manifest de Drive

Las entradas “Sin título” del historial de Drive eran restos de esquemas de identidad viejos:
claves `highlights_`/`bookmarks_` bajo ids **no canónicos** —`epubjs:0.3:…` (book.key() de epub.js)
o el **nombre de fichero**— que `buildSnapshot` convierte en “libros” del manifest, sin título
(el título solo lo pone la biblioteca). Persistían porque la migración a hash solo corre al abrir
un libro (y solo migraba el nombre de fichero) y el sync nunca poda entradas remotas.

- **`recovery.js`**: `purgeOrphans()` borra de Drive (manifest + fichero) y de localStorage las
  entradas bajo ids no canónicos. **Solo** ids no-hash (epubjs/nombre): **nunca** los hash de 64
  hex (canónicos → posible data de otro dispositivo). Destructivo (pierde subrayados viejos no
  migrados que colgaran de esos ids).
- **`app-settings.js`**: botón **“Limpiar entradas huérfanas”** en Datos → Google Drive, con
  confirmación destructiva y recordatorio de backup; tras limpiar, sincroniza el manifest limpio.
- **`tests/purge-orphans.spec.ts`** (nuevo): quita epubjs/nombre, conserva el hash. SW `v86`.

---

## 2026-07-14 — Repaso: árbol estantería→libros (estilo Anki)

El selector de "Repasar hoy" solo dejaba elegir estantería (o Todo). Ahora es un **árbol** como
el de mazos de Anki: cada **estantería** es la categoría padre (con la **suma** de las vencidas de
sus libros) y sus **libros** cuelgan anidados debajo; los libros sin estantería van como "sueltos".
Se repasa a cualquier nivel. El backend (`dueToday`/`decksForScope`) ya soportaba `scope.type==='book'`.

- **`study.js`**: `studyScopes()` devuelve `{ total, shelves:[{name,cards,books:[...] }], looseBooks }`.
- **`library/view.js`**: el selector pinta el árbol (estantería padre en negrita + libros sangrados);
  el chip lo abre si hay elección real (≥1 estantería o >1 libro).
- **`tests/study-scope.spec.ts`**: árbol estantería→libros anidados + sueltos, y selección de libro.
  SW `v85`.

---

## 2026-07-14 — Artefactos: historial (dejan de sobrescribirse)

Generar un resumen (o mapa) ya **no borra el anterior**: cada generación es un artefacto propio y
se conservan todos hasta que el usuario los borra. Antes la clave era `${bookId}:${kind}` (uno por
tipo, se sobrescribía); ahora `${bookId}:${kind}:${id}` (la "puerta de escape" que dejó la auditoría
UX). Los artefactos son locales (no van al sync de Drive).

- **`db.js`**: `putArtifact` genera una clave única por generación (no sobrescribe) y devuelve la
  clave; `deleteArtifact(key)` borra por clave (soporta las legacy sin id).
- **`jobs.js`**: la caché por tipo pasa de un valor a una **lista** (más reciente primero);
  `list(bookId, kind)` / `latest(...)`; `remove(key)` borra un artefacto concreto sin tocar los demás.
- **`summary.js` / `mindmap.js`**: `open({ viewArtifact })` abre un artefacto CONCRETO del historial.
- **`studio.js`**: cada tipo muestra su **historial** de tarjetas (ámbito · citas · fecha), con
  **+ Nuevo** por tipo y **borrar** por artefacto; invitación cuando no hay ninguno.
- **`tests/studio.spec.ts`**: generar dos no sobrescribe; borrar uno deja el otro (+ persistencia).
  SW `v83`.

---

## 2026-07-14 — Studio: galería per-libro de artefactos (guiado por UX, estilo NotebookLM)

Nueva pestaña **"Studio"** en el panel de IA con la galería de artefactos del libro abierto —
resumen, mapa mental y flashcards—, dándoles una casa visible y navegable (antes solo se lanzaban
desde iconos sueltos). Diseño guiado por auditoría UX/UI, inspirado en el panel Studio de NotebookLM.

- **`studio.js`** (nuevo): tarjetas de **tipo fijo** siempre visibles. Los generados muestran
  metadatos (ámbito · nº de citas · antigüedad) + **Abrir** + kebab (**Regenerar** con confirmación
  que reabre el setup, **Borrar** con confirmación). Los no generados aparecen como **invitación**
  (+ Generar). Estados en vivo en la propia tarjeta: **generando** (progreso + cancelar), **error**
  (reintentar), vacío. Reusa el job runner y la persistencia en IndexedDB; sin modelo de datos nuevo.
- **`jobs.js`**: `remove(bookId, kind)` (borra espejo en memoria + IndexedDB, aborta si en curso).
- **`summary.js` / `mindmap.js`**: `open({ mode:'setup' })` fuerza el setup (para "Regenerar").
- Se mantienen los iconos de lanzamiento rápido del toolbar (evitar romper tests/coach mark); el
  "punto único de entrada" que sugiere el agente queda como follow-up.
- **`tests/studio.spec.ts`** (nuevo): vacío → generar → generado → abrir → borrar (+ persistencia).
  SW `v82`.

---

## 2026-07-14 — Fix: "Sincronizando…" eterno (segundo agujero, en el auth)

El timeout por petición anterior solo cubría `drive-provider.js`. Quedaba un `fetch` **sin abort**
en `drive-auth.js` (`tokenRequest`, la renovación del token contra el Worker de Cloudflare): si
esa renovación se colgaba, el ciclo quedaba colgado en `getAccessToken()` **antes** de cualquier
petición a Drive → "Sincronizando…" para siempre y Web Lock retenido.

- **`net.js`** (nuevo): `fetchWithTimeout(url, opts, ms=30000)` con `AbortController`, compartido.
- **`drive-auth.js`** y **`drive-provider.js`**: ambos usan ahora el helper. Cero fetch sin techo
  en el camino de sync.
- **CSS**: con el panel de IA abierto, `#sync-badge` tapaba el botón "Ver" y el input del chat;
  se aparta a la izquierda del panel (`body.ai-open`), como el task-chip.
- **`tests/sync-timeout.spec.ts`** (nuevo): un fetch estancado aborta con `code:'timeout'` pronto,
  no cuelga. SW `v81`.

---

## 2026-07-14 — Fix: las citas del agente no llevaban al pasaje correcto

Al pinchar un chip de cita `[[aN]]` (resumen/chat), la navegación caía en otra página. Diagnóstico
E2E sobre un EPUB real: el CFI almacenado **resuelve al elemento correcto**, pero `rendition.display(cfi)`
de epub.js **mal-pagina el primer display** dentro de una sección larga recién maquetada (calcula la
posición antes de que asienten las columnas por CSS). Medido: solo **10/16** citas caían en la página
correcta; ni colapsar el CFI de rango a punto ayudaba.

- **`epub-reader.js`**: `goTo()` hace ahora un **segundo `display()`** tras un frame, con el layout ya
  estable. Corrige el salto (**10/16 → 15/16**). Barato: la sección ya está cargada y, si el primero
  acertó, el segundo es un no-op sin salto visible. Beneficia también a marcadores y a la navegación
  de búsqueda (mismo `goTo`).
- **`tests/cite-nav.spec.ts`** (nuevo): segmenta el EPUB real, navega por el camino real de la app y
  exige que ≥14/16 citas muestreadas caigan en la página del pasaje. SW `v80`.

---

## 2026-07-14 — Fix: variables CSS inexistentes (menú de repaso invisible)

El selector de ámbito de repaso ("Repasar hoy" → Todo / estanterías) se veía transparente, con
los contadores flotando sobre las portadas y sin poder distinguir qué era qué. Causa: `.lib-study-menu`
—y varios sitios más— usaban custom properties que **no existen** en el tema (`--bg-primary`,
`--bg-secondary`, `--text-primary`, `--text-secondary`), que resuelven a "sin valor" → fondo
transparente y texto invisible, sin error en consola.

- **`main.css`**: mapeadas a las variables reales del tema (`--surface-1/2/3`, `--text`, `--text-soft`).
  Afectaba también al chip de trabajos en segundo plano (`.ai-taskchip`), el documento de resumen
  (`.sum-doc`), el estado de ejecución (`.ai-run-status`) y el propio **`#sync-badge`** (que llevaba
  renderizándose sin fondo).
- **`tests/css-vars.spec.ts`** (nuevo): red de seguridad — falla si cualquier `var(--x)` sin fallback
  no está definida en el CSS. Previene toda esta clase de bug. SW `v79`.

---

## 2026-07-14 — Historial de versiones: overlay dedicado (fin del scroll anidado)

Rediseño guiado por auditoría UX. El historial era un panel inline al **fondo** del modal de
Ajustes → un scroll anidado (lista `max-height:50vh`) dentro de otro scroll: para llegar había
que agotar el scroll del modal y luego pelear con un rectángulo minúsculo. Ahora es un **overlay
propio a pantalla completa** con una **única zona scrollable de altura completa**:

- **`app-settings.js`**: nuevo `#appset-history-overlay` (se apila sobre Ajustes). Tres bandas:
  cabecera sticky (`← Volver` / título / `✕`), buscador sticky y lista `flex:1; min-height:0;
  overflow-y:auto` (sin `max-height`). Drill-down libros→versiones que **reemplaza** el contenido
  en vez de anexarlo. Buscador en vivo (aparece con ≥8 libros). Foco al abrir, `Esc` retrocede un
  nivel o cierra, y al cerrar devuelve el foco al botón que lo abrió. Confirmación antes de
  restaurar.
- **`recovery.js`**: `cleanTitle(raw)` quita el ruido de dominio de z-library
  (`(z-library.sk, 1lib.sk…)`, `(z-lib.org)`) conservando el paréntesis de autores; título con
  `line-clamp:2`.
- Tests: `recovery.spec.ts` cubre `cleanTitle`. SW `v78`.

---

## 2026-07-14 — Sync: timeout por petición + historial navegable

Dos defectos reportados en la vista de Datos → Google Drive:

- **"Sincronizando…" que nunca acaba.** Los `fetch` a Drive no tenían timeout ni abort: una
  petición estancada (red inestable, portal cautivo, Drive lento) dejaba el ciclo colgado para
  siempre, el badge no se limpiaba y —lo peor— el **Web Lock quedaba retenido**, así que ninguna
  pestaña podía volver a sincronizar hasta recargar. `drive-provider.js`: cada petición lleva ahora
  un `AbortController` con techo de **30 s**; al abortar, el ciclo lanza error → `syncNow` pasa a
  `'error'`, libera el lock y el intervalo reintenta a los 90 s.
- **Historial de versiones sin salida y con scroll minúsculo.** `app-settings.js`: cabecera con
  botón **← Volver** (versiones → libros) y **Cerrar** (libros → oculto); las filas de versiones se
  contienen ahora en `.appset-history-list` con scroll propio (antes solo scrolleaba la lista de
  libros, y las versiones desbordaban el modal). SW `v77`.

---

## 2026-07-14 — Identidad de libro unificada (subrayados/marcadores → hash)

Causa de fondo del manifest de sync ensuciado: subrayados y marcadores se keyeaban con el
**nombre del fichero** (`fileBaseId`) —y en versiones viejas con `book.key()` de epub.js—
mientras biblioteca, agente y artefactos usan el **hash SHA-256** del contenido. El mismo libro
aparecía bajo varios ids → duplicados y entradas sin título.

- **`highlights.js` / `bookmarks.js`**: nueva `migrateBook(oldIds, newId)` que fusiona (merge por
  uid, LWW, sin duplicar) los datos guardados bajo ids antiguos en el id canónico (hash) y borra
  las claves viejas. Idempotente.
- **`app.js`**: al abrir un libro (fichero nuevo o desde la biblioteca) se calcula el hash primero,
  se **migra** `nombre-fichero → hash` y se keyean subrayados/marcadores **por el hash**. Los
  datos existentes se consolidan al abrir cada libro, sin pérdida.
- Tests: `tests/book-identity.spec.ts` (fusión por uid, borrado de clave vieja, idempotencia). SW `v76`.

> Nota: las entradas viejas del manifest en Drive (nombre/epubjs) persisten hasta que se limpien;
> ahora salen claramente marcadas "Sin título" en Recuperación. Una purga del manifest en Drive es
> un paso aparte (destructivo) si se quiere el borrón y cuenta nueva.

---

## 2026-07-14 — Vista de recuperación usable + chip/badge sin solaparse

Arreglos de UX sobre problemas observados (no tocan la identidad de libros, causa de fondo).

- **Vista de recuperación (Ajustes → Datos)**: la lista de libros no tenía scroll y mostraba
  ids crudos. Ahora tiene **scroll** (`max-height`), los libros **identificables van primero**,
  y los que no tienen título (solo subrayados/marcadores, keyed por `book.key()` de epub.js) se
  marcan **"Sin título · <id corto>"** en vez del hash entero.
- **Chip de trabajos vs badge de sync**: ambos vivían abajo-derecha y se solapaban. Con un chip
  activo, el badge `#sync-badge` sube (`body.has-taskchip`).
- SW `v75`.

> Nota (backlog): la raíz de los "registros imposibles de identificar" es que subrayados/marcadores
> se keyean con `book.key()` de epub.js mientras biblioteca/IA usan el hash del fichero → el manifest
> de sync mezcla dos espacios de id. Unificar la identidad es un cambio con migración (pendiente).

---

## 2026-07-14 — Persistencia de resúmenes y mapas mentales (IndexedDB)

El caché de resúmenes/mapas era solo en memoria → se perdía al recargar o cerrar (y había que
re-generar, pagando LLM). Ahora se persisten en IndexedDB y sobreviven a cierres/recargas.

- **`db.js` v6**: nuevo store **`artifacts`** (keyPath `${bookId}:${kind}`, índice `bookId`) con
  `getArtifacts` / `putArtifact` / `deleteArtifact`. Se validan contra **`SEG_VERSION`**: si el
  libro se re-segmenta (anclas nuevas), el artefacto viejo se descarta (evita citas rotas).
- **`jobs.js`**: al terminar un trabajo escribe el resultado en `artifacts`; `loadForBook(bookId)`
  trae los ya generados al espejo en memoria (sin pisar uno más reciente de la sesión).
- **`panel.js`**: `Jobs.loadForBook(bookId)` en `setBook` → al abrir un libro, sus resúmenes/mapas
  ya generados están disponibles para reabrir al instante.
- Tests: persistencia en `artifacts` + restauración vía `loadForBook`. SW `v74`.

---

## 2026-07-14 — Resumen y mapa mental NO BLOQUEANTES ("sigue leyendo, te aviso")

Generar un resumen/mapa (1-4 min, varias llamadas al LLM) bloqueaba: había que mirar el modal
sin poder leer. Como en el chat, ahora la generación va en segundo plano y avisa al terminar.

- **`js/ai/jobs.js`** (nuevo): runner de trabajos pesados de IA. Un trabajo a la vez (las
  llamadas ya se serializan en llm.js), estado (running/done/error/cancelled) con progreso,
  **caché de resultado por libro+tipo**, y cancelación al cambiar de libro. Los modales aportan
  la función `run` (el bucle map-reduce, ahora desacoplado del DOM).
- **Vista "en curso"**: al Generar, el modal ofrece **"Seguir leyendo"** (suelta el modal, el
  trabajo sigue) y "Cancelar". Cerrar (X/Escape/clic-fuera) ya **no** cancela: solo suelta.
- **`js/ai/jobs-ui.js`** (nuevo): **chip flotante** de progreso ("Resumen 3/6" con anillo) que
  persiste mientras lees y sirve para reabrir; al terminar, se convierte en "Ver resumen".
- **`js/ai/toast.js`** (nuevo): aviso no intrusivo abajo. Al terminar → toast **"Resumen listo ·
  Ver resumen"** (acción reabre el resultado); en error → "Reintentar". Vibración PWA opcional.
- **Reabrir = instantáneo desde caché** (y arregla el coste oculto: antes, clicar una cita
  cerraba el modal y reabrir **regeneraba** 1-4 min; ahora se restaura al instante). Botón
  **"Regenerar"** en el resultado para rehacerlo. Feedback **"Copiado ✓"** al copiar.
- Panel: `JobsUI.init()` + openers, y `Jobs.cancelForBookChange` en `setBook`.
- Tests: `tests/jobs.spec.ts` (flujo en segundo plano + aviso + reabrir; cancelar desde chip).
  SW `v73`.

---

## 2026-07-14 — P14.2: mapa mental estilo NotebookLM (etiquetas cortas + hover)

Con frases enteras en cada hoja, el mapa se cortaba entero ("…"). Lección de NotebookLM: el
mapa es de NAVEGACIÓN, no un volcado de texto → **rótulos cortos de concepto** en los nodos y
el **detalle detrás de la interacción**.

- **Etiquetas cortas**: el `map` del mapa (`mapPrompt`) ahora extrae CONCEPTOS (2-6 palabras),
  no frases; el `reduce` (`treePrompt`) pide rótulos de 2-5 palabras. Como bonus, inputs cortos
  → el JSON del reduce ya no se trunca → el árbol temático sale mucho más a menudo (antes caía
  al fallback por capítulos). `clampWords` garantiza que ninguna etiqueta se recorte con "…"
  (recorte por palabra completa; el texto va al tooltip).
- **Hover = cita real**: cada nodo lleva un `<title>` SVG con el texto del pasaje (por su ancla,
  vía retrieval) — al pasar el ratón se ve la frase del libro, no una paráfrasis. Clic sigue
  saltando al pasaje.
- **Fallback pulido**: los rótulos de rama del fallback se acortan (`tidyChapter`: quita "1 ",
  "Part 2", "appendix C", subtítulos tras ":") y también usan conceptos cortos como hojas.
- **Filtro de front-matter** (`retrieval.isFrontMatter`, compartido con el resumen): fuera
  "Cover", "Index", "Preface", "about the cover illustration"… de mapas y resúmenes.
- Verificado con generación real (mimo-v2.5) del libro *Knowledge Graphs and LLMs in Action*:
  mapa temático en español, 0 etiquetas cortadas, 16 hojas clicables con tooltip. SW `v72`.

---

## 2026-07-14 — P13.1: resumen estructurado, más rico y multi-idioma correcto

El resumen se veía corto y con defectos: TL;DR cortado a media palabra, viñetas coladas en
inglés dentro de un resumen en español, y una viñeta sin cita. Rediseño a **resumen
estructurado** con **selector de profundidad** (Breve / Estándar / Detallado), verificado
generando resúmenes **reales** (mimo-v2.5) de DDIA (de ~2.000 → ~9.100 caracteres en Estándar).

- **Formato estructurado** (`js/ai/summary.js`): portada (**TL;DR** + **Ideas principales** en
  prosa) → **secciones por capítulo** con viñetas citadas (agrupadas por el capítulo real de
  cada ancla, en orden de lectura) → cierre (**Qué llevarte**, accionable). Todo se arma como
  un markdown y se renderiza de una (`mdToHtml` ya soporta encabezados/listas).
- **Selector de profundidad**: Breve (lista plana, ~24k tokens de cobertura), Estándar
  (estructurado, 48k, por defecto), Detallado (estructurado, 80k, más viñetas por sección).
  Más profundidad = más cobertura y más llamadas.
- **Tres bugs corregidos**: (1) el TL;DR se truncaba porque el reduce tenía `maxTokens: 300` y
  los modelos de razonamiento lo agotaban pensando → subido a 1500-1600 (map 900→1500); (2)
  la regla de idioma decía "mismo idioma que los pasajes" (inglés en libros en inglés) → ahora
  se ancla al idioma del **objetivo** del lector; (3) las viñetas sin cita válida se descartan
  (integridad del foso citado).
- Tests: `tests/summary.spec.ts` actualizado (estructura `.sum-doc`) + caso de modo Breve. SW `v71`.

---

## 2026-07-14 — P14.1: el mapa mental, legible y sin solapes (calidad)

El primer mapa real (DDIA) salía inservible: ramas anónimas "Ideas 1…5", hojas cortadas a
21 caracteres e ilegibles, y nodos amontonados. Tres arreglos, verificados generando mapas
**reales** (mimo-v2.5) de un libro técnico (DDIA) y uno de ficción (Lituma en los Andes).

- **Reduce robusto (la raíz de "Ideas N")**: los modelos de razonamiento gastan miles de
  tokens "pensando" antes del JSON; con el cupo antiguo (1400) agotaban el presupuesto y
  emitían JSON vacío/truncado → el mapa temático caía siempre al fallback. Ahora: `maxTokens`
  del reduce 1400→**5000** (y map 900→1500), `extractJson` **repara JSON truncado** (cierra
  cadenas/objetos abiertos), y el fallback agrupa por **capítulo real** del pasaje (nunca más
  ramas anónimas "Ideas N"). Además se acotan las viñetas a 20 (muestreo uniforme) para que
  el JSON quepa holgado y el mapa no se sature.
- **Legibilidad**: las etiquetas se **envuelven en 2 líneas** (`wrapLabel`) en vez de
  truncarse a 21 car.; hojas hasta ~44 car. legibles.
- **Anticolisión**: layout radial que reparte todo el círculo **proporcional al nº de hojas**
  (densidad angular constante) y **alterna el radio par/impar** de hojas contiguas, resolviendo
  el solape cerca del eje vertical (donde manda el ANCHO de la píldora, no el alto). El lienzo
  **se auto-ajusta** al contenido (viewBox por bounding box), así nada se recorta. PNG a **2×**.
- SW `v70`.

---

## 2026-07-14 — P14: mapa mental radial del libro/capítulo

Botón "Mapa mental" en la barra del agente → un mapa radial SVG del contenido, con las
hojas citando su pasaje. El artefacto compartible (PNG para redes) que hace marketing.

- **`js/ai/mindmap.js`**: selector de ámbito + map (viñetas citadas por trozo) + reduce
  (una llamada → árbol JSON `{title, branches:[{label, children:[{label, src}]}]}`, con
  parseo tolerante y fallback a mapa plano si no parsea). Render **radial SVG** (nodo
  central → ramas de colores de marca → hojas), curvas de Bézier, pills. Hojas con `src`
  mapeado a ancla real son clicables (`.mm-cite`) → saltan al pasaje y cierran el modal.
  Export a **PNG** (rasteriza el SVG en canvas, para compartir) y a **SVG**.
- Botón `#ai-convo-mindmap` en la barra del panel. Reutiliza el troceado y el map de
  summary/flashcards; el retrieval del agente da los pasajes citados.
- Tests: `tests/mindmap.spec.ts` (2) — mapa con ramas/hojas citadas, y clic→navega.
  Verificado visualmente en navegador (radial coherente con la marca). SW `v69`.

---

## 2026-07-13 — P13: resumen elegante citado del libro/capítulo

Botón "Resumen" en la barra del agente → TL;DR + puntos clave, cada uno citando su
pasaje [[aN]] (clic → salta al libro). El pitch "entender más rápido" con el foso citado.

- **`js/ai/summary.js`**: modal con selector de ámbito (capítulo / libro entero, muestreo
  round-robin hasta 36k tokens). Map-reduce: cada trozo → viñetas Markdown citadas; una
  llamada final → TL;DR. Render con `renderWithCitations` (las [[aN]] se vuelven botones
  `.ai-cite` clicables); el clic delega en `navigateCite` del panel → salta al pasaje y
  cierra el modal. Exportar a Markdown y copiar. Reutiliza `buildChunks` de flashcards,
  el retrieval del agente y el render de citas del chat.
- Botón `#ai-convo-summary` en la barra del panel, junto a flashcards.
- Tests: `tests/summary.spec.ts` (2) — TL;DR + puntos citados clicables, y clic→navega. SW `v68`.

---

## 2026-07-13 — P12: repasar flashcards por libro y por estantería

Antes "Repasar hoy" mezclaba los mazos de todos los libros; ahora se puede acotar.

- **`study.js`**: `dueToday(scope)` y `openToday({scope})` aceptan un ámbito
  `{type:'all'|'book'|'shelf', …}`; `decksForScope` filtra los mazos (por `bookId`, o
  por los libros de una estantería vía `shelfIds`). Nuevo `studyScopes()` devuelve el
  total global + una entrada por estantería con vencidas (para el selector).
- **Selector en la biblioteca**: el chip "Repasar hoy · N" abre un popover con "Todo · N"
  y una fila por estantería con vencidas; elegir una abre el modo Estudiar de ese ámbito.
  Si no hay estanterías con vencidas, repasa todo directo (flujo rápido de siempre). El
  repaso "por libro" ya existía desde el mazo del modal de flashcards.
- Reusa infra existente: mazos por `bookId`, estanterías (`library/store.js`), y
  `Study.open({decks})` que ya aceptaba un subconjunto. Habilita gate Pro futuro
  (repaso por estantería). Tests: `tests/study-scope.spec.ts` (3, incl. UI del selector). SW `v67`.

---

## 2026-07-13 — P11: compartir una frase subrayada como tarjeta-cita

Botón "Compartir" en un subrayado → genera una imagen PNG con la cita para redes.

- **`js/share-card.js`**: renderiza la cita en un canvas con las **proporciones de la
  skill libro-quote del content-engine** —1080×1080, 2 columnas (portada prominente ~40% /
  cita ~60%)— y tokens de marca (papel cálido `#faf8f3`, cita en serif Source Serif 4,
  chip emerald "BookReader"). La **portada** sale de la biblioteca local (la del libro
  leído: EPUB embebido o 1ª página del PDF), no de Open Library → sin llamada externa,
  coherente con la privacidad. Auto-ajuste de tamaño de fuente y word-wrap; sin portada,
  la cita ocupa todo el ancho. `shareQuote` usa **Web Share** con ficheros si el navegador
  lo soporta; si no, descarga el PNG. Todo en local, la imagen se genera en el dispositivo.
- Botón en el **tooltip de selección** (EPUB y PDF) y en cada **subrayado del sidebar**.
  `app.js` fija título/autor del libro (`setBookMeta`) al abrir para la atribución.
- Tests: `tests/share-card.spec.ts` (3) — PNG válido 1080², cita larga sin romper,
  fallback a descarga sin Web Share. Verificado visualmente en navegador. SW `v66`.

---

## 2026-07-13 — Citas del agente: resaltan el TROZO exacto, no la página entera

Al pulsar una referencia del agente, además de navegar, se señala el pasaje exacto.

- **EPUB**: el ancla pasa de CFI de **elemento** a CFI de **RANGO** sobre el texto del
  bloque (`segment.js`: `cfiFromRange(selectNodeContents(el))`, fallback a `cfiFromElement`).
  El resaltado transitorio que ya existía (`annotations.highlight`, app.js) ahora marca el
  fragmento en vez de fallar. Requiere re-segmentar → **SEG_VERSION 4→5** (automático al abrir).
- **PDF**: antes destellaba la página entera ("no teníamos los rects del pasaje"). Ahora se
  **localiza el texto del pasaje en la capa de texto de pdf.js** (`pdf-locate.js` ·
  `rangeForText`: tolera texto partido en muchos `<span>` y blancos irregulares, con fallback
  al prefijo), se convierte a rects fraccionales (`pdfFractionalRects`, ahora exportada) y se
  pinta un overlay transitorio (`.pdf-cite-hl`, 2.8s). Si no se localiza → destello de página
  (sin regresión). `panel.js` pasa el texto del pasaje (del corpus indexado) a `onCite`.
- Tests: `tests/pdf-locate.spec.ts` (2) — match cruzando spans, offset correcto, blancos y
  prefijo. EPUB verificado en navegador real (1495/1495 anclas con CFI de rango). SW `v65`.

---

## 2026-07-13 — Sync Fase 3 (parte 1): recuperación de versiones anteriores (P7)

Red de seguridad del sync: recuperar datos borrados o perdidos desde el historial
que Drive conserva de cada fichero. Reduce el miedo a activar el sync automático.

- **`js/sync/recovery.js`**: `listBooks` (libros con datos, del manifest),
  `listVersions(bookId)` (revisiones del fichero del libro, recientes primero),
  `previewVersion` (resumen de items vivos sin aplicar) y `restoreVersion`. Semántica
  de recuperación, no reversión ciega: re-afirma los items **vivos** de la versión
  elegida (updatedAt = ahora, sin tombstone) y los fusiona → recupera lo borrado tras
  esa fecha, gana el próximo sync (se propaga a los otros dispositivos) y conserva lo
  más nuevo. Reversible. Usa la API de revisiones de Drive ya existente (Fase 1).
- **UI** en Ajustes → Datos → "Historial de versiones": elegir libro → lista de
  versiones por fecha (la actual marcada, no restaurable) → Restaurar → recarga.
- Tests: `tests/recovery.spec.ts` (4), incl. el caso central (borrar un subrayado,
  sincronizar, recuperarlo de una versión previa conservando lo añadido después).
  `drive-mock.ts` gana soporte de revisiones. Suite: 120 ✓. SW `v64`.
- Verificado en navegador real: clic en Restaurar → el subrayado borrado vuelve con su nota.
- Pendiente de Fase 3: WebDAV (2º proveedor), manejo fino de errores de usuario,
  y (opcional) sincronizar los ficheros de libro.

---

## 2026-07-13 — Sync Fase 2b: SyncEngine automático — sync sin botones (P7)

El motor que cierra la Fase 2: pull→merge→push automático, sin que el usuario
toque "Guardar"/"Restaurar". Conectar Drive en Ajustes ya activa el sync continuo.

- **`js/sync/engine.js`**: ciclo `pull → merge → push`. Pull lee el manifest y solo
  los libros con etag remoto nuevo (guardado en `sync_state`), fusionándolos por uid.
  Push sube los libros con `updatedAt` local mayor que el remoto, `ifMatch` por etag,
  manifest el último. **412** (otro dispositivo escribió) → reintenta el ciclo con
  backoff+jitter (máx. 3); `sync_state` se persiste tras cada escritura para no
  rebotar contra los propios etags. Token revocado → estado `reconnect` sin bucle.
- **Triggers**: al arrancar (`syncOnLoad`), tras cambios locales (debounce 4s), cada
  90s con la pestaña visible, y flush al ocultar la pestaña. **Multi-pestaña**: Web
  Locks (`bookreader-sync`, `ifAvailable`) → solo una pestaña sincroniza a la vez.
- **Posición de lectura sincronizada**: `saveLastPosition`/`saveLastPage` sellan el
  valor con `*At` (LWW de escalares) y emiten `bookreader:data-changed`. En el sync
  automático (`mode:'merge'`) los escalares solo ganan si su sello es más reciente;
  en un Restaurar explícito (`mode:'restore'`) gana remoto.
- **Sin `location.reload()`** (el error de arete): un merge remoto emite
  `bookreader:remote-applied` y la sidebar re-renderiza subrayados/marcadores en sitio.
- **Badge** de estado (abajo-derecha): `syncing | error | reconnect` (clic en
  reconnect abre Ajustes → Datos). `setOnChange` de highlights/bookmarks pasa a lista
  (UI + engine conviven). Escrituras del propio merge no re-disparan push.
- Tests: `tests/sync-engine.spec.ts` (7) + `tests/drive-mock.ts` compartido — primer
  push, pull+re-render, 412-retry, posición por LWW, reconnect, no-op sin token, ida y
  vuelta A↔B. Suite: 116 ✓. SW `v63`.

---

## 2026-07-12 — Sync Fase 2a: merge por item — restaurar ya no pisa, fusiona (P7)

Primer tramo del SyncEngine: el merge determinista del plan, adelantado al Restaurar
manual. Caso cubierto: el mismo libro con notas distintas en dos dispositivos.

- **`js/sync/merge.js`**: unión por `uid`, LWW por item (`updatedAt` mayor gana),
  tombstones se propagan (y una edición posterior al borrado resucita). En empate
  exacto gana el borrado (determinista). Conmutativo e idempotente (A⊕B == B⊕A,
  A⊕A == A) — verificado por test.
- **`restoreSnapshot()` fusiona**: subrayados/marcadores por item; mensajes/notas
  (IDB) casan por `uid` **conservando el id local** (el id autoincremental jamás se
  importa crudo: mismo id ≠ mismo registro entre dispositivos); convos por id global
  con LWW por `lastUsedAt`; escalares sin `updatedAt` (posición, ajustes) gana remoto
  en un Restaurar explícito. Nunca borra datos locales que el remoto no conozca.
- Tests: `tests/merge.spec.ts` (3) — propiedades algebraicas del merge, escenario
  dos-dispositivos end-to-end (A guarda, B con notas propias restaura → unión sin
  pérdidas, LWW en el pasaje compartido), remapeo de ids en IDB. Suite: 109 ✓. SW `v62`.
- Falta de la Fase 2: SyncEngine (pull→merge→push con reintento en 412), triggers
  automáticos (arranque/debounce/periódico/visibilitychange), lock multi-pestaña, badge.

---

## 2026-07-12 — Sync Fase 1: DriveProvider + Guardar/Restaurar en Drive (P7)

Primer proveedor de almacenamiento sobre la interfaz `StorageProvider` del plan
([`SYNC_PLAN.md`](SYNC_PLAN.md)). Hito verificado por test: guardar en Drive, borrar
datos locales, restaurar → todo vuelve (tombstones incluidos).

- **Auth** (`js/sync/drive-auth.js`): authorization-code + PKCE en popup
  (`auth/callback.html` reenvía el code por BroadcastChannel); intercambio y refresh
  vía Worker de Cloudflare. El `refresh_token` vive en localStorage **excluido del
  backup** (SECRET_KEYS); el access token solo en memoria. Token revocado → estado
  "reconectar", sin bucles de error.
- **Provider** (`js/sync/drive-provider.js`): `list/read/write/remove` sobre
  `appDataFolder` (REST v3, multipart, portado de arete), 401 → refresh + un reintento.
  Concurrencia optimista con `version` como etag: `write(..., {ifMatch})` falla con
  `err.code=412` si el remoto cambió (mejor esfuerzo; el retry-loop llega en Fase 2).
  API de revisiones lista para el recovery de Fase 3.
- **Layout por-libro** (`js/sync/layout.js`): `bookreader/manifest.json` +
  `settings.json` + `books/<id>.json` (subrayados/marcadores crudos con tombstones,
  posición, convos, mensajes, notas, ratings). El manifest se sube el último para no
  indexar estados a medias. Secretos (`ai_key`, `drive_refresh_token`) jamás viajan.
- **UI** en Ajustes → Datos: Conectar/Desconectar Drive, Guardar y Restaurar con
  progreso; restaurar fusiona (semántica del import de backup).
- Tests: `tests/drive-sync.spec.ts` (4) con Drive y Worker mockeados por interceptación
  de red — hito completo, layout, exclusión de secretos, 412, reconectar. Suite: 106 ✓.
- SW `v61`: precache de `js/sync/*` y `auth/callback.*`.

---

## 2026-07-12 — Sync Fase 0: modelo de datos mergeable + Worker de auth (P7)

Base del sync multi-dispositivo según [`SYNC_PLAN.md`](SYNC_PLAN.md). Shippeable sola:
mejora también el backup (los borrados ya no "resucitan" al restaurar sobre datos vivos).

- **Identidad estable por item** (`js/sync/schema.js`): subrayados, marcadores, mensajes,
  notas y decks llevan `uid` global (EPUB/bookmarks: el CFI — mismo pasaje → mismo uid en
  cualquier dispositivo; PDF/IDB: UUID) + `updatedAt` (LWW por item en el merge futuro).
- **Tombstones**: borrar subrayados/marcadores/notas marca `deleted/deletedAt` en vez de
  filtrar el array — el borrado podrá propagarse entre dispositivos. `getAll()`/`getNotes()`
  ocultan tombstones (la UI no cambia); `getAllRaw()` los expone para sync/backup. Re-crear
  un item borrado (mismo CFI) lo resucita conservando el uid. Purga física a los 30 días.
- **Migración idempotente al arrancar**: backfill de `uid`/`updatedAt` en datos existentes
  (localStorage por prefijo + cursor sobre `messages`/`notes`/`decks` en IDB), marca
  `sync_schema_migrated`. `importBackup()` re-aplica el backfill (backups antiguos sin uid).
- **Infra de auth Drive** (`workers/auth/`): Cloudflare Worker stateless desplegado
  (`bookreader-auth.luisgonzalezb93.workers.dev`) con `/auth/exchange` y `/auth/refresh` —
  custodia el `client_secret` de Google (secret de wrangler), CORS a localhost:8000 +
  luisgonzalezbernal.com, PKCE. Guías en `docs/GUIA_CLOUDFLARE.md` y `docs/GUIA_MONETIZACION.md`.
- Tests: `tests/sync-schema.spec.ts` (6) — backfill idempotente, tombstone+resurrección en
  highlights/bookmarks, uid estable en IDB, tombstone de notas, purga por TTL. Suite: 102 ✓.

---

## 2026-07-09 — Reorganización de URLs: landing en la raíz, app en /app/

El landing pasa a ser la portada (`/bookreader/`) y la app se muda a `/bookreader/app/`.
Como toda la app usa **rutas relativas** (`js/…`, `sw.js`, manifest `start_url: "."`), el
árbol se movió a `app/` sin tocar una sola ruta interna; solo se ajustaron los ficheros que
nombran `js/`/`sw.js` (eslint, `package.json`, `playwright.config.ts` sirve `app/` como raíz).
- Datos del usuario **intactos**: IndexedDB/localStorage son por-origen, no por-ruta.
- **SW auto-destructor** en la raíz (`sw.js`): los clientes que instalaron la app cuando vivía
  en `/bookreader/` limpian su registro y cachés viejas (sin tocar IndexedDB) y recargan al
  landing. La app nueva registra su propio SW con scope `/bookreader/app/` (CACHE `v60`).
- El landing referencia las fuentes/iconos de la app (`app/fonts`, `app/icons`) y su CTA lleva a `app/`.

---

## 2026-07-08 — Flashcards: generación por trozos con function calling (map-reduce)

Rediseño del pipeline de generación al patrón profesional **restringir > presupuestar >
validar > degradar** (la iteración anterior solo endurecía el parser):
- **Troceo de entrada** ([`buildChunks`](js/ai/flashcards.js), pura): el material se divide en
  trozos de ~10k tokens y cada llamada produce SOLO las tarjetas de su trozo, con **cupo
  proporcional de suma exacta** (`allocateCounts`, resto mayor) y arrastre de déficit. El
  truncado se vuelve **imposible por diseño** (entrada y salida acotadas — clave con modelos
  reasoning), hay éxito parcial (un trozo fallido no tira el mazo, se avisa) y el progreso es
  real. Además el **capítulo ahora se cubre ENTERO** (antes se cortaba a 12k tokens); el libro
  entero mantiene su muestra de 40k (coste acotado).
- **Function calling en vez de JSON-en-prosa**: las tarjetas llegan como argumentos del tool
  `create_flashcards` con schema (reusa `chatTools`, fiable en nan/DeepSeek sin streaming —
  spike E5). **Escalera de robustez** por trozo: tool forzado → tools `auto` + recordatorio →
  fallback a texto con el parser tolerante (proveedores BYOK sin tools); el escalón que
  funciona se recuerda para los trozos siguientes. Un tool_call con `cards:[]` es válido
  ("este trozo no da más"), no un fallo.
- **Anti-duplicados entre trozos**: cada llamada recibe los frentes ya generados.
- **Verificado en vivo** (DDIA real, API nan): 2 trozos × tool forzado → 15/15 tarjetas, sin
  tocar el fallback.

---

## 2026-07-08 — Fix · Flashcards: "JSON no encontrado" con modelos reasoning

El modelo por defecto (`deepseek-v4-flash`) es *reasoning* y su razonamiento consume el mismo
cupo de `max_tokens` (4096 global) que la salida: pidiendo 15-30 tarjetas, el array JSON se
cortaba —a veces antes del primer `[`— y `parseCards` lanzaba *"La respuesta no contiene tarjetas"*.
Tres arreglos que atacan las tres causas:
- **Presupuesto escalado** ([`flashcards.js`](js/ai/flashcards.js)): `maxTokens = min(8192, 2500 + count·220)`
  para la generación; `chatStream` ([`llm.js`](js/ai/llm.js)) ahora acepta `maxTokens` (antes fijo).
- **Parser robusto** (como `parseExpansion` de IA7): `parseCards` deja de usar `indexOf('[')`
  —frágil ahora que el prompt y los pasajes llevan marcadores `[[aN]]`— y extrae los objetos JSON
  **balanceados** con `"front"` (reusa `balancedObjects`), ignorando `<think>…</think>` y las llaves
  del razonamiento. **Salva las tarjetas completas de una respuesta truncada** (mejor N que un error).
- **Rescate del canal de razonamiento:** si el `content` viene vacío, se intenta parsear el
  `reasoning_content` (algunos modelos vuelcan ahí el JSON); y si la respuesta se truncó, se avisa
  cuántas tarjetas se recuperaron en vez de descartarlas.

---

## 2026-07-08 — P10 · Modo Estudiar · fase 3: racha y mini-stats

El refuerzo del hábito: **racha de días** estudiando (🔥 en la pantalla final; `bumpStreak`/
`currentStreak` puros en [`srs.js`](js/ai/srs.js), idempotentes por día, persistidos en
localStorage) y **mini-stats por mazo** en el modal (nuevas · aprendiendo · maduras, criterio
Anki: madura = intervalo ≥ 21d). El gate Pro del backlog queda fuera a propósito: no existe
infra de licencias y no es parte de esta feature.

---

## 2026-07-08 — P10 · Modo Estudiar · fase 2: fuente citada ("ver en el libro")

El moat del repaso: cada tarjeta guarda su **ancla de origen** y al repasar puedes saltar a la
página/CFI exacta de donde salió — lo que ni Anki ni ChatGPT+PDF pueden hacer.
- Generación ([`flashcards.js`](js/ai/flashcards.js)): los pasajes van al LLM **con su marcador
  `[[aN]]`** (~5% más tokens) y se pide `"src"` por tarjeta; `attachSources` **valida** el id
  (los modelos los inventan) y si falta/no existe lo **repesca por BM25** con el contenido de la
  tarjeta, prefiriendo su capítulo declarado. Best-effort: sin acierto, la tarjeta queda sin salto.
- Repaso ([`study.js`](js/ai/study.js)): botón **"Ver en el libro"** al voltear → navega por el
  **deep-link del router** (`#book=<id>&loc=<cfi|página>`): reposiciona si el libro está abierto
  o **lo abre de cero** (la cola global cruza libros; el id del mazo y el de la biblioteca son el
  mismo hash). El modal de flashcards se cierra al saltar (`onNavigate`).

---

## 2026-07-08 — P10 · Modo Estudiar · fase 1: repetición espaciada in-app

Las flashcards dejan de ser solo un export a Anki: ahora se **repasan dentro de la app** con
repetición espaciada (SM-2), creando el bucle de retorno diario que faltaba. Decisiones en
BACKLOG · P10 (SM-2 sobre FSRS; overlay, no pestaña; por-mazo Y cola global).

- Nuevo [`js/ai/srs.js`](js/ai/srs.js): scheduler **SM-2 puro** (sin DOM/DB) — `grade` con 4 notas
  (otra vez/difícil/bien/fácil), `isDue`/`dueCount`/`deckStats` y previews de intervalo para los
  botones. `due` en días de calendario local. Estado `card.srs` **inline en el mazo** (sin bump de
  esquema; migrable a FSRS: guarda reps/lapses/ease/interval/due/lastReview).
- Nuevo [`js/ai/study.js`](js/ai/study.js): overlay de sesión — voltear (espacio), autoevaluar
  (teclas 1-4), re-encolado de "otra vez" en la misma sesión, cloze con huecos `[…]`/`[pista]` y
  revelado resaltado. **Persiste tras cada tarjeta** (cerrar a medias no pierde nada).
- Dos puertas: botón **"Estudiar"** con badge de vencidas por mazo (modal de flashcards) y chip
  **"Repasar hoy · N"** en la estantería (cola global: une lo vencido de todos los mazos).

Tests: [`tests/srs.spec.ts`](tests/srs.spec.ts) (unit del scheduler, fechas inyectadas) y
[`tests/study.spec.ts`](tests/study.spec.ts) (E2E: chip → sesión → persistencia → cloze → cola global).

---

## 2026-07-06 — IA7 · fase 2: golden @live medido (el valor está en cross-lingüe)

Golden de retrieval sobre **DDIA real** con la API real ([`tests/retrieval-hyde.spec.ts`](tests/retrieval-hyde.spec.ts),
`npm run test:ai`), midiendo si el retrieval encuentra el pasaje correcto con la pregunta cruda vs. con la
expansión (unión). Resultado, honesto:
- **Mismo idioma (EN):** BM25 crudo ya recupera **6/6** a top-40 → la expansión **no mejora el recall**
  (coherente con [ADR-014](DECISIONS.md)) pero **nunca empeora** (invariante de la unión, verificado).
- **Cross-lingüe (ES→EN):** crudo **0/5** → con expansión **4/5**. Aquí HyDE **mueve la aguja**: es el
  caso real (leer libros técnicos en inglés preguntando en español); sin expansión BM25 no cruza el idioma.

Además, `parseExpansion` ahora ignora bloques `<think>…</think>` y prueba los objetos JSON balanceados
(reduce los `null` con modelos *reasoning*). Ver BACKLOG · IA7.

---

## 2026-07-06 — IA7 · Reescritura de consulta por defecto (HyDE-lite) · fase 1

La mejora de retrieval de mayor ROI **sin embeddings**: entender la pregunta **antes** de buscar.
BM25 falla en preguntas conceptuales/parafraseadas (las palabras de la pregunta no están en el texto).
Ahora, en turnos normales, una llamada barata al LLM (BYOK, sin infra nueva) expande la pregunta en
`{ terms, hypothetical }` (HyDE) y el retrieval hace BM25 sobre la pregunta **cruda ∪ la expansión** →
**unión, no sustitución**: conserva la precisión léxica en nombres/términos y suma recall conceptual.

- Nuevo [`js/ai/query-expand.js`](js/ai/query-expand.js): `expandQuery` con **timeout + fallback**
  (nunca lanza; ante cualquier fallo → `null` → retrieval con la pregunta cruda, cero regresión) y
  parseo JSON tolerante (`parseExpansion`).
- Integración en [`panel.js`](js/ai/panel.js) (`deliver`/`buildContext`): **gate** (solo con key, libro
  listo y SIN capítulo nombrado — ahí la intención ya es explícita); el router y el capítulo actual
  siguen sobre la pregunta cruda, solo el paso BM25 usa la unión. Estado "Entendiendo la pregunta…".
- El `bm25Count` que alimenta el gate del retrieval agéntico (Fase 1b de IA5) se conserva sobre la
  pregunta cruda a propósito.

Tests en [`tests/query-expand.spec.ts`](tests/query-expand.spec.ts): parseo/fallback (funciones puras) e
integración (una pregunta conceptual dispara la expansión y responde igual). Ver BACKLOG · IA7. sw v56.

---

## 2026-07-06 — Fix (SW): despliegues coherentes; no más "se rompió tras actualizar"

Síntoma reportado: tras varios despliegues seguidos, paginación y scroll "dejaban de funcionar".
Diagnóstico: **no era un bug del lector** (verificado E2E en local y en producción con un PDF
multipágina: paginación, scroll, zoom y navegación tras zoom funcionan, cero errores de consola). La
causa era el **service worker**: con *stale-while-revalidate* (`return cached || network`) un despliegue
podía servir una **mezcla de módulos de dos generaciones** (unos revalidados, otros no) → la app quedaba
medio rota hasta recargar varias veces.

Estrategia nueva del [`sw.js`](sw.js) (v55):
- **Código de la app** (navegaciones + HTML/JS/CSS propios): **network-first** con fallback a caché.
  Estando online se sirve siempre la última versión y **coherente**; offline sigue desde caché (shell +
  módulos), verificado con Playwright (recarga offline mantiene la UI y sirve los módulos).
- **Libs y assets inmutables** (`vendor/`, fuentes, iconos, wasm): **cache-first** (versionados por nombre
  de archivo → arranque rápido y offline intactos).

Con esto, cada actualización se propaga entera de una vez en la siguiente carga, sin estados a medias.

---

## 2026-07-06 — UX/UI: 5 mejoras (descubribilidad, fricción y pulido)

Ronda de UX a partir de una crítica del propio panel:

1. **Descubribilidad de Flashcards** (la feature de pago pasaba desapercibida como un icono más):
   el botón se tiñe con el color de acento para destacar entre los iconos grises, y la **primera vez**
   que un libro queda listo aparece un **coach mark** que lo señala (una sola vez; persiste "visto" en
   localStorage). Ver [`panel.js`](js/ai/panel.js) (`maybeHintFlashcards`).
2. **Fuga de telemetría en el estado**: `"Listo (cacheado) · 1974 pasajes"` → **"Listo para preguntar"**
   (el detalle técnico queda en el `title`). Nada de jerga del pipeline en la UI.
3. **Desplegable propio para el alcance de flashcards** (antes un `<select>` nativo que ignoraba el tema):
   combobox con los tokens de la app, **buscador** cuando el índice es largo y lista filtrable. Ver
   [`flashcards.js`](js/ai/flashcards.js) (`mountScopeCombo`).
4. **Menos fricción en el onboarding**: botón **"Prefiero solo chatear con el libro"** para preguntar
   **sin** elegir objetivo; tras la 1ª respuesta, un aviso ofrece **activar un objetivo sin perder el
   chat** (upgrade en sitio de la conversación). El valor primero, la estructura después.
5. **Salida del agente sin arte ASCII**: el system prompt pide **tablas/listas Markdown** en vez de
   diagramas con caracteres (│ ┌ → ), que se veían crudos. Ver [`panel-template.js`](js/ai/panel-template.js).

Tests en [`tests/panel.spec.ts`](tests/panel.spec.ts) (chat libre + upgrade, coach mark de una vez,
estado sin jerga) y [`tests/flashcards.spec.ts`](tests/flashcards.spec.ts) (combobox de alcance).

---

## 2026-07-06 — Fix: la posición de lectura ya no se pierde al salir del libro en móvil

Al salir del libro (volver a la biblioteca o cerrar la PWA) y reabrirlo, aterrizaba en otro lugar.
Causa: dos almacenes de posición compitiendo y el rancio ganaba al reabrir.
- `lastPosition_<key>` (localStorage) se guarda **en síncrono** en cada `relocated` → siempre fresco.
  Pero `record.lastCfi` (biblioteca, IndexedDB) se guardaba con **rebote de 800 ms** que en móvil moría
  al cerrar/cambiar de app, y al reabrir `openBookRecord` **pisaba** la posición fresca con ese `lastCfi`
  rancio (`goTo` incondicional).
- **Prioridad invertida al restaurar:** la `lastPosition_` que el lector ya restauró manda;
  `record.lastCfi` queda solo como fallback si no existe (`restoredSavedPosition()` en
  [`js/epub-reader.js`](js/epub-reader.js)).
- **Flush del progreso pendiente** al salir a la biblioteca y en `visibilitychange: hidden`
  (`flushProgress` en [`js/app.js`](js/app.js)): el rebote ya no pierde el último cambio cuando el
  móvil congela la PWA. Lo pendiente captura el `bookId` → se arregla también el `TypeError` latente
  (`currentBook.id` con `currentBook` ya null) que silenciaba el guardado al salir.
- **Mismo guard en `syncRouteSoon`**: el rebote de 600 ms de la URL lanzaba el mismo `TypeError`
  (visto en consola durante la verificación) si salías a la biblioteca antes de que disparase.

Verificado end-to-end con Playwright sobre la app real: pasar páginas a ritmo rápido (<800 ms) y salir
→ `lastCfi` coherente con la posición fresca; `lastCfi` rancio plantado a mano → al reabrir gana la
fresca; `visibilitychange: hidden` con rebote pendiente → flush inmediato; consola sin errores.
Suite 77/77 E2E. PDF no afectado (usa `pdfLastPage_` síncrono, sin override).

## 2026-07-06 — Flashcards con export a Anki (.apkg y .txt) — feature estrella del lanzamiento

El agente **genera flashcards del libro y las exporta a Anki**, 100% en el navegador (sin backend), la
feature ganadora del [`LAUNCH_PLAN.md`](LAUNCH_PLAN.md). Botón de tarjetas en el toolbar del panel →
modal con:
- **Generación**: alcance (capítulo con contenido o libro entero — muestreo round-robin por capítulo
  hasta 40k tokens para cubrirlo uniforme), tipo (**Pregunta→Respuesta** o **cloze** `{{c1::…}}`) y
  cantidad (10-30). Prompt con reglas de calidad (atómicas, autocontenidas, mismo idioma del libro,
  alineadas al objetivo de la conversación); salida JSON parseada tolerante. Progreso en vivo (N/M).
- **Revisión**: tarjetas editables inline (front/back), quitar tarjetas; los cambios persisten.
- **Export**: **.apkg nativo de Anki** — SQLite `collection.anki2` (esquema v11 estilo genanki) generada
  con **sql.js vendorizado y de carga perezosa** + zip con JSZip (ver
  [DECISIONS.md ADR-020](DECISIONS.md)) — o **.txt** de import de texto (cabeceras
  `#separator/#html/#notetype column/#deck/#tags column`). Tags `bookreader` + capítulo de origen.
- **Mazos persistentes** (IndexedDB `decks`, DB v5): re-exportar/revisar/borrar sin regenerar (sin
  re-gastar tokens).

CSP: `script-src` gana `'wasm-unsafe-eval'` (solo compilación de wasm de mismo origen; no habilita
`eval`). Nuevos [`js/ai/flashcards.js`](js/ai/flashcards.js) y
[`js/ai/anki-export.js`](js/ai/anki-export.js); botón en [`panel-template.js`](js/ai/panel-template.js).
Tests deterministas en [`tests/flashcards.spec.ts`](tests/flashcards.spec.ts), incluido un **round-trip
real del .apkg** (unzip + abrir la SQLite con sql.js + consultas) y validación externa con `sqlite3`
(integrity ok).

---

## 2026-07-06 — UX: Markdown formateado EN VIVO durante el streaming

Antes, mientras la respuesta se streameaba, el chat mostraba el texto **en crudo** (con `**`, `|`,
`#`… a la vista) y solo lo formateaba al terminar. Ahora se renderiza el Markdown **en vivo** a medida
que llega (negritas, listas, tablas, citas), con throttle a un frame (`requestAnimationFrame`) para no
re-parsear en cada token; el Markdown incompleto se pinta best-effort y se asienta al llegar el resto.
Aplica al chat y al repaso de capítulo. Ver [`js/ai/panel.js`](js/ai/panel.js) (`renderStreaming`) y la
regresión en [`tests/stream-format.spec.ts`](tests/stream-format.spec.ts).

---

## 2026-07-06 — UX (3ª pasada): cabecera del panel a un único toolbar

La cabecera aún apilaba 5 filas (título "Agente", estado, perfil, selector, pestañas). Recomendación
UX aplicada: **toolbar único**.
- **Se elimina la fila de título "Agente"** (redundante: el panel ya se sabe qué es). El selector de
  conversación, el chip de perfil, `＋`/`⤴` y `⚙`/`✕` viven ahora en **una sola fila** (`.ai-toolbar`).
  Chrome de ~200px → ~90px (unas 3-4 líneas más de chat).
- **Estado realmente efímero:** además de en táctil, el estado en reposo se colapsa en **modo hoja**
  (ancho < 768, p. ej. una ventana estrecha de escritorio) — antes seguía mostrándose ahí. Reaparece
  solo al segmentar/generar/errar.
- Limpieza de CSS muerto (`.ai-header`, `.ai-title`). Ver [`panel-template.js`](js/ai/panel-template.js)
  y [`css/main.css`](css/main.css).

---

## 2026-07-06 — UX (2ª pasada): el estado en reposo se colapsa y el selector muestra el objetivo

Crítica UX/UI: la parte superior del panel estaba dominada por **chrome de sistema** (un readout
técnico) y **taxonomía interna**, no por contenido ni controles útiles.
- **Estado efímero:** la línea "Listo (cacheado) · N pasajes · T2 · HQ&A" era un readout permanente
  sin acción y con el template **duplicado** respecto al selector. Ahora en reposo se marca `idle` y se
  **colapsa en táctil** (se recupera todo el alto para el chat); los estados transitorios
  (leyendo/generando/error) quitan `idle` y reaparecen. Se quita además el template del texto (redundante).
- **Selector con identidad humana:** el botón de conversación mostraba el código interno "T2 · HQ&A";
  ahora muestra el **nombre propio o el OBJETIVO** de lectura que escribió el usuario. Ver
  [`js/ai/panel.js`](js/ai/panel.js) (`refreshStatus`, `setStatus`, `renderConvoBar`) y `@media (pointer: coarse)`.

---

## 2026-07-06 — UX: más alto para el chat del agente (menos chrome en la cabecera)

El panel apilaba cinco filas (título, estado, chip de perfil, selector de conversación, pestañas)
antes del chat; en móvil/tablet **vertical** eso dejaba el área de mensajes en ~3 líneas. En un iPad en
vertical no aplicaba ni el bottom-sheet (<768px) ni la compresión de horizontal (max-height 480), así
que se veía el chrome completo.
- **El chip de perfil pasa a la fila del selector de conversación** ([`panel-template.js`](js/ai/panel-template.js)),
  eliminando una fila entera en todas las vistas (encoge con ellipsis para no empujar al selector).
- **Compactación en táctil** (`@media (pointer: coarse)`): menos padding/márgenes en estado, barra de
  conversación, pestañas y lista de mensajes. Ver [`css/main.css`](css/main.css).

---

## 2026-07-06 — Fix: las tablas del agente se renderizan como tabla (no texto crudo)

El renderizador de Markdown del chat ([`js/ai/markdown.js`](js/ai/markdown.js)) no soportaba tablas:
una tabla del modelo salía como texto crudo con pipes y una fila `|---|---|` suelta, ilegible en el
panel. Añadido soporte de **tablas GFM** (cabecera + fila separadora → `<table class="ai-md-table">`),
con contenedor de scroll horizontal (`.ai-md-tablewrap`) porque el panel es estrecho. Regresión en
[`tests/render.spec.ts`](tests/render.spec.ts). Sin bump de `sw.js` (SWR propaga el cambio).

---

## 2026-07-05 — Auditoría: correcciones de seguridad, offline, RAG, a11y y UX

Lote de mejoras a partir de una auditoría técnica independiente. Suite: 66/66 E2E (antes 64;
+`security.spec.ts` y +`retrieval-golden.spec.ts`). Lint sin nuevos problemas.

### Crítico / Seguridad
- **PWA offline reactivada:** `sw.js` existía y se versionaba, pero **nunca se registraba** (no había
  `navigator.serviceWorker.register` en todo el histórico) → la app no funcionaba offline y la estrategia
  SWR estaba inerte. Añadido el registro en [`js/app.js`](js/app.js) (`registerServiceWorker`, tras `load`,
  falla en silencio donde no aplica). Bump de `sw.js` a `v51` (se añade `dialog.js` al precache).
- **Sandbox del iframe EPUB — se retira `allow-scripts`:** el iframe de lectura corría con
  `allow-same-origin allow-scripts`, combo que permitiría a un `<script>` de un EPUB malicioso leer
  `parent.localStorage` (la API key). Ahora `allow-same-origin` solo (epub.js lo necesita para paginar);
  los scripts del propio EPUB no corren. La paginación de texto reflowable no usa scripts, sin regresión.
  Se **rectifica** la nota anterior del CHANGELOG (afirmaba "origen opaco sin allow-same-origin", falso).
  Regresión en [`tests/security.spec.ts`](tests/security.spec.ts): falla si la key vuelve a ser legible.

### Robustez / RAG
- **Guard de secuencia de libro en el chat:** `deliver`/`deliverVision`/`quizChapter` persistían la
  respuesta aunque el usuario cambiara de libro mid-turno (misma clase de carrera que la de segmentación,
  pero en la ruta de respuesta). Ahora capturan `bookSeq` y no pintan/persisten si cambió; `setBook`
  aborta la petición en vuelo. Ver [`js/ai/panel.js`](js/ai/panel.js).
- **BM25 Unicode:** el tokenizador dividía por `[^a-z0-9]`, así que libros en cirílico/griego/CJK
  quedaban con cero tokens (retrieval desactivado). Ahora `[^\p{L}\p{N}]+/u`. Ver
  [`js/ai/retrieval.js`](js/ai/retrieval.js).
- **Atenuación de capítulos completa en libros grandes:** `rate_chapters` iba con `max_tokens:1024` y
  truncaba la lista en libros con muchos capítulos (últimos sin puntuar). `chatTools` acepta `maxTokens`
  y la atenuación pide margen `~120 tok/capítulo`. Ver [`js/ai/llm.js`](js/ai/llm.js),
  [`js/ai/attenuation.js`](js/ai/attenuation.js).
- **Golden set de recall** sobre un EPUB real ("Pedro Páramo") en
  [`tests/retrieval-golden.spec.ts`](tests/retrieval-golden.spec.ts): recall@5 end-to-end como red de
  regresión, además del corpus sintético existente.

### Accesibilidad / UX
- **Diálogos propios** ([`js/ui/dialog.js`](js/ui/dialog.js)): `alertBox`/`confirmBox`/`promptBox`
  modales, theme-aware, con foco atrapado y Escape/backdrop, reemplazan a los `alert`/`confirm`/`prompt`
  nativos (18 usos en app, panel, biblioteca, ajustes, subrayados).
- **A11y del panel IA:** onboarding con `role="dialog"`, `aria-modal`, focus-trap y restauración de foco;
  `#ai-messages` con `role="log"` + `aria-live="polite"` (el lector de pantalla anuncia la respuesta).
- **Carga robusta:** si `loadEpub`/`loadPdf` fallan, no se deja `currentBook` apuntando a un libro no
  renderizado ni se persiste en la biblioteca ([`js/app.js`](js/app.js)).

### Mantenibilidad
- **Tokens CSS:** migrados los alias legacy (`--bg-*`, `--text-primary/secondary/muted`, `--highlight-bg`)
  a los nuevos (`--surface-*`, `--text`/`--text-soft`/`--text-faint`) y eliminados de `themes.css`
  (se conserva `--shadow`, que no tiene equivalente 1:1).

---

## 2026-07-05 — Fix: el pinch-zoom del trackpad ya no cambia de página

Al hacer pinch-zoom en el PDF con el trackpad en PC, el componente horizontal del gesto se
interpretaba como swipe atrás/adelante del navegador, que con los deep-links por URL te sacaba del
libro a la biblioteca ("cambia de página"). Fix: `overscroll-behavior-x: none` en `html, body` (y
`overscroll-behavior: contain` en el contenedor del PDF) para desactivar la navegación por GESTO. El
botón atrás del navegador y el logo→biblioteca siguen funcionando.

## 2026-07-05 — Pulido de UI (cherry-pick del rediseño Stitch)

Se extrae SOLO la capa de "polish" del rediseño Stitch (rama `feat/stitch-ui-redesign`), dejando fuera
lo decorativo o inerte:
- **Consolidación de tokens:** valores hardcodeados → tokens (`--bg-tertiary`→`--surface-3`,
  `--border`→`--border-soft`, px sueltos → `--r-sm/md/pill`).
- **Estados de foco** en search / select / textarea (`border-color: var(--accent)`).
- **Bordes `--border-soft`** por defecto (look más calmado) y **más aire** (paddings/gaps/márgenes).
- **Landing más expresiva** (icono 72px, h1 32px bold con tracking negativo) y anillo `accent-soft` en el
  tema activo; sombra sutil en la burbuja del usuario; chips de cita un poco más visibles.
- **Descartado** (no entra): drop caps, relevancia con 5 estrellas y barra `.ai-stats` (CSS sin cablear
  en JS; los drop caps además vivían en el documento padre, no en el iframe del EPUB), y el coloreado de
  la Libreta en verde/`accent-soft` (se mantiene neutro).

## 2026-07-05 — Fix: bandas oscuras en subrayados de PDF multilínea

Al subrayar varias líneas, las zonas de solape entre rects contiguos se veían más oscuras: cada
`.pdf-hl` llevaba `mix-blend-mode: multiply` + `opacity: 0.4`, así que donde dos rects se solapaban
(por el alto de línea) se multiplicaba dos veces. Ahora cada subrayado va en un `.pdf-hl-group` y el
blend/opacidad se aplican UNA vez al grupo: los rects sólidos del mismo color se funden en un bloque
uniforme antes de mezclarse. Verificado: color idéntico en solape y zona simple.

## 2026-07-05 — Tema "Claro" ahora es blanco neutro (no sepia)

El tema Claro caía en el `:root` por defecto, cuyas superficies eran "papel premium" cálido
(`#faf8f3`/`#fdfbf6`, borde `#ddd8ce`, fondo del PDF beige `#efeae0`) → se veía sepia. Ahora la paleta
Claro es **blanco puro con grises neutros/fríos** (superficies `#ffffff`, hover `#eef0f2`, borde
`#e3e6ea`, sombra neutra). El tono cálido "papel" queda reservado al tema **Sepia** (sin cambios). El
texto ya era neutro; solo cambiaban superficies, bordes y sombra.

## 2026-07-05 — Fix: chat del agente ilegible en móvil horizontal

En horizontal el ancho supera el breakpoint del bottom-sheet (<768px), así que el panel volvía a
drawer lateral pero con muy poca ALTURA: el "cromo" (línea de estado, chip de perfil, selector de
conversación, pestañas y composer) se comía casi todo el alto y apenas cabía un mensaje ("no se ve
nada"). Nueva media query `max-height: 480px` que comprime ese cromo (oculta estado y chip, encoge
cabecera/composer, recorta márgenes) → los mensajes recuperan altura (~107px → ~266px). No afecta a
tablets en horizontal (≥768px de alto).

## 2026-07-05 — Fix: subrayado de PDF invisible en modo scroll

En modo scroll el subrayado se guardaba pero **no se veía sobre el texto**. Causa: la capa de
subrayados (`.pdf-hl-layer`) se creaba sobre el placeholder de la página ANTES de que el observer
perezoso añadiera el `.pdf-scaler`; al ir ambos `position:absolute`, el canvas (opaco) quedaba
**después en el DOM y lo tapaba**. Fix: `z-index` a `.pdf-hl-layer` para que quede por encima del
canvas pase lo que pase con el orden de creación. Test en [`tests/pdf.spec.ts`](tests/pdf.spec.ts).

## 2026-07-05 — PDF móvil: márgenes centrados + ocultar barras (inmersivo)

Dos arreglos sobre el lector PDF en móvil reportados por el usuario:
- **Márgenes raros (franja gris asimétrica):** el contenedor se ponía en `display:flex`, lo que hacía que
  `#pdf-zoom-layer` encogiera a su contenido y se pegara a la izquierda → todo el hueco gris a la derecha
  en pantallas anchas (landscape). Ahora el contenedor es `block` (área de scroll) y el layer centra la
  página con **margen simétrico**; en portrait/landscape estrechos la página llena el ancho como antes.
- **No se podían ocultar los menús:** en PDF el botón ⤢ estaba deshabilitado y no había gesto. Ahora el
  botón se habilita, el PDF **arranca inmersivo en móvil** (estilo Play Books) y **tocar el centro alterna
  las barras** (tap limpio de 1 dedo; scroll, pinch y selección de texto no cuentan). `updateReaderScale`
  es no-op con un PDF a la vista (el encogido del viewport es solo para el texto EPUB).
- Tests en [`tests/pdf.spec.ts`](tests/pdf.spec.ts) (margen simétrico en landscape + toggle del inmersivo).

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
el toque en el texto ocurre DENTRO del iframe de lectura. Ese iframe es **same-origin** (epub.js lo
necesita para paginar y para que inyectemos tema/selección/teclado), pero **sin `allow-scripts`**: un
`<script>` de un EPUB malicioso no corre, así que no puede leer la API key del `localStorage` del padre
(defensa reforzada además por la CSP `script-src 'self'`, que la srcdoc hereda). Aun siendo same-origin,
el iframe de contenido de epub.js **no puede iniciar `requestFullscreen()`** de forma fiable desde un
gesto suyo en todos los navegadores, y el rechazo era silencioso → "no funcionaba". El botón ⤢ vive en
el documento padre, así que su gesto sí puede iniciar fullscreen.

_Nota de seguridad (rectificación):_ una versión anterior de esta entrada afirmaba que el iframe era de
**origen opaco sin `allow-same-origin`**. Es incorrecto: epub.js requiere `allow-same-origin`. La key se
protege quitando `allow-scripts` (ningún script del EPUB corre) + la CSP heredada, no por aislamiento de
origen. Ver [`tests/security.spec.ts`](tests/security.spec.ts) (regresión que falla si la key se vuelve
legible desde el contenido del libro).

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
