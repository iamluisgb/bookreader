# Auditoría de seguridad — BookReader

**Fecha:** 2026-10-05 · **Método:** workflow `python-web-security` (escáner + lectura dirigida + reproducción). Los patrones de framework Python no aplican; se usaron los frentes y criterios del catálogo.
**Alcance:** cliente PWA (`app/js`, `index.html`), Workers `auth` / `gateway` / `share`, servidor MCP local, build y deploy.
**Estado:** `npm audit` limpio (raíz y `mcp`); secretos limpios.

## Veredicto: REVISAR (nada crítico; 2 medios que conviene cerrar antes de crecer)

No hay un crítico explotable hoy. El hallazgo más importante (inyección en el render de markdown) está **mitigado por el CSP actual**, y por eso se reporta como Medio y no como Crítico: la ejecución de JS está bloqueada. Aun así es el fix #1, porque queda a una directiva de CSP de ser explotable.

### Threat model
App 100% frontend con contenido de usuario (libros EPUB/PDF de origen no confiable) que alimenta a un LLM; el atacante es quien controla ese contenido (prompt injection) o un tercero que consigue un enlace de compartición. Datos valiosos: `ai_key` (BYOK), `drive_refresh_token` (acceso duradero al Drive del usuario), y el contenido de los libros. Los Workers tienen su propia superficie (tokens `br-…`, cuotas, R2/D1).

---

## Hallazgos

| # | Severidad | Área | Hallazgo | Evidencia | Fix |
|---|-----------|------|----------|-----------|-----|
| 1 | **Medio** (latente XSS) | Cliente / salida | `esc()` en `markdown.js` no escapa comillas; la URL de un enlace `[x](url)` inyecta atributos en `<a href="…">`. **CONFIRMADO** | `mdToHtml('…[e](https://evil/"onmouseover="alert\`document.domain\`)')` → `<a href="https://evil/"onmouseover="alert\`document.domain\`" target="_blank" …>` | Escapar `"` y `'` en `esc()` (o usar `escapeHtml`); encodear la URL (`encodeURI`) antes de meterla en `href` |
| 2 | **Medio** | Cliente / headers | Faltan headers de seguridad: sin `frame-ancestors`/`X-Frame-Options` (clickjacking), sin `X-Content-Type-Options: nosniff`, sin `Referrer-Policy`. El CSP va por `<meta>`, que no puede expresar `frame-ancestors`. HSTS a confirmar en Cloudflare | `dist/_headers` solo define `Cache-Control`; `index.html` no trae esos meta | Añadir a `dist/_headers` (o `_headers` de Pages): `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Content-Security-Policy` con `frame-ancestors 'none'`, HSTS |
| 3 | **Medio** | Cliente / sesión | Tokens de larga vida en `localStorage`: `drive_refresh_token` (acceso duradero a Drive) y `ai_key` (BYOK). Cualquier XSS futuro los exfiltra. | `app/js/sync/drive-auth.js:22,119`, `app/js/ai/llm.js:101-102`; `SECRET_KEYS` en `backup.js:30` | Ya están excluidos de backup/sync (bien). Con el fix #1 y cookies `HttpOnly` no aplican (es token de terceros); valorar mover el refresh a un worker con cookie `HttpOnly`+`SameSite` si el modelo lo permite |
| 4 | Bajo | Gateway / CORS | `corsHeaders()` cae a `allowed[0] || '*'` en vez de omitir `Access-Control-Allow-Origin` para orígenes no permitidos. Si `ALLOWED_ORIGINS` quedara vacío → `*`. No hay cookies (auth por Bearer) → no hay robo credencial, pero es incoherente con `share`/`auth`, que sí omiten el header | `workers/gateway/src/index.js:720-731` | Para origen no permitido, no emitir `ACAO` (o `'null'`), nunca `allowed[0]`; quitar el fallback `|| '*'` |
| 5 | Bajo | Auth / OAuth | `redirect_uri` se reenvía a Google sin validarlo contra una allowlist propia. Google lo valida contra los registrados, así que el riesgo es bajo | `workers/auth/src/index.js:49` | Validar `redirect_uri` contra la lista de `auth/callback` conocidos antes de reenviar |
| 6 | Bajo | Workers | Comparaciones de tokens no constantes: `usage` (`auth !== Bearer …`) y `stats`/`remove` (hash con `!==`). Timing teórico | `share/src/index.js:152,171,215` | Comparación en tiempo constante para secretos (impacto real mínimo con hashes de 128 bits) |

### Detalle del hallazgo 1 (el importante)

