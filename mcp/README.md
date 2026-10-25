# BookReader MCP — leer tu biblioteca desde un agente externo

Un servidor **MCP local (stdio)** que lee los datos de BookReader y los pone a disposición de un
agente externo (Claude Desktop, Claude Code, cualquier cliente MCP). **Solo lectura**: aquí no se
crea ni se modifica nada.

No es una API pública ni expone tu biblioteca en la red: es un puente local en tu máquina, con tus
datos, bajo tu control. No toca una línea de la app.

Dos fuentes, la misma superficie de tools:

| | **F1 · backup** | **F2 · layout de sync** |
| --- | --- | --- |
| De dónde lee | El JSON de «Descargar backup (JSON)» | `library.json` (el catálogo), `manifest.json`, `settings.json`, `books/<id>.json` |
| Credenciales | Ninguna | Refresh token de Google (o una carpeta copiada) |
| Datos | Foto del momento | Vivos |
| `reading_stats` | **No existe** (el backup no lleva el registro de lectura) | Sí |
| `list_decks`, `get_deck`, `list_artifacts`, `get_artifact` | Sí, **si el backup es del formato actual** (lleva `ai.decks`/`ai.artifacts`); un backup viejo no las anuncia | Sí |
| Títulos | Solo si el libro pasó por el agente (`title: null` si no) | Del catálogo (`library.json`); sin él, del manifest |

F2 lista los libros desde `library.json` —el catálogo: es el que sabe **qué libros tienes** y cuáles están
borrados (`deleted`)—, no desde `manifest.json`, que es el índice de los ficheros de datos de lectura.
Sin `library.json` (layout viejo) cae al manifest.

Prueba F1 primero: responde si el caso de uso aporta algo antes de pagar el peaje de Drive.

El layout de F2 puede estar en Google Drive o en el **sync de BookReader** (MON4, cifrado de
extremo a extremo): misma lectura, mismas tools. Ver «La fuente del sync de BookReader», abajo.

---

## F1 · la limitación, primero

La fuente de backup es una **foto**, y eso tiene consecuencias que conviene saber antes de probarla:

1. **No hay estadísticas de lectura.** El registro vive en su propia IndexedDB
   (`app/js/reading-log.js`) y `buildBackup()` no lo incluye. Por eso `reading_stats` **no se
   anuncia** con esta fuente: una tool que siempre contesta «no hay datos» es peor que una tool que
   no existe, porque el modelo la llama.
2. **Los mazos y artefactos dependen del formato del backup.** Desde el arreglo de backup
   completo, `buildBackup()` exporta también `decks` y `artifacts`, así que un backup **nuevo** sí
   los trae y las cuatro tools se anuncian. Un backup **viejo** (exportado antes de ese cambio) no
   los lleva y el MCP no las anuncia — la capacidad se **detecta** en el fichero, no se declara
   (mismo criterio que `reading_stats`: una tool que siempre contesta «no hay datos» es peor que
   una tool que no existe).
3. **Puede no haber títulos.** El backup no lleva la biblioteca (está en IndexedDB), así que el
   título solo existe si el libro pasó por el agente. Si no, `list_books` devuelve `title: null` y
   el cliente usa el `id`.
4. **Lo que lees durante la sesión no aparece** hasta que vuelvas a exportar el backup.

Lo que sí trae: subrayados (con su nota al margen), marcadores, notas de libreta con su contexto de
conversación y los metadatos del agente.

## Lo que este MCP nunca lee ni devuelve

Está en código, no en una costumbre: [`src/redact.mjs`](src/redact.mjs).

| Clave | Por qué |
| --- | --- |
| `ai_key` | Es tu API key (BYOK): un secreto que no sale del dispositivo. |
| `drive_refresh_token` | Es el permiso permanente sobre tu Drive. |
| `device_id` | No es inocuo: es la mitad de la clave con la que cada equipo escribe sus días de lectura. Si se clona, dos equipos escriben la misma fila y uno deja de contar. |
| `license`, `sync_state`, `sync_schema_migrated` | Ninguna tool las necesita; se vetan por conservadoras. |

El backup ya las excluye al exportar, pero **el layout de sync SÍ lleva el `deviceId`**: cada
registro de `settings.reading_days` es `{ key: '<día>|<deviceId>', deviceId, … }`. Por eso la
fuente de Drive tira el campo *y* el `key` (que lo lleva dentro) antes de sumar nada, y el test
busca el identificador literal en la salida entera de cada tool.

