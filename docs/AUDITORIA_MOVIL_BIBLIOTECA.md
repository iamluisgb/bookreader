# Auditoría — navegación móvil de la biblioteca

> **Estado (2026-10-02, tarde):** implementados Q1–Q7 y F1 (ver CHANGELOG). Pendientes: Q8
> («Primeros pasos» descartable), F2 (barra inferior, solo con datos), F4 (Atrás del sistema cierra
> la hoja) y «Organizar» (reordenar) en la hoja de estanterías.

Fecha: 2026-10-02. Alcance: la biblioteca en móvil (< 768 px) y el camino a Ajustes generales,
Análisis, Mazos y «Nueva estantería», también desde un libro abierto. No incluye el lector por
dentro ni los paneles del agente.

**Método.** Playwright contra la app local (`localhost:8888`), con una biblioteca sembrada de 25
libros y 8 estanterías: nombres largos, rama «Técnico» con «Técnico/LLM» y «Técnico/Sistemas
distribuidos», y una inteligente («Sin empezar»). Capturas a 390×844 y 360×740 (táctil) y a
1300×820 para comparar, además de las medidas de cada control con `getBoundingClientRect`. Las
cifras de abajo salen de ahí.

---

## 1. Diagnóstico

### Lo que funciona

- **Escritorio está bien resuelto.** El rail tiene árbol plegable, secciones *Estanterías* /
  *Automáticas*, contadores tabulares y Ajustes anclado abajo y separado. La arquitectura es
  correcta. El problema es cómo se pliega a móvil.
- **Ajustes, Análisis y Mazos se abren como _bottom sheets_** a casi pantalla completa, con
  cierre de 44 px. Una vez abiertos se usan bien.
- **«Continuar leyendo»** es la primera acción real y tiene un botón claro.
- **El botón Atrás funciona desde un libro**: abrir un libro hace `pushState` (`app.js:692`) y
  Atrás vuelve a la biblioteca.
- **Menús ⋯ bien acotados al viewport** (`positionMenu`), con filas de unos 44 px y «Eliminar» en
  rojo y al final.
- **Los chips del filtro bajo el título** («Técnico ✕ · Quitar filtro») dicen qué estás viendo y
  permiten deshacerlo en táctil.

### Los 5 problemas de más impacto

**P1 · Ajustes, Análisis, Mazos y Nueva estantería están al final de una tira de 2 200 px.**
En móvil el rail entero se convierte en una fila horizontal (`main-late.css:801-841`), y las cuatro
acciones van después de todas las estanterías (`view.js:234-237`). Con 8 estanterías la tira mide
**2 201 px** (5,6 pantallas a 390 px). «Nueva estantería» empieza en x = 1 858 y «Ajustes generales»
en x = **2 002**. Nada en la pantalla inicial indica que existan. Tres de ellas son además
**solo icono** (`.lib-rail-create span { display:none }`): un «+», unas barras y un icono de
tarjetas, en verde, sin etiqueta y con 40×30 px de área. Que «es muy difícil llegar a Ajustes» no
es una impresión: es literal. La única pista es una línea de texto en «Primeros pasos» («…en
Ajustes»), que no enlaza a nada.

**P2 · No se ve qué estantería está seleccionada, y la tira la pierde de vista al elegirla.**
Hay dos fallos que se suman:
- `modern.css:170` pinta la fila activa con `var(--fill)` y `modern.css:355` pinta **todas** las
  píldoras móviles con el mismo `var(--fill)`. Activa e inactiva son idénticas. En la captura,
  «Libros 25» (activa) y «Sin estantería 3» se ven igual.
- Cada selección rehace el HTML (`host.innerHTML = …` en `render()`) y la tira vuelve a
  `scrollLeft = 0`. Si tocas «Técnico», que está a dos pantallas, la tira salta al principio y el
  chip que acabas de tocar queda fuera de vista. Solo el H1 («Técnico») dice dónde estás.

**P3 · La tira no indica que se desliza hacia ambos lados, y cada chip tiene dos objetivos.**
- El fundido de `modern.css:350-353` solo va a la **derecha**. Al desplazarla, los chips se cortan
  a la izquierda sin pista («…ratura contemporánea»). Es lo que se ve en la captura del usuario.
- El **⋯ va dentro de la píldora** (26×26 px, a 4 px del borde). Visualmente es un solo chip con dos
  zonas de toque contiguas: el nombre filtra y el ⋯ abre un menú. Es fácil tocar uno queriendo el
  otro, y en una píldora de 30 px de alto el ⋯ queda muy por debajo de 44 px.
- En la tira se mezclan cuatro tipos de cosa sin distinguirlos: vistas del sistema (Libros, Sin
  estantería), estanterías manuales, inteligentes (en móvil pierden el icono ✦ porque se oculta
  `.lib-rail-thumb`, así que «Sin empezar» parece manual) y acciones (+, Análisis, Mazos, Ajustes).
