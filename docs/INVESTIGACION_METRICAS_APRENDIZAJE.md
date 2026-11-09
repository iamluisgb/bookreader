# Cómo medir aprendizaje real en BookReader (estado del arte, nov. 2026)

Investigación con fuentes primarias para diseñar las métricas de aprendizaje de BookReader sin caer en métricas vanidosas. Parte de lo que ya sabemos (efecto del test, espaciado, pretesting, retención endógena en FSRS, true retention, que el tiempo de lectura no mide aprendizaje) y no lo repite.

Restricción de diseño que condiciona todo: **no hay telemetría ni agregados entre usuarios**. Solo hay métricas on-device por usuario y evals offline sobre backups exportados. Eso descarta casi todo lo que hace la industria (A/B entre usuarios, normas poblacionales, IRT calibrada con miles de personas) y obliga a diseños n=1.

Cada cifra lleva su referencia numerada; las URLs están al final. Lo marcado como "inferencia" es razonamiento propio, no dato de la fuente.

---

## 1. Rendimiento frente a aprendizaje

### 1.1 La distinción

Soderstrom y Bjork revisan décadas de investigación motora y verbal y concluyen que lo que se observa durante la práctica es **rendimiento**, "a menudo un índice poco fiable" de los cambios duraderos que constituyen el aprendizaje. Hay aprendizaje sin cambio visible en el rendimiento y, al revés, mejoras de rendimiento que no producen aprendizaje; algunas manipulaciones tienen efectos **opuestos** sobre uno y otro. Además, la gente interpreta su rendimiento durante la práctica como guía fiable de su aprendizaje a largo plazo, y se equivoca [1].

Consecuencia directa para BookReader: cualquier métrica calculada dentro de la sesión (aciertos en la sesión, tarjetas "aprendidas" hoy, veredictos positivos del agente con ayuda) mide rendimiento. Para medir aprendizaje hace falta **tiempo entre la práctica y la medida, y que la medida se haga sin ayuda**.

### 1.2 Ilusiones de competencia documentadas

| Estudio | Qué pasó | Lección para el diseño |
|---|---|---|
| Kornell y Bjork 2008 [2] | El espaciado mejoró la inducción de categorías, pero los participantes valoraron la práctica masiva como más eficaz, **incluso después de que su propio test les hubiera demostrado lo contrario**. | Enseñar al usuario su propio resultado no basta para corregir la creencia. |
| Deslauriers et al. 2019 [3] | Física universitaria, asignación aleatoria, mismo material: los alumnos en clase activa aprendieron más, pero su sensación de aprendizaje fue menor que la de los alumnos de clase magistral. El esfuerzo cognitivo se interpretó como señal de aprender peor. | Las encuestas de "¿cuánto has aprendido?" premian lo fácil. Una métrica de satisfacción empujaría el producto hacia lo pasivo. |
| Bastani et al. 2025 [37] | Los alumnos del tutor GPT con salvaguardas no rindieron mejor en el examen que el grupo control, pero **percibieron que sí**. | El rendimiento asistido infla la autopercepción. |
| Koriat et al. 2004 (descrito en [6]) | Los juicios de aprendizaje no reflejaron el intervalo de retención (5 min, 1 día, 1 semana) cuando se manipulaba entre sujetos, aunque la gente cree que olvida con el tiempo. | El usuario no anticipa su propio olvido: "lo sé" hoy no predice "lo sabré en un mes". |

### 1.3 Juicios de aprendizaje (JOL) y cuándo pedirlos

Un JOL es la predicción del aprendiz sobre si recordará algo después. El hallazgo más útil para un producto es el **efecto del JOL diferido**: un metaanálisis de 112 tamaños de efecto (4.554 participantes) encontró que pedir el juicio un rato después del estudio, en vez de inmediatamente, aumenta la exactitud relativa (gamma) en casi una desviación típica, g = 0,93 [5][6]. La explicación dominante es que el juicio diferido se apoya en un intento de recuperación real.

Implicación (inferencia): si BookReader pide confianza, debe pedirla **antes de mostrar la respuesta y en una sesión distinta a la del estudio**, nunca justo tras leer el pasaje.

### 1.4 Cómo se mide la calibración metacognitiva

Hay que separar tres cosas [7]:

- **Sesgo** (*bias*): ¿el usuario es sistemáticamente sobre o infraconfiado? Se mide como confianza media − acierto medio.
- **Sensibilidad o resolución**: ¿distingue lo que sabe de lo que no? Es una medida relativa, por ítem.
- **Eficiencia**: sensibilidad dada su tasa de acierto (meta-d'/d'); requiere modelos de detección de señales y muchos ensayos.

Medidas habituales:

| Medida | Cálculo | Problema conocido |
|---|---|---|
| Brier score | media de (confianza − resultado)², con resultado 0/1 | Mezcla calibración y resolución; se descompone (Murphy) en incertidumbre del resultado + calibración − resolución [7]. Con acierto cerca del techo (90 %), la incertidumbre del resultado es baja y el Brier sale bajo aunque la persona no discrimine nada. |
| Curva de calibración | agrupar por nivel de confianza y comparar con la proporción de aciertos de cada grupo | El hallazgo típico es sobreconfianza [7]. Necesita bastantes ensayos por grupo. |
| Gamma de Goodman-Kruskal | asociación ordinal entre confianza y acierto por pares de ítems (Nelson 1984) | Masson y Rotello demostraron que el valor empírico de G se desvía sistemáticamente de su valor real en condiciones realistas y depende del sesgo de respuesta; recomiendan alternativas [8]. Sigue siendo la medida más usada en la literatura de metamemoria, así que el sesgo está en disputa activa. |
| AUROC2 (ROC de tipo 2) | área bajo la curva que enfrenta "confianza alta cuando acierta" contra "confianza alta cuando falla" | No paramétrica y libre de sesgo de confianza, pero también depende del rendimiento de base [7]. Es la recomendación de Fleming y Lau frente a gamma y phi. |

