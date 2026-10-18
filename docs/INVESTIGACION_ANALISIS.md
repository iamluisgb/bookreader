# Análisis: lectura y estudio en una sola pantalla

> **Estado:** implementado el 18-oct-2026 como P44 (BACKLOG). Diferencias con esta propuesta: el
> «cuadro de estudio» del cierre de sesión se retiró en vez de moverse (Análisis pinta repasos por día,
> sin color por retención del día); `study_log` se queda como contador del día de este dispositivo
> (lo necesita la meta al instante) y todo lo analizado sale de `attempts`.

Investigación del 18-oct-2026. Pregunta: cómo mejorar la sección de Análisis
([`analysis.js`](../app/js/analysis.js), P25) y cómo meter en ella el estudio de flashcards, a
partir de lo que hacen los líderes y de lo que dice la investigación. Respeta las decisiones de
P25 y P31 (una sola cifra de tiempo, la validada; nada de comparativas ni de paneles de filtros) y
se alinea con P42 F3 («Practicado»), que ya pedía una sección de estudio aquí.

## Resumen ejecutivo

- **Hoy Análisis solo cuenta lectura.** El estudio aparece solo como una baldosa de «Racha». Sus
  datos están dispersos en el cierre de sesión (heatmap de 5 semanas, previsión de 7 días, «% a la
  primera» de esa sesión) y en el dominio por libro de la biblioteca.
- **El dato ya existe.** El store `attempts` (P42 F1, desde el 15-oct) es un *revlog* completo,
  con un registro por nota: tarjeta, libro, hora, nota, intervalo previo, latencia, modo (girar o
  escribir) y veredicto del agente. Es lo mismo que usa Anki para todas sus estadísticas FSRS.
  Además, cada tarjeta guarda su estabilidad y su dificultad (`card.srs`). No hay que medir nada
  nuevo para la primera fase.
- **El estándar de la industria es la *retención real*, no el «% a la primera».** Anki la trae de
  serie desde la 24.11. Es la proporción de repasos *vencidos* que se recordaron, separada en
  tarjetas jóvenes y maduras, y se compara con la retención objetivo (90 % en nuestro FSRS). «Lo
  que quieres frente a lo que obtienes» [1][2].
- **La segunda cifra que se ha impuesto es el *conocimiento estimado*.** Es la suma de la
  probabilidad de recordar cada tarjeta hoy (Anki 24.11, «Estimated total knowledge») [3]. Por
  libro responde a la pregunta que nadie más puede responder: *¿qué me queda de este libro?*
- **Los cuadros de mando que funcionan describen respecto a uno mismo y empujan a una acción.**
  Compararse con otros sube la ansiedad en quien estudia para no quedar mal [4]. Mostrar datos sin
  una acción al lado no cambia la conducta [5].
- **El alumno se sobreestima, y la app puede medirlo.** Los juicios de aprendizaje se inflan
  cuando la respuesta está a la vista [6]. Tenemos las dos señales: la nota que se pone el lector
  y el veredicto del agente cuando escribe. La distancia entre ambas es una métrica de
  calibración que ningún competidor enseña.
- **Propuesta:** una pantalla que responde cuatro preguntas (¿cuánto leí?, ¿cuánto y cómo
  estudié?, ¿qué me queda de cada libro? y ¿qué se me viene?) en cuatro fases. La F1 es pequeña y
  funciona con los datos de hoy. El optimizador FSRS personal (F4) espera a que haya historia.

## Qué hay hoy

| Dónde | Qué enseña | Problema |
| --- | --- | --- |
| Análisis | Tiempo validado, páginas, palabras, subrayados, notas, racha; columnas por día; por libro | Nada de estudio salvo la racha, que va entre baldosas de lectura |
| Cierre de sesión | % a la primera, tiempo, racha, heatmap de 5 semanas, previsión de 7 días | Solo se ve al terminar un repaso; el % es de esa sesión (rendimiento, no aprendizaje) |
| Biblioteca | «Repaso de hoy», racha, dominio por libro (`deckMastery`) | El dominio pondera por intervalo, no por probabilidad de recuerdo; no conecta con la lectura |
| `study_log` | n/ok/c por día, 120 días | Duplica lo que ya está en `attempts`, con menos detalle |

## Qué hacen los líderes

**Anki (24.11+), la referencia en SRS** [1][3]:
- *True retention*: tabla por periodos (hoy, ayer, semana, mes, año), separada en jóvenes
  (intervalo < 21 d) y maduras. Cuenta solo el primer repaso vencido de cada tarjeta en el día.
- *Estimated total knowledge*: Σ retrievabilidad. Una cifra en «tarjetas que sabes hoy».
- *Future due* y *daily load*: carga de los próximos días y carga media que añade cada tarjeta
  (≈ Σ 1/intervalo). Es la señal para frenar las tarjetas nuevas antes de que el repaso se coma el
  día.
