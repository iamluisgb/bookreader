# AGENTS.md — BookReader

Lector web de EPUB/PDF desplegado en Cloudflare Pages. 100% frontend, sin build step. PWA
offline con un agente de IA (BYOK) que lee el libro completo según un objetivo.

## Stack
- Vanilla JS (ES6 modules, sin framework, sin build)
- epub.js v0.3.93 y pdf.js v3.11.174 — **vendorizados** en `vendor/` (no CDN)
- CSS Variables para themes · localStorage (config/subrayados) + IndexedDB (datos del agente)

## Documentación
- [`BACKLOG.md`](BACKLOG.md) — lo pendiente (única fuente).
- [`CHANGELOG.md`](CHANGELOG.md) — lo entregado (histórico).
- [`DECISIONS.md`](DECISIONS.md) — decisiones de arquitectura del agente IA (ADR: el _porqué_).
- [`DESIGN.md`](DESIGN.md) — lenguaje visual (principios + tokens).
- [`templates.md`](templates.md) — spec de las 6 plantillas de libreta.

## Estructura
- `index.html` — entry point (CSP, scripts vendorizados).
- `css/` — main.css (layout), reader.css (iframe epub), themes.css (tokens/temas).
- `js/` — orquestador (`app.js`) + módulos por responsabilidad:
  - lectura: `epub-reader.js`, `pdf-reader.js`, `touch-select.js`, `progress.js`
  - sidebar: `bookmarks.js`/`bookmarks-ui.js`, `highlights.js`/`highlights-ui.js`, `settings.js`
  - agente IA: `js/ai/` (`panel.js`, `panel-template.js`, `llm.js`, `segment.js`, `db.js`,
    `templates.js`, `render.js`, `markdown.js`, `attenuation.js`)
  - sync: `js/sync/` (`engine.js` orquesta; `layout.js`/`merge.js` datos; `library-sync.js`
    biblioteca; `blobs.js` ficheros de libro; `drive-*.js` proveedor)
  - utilidades: `js/ui/` (`icons.js`, `escape.js`), `storage.js`
  - biblioteca: `js/library/` (`store.js` IndexedDB, `view.js` pantalla,
    `shelves.js` reglas/árbol/pertenencia — lógica pura, sin DOM ni IDB)
- `vendor/` — libs vendorizadas (jszip, epub.js, pdf.js + worker).
- `sw.js` — service worker (precache + stale-while-revalidate). `manifest.json` — PWA.

## Convenciones
- JS modules via `<script type="module">`. Funciones nombradas, no arrow anónimas en módulos públicos.
- CSS: variables en `:root`, themes con `[data-theme="sepia"]` etc.
- Config/subrayados en localStorage con prefijo `bookreader_`; datos del agente en IndexedDB.
- No agregar dependencias sin justificación. Las libs core están vendorizadas (mismo origen → CSP estricta).
- Escapar SIEMPRE con `js/ui/escape.js` al construir HTML con datos.

## Desarrollo
- Servir en local: `python3 -m http.server` y abrir `index.html`. No hay build de la app.
- **Deploy** (Cloudflare Pages): `npm run deploy:pages`. El build sale de **HEAD**, no del
  árbol de trabajo — lo que tengas sin commitear no se despliega, y avisa de ello. Rechaza
  un HEAD que no esté en `origin/main` (escape: `DEPLOY_ALLOW_UNPUSHED=1`). El commit
  desplegado queda en `dist/build.json`, servido como `/build.json`.
- `npm run build:preview` construye desde el árbol de trabajo, solo para previsualizar.
- `npm test` — 19 E2E deterministas (Playwright, sin API). `npm run test:ai` — `@live` contra la API real (key en `.env`).
- `npm run lint` (ESLint) · `npm run format` (Prettier).
- El test "export after highlight" depende de que el epub de prueba se llame `test.epub` (bookId `test`).
