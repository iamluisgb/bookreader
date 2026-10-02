# Auditoría UX/UI de las libretas

> 2026-10-02. Solo recomendaciones: no hay cambios de código. Se ha mirado la interfaz real con
> Playwright (EPUB `tests/test.epub`, licencia Pro simulada, `chat/completions` stubbeado), en
> escritorio 1300×820 y en móvil 390×844, con cinco plantillas (T1, HQ&A, T3, T5 y T6), en claro y
> en oscuro. Las capturas se citan como `[desk-03]`, `[mob-06]`, etc. Código de referencia:
> `app/js/ai/panel.js` (render y eventos), `app/js/ai/notebook.js` (lógica), `app/js/ai/templates.js`
> y `app/css/modern.css` § «Libreta que guía».

---

## 1. Diagnóstico

### Lo que funciona (no tocar la idea)

- **«Te toca» es el acierto de NB2.** Enseña una sola pregunta, en su momento, con la pregunta en
  grande, el contexto («Has terminado «CAPÍTULO 2»») y dos salidas claras: Guardar / Ahora no
  `[desk-01, desk-02]`. Es lo que Readwise Daily Review hace bien (una cosa por pantalla) y lo que casi
  ninguna app de notas hace.
- **La frontera IA / tú** (`fill: 'agent' | 'user'`) se ve: lo tuyo en tarjeta con chip «tú», lo de la
  IA en lista gris con chip «IA» `[desk-03]`. Está respaldada por el efecto de generación
  (`docs/INVESTIGACION_APRENDIZAJE.md` §1).
- **«Primero tú» en T3**: la tesis del agente queda bloqueada hasta que escribes la tuya `[desk-09]`.
- **Campo vacío = una línea** con el cuándo («al terminar el libro», «en cada capítulo»). La libreta
  vacía ya no parece un formulario `[desk-01]`.
- **HQ&A → mazo** sin pasos extra, y «Montarlo con mis notas» en T1 `[desk-03]`: la libreta produce algo.
- **Cumple DESIGN.md §1.6**: no hay barras de acento laterales. «Te toca» usa elevación, las notas
  propias usan superficie y borde suave, el estado «sin responder» usa un fondo tenue. El modo oscuro
  aguanta bien `[desk-13]`.

### Los 5 problemas de más impacto

**P1. La libreta está desconectada del texto del libro.** Es el problema principal. Una app de lectura
gana o pierde en el camino que va del subrayado a la nota.

- La barra de selección (`index.html` `#highlight-tooltip`) tiene Preguntar, Explícame, Por qué importa,
  Tarjeta, colores, Nota, Copiar y Compartir, pero **no tiene «A la libreta»**. La «Nota» de esa barra
  se guarda en el subrayado (panel Subrayados), que es **otro sistema de notas** distinto de la libreta.
- Solo HQ&A conecta el subrayado con la libreta, y lo hace de forma **implícita**: `onReaderSelection`
  (`panel.js:710`) escucha `rendition.on('selected')` y **cualquier selección de ≥ 8 caracteres** lanza
  una llamada al LLM y crea una nota, aunque el usuario solo quisiera copiar. No pasa nada en PDF (solo
  escucha la `rendition` de EPUB). Además, en táctil la selección la gestiona `touch-select` con su propio
  callback (`highlights-ui.js:67`), así que **hay que comprobar en un dispositivo si HQ&A llega a
  dispararse en móvil**. Si no, la plantilla de pago no hace en el móvil lo que promete.
- Ir al pasaje cuesta. En las plantillas por capítulo, el chip de capítulo, que es el enlace al pasaje,
  se oculta dentro de su grupo (`noteHtml(…, { showChapter: chapter == null })`), y «Ir al pasaje» queda
  a dos toques dentro del menú ⋯ `[desk-06]`. Las notas de «Te toca» y las escritas a mano no guardan
  ningún CFI, así que no tienen pasaje.
