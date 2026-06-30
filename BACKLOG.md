# BACKLOG — BookReader

Único backlog de lo **pendiente**. Lo entregado vive en [`CHANGELOG.md`](CHANGELOG.md).
Referencia: [`AGENTS.md`](AGENTS.md) (guía), [`DESIGN.md`](DESIGN.md) (diseño),
[`templates.md`](templates.md) (plantillas de libreta).

**Leyenda esfuerzo:** S < 0.5d · M ~1d · L ~2–3d. Los IDs entre paréntesis son los
históricos que cada ítem absorbe (trazabilidad con git).

---

## 🤖 IA / Agente

### IA1 — Recorte de contexto y de historial al LLM · `L` · **prioridad alta (coste)** _(ex T5, E3.2, E3.3)_
Hoy cada mensaje manda system prompt + **libro anotado completo** + **todo el historial**
([`js/ai/panel.js`](js/ai/panel.js), `history` sin recorte). Caro y lento en *cada* turno.
- Usar la relevancia por capítulo que ya existe (`saveRatings`/`getRatings` en
  [`js/ai/db.js`](js/ai/db.js)) para enviar **solo los capítulos relevantes**.
- **Resumen rodante** del historial (ventana de N turnos o resumen de lo viejo).
- **Guard por `tokenEstimate`**: avisar/confirmar antes de mandar libros enormes _(absorbe E2.3)_.
- Aprovechar **prompt caching**: prefijo estable (perfil + libro) primero.

### IA2 — Interrupción "Pepito Grillo" (Modelado de Comportamiento) · `M` _(ex E5.2)_
Con la plantilla correspondiente, que el agente interrumpa en puntos de quiebre del libro.

### IA3 — Reintentos automáticos en errores transitorios · `S` _(ex E7.1)_
Reintentar 429/5xx con backoff; hoy solo se muestra el error.

### IA4 — Retrieval a nivel de capítulo (plan B) · `M` _(ex E7.2)_
No urgente (el caching funciona, ver CHANGELOG E0.1). Palanca para libros enormes / sin caching.

---

## 🎨 Producto / UX

### P1 — Perfiles de agente estilo Hermes · `L` _(ex B1)_
**agent soul** (personalidad/system) + **user profile** (quién es el usuario) + **my notes**
(notas persistentes que el agente siempre tiene en cuenta). Varios perfiles **reutilizables
entre libros** (a diferencia de las `convos`, por libro). Se inyecta en `systemPrompt()` como
prefijo cacheable. Nuevo store `profiles` en IndexedDB.

### P2 — Plantillas de libreta propias · `M`–`L` _(ex B2)_
Permitir crear/editar tipos de libreta (campos, prompt de objetivo, rol del agente), no solo
las 6 de fábrica. Persistir en IndexedDB y mostrarlas junto a las de fábrica en el onboarding.

### P3 — Export / import global · `M` _(ex B3)_
Hoy solo se exportan los subrayados. Export **global** (subrayados, libretas/notas, perfiles,
conversaciones, ajustes) en JSON (backup round-trip) + Markdown legible. **Importar** el mismo
JSON para migrar entre dispositivos (la PWA es local-first, sin servidor).

### P4 — Swipe para pasar página en móvil · `M` _(ex B5)_
Como Play Books: swipe horizontal → `prev`/`next`. Hoy se pasa con toque en los bordes
([`js/touch-select.js`](js/touch-select.js)). **Cuidado con la coexistencia de gestos**:
long-press = seleccionar, swipe sin long-press = pasar, toque corto = navegar/inmersivo.

### P5 — Búsqueda de texto en el libro · `M`
Buscar y saltar a coincidencias dentro del EPUB.

### P6 — Mejoras de subrayados · `S`–`M`
- Importar JSON de highlights (restaurar), exportar también los bookmarks en el JSON.
- Exportar por color (solo amarillos, etc.); copiar el texto de un highlight al portapapeles.
- Confirmación al borrar y borrar desde el propio resaltado en el lector.

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

### TEC3 — `baseURL` del LLM editable en UI · `S` _(ex E1.2 🟡)_
Hoy `https://api.nan.builders/v1` está fijo en [`js/ai/llm.js`](js/ai/llm.js).