- Distribuciones de dificultad, estabilidad y retrievabilidad: para usuarios avanzados.
- Errores habituales que señalan sus guías [2]: juzgar la retención por un solo día, pulsar
  «Difícil» para proteger la cifra, y añadir nuevas sin mirar la carga.

**FSRS y su optimizador** [7][8]: los parámetros por defecto ya ganan a SM-2, pero se ajustan a
cada persona a partir de su revlog, y eso reduce repasos para la misma retención. Desde Anki
24.06 no exige un mínimo de repasos: decide solo si optimizar del todo, a medias o nada. Se
recomienda reoptimizar más o menos una vez al mes. Hay binding en WASM para el navegador
(`@open-spaced-repetition/binding`), así que puede correr en el dispositivo, sin servidor.
RemNote ya lo ofrece como un botón [9].

**Apps de lectura (Kindle Reading Insights, Readwise)**: rachas, libros terminados, minutos. Son
métricas de volumen que no distinguen leer de rastrear (P25 ya lo hace mejor) y que no conectan lo
leído con lo retenido. Ese hueco es el sitio de BookReader: es la única app que tiene a la vez el
tiempo validado por libro y la memoria por libro.

## Qué dice la investigación

- **Descriptivo y referido a uno mismo.** En un ensayo con cuadros de mando predictivos y
  descriptivos [4], ambos bajaron la ansiedad frente al grupo de control. Quien tenía
  orientación de evitación del rendimiento mostró más ansiedad con cualquiera de los dos. Por eso
  no hay comparación con otros, ni ranking, ni percentiles. Coincide con P31.
- **De la monitorización a la acción.** Winne [5]: la analítica para la autorregulación sirve
  cuando ayuda a *decidir qué hacer después*. Cada bloque de la pantalla tiene que acabar en un
  botón («Repasar este libro», «Arreglar 3 tarjetas», «Pausar nuevas»).
- **Ilusión de competencia.** Los juicios de aprendizaje se inflan cuando se estudia con la
  respuesta delante. Se corrigen con práctica de recuperación y feedback [6]. Girar la tarjeta y
  ponerse «Bien» es justo ese caso. Lo que distingue a BookReader es que *también* tiene intentos
  escritos juzgados.
- **Rendimiento ≠ aprendizaje** (Bjork, dificultades deseables [10]): un repaso duro con un 75 %
  puede enseñar más que uno cómodo con un 98 %. El «% a la primera» de la sesión no debe venderse
  como progreso. La retención real sobre material *vencido* sí mide memoria a largo plazo.

## Propuesta

Una pantalla con el rango como único interruptor (Día, Semana, Mes; P31 añade Año y Todo cuando
duela). Cuatro preguntas, en este orden:

### 1. ¿Cuánto he leído? (ya existe, se poda)
El héroe de tiempo, las columnas por día y el desglose por libro siguen igual. Se quitan dos
baldosas: «Palabras», que repite a «Páginas» en otra unidad, y «Racha», que pasa al bloque de
estudio.

### 2. ¿Cuánto he estudiado y cómo?
Un bloque hermano del de lectura, con su propia cifra de tiempo:
- **Tiempo de repaso**: Σ `latencyMs`, con un tope de 60 s por tarjeta (el mismo criterio que
  Anki). Así una tarjeta abierta mientras se hace otra cosa no infla el total, el mismo principio
  honesto que la lectura.
- **Repasos** y **días con repaso** (n de N), con la racha al lado.
- **Retención real** frente al objetivo del 90 %, en jóvenes y maduras. Se calcula así: primera
  nota del día de cada tarjeta con `prevInterval ≥ 1`, y acierto = cualquier nota que no sea
  «otra vez». **Solo con N suficiente** (≥ 30 repasos en el rango). Por debajo, la pantalla dice
  cuántos faltan en vez de pintar ruido (mismo criterio que P42 F3). Lectura en una línea: *por
  debajo del 85 %, las tarjetas son demasiadas o están mal formuladas; por encima del 95 %,
  repasas más de lo necesario*.
- **Practicado frente a mirado** (P42 F3): repasos con intento escrito y veredicto, aparte de los
  de solo girar. No se suman.

### 3. ¿Qué me queda de cada libro?
La fila de «Por libro» une lectura y memoria, porque esa es la pregunta que solo BookReader puede
responder:
- Tiempo leído en el rango (ya está) + **recuerdo estimado hoy** = Σ R / tarjetas no nuevas, con
  la fórmula de `retrievability()` que ya está en `srs.js`. Funciona desde hoy, porque sale del
  estado de las tarjetas y no del historial.
- Señal de **tarjetas problemáticas** (leeches y tarjetas con retención baja) con la acción
  «Revisar», que lleva al flujo de P42 («Reformúlala tú»).
- Tocar la fila aplica el escope de P31 punto 3: la pantalla entera se filtra a ese libro, con el
  botón «Repasar este libro».
- Sustituye a `deckMastery`, que pondera por intervalo y no por probabilidad de recordar. La
  biblioteca pasaría a usar la misma cifra, para que haya un solo concepto de «dominio».

