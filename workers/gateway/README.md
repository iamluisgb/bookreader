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

## Demo self-service (F3)

`POST /demo-token` emite un token de `DEMO_QUOTA` llamadas (30). Guardas: 1 demo por IP
(hasheada con `IP_HASH_SALT`) y día → 429 `demo_already_granted`; tope de emisión diaria
`MAX_DAILY_TOKENS` → 429 `demo_sold_out`; tope de llamadas demo/día `MAX_DAILY_CALLS` →
403 `demo_paused` en el chat. Los topes son vars de `wrangler.jsonc`. Consumo del día:

```bash
npx wrangler d1 execute bookreader-gateway --remote --command \
  "SELECT * FROM daily_stats ORDER BY day DESC LIMIT 7"
```

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

Los helpers de límites son puros y se prueban sin Worker ni D1:

```bash
npm run test:gateway     # node --test · allowlist, medición de entrada, buckets de IP
```

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
