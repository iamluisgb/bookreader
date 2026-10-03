# Auditoría — cabecera del lector, panel lateral y panel del agente

Fecha: 2026-10-03. Alcance: la cabecera del lector (`#reader-header`) y cómo convive con el panel
lateral (`#sidebar`: índice, buscar, marcadores, subrayados y ajustes de lectura) y con el panel
del agente (`#ai-panel`). No incluye el pie ni el contenido de los paneles salvo donde tocan la
cabecera.

**Queja de partida (dueño del producto).** «Queda raro que el icono sea para ir al menú y cuando
se abre la sidebar quede centrado.» Con el panel lateral abierto, el botón de volver (‹ + logo) y
el icono de panel acaban flotando a media pantalla, pegados al borde del panel, mientras el panel
repite marca («BookReader») y tiene su propio cierre.

**Método.** Playwright contra la app local (`localhost:8888`) con `tests/test.epub` y
`tests/test-multipage.pdf`. Capturas a 1440×900, 1100×800 y 390×844 (táctil), en claro y en
oscuro, con el panel lateral cerrado y abierto, el agente abierto, ambos abiertos, «cromo en
calma» y un título largo («Designing Data-Intensive Applications: The Big Ideas Behind…»
inyectado en `#reader-title`). Posiciones medidas con `getBoundingClientRect`. Las cifras de
abajo salen de ahí (x = borde izquierdo, en px).

---

## 1. Diagnóstico

### Lo que funciona

- **Tres cabeceras alineadas.** Lector, panel lateral y agente miden 52 px
  (`--header-height`) y sus bordes inferiores coinciden. Visualmente es una sola franja.
- **Título centrado sobre la columna de lectura**, no sobre la ventana: con el panel lateral
  abierto a 1440, el centro del título queda en x = 880, el centro exacto de 320–1440. Es lo que
  hace Apple Books y es correcto.
- **Empujar en escritorio, superponer en móvil.** El texto nunca queda tapado por un panel en
  escritorio, y en móvil el cajón con *scrim* es el patrón esperado.
- **Cromo en calma.** A los 2,5 s todo el contenido de cabecera y pie se desvanece por opacidad
  (medido: `opacity 0` en los cinco grupos) sin repaginar. Queda solo el papel. Muy en la línea
  de Apple Books y Play Books.
- **Estado de los toggles sin barras laterales.** Panel y agente abiertos se marcan tiñendo su
  icono de acento (`modern.css:280`). Cumple el principio 6.
- **«Más» (⋯)** reúne Ajustes de lectura, Ajustes generales y Biblioteca, con el mismo menú que
  la biblioteca. Es un buen cajón para lo secundario.
- **44 px en táctil**: todos los botones visibles de la cabecera miden 44×44 a 390 (el de volver,
  46×44).

### Problemas, por impacto

**P1 · La navegación global vive dentro del lector y viaja con él.**
`#library-btn` y `#sidebar-toggle` son hijos de `.reader-header`, que está dentro de
`.reader-main`, y abrir el panel empuja `.reader-main` con `margin-left: var(--sidebar-width)`
(`main.css:1159`). Resultado medido a 1440:

| Estado | Volver (‹ logo) | Panel | Título |
|---|---|---|---|
| Panel cerrado | x = 12 | x = 70 | centro 720 |
| Panel abierto | **x = 332** | **x = 390** | centro 880 |
| Panel + agente | x = 332 | x = 390 | centro 690 |

Los dos controles saltan 320 px a la derecha y quedan en mitad de la pantalla, a 12 px del borde
del panel. Es la queja literal. Además, en ese estado hay **dos controles que cierran lo mismo**
a 123 px uno del otro: la ✕ del panel (x ≈ 285) y el icono de panel teñido de acento (x = 390).
Ningún lector de referencia hace esto: en Apple Books para Mac, Readwise Reader y las apps de
sistema de macOS (Notas, Mail, Finder) el botón de mostrar/ocultar el panel **no se mueve** al
abrirlo: está siempre en la misma esquina, y ese mismo botón lo cierra.

