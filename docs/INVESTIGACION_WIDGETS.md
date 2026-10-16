# Qué widgets de estudio debe tener BookReader

Investigación del 16-oct-2026. Pregunta: qué 5–8 **tipos genéricos** de widget interactivo,
rellenables por un LLM con un JSON a partir de cualquier libro y corregibles sin juez cuando sea
posible, ayudan más a aprender a un lector adulto. Parte de los cuatro prototipos sobre DDIA
(anomalías, lease, rebalanceo, timeout) y de la sección «Aprendizaje basado en evidencia» del
BACKLOG (Bastani, Kestin, ICAP, VanLehn), que no se repite aquí.

## Resumen ejecutivo

- **Los líderes convergen en un catálogo pequeño de widgets declarativos.** Khan Academy (Perseus)
  define cada ejercicio como JSON y lo corrige con código determinista: opción múltiple, número,
  expresión, huecos, ordenar, clasificar, emparejar, gráfico interactivo [1]. La respuesta libre es
  la única que no corrige [2]. Google Learn Your Way, lo más parecido a BookReader, genera desde un
  PDF quizzes por sección, preguntas incrustadas y huecos, y en su ensayo con 60 alumnos retuvo un
  78 % frente a 67 % del lector de PDF [3].
- **Lo que más mueve el aprendizaje es comprometerse antes de ver.** Predecir antes de una
  demostración sube las explicaciones correctas del 22 % al 30 %; solo mirar no mejora nada
  (24 %) [4]. Intentar antes de la explicación da g = 0.36 en comprensión y transferencia, y g = 0.56
  si la explicación posterior parte de lo que produjo el alumno [5].
- **Recuperar sin feedback casi no sirve cuando se falla mucho.** Con acierto ≤ 50 % y sin
  feedback, el efecto test desaparece (g = 0.03) [6]. El feedback que explica el porqué rinde
  mucho más que el que dice «bien/mal» [7][8].
- **Construir supera a recibir.** Rellenar una matriz de conceptos × atributos tiene la mediana más
  alta de las estrategias generativas (d = 1.07) [9]; construir un mapa conceptual (g = 0.72) supera
  a estudiar uno hecho (g = 0.43) [10]; enseñar a otro, d = 0.77 [11].
- **El tutor por chat no basta.** En el ensayo independiente de Khanmigo, los alumnos solo
  escribieron al tutor en el 17 % de las sesiones con error, y el efecto fue igual al de Khan sin
  IA [12]. El widget tiene que pedir el trabajo, no esperar a que el lector lo pida.
- **Lo generado por LLM hay que verificarlo.** Un estudio de quizzes médicos generados con ChatGPT
  encontró un 22 % de errores factuales [13]. Lo fiable es lo que se comprueba por código (fórmula,
  orden, clave) y lo que lleva la cita literal del pasaje.

## Qué hacen los líderes

**Khan Academy** es la referencia de arquitectura. Su motor Perseus tiene unos veinte widgets
(`radio`, `numeric-input`, `expression`, `orderer`, `sorter`, `categorizer`, `matcher`,
`interactive-graph`, `label-image`, `table`…), cada uno con su función de corrección [1]. Las
expresiones se corrigen por equivalencia simbólica con una lista de respuestas aceptadas y
rechazadas que llevan su propio mensaje de error. La respuesta libre devuelve «sin puntuar» y
espera una corrección externa [2]: es exactamente el hueco donde un LLM juez tiene sentido y el
único sitio donde lo necesitaríamos.

**Desmos** aporta un matiz de diseño: el feedback **interpretativo** (mostrar qué significa tu
respuesta, por ejemplo el paracaidista que se mueve según tu gráfica) frente al evaluativo («mal»).
Corrige de forma conservadora y deja un estado de «necesita interpretación humana» [14]. Los
prototipos de DDIA ya hacen lo primero: la línea de tiempo del lease o las claves que se mueven
enseñan la consecuencia de tu respuesta.

**Math Academy** encadena ejemplo resuelto → problemas parecidos → dominio antes de avanzar, y su
repetición espaciada recorre el grafo de temas: repasar un tema avanzado cuenta como repaso de los
simples que contiene [15]. No publica datos de eficacia. **Duolingo** usa pocos formatos (traducir,
huecos, banco de fichas, emparejar) y elige la dificultad con un modelo estadístico [16]. **PhET**
guía sin instrucciones mediante controles limitados («implicit scaffolding») [17].