`scrub()` borra lo vetado de cualquier estructura a cualquier profundidad y `findForbidden()` lo
comprueba: [`test/redaction.test.mjs`](test/redaction.test.mjs) planta secretos en un backup y en
un layout, y verifica que ninguna tool los devuelve.

---

## Probarlo en 3 comandos

```bash
cd mcp && npm install
node cli.mjs --backup ~/Descargas/bookreader-backup-2026-09-23.json list_books
node server.mjs --backup ~/Descargas/bookreader-backup-2026-09-23.json   # servidor MCP por stdio
```

El backup se saca de la app: **Ajustes (⚙) → Datos → «Descargar backup (JSON)»**. El servidor
escribe sus diagnósticos por **stderr** (stdout es el canal del protocolo y ahí no se toca nada).

Con la fuente viva, si ya tienes una carpeta copiada del layout:

```bash
node cli.mjs --dir ~/bookreader-layout tools                       # qué tools anuncia esta fuente
node cli.mjs --dir ~/bookreader-layout reading_stats '{"range":"7d"}'
```

## Las tools

| Tool | Argumentos | Qué devuelve |
| --- | --- | --- |
| `list_books` | — | Libros con contadores (subrayados, marcadores, notas, conversaciones), última actividad y última posición. |
| `get_highlights` | `bookId` o `book`, `limit?`, `offset?` | Subrayados del libro con texto, nota, capítulo/página, color y CFI. |
| `get_notes` | `bookId` o `book`, `limit?`, `offset?` | Notas de libreta con `fieldKey`, etiqueta, objetivo y conversación de origen. |
| `search_highlights` | `query`, `bookId?`/`book?`, `limit?` | Busca en el texto de los subrayados y en sus notas, sin distinguir mayúsculas ni acentos. Todos los términos deben aparecer (AND). |
| `reading_stats` | `range?`, `bookId?`/`book?`, `groupBy?` | **Solo F2.** Minutos, palabras y unidades de lectura real, con desglose por día/semana/mes y por libro. |
| `list_decks` | `bookId?`/`book?` | **Solo F2.** Mazos de flashcards con contadores de repaso: tarjetas, vencidas hoy, nuevas y suspendidas. Sin el texto de las tarjetas. |
| `get_deck` | `bookId` o `book`, `deckUid?` (o `deckId?`/`scope?`), `limit?` | **Solo F2.** Las tarjetas de un mazo: frente, dorso, capítulo, suspensión y estado SRS (`due`, `reps`, `stability`, `difficulty`). Mejor por `deckUid`: el `deckId` numérico cambia de un dispositivo a otro. |
| `list_artifacts` | `bookId?`/`book?`, `kind?` | **Solo F2.** Qué salió del Studio (summary, mindmap, infographic, figures), con una `preview` de como mucho 200 caracteres: nunca el contenido entero. |
| `get_artifact` | `bookId` o `book`, `key` | **Solo F2.** El `result` completo de un artefacto, serializado, con tope de 20000 caracteres (`truncated: true` y `totalChars` si se recorta). |

`book` es el título o parte de él, sin tildes ni mayúsculas; si casa con varios libros, la tool lo dice con los candidatos. Un argumento que la tool no conoce es un error que lista los que sí acepta: antes se ignoraba y el filtro no se aplicaba.

**Con el sync de BookReader**, según los permisos del token (Ajustes → Datos → Agentes):

