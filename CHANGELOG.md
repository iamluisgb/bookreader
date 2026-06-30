# CHANGELOG — BookReader

Registro histórico de lo entregado. Lo **pendiente** vive en [`BACKLOG.md`](BACKLOG.md).
Los IDs (`E*`, `F*`, `T*`, `B*`) se conservan para trazar con el histórico de git.

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
