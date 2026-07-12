# Guía: cuenta de Cloudflare y Worker de refresh de tokens para el sync con Drive

> Objetivo: dejar lista la infraestructura (gratuita) que necesita la Fase 1 del sync
> (`SYNC_PLAN.md`): un **Cloudflare Worker stateless** que intercambia y renueva los
> tokens OAuth de Google Drive. El `client_secret` vive en el Worker; los datos del
> usuario van siempre cliente ↔ Drive directamente. Spec completa en `LAUNCH_PLAN.md`
> ("Especificación del Cloudflare Worker").

## Qué vamos a montar y por qué

Google solo entrega *refresh tokens* en el flujo authorization-code, y ese flujo exige
el `client_secret` tanto en el intercambio inicial como en cada renovación. Un secret
no puede vivir en un frontend público, así que necesitamos un servidor mínimo. El
Worker tiene exactamente dos endpoints:

- `POST /auth/exchange` — code del consentimiento → `{ access_token, refresh_token, expires_in }`
- `POST /auth/refresh` — refresh_token → access_token nuevo

Coste: **$0**. El plan gratuito de Workers da 100.000 requests/día, de sobra para
renovaciones de token (1 request por usuario por hora de uso, aprox.).

---

## Paso 1 — Crear la cuenta de Cloudflare

1. Ve a <https://dash.cloudflare.com/sign-up>.
2. Regístrate con email + contraseña (vale `luisgonzalezb93@gmail.com`; no hace falta
   Google SSO). **No pide tarjeta** para el plan Free.
3. Verifica el email (llega un correo "Verify your email address"; sin verificar no
   deja desplegar Workers).
4. Recomendado: activa 2FA en *My Profile → Authentication* (la cuenta va a custodiar
   el `client_secret` de Google).
5. **No necesitas añadir ningún dominio/sitio web.** Si el onboarding te empuja a
   "Add a site", sáltatelo: los Workers funcionan sin dominio propio, sobre
   `*.workers.dev`.

## Paso 2 — Activar Workers y reclamar el subdominio `workers.dev`

1. En el dashboard, menú lateral → **Compute (Workers)** → *Workers & Pages*.
2. La primera vez te pedirá **elegir tu subdominio** `<nombre>.workers.dev`. Es único
   por cuenta y aparece en las URLs públicas; elige algo neutro tipo `bookreader-sync`
   o `lgb-apps` (se puede cambiar después, pero rompe las URLs ya desplegadas).
3. Plan: deja **Free** (100k req/día, 10 ms CPU/request — el Worker de tokens usa ~1 ms).

## Paso 3 — Instalar wrangler y autenticarse

Desde `projects/bookreader/` (wrangler como devDependency, no global):

```bash
npm i -D wrangler
npx wrangler login     # abre el navegador → autoriza con la cuenta recién creada
npx wrangler whoami    # verifica: debe mostrar tu email y Account ID
```

Apunta el **Account ID** que muestra `whoami`; lo usaremos en `wrangler.toml`.

## Paso 4 — Prerrequisito Google: OAuth client (la otra mitad del token)

Sin esto el Worker no tiene nada que renovar. En <https://console.cloud.google.com>:

1. Crea un proyecto (p.ej. `bookreader-sync`).
2. **APIs & Services → Library** → habilita **Google Drive API**.
3. **APIs & Services → OAuth consent screen**:
   - Tipo **External**, nombre de la app, email de soporte.
   - Scope: `https://www.googleapis.com/auth/drive.appdata` (solo appDataFolder —
     scope no sensible, no requiere verificación de Google).
   - Mientras esté en modo *Testing*, añade tu email como test user. Ojo: en Testing
     los refresh tokens **caducan a los 7 días**; antes de lanzar hay que pasar la app
     a *In production* (con solo drive.appdata no exige auditoría).
4. **Credentials → Create credentials → OAuth client ID**:
   - Tipo **Web application**.
   - *Authorized JavaScript origins*: el dominio de la app (y `http://localhost:5173`
     o el puerto de dev que uses).
   - *Authorized redirect URIs*: la URL de la app que recibirá el `code`
     (p.ej. `https://<dominio-app>/auth/callback.html` y su equivalente localhost).
5. Guarda el **Client ID** (público, irá en el frontend y en el Worker) y el
   **Client Secret** (privado, irá SOLO como secret del Worker — jamás en el repo).

