# BACKLOG-TECH — Calidad técnica (seguridad, performance, buenas prácticas)

Deuda técnica y mejoras transversales detectadas en la auditoría del **2026-06-30**.
El backlog de producto vive en [`BACKLOG.md`](BACKLOG.md); el de la feature de IA en
[`BACKLOG-AI.md`](BACKLOG-AI.md). Aquí va lo que no es una feature de usuario: seguridad,
coste/latencia y mantenibilidad.

**Leyenda esfuerzo:** S < 0.5d · M ~1d · L ~2–3d.
**Estados:** ⬜ PENDIENTE · 🟡 EN CURSO · ✅ HECHO

---

## 🔒 Seguridad

### T1 — SRI en las libs de CDN · `S`–`M` ✅ HECHO (2026-06-30)
jszip, epub.js y pdf.js se cargaban sin `integrity` ni `crossorigin`. Si una CDN se
compromete, ejecuta JS arbitrario con acceso a **la API key en localStorage y a todo el
contenido de los libros**.
- **Aplicado (Opción A):** `integrity="sha384-…" crossorigin="anonymous"` en los 3 `<script>`
  de [`index.html`](index.html). Hashes calculados de los recursos reales de jsDelivr/cdnjs.
- **Bonus:** se eliminó el `<link>` a `epubjs@0.3.93/dist/epub.min.css`, que devolvía **404**
  (esa versión no publica CSS) — un recurso muerto que el navegador pedía en cada carga.
- **Verificado:** 19/19 tests E2E pasan, incluidos los "sin errores de consola tras cargar
  EPUB" (un hash erróneo bloquearía las libs y la carga fallaría).
