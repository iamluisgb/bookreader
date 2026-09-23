# BookReader MCP — F1: leer tu biblioteca desde un agente externo

Un servidor **MCP local (stdio)** que lee los datos de BookReader y los pone a disposición de un
agente externo (Claude Desktop, Claude Code, cualquier cliente MCP). **Solo lectura**: aquí no se
crea ni se modifica nada.

No es una API pública ni expone tu biblioteca en la red: es un puente local en tu máquina, con tus
datos, bajo tu control. La app no se toca.

---

## La limitación, primero (F1)

En esta fase la fuente es **el fichero de backup** que exporta la app. Un backup es una **foto**, y
eso tiene tres consecuencias que conviene saber antes de probarlo:

1. **No hay estadísticas de lectura.** El registro de lectura vive en su propia IndexedDB
   (`app/js/reading-log.js`) y `buildBackup()` no lo incluye. Por eso la tool `reading_stats`
   **no se anuncia** en F1: una tool que siempre contesta «no hay datos» es peor que una tool que
   no existe, porque el modelo la llama.
2. **Puede no haber títulos.** El backup no lleva la biblioteca (está en IndexedDB), así que el
   título solo existe si el libro pasó por el agente. Si no, `list_books` devuelve `title: null` y
   el cliente usa el `id`.
3. **Lo que lees durante la sesión no aparece** hasta que vuelvas a exportar el backup.

Lo que sí trae: subrayados (con su nota al margen), marcadores, notas de libreta con su contexto de
conversación, y los metadatos del agente. La fuente **viva** (sin exportar a mano) llega en F2.

## Lo que este MCP nunca lee ni devuelve

Está en código, no en una costumbre: [`src/redact.mjs`](src/redact.mjs).

| Clave | Por qué |
| --- | --- |
| `ai_key` | Es tu API key (BYOK): un secreto que no sale del dispositivo. |
| `drive_refresh_token` | Es el permiso permanente sobre tu Drive. |
| `device_id` | No es inocuo: es la mitad de la clave con la que cada equipo escribe sus días de lectura. Si se clona, dos equipos escriben la misma fila y uno deja de contar. |
| `license`, `sync_state`, `sync_schema_migrated` | Ninguna tool las necesita; se vetan por conservadoras. |

`scrub()` las borra de cualquier estructura antes de proyectarla y `findForbidden()` lo comprueba en
los tests: [`test/redaction.test.mjs`](test/redaction.test.mjs) planta secretos en un backup y
verifica que ninguna tool los devuelve.

---

## Probarlo en 3 comandos

```bash
cd mcp && npm install
node cli.mjs --backup ~/Descargas/bookreader-backup-2026-09-23.json list_books
node server.mjs --backup ~/Descargas/bookreader-backup-2026-09-23.json   # servidor MCP por stdio
```

El backup se saca de la app: **Ajustes (⚙) → Datos → «Descargar backup (JSON)»**. El servidor
escribe su diagnóstico por **stderr** (stdout es el canal del protocolo, y ahí no se toca nada).

## Las tools de F1

| Tool | Argumentos | Qué devuelve |
| --- | --- | --- |
| `list_books` | — | Libros con contadores (subrayados, marcadores, notas, conversaciones), última actividad y posición. |
| `get_highlights` | `bookId`, `limit?`, `offset?` | Subrayados del libro con texto, nota, capítulo/página, color y CFI. |
| `get_notes` | `bookId`, `limit?`, `offset?` | Notas de libreta con `fieldKey`, etiqueta, objetivo y conversación de origen. |
| `search_highlights` | `query`, `bookId?`, `limit?` | Busca en el texto de los subrayados y en sus notas, sin distinguir mayúsculas ni acentos. Todos los términos deben aparecer (AND). |

Los resultados van como JSON en el contenido de la tool. Los errores esperables (libro
desconocido, argumento que falta) se devuelven como resultado con `isError`, con un mensaje que
el modelo puede leer y corregir: la sesión no se cae.

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

Reinicia Claude Desktop. Si el backup cambia de ruta, mejor usa la variable de entorno
`BOOKREADER_MCP_BACKUP` y deja el `args` sin la ruta.

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
node mcp/cli.mjs --backup /ruta/backup.json tools      # qué tools anuncia esta fuente
```

Si tu pi incorpora cliente MCP, este servidor se registra como cualquier otro de stdio (el
`command`/`args` de arriba).

## Opciones

```
--backup <fichero.json>    fuente F1: el backup de la app
--dir <carpeta>            fuente F2: una carpeta con el layout de sync (llegará con F2)
--source <backup-file|drive>
--base <prefijo>           prefijo del layout en el proveedor (por defecto `bookreader/`)
--cache-ms <n>             TTL de la caché del proveedor (por defecto 15000; 0 la desactiva)
--help, --version
```

Entorno: `BOOKREADER_MCP_BACKUP`, `BOOKREADER_MCP_DIR`, `BOOKREADER_MCP_BASE`,
`BOOKREADER_MCP_CACHE_MS`.

## Tests

```bash
cd mcp && npm test      # o, desde la raíz del repo: npm run test:mcp
```

`node --test`, sin navegador: fixtures con la forma real de la app, un cliente MCP de verdad
hablando con el servidor como proceso hijo, y comprobaciones de que los secretos no salen.

## Privacidad

- El backup se lee del disco cada vez que arrancas el servidor; no se copia a ningún sitio.
- El servidor no abre puertos ni habla con la red en F1: stdio y el fichero, nada más.
- Todo lo que devuelven las tools está filtrado por `src/redact.mjs` (ver la tabla de arriba).