- La jerarquía se aplana a «Técnico/LLM» y las ramas plegadas se despliegan siempre
  (`.is-folded { display:flex }`). Con 20 estanterías la tira solo puede crecer.
- El menú ⋯ de una estantería ofrece **«Subir» / «Bajar»**, que en una fila horizontal significan
  izquierda y derecha.
- Cruzar estanterías (Y/O) en táctil solo es posible con ⋯ → «Añadir al filtro». Funciona, pero
  nadie lo descubre.

**P4 · Objetivos táctiles por debajo de 44 px (`DESIGN.md` §3 lo exige).**

| Control (390 px) | Medida | Objetivo |
|---|---|---|
| Chip de estantería | 85×**30** | ≥ 44 de alto (área de toque) |
| ⋯ de estantería | **26×26** | 44×44 |
| ⋯ de libro (sobre la portada) | **30×30** | 44×44 |
| Desplegables Recientes / Progreso | 132×**32** | 44 |
| Buscador | 358×**32** | 44 |
| Subir archivos (solo icono) | 42×34 | 44, y con nombre accesible |
| Botones de la cabecera del lector | **36×36** | 44 |

**P5 · Desde un libro, Ajustes generales está escondido en el cajón del índice.**
Con un libro abierto, la cabecera tiene logo · panel · título · pantalla completa · buscar ·
marcador. Ajustes generales solo está en el **pie del cajón del índice** (`index.html:210`), detrás
del icono de «panel», que nadie asocia con «configuración». Además:
- «Volver a la biblioteca» es el **logotipo** (`#library-btn`), sin chevron ni texto: parece marca,
  no navegación.
- En móvil la lectura arranca en inmersivo (`app.js:1416`), así que hace falta un toque en el
  centro para ver siquiera esa cabecera.

**De paso (afecta a la navegación, no es el foco):** a 390 px, «Primeros pasos» y «Continuar
leyendo» ocupan los primeros ~600 px, y la rejilla empieza en y = 624 de 844. «Primeros pasos»
sigue ahí con 25 libros porque falta el paso del objetivo, y no se puede descartar. Lo que se ve al
abrir es la tira, el título, una tarjeta de onboarding y el héroe. Ni una sola salida a Ajustes.

---

## 2. Recomendaciones priorizadas

Impacto: A alto · M medio · B bajo. Esfuerzo: S (≤ ½ día) · M (1-3 días) · L (> 3 días).

### Quick wins

| # | Problema | Propuesta (qué ve y hace el usuario) | Imp. | Esf. |
|---|---|---|---|---|
| Q1 | P1 | **Cabecera de biblioteca con un botón «Más» (⋯ o avatar) a la derecha del título**, 44 px. Abre una *bottom sheet* «Más» con, en este orden: **Ajustes generales**, **Análisis**, **Mazos**, separador, **Nueva estantería**, **Guía rápida**. Las cuatro acciones **salen de la tira** en móvil. Es el patrón de Kindle («More») y de Google Play Books (avatar → ajustes). Reutiliza el componente de sheet que ya usan Ajustes y Análisis. | A | S-M |
| Q2 | P2 | **Estado seleccionado inequívoco.** Chip activo en **tinta**: fondo `--text`, texto `--surface-0` y contador atenuado. Es el mismo lenguaje que el botón principal («Seguir leyendo»), y no es una barra lateral. Después de cada `render()`, **centrar el chip activo** (`scrollIntoView({inline:'center', block:'nearest'})`), o bien conservar el `scrollLeft` previo y centrarlo solo si queda fuera. | A | S |
| Q3 | P3 | **Fundido a ambos lados según la posición**: clases `has-left` / `has-right` actualizadas en `scroll` y aplicadas con `mask-image`. Sin fundido a la izquierda cuando `scrollLeft = 0`, y sin fundido a la derecha al llegar al final. | M | S |
| Q4 | P3, P4 | **Sacar el ⋯ del chip en móvil.** En la tira, el chip solo filtra. Opciones de la estantería por **pulsación larga** sobre el chip y, de forma visible, con un ⋯ junto al título cuando la estantería está seleccionada («Técnico ⋯»). Es lo que hace Apple Books en una colección abierta: el menú está en la cabecera, no en la pestaña. | A | S-M |
| Q5 | P4 | **Áreas de toque de 44 px**: chips de 36 px visibles con 44 px de área (padding vertical o `::after` invisible), ⋯ de libro de 44 px, desplegables y buscador a 44 px y botones de la cabecera del lector a 44 px en `pointer: coarse`. | M | S |
| Q6 | P3 | En móvil, **ocultar «Subir/Bajar»** del menú de estantería (o renombrarlos «Mover a la izquierda/derecha»). El orden se gestiona mejor en la sheet de F1. | B | S |
| Q7 | P5 | **«Ajustes generales» también en la cabecera del lector**: un ⋯ «Más» a la derecha (44 px) con *Ajustes de lectura*, *Ajustes generales* y *Volver a la biblioteca*. El pie del cajón puede quedarse como segunda vía. Y al logotipo de volver, un **chevron «‹»** delante: logo + ‹ se lee como «atrás», como el «‹ Biblioteca» de Apple Books. | A | S |
| Q8 | De paso | «Primeros pasos» **descartable** (✕) y plegado a una línea cuando ya hay libros. Así recupera ~270 px y la rejilla sube. | M | S |

