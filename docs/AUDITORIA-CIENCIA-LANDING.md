# Auditoría científica de la landing `/es/lee-el-libro/`

Comprobación de las cifras de «Los números» contra los PDF originales, y búsqueda de evidencia
para «Y por qué el libro entero» (que hoy la propia página declara como creencia).

Veredicto corto: **las cuatro cifras se sostienen tal y como están escritas**. La sección del
libro entero **no se puede respaldar como está insinuada** («el libro entero te hace recordar
más»), porque hay evidencia publicada en contra; sí se puede respaldar una versión más estrecha
y más fuerte (mecanismo, no conclusiones).

---

## 1. «Los números» — las cuatro cifras

### 1.1 «61 % frente a 40 % — lo que se recuerda a la semana» ✅

Roediger y Karpicke (2006), *Psychological Science* 17(3), 249–255. **Experimento 2**, prueba
final a **1 semana**: STTT (estudiar una vez + tres tests) 61 % frente a SSSS (estudiar cuatro
veces) 40 %, t(58) = 4,78, d = 1,26.

Condiciones exactas, por si alguien las pregunta:

- Pasajes TOEFL de **256 y 275 palabras**, 30 unidades de idea, **recuerdo libre**, **sin feedback**.
- 180 estudiantes de Washington University, 30 por celda.
- Ojo: la cifra del **Experimento 1** es otra (56 % vs 42 % a la semana). Usar 61/40 es correcto,
  pero es Exp. 2 y conviene no mezclarlas en la misma página. En `read-the-book` y en el blog,
  comprobar que no aparezca 56/42 atribuido a la misma frase.

### 1.2 «3,4 frente a 14,2 — veces que leyeron el texto» ✅

Mismo artículo, **Tabla 1**: pasadas completas contadas por el propio sujeto durante los periodos
de estudio. SSSS = 14,2 (suma de cuatro periodos de 5 min, ~3,5 por periodo); STTT = 3,4 (un solo
periodo). La frase «el grupo que más recordó lo leyó cuatro veces menos» es literalmente cierta
(14,2 / 3,4 = 4,18).

Caveat si te lo discuten: el grupo que se puso a prueba dispuso de **más minutos totales**
(5 min de estudio + 3 × 10 min de test = 35 min) que el de relectura (4 × 5 = 20 min). La
comparación honesta es «una pasada frente a cuatro», no «el mismo tiempo». La copia actual no
afirma igualdad de tiempo, así que no hay que tocarla; solo no añadir «con el mismo tiempo».

### 1.3 «2 de 10 — técnicas de estudio que funcionan» ✅

Dunlosky et al. (2013), *Psych. Science in the Public Interest* 14(1). Diez técnicas evaluadas;
**dos** con utilidad alta: *practice testing* y *distributed practice*. Cinco con utilidad baja:
**resumir, subrayar, mnemotecnia de palabra clave, imágenes y releer**. La frase de la landing
(«subrayar y releer están entre las de utilidad baja») es exacta.

Matiz útil y no usado: **resumir también es de utilidad baja** en esa tabla. Sirve para el
argumento del libro entero, pero hay que usarlo con cuidado (mide resumir *como técnica propia*,
no leer el resumen de otro).

### 1.4 «84 % frente a 11 % — relee · intenta recordar» ✅

Karpicke, Butler y Roediger (2009), *Memory* 17(4), 471–479. Encuesta a 177 universitarios de
Washington University: **83,6 %** (148/177) lista relectura de apuntes o libro; **11 %** (19/177)
dice practicar recuperación sin ambigüedad; solo **1 %** (2/177) la pone como estrategia número uno.

Caveats que merecen una nota al pie si la cifra se queda sola:

- Es **auto-informe**, no observación, y de una universidad selectiva (SAT > 1400).
- El 11 % es «sin ambigüedad»: un 43 % dijo resolver problemas de práctica y un 40 % usar
  flashcards, que pueden o no ser recuperación. En la pregunta forzada, el 18 % elegiría
  autoevaluarse y el 57 % releer.
- No invalida la frase actual, pero un lector hostil dirá que el 11 % está subestimado.

---

## 2. «Y por qué el libro entero» — qué hay y qué no hay