- Las citas `[[aN]]` **desaparecen sin aviso** hasta que el libro está segmentado: `citeReplace`
  (`render.js:44-47`) borra el ancla no mapeada. En `[desk-02]`, «procesar dos veces = una» sale sin
  chip, y el mismo texto aparece con chip «pág. 1» segundos después `[desk-04]`. Cuando aparece, la nota
  muestra **dos ubicaciones que compiten**: el chip verde «pág. 1» de la cita y el chip gris
  «CAPÍTULO 2» del capítulo.

**P2. La libreta promete cosas que no hace sola.**

- Los campos INFO vacíos dicen «**lo apunta el agente**» `[desk-01, desk-10, desk-11]`, pero el agente
  solo apunta si chateas y el extractor decide guardar (`extractToNotebook`, `panel.js:2237`). Si no
  chateas, «Conceptos del autor» o «Qué construye el capítulo» se quedan vacíos para siempre. En T6, la
  sección del capítulo actual pinta **cinco líneas vacías**, tres de ellas «lo apunta el agente», y esa
  sección es la «Cubierta» marcada como «Ahora» `[desk-10, mob-10]`.
- **HQ&A vacía no explica cómo empezar** `[desk-08]`: muestra una sola línea, «Preguntas y respuestas
  +». Al tocarla se abre un textarea libre cuyo placeholder dice «Subraya un pasaje: el agente propone la
  pregunta…», es decir, te invita a escribir mientras te dice que la vía es subrayar. Lo que escribas ahí
  no tiene formato P/R, así que no entra en el mazo (`parseQA` devuelve `q` vacío).
- Si el extractor automático falla, el chat deja un «✕ No se pudo guardar en la libreta» gris **sin
  reintento**: en modo auto no hay botón `[desk-12]`.

**P3. Jerarquía y densidad: mucho cromo por poca nota.**

- Cada nota de la IA ocupa unos 65 px aunque tenga una sola línea, porque la fila meta (chip + ⋯) va
  debajo en su propia línea (`.ai-nb-note-meta`, `modern.css:906`) `[desk-03, desk-10]`. Las tarjetas
  propias dejan un hueco en blanco con un ⋯ huérfano en la esquina `[desk-02]`.
- Antes de la primera nota se apilan cuatro capas: objetivo, nombre de plantilla, «Te toca» y
  entregable. En móvil, «Te toca» ocupa casi toda la primera pantalla `[mob-01]`. Está bien cuando hay
  pregunta pendiente, pero el bloque Objetivo + plantilla se repite en cada visita y ya figura en el
  selector de conversación.
- **Marcado crudo**: la respuesta vacía de HQ&A se ve como `R: _(escribe tu respuesta)_`, con los
  guiones bajos a la vista `[desk-06, mob-06]`.
- En las plantillas por capítulo, la cabecera de capítulo solo da el total de notas («CAPÍTULO 1 · 2»).
  No dice **cuántas están sin responder**, que es justo lo que hay que hacer. Hay que abrir cada grupo
  para descubrirlo `[desk-05]`.

**P4. Libreta, chat y Studio no se hablan.**

- El agente **no ve tus notas**: `systemPrompt` (`panel-template.js:92-169`) recibe la definición de los
  campos, pero no su contenido. No puede decir «como apuntaste en el capítulo 2…» ni darse cuenta de que
  ya respondiste algo. La única puerta es «Revisar con el agente», nota a nota.
- El repaso de capítulo de HQ&A (`quizChapter`, `panel.js:1808`) pregunta **en el chat**, y tu respuesta
  se queda en el chat: no llega a la libreta ni al mazo. El método HQ&A queda partido en dos sitios.
- Studio genera resumen, mapa y tarjetas **desde el libro, no desde tus notas** (`studio.js` no lee
  `notes`). El único artefacto hecho desde la libreta es el entregable de T1.
- Exportar está escondido en el menú del selector de conversación («Exportar a Markdown…»,
  `panel.js:891`), siempre incluye el chat y no se puede copiar al portapapeles. BACKLOG P8 v2 ya lo
  apunta.

**P5. Robustez y accesibilidad.**