**Google Learn Your Way** genera, desde un PDF, texto con preguntas incrustadas, quizzes por
sección, diapositivas con huecos y un mapa mental. En su ensayo (N = 60, 15–18 años, aleatorizado
frente a un lector de PDF) la retención a los 3–5 días fue de 78 % frente a 67 % [3]. Es un estudio
de Google y pequeño. Su trabajo posterior sobre «learning interactives» añade retos de fácil a
difícil, pistas por niveles y un agente que comprueba que cada nivel es resoluble, pero solo midió
la valoración de profesores, no el aprendizaje [18].

**NotebookLM, ChatGPT Study Mode, el modo de aprendizaje de Claude y LearnLM** se quedan en
flashcards, opción múltiple y diálogo socrático. No publican evidencia de aprendizaje; LearnLM
mide la preferencia de expertos (+31 % frente a GPT-4o) [19]. **Anki** es la referencia para
corregir respuesta tecleada: compara lo escrito con la respuesta y marca qué partes coinciden [20].
Gloss, Readwise y Rember no tienen ejercicios interactivos más allá de pregunta-respuesta.

Conclusión de esta parte: **nadie hace todavía widgets interactivos generados desde un libro
cualquiera con corrección fiable**. Google es quien más se acerca, y solo en textos escolares.

## Qué dice la investigación

**Práctica de recuperación.** Hacer preguntas supera a releer: g = 0.50 en laboratorio [6] y
g = 0.50 en aula, con 48.478 alumnos [21]. Frente a otras estrategias elaborativas la ventaja es
pequeña (g = 0.095) [21]. Dos condiciones mandan: que haya feedback (g = 0.73 con feedback frente a
0.39 sin él) y que el acierto no caiga por debajo del 50 % sin feedback (g = 0.03) [6]. La
transferencia a preguntas nuevas existe (d = 0.40), pero necesita práctica elaborada y acierto en la
práctica [22]: preguntas de aplicación, no literales.

**Formato.** En laboratorio, recordar rinde más que reconocer (0.61 frente a 0.29) [6]; en aula la
diferencia desaparece y el formato importa menos [21]. La opción múltiple funciona si los
distractores son competitivos: obligan a recuperar también lo que hay detrás de las opciones falsas
[23]. Para opositores, practicar en el formato del examen rinde más [21].

**Feedback.** Decir solo «bien/mal» apenas sirve; dar la respuesta correcta, algo; explicar el
porqué, más [7]. El feedback de alta información llega a d = 0.99 [8]. Pedir la confianza antes de
revelar sirve para lo que más se corrige: los errores cometidos con mucha seguridad
(hipercorrección) [24].

**Predecir e intentar antes.** En demostraciones de física, predecir subió los resultados correctos
del 61 % al 77 % y las explicaciones del 22 % al 30 %, por unos dos minutos de coste; observar sin
predecir no mejoró las explicaciones [4]. Resolver antes de la instrucción da g = 0.36 en
comprensión y transferencia, pero g = −0.03 en conocimiento procedimental, y sube a 0.56 cuando la
explicación posterior se construye sobre lo que el alumno produjo [5]. Las preguntas previas a un
capítulo ayudan a aprender lo preguntado (g ≈ 0.54) y nada lo demás (g = 0.04) [25], y la respuesta
tiene que llegar después [26].

**Ejemplos.** Los ejemplos resueltos ayudan al novato, y la ayuda se invierte con el experto: novato
con mucha asistencia d = 0.51, experto con poca d = −0.43 [27]. Un widget de problemas debe ir
retirando pasos según rinde el lector. Las indicaciones de autoexplicación dan g = 0.55 [28].

**Construir.** Matriz conceptos × atributos, d = 1.07 (mediana de 8 de 8 comparaciones) [9]; mapa
conceptual construido g = 0.72 frente a estudiado 0.43, en STEM y fuera de STEM [10]; mapas
parcialmente rellenos reducen el tedio [9]. Enseñar a otro, d = 0.77, mejor si se explica de memoria
y el interlocutor hace preguntas profundas [11]. Ordenar pasos (problemas de Parsons) enseña lo
mismo que escribir desde cero en menos tiempo, en programación [29] y en demostraciones matemáticas
con N = 332 [30].

**Encontrar el error.** Efecto pequeño (g = 0.14) salvo que el lector explique el error [31]. Mejor
como modo de otros widgets que como tipo propio.

**Simulaciones.** Funcionan, y la guía pesa más que la libertad: la indagación guiada supera a la
libre con d = 0.50 [32]. La exploración sin objetivo es lo que no hay que hacer.

