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

### T2 — Content-Security-Policy · `S`–`M` ⬜ PENDIENTE
No hay CSP. Dado el uso intensivo de `innerHTML`, una CSP da defensa en profundidad.
- Meta `Content-Security-Policy` en [`index.html`](index.html): restringir `script-src`
  a `self` + las CDN concretas (o solo `self` si se vendoriza en [T1](#t1)), `connect-src`
  a `self` + `https://api.nan.builders`, `img-src 'self' data:` (covers son data URLs).
- Mejor combinarlo con [T1](#t1): con libs vendorizadas la CSP queda mucho más estricta.

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

### T4 — Aviso de privacidad la primera vez que se usa el agente · `S` ⬜ PENDIENTE
Cada consulta envía el **texto completo del libro** a `api.nan.builders`
([`js/ai/panel.js`](js/ai/panel.js) ~L624). Es BYOK y opt-in, pero no hay aviso.
- Mostrar una nota la primera vez: "tu key vive solo en este navegador; el contenido del
  libro se envía al proveedor que elijas para responder".

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

### T6 — PWA realmente offline: precachear las libs core · `S`–`M` ⬜ PENDIENTE
El service worker ([`sw.js`](sw.js) L2-31) precachea el código propio pero **no**
jszip/epub.js/pdf.js (vienen de CDN) → sin red no se puede abrir ningún libro, lo que
contradice la promesa PWA.
- Si se vendoriza en [T1](#t1), añadir `vendor/*` a `ASSETS`.
- Si se sigue usando CDN, cachearlas explícitamente (con cuidado por CORS/opacas).

### T7 — Estrategia de caché del service worker · `S` ⬜ PENDIENTE
`fetch` es cache-first puro ([`sw.js`](sw.js) L49-53): los assets propios quedan congelados
hasta bumpear `CACHE_NAME` a mano (vamos por v25).
- Pasar a **stale-while-revalidate** para los assets propios: sirve de caché y refresca en
  segundo plano, eliminando el baile manual de versión.

### T8 — Trocear `app.js` y `panel.js` · `M`–`L` ⬜ PENDIENTE
[`js/app.js`](js/app.js) (~848 líneas) mezcla bookmarks, highlights, selección y progreso;
[`js/ai/panel.js`](js/ai/panel.js) (~920) concentra toda la UI del agente.
- No urgente. Trocear por responsabilidad si siguen creciendo (p.ej. `js/highlights-ui.js`,
  `js/progress.js`; separar onboarding/chat/notebook en la capa IA).

---

## ✨ Buenas prácticas

### T9 — Linter + formatter · `S` ⬜ PENDIENTE
No hay eslint/prettier. Útil para mantener la convención (funciones nombradas, sin arrow
anónimas en módulos públicos) conforme crece el código.
- ESLint flat config mínima + Prettier; opcional un check en CI / pre-commit.

### T10 — Metadatos de `package.json` · `S` ⬜ PENDIENTE
`description`, `author` vacíos y `license` ISC por defecto en
[`package.json`](package.json). Cosmético; rellenar o fijar la licencia real.

---

## Orden sugerido

1. **T1** (SRI/vendorizar) — cierra el riesgo supply-chain; si vendorizas, habilita T6.
2. **T5** (recorte de contexto al LLM) — el mayor coste recurrente.
3. **T6** (precache de libs) — PWA offline de verdad.
4. **T2 + T3** (CSP + cover/escapado) — defensa en profundidad de bajo esfuerzo.
5. Resto (T4, T7–T10) según oportunidad.