La página dice: «Esto ya no es un estudio: es lo que creemos». **Es la decisión correcta**, y
conviene mantenerla para la parte de propiedad. Pero hay tres cosas que sí están medidas y que
hoy se están dejando fuera.

### 2.1 Lo que sí hay

**(a) Profundidad frente a cobertura (Lehmann, Cornelius y Sting, 2025).** Dos experimentos
preregistrados e incentivados más un estudio de campo. Quien **sustituye** su estudio por la IA
(pide soluciones) **cubre más temas y entiende menos de cada uno**; quien la **complementa**
(pide explicaciones) no amplía cobertura y **entiende más**. Es el eje exacto de «resumen frente
a libro»: más superficie, menos profundidad. Ya está en
[`INVESTIGACION_METRICAS_APRENDIZAJE.md`](INVESTIGACION_METRICAS_APRENDIZAJE.md) (ref. 44), pero
no se usa en la landing.

**(b) El resumen empeora a los buenos lectores (Etkin et al., 2025).** *Frontiers in Education*
10:1506752, n = 195, diseño cruzado aleatorizado, pasajes del ACT, cuatro herramientas GPT
(resumen, esquema, tutor de preguntas, chat socrático). Resultado preregistrado: las herramientas
**mejoran a los lectores flojos y empeoran a los buenos**, y la que más empeora a los buenos es
**justo la de resumen**. Es el único dato que he encontrado medido directamente con resúmenes
generados y comprensión de un texto.

**(c) La ilusión es máxima justo en el «porqué» (Rozenblit y Keil, 2002).** *Cognitive Science*
26, 521–562. La gente se siente entender mecanismos causales mucho más de lo que los entiende, y
el desfase aparece en cuanto se le pide explicarlos. El efecto es **mayor para conocimiento
explicativo** (cómo funciona algo) que para hechos, procedimientos o narraciones. Es la base
empírica de «un resumen te cuenta a qué llegó el autor y tú sientes que entiendes por qué».

**(d) Lo que se transfiere es el mecanismo (Pan y Rickard, 2018).** Metaanálisis ya citado en el
repo (ref. 13): la práctica de recuperación transfiere con d = 0,40, y transfiere **más** cuando
la recuperación es elaborada y hacia preguntas de aplicación e inferencia. Reconocer la
conclusión de otro no es ninguna de las dos cosas.

### 2.2 Lo que hay en contra (y por eso no se puede afirmar «recuerdas más»)

**Reder y Anderson (1980).** *J. Verbal Learning and Verbal Behavior* 19, 121–134. Siete
experimentos comparando un capítulo con **su resumen**: ventaja consistente del resumen en
pruebas de **ideas principales**. Trabajos posteriores del mismo grupo separaron dos causas que
allí iban confundidas (brevedad frente a organización y repetición espaciada), lo que sugiere que
la ventaja viene de la estructura y el espaciado más que de la condensación.

Consecuencia práctica: **la landing no puede decir ni insinuar que leer el libro entero hace
recordar más.** Sería falso o, como mínimo, discutible con literatura de 1980. Lo que sí puede
decir es que el resumen **conserva lo que se recuerda igual** (las conclusiones) y **pierde lo que
no se puede recuperar de un resumen** (el mecanismo, el argumento, los motivos por los que el
autor descarta las alternativas).

También hay estudios flojos que dan ventaja a resúmenes generados por IA en comprensión (por
ejemplo, un trabajo de 2026 con estudiantes chinos de inglés B2 y textos de economía, donde el
resumen gana al texto completo). No los usaría: el resumen estaba en chino/inglés simplificado y
el texto original era en inglés, así que miden proficiencia de lengua, no aprendizaje.

### 2.3 Lo que es postura, no ciencia

- **Criterio** («si nunca ves el argumento completo, no puedes estar en desacuerdo»): es una
  afirmación normativa razonable, no un hallazgo. Hay literatura de argumentación, pero nada que
  la mida así. Dejarla como creencia, con esa palabra.
- **Propiedad** (tus ficheros, tus notas, tu biblioteca): no es una afirmación empírica. Mezclarla
  bajo el epígrafe «esto es lo que creemos» diluye las otras dos, que sí pueden subir de nivel.

---

## 3. Copy propuesto

Dos bloques, separando lo medido de lo que es postura. Mantiene el tono y la longitud.