### Cambios de fondo

**F1 · Selector de estanterías en _bottom sheet_ (M · impacto A).** La tira deja de intentar
contener toda la biblioteca:

- **La tira** queda corta y estable: `Libros` · `Sin estantería` · hasta 4-5 estanterías
  **fijadas o más usadas** · un último chip **«Estanterías ▾»**. Lo que hace Google Play Books
  con su fila de filtros y Libby con «Tags».
- **La sheet «Estanterías»** es el rail de escritorio en vertical:
  - árbol con triángulos y guía, secciones *Estanterías* / *Automáticas* (con su ✦) y contadores;
  - filas de 48 px con ⋯ propio de 44 px;
  - **casillas para cruzar** (selección múltiple de verdad en táctil) con el conmutador
    *en todas / en alguna* arriba;
  - pie fijo con **«+ Nueva estantería»** y «Organizar» (reordenar y fijar a la tira).

  Es el patrón de «Colecciones» de Apple Books y de la hoja de filtros de Kindle.
- Así se resuelven la jerarquía aplanada, los nombres largos, las inteligentes sin marca, Y/O sin
  modificador y «Subir/Bajar» de una vez, sin inventar nada: es el mismo modelo de datos
  (`Shelves.shelfRows`) con otra presentación.

**F2 · ¿Barra inferior? Todavía no, con un criterio para decidirlo (decisión · impacto M).**
Los destinos reales son Biblioteca (principal), Repaso de hoy (bucle diario), Análisis (ocasional),
Mazos (gestión, ocasional) y Ajustes (raro). Una *tab bar* de 3-4 pestañas (Biblioteca · Repaso ·
Análisis · Más), como Kindle o Apple Books, solo se justifica si hay **dos o más destinos de uso
diario**. Hoy solo lo es la biblioteca, y el repaso ya tiene su tarjeta «Repaso de hoy» arriba.
Recomendación: **Q1 ahora**. Barra inferior **solo si** las métricas (`usage-log`) muestran que
Repaso se abre a diario por separado de la tarjeta. Si llega, va en la biblioteca y **nunca** en el
lector, que sigue a pantalla completa (`DESIGN.md` §1 y §6.3).

**F3 · Una sola arquitectura en los dos tamaños (S-M · impacto M).** Mismo inventario, mismo orden y
mismos nombres:
- **Escritorio**: rail = vistas + estanterías + «Nueva estantería», y abajo un bloque «Análisis ·
  Mazos · Ajustes generales», como hoy.
- **Móvil**: tira (vistas + fijadas + «Estanterías ▾») y cabecera con «Más» (Análisis · Mazos ·
  Ajustes).
- Lo que cambia es el contenedor, no la taxonomía. Conviene que la lista de acciones de «Más» salga
  de **una sola definición** en `view.js` para que no se desincronicen.

**F4 · Accesibilidad y sistema (S · impacto M).**
- Tira con `role="toolbar"` (o lista) y chips con `aria-pressed`. `aria-current` ya está.
- El ⋯ que queda con nombre accesible propio.
- La sheet «Más» / «Estanterías» atrapa el foco, se cierra con Esc y con deslizar hacia abajo.
- **Atrás del sistema cierra la sheet abierta** (empujar un estado al abrirla). Hoy las sheets no
  empujan estado de historial (`app-settings.js` solo escucha Esc), así que en Android Atrás no
  cierra la hoja: actúa sobre la vista que hay debajo.
- «Subir archivos» solo icono necesita `aria-label` y, mejor, el texto «Subir» en ≥ 360 px.

### Orden sugerido

1. Q2 + Q3 + Q5 (un PR de CSS/JS pequeño: la tira deja de engañar).
2. Q1 + Q7 (la queja del usuario: Ajustes a un toque desde biblioteca y desde lector).
3. Q4 + Q6 + Q8.
4. F1 y F4.
5. F2, solo con datos.

---

## 3. Esquema propuesto

### Biblioteca móvil (390 px)

