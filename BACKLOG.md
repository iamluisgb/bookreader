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
- **Fase 3 — resumen rodante del historial:** resumir los turnos que salen de la ventana (1 llamada
  extra por turno) en vez de descartarlos, para conversaciones muy largas.
- **Retrieval por pregunta con embeddings:** si algún proveedor BYOK expone `/embeddings`, pasar de
  selección por *objetivo* a por *pregunta* (estilo NotebookLM). Convergería con IA4.

### IA2 — Interrupción "Pepito Grillo" (Modelado de Comportamiento) · `M` _(ex E5.2)_
Con la plantilla correspondiente, que el agente interrumpa en puntos de quiebre del libro.

### IA3 — Reintentos automáticos en errores transitorios · `S` _(ex E7.1)_
Reintentar 429/5xx con backoff; hoy solo se muestra el error.

### IA4 — Retrieval por pregunta con embeddings · `M` _(ex E7.2)_
El retrieval **a nivel de capítulo** ya lo entregó IA1 (fase 1). Lo que queda como palanca extra para
libros enormes es el retrieval **por pregunta** con embeddings (si un proveedor BYOK expone
`/embeddings`) — ver nota en IA1.

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

### P5 — Búsqueda de texto en el libro · `M`
Buscar y saltar a coincidencias dentro del EPUB.

### P6 — Mejoras de subrayados · `S`–`M`
- Exportar por color (solo amarillos, etc.); copiar el texto de un highlight al portapapeles.
- Confirmación al borrar y borrar desde el propio resaltado en el lector.
- _(El backup/restore de highlights y bookmarks ya lo cubre P3, ver CHANGELOG.)_

### P7 — Sync entre dispositivos · `L`
Requiere backend (hoy todo es local-first: IndexedDB + localStorage).

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

### PDF1 — IA/agente sobre PDF (fase 1, mayor impacto) · `L`
Es el salto de "visor de PDF" a "BookReader con PDF". Alimentar el pipeline de IA con el texto del PDF
en vez del `spine` de epub.js:
- Extraer texto por página con `page.getTextContent()` (ya se usa para la capa de texto).
- **Detección de PDF escaneado:** si las primeras páginas no tienen texto, avisar («este PDF no tiene
  texto seleccionable; el agente no puede leerlo») en vez de fallar en silencio. (Sin OCR; fuera de
  alcance.)
- Reconstruir estructura de capítulos con `pdf.getOutline()` cuando exista → mantener el `## capítulo`
  y que el recorte por relevancia de **IA1** funcione (no troceo tosco por página).
- Limpieza de extracción: unir palabras partidas por guión de justificación (`over‐ all` → `overall`).
- Generalizar `js/ai/segment.js` (hoy epub-only) tras una interfaz por formato.

### PDF2 — Selección→agente en PDF · `M`
Conectar la capa de texto **ya seleccionable** del PDF al panel IA y al tooltip de subrayar (hoy
dependen del evento `selected` de la `rendition` de epub.js, [`panel.js`](js/ai/panel.js) L190,
[`highlights-ui.js`](js/highlights-ui.js) L47). Habilita también HQ&A al subrayar en PDF.

### PDF3 — Subrayados/anotaciones en PDF · `L`
- **Modelo de ancla nuevo:** `{página, rects}` en vez de `cfi` (afecta a `js/highlights.js`, que hoy
  es cfi-only; el export ya contempla `page`).
- Dibujar los subrayados como **capa `<div>` overlay** sobre el canvas (no `rendition.annotations`,
  que es epub-only).
- Persistir y re-pintar al volver a la página.

### PDF4 — Modo scroll (capítulo continuo) en PDF · `M`
Renderizar páginas en continuo en vez de reutilizar un solo wrapper
([`renderPage`](js/pdf-reader.js) reusa `.pdf-page`). Equivalente al `scrolled-doc` de EPUB ya
entregado.

### PDF5 — Tipografía / tema en PDF · límite de formato
**No portable de raíz:** el texto del PDF es layout fijo (imagen), no reflowable. No hay tamaño de
fuente, ni reflow, ni recolorear texto. Máximo alcanzable: **zoom** y, para modo oscuro, un filtro
`invert` sobre el canvas (funciona pero degrada figuras/colores). Reflow real exigiría reconvertir el
PDF a HTML → **fuera de alcance**. Documentado aquí para no reabrir el debate.

---

## 🔧 Técnico (calidad / seguridad / perf / bugs)

### TEC1 — Revisar el lector PDF · `M` _(ex T11)_
Bugs de bajo nivel del visor. **Prerrequisito de la épica [PDF — paridad de features](#-pdf--paridad-de-features-con-epub)** (los ítems PDF1–PDF4 asumen un visor sólido).
[`js/pdf-reader.js`](js/pdf-reader.js) tiene **0 cobertura E2E**. Puntos:
- **Bug del ArrayBuffer *detached*:** al guardar un PDF en la biblioteca, `persistToLibrary`
  ([`js/app.js`](js/app.js) ~L82) hace `slice` sobre un buffer ya transferido a pdf.js → el
  PDF no se guarda. Clonar el buffer antes de `getDocument`.
- **Nitidez HiDPI:** `scale = 1.5` fijo ignora `devicePixelRatio` (canvas borroso); sin zoom.
- **Navegación por teclado** en PDF.
- _(IA y subrayados/selección en PDF → ahora en la épica [PDF — paridad de features](#-pdf--paridad-de-features-con-epub), PDF1–PDF3.)_
- **Errores/UX:** `catch(e){}` vacíos; sin UI de error; param `onProgress` de `load()` sin usar.
- **Acoplamiento a pdf.js 3.11** (`renderTextLayer` cambia de API en 4.x).

### TEC2 — Tests del panel IA (characterization) · `M` · **recomendación staff**
El panel IA tiene **0 cobertura** determinista (solo `@live` no determinista). Añadir tests que
fijen el comportamiento actual → red para cualquier refactor futuro del core (prerequisito para
un eventual store con API, ver decisión de T8 en el CHANGELOG).

