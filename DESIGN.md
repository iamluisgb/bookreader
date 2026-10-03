# DESIGN — Lenguaje visual de BookReader

Referencia viva del sistema de diseño: principios, tokens, patrones y cómo se gobierna.
Si este documento y el código no coinciden, **el código manda y este documento está mal**:
corrígelo en el mismo commit. La historia de cómo se llegó aquí está en
[`CHANGELOG.md`](CHANGELOG.md) (rediseño F1–F5, UI2–UI4, sistema de diseño DS1).

- Tokens: [`app/css/themes.css`](app/css/themes.css) — **única fuente** para app y páginas públicas.
- Biblioteca de patrones viva: [`app/patterns.html`](app/patterns.html) (servir `app/` y abrirla).
- Reglas ejecutables: [`tests/css-vars.spec.ts`](tests/css-vars.spec.ts) y
  [`tests/patterns.spec.ts`](tests/patterns.spec.ts).

Objetivo: una app "compañero de estudio" calmada y enfocada. Referencias: **Apple Books**
(lectura inmersiva, poco cromo), **NotebookLM** (panel del agente, citas como ciudadanas de
primera clase). **Mobile-first / PWA** como requisito de primera clase.

---

## 1. Principios

Sirven para decidir. Si dos opciones parecen válidas, gana la que cumple más de estos.

1. **El contenido manda.** El texto del libro es el héroe; el cromo (barras, paneles) se
   atenúa y se aparta. Lectura inmersiva.
2. **Calma y foco.** Superficies neutras, mucho aire, sombras difusas. Nada de gradientes
   ruidosos ni sombras duras.
3. **El verde es identidad, no acción.** El verde señala marca, progreso, citas y selección.
   Las acciones principales van en **tinta** (`--btn-bg`). Cuando todo era verde, nada
   destacaba (UI2, 2026-09).
4. **Las citas son producto.** Los chips de cita, los subrayados y la relevancia de capítulos
   son elementos visuales de primer nivel, no decoración.
5. **Una sola lengua de diseño en 4 superficies**: lector · agente · biblioteca · páginas
   públicas (landing, /anki/, /privacy/). Mismos tokens, mismos nombres.
6. **Nada de barras de acento laterales.** El estado (activo, actual, seleccionado) se
   señala con fondo, color de texto y peso, nunca con un `border-left` o `box-shadow inset`
   de acento pegado al borde.
7. **Solo tokens.** Ningún color, tamaño de letra, radio, capa o breakpoint se escribe a mano.
   Si falta un valor, se crea el token en `themes.css` con un comentario que diga para qué
   es. Lo comprueba `npm test` (§7).
8. **Legible antes que sutil.** Todo texto cumple WCAG AA (4.5:1) sobre su superficie, en
   los cuatro temas. La jerarquía se consigue con tamaño y peso, no con grises ilegibles.

---

## 2. Tokens (`app/css/themes.css`)

Nombres por **rol**, nunca por valor ni por pantalla (`--text-soft`, no `--gray-500` ni
`--library-subtitle`).

| Familia | Tokens | Notas |
|---|---|---|
| Superficies | `--surface-0..3`, `--fill`, `--fill-strong`, `--fill-raised`, `--desk` | `--fill-raised` = opción elegida de un control segmentado |
| Texto | `--text`, `--text-soft`, `--text-faint` | los tres ≥ 4.5:1 en todos los temas |
| Acento | `--accent`, `--accent-hover`, `--accent-soft`, `--on-accent` | `#178046` claro · `#32d074` oscuro · `#146f3c` sepia |
| Marca | `--brand`, `--on-brand`, `--logo-*` | `#22c55e`: logo, CTA de la landing. No para controles de la app |
| Acción | `--btn-bg`, `--btn-bg-hover`, `--btn-ink` | botón principal en tinta |
| Feedback | `--danger`, `--on-danger`, `--warning`, `--success` | semántico, independiente del acento. Fondo suave: `color-mix(in srgb, var(--danger) 12%, transparent)` |
| Bordes | `--border`, `--border-soft` | |
| Elevación | `--shadow-1/2/3`, `--shadow` | |
| Radios | `--r-xs 4` · `--r-sm 8` · `--r-md 10` · `--r-lg 14` · `--r-xl 20` · `--r-pill` | `0` y `50%` (círculos) se permiten |
| Espacio | `--s-1..8` (4, 8, 12, 16, 20, 24, 32, 40) | |
| Letra | `--font-ui` (sistema), `--font-reader` (serif del libro), `--font-display` (Source Serif 4, marca), `--font-mono` | la serif de display es para la landing; dentro de la app la única serif es la del libro |
| Escala | `--fs-2xs 11` · `--fs-xs 12` · `--fs-sm 13` · `--fs-md 14` · `--fs-lg 16` · `--fs-xl 20` · `--fs-2xl 26` · `--fs-3xl 30` | ni un tamaño fuera de la escala (excepciones con nombre en el test) |
| Capas | `--z-content 20` · `--z-chrome 40` · `--z-scrim 90` · `--z-panel 100` · `--z-popover 200` · `--z-modal 300` · `--z-overlay 400` · `--z-tooltip 500` · `--z-toast 600` · `--z-status 900` · `--z-picker 1000` · `--z-dialog 3000` · `--z-screen 9000` | variantes dentro de una capa: `calc(var(--z-popover) + 50)`. Dentro de un componente, enteros 1–10 |
| Motion | `--ease`, `--ease-out-soft`, `--transition-fast/normal/panel` | respetar `prefers-reduced-motion` |