- **Pérdida de borradores**: `renderNotebook` reescribe `innerHTML` entero (`panel.js:2510`). El texto a
  medio escribir en «Te toca» o en un editor se pierde si llega un repintado asíncrono: termina el
  extractor automático (`:2280`), termina HQ&A (`:740`), cambia el capítulo (`:1798`) o
  `refreshFinished` detecta que el libro está terminado (`:2342`).
- **Foco**: al abrir el ⋯, el botón que tenía el foco se destruye y se vuelve a crear. El menú lleva
  `role="menu"`, pero no responde a flechas ni a Escape, y no devuelve el foco al cerrarse.
- **Objetivos táctiles**: el ⋯ mide 26 px y el `+` del campo 28 px (DESIGN.md §3 pide ≥ 44 px en
  móvil). En escritorio, el ⋯ queda a 0,55 de opacidad.
- **Descubribilidad**: el panel abre en Chat, y la primera pista apunta a Studio («flashcards para
  Anki») `[mob-00]`. El punto de no leído de la pestaña Libreta solo aparece al cambiar de capítulo o
  cuando se apunta algo. Nada avisa de la pregunta inicial pendiente de T1, que es la que fija el
  entregable.

---

## 2. Recomendaciones priorizadas

Impacto: Alto / Medio / Bajo. Esfuerzo: S (≤ 1 día), M (unos días), L (semanas).

### Quick wins (esfuerzo S)

| # | Problema | Propuesta (qué ve y hace el usuario) | Imp. | Esf. |
|---|---|---|---|---|
| Q1 | P3 densidad | **Fila meta en línea.** En las notas de la IA, chip y ⋯ a la derecha de la misma línea del texto, sin fila propia. En las notas propias, la fila meta solo aparece si hay chip o «Responder». Unos 40 % menos de alto por nota. | Alto | S |
| Q2 | P1 pasaje | **Un único chip de ubicación, siempre a un toque.** Si la nota tiene CFI o cita, se muestra «↗ pág. 12» (o «↗ cap. 2» sin página), también dentro de los grupos por capítulo. El chip gris de capítulo sobra cuando ya estás en su grupo. Al tocarlo, el lector salta y el pasaje parpadea, como en Kindle con «Ir a la ubicación». | Alto | S |
| Q3 | P1 citas | **No borrar citas pendientes.** Mientras no haya anclas, `[[aN]]` se pinta como un chip neutro desactivado («…»), y `repaintCites` lo activa después. Solo se elimina si el libro ya está segmentado y el ancla no existe. | Medio | S |
| Q4 | P3 | **Placeholder real para la respuesta vacía**: «R: Tu respuesta…» como botón tenue que abre el editor, en lugar del Markdown `_(escribe tu respuesta)_`. | Medio | S |
| Q5 | P3 | **Pendientes en la cabecera de capítulo**: «Capítulo 1 · 3 notas · 1 por responder». La parte «por responder» se marca con texto y color (sin barra). Los capítulos sin texto (cubierta, créditos) no se marcan como «Ahora» ni muestran líneas vacías. | Alto | S |
| Q6 | P2 | **Campos del agente honestos.** Se cambia «lo apunta el agente» por una acción: «Pedir al agente», que con un toque lanza la extracción de ese campo para el capítulo actual con las citas del libro. Sin clave o sin libro listo, el campo vacío se oculta hasta que exista. | Alto | S |
| Q7 | P2 | **Estado vacío de HQ&A que enseña el gesto**: tres pasos ilustrados en una tarjeta («Selecciona una frase → el agente te pregunta → respondes con tus palabras → va a tu mazo») y un botón «Probar con este capítulo» que propone 3 frases candidatas del capítulo actual. | Alto | S |
| Q8 | P2 | **Reintentar** cuando falla el extractor automático (el mismo botón «A la libreta» en estado de error). | Bajo | S |
| Q9 | P5 | **Borradores a salvo**: antes de repintar se guarda el valor de cualquier textarea abierto (por campo, capítulo o id) y se restaura, o se aplaza el repintado mientras un textarea de la libreta tenga el foco. | Alto | S |
| Q10 | P5 | **Accesibilidad del menú**: ⋯ y `+` de 44 px de área táctil (el icono puede seguir siendo pequeño), `aria-haspopup="menu"`, flechas y Escape, y foco de vuelta al ⋯ al cerrar. | Medio | S |
| Q11 | P5 | **Aviso en la pestaña**: «Libreta · 1» cuando hay «Te toca» pendiente, también el de inicio. Es un contador con texto, no solo el punto. | Medio | S |