Para BookReader (inferencia): la medida práctica es **AUROC2 sobre los intentos con confianza previa**, más el sesgo medio. Ambas se calculan on-device con decenas de intentos, a diferencia de meta-d'. Hay una fuente de calibración "gratuita": en el modo *escribir la respuesta*, la autocalificación del usuario frente al veredicto del agente es un par confianza/resultado. Solo vale si el veredicto del agente es fiable, lo que se puede comprobar en evals offline.

---

## 2. Cómo mide aprendizaje la investigación

### 2.1 Test diferido y transferencia

El estándar es un **test diferido**, sin ayuda y con ítems no practicados. La transferencia se clasifica por distancia: cercana (mismo concepto con otro formato o formulación) y lejana (aplicar a un problema nuevo).

El metaanálisis de Pan y Rickard (192 tamaños de efecto, 122 experimentos, N = 10.382) halló que practicar con tests produce aprendizaje transferible, d = 0,40 (IC 95 % 0,31–0,50), frente a releer. La transferencia es mayor entre formatos de test, hacia preguntas de aplicación e inferencia, y cuando la recuperación es elaborada. Es más débil hacia material no evaluado visto en el estudio y hacia ítems reordenados. Hay una matización importante: **tras corregir sesgo de publicación, la predicción sin moderadores favorables a menudo indica que no hay transferencia positiva** [13].

Implicación (inferencia): que una tarjeta se recuerde no dice que se entienda la idea. Hace falta un banco de **ítems nuevos** sobre el mismo contenido (paráfrasis, aplicación, inferencia) que nunca entren en la cola de repaso.

### 2.2 Ganancia normalizada (Hake g) y sus críticas

Hake definió g = (post − pre) / (100 − pre) y la usó en 62 cursos (N = 6.542): los cursos tradicionales obtuvieron g ≈ 0,23 y los de participación interactiva g ≈ 0,48 [10].

Críticas:
- Nissen et al., con 4.551 estudiantes de 89 cursos, concluyen que g está **sesgada a favor de poblaciones con pretest alto** y lleva a inferencias distintas que la d de Cohen [11].
- Coletta y Steinert lo discuten: atribuyen ese sesgo a variables omitidas, defienden g y piden controlar la capacidad del alumno (razonamiento científico o SAT) [12]. **El debate sigue abierto.**

Para BookReader (inferencia): g solo tiene sentido con pre y post sobre ítems equivalentes, y con n=1 el ruido domina. Además, el pretest de BookReader no es un pretest neutral: preguntar antes de leer **altera** el aprendizaje (es la intervención de pretesting). El "pre" no sirve como línea base limpia. Si se usa, debe ser con formas paralelas y presentarse como "preguntas que no sabías antes / sabes ahora", no como porcentaje de ganancia.

### 2.3 Modelos de estado de conocimiento: IRT, BKT, PFA, DKT, Elo

| Modelo | Qué hace | ¿Sirve para un solo usuario on-device? |
|---|---|---|
| IRT | estima habilidad del alumno y dificultad del ítem a la vez | La dificultad se calibra con muchos alumnos. Sin agregados entre usuarios no hay calibración externa; solo dificultades relativas dentro del propio usuario (inferencia). |
| BKT (Corbett y Anderson 1994) | probabilidad de que una regla esté dominada, actualizada en cada intento; el tutor da ejercicios hasta el "dominio" [18] | Requiere un mapa de habilidades (qué ítem ejercita qué). En un libro arbitrario no existe; el agente podría proponerlo, pero sin validar. |
| PFA (Pavlik, Cen y Koedinger 2009) | regresión logística sobre éxitos y fallos previos por habilidad | Mismo problema del mapa de habilidades. No abrí la fuente primaria. |
| DKT (Piech et al. 2015) | red recurrente que predice el siguiente acierto; mejoró la predicción en varios conjuntos de datos [19] | Necesita grandes corpus de entrenamiento. Khajah et al. muestran que BKT con extensiones (recencia, variación individual, similitud entre habilidades) iguala a DKT [20]: la profundidad no aportaba representaciones nuevas. |
| Elo | trata cada respuesta como una partida alumno-ítem y actualiza habilidad y dificultad; Pelánek lo defiende como simple, robusto y eficaz para sistemas adaptativos [21] | Es lo más viable en local, pero con un único alumno la "dificultad" del ítem se aprende de una sola persona. |

Conclusión: todos estos modelos **predicen el siguiente acierto**, que es rendimiento. Son útiles para decidir qué preguntar, no para afirmar que se aprendió. FSRS ya cubre el papel de modelo predictivo por tarjeta. El srs-benchmark muestra el techo: con 10.000 colecciones de Anki, FSRS-7 tiene un AUC de unos 0,72 y una media móvil sin parámetros llega a 0,70 [36]. La discriminación por tarjeta es modesta incluso para el mejor modelo clásico.

### 2.4 Medir comprensión lectora (no solo memoria)

