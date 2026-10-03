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
- [`docs/EVALS.md`](docs/EVALS.md) — cómo se mide la calidad del agente, y el **contrato**
  (baseline + métrica + time-box) que todo ítem de calidad escribe antes de implementar.

## Estructura
- `index.html` — entry point (CSP, scripts vendorizados).
- `css/` — themes.css (tokens y temas, **única fuente**; también la cargan las páginas
  públicas), main.css (layout por pantalla), reader.css (iframe epub), temml.css (fórmulas),
  agent.css (panel del agente + ajustes, **carga perezosa**) y modern.css (capa de sistema:
  base tardía + patrones, va la ÚLTIMA). agent.css se inserta en el hueco `#css-slot-agent`,
  justo antes de modern.css, para no alterar la cascada (ver `js/css-loader.js`).
- `patterns.html` — biblioteca de patrones viva (uso interno, fuera del deploy).
- `js/` — orquestador (`app.js`) + módulos por responsabilidad:
  - lectura: `epub-reader.js`, `pdf-reader.js`, `pdf-axis-lock.js`, `touch-select.js`, `progress.js`
  - análisis: `reading-log.js` (cuenta solo la lectura a ritmo plausible; los saltos no suman)
    y `analysis.js` (la pantalla, carga perezosa desde la estantería)
  - sidebar: `bookmarks.js`/`bookmarks-ui.js`, `highlights.js`/`highlights-ui.js`, `settings.js`
  - agente IA: `js/ai/` (`panel.js`, `panel-template.js`, `llm.js`, `segment.js`, `db.js`,
    `templates.js`, `render.js`, `markdown.js`, `attenuation.js`)
  - sync: `js/sync/` (`engine.js` orquesta; `layout.js`/`merge.js` datos; `library-sync.js`
    biblioteca; `blobs.js` ficheros de libro; `drive-*.js` proveedor)
  - utilidades: `js/ui/` (`icons.js`, `escape.js`), `storage.js`
  - biblioteca: `js/library/` (`store.js` IndexedDB, `view.js` pantalla,
    `shelves.js` reglas/árbol/pertenencia — lógica pura, sin DOM ni IDB)
- `vendor/` — libs vendorizadas (jszip, epub.js, pdf.js + worker, temml, Mermaid recortado a
  secuencia/flujo/timeline para los diagramas del chat, ver ADR-052). **No se cargan en el
  arranque**: las pide `js/vendor-loader.js` al abrir un libro, y solo la del formato.
- `sw.js` — service worker (precache + stale-while-revalidate). `manifest.json` — PWA.

## Convenciones
- JS modules via `<script type="module">`. Funciones nombradas, no arrow anónimas en módulos públicos.
- CSS: **solo tokens** de `app/css/themes.css` (color, `--fs-*`, `--r-*`, `--z-*`, `--s-*`). Si
  falta un valor, se crea el token con un comentario de para qué es; nunca un valor a mano.
  Feedback con `--danger/--warning/--success`, no con el acento. Los temas solo redefinen
  tokens: nada de `[data-theme]` en componentes. `npm test` lo comprueba
  (`tests/css-vars.spec.ts`); si te frena, no relajes el test.
- Componentes: usa el patrón por su nombre de función (`.btn.btn--primary`,
  `.btn.btn--secondary`, `.segmented` > `.segmented-btn`). Mira primero `app/patterns.html`;
  si el patrón no existe, créalo en `modern.css` y añádelo ahí. Las clases de contexto
  (`.lib-upload`, `.dlg-ok`…) son ganchos de JS/tests, no para color ni estados.
  Principios y tokens: [`DESIGN.md`](DESIGN.md).
- Iconos: solo los de `js/ui/icons.js`, con tamaño por paso (`icon('x', { size: 'md' })`, nunca
  un número) y **un significado por icono** (tabla en DESIGN.md § Iconos). Sin emoji en la
  interfaz. `tests/icons.spec.ts` lo comprueba.
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
- `npm run smoke` — humo contra producción (fuera de `npm test`: necesita red). `deploy:pages`
  lo lanza solo al terminar, exigiendo que lo servido sea el commit recién desplegado.
  `SMOKE_URL=…` para apuntar a otro deploy.
- `npm test` — 19 E2E deterministas (Playwright, sin API). `npm run test:ai` — `@live` contra la API real (key en `.env`).
- `npm run perf` — arnés de rendimiento del lector ([`tests/perf.spec.ts`](tests/perf.spec.ts), `@perf`,
  fuera de `npm test`). Necesita las fixtures pesadas (`npm run eval:fixtures`); sin ellas se salta.
  Cada métrica tiene **presupuesto** y falla si se sale; la corrida se vuelca a `test-results/perf.json`.
  Correrlo **solo**: medir con la suite en paralelo no mide nada.
- `npm run eval` — calidad del agente (fuera de `npm test`: cuesta dinero y minutos). Puntúa
  y **falla si un presupuesto de [`evals/budgets.mjs`](evals/budgets.mjs) se rompe** — la valla
  contra regresiones de calidad, hermana de la de `npm run perf`. Antes de tocar prompts,
  retrieval o modelo, escribe el **contrato** del ítem (baseline medido, métrica primaria,
  time-box): [`docs/EVALS.md` § EV5](docs/EVALS.md).
- `npm run lint` (ESLint) · `npm run format` (Prettier).
- El test "export after highlight" depende de que el epub de prueba se llame `test.epub` (bookId `test`).