**Temas:** claro, oscuro (manual o `prefers-color-scheme`) y sepia (solo lectura). Un tema
**solo redefine tokens**: ningún componente lleva reglas `[data-theme="…"]` propias para
cambiar un color. Si un componente necesita otro valor en oscuro, eso es un token nuevo.

**Páginas públicas** (landing EN/ES, /anki/, /privacy/): cargan `app/css/themes.css` y, después,
[`assets/landing/brand.css`](assets/landing/brand.css), que solo añade lo que la app no tiene
(papel del libro ilustrado, banda oscura, sombra del hero).

---

## 3. Arquitectura responsive

| Breakpoint | Qué cambia |
|---|---|
| `max-width: 600px` | móvil estrecho: ajustes finos de chips, hojas y diálogos |
| `max-width: 767px` (= móvil < 768) | paneles como *bottom sheets*, FAB del agente. Lo replican `js/ai/panel.js` y `js/ai/sheet-height.js` |
| `min-width: 1001px` | lector a doble página con «escritorio». **Ligado a `epub-reader.js` (`vw > 1000`)**: no moverlo solo en CSS |
| `max-width: 1023px` (= tablet < 1024) | agente e índice como drawers superpuestos |
| `max-height: 480px` | móvil apaisado |

Media queries de capacidad (`pointer: coarse`, `hover: none`) en lugar de anchos cuando lo
que cambia es el tipo de entrada. Ningún otro ancho: lo comprueba el test.

Detalles móviles: `100dvh` (no `100vh`), `env(safe-area-inset-*)`, `viewport-fit=cover`,
`overscroll-behavior: contain` en los sheets, targets táctiles ≥ 44px.

---

## 4. Patrones

Un patrón se nombra por su **función**, no por la pantalla donde vive. Las clases de contexto
(`.lib-upload`, `.dlg-ok`, `.reading-mode-btn`…) se mantienen como ganchos de JS y tests y
para ajustes de forma o tamaño propios de ese sitio, **nunca** para color ni estados.
Catálogo con ejemplos vivos: `app/patterns.html`.

| Patrón | Clases | Para |
|---|---|---|
| Botón principal | `.btn.btn--primary` | la acción principal de la vista (una por vista) |
| Botón secundario | `.btn.btn--secondary` | acciones de apoyo |
| Control segmentado | `.segmented` > `.segmented-btn(.active)` | elegir 1 de 2–5 opciones que cambian la vista (modo de lectura, ajuste PDF, pestañas) |
| Chip de cita | `.ai-cite` | ir del texto del agente al pasaje |
| Acción destructiva | `.sel-act--danger`, `.dlg-danger` | borrar; usa `--danger` |

**Estados:** para código nuevo, `.is-*` (`.is-active`, `.is-busy`, `.is-error`). `.active`
y `.open` siguen en el código existente; no mezclar los dos en un mismo componente.

### Iconos

Un solo set de línea en `js/ui/icons.js` (rejilla 24×24, `currentColor`, `aria-hidden`; el
texto o el `aria-label` del botón los nombra). Galería con su significado en
`patterns.html § Iconos`. Reglas (`tests/icons.spec.ts`):

- **Un significado por icono.** `sparkles` = lo hace la IA; `funnel` = filtro por regla
  (estantería inteligente); `pin` = fijar; `bookmark` = marcar página; `note` = nota suelta;
  `notebook` = la libreta; `share` = hoja de compartir del sistema; `download`/`upload` =
  guardar/subir un fichero; `cloud` = Drive y sincronizar; `chart` = Análisis; `function` =
  ejemplo con números; `user` = tu perfil; `users` = otra persona; `flame` = racha;
  `help` = ayuda; `info` = nota informativa. Antes de reutilizar uno para otra cosa, crea
  otro: dos significados para un dibujo obligan a leer la etiqueta siempre.