**P2 · El título se monta encima de los iconos (bug visible, también en móvil).**
`.reader-title` es `position: absolute` centrado con `max-width: min(calc(100% - 260px), 460px)`
(`main.css:646`). Los 260 px suponen que las dos islas de iconos suman 260, pero la izquierda
ocupa ~104 px y la derecha 196 (escritorio) o 188 (móvil); y para centrar sin chocar hay que
reservar **dos veces la isla más ancha** (~420 px), no la suma. Medido:

| Viewport · estado | Caja del título | Iconos de la derecha empiezan en | Solape |
|---|---|---|---|
| 390 · «Pedro Páramo» | 142–248 | 190 | **58 px** (tapa «pantalla completa») |
| 390 · título largo | 130–260 | 190 | **70 px** |
| 1100 · panel + agente | 467–573 | 512 | **61 px** |
| 1100 · agente · título largo | 130–590 | 512 | **78 px** (tapa pantalla completa y buscar) |

En móvil ocurre **siempre**, con cualquier título de más de ~7 caracteres: en la captura de 390
se lee «Pedro Pá[⤢]ramo». Como el título tiene `pointer-events: none`, los iconos siguen
pulsables, pero la cabecera se ve rota.

**P3 · El logo como «volver» sigue siendo ambiguo, y la marca está dos veces.**
El «‹» que se añadió en la auditoría móvil (Q7) ayuda, pero es un glifo pequeño en `--text-soft`
pegado (`margin-right: -2px`) a un imagotipo de color de 24 px: el ojo ve el logo, no la flecha.
Un logo arriba a la izquierda se lee como «inicio/marca» en la web, no como «atrás». Y con el
panel abierto aparecen a la vez «BookReader» (h2 del panel) y el logo: **dos marcas en 400 px**
de franja, en la pantalla donde el principio 1 dice que el contenido manda. Kindle, Play Books,
Kobo y Readwise usan una flecha (con o sin la palabra «Biblioteca»); ninguno pone su logo en el
lector.

**P4 · Los ajustes de lectura están dentro del panel del índice y lo empujan todo.**
El botón de ajustes (sliders) vive en la cabecera del panel lateral, y «Más → Ajustes de
lectura» abre ese mismo panel (`app.js:514`). En escritorio el panel **empuja y repagina** el
texto: cambias el tamaño de letra mirando una columna 320 px más estrecha que la que tendrás al
cerrarlo, así que la vista previa no es fiel. Apple Books, Kindle, Kobo y Play Books coinciden:
«Aa» en la cabecera, abre un **popover/hoja que no mueve el texto**, para ver el cambio sobre la
página real. Además, el índice y la apariencia son tareas distintas y hoy comparten panel (el
sliders se comporta como una quinta pestaña escondida).

**P5 · Móvil: siete piezas en 390 px, y nombres que no dicen lo que hacen.**
A 390 la cabecera lleva ‹logo · panel · título · pantalla completa · buscar · marcador · ⋯ (más el
FAB del agente abajo). Al título le quedan 130 px y aun así choca (P2). Apple Books en iPhone
deja arriba solo cerrar y el título, y todo lo demás en un único menú; Play Books y Kindle,
flecha · (título) · 2-3 acciones. Además:
- `#immersive-toggle` se anuncia como **«Modo lectura»** (`index.html:222`) pero en escritorio y
  móvil hace pantalla completa (el nombre solo se corrige tras el primer cambio, `app.js:985`). Y
  «Modo de lectura» ya es otra cosa: Páginas/Doble/Scroll en los ajustes. Un nombre, dos
  significados.
- `#sidebar-toggle` dice siempre **«Abrir sidebar»**, también abierto; no tiene `aria-expanded`
  ni `aria-controls`, y «sidebar» es la única palabra en inglés de la cabecera. Lo mismo
  `#ai-toggle` (sin `aria-expanded`).
- El panel se abre desde cuatro sitios con lógica distinta: el toggle (marca el capítulo actual,
  `app.js:1312`, y dispara la atenuación del agente, `panel.js:200`), la lupa (`app.js:1271`) y
  «Más → Ajustes de lectura» (`app.js:514`) hacen `classList.add('open')` a mano y se saltan
  ambas cosas. No hay atajo de teclado para panel ni agente.

