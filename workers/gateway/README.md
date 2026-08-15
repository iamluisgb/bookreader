# bookreader-gateway (MON1)

Proxy OpenAI-compatible con tokens propios sobre nan. Ver `BACKLOG.md` (MON1) y
`DECISIONS.md` ADR-021. Desplegado en:

    https://bookreader-gateway.luisgonzalezb93.workers.dev

La app lo usa **sin cambios de código**: Ajustes → Agente → Base URL
`https://bookreader-gateway.luisgonzalezb93.workers.dev/v1`, API key = token `br-…`,
modelo `bookreader-fast` (o «Descubrir», que lista los alias vía `/v1/models`).

## Operación (desde este directorio)

```bash
# Desplegar cambios
npx wrangler deploy

# Secret del proveedor (una vez, o al rotar la key)
npx wrangler secret put NAN_API_KEY

# Emitir un token demo de 100 llamadas
npx wrangler d1 execute bookreader-gateway --remote --command \
  "INSERT INTO tokens (token, remaining, note) VALUES ('br-demo-$(openssl rand -hex 8)', 100, 'motivo')"

# Ver tokens y consumo
npx wrangler d1 execute bookreader-gateway --remote --command \
  "SELECT token, remaining, active, tier, note, created FROM tokens ORDER BY created DESC"

# Revocar / reactivar
npx wrangler d1 execute bookreader-gateway --remote --command \
  "UPDATE tokens SET active = 0 WHERE token = 'br-…'"

# Logs en vivo (observability activada; nunca loguea prompts)
npx wrangler tail
```

## Cuánto cuesta la demo (F1.2)

El gateway contaba llamadas pero no lo que cuesta una. Ahora `daily_stats` acumula
tokens por día — **contadores agregados, nunca contenido**: la retención cero sigue
intacta. Dos series a propósito:

- `est_input_tokens` — la estimación del propio gateway (~4 chars/token), en **todas**
  las llamadas.
- `real_input_tokens` / `real_output_tokens` / `measured_calls` — el `usage` que
  devuelve el proveedor. Solo llega en las llamadas **no streaming** (tools y visión):
  el stream se reenvía sin parsear (ADR-021 §5).
- `est_input_measured` — la estimación **de esas mismas llamadas medidas**. Es el único
  término comparable con `real_input_tokens`: dividir por `est_input_tokens` mediría el
  mix streaming/no-streaming, no el error de la estimación.

```bash
# Coste por llamada y desviación de la estimación (últimos 7 días)
npx wrangler d1 execute bookreader-gateway --remote --command \
  "SELECT day, calls, demo_calls,
          real_input_tokens / NULLIF(measured_calls,0)  AS in_por_llamada,
          real_output_tokens / NULLIF(measured_calls,0) AS out_por_llamada,
          ROUND(1.0 * est_input_measured / NULLIF(real_input_tokens,0), 2) AS factor_estimacion,
          ROUND(1.0 * est_input_tokens / NULLIF(measured_calls,0) * calls, 0) AS entrada_total_estimada
   FROM daily_stats ORDER BY day DESC LIMIT 7"
```

`factor_estimacion` > 1 significa que sobreestimamos la entrada (los techos de `LIMITS`
son entonces más conservadores de lo que parecen); se usa para convertir
`est_input_tokens` en tokens reales y así estimar el gasto **del total**, incluidas las
llamadas en streaming que nunca se miden. Con una semana de datos, `DEMO_QUOTA` y
`MAX_DAILY_CALLS` dejan de ser números inventados.

> Ojo al leer los primeros días: con pocas llamadas medidas el factor baila mucho.
> Fíate cuando `measured_calls` pase de unas decenas.

## Demo self-service (F3)

`POST /demo-token` emite un token de `DEMO_QUOTA` llamadas (30). Guardas: 1 demo por IP
(hasheada con `IP_HASH_SALT`), día **y producto** → 429 `demo_already_granted`; tope de
emisión diaria `MAX_DAILY_TOKENS` → 429 `demo_sold_out`; tope de llamadas demo/día
`MAX_DAILY_CALLS` → 403 `demo_paused` en el chat. Los topes son vars de `wrangler.jsonc`.
Las concesiones de más de 30 días se barren al emitir (el límite es por día: guardarlas
no sirve de nada).

## Dos productos (F4)

El gateway sirve a **bookreader** y a **arete**. Cada token nace con su `product` y solo
puede usar los alias de ese producto (`bookreader-*` / `arete-*`); pedirlos cruzados es
`400 model_not_found` y **no** gasta cuota. Sin esa atadura, el desglose de consumo sería
decorativo: cualquiera podría gastar por la puerta de la otra app.

```bash
# Pedir un token para arete (sin `product` → bookreader, por los clientes ya desplegados)
curl -X POST https://bookreader-gateway.luisgonzalezb93.workers.dev/demo-token \
  -H 'Content-Type: application/json' -d '{"product":"arete"}'
```