| Método | Qué mide | Evidencia y caveat |
|---|---|---|
| Recuerdo libre ("escribe lo que recuerdes del capítulo") | cuántas unidades de idea recupera el lector sin pistas | Es la medida clásica de comprensión de textos. Hay que puntuarla contra una lista de ideas del texto; un agente puede hacerlo, pero su puntuación debe validarse frente a humanos (inferencia). |
| Resumen | selección e integración de ideas | Como técnica de estudio, Dunlosky et al. la clasifican de **baja utilidad**, junto con subrayar y releer [16]. Como medida es válido; como intervención, no se le debe atribuir aprendizaje. |
| Autoexplicación | inferencias causales y conceptuales | Metaanálisis: inducirla con prompts da g = 0,55 (69 tamaños de efecto) [15]. La calidad de la autoexplicación sirve a la vez de medida y de intervención. |
| Generación de preguntas | comprensión del lector | Revisión de 26 estudios: tamaño de efecto mediano de 0,36 con tests estandarizados y de 0,86 con tests diseñados por el experimentador [14]. Esa diferencia ilustra lo que se infla una medida cuando la diseña quien diseña la intervención. |
| ICAP (Chi y Wylie) | modo de implicación: pasivo < activo < constructivo < interactivo; predice más aprendizaje según se sube [17] | Clasifica **conductas visibles**, no resultados. Útil para etiquetar lo que hace el usuario (subrayar = activo; anotar con sus palabras = constructivo; debatir con el tutor = interactivo). Es un proxy de proceso, no una medida de aprendizaje. |

---

## 3. Casos de la industria y Goodhart

La formulación habitual de la ley de Goodhart es de Strathern: "cuando una medida se convierte en objetivo, deja de ser una buena medida", escrita sobre las auditorías universitarias británicas [22].

| Producto | Métrica norte o de progreso | Qué mide en realidad | Evidencia de aprendizaje y problemas |
|---|---|---|---|
| **Duolingo** | DAU: objetivo a medio plazo de 100 millones de DAU en 2028 [26]. La racha es su mecanismo de retención. Al usuario le enseña el Duolingo Score (0–160, alineado con el MCER) [23]. | El propio blog define el Score como "cuánto del material del curso has completado"; sube al completar lecciones [23]. Es **progreso en el curso, no una prueba de dominio**. | Jiang et al. evaluaron a 225 adultos que **terminaron** los cursos iniciales de español o francés: Intermediate Low en lectura y Novice High en comprensión oral, comparable a cuarto semestre universitario; no se midieron otras destrezas [24]. Sin grupo control y solo con quienes terminaron (sesgo de supervivencia; crítica propia). Loewen et al. (9 participantes) hallaron una correlación moderada entre tiempo de uso y ganancia, y problemas de motivación [25]. En 2026 Duolingo añadió una sesión de dominio al final de cada unidad que **impide avanzar** sin dominar y que usa como señal de la calidad de cada unidad [26]: un paso de "progreso" a "medida". |
| **Khan Academy** | Tiempo (30+ min/semana) y, desde 2023, "skills to proficient+" [28] | Habilidades que llegan a "proficient" o "mastered" en su sistema de dominio. | Eligieron la métrica por **validez convergente**: correlaciona con el examen externo MAP Growth, sea cual sea el tiempo de uso [28]. El estudio de MAP Accelerator (181.000 alumnos) vio +0,26 DE con 30+ min/semana frente a <15, pero los autores reconocen confusión que "no explica del todo" la relación [29]. Un estudio en PNAS (2026) estima +0,0047 DE por hora anual y +0,0031 DE por habilidad llevada a proficient [30]: efectos reales y pequeños por unidad. Riesgo de Goodhart: "proficient" es rendimiento dentro de la plataforma; su validez depende de que siga correlacionando con MAP cuando se convierta en objetivo. |
| **Math Academy** | XP; cada XP equivale a "aproximadamente un minuto de esfuerzo concentrado" [31][32] | Esfuerzo calibrado en tiempo, ponderado por resultado ("la cantidad depende de lo bien que lo hagas") [31]. Diagnóstico adaptativo inicial de 30–45 min que sitúa al alumno en su "frontera de conocimiento" [31]. | Es honesto sobre lo que mide (trabajo, no conocimiento) y lo usa como presupuesto diario, no como prueba de aprendizaje. No encontré estudios de eficacia independientes. |
| **Quizlet** | "El 94 % de los estudiantes que usan Learn o Test dicen que Quizlet les ayuda a sacar mejores resultados" (encuesta a 381 usuarios, dic. 2021) [33] | Percepción. | Es justo el tipo de medida que Deslauriers [3] y Bastani [37] muestran que engaña. |
| **Brilliant** | — | — | El único estudio académico que encontré (60 alumnos, Colombia, 2023) tiene un resumen escrito en futuro ("los resultados *pueden* demostrar") y no reporta resultados [34]. |
| **Readwise** | Daily Review | La revisión diaria **reexpone** subrayados (releer, no recuperar). El modo Mastery usa una semivida inicial de 7/14/28 días y reaparece cuando la probabilidad estimada de recuerdo baja del 50 % [35]. | No encontré datos de eficacia. La propia documentación describe el algoritmo como "una caja negra" frente a Anki [35]. |
| **Anki / FSRS** | True retention, carga de repasos | Ajuste del modelo de memoria al historial. | El srs-benchmark evalúa con log loss, RMSE(bins) y AUC. Incluye un algoritmo trampa, **RMSE-BINS-EXPLOIT**, que logra el mejor RMSE(bins) de la tabla (0,0135) con un log loss de 4,6, unas diez veces peor que el resto [36]. Es Goodhart dentro de la propia métrica de evaluación: ninguna métrica de calibración debe ir sola. |

Patrón común (inferencia): las métricas que se enseñan al usuario son de **actividad o progreso** (racha, Score, XP, skills) y las que justifican el aprendizaje vienen de **estudios externos con tests independientes** (MAP, ACTFL). Khan es el único que eligió su métrica interna por correlación con un test externo. BookReader no puede correlacionar con nada externo, así que tiene que construir su propio "test externo" dentro de la app: ítems retenidos, diferidos y nuevos.

---

## 4. Tutores con IA 2023–2026: rendimiento asistido frente a aprendizaje