**Intercalado y espaciado.** Intercalar conceptos parecidos ayuda (g = 0.42), pero no con texto
expositivo general ni con palabras (g = −0.39) [33]. Los aprendices prefieren la práctica en bloque
aunque les rinda peor, así que el sistema decide, no la preferencia del usuario [34].

## La selección: siete tipos

Todos comparten la carcasa que ya tienen los prototipos: se cuelgan de una nota o un pasaje, piden
**compromiso antes de revelar**, explican el porqué con cita, registran el intento (P42) y, si
fallas, crean tarjeta (FSRS) que vuelve **con otra variante**. Cada tipo declara qué rellena el LLM
y cómo se corrige.

| # | Tipo | Mecanismo y evidencia | El LLM rellena | Se corrige | Géneros |
|---|---|---|---|---|---|
| 1 | **Predice y comprueba** | Predecir antes [4]; intentar antes [5] | Escenario, controles, desenlaces y **tabla de casos** con explicación y cita; opcional traza por carriles o tiempo | Fila de la tabla; exacto | Técnico, ciencia, economía, derecho («¿qué pasa si…?») |
| 2 | **Rellena la matriz** | Matriz d = 1.07 [9]; intercalar lo parecido [33] | Filas (conceptos), columnas (atributos), celdas con cita; algunas ya rellenas | Celda a celda; exacto | Todos: niveles de aislamiento × anomalías, escuelas × tesis, fármacos × efectos |
| 3 | **Ordena la secuencia** | Parsons [29][30]; línea de tiempo de Learn Your Way [3] | Pasos o hechos en orden, con cita; distractores opcionales | Orden; exacto o parcial | Procesos, algoritmos, historia, procedimientos legales, argumentos |
| 4 | **Problema con números** | Ejemplos que se retiran [27]; transferencia con aplicación [22] | Parámetros, **fórmula en un mini-lenguaje seguro**, unidades, tolerancia, pasos del ejemplo resuelto; modo «reto con restricciones» | Se evalúa la fórmula con números nuevos cada vez | Técnico, ciencia, economía, finanzas |
| 5 | **Pregunta con distractores que enseñan** | Recuperar con feedback [6][7]; distractores competitivos [23]; formato de examen [21] | Enunciado de aplicación, opciones con **feedback por opción**, la respuesta y la cita | Clave; exacto | Opositores, repaso de cualquier libro |
| 6 | **Recuerda con tus palabras** | Recordar > reconocer en laboratorio [6]; confianza antes de revelar [24] | Pregunta y respuesta modelo con 2–4 ideas clave citadas | Comparación local de texto (como el cloze de P42); juez solo si no coincide | Todos |
| 7 | **Explícaselo a alguien** | Enseñar d = 0.77 [11]; autoexplicación g = 0.55 [28] | Rúbrica de ideas clave desde el pasaje y preguntas de seguimiento | **Juez LLM** con la rúbrica y la solución delante: el único tipo con juez | Todos; ya existe como Feynman |

«Encuentra el error» queda como **modo** de 1, 3 y 4 (un paso falso que el lector marca y explica),
por su efecto pequeño cuando va solo [31]. Las preguntas previas al capítulo (P17) son los tipos 5 y
6 en modo «antes de leer», solo sobre lo que el capítulo va a explicar [25].

Los cuatro prototipos de DDIA caen así: anomalías y lease son **tipo 1** (con traza por carriles y
por tiempo), rebalanceo es **tipo 4** en modo estimación con una vista propia, y timeout es **tipo
4** en modo reto con restricciones.

### Reglas comunes que salen de la evidencia

1. **Compromiso antes de revelar**, siempre, y un «por qué» en una frase [4][5].
2. **Feedback que explica**, con la cita del pasaje; nunca solo «bien/mal» [7].
3. **Confianza antes de revelar** en los tipos de recuerdo; los fallos seguros se marcan para repaso
   prioritario [24].
4. **Dificultad en la zona útil:** si el lector falla más de la mitad, bajar un escalón o dar el
   ejemplo resuelto [6][27].
5. **Vuelve con otra variante:** otros números, otra fila de la tabla, otro orden [22].
6. **Intercalar solo lo que se confunde** (las filas de una matriz, los niveles de aislamiento), no
   capítulos al azar [33].
7. **Decide el sistema**, no la preferencia del usuario por repetir en bloque [34].

## Cómo verificar lo que genera el LLM

Cada spec trae la clave de respuesta y la **cita literal** del pasaje. Antes de enseñar un widget:

