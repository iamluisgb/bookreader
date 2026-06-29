# DESIGN-PLAN — Rediseño visual de BookReader

Objetivo: elevar la app a un "compañero de estudio" calmado y enfocado, inspirado en
**NotebookLM** (superficies tonales, tarjetas redondeadas, chips, jerarquía tipográfica
clara, citas como ciudadanas de primera clase) y **Playbook/Play Books** (lectura inmersiva,
poco cromo, foco en el contenido). **Mobile-first / PWA** como requisito de primera clase.

---

## 1. Principios

1. **El contenido manda.** El texto del libro es el héroe; el cromo (barras, paneles) se
   atenúa y se aparta. Lectura inmersiva.
2. **Calma y foco.** Superficies neutras con capas tonales sutiles, mucho aire, una sola
   acento. Nada de gradientes ruidosos ni sombras duras.
3. **Las citas son producto.** Los chips `[[aN]]`, los subrayados y la relevancia de
   capítulos son elementos visuales de primer nivel, no decoración.
4. **Una sola lengua de diseño en 3 superficies**: lector · agente · libreta.
5. **Responsive de verdad.** No "encoge el desktop": en móvil los paneles son *drawers/bottom
   sheets*, el lector ocupa toda la pantalla, navegación por gestos/tab inferior.

---

## 2. Tokens de diseño (reescritura de `themes.css`)

Hoy hay ~12 variables planas. Pasamos a un sistema con escalas semánticas:

- **Superficies (elevación tonal, estilo NotebookLM/Material 3):**
  `--surface-0` (fondo app) · `--surface-1` (paneles) · `--surface-2` (tarjetas) ·
  `--surface-3` (hover/activo). En claro = blancos/grises muy sutiles; en oscuro = grises
  azulados en vez del actual `#1a1a2e` saturado.
- **Texto:** `--text` · `--text-soft` · `--text-muted` · `--text-on-accent`.
- **Acento:** `--accent`, `--accent-hover`, `--accent-soft` (fondo tenue para chips/badges).
- **Bordes y líneas:** `--border`, `--border-soft`.
- **Elevación:** `--shadow-1/2/3` (sombras suaves, difusas, baja opacidad).
- **Radios:** `--r-sm 8` · `--r-md 12` · `--r-lg 16` · `--r-xl 22` · `--r-pill 999`.
- **Espaciado (escala 4px):** `--s-1..--s-8` (4,8,12,16,20,24,32,40).
- **Tipografía:** `--font-ui` (Inter/system), `--font-reader` (serif), `--font-display`
  (un poco más de carácter para títulos del onboarding). Escala `--fs-xs..--fs-2xl`.
- **Motion:** `--ease`, `--dur-fast/normal`; respetar `prefers-reduced-motion`.

Temas: **claro**, **oscuro** (rediseñado, menos saturado) y **sepia** (solo lectura).
Acento por defecto propuesto: índigo/azul calmado (afinar el `#4a90d9` actual hacia algo más
sobrio) — *a confirmar*.

---

## 3. Arquitectura responsive

Breakpoints: **móvil < 768** · **tablet 768–1024** · **desktop ≥ 1024**.

### Desktop (≥1024)
Tres zonas, como NotebookLM:
```
┌──────────┬───────────────────────┬───────────────┐
│  Índice   │       Lector           │   Agente       │
│ (drawer   │   (centrado, inmersivo)│  Chat │ Libreta │
│  o rail)  │                        │                │
└──────────┴───────────────────────┴───────────────┘
```
El panel del agente se queda fijo a la derecha (ancho afinado, redimensionable opcional).

### Tablet (768–1024)
El agente pasa a **overlay drawer** (no empuja el lector); el índice también. Backdrop.

### Móvil (<768) — el gran cambio
- **Lector a pantalla completa**, cromo mínimo (header translúcido que se auto-oculta al leer).
- **Barra inferior** con accesos: Índice · (centro: progreso) · Agente. (Patrón a confirmar:
  tab bar inferior vs FAB.)
- **Índice, Agente y Libreta** = **bottom sheets** a pantalla casi completa, deslizables,
  con "grabber" superior. El onboarding = sheet/stepper a pantalla completa.
- **Gestos**: tap en bordes / swipe para pasar página; swipe-down para cerrar sheets.
- **Tipografía y toques** ajustados: targets ≥ 44px, texto del lector responsive.

Detalles técnicos móviles: `100dvh` (no `100vh`), `env(safe-area-inset-*)` para notch,
`viewport-fit=cover`, `overscroll-behavior: contain` en los sheets, evitar zoom accidental.

---

## 4. Componentes (restyle)

- **Topbar/lector:** más limpia, translúcida con blur sutil; título del libro centrado; iconos
  redondeados con estados hover/active claros. En móvil se auto-oculta.
- **Botones:** sistema único — `pill` (acciones primarias), `ghost` (secundarias), `icon`
  (circulares, 40px). Estados consistentes.
- **Panel del agente:** cabecera con avatar/título, pestañas Chat/Libreta tipo *segmented
  control*. Estado "leyendo el libro…" con shimmer en vez de texto seco.
- **Burbujas de chat:** del agente sin "burbuja" pesada (estilo NotebookLM: bloque de texto
  con buena tipografía Markdown); del usuario como pill/acento. Acciones (Copiar / A la
  libreta) como iconos sutiles al hover.