Los disyuntores diarios siguen siendo **uno solo** (`daily_stats`): acotan el gasto que
se paga, que no se reparte por app. El desglose vive aparte, en `product_stats`:

```bash
# Quién consume qué (últimos días)
npx wrangler d1 execute bookreader-gateway --remote --command \
  "SELECT day, product, tokens_issued, demo_calls, calls,
          real_input_tokens / NULLIF(measured_calls,0) AS in_por_llamada
   FROM product_stats ORDER BY day DESC, product LIMIT 14"

# Total del día (el que miran los disyuntores)
npx wrangler d1 execute bookreader-gateway --remote --command \
  "SELECT * FROM daily_stats ORDER BY day DESC LIMIT 7"
```

Añadir un producto = una entrada en `PRODUCTS`, sus filas en `ROUTING` y su origen en
`ALLOWED_ORIGINS`. Nada más: la emisión, la validación y el desglose salen de ahí.

## Límites de entrada (anti-abuso)

`MAX_TOKENS_CAP` solo acota la **salida**. Sin techos de entrada, una llamada puede
llevar megas de mensajes y sigue contando **1** contra la cuota y contra
`MAX_DAILY_CALLS` — los disyuntores diarios dejarían de acotar el gasto real. Por eso
`handleChat` mide antes de enrutar:

| Límite | Valor | Rechazo |
|---|---|---|
| Tamaño del body | 1 MB | `413 request_too_large` |
| Contexto de texto | 90 000 tokens (~4 chars/token) | `413 context_too_large` |
| Imágenes por petición | 2 | `400 too_many_images` |

Los tres rechazan **antes** del decremento: una petición inválida no gasta cuota. El
peor caso legítimo (visión: captura de 1024px + texto de página) ronda 500 KB, y el
cliente presupuesta 60K tokens de libro por turno (`context.js`), así que hay margen.

Además, al proveedor solo se reenvían los parámetros de `PASSTHROUGH`
(**allowlist**, no `...body`): campos como `n` o `best_of` multiplican el coste de una
llamada que la cuota sigue contando como una.

Y si el upstream devuelve **5xx**, la llamada se **devuelve a la cuota**: el fallo del
proveedor (o una colisión de concurrencia sobre la key compartida, ADR-021 §6) no lo
paga el usuario de la demo.

## Test

```bash
npm run test:gateway     # node --test
```

Dos familias: los helpers de límites son puros (allowlist, medición de entrada, buckets
de IP), y `products.test.mjs` conduce el Worker entero contra **SQLite real**
(`node:sqlite` con estas mismas migraciones) para lo que no es puro: emisión por
producto, alias cruzados, cuota y desglose. Un doble de D1 a mano tendría que fingir
`RETURNING`, `ON CONFLICT` y `date('now')`, que es donde vive la atomicidad que importa.

`tests/gateway.spec.ts` (@live) conduce la app real contra el gateway. Necesita
`GW_TOKEN=br-…` en `.env`:

```bash
npm run test:ai -- tests/gateway.spec.ts
```

Para el humo local completo (sin gastar llamadas reales), `NAN_BASE_URL` apunta el
proveedor a un mock:

```bash
npx wrangler d1 migrations apply bookreader-gateway --local
npx wrangler dev --local --var NAN_BASE_URL:http://localhost:8798
```

## Diseño (resumen; el porqué completo en ADR-021)

- **Alias, no modelos del proveedor**: `bookreader-fast` → `deepseek-v4-flash`,
  `bookreader-vision` → `mimo-v2.5` (tabla `ROUTING` en `src/index.js`). Cambiar de
  proveedor = cambiar una fila; nadie reconfigura.
- **Decremento atómico** en D1 (`UPDATE … WHERE remaining > 0 RETURNING`), cabecera
  `X-Quota-Remaining` en cada respuesta.
- **Demo agotada → 403** (no 429: el cliente reintenta los 429 con backoff y aquí no ayuda).
- **Retención cero**: los prompts atraviesan el Worker en streaming y no se registran.
- **Todo límite cuenta llamadas, así que una llamada debe tener coste acotado**: de ahí
  los techos de entrada + la allowlist de parámetros (ver arriba). Sin eso, "2000
  llamadas/día" no es un presupuesto.
- **1 demo por red y día, no por IP**: `ipBucket()` agrupa en /64 (IPv6) y /24 (IPv4)
  antes de hashear. Con la IP exacta, rotar dentro de la propia /64 daba tokens sin
  límite hasta vaciar `MAX_DAILY_TOKENS` para todos.
- Riesgo F1 aceptado: una sola key de nan compartida (colisiones de concurrencia las
  absorben los reintentos del cliente); pool de keys o cola → F2 si la medición lo pide.