**Menores.** El pie a 390 trunca el capítulo a «Cu…» teniendo sitio; en modo oscuro el conjunto
es correcto (contraste y teñido de acento bien), sin hallazgos propios.

---

## 2. Recomendaciones

Impacto A/M/B × esfuerzo S/M/L. Las referencias a otras apps describen sus versiones habituales;
el patrón importa más que el píxel.

### Quick wins (S, se pueden hacer ya y por separado)

| # | Problema | Propuesta (lo que ve y hace el usuario) | Ref. | Imp. | Esf. |
|---|---|---|---|---|---|
| Q1 | P2 | **El título nunca pisa un icono.** Cabecera como rejilla de tres columnas `1fr auto 1fr`: islas a los lados y el título en la central, con `min-width: 0` y elipsis. El centro sigue siendo el de la columna de lectura y el truncado sale solo del sitio que hay de verdad. Si quedan menos de ~120 px, el título se oculta (el capítulo ya está en el pie). Título completo en `title` y en el `aria-label` de la región. | Apple Books oculta el título cuando no cabe | A | S |
| Q2 | P3 | **Volver = flecha + palabra.** `‹ Biblioteca` en texto (≥ 768 px) y solo `‹` de 44 px en móvil, ambos en `--text-soft` → `--text` al pasar. Fuera el imagotipo del lector: la marca vive en la biblioteca y en la landing. El tooltip pasa a sobrar. | Kindle (←), Play Books (←), Kobo (‹), Apple Books iPad («Biblioteca» en sus versiones con texto) | A | S |
| Q3 | P3 | **Fuera «BookReader» del panel.** El h2 se cambia por la identidad del libro: título (1 línea, elipsis) y autor en `--text-soft`. El panel deja de repetir marca y pasa a decir de qué libro es el índice. | Kindle y Apple Books abren el índice con portada, título y autor | M | S |
| Q4 | P5 | **Nombres y estado accesibles.** Toggle de panel: «Índice y notas», con `aria-expanded` y `aria-controls="sidebar"`, y la etiqueta cambia a «Ocultar índice y notas» abierto. `#ai-toggle` con `aria-expanded`. `#immersive-toggle` se llama «Pantalla completa» desde el arranque (y «Salir de pantalla completa» dentro). Claves i18n nuevas. | HIG: el nombre describe la acción, no el componente | M | S |
| Q5 | P5 | **Un solo `setSidebar(open, tab)`** que usen toggle, lupa, «Más» y el agente: marca el capítulo actual, dispara la atenuación y actualiza `aria-expanded` siempre igual. Atajos: `[` o `T` para el índice y `.` (o el que ya se use en el agente) para el agente, mostrados en el tooltip. | Readwise Reader (`[` / `]` para los paneles) | M | S |

### Cambios de fondo

