# ISSUES.md — BookReader — Errores conocidos

Proyecto funcional con 18 tests E2E pasando. Los issues de abajo están **resueltos**
(2026-06-28); se conservan como historial.

---

## ✅ RESUELTO — CRÍTICO — Layout de lectura muestra 2 columnas

**Archivo:** `js/epub-reader.js` + `css/main.css`
**Causa raíz real (verificada midiendo el DOM):** el `#epub-container` medía el ancho
completo del viewport (~1200px) mientras a `book.renderTo()` se le pasaba `width = 660`.
epub.js posiciona cada página paginada trasladando el iframe; con el contenedor más ancho
que la vista, el offset de la página dejaba de caer en un borde de columna y se colaba un
trozo de la página adyacente (las "2 columnas"). El `body { max-width / margin / padding }`
inyectado por el tema agravaba el desalineado.
**Solución aplicada:**
1. `sizeContainer()` fija el `#epub-container` exactamente al ancho del render
   (`columnWidth + 60`), `max-width:100%` y `margin:0 auto` para centrarlo. Se llama en
   `load()` y en el handler de `settings:changed` (antes del `rendition.resize`).
2. Se quitó `display:flex; justify-content:center` de `.epub-container` (interfería con el
   posicionamiento interno de epub.js).
3. La inyección de tema en el iframe ya no toca `max-width/margin/padding` del `body`.

**Verificación:** medición del DOM (rango visible del iframe = exactamente una columna) +
screenshots a 1200px → columna única centrada, sin recortes en los bordes.

---

## ✅ RESUELTO — MEDIO — Themes no se aplican correctamente al iframe de epub.js

**Archivo:** `js/epub-reader.js` — `applyTheme()` + `injectThemeIntoContent()`
**Solución aplicada:** una única estrategia de inyección. `injectThemeIntoContent()` es la
sola fuente; se registra en `rendition.hooks.content` para cada iframe nuevo y `applyTheme()`
la reaplica a los iframes existentes vía `rendition.getContents()`. Se eliminó
`injectThemeIntoAllFrames()` y las llamadas a `rendition.themes.default/override`.
**Verificación:** screenshot con tema oscuro → fondo y texto del iframe en oscuro.

---

## ✅ RESUELTO — MEDIO — El botón de bookmark a veces no refleja el estado real

**Archivo:** `js/epub-reader.js` — handler de `rendition.on('rendered')`
**Solución aplicada:** en `rendered` se refresca `currentCfi` con
`rendition.currentLocation()` antes de notificar a la app, evitando leer un CFI obsoleto
cuando `relocated` aún no ha disparado al volver a una página ya renderizada.

---

## ✅ RESUELTO — BAJO — PDF: texto seleccionable

**Archivo:** `js/pdf-reader.js` + `css/main.css`
**Solución aplicada:** tras renderizar cada página se monta una text layer de pdf.js sobre el
canvas (`page.getTextContent()` + `lib.renderTextLayer(...)`) dentro de un wrapper `.pdf-page`
con `--scale-factor`. CSS `.textLayer` con spans transparentes y `::selection` visible.
**Verificación:** PDF de prueba → 6 spans, 212 chars seleccionables, sin errores de consola,
selección alineada con el canvas.
**Pendiente (backlog):** crear highlights persistentes sobre PDF (solo está la selección/copia).

---

## ✅ RESUELTO — BAJO — No se puede reabrir el mismo archivo EPUB

**Archivo:** `js/app.js:50`
**Solución:** `fileInput.value = ''` después de cargar, para que seleccionar el mismo archivo
vuelva a disparar el evento `change`.

---

## INFO — Tests E2E

**Ubicación:** `tests/bookreader.spec.ts`  
**Cómo ejecutar:** `npx playwright test` (requiere `npx playwright install chromium` la primera vez)  
**Estado:** 18/18 pasan. El test de "export after highlight" depende de que el nombre del archivo de test sea `test.epub` (genera bookId `test`).

---

## ESTRUCTURA DEL PROYECTO

```
projects/bookreader/
├── index.html
├── css/
│   ├── main.css          ← layout base + sidebar + contenedor epub
│   ├── reader.css        ← estilos del iframe epub
│   └── themes.css        ← variables CSS por tema (light/sepia/dark)
├── js/
│   ├── app.js            ← orquestador, event wiring
│   ├── epub-reader.js    ← wrapper de epub.js (el más complejo)
│   ├── pdf-reader.js     ← wrapper de pdf.js
│   ├── bookmarks.js      ← CRUD de bookmarks en localStorage
│   ├── highlights.js     ← CRUD de highlights + export JSON
│   ├── settings.js       ← configuración de lectura
│   └── storage.js        ← abstracción localStorage
├── sw.js                 ← service worker
├── manifest.json         ← PWA
├── tests/
│   ├── test.epub         ← epub de prueba
│   └── bookreader.spec.ts ← 18 tests E2E
├── playwright.config.ts
├── AGENTS.md
├── ISSUES.md             ← este archivo
└── package.json
```
