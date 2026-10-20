# Competencia de BookReader — reconocimiento 2026-10-20

> Pregunta: qué productos compiten con BookReader. Método: fuentes primarias (páginas de
> precios y producto de cada vendor) consultadas el 2026-10-20; donde solo hay fuente
> secundaria se marca **[S]**. Precios en USD y en la facturación más barata anunciada.
> Complementa [`INVESTIGACION_PRECIOS.md`](INVESTIGACION_PRECIOS.md), que mira solo el precio
> de referencia (Obsidian, Readwise, Raycast), no el mapa completo.

## 0. Qué trabajo compite (el filtro)

BookReader hace tres cosas que en el mercado se venden por separado: **leer tus propios
EPUB/PDF**, **convertirlos en conocimiento** (tarjetas, mapas, infografías, repaso) y
**sincronizarlos** sin cuenta. Cualquier producto que haga dos de las tres es competencia
real; el que haga una es competencia parcial o canal.

Esto descarta como competidor directo a Blinkist y compañía (venden el resumen, no leen tu
fichero) y ascende a Anki a **aliado** (nuestro export va hacia allí) en vez de rival.

## 1. Los cuatro que de verdad compiten

| Producto | Precio | Por qué compite | Qué no tiene |
|---|---|---|---|
| **Gemini Notebook** (ex NotebookLM, renombrado jul-2026) | Gratis (50 fuentes por cuaderno) · AI Plus **4,99 $/mes** · AI Pro **19,99 $** (300 fuentes) · Ultra 99,99–199,99 $ (600) [D] | Mismo gesto: subes tus documentos y el modelo los lee, resume, genera tarjetas, audio y mapas. Marca, infraestructura y **precio 0** | No es un lector: no hay biblioteca, ni subrayado con CFI, ni repaso, ni offline real. Tus libros viven en su nube |
| **Readwise Reader** | **9,99 $/mes** en anual (Lite 5,59 $); 12,99 $ mensual **[S]** [D] | El producto más maduro del nicho: EPUB/PDF/artículos, Ghostreader global con citas sobre **toda** la biblioteca, export a Obsidian/Notion, MCP | Nube obligatoria, sin BYOK, sin repaso FSRS, sin mapas ni infografías |
| **MarginNote 4** | PRO **4,99 $** (upgrade) · Max **16,99 $/año** · Max lifetime **51,99 $** [D] | El más cercano en producto: PDF/EPUB/web, subrayado → nodo de mapa → tarjeta, **FSRS**, IA que propone y tú aceptas | Solo iPad/Mac, cerrado, sin web ni PWA, sin sync propio ni MCP |
| **Koodo Reader** | **Gratis** (AGPL-3.0) [D] | Open source, 15 formatos, sync a Drive/OneDrive/WebDAV/Dropbox, y **IA con tu propio modelo** — el mismo BYOK, a coste cero | IA superficial (traducir, diccionario, resumen), sin estudio ni repaso, interfaz de otro tiempo |

**El incómodo es Koodo.** Es el mismo modelo de negocio que el plan Gratis de BookReader
(local-first + BYOK + sync a tu Drive) y ya existe, es gratis y tiene más formatos. Lo que
no tiene es la capa de estudio ni el agente que lee el libro entero con un objetivo.

## 2. Estudio y repaso (territorio del plan Pro, 29 $)

| Producto | Precio | Solape |
|---|---|---|
| **RemNote** | Free · Pro **8 $/mes** (96 $/año) · Pro+IA **18 $/mes** (216 $/año) [D] | Notas + PDF anotado + tarjetas IA + FSRS. El competidor más completo del plan Pro |
| **MarginNote 4** | ver arriba [D] | Mismo flujo libro→tarjeta, pero Apple-only |
| **Anki** | Gratis en escritorio y Android; iOS de pago (una vez) [D] | **Aliado.** Es el estándar y el destino de nuestro export; competir contra él sería perder |
| **Heptabase** | Pro **8,99 $** · Premium **17,99 $** · Premium+ **53,99 $/mes** [D] | Espacio visual con PDF, AI tutor y créditos; vende "segundo cerebro", no lector |
| **Traverse** | Free · Member **15 $/mes** [D] | Mapas + notas + repaso en web; sin lector de EPUB serio |
| **Rember** | Free · Pro **8 $/mes** [D] | Tarjetas desde libros/YouTube con repaso; sin lector |
| **Mochi** | **5 $/mes** [D] | Repaso puro, sin captura desde el libro |
| **Turbo AI** | Free · ~**5,99–19,99 $/mes** **[S]** | Estudio desde PDFs/clases para estudiantes; 10 M de usuarios declarados |
| **Quizlet** | Plus **7,99 $/mes** o 35,99 $/año **[S]** | Repaso masivo, sin lectura |

Lectura del bloque: el repaso como categoría está **commoditizado y barato** (5–8 $/mes). Un
Pro de 29 $ no se defiende vendiendo "tarjetas y repaso" — se defiende vendiendo el **flujo
completo desde el libro que ya tienes**, que es justo lo que ninguno de estos hace.

## 3. Resúmenes de libros (otro trabajo, mismo presupuesto)