| # | Problema | Propuesta | Ref. | Imp. | Esf. |
|---|---|---|---|---|---|
| F1 | P1 | **Carril de navegación fijo.** «‹ Biblioteca» y el botón de panel salen de `.reader-header` a un grupo propio (`.reader-nav`) anclado arriba a la izquierda de la **ventana**, en `position: fixed` con altura `--header-height` y capa justo por encima del panel (`calc(var(--z-panel) + 1)`). Con el panel cerrado está sobre la cabecera del lector (que reserva su ancho con `padding-left`); con el panel abierto queda **en el mismo píxel**, ahora sobre la cabecera del panel (que también reserva su ancho). El usuario ve que nada se mueve: el panel se desliza por debajo del grupo, y el mismo botón que lo abrió lo cierra. La ✕ del panel desaparece en escritorio (≥ 1024); en los modos cajón (< 1024) se mantiene la ✕ dentro del cajón porque ahí el panel tapa y hay *scrim*. La cabecera del lector, con el panel abierto, queda limpia: título centrado en la columna y acciones a la derecha. El grupo entra en cromo en calma y en el inmersivo como el resto de la cabecera. | Apple Books Mac, Readwise Reader, Notas/Mail/Finder de macOS: el botón de barra lateral no se mueve | A | M |
| F2 | P4 | **«Aa» en la cabecera, fuera del panel.** Botón «Aa» (icono nuevo `type`, un significado: apariencia del texto) en el grupo derecho, que abre un **popover anclado** en escritorio y una **hoja inferior** en móvil con lo que hoy es `#tab-settings` (tema, papel, letra, tamaño, modo Páginas/Doble/Scroll, brillo). No empuja ni repagina mientras está abierto: ves el cambio sobre la página real. Sale el sliders de la cabecera del panel y «Ajustes de lectura» de «Más». El panel queda solo para navegar el libro (Contenido · Buscar · Marcadores · Subrayados). | Apple Books, Kindle, Kobo, Play Books: «Aa» → popover/hoja | A | M |
| F3 | P5 | **Cabecera móvil a dieta.** A < 768: `‹` · título · `Aa` · `⋯`. Pasan a «Más»: Índice y notas, Buscar, Marcar página (con su estado «Página marcada»), Pantalla completa, Ajustes generales. El índice también se abre **tocando el capítulo del pie** (que hoy ya dice dónde estás). El agente sigue en su FAB. Con 4 piezas el título gana ~200 px y deja de pelear con nadie. | Apple Books iPhone (un único menú), Play Books (tocar el capítulo abre el índice) | A | M |
| F4 | P1 (agente) | **El mismo carril, a la derecha, para el agente** (opcional, después de validar F1). El ✦ queda fijo en la esquina superior derecha; con el agente abierto se queda en el mismo sitio, sobre la cabecera del agente, y sustituye a su ✕. «⋯» pasa a ser el último icono de la cabecera del lector. Así ambos paneles se abren y cierran desde el borde por el que entran. | Simetría de las apps de sistema con inspector a la derecha (Pages, Keynote) | M | M |
| F5 | P3 | **Cabecera del panel con contenido.** Tras Q3 y F1, debajo del carril: miniatura de portada (32 px), título, autor y progreso («37 % · 2 h 10 min»). Es el contexto del índice y sustituye lo que hoy ocupa la marca. | Kindle (cabecera del índice), Apple Books | B | S–M |

**Orden sugerido.** Q1 (es un bug en todos los móviles) → Q2 + Q3 + Q4 (un solo PR, cambian
etiquetas y tests) → F1 (la queja) → F2 → F3 → Q5 en cuanto se toque `initSidebar` → F4/F5 si
F1 convence.

---

## 3. Esquemas de la cabecera propuesta

Leyenda: `‹ Biblioteca` volver · `▯` mostrar/ocultar índice · `Aa` apariencia · `⌕` buscar ·
`[M]` marcar página · `✦` agente · `⋯` más · `⤢` pantalla completa ·
`│` borde de panel. Todo a 52 px de alto.

**Escritorio, paneles cerrados (1440)**

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ‹ Biblioteca  ▯              Designing Data-Intensive Appl…          Aa ⌕ [M] ⤢ ✦ ⋯ │
└──────────────────────────────────────────────────────────────────────────────────────┘
  ^ carril fijo (x = 12)        título centrado en la columna         acciones
```

**Escritorio, índice abierto** — el carril no se mueve; el panel entra por debajo.

```
┌──────────────────────────┬───────────────────────────────────────────────────────────┐
│ ‹ Biblioteca  ▯(acento)  │            Designing Data-Intensive Appl…  Aa ⌕ [M] ⤢ ✦ ⋯ │
├──────────────────────────┤                                                           │
│ [▭] Designing Data-Int…  │                                                           │
│     Martin Kleppmann·37 %│                     (página)                              │
│ Contenido Buscar Marc. S.│                                                           │
│ · Cubierta            1  │                                                           │
```
(sin «BookReader», sin sliders, sin ✕: el ▯ en acento es el cierre)

**Escritorio, agente abierto** (con F4; sin F4, el ✦ sigue en la cabecera del lector y el agente
conserva su ✕)

```
┌───────────────────────────────────────────────────────┬──────────────────────────────┐
│ ‹ Biblioteca  ▯        Designing Data-Int…  Aa ⌕ [M] ⋯│ Elegir objetivo   ⚙   ✦(acento)│
└───────────────────────────────────────────────────────┴──────────────────────────────┘
```

**Escritorio, índice y agente abiertos (1100)** — el título se oculta si no le quedan ~120 px.

```
┌──────────────────────────┬────────────────────────┬──────────────────────────────────┐
│ ‹ Biblioteca  ▯(acento)  │   Pedro Páramo  Aa ⌕ ⋯ │ Elegir objetivo      ⚙  ✦(acento)│
└──────────────────────────┴────────────────────────┴──────────────────────────────────┘
          (en columnas estrechas, [M] y ⤢ pasan a «Más» antes de que el título choque)