- **Chips de cita `[[aN]]`:** pill pequeño con `--accent-soft`, número, icono ↗ al hover.
- **Libreta:** tarjetas por campo con la etiqueta como *eyebrow*, notas como tarjetas suaves,
  editor inline más cuidado; objetivo destacado arriba.
- **Onboarding:** stepper a pantalla completa (sobre todo en móvil), tarjetas de bloque/
  plantilla grandes y táctiles, microcopy.
- **Índice con relevancia:** la atenuación/★ integrada con el nuevo estilo (badge sutil en
  vez de solo opacidad).
- **Progreso/lector footer:** barra más fina y elegante, % y tiempo restante discretos.
- **Estados vacíos y skeletons** coherentes.

---

## 5. PWA (hoy incompleta)

- `manifest.json`: añadir **iconos** (192/512 + **maskable**), `theme_color` y
  `background_color` nuevos, `display: standalone`, `orientation`, `categories`,
  `description`. (Necesitamos generar los iconos.)
- `index.html`: `viewport-fit=cover`, `apple-mobile-web-app-*`, `theme-color` dinámico por
  tema, splash básico.
- Confirmar que `sw.js` cachea el nuevo CSS/assets (shell offline).
- **Instalable** y con barra de estado tematizada (claro/oscuro).

---

## 6. Plan de ejecución por fases (sin romper los 18 tests deterministas)

> Cada fase: implementar → `npm test` (18 verdes) → screenshots **desktop + móvil** (viewport
> 390×844) → ajustar.

- **F1 · Tokens y primitivas** ✅ HECHO (2026-06-29) — `themes.css` reescrito (paleta neutra
  NotebookLM + acento índigo, oscuro rediseñado, sepia; escalas de radio/espaciado/sombra/
  tipografía; alias antiguos conservados). **Tema por defecto = sistema** (`prefers-color-
  scheme`) con botón Auto + override claro/oscuro/sepia; lector resuelve el tema del sistema.
  18/18 verde; verificado en claro y oscuro.
- **F2 · Responsive / móvil** ✅ HECHO (2026-06-29) — breakpoints (≥1024 empuja, <1024
  superpone, <768 sheets). Agente y onboarding como **bottom sheets** (grabber, esquinas
  redondeadas); índice como drawer; **scrim** (`:has`) que cierra al tocar; **FAB 🤖** por
  encima del footer; `#ai-toggle` oculto en móvil; safe-areas (`env(...)`) + `100dvh`; foco
  accesible índigo. 18/18 verde; verificado a 390×844 (lector, onboarding, sheet, drawer).
- **F3 · Restyle de componentes** ✅ HECHO (2026-06-29) — chat estilo NotebookLM (mensaje
  del agente como bloque limpio sin caja; usuario como burbuja de acento), **chips de cita
  pill** `--accent-soft`, pestañas **segmented control**, header translúcido (blur), botones
  **pill**, progreso fino, libreta con **eyebrow** + tarjetas suaves, foco índigo, **shimmer**
  de estado mientras el agente trabaja. 18/18 verde; verificado.
- **F4 · PWA + lector inmersivo** ✅ HECHO (2026-06-29) — `manifest.json` completo + iconos
  192/512/maskable/apple (placeholder libro-índigo, **sustituibles**), metas Apple/`theme-color`,
  **theme-color dinámico** por tema (barra de estado), `sw.js` v2 cachea los módulos IA +
  iconos. **Modo lectura inmersivo**: botón ⤢ oculta header/footer; overlay de zonas táctiles
  (izq/centro/der = anterior/salir/siguiente). 18/18 verde; verificado en móvil + oscuro.

- **F5 · Estilo Apple + iconos SF Symbols** ✅ HECHO (2026-06-29) — se eliminan TODOS
  los emojis. Nuevo sistema de iconos de línea SVG (`js/ui/icons.js`, ~24 glifos,
  `currentColor`, trazo 1.7, hidratados vía `[data-icon]` + `hydrateIcons`). Tokens
  reescritos a paleta del sistema iOS: acento **azul de Apple** (#007AFF claro / #0A84FF
  oscuro), grises systemGray, oscuro casi-negro con "página flotante". Texto del libro en
  **serif New York** (`ui-serif`). Selector de tema como **muestras de color** (estilo Apple
  Books). Botones con pulsado sutil (scale), discos de acento en el onboarding, papelera roja
  systemRed. `theme-color`/manifest actualizados. 19/19 verde; verificado en claro, oscuro y
  móvil.

Verificación visual con Playwright en dos viewports; los selectores/IDs existentes se
conservan para no romper tests ni la lógica.

---

## 7. Decisiones tomadas (2026-06-29)

1. **Estética:** NotebookLM — neutro calmado. Superficies blancas/grises sutiles, acento
   **índigo `#5B6CFF`**, tarjetas redondeadas, mucho aire.
2. **Tema por defecto:** **seguir el sistema** (`prefers-color-scheme`), con override manual
   a claro/oscuro/sepia.
3. **Navegación móvil:** **FAB + drawers** — lector limpio, FAB 🤖 abre el agente, icono/gesto
   abre el índice. Máximo espacio de lectura.
4. **Iconos PWA:** los aporta el usuario. Dejo el `manifest.json` y los `<meta>` preparados
   con placeholders documentados para sustituir.