| Estudio | Diseño | Métrica de aprendizaje | Resultado | Qué se discute |
|---|---|---|---|---|
| **Bastani et al., PNAS 2025** [37] | Ensayo de campo preregistrado, ~1.000 alumnos de secundaria en Turquía, cuatro sesiones de 90 min. Tres brazos: GPT Base (tipo ChatGPT), GPT Tutor (con salvaguardas) y control. | Examen **sin ayuda** tras la práctica, con problemas conceptualmente muy parecidos a los practicados. | Práctica: +48 % (Base) y +127 % (Tutor). Examen: **−17 %** con Base; con Tutor el daño desaparece, pero **no hay efecto positivo**. La IA redujo la brecha entre alumnos durante la práctica y no en el examen. Los alumnos del Tutor creyeron haber rendido mejor. | El examen es inmediato y de transferencia cercana. Es el estudio que mejor separa rendimiento de aprendizaje. |
| **Kestin et al., Sci. Rep. 2025** [38] | Ensayo cruzado, física en Harvard, N = 194: tutor IA en casa frente a clase activa. | Post-test **justo después de cada lección**. | Efecto de 0,63 DE por regresión lineal, 0,73–1,3 DE por regresión cuantílica (los autores alegan efecto techo). Mediana de 49 min con el tutor. Más compromiso y motivación declarados. | Sin test diferido: mide adquisición inmediata, no retención. Los mismos autores sugieren integrar espaciado en estudios futuros [38]. |
| **De Simone et al., Banco Mundial 2025** [39][40] | Ensayo aleatorio en 9 escuelas de Edo (Nigeria): seis semanas, 12 sesiones de 90 min, Copilot (GPT-4) en parejas, con profesor que facilita y prompts que promueven razonar. | Evaluación final en papel (inglés, IA, habilidades digitales) y **exámenes ordinarios de fin de curso**. | ~0,3 DE global y ~0,24 en inglés. Mejores notas en exámenes de temas que el programa no cubría. Más sesiones, más ganancia. | Es un *working paper*, no revisado por pares. La conversión a "1,5 años de escolaridad" depende de supuestos. La intervención incluye profesor y estructura: no aísla a la IA. |
| **LearnLM + Eedi, 2025** [49] | Ensayo exploratorio, N = 165, cinco escuelas del Reino Unido. LearnLM redacta y un tutor humano experto supervisa cada mensaje. | Probabilidad de resolver problemas **nuevos en temas posteriores**. | 66,2 % frente a 60,7 % con tutores humanos solos (+5,5 pp). Los tutores aprobaron el 76,4 % de los mensajes con cero o mínimos cambios. | Exploratorio y con supervisión humana; los propios autores son el equipo del modelo. La métrica de transferencia es de las mejores del campo. |
| **Lehmann, Cornelius y Sting 2025** [44] | Dos experimentos de laboratorio preregistrados e incentivados, más un estudio de campo. | Comprensión por tema. | Sin efecto global. Quien **sustituye** (pide soluciones) cubre más temas y entiende peor cada uno; quien **complementa** (pide explicaciones) entiende mejor. La IA amplió la brecha por conocimiento previo. | El análisis por tipo de uso es exploratorio. |
| **Fan et al., BJET 2024** [43] | Experimento aleatorio, 117 universitarios, tarea de escritura con ChatGPT, experto humano, herramientas analíticas o nada. | Nota del ensayo, ganancia de conocimiento, transferencia. | Con ChatGPT mejoró más la nota del ensayo, pero **no** la ganancia de conocimiento ni la transferencia. Proponen la "pereza metacognitiva". | Muestra pequeña por brazo. |
| **Kosmyna et al. (MIT), "Your Brain on ChatGPT" 2025** [41] | 54 participantes en tres sesiones y 18 en la cuarta; grupos LLM, buscador y solo cerebro; EEG. | Conectividad EEG, citar el propio ensayo, sensación de autoría. | Menor conectividad y peor capacidad de citar lo escrito en el grupo LLM. | Preprint. Un comentario crítico señala muestra pequeña, reproducibilidad, problemas en el análisis EEG, inconsistencias en los resultados y poca transparencia [42]. No es evidencia de aprendizaje: mide implicación neural y memoria del propio texto. |
| **Anthropic, informe de educación 2025** [45] | Análisis con Clio de ~1 millón de conversaciones de estudiantes. | Ninguna de aprendizaje: taxonomía de uso. | ~47 % de las conversaciones son "directas" (buscan respuesta con poca implicación). Claude ejecutaba sobre todo funciones de orden alto de Bloom: crear (39,8 %) y analizar (30,2 %). | Los autores admiten falsos positivos y negativos en la clasificación y sesgo de primeros usuarios [45]. Describe delegación, no la mide en resultados. |
| **OpenAI, study mode (jul. 2025)** [46] | Instrucciones de sistema escritas con docentes y expertos en pedagogía. | Ninguna publicada en el lanzamiento: testimonios de estudiantes. | — | Reconocen comportamiento inconsistente y anuncian estudios a más largo plazo [46]. |
| **LearnLM, marco de evaluación (Google, 2024)** [47][48] | Siete benchmarks (humanos y automáticos, cuantitativos y cualitativos). | Rúbricas pedagógicas: no revelar la respuesta, guiar, detectar errores conceptuales, adaptarse al nivel, mantener el tema, tono... | Expertos prefieren LearnLM con fuerzas medias de +31 % sobre GPT-4o, +11 % sobre Claude 3.5 Sonnet y +13 % sobre Gemini 1.5 Pro [48]. | Mide **comportamiento del tutor y preferencia de expertos**, no aprendizaje del alumno. Los propios autores dicen que pocos estudios evalúan resultados reales de aprendizaje [47]. |

Lo que más cambia el diseño de BookReader:

1. **La señal `asked` es central.** Bastani y Lehmann coinciden en que el daño viene de usar la IA como muleta (sustituir) y no como explicación (complementar). Calificarse después de preguntar al agente es rendimiento asistido. Esos intentos no deben contar como evidencia de memoria (inferencia).
2. **Un veredicto del agente sobre una respuesta asistida no es aprendizaje.** Lo es el veredicto sobre una respuesta **sin ayuda y diferida**.
3. **Las rúbricas tipo LearnLM sirven para evaluar al tutor** (¿da la respuesta o guía?) en evals offline, pero no sustituyen a medir al usuario.
4. **Sentirse más motivado o comprometido no es una medida de resultado** (Kestin, Deslauriers).

---

## 5. Medir con n=1 y on-device

### 5.1 Diseños de caso único

La What Works Clearinghouse tiene estándares para diseños de caso único con criterios de diseño y de evidencia, y análisis visual de series temporales [50]. Su lógica (línea base, intervención, retirada o línea base múltiple) se pensó para conductas observables repetidas. En aprendizaje tiene un problema: **lo aprendido no se "retira"**, así que los diseños ABAB funcionan mal (inferencia). La alternativa natural es la línea base múltiple entre libros o capítulos, introduciendo una función en momentos distintos.

### 5.2 Aleatorización dentro del usuario, por ítem

Con un único usuario, lo potente es aleatorizar **ítems**, no personas (inferencia basada en el diseño intra-sujeto clásico de la psicología de la memoria):

- **Subrayado → tarjeta o control.** De cada N subrayados elegibles, una fracción aleatoria (p. ej., 1 de cada 5) **no** se convierte en tarjeta. A los 14–30 días se lanza una sonda sobre ambos grupos. La diferencia estima el efecto de las tarjetas para ese usuario y ese tipo de libro.
- **Modo A frente a modo B.** Cloze frente a escribir la respuesta, o con pretest frente a sin pretest, asignado al azar por capítulo o por tarjeta. Resultado: acierto en la sonda diferida.
- **Con pista del agente frente a sin ella.** Si el usuario consiente, en una fracción de fallos el agente no da la explicación inmediata. Es costoso para la experiencia de uso; solo como experimento declarado.

Las sondas no deben alimentar a FSRS: si lo hacen, la medida cambia lo medido (la propia sonda es práctica de recuperación). Lo aceptable es un número pequeño y fijo de sondas por ítem (una).

### 5.3 Cuánto N hace falta

Tamaño por brazo para detectar la diferencia entre dos proporciones de acierto en la sonda diferida (α = 0,05 bilateral, potencia 0,8; cálculo propio):

| Acierto control | Acierto tratamiento | Ítems por brazo |
|---|---|---|
| 50 % | 70 % | 93 |
| 60 % | 75 % | 152 |
| 70 % | 80 % | 294 |
| 85 % | 90 % | 686 |
| 80 % | 85 % | 906 |

Y precisión de una sola proporción (acierto ~80 %), media anchura del IC 95 %: 20 ítems ±17 pp; 50 ítems ±11 pp; 100 ítems ±8 pp; 200 ítems ±5,5 pp.

Lectura: con un usuario normal (decenas o pocos cientos de sondas al año) **solo se detectan efectos grandes**. Además, los ítems del mismo libro no son independientes, lo que reduce el N efectivo. El A/B intra-usuario sirve para dar evidencia gruesa ("las tarjetas ayudan mucho / no se nota"), no para afinar parámetros. Para afinar, lo honesto es **agregar evals offline sobre backups que los usuarios exporten voluntariamente**, sin telemetría.

### 5.4 Enseñar incertidumbre sin engañar

Fernandes et al. probaron en un experimento incentivado que los *quantile dotplots* (50 puntos) llevaron a decisiones del 97 % del óptimo, 5 pp más que sin incertidumbre, y más consistentes; las CDF funcionaron casi igual y ambas superaron al texto [51].

Reglas para BookReader (inferencia apoyada en [51]):
- Nunca un número sin su N: "8 de 10 sondas" antes que "80 %".
- Por debajo de un mínimo (p. ej., 20 sondas), no dar porcentaje: "aún no hay datos suficientes".
- Mostrar el intervalo como rango o como puntos de frecuencia ("de cada 10 ideas como esta, recordarías entre 6 y 9").
- No hay comparaciones con otros usuarios (no existen) ni tendencias sobre menos de dos ventanas con N suficiente.
- Las diferencias A/B solo se enseñan cuando el intervalo excluye cero, y entonces con el intervalo.

---

## 6. Síntesis

### 6.1 Principios para un sistema de métricas anti-vanidad

1. **Retraso + sin ayuda + ítem nuevo = aprendizaje.** Si falta alguna de las tres, es rendimiento o memoria de la tarjeta [1][13][37].
2. **Separar el instrumento de medida del de práctica.** Las sondas no alimentan al planificador ni se repiten; si no, Goodhart está asegurado [22][36].
3. **Los intentos asistidos no cuentan como evidencia.** `asked = true` excluye el intento de las métricas de memoria y de calibración [37][44].
4. **Nada de autopercepción como resultado.** La satisfacción y el "siento que aprendo" van en contra del aprendizaje con dificultad deseable [3][2].
5. **Toda métrica de calibración del modelo va acompañada de otra que no se pueda trucar a la vez** (log loss junto a RMSE(bins); AUROC2 junto al sesgo) [36][7].
6. **Enseñar N e incertidumbre siempre**, y callar por debajo del mínimo [51].
7. **Lo que se enseña al usuario no es lo que se optimiza.** Las métricas de producto (uso, rachas) pueden existir para el desarrollador offline, nunca como titular de progreso.
8. **Validar al juez.** Los veredictos del agente (escribir la respuesta, recuerdo libre) se validan en evals offline contra calificación humana antes de usarlos como medida [47].
9. **Preferir conductas constructivas como proxy de proceso** (ICAP), sabiendo que es proceso y no resultado [17].

### 6.2 Catálogo de métricas candidatas

#### (a) Miden aprendizaje (con las condiciones indicadas)