### 4. ¿Qué se me viene?
- Previsión de 7 días (la del cierre de sesión, que sube aquí) + **carga diaria** media.
- Si la carga supera el tiempo que el lector suele dedicar, se avisa con una sola acción: «Bajar
  las nuevas de hoy» (avisar, nunca bloquear).

### Fases

| Fase | Qué | Tamaño | Datos |
| --- | --- | --- | --- |
| **F1** | Bloque «Estudio» (tiempo, repasos, días, racha, retención real con su valla de N, practicado/mirado). Poda de baldosas de lectura. | `S` | `attempts` (desde el 15-oct) |
| **F2** | «Por libro» con recuerdo estimado, problemáticas y escope por libro. Mismo dominio en la biblioteca. | `S`–`M` | `card.srs` (desde hoy) |
| **F3** | Previsión + carga diaria + aviso de nuevas. Fuera la previsión duplicada del cierre de sesión. | `S` | `card.srs` |
| **F4** | **Optimizador FSRS personal**, en el dispositivo (binding WASM), detrás de un botón. Se ofrece cuando hay ≥ ~400 repasos o un mes de historia. Enseña el resultado en lenguaje llano: «con tus parámetros, X repasos menos al mes para la misma retención». De paso, FSRS-5 → FSRS-6. | `M` | `attempts` con historia |
| **F5** | **Calibración**: acierto según tu nota frente a acierto según el agente, en las tarjetas con intento escrito. «Te pones Bien en el 92 %; el agente te da por buena el 71 %.» Solo con N suficiente. | `S` | P42 F1/F2 |

F1–F3 no necesitan red, ni clave, ni datos nuevos. F4 y F5 dependen de que se acumule historia: no
hay que forzarlas antes.

### Arreglos que salen de paso
- `study_log` (120 días, n/ok/c) pasa a derivarse de `attempts`. Mantener dos fuentes acabará
  dando dos cifras.
- En el cierre de sesión, «% a la primera» se queda (es feedback inmediato útil), pero el heatmap
  y la previsión se van a Análisis. Así el cierre es más corto y Análisis se convierte en *el*
  sitio para mirar el estudio.

## Qué no hacer

- Comparativas con otros usuarios, rankings, XP o ligas [4].
- Histogramas de dificultad y estabilidad: son herramientas de quien ajusta Anki, no preguntas de
  un lector.
- Mostrar la retrievabilidad media (Anki la tiene) junto a la retención real: casi siempre es
  mayor, halaga, y el usuario se quedaría con la grande. Es el mismo argumento que P25 usó para no
  enseñar el «tiempo con el libro abierto».
- Retención de un solo día o de pocos repasos: es ruido [2].
- Ajuste de la retención objetivo por el usuario en esta épica. Con el optimizador (F4) se puede
  ofrecer, con su coste en carga a la vista, pero no antes.

## Incertidumbre

- **N pequeño.** Con un solo lector y 3 días de `attempts`, la retención real tardará unas
  semanas en ser fiable. Por eso las vallas de N son parte del diseño, no un detalle.
- **Las tarjetas son de un LLM.** Una retención baja en un libro puede deberse a tarjetas mal
  formuladas y no a mala memoria. La pantalla debe sugerir revisar las tarjetas antes que
  «estudiar más».
- **El optimizador en WASM no está probado aquí.** Queda por medir el tamaño del binding y el
  tiempo en un Pixel antes de comprometer la F4.

### Sources
1. Expertium, *Understanding retention in FSRS* — https://expertium.github.io/Retention.html
2. Synapse, *Anki True Retention & FSRS: Rates, Targets and Workload* — https://www.synapse-pro.de/blog/anki-retention-statistics.html
3. Anki Manual, *Card Info, Graphs and Statistics* — https://docs.ankiweb.net/manual/stats
4. Valle et al. (2021), *Predict or describe? How learning analytics dashboard design influences motivation and statistics anxiety* — https://pmc.ncbi.nlm.nih.gov/articles/PMC8153529/
5. Winne, *Learning Analytics for Self-Regulated Learning* (Handbook of LA, cap. 21) — https://www.solaresearch.org/wp-content/uploads/2017/05/chapter21.pdf
6. Koriat & Bjork (2006), *Illusions of competence during study can be remedied…* — https://pubmed.ncbi.nlm.nih.gov/17128596/
7. open-spaced-repetition, *fsrs4anki tutorial* — https://github.com/open-spaced-repetition/fsrs4anki/blob/main/docs/tutorial.md
8. open-spaced-repetition, *ts-fsrs* (scheduler y binding del optimizador) — https://github.com/open-spaced-repetition/ts-fsrs
9. RemNote Help, *The FSRS Spaced Repetition Algorithm* — https://help.remnote.com/en/articles/9124137-the-fsrs-spaced-repetition-algorithm
10. Bjork & Bjork (2011), *Making things hard on yourself, but in a good way* — https://bjorklab.psych.ucla.edu/wp-content/uploads/sites/13/2016/04/EBjork_RBjork_2011.pdf