- **Pendiente futuro (Opción B, recomendada a medio plazo):** vendorizar las libs a `vendor/`
  para no depender de CDN y resolver además [T6](#t6) (offline).

### T2 — Content-Security-Policy · `S`–`M` ✅ HECHO (2026-06-30)
Meta `Content-Security-Policy` en [`index.html`](index.html).
- **Protección clave:** `script-src 'self'` (gracias a vendorizar en [T6](#t6)) bloquea JS
  inyectado — lo que protege la API key en localStorage. `connect-src 'self' blob:
  https://api.nan.builders`: el contenido del libro no puede exfiltrar a hosts arbitrarios.
- Estilos/fuentes/imágenes permisivos (`https:`, `data:`, `blob:`) para que los EPUB
  rendericen fieles; `worker-src`/`frame-src` con `blob:` por el iframe del lector y el
  worker de pdf.js; `object-src 'none'`, `base-uri 'self'`, `form-action 'none'`.
- **Verificado:** los tests detectaron que el contenido del EPUB carga CSS/fuentes/`blob:`
  propios; la política se afinó hasta 19/19 en verde. PDF verificado a mano (worker local
  arranca y renderiza bajo la CSP).

### T3 — Escapar `img src` del cover y unificar escapado · `S` ✅ HECHO (2026-06-30)
- **Util compartido:** nuevo [`js/ui/escape.js`](js/ui/escape.js) con `escapeHtml` (escapa
  `& < > " '`, válido en contenido y atributos). Importado en `app.js`, `panel.js` y
  `library/view.js`; se borraron las 3 copias locales.
- **Cover escapado:** `src="${escapeHtml(b.cover)}"` en [`js/library/view.js`](js/library/view.js).
- **Hueco latente corregido:** la copia de `panel.js` usaba `textContent/innerHTML`, que **no**
  escapaba comillas, y se usaba en contexto de atributo (`data-cfi="${escapeHtml(...)}"`); el
  util nuevo sí las escapa.
- **SW:** `js/ui/escape.js` añadido a `ASSETS` y `CACHE_NAME` → `v26`.
- **Nota:** `esc` en [`js/ai/markdown.js`](js/ai/markdown.js) se deja intacto a propósito: ese
  módulo es un renderer Markdown deliberadamente autocontenido y sin dependencias.

### T4 — Aviso de privacidad la primera vez que se usa el agente · `S` ✅ HECHO (2026-06-30)
- Nota fija en el bloque de configuración del agente ([`js/ai/panel.js`](js/ai/panel.js)),
  visible al abrir la config (primer uso): "Tu API key se guarda solo en este navegador.
  Para responder, el contenido del libro se envía al proveedor del modelo (nan)."
- Icono `shield` nuevo en [`js/ui/icons.js`](js/ui/icons.js) y estilo `.ai-privacy` en
  [`css/main.css`](css/main.css).

---

## ⚡ Performance / Arquitectura

### T5 — No reenviar el libro entero ni todo el historial en cada turno · `L` ⬜ PENDIENTE · **prioridad alta (coste)**
Cada mensaje manda system prompt + **libro anotado completo** + **todo el historial**
([`js/ai/panel.js`](js/ai/panel.js) L622-627, `history.slice(0,-1)` sin recorte). Caro y
lento en *cada* turno; escala con el tamaño del libro.
- Usar la relevancia por capítulo que ya existe (`saveRatings`/`getRatings` en
  [`js/ai/db.js`](js/ai/db.js)) para enviar **solo los capítulos relevantes** al objetivo.
- **Recortar el historial** antiguo (ventana de N turnos o resumen rodante).
- **Guard por `tokenEstimate`**: avisar/confirmar antes de mandar libros enormes.
- Aprovechar **prompt caching**: poner el prefijo estable (persona/perfil + libro) primero
  para maximizar reutilización entre turnos.

### T6 — PWA realmente offline: vendorizar las libs core · `S`–`M` ✅ HECHO (2026-06-30)
- **Vendorizadas** a [`vendor/`](vendor/): jszip, epub.js, pdf.js y **el worker de pdf.js**
  (este último también venía de CDN en runtime). `index.html` y `js/pdf-reader.js`
  (`workerSrc`) apuntan a local; el SRI/crossorigin de [T1](#t1) ya no aplica (mismo origen).
- Los 4 archivos añadidos al precache del SW → sin red se abren EPUB y PDF.
- Habilita además la CSP estricta de [T2](#t2) (`script-src 'self'`).

### T7 — Estrategia de caché del service worker · `S` ✅ HECHO (2026-06-30)
- `fetch` ahora es **stale-while-revalidate** ([`sw.js`](sw.js)): sirve de caché al instante
  y refresca en segundo plano; ya no hace falta bumpear `CACHE_NAME` para propagar cambios
  (solo al añadir/quitar archivos del precache).
- Restringido a GET http(s) del mismo origen; el POST al LLM, los `blob:` del lector y los
  terceros pasan directos.

### T8 — Trocear `app.js` y `panel.js` · `M`–`L` 🟡 PARCIAL (2026-06-30)
Extracciones por responsabilidad, cada una verificada (19/19 E2E + lint 0 errores):
- [`js/progress.js`](js/progress.js): progreso detallado + estimación de palabras, extraído
  de `app.js`. `totalWords` se pasa por parámetro; se eliminó el muerto `estimateWords`.
- [`js/ai/render.js`](js/ai/render.js): `renderWithCitations`/`citeReplace` (Markdown +
  chips de cita), extraído de `panel.js` (920 → 907); `anchors` se pasa por parámetro.
- [`js/highlights-ui.js`](js/highlights-ui.js): **toda la selección/barra de acciones/lista
  de subrayados**, extraída de `app.js` (**848 → 517 líneas**). Público: `initHighlights`,
  `setupHighlights`, `renderHighlights`, `hideHighlightTooltip`. El estado de selección es
  local al módulo; sin ciclos de import (panel.js no importa app.js). *Move* puro.

**Pendiente (deferido a propósito):**
- **Descomponer `panel.js`** (onboarding/chat/libreta): bloqueado por el alto acoplamiento
  — **19 variables de estado a nivel de módulo** + un cache `els` compartido entre ~40
  funciones. Hacerlo limpio requiere primero un refactor de **estado compartido** (un
  `state.js` o pasar contexto) y **más cobertura de tests del panel IA**. No forzarlo sin eso.
- **Código muerto en [`highlights-ui.js`](js/highlights-ui.js)** (heredado, ya muerto antes
  de extraer): `finalizeSelection`/`drawTempSelection`/`pendingSel`/`selFinalizeTimer` y
  `activeSelection` son restos de un enfoque de selección anterior (lint los marca como
  unused). Limpieza segura pero en cascada; hacer en un pase aparte.

### T11 — Revisar las funciones del lector PDF · `M` ⬜ PENDIENTE
Repaso de [`js/pdf-reader.js`](js/pdf-reader.js) (193 líneas): el camino PDF tiene **0
cobertura E2E** y arrastra varios puntos a revisar/decidir:
- **Bug del ArrayBuffer *detached*** (ya detectado): `getDocument({ data: arrayBuffer })`
  transfiere/detacha el buffer, así que `persistToLibrary` ([`js/app.js`](js/app.js) ~L82)
  falla al hacer `slice` → **el PDF no se guarda en la biblioteca**. Clonar el buffer antes
  de pasarlo a pdf.js (o copiar para la librería antes de `getDocument`).
- **Nitidez en pantallas HiDPI/retina:** `scale = 1.5` fijo ([L79](js/pdf-reader.js)) ignora
  `devicePixelRatio`; el canvas se ve borroso en retina. Renderizar a `scale * dpr` y
  escalar por CSS. Sin zoom configurable tampoco.
- **El agente de IA no soporta PDF:** la segmentación ([`js/ai/segment.js`](js/ai/segment.js))
  usa el spine de epub.js; con PDF el botón del agente queda deshabilitado. Decidir si se
  quiere (extraer texto por página con `getTextContent`).
- **Highlights/marcadores en PDF:** ya hay text layer seleccionable
  ([`renderTextLayer`](js/pdf-reader.js#L122)) pero no se persiste nada (ver también
  [`BACKLOG.md`](BACKLOG.md) / [`AGENTS.md`](AGENTS.md)).
- **Navegación por teclado** en PDF (flechas/AvPág) — pendiente como en EPUB.
- **Manejo de errores/UX:** `catch(e) {}` vacíos que se tragan fallos; sin UI de error si el
  PDF está corrupto o `getDocument` rechaza; el parámetro `onProgress` de `load()` está sin
  usar.
- **Acoplamiento a pdf.js 3.11:** `renderTextLayer(...)` cambia de API en 4.x (clase
  `TextLayer`); tenerlo en cuenta si se actualiza la versión vendorizada.

---

## ✨ Buenas prácticas

### T9 — Linter + formatter · `S` ✅ HECHO (2026-06-30)
- ESLint flat config ([`eslint.config.mjs`](eslint.config.mjs)) con globals de browser +
  service worker y `ePub`; Prettier ([`.prettierrc.json`](.prettierrc.json) +
  `.prettierignore`). Scripts `lint`, `format`, `format:check` en `package.json`.
- `npm run lint` pasa con **0 errores** (quedan 7 warnings de variables/imports sin usar,
  código muerto preexistente que el linter ahora señala). Se corrigieron de paso un
  `no-useless-assignment` en `panel.js` y se documentaron patrones intencionados (NUL
  centinela en `markdown.js`, char-class unicode en `touch-select.js`).
- No se corrió `prettier --write` sobre el código existente (evitar un diff masivo); la
  herramienta queda lista para usar.

### T10 — Metadatos de `package.json` · `S` ✅ HECHO (2026-06-30)
[`package.json`](package.json): `description`, `author`, `homepage`, `repository`,
`keywords`, y `"private": true` (no se publica a npm). Licencia ISC sin cambiar (cambiarla
es decisión del propietario).

---

## Estado (2026-06-30)

✅ Hechos: T1, T2, T3, T4, T6, T7, T9, T10. 🟡 Parcial: T8 (extraídas las piezas seguras;
queda la descomposición de selección/highlights y de la UI del agente).

**Pendiente principal:** **T5** (recorte de contexto al LLM) — el mayor coste recurrente; lo
revisa el propietario por separado.

**Revisión PDF:** al verificar el PDF a mano salió un bug preexistente (ArrayBuffer
*detached* al guardar en la biblioteca) y otros puntos del lector PDF → recogidos en
[T11](#t11--revisar-las-funciones-del-lector-pdf--m--pendiente).