| Métrica | Qué mide | Cálculo con los datos de BookReader | Cómo se infla (Goodhart) | Evidencia |
|---|---|---|---|---|
| **Retención diferida en sonda** | memoria sin ayuda tras un intervalo | Ítems-sonda (pregunta derivada de un subrayado o idea, **nunca vista como tarjeta**) que se lanzan una vez a ≥14 días. Acierto según el veredicto del agente en modo escribir. Se enseña como "k de n". | Sondas fáciles o copias literales de la tarjeta; dejar que el usuario elija cuándo responder. Mitigación: generación y momento automáticos y paráfrasis obligatoria. | [1][13] |
| **Transferencia (aplicación/inferencia)** | comprensión utilizable | Igual que la sonda, pero con preguntas de aplicación o "¿por qué?" generadas por el agente a partir del capítulo; acierto diferido. | El agente genera preguntas reconocibles o triviales. Mitigación: eval offline de la dificultad y la distancia de las sondas. | [13][49][37] |
| **Recuerdo libre diferido por capítulo** | comprensión del texto | "Cuéntame lo que recuerdas del capítulo X" a ≥7 días; el agente puntúa la proporción de ideas clave (lista extraída del capítulo) que aparecen. | Releer justo antes; lista de ideas laxa. Mitigación: no avisar con antelación y validar la puntuación del agente offline. | [16] (como medida, no como técnica) |
| **Efecto intra-usuario de una función** | si X ayuda *a este usuario* | Aleatorización por ítem (tarjeta/control, modo A/B) y diferencia en la sonda diferida, con intervalo. | Pocos datos con intervalos enormes presentados como hallazgos. Mitigación: umbral de N y enseñar el IC. | §5.2–5.3 |
| **Diferencia asistido/no asistido** | dependencia de la IA | Acierto en el siguiente repaso **sin ayuda** de tarjetas cuyo intento anterior fue `asked = true`, frente a tarjetas similares (misma R predicha por FSRS) con `asked = false`. | Correlacional: se pregunta más en las tarjetas difíciles. Mitigación: estratificar por R predicha y dificultad FSRS. | [37][44][43] |

#### (b) Proxies útiles con caveats

| Métrica | Qué mide | Cálculo | Cómo se infla | Evidencia |
|---|---|---|---|---|
| **Calibración del usuario (AUROC2 + sesgo)** | si sabe lo que sabe | Confianza pedida antes de revelar, en sesiones distintas a la de estudio; o autocalificación frente a veredicto del agente en modo escribir (solo intentos sin `asked`). | Responder siempre "medio"; el AUROC2 depende del rendimiento de base. | [5][7][8] |
| **True retention / acierto en repasos maduros** | memoria de las tarjetas propias | Ya existe. | Endógeno por construcción; se infla con tarjetas fáciles o calificándose "Bien" sin recuperar. | (ya conocido); [36] |
| **Conocimiento estimado (Σ R)** | tamaño de la memoria mantenida | Ya existe. | Crear muchas tarjetas triviales. Mitigación: enseñarlo como "tarjetas que probablemente recuerdas", nunca como "conocimiento", y no como titular. | (ya conocido) |
| **Ajuste de FSRS (log loss, RMSE(bins), AUC)** | si el planificador predice bien a este usuario | Sobre el revlog, con validación temporal. | Optimizar una sola métrica (RMSE-BINS-EXPLOIT). Siempre las tres juntas. | [36] |
| **Proporción de intentos sin ayuda** | autonomía en el repaso | 1 − (intentos `asked`) / intentos. | Desactivar al agente o calificarse antes de preguntar. Solo tendencia, sin objetivo. | [37][44] |
| **Tasa de actividades constructivas** | modo de implicación | Notas con palabras propias, autoexplicaciones y preguntas generadas, frente a subrayados sin nota. | Notas de relleno; el agente escribe la nota. Es proceso, no resultado. | [17][15][14] |
| **Calidad de la autoexplicación** | profundidad de la elaboración | El agente puntúa con una rúbrica (causalidad, conexión con conocimiento previo). | Respuestas largas y vacías; rúbrica blanda. Validar offline. | [15] |
| **Errores conceptuales detectados y resueltos** | corrección de malentendidos | El agente etiqueta un error en un intento; se comprueba si persiste en la sonda diferida. | Etiquetado indulgente. Validar offline. | [47] (dimensión de rúbrica) |

#### (c) Vanidosas o perversas

| Métrica | Por qué | Daño probable |
|---|---|---|
| Racha de días | Mide hábito; es la métrica de retención de Duolingo, no de aprendizaje [26]. | Repasos mínimos para no romperla; ansiedad. |
| Páginas o tiempo de lectura, libros terminados | No mide aprendizaje (ya sabido). | Leer en diagonal. |
| Tarjetas repasadas o creadas | Actividad. | Inflar el mazo de tarjetas triviales, que encima infla Σ R. |
| Acierto dentro de la sesión | Rendimiento inmediato [1]. | Premia la práctica masiva y las tarjetas fáciles. |
| Veredicto positivo del agente con ayuda | Rendimiento asistido [37]. | Recompensa usar la IA como muleta. |
| "% del libro dominado" o progreso tipo Duolingo Score | Progreso de completado disfrazado de dominio [23]. | El usuario confunde avanzar con saber. |
| "¿Cuánto has aprendido?" (autoinforme) | Se correlaciona al revés con el aprendizaje activo [3]. | Empuja el producto hacia lo cómodo y pasivo. |
| XP sin calibrar | Puntos por actividad. Math Academy lo hace honesto porque lo calibra como tiempo de esfuerzo y lo pondera por resultado [31]; sin eso es vanidad. | Granjear puntos. |
| Retención observada de FSRS como titular | Tiende al objetivo por construcción (ya sabido). | Falsa sensación de éxito constante. |