### Cambios de fondo (M / L)

| # | Problema | Propuesta | Referencia | Imp. | Esf. |
|---|---|---|---|---|---|
| F1 | P1 | **«A la libreta» en la barra de selección.** Al tocarlo aparecen chips con los campos de la plantilla, primero los tuyos. Se guarda la cita literal con su CFI y se abre el editor debajo para tu comentario. En HQ&A, el botón se llama «Hazme la pregunta» y **sustituye al disparo automático**: ninguna selección crea notas sin pedirlo, y funciona igual en táctil y en PDF. | LiquidText y MarginNote (el *excerpt* arrastrado mantiene el vínculo con el texto); Kindle (nota sobre el subrayado). | Alto | M |
| F2 | P4 | **El agente lee tu libreta.** Se inyecta en el prompt un resumen acotado de tus notas de cognición (las últimas N, o las del capítulo relevante, con presupuesto de tokens). El agente puede apoyarse en ellas, señalar contradicciones y no preguntar lo ya respondido. | NotebookLM: las notas pueden convertirse en fuentes. | Alto | M |
| F3 | P4 | **El repaso de capítulo termina en la libreta.** Bajo la respuesta del usuario a «🔔 Repaso» aparece «Guardar como P/R», que la convierte en nota HQ&A del capítulo y en tarjeta del mazo. | Readwise: *highlight → question* en el repaso. | Medio | S–M |
| F4 | P4 | **Salida desde la propia libreta.** Un icono en la cabecera de la pestaña abre «Copiar / Markdown / Obsidian», con opción de incluir o no el chat. El formato Obsidian lleva *frontmatter*, `[[título del libro]]` y citas con página. Cierra P8 v2 y adelanta F7 del BACKLOG. | Readwise (exporta a Obsidian y Notion); Kindle (cuaderno por correo). | Medio | M |
| F5 | P4 | **Studio desde mis notas.** Al generar un resumen o un mapa mental: «A partir de: el libro · mi libreta». El entregable se generaliza a todas las plantillas: T3 da un ensayo crítico de una página, T4 una carta al yo de dentro de un mes, T6 el README del proyecto y T5 una reseña. | NotebookLM Studio (artefactos sobre tus fuentes). | Medio | M |
| F6 | P1 | **Marginalia en el lector**: una marca discreta en el margen junto a los párrafos con nota. Al tocarla, la nota se abre en un popover y desde ahí se puede editar. La libreta deja de ser algo que solo se ve en otra pestaña. | Kindle (icono de nota en línea); LiquidText (enlaces bidireccionales). | Alto | L |
| F7 | — | **Búsqueda y vista global**: un buscador en la libreta y una vista «todas mis libretas» filtrable por plantilla o campo (es la base de F5–F6 del BACKLOG, la matriz de literatura). | Readwise; Obsidian. | Medio | L |
| F8 | — | **Ritual de cierre** al terminar el libro: una pantalla que reúne tus notas, las preguntas que quedaron pendientes («Ahora no»), el entregable y la pregunta «¿Lograste tu objetivo?» (SRL, `INVESTIGACION_APRENDIZAJE.md` §3.7). | — | Medio | M |

### Top 5 (orden recomendado)

1. **F1 · «A la libreta» en la selección y HQ&A explícito.** Resuelve el problema principal y corrige un
   efecto secundario (notas que nadie pidió) y un posible fallo en móvil y PDF.
2. **Q1 + Q2 + Q4 + Q5 · el paquete de legibilidad.** Notas más compactas, pasaje a un toque, sin
   marcado crudo y pendientes visibles. Es esfuerzo S y se nota en cada visita.
3. **Q6 + Q7 · estados vacíos honestos.** «Pedir al agente» en lugar de una promesa, y una HQ&A vacía
   que enseña el gesto.