| Tool | Permiso | Qué hace |
| --- | --- | --- |
| `get_toc` | texto | Capítulos de un libro con su tamaño en palabras. |
| `read_chapter` | texto | Un capítulo por páginas (~6000 palabras; `offset`/`nextOffset`), con las anclas `[[aN]]` de la app. |
| `search_book` | texto | Los pasajes que mejor responden a una búsqueda (BM25), con ancla y capítulo. |
| `search_library` | texto | Busca en TODOS los libros a la vez (índice que construye la app, IA10): los libros que mejor tratan el tema con sus pasajes, varias formulaciones (`queries`), filtro por estantería y `notSearched`. |
| `add_cards` | escritura | Tarjetas nuevas (basic, cloze o mcq) en un mazo, validadas como en la app; la cita de una mcq y el `src` se comprueban contra el texto del capítulo. |
| `update_cards` | escritura | Cambia anverso, reverso, tipo, capítulo o suspensión. **El repaso se conserva.** |
| `delete_cards` | escritura | Borra tarjetas (tombstone: el borrado llega a todos los dispositivos). |
| `create_deck` | escritura | Un mazo nuevo para un libro o capítulo, con sus primeras tarjetas si se quiere. |
| `create_mindmap` | escritura | Un mapa mental en el Studio (2–8 ramas, hasta 6 conceptos cada una). |
| `create_infographic` | escritura | Una infografía con la plantilla de la app (tesis, ideas, paneles, cita). |
| `create_summary` | escritura | Un resumen por capítulos, con viñetas que citan el pasaje. |
| `delete_artifact` | escritura | Borra un mapa, infografía o resumen (tombstone). |
| `list_shelves` | — | Estanterías (anidadas con «/», inteligentes con su regla) y cuántos libros tiene cada una. `list_books` trae autor, estado y `shelfIds`. |
| `move_books` | biblioteca | Mete y saca libros de estanterías, en lote (por id o por título). |
| `update_books` | biblioteca | Título, autor y estado (unread/reading/finished) de libros, en lote. |
| `create_shelf` | biblioteca | Estantería normal (con libros, si se quiere), anidada o inteligente (`rule`). |
| `update_shelf` | biblioteca | Renombrar (también moverla en el árbol) o cambiar su regla. El id no cambia. |
| `reorder_shelves` | biblioteca | El orden de las estanterías de un nivel. |
| `delete_shelf` | biblioteca | Borra una estantería: los libros salen de ella y las reglas que la citan se limpian. |
| `create_book_upload` | subir | Paso 1 de subir un EPUB o PDF: con nombre, tamaño y SHA-256, devuelve una URL de un solo uso para el PUT (o `exists` si ya está). |
| `get_book_upload` | subir | Cómo quedó una subida: `pending`, `done`, `failed` (con el motivo) o `expired`. |
| `delete_books` | borrar | Borra libros (por id o título, hasta 50) como «Borrar» en la app. Subrayados, notas y mazos se conservan. |

Organizar la biblioteca pide su propio permiso («Organizar mi biblioteca»). Cada libro tocado
lleva el sello de su grupo (`shelvesAt`, `statusAt`, `metaAt`), así que un pase de página en otro
dispositivo que aún no bajó el cambio no lo revierte. Cada cambio guarda su deshacer: los valores
anteriores de lo que tocó, cifrados con la clave del sync. En la app, Ajustes → Datos → Agentes
lista los cambios recientes con «Deshacer», que solo revierte lo que hizo el agente.

Subir libros pide su propio permiso («Subir libros»). Los bytes no pasan por el modelo ni por
JSON-RPC: `create_book_upload` devuelve una URL de un solo uso (15 minutos, ese tamaño, ese hash)
y el agente sube el fichero con un PUT (`curl -sS -T libro.epub "<url>"`). El Worker comprueba
tamaño, formato (cabecera de zip o `%PDF-`), DRM (Adobe, Apple, LCP) y SHA-256, lo cifra trozo a
trozo con la clave del sync, lo guarda en `files/<sha>.<ext>` como la app y lo da de alta en
`library.json`. El bookId es el hash, así que el mismo libro no se duplica; si el fichero ya
estaba en el sync, vuelve a la biblioteca sin subir nada. La cuota se comprueba antes de dar la
URL. En la URL va un secreto: D1 guarda su hash y, cifrados con él, la clave y lo declarado (sin
títulos ni hashes en claro). Va a R2 por partes según se cifra, así que en memoria no hay más de
unos 12 MB. Máximo `MCP_UPLOAD_MAX_BYTES` (95 MB): Cloudflare corta las peticiones de más de
100 MB en los planes Free y Pro; lo que pase de ahí se sube desde la app. El alta se deshace desde la app como los cambios de biblioteca. La portada la saca la
app la primera vez que abre el libro. Código en `src/upload-tools.mjs` y
`workers/sync/src/upload.js`.

Borrar libros pide su propio permiso («Borrar libros»), desmarcado al crear el token. Hace lo
mismo que «Borrar» en la app: deja la ficha de `library.json` como tombstone. Cada dispositivo,
al bajarlo, suelta su copia, y el primero borra el fichero del sync. `books/<id>.json`
(subrayados, notas, mazos) no se toca: el bookId es el hash del fichero, así que si se vuelve a
subir el mismo libro, vuelve todo. El deshacer guarda la ficha entera y la app la repone. El
fichero solo vuelve si sigue en el sync: si un dispositivo ya sincronizó y lo borró, el libro
vuelve a la biblioteca sin fichero y hay que subirlo otra vez.