1. **Esquema y cobertura** en el host: la tabla del tipo 1 cubre todas las combinaciones; cada celda,
   paso u opción tiene cita.
2. **La cita existe en el texto** (búsqueda literal en el capítulo).
3. **Ida y vuelta** para los tipos 1, 2, 5: otro modelo responde solo con el pasaje y se descarta el
   ítem si no sale exactamente una respuesta correcta [35]. No valida si los distractores engañan a
   un humano; para eso, sacarlos de los errores reales del lector (registro de P42).
4. **Ejecución** para el tipo 4: la fórmula se evalúa con valores de prueba y se comprueban unidades
   y rangos.
5. **Juez solo en el tipo 7**, con la rúbrica y la solución delante: un tutor sin solución revela la
   respuesta o se equivoca a menudo [36].

La métrica para el contrato EV5: % de specs que pasan 1–4 en 20 capítulos de tres libros de géneros
distintos, y % que un revisor humano da por correctos frente al texto.

## Qué no hacer

- **Simulaciones de exploración libre** sin objetivo ni predicción [32].
- **Ilustraciones y animaciones decorativas:** lo peor valorado de Learn Your Way fueron las
  ilustraciones [3].
- **Confiar el aprendizaje al chat** con el tutor [12].
- **Opción múltiple generada sin verificar** [13].
- **«¿Por qué?» como widget central:** la interrogación elaborativa tiene utilidad moderada y depende
  de saber ya del tema.
- **Gamificación como motor:** ayuda algo (g = 0.49 en lo cognitivo [37]), pero no sustituye a
  ninguno de los mecanismos de arriba.

## Conclusión

El orden de construcción que recomiendo, por evidencia, alcance por géneros y facilidad de
verificar:

1. **Predice y comprueba (1)**: es el diferencial frente a NotebookLM y compañía, y ya hay dos
   prototipos.
2. **Rellena la matriz (2)**: la evidencia más fuerte, vale para todos los géneros y se corrige
   celda a celda.
3. **Ordena la secuencia (3)**: barato, sirve en humanidades y en procedimientos de oposición.
4. **Problema con números (4)**: para técnicos y ciencia, con la fórmula como garantía.
5. **Pregunta con distractores que enseñan (5)**: para el vertical opositor.

Los tipos 6 y 7 ya existen en parte (cloze con comparador local de P42 y Feynman) y se adaptan a la
carcasa común en lugar de construirse de nuevo.

## Incertidumbre y limitaciones

- La evidencia de producto es floja: Brilliant, Desmos y Math Academy no publican eficacia; la de
  Learn Your Way es de Google y con N = 60; el dato de dosis de Khan es interno y cuasi-experimental.
- La matriz (d = 1.07) sale de pocas comparaciones (8) en la tabla de Fiorella y Mayer; es la
  mediana, no un meta-análisis con corrección de sesgo.
- Hay conflictos: el formato de pregunta importa en laboratorio y no en aula [6][21]; la
  autoexplicación sumada a ejemplos resueltos sube el efecto según unos estudios y lo baja según
  otros; el momento del feedback no tiene veredicto.
- Casi toda la evidencia es con estudiantes jóvenes; la de educación continua es escasa (k = 6 en
  Yang 2021, sin conclusión) [21].
- No se verificó en fuente primaria: el d = 0.62 de simulaciones de SRI 2014, Crissman 2006, Schwartz
  y Bransford 1998.
- La parte de productos se apoya en resúmenes automáticos de las páginas; las cifras clave (Khanmigo,
  Learn Your Way, Perseus) se comprobaron en la fuente.

### Sources