- **Qué:** `mdToHtml` escapa primero con `esc()` —que solo cubre `& < >`— y después aplica el formato. La regla de enlaces captura la URL con `[^)\s]+` y la inserta directamente en un atributo: `<a href="$2" …>`. Una comilla `"` en la URL cierra el `href` e inyecta atributos arbitrarios (p. ej. `onmouseover`). La salida del LLM se pinta con este renderizador, y el LLM lee el contenido del libro → **prompt injection desde un EPUB/PDF hostil puede fabricar el enlace**.
- **Dónde:** `app/js/ai/markdown.js` (`esc`, `inline`), consumido por `app/js/ai/render.js:14`.
- **Repro (ejecutado con Node sobre la función real):**
  ```
  mdToHtml('Mira este [enlace](https://evil.example/"onmouseover="alert(document.domain))')
  → <p>Mira este <a href="https://evil.example/"onmouseover="alert(document.domain" target="_blank" rel="noopener">enlace</a>)</p>
  ```
- **Mitigación actual (por qué es Medio, no Crítico):** el CSP `script-src 'self' 'wasm-unsafe-eval'` **no** incluye `'unsafe-inline'`, así que los handlers inline y los `javascript:` quedan bloqueados por el navegador. Hoy el impacto directo es inyección de atributos / spoofing de UI, no ejecución. Si esa directiva se relaja (o un consumidor no-CSP renderiza el HTML), pasa a Alto/Crítico, y el `drive_refresh_token` del punto 3 queda expuesto.
- **Fix:** en `esc()` escapar también `"` y `'`; y tratar la URL como dato de atributo: `encodeURI` (o allowlist de esquema + encode). Es un cambio de dos líneas. Nota: contradice la convención del proyecto («escapar SIEMPRE con `escape.js`») — aquí `markdown.js` usa su propio `esc` más débil.

---

## Lo que está bien (verificado, no reworkear)

- **Secretos limpios.** `.env` nunca se commiteó (`git log -- .env` vacío); los valores reales no aparecen en el historial (solo los nombres de variables); `dist/` no contiene claves; el build usa lista blanca explícita (`scripts/build-pages.mjs`, que comenta que copiar la raíz ya expuso `.env` una vez — corregido). `br-demo-000000000000` en tests es un placeholder.
- **CORS con allowlist** en `share` y `auth` (fail-closed: origen no permitido → 403 / sin ACAO).
- **Compartir por enlace bien pensado:** id de 128 bits, clave en el fragmento (`#`) que el navegador no envía, bytes cifrados que el Worker no puede leer, `deleteToken` hasheado, TTL + purga, topes de gasto de R2.
- **Gateway:** validación de token contra D1, allowlist de alias por producto, tope de `max_tokens` server-side, `PASSTHROUGH` con allowlist (no `...body`), límites de entrada, errores sin filtrar detalle, retención cero de prompts.
- **CSP estricta** en scripts (sin `'unsafe-inline'`), libs vendorizadas del mismo origen.
- **Mermaid `securityLevel: 'strict'`** (`app/js/ai/diagram.js:120`) — sin HTML ni `click` en diagramas.
- **Backup/sync excluyen secretos** (`SECRET_KEYS = ['ai_key','drive_refresh_token']`).
- **Dependencias** sin vulnerabilidades (`npm audit` raíz y `mcp`).

## A REVISAR / pendientes

- 2FA y alcance mínimo de la API key de nan y de las cuentas Cloudflare/Google (fuera del repo; no verificable aquí).
- HSTS: confirmar si Cloudflare lo añade a nivel de zona.
- Restore de backups de D1/R2 probado (no hay evidencia en el repo).
- Logs: el gateway promete retención cero; confirmar que observability no captura cuerpos.

## Definition of done — estado

| Item | Estado |
|---|---|
| Escáner corrido; secretos rotados | ✅ sin fugas (nada que rotar) |
| Autorización server-side en cada recurso | ✅ (share/gateway), salvo CORS #4 |
| Password/credenciales memory-hard | n/a (sin login propio; OAuth de terceros) |
| Rate limit | ✅ share (subidas/IP) + gateway (cuotas/disyuntores); auth sin rate limit propio |
| Salida escapada | ❌ markdown.js (#1) |
| CORS allowlist; headers; debug off | ⚠️ CORS ok salvo #4; headers ausentes (#2) |

**Conclusión:** app sorprendentemente bien construida para el problema que resuelve. Cerrar #1 (escapar comillas en el render de markdown) y #2 (headers) y el resto es deuda menor.