Los artefactos se CREAN siempre (el Studio guarda el historial de cada tipo): mejorar un mapa
es crear otro y borrar el viejo si sobra. Pasan por los mismos techos que los que genera la app
(`app/js/ai/artifact-schema.js`, compartido), y sus citas (`src`) solo se guardan si existen en
el texto del libro; las demás se quitan y se cuentan (`citationsDropped`).

Todas las de escritura aceptan `dry_run: true` (el antes y el después, sin escribir). Escriben
como un dispositivo más: leen el fichero del libro con su etag, lo cambian, lo cifran y lo
guardan solo si nadie escribió entre medias (si alguien lo hizo, se relee y se reaplica); la
versión anterior queda en el historial de la app. Cada tarjeta tocada lleva `editedBy`
(«agent:<nombre del token>»). Texto y repaso se funden por separado en los dispositivos
(`textAt`/`srsAt`, app/js/ai/db.js · mergeCardPair): reescribir una tarjeta mientras el móvil la
repasa sin conexión no pierde ninguna de las dos cosas.

El texto de los libros lo sube la app solo si algún agente tiene ese permiso, y solo de los
libros que ya ha troceado (al usar en ellos el agente, la búsqueda o el estudio). Formato en
`app/js/sync/book-text-build.js`: pensado para que ninguna tool lea el libro entero (el Worker
tiene muy poco tiempo de CPU por petición).

Los resultados van como JSON en el contenido de la tool. Los errores esperables (libro
o mazo desconocido, argumento que falta, rango que no existe) se devuelven como resultado con
`isError` y un mensaje que el modelo puede leer y corregir: la sesión no se cae.

Mazos y artefactos **exigen la fuente viva** (`--dir` o Drive): los lleva cada `books/<id>.json`
del layout de sync, y el backup de la app no los exporta. Con `--backup` esas cuatro tools ni
siquiera se anuncian — mismo criterio que `reading_stats`.

### `reading_stats`, en detalle

- **Qué cuenta**: la app no mide «tiempo con el libro abierto», mide **palabras a ritmo plausible**
  (`app/js/reading-log.js`). Los saltos, el café y el barrido rápido no suman.
- **Ventanas**: `today`, `7d`, `30d`, `90d`, `365d`, `all` (por defecto `7d`).
- **Agrupación**: `day`, `week` (semana ISO), `month`. Escope opcional por `bookId`.
- **Suma entre dispositivos**: el registro son filas por día y dispositivo, y leerlas es sumar (el
  martes leído en el PC y en la tableta son dos filas). **No hay desglose por dispositivo** a
  propósito: sería publicar el `deviceId`.
- `daysRead` cuenta días distintos con actividad en la ventana, no días naturales.

## Registrarlo

### Claude Desktop

