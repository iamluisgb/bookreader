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

## 🔧 Técnico (calidad / seguridad / perf / bugs)

### TEC1 — Revisar el lector PDF · `M` _(ex T11)_
[`js/pdf-reader.js`](js/pdf-reader.js) tiene **0 cobertura E2E**. Puntos:
- **Bug del ArrayBuffer *detached*:** al guardar un PDF en la biblioteca, `persistToLibrary`
  ([`js/app.js`](js/app.js) ~L82) hace `slice` sobre un buffer ya transferido a pdf.js → el
  PDF no se guarda. Clonar el buffer antes de `getDocument`.
- **Nitidez HiDPI:** `scale = 1.5` fijo ignora `devicePixelRatio` (canvas borroso); sin zoom.
- **El agente IA no soporta PDF** (segmentación usa el spine de epub.js).
- **Highlights/marcadores en PDF:** hay text layer seleccionable pero no se persiste nada.
- **Navegación por teclado** en PDF.
- **Errores/UX:** `catch(e){}` vacíos; sin UI de error; param `onProgress` de `load()` sin usar.
- **Acoplamiento a pdf.js 3.11** (`renderTextLayer` cambia de API en 4.x).

### TEC2 — Tests del panel IA (characterization) · `M` · **recomendación staff**
El panel IA tiene **0 cobertura** determinista (solo `@live` no determinista). Añadir tests que
fijen el comportamiento actual → red para cualquier refactor futuro del core (prerequisito para
un eventual store con API, ver decisión de T8 en el CHANGELOG).