---

## Datos que no pude verificar o que dejé fuera

- **PFA (Pavlik, Cen y Koedinger 2009):** no abrí la fuente primaria; la descripción es la habitual en la literatura.
- **Deslauriers et al. 2019:** la página de PNAS bloqueó la lectura; usé la versión de PMC (mismo artículo).
- **Rhodes y Tauber 2011:** PubMed no cargó; el N y el número de efectos salen del resumen indexado y g = 0,93 del capítulo de Rhodes [6].
- **Koriat et al. 2004:** solo leí la descripción del experimento en [6].
- **Nissen et al. 2018:** leí el preprint de arXiv; la versión de PRPER bloqueó la lectura.
- **Banco Mundial (Nigeria):** el resumen del documento oficial no se pudo leer; las cifras salen del artículo de los propios autores en VoxDev [40].
- **Eedi/LearnLM:** circula una probabilidad bayesiana del 93,6 % en LinkedIn que no encontré en el resumen; no la uso.
- **Math Academy, Readwise y Brilliant:** no encontré estudios de eficacia independientes. Es ausencia de hallazgo, no prueba de que no existan.
- **Schraw 2009 y Bjork, Dunlosky y Kornell 2013:** no pude abrir el texto; no los cito para afirmaciones concretas.

---

## Referencias