En `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`; Windows:
`%APPDATA%\Claude\`; Linux: `~/.config/Claude/`):

```json
{
  "mcpServers": {
    "bookreader": {
      "command": "node",
      "args": ["/ruta/absoluta/bookreader/mcp/server.mjs", "--backup", "/ruta/absoluta/backup.json"]
    }
  }
}
```

Reinicia Claude Desktop. Si la ruta del backup cambia, mejor exporta `BOOKREADER_MCP_BACKUP` y deja
el `args` sin ella. Para la fuente viva, cambia los argumentos por
`["--dir", "/ruta/al/layout"]` (o `["--refresh-token-file", "/ruta/refresh-token"]`).

### Claude Code

```bash
claude mcp add bookreader -- node /ruta/absoluta/bookreader/mcp/server.mjs --backup /ruta/absoluta/backup.json
claude mcp add --scope user bookreader -- node ...   # para todos tus proyectos
```

O un `.mcp.json` en la raíz del proyecto, con la misma forma que el de Claude Desktop.

### pi

**Esta versión de pi (0.87.1) no trae cliente MCP**: no hay `mcpServers` en su configuración, así
que no hay dónde registrarlo. La vía que sí funciona hoy es el CLI, que un agente con shell puede
ejecutar:

```bash
node mcp/cli.mjs --backup /ruta/backup.json list_books
node mcp/cli.mjs --backup /ruta/backup.json search_highlights '{"query":"consenso"}'
node mcp/cli.mjs --dir /ruta/layout reading_stats '{"range":"30d","groupBy":"week"}'
```

Si tu pi incorpora cliente MCP, este servidor se registra como cualquier otro de stdio (el
`command`/`args` de arriba).

## La fuente de Drive (F2)

### Qué se puede probar hoy, sin credenciales

Tres proveedores detrás de la misma interfaz (`{ read(path) }`):

| Proveedor | Cuándo se usa | Qué demuestra |
| --- | --- | --- |
| `google-drive` | `--source drive` con refresh token | El camino de verdad: `appDataFolder`, misma API REST que la app, versiones como etags, reintento único tras un 401. |
| `fs` | `--dir <carpeta>` | El layout completo (manifest + settings + libros) leído de disco, sin red. |
| `memory` | Solo tests | La misma fuente sin tocar el disco. |

El de disco es la vía para probar F2 **ahora**: copia la carpeta `bookreader/` de tu
`appDataFolder` (o exporta el layout con las DevTools) y apunta el MCP ahí:

```bash
node mcp/server.mjs --dir ~/bookreader-layout
```

### Lo que falta para probarlo contra Drive de verdad

1. **Un refresh token.** Se obtiene conectando el sync en la app (Ajustes → Datos → Google Drive) y
   copiando `bookreader_drive_refresh_token` de su localStorage (DevTools → Application), o
   dejando la app conectada y exportándolo a un fichero con permisos solo para ti:
   `--refresh-token-file ~/.bookreader/refresh-token` (chmod 600).
2. **OAuth interactivo desde el MCP: no está, a propósito.** El flujo que abriría el navegador
   necesita un `redirect_uri` registrado en el cliente OAuth de Google. El de la app es
   `auth/callback.html` de su propio origen, así que un redirect a `http://localhost:<puerto>` daría
   `redirect_uri_mismatch`. Implementarlo «de mentira» habría sido peor que no tenerlo: para
   hacerlo de verdad hay que registrar un redirect propio (otro cliente OAuth) o añadir el canje en
   el Worker `workers/auth`. **No se ha ejecutado ni una llamada real contra la API de Drive**: el
   doble de `fetch` de los tests reproduce la forma de la API, no su comportamiento exacto.
3. **Nada de esto escribe.** F3 (crear nota, crear tarjeta) queda fuera de P28: el merge del sync
   fusiona por unión y exige `uid`, y un registro sin él deja el digest distinto en los dos
   dispositivos → push en bucle. Si algún día se hace, el MCP reutiliza las funciones de creación
   de la app, no compone JSON a mano.

### El token, en claro

El refresh token se manda al **mismo Worker de Cloudflare que usa la app**
(`bookreader-auth.luisgonzalezb93.workers.dev`, ver `app/js/sync/drive-auth.js`), que es quien
custodia el `client_secret` y devuelve un access token. No hay un segundo servidor de confianza ni
un segundo cliente OAuth: es el camino que ya existe. El token no se escribe en ningún log.

## El MCP remoto (sin instalar nada)

Con el sync de BookReader, el MCP también se sirve desde el Worker del sync:
`https://bookreader-sync.luisgonzalezb93.workers.dev/mcp` (MCP por HTTP). Mismas tools.

1. En la app: Ajustes → Datos → **Agentes (MCP)** → **Conectar un agente**. Le das un nombre y
   te enseña un token `br-mcp-…` **una sola vez**, con el comando de Claude Code ya hecho:

   ```bash
   claude mcp add --transport http bookreader https://bookreader-sync.luisgonzalezb93.workers.dev/mcp \
     --header "Authorization: Bearer br-mcp-…"
   ```

2. Para agentes sin cliente MCP (pi, en Hermes), la terminal:

   ```bash
   export BOOKREADER_MCP_TOKEN=br-mcp-…      # o --token-file <fichero de modo 600>
   node mcp/cli.mjs --remote tools
   node mcp/cli.mjs --remote search_highlights '{"query":"consenso"}'
   ```

**Qué ve el servidor.** Para responder, el Worker necesita la clave del sync: la app se la manda
al crear el token y él la guarda cifrada con una clave que se deriva del propio token (del token
solo guarda el hash). Sin el token no se puede descifrar; con él, el Worker descifra lo que pide
el agente mientras dura cada consulta. Es menos privado que el MCP local de abajo, a cambio de no
instalar nada. Cada token se revoca en la app al momento; caduca a los 90 días; «Empezar de cero»
los anula todos. La licencia se revalida cada día.


Para quien sincroniza con BookReader en vez de con Drive (MON4). El servidor del sync no ve nada en
claro, así que el MCP hace lo mismo que un dispositivo emparejado: pide un token con tu **licencia**
y descifra en local con la **clave** del sync. Las dos van en el enlace de emparejamiento.