4. **F2 · el agente lee tu libreta.** Une chat y libreta, y vuelve más útil «Revisar con el agente».
5. **Q9 + Q10 · borradores a salvo y accesibilidad del menú.** Perder lo que alguien ha escrito es el
   peor fallo posible en una herramienta de escritura.

---

## 3. La libreta ideal

```
┌ Chat │ Libreta · 1 │ Studio ──────────────── ⤓ ┐   ← contador = pendientes; ⤓ = copiar/exportar
│ ◎ Kafka pierde eventos · Extracción        ▾   │   ← objetivo en una línea (se despliega)
│                                                │
│ ╭ Te toca · Has terminado «Cap. 2» ─────────╮  │
│ │ ¿Qué de este capítulo te sirve?           │  │
│ │ [ tu respuesta…                         ] │  │
│ │ Guardar   Ahora no        ↗ releer cap. 2 │  │
│ ╰───────────────────────────────────────────╯  │
│                                                │
│ Qué me sirve                         tú    +   │
│ ┌────────────────────────────────────────────┐ │
│ │ acks=1 pierde eventos si cae el líder…     │ │
│ │                      ↗ pág. 34   ⋯         │ │   ← un solo chip de ubicación
│ └────────────────────────────────────────────┘ │
│ Conceptos del autor                  IA        │
│  Idempotencia del consumidor   ↗ p. 12   ⋯     │   ← una línea por nota de la IA
│  Outbox transaccional          ↗ p. 40   ⋯     │
│  Ver 2 más                                     │
│ Plan de acción · al terminar el libro      +   │
│                                                │
│ [ Montarlo con mis notas ]                     │
└────────────────────────────────────────────────┘
En el lector: «▍» discreto en el margen = aquí hay nota.
Selección → [Preguntar] [A la libreta ▾] [Tarjeta] …
```

Principios: una pregunta a la vez; lo tuyo pesa más que lo de la IA; todo vuelve al texto con un toque;
lo que escribes alimenta al agente, al Studio y al mazo.

---

## 4. Riesgos y lo que no cambiaría

**No cambiaría:**

- **«Te toca» con una sola pregunta.** Ni dos ni una lista de pendientes en la cabecera. El contador de
  la pestaña informa, pero no reemplaza a la pregunta única.
- **La IA no escribe en tus campos.** Ninguna de las propuestas (F2, F5, Q6) rompe la frontera
  `fill: 'user'`. «Pedir al agente» solo actúa sobre campos INFO.
- **El menú ⋯** en lugar de iconos fijos: hay que agrandar el área táctil, no volver a la fila de iconos.
- **Las notas propias sin barra lateral de color**: se mantienen superficie, peso y chip «tú». La marca
  de margen de F6 está en el lector y señala que hay una nota, no un estado de la libreta.
- **Plegar la lista de la IA a partir de 3** y los capítulos plegables con el actual abierto.

**Riesgos:**

- **F1 quita el HQ&A automático.** Habrá menos notas generadas, pero cada una será intencionada. Conviene
  medir respuestas escritas por semana y no notas creadas.
- **F2 cuesta tokens e incluye contenido privado en el prompt.** Hay que ponerle un presupuesto fijo
  (p. ej. 1,5 k tokens) y un interruptor en Ajustes del agente.
- **Carga cognitiva**: sumar prequestions, cierre SRL, repaso y «Te toca» puede volver a convertir la
  libreta en deberes (`INVESTIGACION_APRENDIZAJE.md` §5). Como mucho, un ritual nuevo por plantilla.
- **F6 (marginalia)** toca el render del lector EPUB y PDF. Es el cambio más caro: conviene validarlo
  antes con F1 + Q2, que ya resuelven buena parte de la relación con el texto.
- **DESIGN.md desfasado**: el documento sigue diciendo que el acento es índigo `#5B6CFF`, pero
  `themes.css` usa esmeralda (`#178046` en claro y `#32d074` en oscuro). Hay que actualizar DESIGN.md
  antes de diseñar sobre estas recomendaciones.