```
┌──────────────────────────────────────┐
│ Libros                     🔍    ⋯   │  ← cabecera: título (o estantería) · buscar · Más (44 px)
├──────────────────────────────────────┤
│ [■Libros 25] [Sin estant. 3] [Técni… │  ← tira corta; chip activo en tinta
│  …co 12] [Club 3] [Estanterías ▾]    │     fundido solo donde hay más
├──────────────────────────────────────┤
│ ┌──────────────────────────────────┐ │
│ │ ▓▓  CONTINUAR LEYENDO            │ │
│ │ ▓▓  Designing Data-Intensive…    │ │
│ │ ▓▓  [ Seguir leyendo › ]         │ │
│ └──────────────────────────────────┘ │
│ ┌──────────────────────────────────┐ │
│ │ ◔ Repaso de hoy · 12 tarjetas    │ │
│ └──────────────────────────────────┘ │
│ [Recientes ▾] [Progreso ▾]  [⤒ Subir]│
│ ┌──────┐ ┌──────┐                    │
│ │      │ │      │                    │
└──────────────────────────────────────┘
```

Con una estantería seleccionada, el título lleva su menú:

```
│ Técnico ⋯                  🔍    ⋯   │   ⋯ junto al título = opciones de «Técnico»
│ [Libros 25] [■Técnico 12] [LLM 6] …  │   chip activo centrado en la tira
```

### Sheet «Más» (desde ⋯ de la cabecera)

```
┌──────────────────────────────────────┐
│               ───                    │
│  ⚙  Ajustes generales              › │
│  ▥  Análisis                       › │
│  ▤  Mazos                          › │
│  ─────────────────────────────────── │
│  +  Nueva estantería               › │
│  ?  Guía rápida                      │
└──────────────────────────────────────┘
```

### Sheet «Estanterías» (desde «Estanterías ▾»)

```
┌──────────────────────────────────────┐
│               ───                    │
│ Estanterías        Cruzar: [en todas]│
│ ☐ Libros                         25  │
│ ☐ Sin estantería                  3  │
│ ESTANTERÍAS                          │
│ ☐ L  Literatura contemporánea  6   ⋯ │
│ ☐ T  Técnico ▾                12   ⋯ │
│ │ ☐ L  LLM                     6   ⋯ │
│ │ ☐ S  Sistemas distribuidos   4   ⋯ │
│ ☐ E  Ensayo y divulgación…     5   ⋯ │
│ AUTOMÁTICAS                          │
│ ☐ ✦  Sin empezar              10   ⋯ │
├──────────────────────────────────────┤
│ [+ Nueva estantería]     [Organizar] │
└──────────────────────────────────────┘
```

### Camino a Ajustes: hoy y propuesto

```
HOY (biblioteca)  deslizar la tira ~5 pantallas → «Ajustes generales»   (no se ve que existe)
HOY (lector)      toque centro → icono «panel» → pie del cajón → «Ajustes generales»

PROPUESTO (biblioteca)  ⋯ → Ajustes generales                          (2 toques, visible)
PROPUESTO (lector)      toque centro → ⋯ → Ajustes generales           (3 toques, visible)
```

---

## 4. Riesgos y lo que no cambiaría

**Riesgos**
- **Esconder estanterías detrás de «Estanterías ▾»** puede costar un toque a quien usa muchas a
  diario. Se mitiga fijando las más usadas en la tira y conservando la última elegida. Medir el uso
  de la sheet antes de recortar más.
- **Un ⋯ en la cabecera y otro junto al título** pueden confundirse. Usar iconos distintos: Más =
  avatar o engranaje con punto, opciones de estantería = ⋯. O fundir las opciones de la estantería
  dentro de «Más» cuando hay una seleccionada.
- **Pulsación larga** no es descubrible por sí sola. Por eso Q4 la acompaña de un ⋯ visible y no la
  usa como única vía.
- **Barra inferior prematura**: le quita 56-80 px a una pantalla que ya pierde 600 px en tarjetas, y
  compromete una IA de producto difícil de deshacer.
- **Arrastrar libros a estanterías** no existe en táctil. «Añadir a estantería» desde el ⋯ del
  libro debe seguir siendo la vía principal en móvil (hoy ya lo es).

**Lo que no cambiaría**
- El **rail de escritorio**: árbol, secciones, iniciales con tono y Ajustes anclado abajo.
- Las **bottom sheets** de Ajustes, Análisis y Mazos, y la sheet de opciones de libro, salvo los
  objetivos táctiles.
- El modelo de **estantería = etiqueta** con cruce Y/O y los chips de filtro bajo el título.
- **«Continuar leyendo»** como primer bloque y el lector a pantalla completa sin barra inferior.
- La regla de diseño: **ningún estado con barra de acento lateral**. El activo se marca con fondo
  en tinta y peso, y la fila seleccionada de la sheet con su casilla.
