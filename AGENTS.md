# AGENTS.md — BookReader

Lector web de EPUB/PDF desplegable en GitHub Pages. 100% frontend, sin build step.

## Stack
- Vanilla JS (sin framework)
- epub.js v0.3.93 (CDN)
- pdfjs-dist v3.11.174 (CDN)
- CSS Variables para themes
- localStorage para persistencia

## Estructura
- `index.html` — entry point
- `css/` — main.css (layout), reader.css (reader styles), themes.css (colores)
- `js/` — módulos ES6 con import/export
- `sw.js` — service worker para offline
- `manifest.json` — PWA

## Convenciones
- JS modules via `<script type="module">`
- Funciones nombradas, no arrow functions anónimas en módulos públicos
- CSS: variables en `:root`, themes con `[data-theme="sepia"]` etc
- Todo se persiste en localStorage bajo prefijo `bookreader_`
- No agregar dependencias sin justificación
- epub.js y pdfjs-dist se cargan desde CDN (jsDelivr/unpkg)

## Desarrollo
- Abrir `index.html` directamente en navegador (o `python3 -m http.server`)
- No hay build step, deploy directo a GitHub Pages
- Probar con epub en `~/Downloads/`

## Backlog (futuro)

### Highlights
- [ ] Importar JSON de highlights (restaurar subrayados)
- [ ] Exportar bookmarks también en el JSON
- [ ] Exportar selección por color (solo amarillos, etc.)
- [ ] Copiar texto de un highlight al portapapeles

### PDF
- [ ] Text layer de pdf.js para hacer texto seleccionable
- [ ] Highlights en PDF (selección → tooltip → guardar)
- [ ] Navegación por páginas con teclado en PDF

### UX
- [ ] Búsqueda de texto en el libro
- [ ] Modo fullscreen
- [ ] Notas/comentarios en highlights
- [ ] Sync entre dispositivos (requiere backend)