- **Tamaño por paso, nunca en píxeles:** `icon(name, { size: 'md' })`. `sm` 14 (en línea
  con texto pequeño) · `md` 16 (botones, menús) · `lg` 20 (acciones destacadas) · `xl` 24
  (cabecera, lector) · `display` 32 · `hero` 56 (estados vacíos). Tokens `--icon-*`; el
  trazo baja al crecer (1,9 → 1,4).
- **Sin emoji en la interfaz:** cambian de dibujo en cada sistema y no siguen el tema. La
  excepción es la tarjeta para compartir (imagen para redes). Las flechas tipográficas de un
  texto («Ajustes → Agente») no son iconos y se quedan.
- **Icono nuevo:** dibújalo en la rejilla 24 con trazos `round`, añádelo a `ICONS` con un
  comentario de para qué es (y qué NO es), y a `SIGNIFICA` en `patterns.html`.

**Añadir un patrón:** 1) mira si ya existe en `patterns.html`; 2) si no, dale un nombre
por función y defínelo en `modern.css` (§5); 3) añádelo a `patterns.html` y, si tiene
tokens propios, al contrato de `tests/patterns.spec.ts`.

---

## 5. Hojas de estilo y cascada

Orden en `app/index.html` (lo fija la posición del `<link>`, no cuándo carga):

1. `fonts.css` — `@font-face`.
2. `themes.css` — tokens y temas.
3. `main.css` — layout y estilos por pantalla.
4. `reader.css`, `temml.css` — iframe del EPUB y fórmulas.
5. *(hueco `#css-slot-agent`)* — aquí inserta `js/css-loader.js` **`agent.css`** (panel del
   agente y ajustes, carga perezosa).
6. `modern.css` — **capa de sistema**: §1 base tardía (foco, tooltips, responsive, antes
   `main-late.css`) y §2 patrones. Va la última para ganar los empates.

Un patrón se define **una vez**, en `modern.css`. Si una pantalla necesita retocarlo, lo
hace por su clase de contexto y solo en forma o tamaño.

---

## 6. Biblioteca de patrones

`app/patterns.html` carga las mismas hojas que la app y lee los valores de los tokens en el
navegador: no puede quedarse desfasada. Incluye un selector de tema (sistema, claro,
oscuro, sepia). Es de uso interno y queda **fuera del deploy** (`EXCLUIDOS` en
`scripts/build-pages.mjs`). Servir con `python3 -m http.server -d app` y abrir `/patterns.html`.

---

## 7. Gobernanza

El sistema es pequeño y lo tocan una persona y agentes de IA. Un agente no tiene criterio
implícito, así que las reglas son **tests**, no recomendaciones:

- `tests/css-vars.spec.ts` (en `npm test`):
  - toda `var(--x)` sin fallback está definida;
  - `font-size` solo con `--fs-*` (excepciones con nombre en el propio test);
  - `border-radius` solo con `--r-*`, `0` o `50%`;
  - `z-index` > 10 solo con `--z-*`;
  - breakpoints solo los de §3;
  - rojos/ámbares/verdes de feedback solo con `--danger/--warning/--success`, y un **techo**
    de colores hex sueltos por fichero que solo puede bajar.
- `tests/patterns.spec.ts`: cada patrón se pinta con sus tokens en los cuatro temas.

Si un test te frena: **no lo relajes**. Crea el token o usa el patrón. Si de verdad hace falta
una excepción, añádela con un comentario que diga por qué.

---

## 8. Decisiones

- **2026-06-29** — Estética NotebookLM; tema por defecto = sistema; navegación móvil FAB +
  drawers; iconos PWA aportados por el autor.
- **2026-09** (UI2–UI4) — Línea Apple: letra del sistema, grises de Apple, botón principal en
  tinta, controles segmentados. El acento pasa de índigo `#5B6CFF` a esmeralda `#178046`; el
  verde de marca `#22c55e` queda para identidad.
- **2026-10-03** (DS1, auditoría según *Design Systems* de A. Kholmatova) — Tokens únicos
  para app y páginas públicas; escala de capas y feedback; `--fs-xs` = 12px (antes 11px,
  ahora `--fs-2xs`); contraste AA en `--text-soft/--text-faint` y en el acento sepia;
  patrones por función (`.btn--*`, `.segmented`); `main-late.css` fusionada en `modern.css`;
  breakpoints 560/620 → 600; biblioteca de patrones y reglas ejecutables.