1. Soderstrom, N. C. y Bjork, R. A. (2015). Learning versus performance: An integrative review. *Perspectives on Psychological Science*, 10(2). https://pubmed.ncbi.nlm.nih.gov/25910388/
2. Kornell, N. y Bjork, R. A. (2008). Learning concepts and categories: Is spacing the "enemy of induction"? *Psychological Science*, 19(6). https://pubmed.ncbi.nlm.nih.gov/18578849/
3. Deslauriers, L., McCarty, L. S., Miller, K., Callaghan, K. y Kestin, G. (2019). Measuring actual learning versus feeling of learning in response to being actively engaged in the classroom. *PNAS*. https://pmc.ncbi.nlm.nih.gov/articles/PMC6765278/
4. Koriat, A., Bjork, R. A., Sheffer, L. y Bar, S. K. (2004). Predicting one's own forgetting. *JEP: General*, 133(4). https://doi.apa.org/doi/10.1037/0096-3445.133.4.643
5. Rhodes, M. G. y Tauber, S. K. (2011). The influence of delaying judgments of learning on metacognitive accuracy: A meta-analytic review. *Psychological Bulletin*, 137(1). https://pubmed.ncbi.nlm.nih.gov/21219059/
6. Rhodes, M. G. (2016). Judgments of learning: Methods, data, and theory. *Oxford Handbook of Metamemory*. https://pdf.retrievalpractice.org/metacognition/8_Rhodes_2015.pdf
7. Fleming, S. M. y Lau, H. C. (2014). How to measure metacognition. *Frontiers in Human Neuroscience*, 8. https://pmc.ncbi.nlm.nih.gov/articles/PMC4097944/
8. Masson, M. E. J. y Rotello, C. M. (2009). Sources of bias in the Goodman–Kruskal gamma coefficient measure of association. *JEP: LMC*, 35(2). https://psycnet.apa.org/record/2009-02753-015
9. Schraw, G. (2009). A conceptual analysis of five measures of metacognitive monitoring. *Metacognition and Learning*, 4(1). https://psycnet.apa.org/record/2010-05435-003
10. Hake, R. R. (1998). Interactive-engagement vs. traditional methods: A six-thousand-student survey of mechanics test data. https://eric.ed.gov/?id=ED441679
11. Nissen, J. M., Talbot, R. M., Nasim Thompson, A. y Van Dusen, B. (2018). Comparison of normalized gain and Cohen's d for analyzing gains on concept inventories. *PRPER*, 14. Preprint: https://arxiv.org/abs/1612.09180
12. Coletta, V. P. y Steinert, J. J. Why normalized gain should continue to be used in analyzing preinstruction and postinstruction scores on concept inventories. *PRPER*. https://www.per-central.org/items/detail.cfm?ID=15401
13. Pan, S. C. y Rickard, T. C. (2018). Transfer of test-enhanced learning: Meta-analytic review and synthesis. *Psychological Bulletin*, 144(7). https://pubmed.ncbi.nlm.nih.gov/29733621/
14. Rosenshine, B., Meister, C. y Chapman, S. (1996). Teaching students to generate questions: A review of the intervention studies. *Review of Educational Research*, 66. https://psycnet.apa.org/record/1996-05691-003
15. Bisra, K., Liu, Q., Nesbit, J. C., Salimi, F. y Winne, P. H. (2018). Inducing self-explanation: A meta-analysis. *Educational Psychology Review*, 30. https://link.springer.com/article/10.1007/s10648-018-9434-x
16. Dunlosky, J., Rawson, K. A., Marsh, E. J., Nathan, M. J. y Willingham, D. T. (2013). Improving students' learning with effective learning techniques. *Psychological Science in the Public Interest*, 14(1). https://pubmed.ncbi.nlm.nih.gov/26173288/
17. Chi, M. T. H. y Wylie, R. (2014). The ICAP framework: Linking cognitive engagement to active learning outcomes. *Educational Psychologist*, 49(4). https://education.asu.edu/sites/g/files/litvpz656/files/lcl/chiwylie2014icap_2.pdf
18. Corbett, A. T. y Anderson, J. R. (1994). Knowledge tracing: Modeling the acquisition of procedural knowledge. *User Modeling and User-Adapted Interaction*, 4. https://link.springer.com/article/10.1007/BF01099821
19. Piech, C. et al. (2015). Deep knowledge tracing. *NeurIPS*. https://arxiv.org/abs/1506.05908
20. Khajah, M., Lindsey, R. V. y Mozer, M. C. (2016). How deep is knowledge tracing? *EDM*. https://arxiv.org/abs/1604.02416
21. Pelánek, R. (2016). Applications of the Elo rating system in adaptive educational systems. *Computers & Education*, 98. https://www.fi.muni.cz/~xpelanek/publications/CAE-elo.pdf
22. Strathern, M. (1997). "Improving ratings": audit in the British University system. *European Review*, 5(3). https://www.cambridge.org/core/journals/european-review/article/improving-ratings-audit-in-the-british-university-system/FC2EE640C0C44E3DB87C29FB666E9AAB
23. Duolingo (2024). How the Duolingo Score tracks your learning progress. https://blog.duolingo.com/duolingo-score/
24. Jiang, X., Rollinson, J., Plonsky, L., Gustafson, E. y Pajak, B. (2021). Evaluating the reading and listening outcomes of beginning-level Duolingo courses. *Foreign Language Annals*, 54(4). https://eric.ed.gov/?id=EJ1325291
25. Loewen, S. et al. (2019). Mobile-assisted language learning: A Duolingo case study. *ReCALL*, 31(3). https://eric.ed.gov/?id=EJ1226279
26. Duolingo (2026). Shareholder letter Q1 FY2026. https://www.sec.gov/Archives/edgar/data/1562088/000162828026029790/q1fy26duolingo3-31x26share.htm
27. Settles, B. y Meeder, B. (2016). A trainable spaced repetition model for language learning. *ACL*. https://aclanthology.org/P16-1174/
28. Yamkovenko, B. (2023). Why Khan Academy will be using "skills to proficient" to measure learning outcomes. https://blog.khanacademy.org/why-khan-academy-will-be-using-skills-to-proficient-to-measure-learning-outcomes/
29. Grimaldi, P., Weatherholtz, K. y Millwood Hill, K. (2022). Estimating the causal effects of Khan Academy MAP Accelerator across demographic subgroups. *EDM*. https://files.eric.ed.gov/fulltext/ED624104.pdf
30. Eames, T. et al. (2026). Computer-assisted learning in the real world: How Khan Academy influences student math learning. *PNAS*. https://www.pnas.org/doi/10.1073/pnas.2507708123
31. Math Academy. How it works. https://www.mathacademy.com/how-it-works
32. Math Academy. FAQ. https://www.mathacademy.com/faq
33. Quizlet. Learn. https://quizlet.com/gb/features/learn
34. de la Puente, M. y Pérez, H. (2023). Assessing the impact of Brilliant.org on enhancing mathematics academic performance among high school students in Colombia. *Mathematics Teaching Research Journal*, 15(2). https://eric.ed.gov/?id=EJ1394390
35. Readwise. Reviewing your highlights (docs). https://docs.readwise.io/highlights/docs/faqs/reviewing-highlights
36. Open Spaced Repetition. srs-benchmark. https://github.com/open-spaced-repetition/srs-benchmark
37. Bastani, H. et al. (2025). Generative AI without guardrails can harm learning: Evidence from high school mathematics. *PNAS*, 122. https://www.pnas.org/doi/10.1073/pnas.2422633122
38. Kestin, G., Miller, K., Klales, A. et al. (2025). AI tutoring outperforms in-class active learning: an RCT introducing a novel research-based design in an authentic educational setting. *Scientific Reports*. https://www.nature.com/articles/s41598-025-97652-6
39. De Simone, M. E. et al. (2025). From chalkboards to chatbots: Evaluating the impact of generative AI on learning outcomes in Nigeria. World Bank Policy Research Working Paper 11125. https://documents.worldbank.org/en/publication/documents-reports/documentdetail/099548105192529324
40. De Simone, M. et al. (2025). How AI tutors improved learning in Nigeria. *VoxDev*. https://voxdev.org/topic/education/how-ai-tutors-improved-learning-nigeria
41. Kosmyna, N. et al. (2025). Your brain on ChatGPT: Accumulation of cognitive debt when using an AI assistant for essay writing task. arXiv:2506.08872. https://arxiv.org/abs/2506.08872
42. Stankovic, M., Hirche, E., Kollatzsch, S. y Doetsch, J. N. (2025). Comment on: Your brain on ChatGPT. arXiv:2601.00856. https://arxiv.org/abs/2601.00856
43. Fan, Y. et al. (2024). Beware of metacognitive laziness: Effects of generative artificial intelligence on learning motivation, processes, and performance. *BJET*. https://arxiv.org/abs/2412.09315
44. Lehmann, M., Cornelius, P. B. y Sting, F. J. (2025). AI meets the classroom: When do large language models harm learning? arXiv:2409.09047. https://arxiv.org/abs/2409.09047
45. Anthropic (2025). Anthropic Education Report: How university students use Claude. https://www.anthropic.com/research/anthropic-education-report-how-university-students-use-claude
46. OpenAI (2025). Introducing study mode. https://openai.com/index/chatgpt-study-mode/
47. Jurenka, I. et al. (2024). Towards responsible development of generative AI for education: An evaluation-driven approach. arXiv:2407.12687. https://arxiv.org/abs/2407.12687
48. LearnLM Team (2024). LearnLM: Improving Gemini for learning. arXiv:2412.16429. https://arxiv.org/abs/2412.16429
49. LearnLM Team Google y Eedi (2025). AI tutoring can safely and effectively support students: An exploratory RCT in UK classrooms. arXiv:2512.23633. https://arxiv.org/abs/2512.23633
50. What Works Clearinghouse (2010). Single-case design technical documentation. https://ies.ed.gov/ncee/wwc/Document/229
51. Fernandes, M., Walls, L., Munson, S., Hullman, J. y Kay, M. (2018). Uncertainty displays using quantile dotplots or CDFs improve transit decision-making. *CHI*. https://mucollective.northwestern.edu/project/uncertainty-bus