1. En la app: Ajustes → Datos → **Enlace para otro dispositivo** (se copia al portapapeles).
2. Guárdalo en un fichero que solo puedas leer tú. El MCP **se niega a arrancar** si el fichero lo
   pueden leer otros usuarios de la máquina:

   ```bash
   mkdir -p ~/.config/bookreader && umask 077
   read -rs -p 'Enlace: ' L && printf %s "$L" > ~/.config/bookreader/sync-pair; unset L; echo
   ```

3. Regístralo:

   ```bash
   claude mcp add --scope user bookreader -- node /ruta/absoluta/bookreader/mcp/server.mjs \
     --pair-file ~/.config/bookreader/sync-pair
   ```

Ese fichero da acceso de lectura a **todo** tu sync: trátalo como una contraseña. Si se filtra, en la
app → **Empezar de cero** cambia la clave (y el enlace viejo deja de servir).

El cifrado no se replica: el MCP importa `app/js/sync/sync-crypto.js`, el mismo módulo que usa la
app. Habla solo con el Worker del sync (`bookreader-sync.luisgonzalezb93.workers.dev`), sin
cabecera `Origin`: el Worker la exige a los navegadores, no a los programas del usuario.

## Opciones

```
--backup <fichero.json>    fuente F1: el backup de la app
--dir <carpeta>            fuente F2 con proveedor local: carpeta con el layout de sync
--source <backup-file|drive|bookreader>
--base <prefijo>           prefijo del layout en el proveedor (por defecto `bookreader/`)
--cache-ms <n>             TTL de la caché del proveedor (por defecto 15000; 0 la desactiva)
--access-token <token>     access token de Google para una prueba de una hora
--refresh-token-file <p>   fichero con el refresh token de la app
--pair-file <p>            fuente bookreader: fichero (modo 600) con el enlace de emparejamiento
--help, --version
```

Entorno: `BOOKREADER_MCP_BACKUP`, `BOOKREADER_MCP_DIR`, `BOOKREADER_MCP_BASE`,
`BOOKREADER_MCP_CACHE_MS`, `BOOKREADER_DRIVE_REFRESH_TOKEN`, `BOOKREADER_DRIVE_REFRESH_TOKEN_FILE`,
`BOOKREADER_DRIVE_ACCESS_TOKEN`, `BOOKREADER_APP_ORIGIN`, `BOOKREADER_SYNC_PAIR_FILE`.

`BOOKREADER_APP_ORIGIN` es el `Origin` con el que el MCP llama al Worker de auth. **El Worker lo
exige** (mira su `ALLOWED_ORIGINS`), y un navegador lo pone solo pero Node no: sin él responde
`403 Forbidden` antes de llegar a Google. Por defecto es `https://bookreader.raiatech.com`; para
desarrollo en local, `BOOKREADER_APP_ORIGIN=http://localhost:8000`.

## Tests

```bash
cd mcp && npm test      # o, desde la raíz del repo: npm run test:mcp
```

`node --test`, sin navegador y sin red: 106 tests. La fuente del sync de BookReader se prueba
contra el Worker de verdad (`workers/sync/src`, sobre el arnés de sus tests) con datos cifrados como
los cifra la app, y tiene que devolver lo mismo que el layout en claro. Fixtures con la forma real de la app (backup y
layout), un cliente MCP de verdad hablando con el servidor como proceso hijo, un doble de la API de
Drive, un test de paridad entre las dos fuentes y las comprobaciones de que los secretos y el
`deviceId` no salen.

## Privacidad

- Los datos se leen del fichero o del Drive **del usuario**, en la máquina del usuario; no se
  copian a ningún sitio.
- En F1 el servidor no habla con la red: stdio y el fichero, nada más. En F2 solo habla con la API
  de Drive (para leer tus datos) y con el Worker del token (para renovar el permiso). Con el sync
  de BookReader, solo con su Worker, y lo que baja se descifra en tu máquina.
- Todo lo que devuelven las tools pasa por `src/redact.mjs` (ver la tabla de arriba).


## Por título

`get_highlights` y `get_notes` aceptan `book` (título o parte, sin tildes ni mayúsculas) en vez de
`bookId`: `node mcp/cli.mjs --backup backup.json get_highlights '{"book":"pedro paramo"}'`. Si casa
con varios libros, el error trae los candidatos con su id.