[1] Khan Academy, Perseus, widgets de corrección: https://github.com/Khan/perseus/tree/main/packages/perseus-score/src/widgets
[2] Perseus, corrección de respuesta libre: https://github.com/Khan/perseus/blob/main/packages/perseus-score/src/widgets/free-response/score-free-response.ts
[3] Google Research, Learn Your Way: https://research.google/blog/learn-your-way-reimagining-textbooks-with-generative-ai/
[4] Crouch, Fagen, Callan y Mazur (2004), Classroom demonstrations: learning tools or entertainment?: https://www.otffeo.on.ca/en/wp-content/uploads/sites/2/2014/11/Mazur_demo-article.pdf
[5] Sinha y Kapur (2021), When problem solving followed by instruction works: https://janfasen.nl/wp-content/uploads/2023/05/Sinha-and-Kapur-PS-I.pdf
[6] Rowland (2014), The effect of testing versus restudy on retention: https://doi.org/10.1037/a0037559
[7] Van der Kleij, Feskens y Eggen (2015), Effects of feedback in a computer-based learning environment: https://doi.org/10.3102/0034654314564881
[8] Wisniewski, Zierer y Hattie (2020), The power of feedback revisited: https://doi.org/10.3389/fpsyg.2019.03087
[9] Fiorella y Mayer (2016), Eight ways to promote generative learning: https://doi.org/10.1007/s10648-015-9348-9
[10] Schroeder, Nesbit, Anguiano y Adesope (2018), Studying and constructing concept maps: https://summit.sfu.ca/item/17789
[11] Fiorella, Learning by teaching: https://www.unh.edu/teaching-learning-resource-hub/sites/default/files/media/2023-06/itow-learning-by-teaching-fiorella.pdf
[12] NBER w35620, ensayo aleatorizado de Khanmigo: https://www.nber.org/papers/w35620
[13] Camarata et al., LLM-generated multiple-choice practice quizzes: https://researchdiscovery.drexel.edu/esploro/outputs/journalArticle/LLM-Generated-Multiple-Choice-Practice-Quizzes-for/991022059818004721
[14] Desmos, guía para construir buenas actividades digitales: https://blog.desmos.com/articles/desmos-guide-to-building-great-digital-math-2021/
[15] Skycak, Individualized spaced repetition in hierarchical knowledge structures: https://justinmath.com/individualized-spaced-repetition-in-hierarchical-knowledge-structures/
[16] IEEE Spectrum, Duolingo: https://spectrum.ieee.org/duolingo
[17] Podolefsky, Moore y Perkins, Implicit scaffolding in interactive simulations: https://arxiv.org/abs/1306.6544
[18] Google Research, learning interactives con generative UI: https://research.google/blog/the-future-of-practice-enabling-teachers-to-create-learning-interactives-with-generative-ui/
[19] LearnLM technical report: https://arxiv.org/html/2412.16429v3
[20] Anki, campos de plantilla (type-in): https://docs.ankiweb.net/templates/fields.html
[21] Yang et al. (2021), Testing (quizzing) boosts classroom learning: https://gwern.net/docs/spacedrepetition/2021-yang.pdf
[22] Pan y Rickard (2018), Transfer of test-enhanced learning: https://doi.org/10.1037/bul0000151
[23] Little y Bjork (2015), Optimizing multiple-choice tests as tools for learning: https://doi.org/10.3758/s13421-014-0452-8
[24] Metcalfe (2017), Learning from errors: https://doi.org/10.1146/annurev-psych-010416-044022
[25] St. Hilaire et al. (2023), meta-análisis de pretesting: https://doi.org/10.3758/s13423-023-02353-8
[26] Pan y Carpenter (2023), Prequestioning and pretesting effects: https://doi.org/10.1007/s10648-023-09814-5
[27] Meta-análisis de expertise reversal (Learning and Instruction, 2025): https://www.pedocs.de/frontdoor.php?la=en&source_opus=34113&nr=1&anker=start&zeitschriftentitel=Learning+and+instruction&zeitschriftenjahr=2025&zeitschriftenband=98
[28] Bisra et al. (2018), Inducing self-explanation: https://www.clearinghouse.edu.tum.de/wp-content/uploads/2023/09/CHU-KR-25_ENG_Bisra_2018_Selbsterklaerungen.pdf
[29] Ericson, Margulieux y Rick (2017), Parsons problems vs. fixing and writing code: https://doi.org/10.1145/3141880.3141895
[30] Proof Blocks, ensayo con N = 332: https://arxiv.org/pdf/2211.09609
[31] Meta-análisis de ejemplos erróneos (IPN): https://www.leibniz-ipn.de/en/research/publications/a-framework-for-learning-from-erroneous-examples-and-meta-analysis-of-empirical-research
[32] Lazonder y Harmsen (2016), Meta-analysis of inquiry-based learning: https://doi.org/10.3102/0034654315627366
[33] Brunmair y Richter (2019), Similarity matters: https://doi.org/10.1037/bul0000209
[34] Kornell y Bjork (2008), Learning concepts and categories: https://doi.org/10.1111/j.1467-9280.2008.02127.x
[35] Alberti et al. (2019), Synthetic QA corpora generation with roundtrip consistency: https://aclanthology.org/P19-1620/
[36] Macina et al. (2023), MathDial: https://arxiv.org/abs/2305.14536
[37] Sailer y Homner (2020), The gamification of learning: https://link.springer.com/article/10.1007/s10648-019-09498-w