**Blinkist** (79,99–139,99 $/año de intro, luego 99,99–174,99 $ [D]), **12min**
(4,99–7,99 $/mes, mercado ES [D]), **Shortform** (sin precio público verificado). Venden el
resumen hecho, no leen tu fichero: canibalizan al lector casual, no al que ya tiene el EPUB y
quiere exprimirlo. Riesgo real: que el usuario compare "15 min de resumen" con "leer un libro
con un agente" y elija lo barato.

## 4. Ecosistemas cerrados (riesgo de plataforma)

- **Kindle "Ask this Book"** — desplegado en 2025 y con **rollout amplio en 2026** sobre libros
  comprados o prestados [D]. Si Amazon regala la pregunta al libro, la feature deja de ser
  diferencial en el único sitio donde el usuario ya tiene el libro legal.
- **Apple Books / Apple Intelligence** y **Google Play Books** — integran resumen y preguntas en
  el sistema operativo. Mismo efecto: commoditizan el "pregunta al libro".
- Lo que **no** commoditizan: leer *tus* ficheros, sin cuenta, sin subirlos, offline, y sacar
  tarjetas a Anki. Ahí sigue habiendo hueco.

## 5. Autoalojado y open source (el suelo de precio)

**Kavita**, **Calibre-Web**, **Thorium Reader**, **BookHaven** — gratis, sin IA o con IA
enchufable [D]. Confirman el suelo: nadie paga por "leer EPUB". Se paga por el agente, el
estudio y el sync.

## 6. Dónde queda el hueco (y cuáles son los riesgos)

**Hueco defendible, en orden de fuerza:**

1. **Flujo completo con salida a Anki/FSRS.** Del EPUB a la tarjeta repasable sin salir de la
   app. Readwise exporta subrayados, RemNote hace tarjetas pero no lee libros enteros,
   MarginNote lo hace pero solo en Apple. Nadie lo hace en web.
2. **Tu biblioteca dentro de Claude/ChatGPT (MCP).** Readwise ya tiene MCP [S]; es la única
   feature del mapa que un competidor está empezando a copiar. Ventaja corta: 6–12 meses.
3. **Local-first sin cuenta y sin subir el libro.** Ni NotebookLM, ni Readwise, ni MarginNote lo
   ofrecen. Es el argumento que gana en HN/self-hosted, y el que Koodo ocupa gratis.

**Riesgos, por orden de gravedad:**

- **Gemini Notebook gratis** hace el 80 % de lo que el usuario percibe como "entiende mi libro".
  Si el mensaje de BookReader es "pregúntale al libro", pierde por precio y por marca. Si es
  "conviértelo en repaso que no se te olvida", no compite con él.
- **Koodo gratis con BYOK** convierte el plan Gratis en "lo mismo pero peor". El plan Gratis
  tiene que ser igual de bueno en lectura o el usuario se va al open source.
- **Pro a 29 $** compite con RemNote a 8 $/mes y MarginNote a 17 $/año. El pago único se
  defiende solo si la promesa es el flujo entero y "para siempre".

**Una frase:** el mercado está lleno de productos que leen tu libro y de productos que te hacen
repasar; **casi nadie une las dos cosas y menos aún en web, sin cuenta y con salida a Anki** —
ese es el producto, y el marketing debería decir eso y no "chatea con tus libros".

## Fuentes

- https://notebook.google/plans [D] — planes y límites de fuentes; renombrado desde NotebookLM.
- https://one.google.com/intl/en_us/about/google-ai-plans/ [D] — AI Plus 4,99 $, Pro 19,99 $.
- https://readwise.io/pricing [D] — Lite 5,59 $, Full 9,99 $ (anual); Reader incluido en Full.
- https://docs.readwise.io/reader/docs/faqs/ghostreader [D] — Ghostreader global con citas.
- https://readwise.io/reader/update-aug2026 [D] — soporte y arreglos de subida de EPUB.
- https://www.marginnote.com/en/ y /en/pricing/ [D] — PRO 4,99 $, Max 16,99 $/año, lifetime 51,99 $; FSRS.
- https://www.koodoreader.com/en [D] — AGPL-3.0, 15 formatos, sync multi-nube, IA con modelo propio.
- https://www.remnote.com/pricing [D] — Free / 8 $ / 18 $ al mes.
- https://heptabase.com/pricing [D] — 8,99 / 17,99 / 53,99 $.
- https://traverse.link/pricing [D] — 15 $/mes.
- https://www.rember.com/ [D] — Pro 8 $/mes.
- https://mochi.cards/ [D] — Pro 5 $/mes.
- https://quizlet.com/upgrade [D] y review [S] — 7,99 $/mes o 35,99 $/año.
- https://www.blinkist.com/pricing [D] — 79,99/139,99 $ intro, luego 99,99/174,99 $/año.
- https://12min.com/es/pricing [D] — Premium 4,99 $, Gold 7,99 $/mes.
- https://authorsguild.org/news/statement-on-amazon-kindle-ask-this-book-ai-feature/ [D] — "Ask this Book", rollout amplio en 2026.
- https://kindlepreneur.com/amazon-ask-this-book/ [D] — alcance a dispositivos Kindle y Android en 2026.
- https://apps.ankiweb.net/ [D] — escritorio gratis, sync AnkiWeb.
- https://www.fahimai.com/turbo-ai [S] — 5,99–19,99 $/mes.