## Paso 5 — Crear el Worker

Estructura mínima (p.ej. `workers/auth/` dentro del repo):

```
workers/auth/
  wrangler.toml
  src/index.js
```

`wrangler.toml`:

```toml
name = "bookreader-auth"
main = "src/index.js"
compatibility_date = "2026-07-01"
account_id = "<ACCOUNT_ID del paso 3>"

[vars]
GOOGLE_CLIENT_ID = "<client_id>.apps.googleusercontent.com"
ALLOWED_ORIGIN = "https://<dominio-de-la-app>"
```

`src/index.js` (esqueleto conforme a la spec de `LAUNCH_PLAN.md`; ~50 líneas):

```js
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

async function google(params, env) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      ...params,
    }),
  });
  return new Response(res.body, { status: res.status, headers: cors(env) });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(env) });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (request.headers.get('Origin') !== env.ALLOWED_ORIGIN)
      return new Response('Forbidden', { status: 403 });

    const url = new URL(request.url);
    const body = await request.json().catch(() => ({}));

    if (url.pathname === '/auth/exchange' && body.code) {
      return google({
        grant_type: 'authorization_code',
        code: body.code,
        redirect_uri: body.redirect_uri,
        code_verifier: body.code_verifier, // PKCE
      }, env);
    }
    if (url.pathname === '/auth/refresh' && body.refresh_token) {
      return google({ grant_type: 'refresh_token', refresh_token: body.refresh_token }, env);
    }
    return new Response('Not found', { status: 404, headers: cors(env) });
  },
};
```

Notas de la spec que este esqueleto ya cumple:
- **No almacena nada**: sin KV, sin D1, sin logs de tokens. Solo baraja tokens de Google.
- **CORS restringido** al dominio de la app (variable `ALLOWED_ORIGIN`).
- **PKCE**: el frontend genera `code_verifier`/`code_challenge`; el Worker reenvía el
  verifier. La auth inicial en el cliente debe usar `access_type=offline` +
  `prompt=consent` para que Google entregue el refresh_token.

## Paso 6 — Guardar el secret y desplegar

```bash
cd workers/auth
npx wrangler secret put GOOGLE_CLIENT_SECRET   # pega el secret del paso 4 (no queda en el repo)
npx wrangler deploy
```

El deploy imprime la URL: `https://bookreader-auth.<subdominio>.workers.dev`.

## Paso 7 — Verificar

```bash
# CORS preflight: debe devolver los headers Access-Control-*
curl -si -X OPTIONS https://bookreader-auth.<subdominio>.workers.dev/auth/refresh \
  -H "Origin: https://<dominio-de-la-app>"

# Refresh con token falso: debe devolver 400 de Google (invalid_grant), NO un 500
curl -si -X POST https://bookreader-auth.<subdominio>.workers.dev/auth/refresh \
  -H "Origin: https://<dominio-de-la-app>" -H "Content-Type: application/json" \
  -d '{"refresh_token":"fake"}'

# Origin distinto: debe devolver 403
curl -si -X POST https://bookreader-auth.<subdominio>.workers.dev/auth/refresh \
  -H "Origin: https://evil.example" -H "Content-Type: application/json" -d '{}'
```

Prueba end-to-end real: desde la app, flujo completo consentimiento → `/auth/exchange`
→ guardar refresh_token en IndexedDB → forzar `/auth/refresh` → llamar a Drive con el
access_token nuevo.

## Checklist final

- [ ] Cuenta Cloudflare creada, email verificado, 2FA activado
- [ ] Subdominio `workers.dev` reclamado
- [ ] `wrangler login` + `whoami` OK
- [ ] OAuth client de Google creado (scope `drive.appdata`, redirect URIs correctos)
- [ ] `GOOGLE_CLIENT_SECRET` como secret del Worker (nunca en el repo)
- [ ] Worker desplegado y los 3 curls de verificación pasan
- [ ] Antes de lanzar: OAuth consent screen en *In production* (evita la caducidad
      de refresh tokens a 7 días del modo Testing)

## Sinergia futura

Este mismo Worker (o un segundo en la misma cuenta) sirve para la pivotada nº 2 del
`LAUNCH_PLAN.md`: el modo "N mensajes de IA gratis" con proxy de key propia. La cuenta
y el tooling que montas aquí se reutilizan tal cual.