> ## Y por qué el libro entero.
>
> Esto ya no es un estudio: es lo que creemos. Pero antes, lo que sí está medido.
>
> **Un resumen conserva lo que ya se recuerda igual.** En siete experimentos comparando un
> capítulo con su resumen, el resumen ganó en las preguntas sobre las ideas principales
> (Reder y Anderson, 1980). Lo que no conserva es el mecanismo: por qué el autor llega ahí y por
> qué descarta lo demás.
>
> **Y el mecanismo es lo que se usa.** Lo que se transfiere a un problema nuevo no es la
> conclusión, es la explicación (Pan y Rickard, 2018). Justo lo que un resumen no lleva.
>
> **El resumen no te hace mejor lector.** En un experimento con 195 lectores y cuatro herramientas
> de IA, la de resumen fue la que más empeoró la comprensión de los que ya leían bien
> (Etkin y otros, 2025). A los que leían mal, les ayudó. Tú no eres el que lee mal.
>
> **Y luego está lo que sentimos.** Nos sentimos entender un mecanismo mucho más de lo que lo
> entendemos, y solo se cae la ilusión cuando alguien nos pide explicarlo (Rozenblit y Keil,
> 2002). Un resumen alimenta exactamente esa sensación.
>
> Lo que queda, y esto es postura y no ciencia:
>
> **Criterio.** Si nunca ves el argumento completo, no puedes estar en desacuerdo. Te quedas con
> la conclusión de otro.
>
> **Propiedad.** Tu biblioteca en la nube de otro es una suscripción. Tus ficheros y tus notas son
> tuyos, y se van contigo.

Si se quiere la versión de una línea para el bloque de tesis: **«Un resumen te da lo que se
recuerda igual. El libro te da lo que se puede usar.»**

---

## 4. Micro-arreglos a «Los números» (opcionales, para blindarla)

- En la cifra 61/40, añadir en el subtítulo: «recuerdo libre de un texto de 250 palabras, sin
  feedback». Quita la única objeción de validez externa que tiene.
- En la cifra 84/11: «encuesta a 177 universitarios; el 11 % lo dijo sin ambigüedad». Cuesta seis
  palabras y desarma la crítica.
- No mezclar 61/40 (Exp. 2) con 56/42 (Exp. 1) en la misma página ni en la de `/read-the-book/`.

## Referencias

- Roediger, H. L. y Karpicke, J. D. (2006). Test-enhanced learning. *Psychological Science*, 17(3), 249–255. https://colinallen.dnsalias.org/Readings/2006_Roediger_Karpicke_PsychSci.pdf
- Dunlosky, J. et al. (2013). Improving students' learning with effective learning techniques. *PSPI*, 14(1). https://www.whz.de/fileadmin/lehre/hochschuldidaktik/docs/dunloskiimprovingstudentlearning.pdf
- Karpicke, J. D., Butler, A. C. y Roediger, H. L. (2009). Metacognitive strategies in student learning. *Memory*, 17(4), 471–479. https://learninglab.psych.purdue.edu/downloads/2009/2009_Karpicke_Butler_Roediger.pdf
- Lehmann, M., Cornelius, P. B. y Sting, F. J. (2025). AI meets the classroom: When do large language models harm learning? arXiv:2409.09047. https://arxiv.org/abs/2409.09047
- Etkin, H. K., Etkin, K. J., Carter, R. J. y Rolle, C. E. (2025). Differential effects of GPT-based tools on comprehension of standardized passages. *Frontiers in Education*, 10:1506752. https://doi.org/10.3389/feduc.2025.1506752
- Rozenblit, L. y Keil, F. (2002). The misunderstood limits of folk science: an illusion of explanatory depth. *Cognitive Science*, 26(5), 521–562. https://cogdevlab.yale.edu/sites/default/files/files/rozenblit%20%26%20keil%20%202002.pdf
- Pan, S. C. y Rickard, T. C. (2018). Transfer of test-enhanced learning. *Psychological Bulletin*, 144(7). https://pubmed.ncbi.nlm.nih.gov/29733621/
- Reder, L. M. y Anderson, J. R. (1980). A comparison of texts and their summaries: Memorial consequences. *JVLVR*, 19, 121–134. https://www.sciencedirect.com/science/article/pii/S002253718090122X
