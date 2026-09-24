# BookReader MCP — leer tu biblioteca desde un agente externo

Un servidor **MCP local (stdio)** que lee los datos de BookReader y los pone a disposición de un
agente externo (Claude Desktop, Claude Code, cualquier cliente MCP). **Solo lectura**: aquí no se
crea ni se modifica nada.

No es una API pública ni expone tu biblioteca en la red: es un puente local en tu máquina, con tus
datos, bajo tu control. No toca una línea de la app.

Dos fuentes, la misma superficie de tools:

| | **F1 · backup** | **F2 · layout de sync** |
| --- | --- | --- |
| De dónde lee | El JSON de «Descargar backup (JSON)» | `manifest.json`, `settings.json`, `books/<id>.json` |
| Credenciales | Ninguna | Refresh token de Google (o una carpeta copiada) |
| Datos | Foto del momento | Vivos |
| `reading_stats` | **No existe** (el backup no lleva el registro de lectura) | Sí |
| Títulos | Solo si el libro pasó por el agente (`title: null` si no) | Del manifest (que siempre tiene lo que importó) |

Prueba F1 primero: responde si el caso de uso aporta algo antes de pagar el peaje de Drive.

---

## F1 · la limitación, primero

La fuente de backup es una **foto**, y eso tiene consecuencias que conviene saber antes de probarla:

1. **No hay estadísticas de lectura.** El registro vive en su propia IndexedDB
   (`app/js/reading-log.js`) y `buildBackup()` no lo incluye. Por eso `reading_stats` **no se
   anuncia** con esta fuente: una tool que siempre contesta «no hay datos» es peor que una tool que
   no existe, porque el modelo la llama.
2. **Puede no haber títulos.** El backup no lleva la biblioteca (está en IndexedDB), así que el
   título solo existe si el libro pasó por el agente. Si no, `list_books` devuelve `title: null` y
   el cliente usa el `id`.
3. **Lo que lees durante la sesión no aparece** hasta que vuelvas a exportar el backup.

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
| `get_highlights` | `bookId`, `limit?`, `offset?` | Subrayados del libro con texto, nota, capítulo/página, color y CFI. |
| `get_notes` | `bookId`, `limit?`, `offset?` | Notas de libreta con `fieldKey`, etiqueta, objetivo y conversación de origen. |
| `search_highlights` | `query`, `bookId?`, `limit?` | Busca en el texto de los subrayados y en sus notas, sin distinguir mayúsculas ni acentos. Todos los términos deben aparecer (AND). |
| `reading_stats` | `range?`, `bookId?`, `groupBy?` | **Solo F2.** Minutos, palabras y unidades de lectura real, con desglose por día/semana/mes y por libro. |

Los resultados van como JSON en el contenido de la tool. Los errores esperables (libro
desconocido, argumento que falta, rango que no existe) se devuelven como resultado con `isError` y
un mensaje que el modelo puede leer y corregir: la sesión no se cae.

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

## Opciones

```
--backup <fichero.json>    fuente F1: el backup de la app
--dir <carpeta>            fuente F2 con proveedor local: carpeta con el layout de sync
--source <backup-file|drive>
--base <prefijo>           prefijo del layout en el proveedor (por defecto `bookreader/`)
--cache-ms <n>             TTL de la caché del proveedor (por defecto 15000; 0 la desactiva)
--access-token <token>     access token de Google para una prueba de una hora
--refresh-token-file <p>   fichero con el refresh token de la app
--help, --version
```

Entorno: `BOOKREADER_MCP_BACKUP`, `BOOKREADER_MCP_DIR`, `BOOKREADER_MCP_BASE`,
`BOOKREADER_MCP_CACHE_MS`, `BOOKREADER_DRIVE_REFRESH_TOKEN`, `BOOKREADER_DRIVE_REFRESH_TOKEN_FILE`,
`BOOKREADER_DRIVE_ACCESS_TOKEN`.

## Tests

```bash
cd mcp && npm test      # o, desde la raíz del repo: npm run test:mcp
```

`node --test`, sin navegador y sin red: 80 tests. Fixtures con la forma real de la app (backup y
layout), un cliente MCP de verdad hablando con el servidor como proceso hijo, un doble de la API de
Drive, un test de paridad entre las dos fuentes y las comprobaciones de que los secretos y el
`deviceId` no salen.

## Privacidad

- Los datos se leen del fichero o del Drive **del usuario**, en la máquina del usuario; no se
  copian a ningún sitio.
- En F1 el servidor no habla con la red: stdio y el fichero, nada más. En F2 solo habla con la API
  de Drive (para leer tus datos) y con el Worker del token (para renovar el permiso).
- Todo lo que devuelven las tools pasa por `src/redact.mjs` (ver la tabla de arriba).
