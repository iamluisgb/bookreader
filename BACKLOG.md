# BACKLOG — Producto (peticiones del usuario)

Bandeja de entrada de ideas de producto. El backlog de la feature de IA (agente +
libreta) vive en [`BACKLOG-AI.md`](BACKLOG-AI.md); aquí van peticiones transversales.

**Leyenda esfuerzo:** S < 0.5d · M ~1d · L ~2–3d.

---

## Añadido 2026-06-30 (peticiones del usuario)

### B1 — Personalizar el agente estilo Hermes + perfiles múltiples · `L` ⬜ PENDIENTE
Inspiración: Hermes — **agent soul** (personalidad/system del agente), **user profile**
(quién es el usuario: intereses, nivel, idioma, qué busca al leer) y **my notes** (notas
persistentes del usuario que el agente tiene siempre en cuenta).
- Crear y cambiar entre varios **perfiles de agente**, cada uno con su soul + profile + notes,
  **reutilizables entre libros** (a diferencia de las `convos`, que son por libro).
- El perfil activo se inyecta en el `systemPrompt()` ([`js/ai/panel.js`](js/ai/panel.js))
  como prefijo cacheable, antes del libro.
- Relación: hoy hay conversaciones por libro (`convos` en [`js/ai/db.js`](js/ai/db.js)) y
  plantillas. Esto añade una capa de **persona/perfil** por encima, independiente del libro.
- Persistencia: nuevo store `profiles` en IndexedDB.

### B2 — Más tipos de libretas (plantillas propias) · `M`–`L` ⬜ PENDIENTE
Hoy hay 6 plantillas fijas ([`templates.md`](templates.md) / [`js/ai/templates.js`](js/ai/templates.js)).
- Permitir al usuario **crear/editar tipos de libreta** con sus propios campos (clave, tipo,
  prompt de objetivo, rol del agente), no solo las 6 de fábrica.
- Persistir plantillas de usuario (IndexedDB) y mostrarlas junto a las de fábrica en el
  onboarding (bloque → plantilla → objetivo).

### B3 — Exportar (y quizá importar) todo lo que crea el usuario · `M` ⬜ PENDIENTE
Hoy solo se exportan los **subrayados** a JSON (botón en la pestaña Subrayados).
- Export **global**: subrayados, libretas/notas, perfiles de agente (B1), conversaciones y
  mensajes, ajustes. Formato JSON (backup/round-trip) y opcional Markdown legible.
- Considerar **importar** el mismo JSON para restaurar/migrar entre dispositivos (la PWA es
  local-first: IndexedDB + localStorage, sin servidor).

### B4 — Borrar un subrayado · `S` ✅ HECHO (2026-06-30)
El botón ✕ de la lista ahora **refresca la lista** (`renderHighlights()`) y **quita el
resaltado pintado** en la página (`rendition.annotations.remove(cfi, 'highlight')`).
Verificado E2E: subrayar → borrar → lista vacía + botón Exportar deshabilitado.
- Opcional pendiente: confirmación y borrar desde el propio resaltado en el lector (barra de
  selección al tocar un subrayado existente).

### B5 — Pasar de página deslizando el dedo en móvil (swipe) · `M` ⬜ PENDIENTE
Como Play Books: **swipe horizontal** para anterior/siguiente. Hoy en móvil se pasa página
con **toque en los bordes** ([`js/touch-select.js`](js/touch-select.js)).
- Añadir gesto de arrastre horizontal (umbral de distancia/velocidad) → `prev`/`next`.
- **Cuidado con la coexistencia de gestos**: mantener pulsado = seleccionar texto; arrastre
  horizontal rápido = pasar página; toque corto en zonas = navegar/inmersivo. Distinguir
  swipe-para-pasar de arrastre-para-seleccionar (la selección se inicia con long-press, así
  que un arrastre sin long-press previo puede tratarse como swipe).
- Opcional: animación de deslizamiento de la página (epub.js no la trae de serie).
