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

## Test end-to-end

`tests/gateway.spec.ts` (@live) conduce la app real contra el gateway. Necesita
`GW_TOKEN=br-…` en `.env`:

```bash
npm run test:ai -- tests/gateway.spec.ts
```

## Diseño (resumen; el porqué completo en ADR-021)

- **Alias, no modelos del proveedor**: `bookreader-fast` → `deepseek-v4-flash`,
  `bookreader-vision` → `mimo-v2.5` (tabla `ROUTING` en `src/index.js`). Cambiar de
  proveedor = cambiar una fila; nadie reconfigura.
- **Decremento atómico** en D1 (`UPDATE … WHERE remaining > 0 RETURNING`), cabecera
  `X-Quota-Remaining` en cada respuesta.
- **Demo agotada → 403** (no 429: el cliente reintenta los 429 con backoff y aquí no ayuda).
- **Retención cero**: los prompts atraviesan el Worker en streaming y no se registran.
- Riesgo F1 aceptado: una sola key de nan compartida (colisiones de concurrencia las
  absorben los reintentos del cliente); pool de keys o cola → F2 si la medición lo pide.