```

**Móvil (390, táctil), barras visibles**

```
┌──────────────────────────────────────────┐
│ ‹      Designing Data-Intensi…    Aa  ⋯  │   44 px cada botón
└──────────────────────────────────────────┘
                 (página)
┌──────────────────────────────────────────┐
│ ‹   Capítulo 3 · Storage and Retr… ▾   › │   tocar el capítulo → índice
│ ━━━━━━━━━━──────────────────────  37 %   │
└──────────────────────────────────────────┘                                   (✦ FAB)

«⋯» → Índice y notas · Buscar · Marcar página · Pantalla completa · ── · Ajustes generales
```

**Móvil, índice abierto (cajón)**

```
┌───────────────────────────────┬──────────┐
│ Designing Data-Intensi…    ✕  │ (scrim)  │
│ Martin Kleppmann · 37 %       │          │
│ Contenido Buscar Marc. Subr.  │          │
```

**Inmersivo / cromo en calma** — sin cambios de concepto: escritorio en ventana desvanece por
opacidad cabecera, carril y pie; en pantalla completa se ocultan y reaparecen al llevar el ratón
al borde; en móvil arranca inmersivo y un toque en el centro las trae.

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                      │
│                                   (solo papel)                                       │
```

---

## 4. Riesgos y lo que no cambiaría

**Riesgos**

- **Capas del carril fijo (F1).** Tiene que quedar por encima del panel pero por debajo de
  *scrim*, popovers, diálogos y tooltips (`--z-panel + 1` < `--z-popover`). Revisar que el
  `backdrop-filter` de la cabecera no cree un contexto que lo atrape, y que en pantalla completa
  se oculte con el `translateY(-100%)` de la cabecera (hoy la regla es solo para `.reader-header`).
- **Ancho del panel redimensionable.** `--sidebar-width` lo cambia el usuario (288–560 px,
  `app.js:398`). El carril está anclado a la izquierda, así que no le afecta, pero la reserva de
  la cabecera del panel debe salir del ancho real del carril, no de un número.
- **Tests y ganchos.** `bookreader.spec.ts` busca los botones por «Abrir sidebar»/«Cerrar
  sidebar»; `panel.js:200` escucha el clic de `#sidebar-toggle`; varios tests usan
  `#library-btn`. Mantener los `id` y migrar los nombres con Q4 y Q5 en el mismo cambio.
- **F2 mueve un panel entero.** `#tab-settings` tiene lógica de formato (`data-format`,
  `updateFormatScopedUI`) y vive en el DOM del panel. Moverlo a un popover/hoja debe conservar
  esa lógica y la carga de fuentes. Hacerlo después de F1, no a la vez.
- **Descubribilidad en móvil (F3).** Sacar Buscar y Marcar de la cabecera los aleja un toque.
  Medir antes y después (uso de búsqueda y marcadores) y, si cae, devolver uno de los dos.
- **i18n.** Etiquetas nuevas («Índice y notas», «Pantalla completa», «Biblioteca» como texto del
  botón) en ES/EN; `i18n-audit.spec.ts` lo pedirá.

**Lo que no cambiaría**

- El **título centrado en la columna de lectura** (no en la ventana).
- Que en escritorio los paneles **empujen** y en móvil se **superpongan**: es lo que protege el
  texto y lo que hace posible leer con el agente al lado.
- **Cromo en calma** y el arranque **inmersivo en móvil**.
- Las tres cabeceras a la **misma altura** y la franja continua.
- El **teñido de acento** como estado de los toggles (nada de barras laterales).
- El menú **«Más»** como segunda vía a Biblioteca y Ajustes generales, y el **pie del panel** con
  Ajustes generales.
- El marcador en la cabecera en escritorio (Apple Books y Kindle lo tienen ahí).
