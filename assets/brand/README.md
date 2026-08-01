# Marca BookReader — logo v2 (libro + cinta)

Vectorización y assets derivados de `logo_bookreader.png` (raster 1536×1024, sin alpha).
**Nada de esto está enchufado todavía**: los iconos vivos siguen siendo `app/icons/*`.

## Archivos

| Archivo | Uso |
|---|---|
| `mark-dark.svg` | **Fuente principal.** Tile charcoal `#0e1116`→`#171b21`, página `#f8fafc`, cinta `#22c55e`. La variante que sobrevive a tamaño pequeño. |
| `mark-light.svg` | Fiel al original (tile gris claro). Solo marketing sobre fondo oscuro o neutro. |
| `maskable-dark.svg` / `maskable-light.svg` | Full-bleed, contenido al 78% (safe zone Android/iOS). Sin esquinas redondeadas: las pone el SO. |
| `favicon.ico` | Multi-size 16→256, desde la variante oscura. |
| `png/` | Rasterizados. `original-1536.png` es el archivo tal cual lo entregaste. |
| `rasterize.mjs` | Regenera los PNG con Chromium: `node assets/brand/rasterize.mjs`. |

`png/wordmark.png` y `png/lockup-vertical.png` son recortes del raster original con su
fondo horneado. **No son vectores**: para un lockup escalable hace falta identificar la
tipografía (grotesca geométrica, tipo Poppins/Montserrat/Gilroy) y trazar el texto.

## Decisiones tomadas al vectorizar

- **Tres tonos planos: fondo, página, cinta.** Fuera el degradado del tile, el panel de
  "página derecha" y la línea de lomo — metían dos tonos extra en el fondo y a tamaño
  pequeño se emborronaban. El mark ahora es plano y escala limpio.
- **La variante oscura es la recomendada para icono.** En el original el libro es gris
  claro sobre gris claro: a 32px desaparece y solo queda la cinta verde.
- **Verde alineado al token existente** (`#22c55e`) en vez del teal del PNG, para no
  romper `--accent` ni el `theme-color` de la landing.
- **Sombra y chaflán no horneados** en las variantes maskable: iOS/Android aplican su
  propia máscara y el squircle horneado produce esquinas dobles.

## Pendiente si se adopta

- `app/icons/icon.svg` y `icon-maskable.svg` (line-art página + prompt `>_`).
- Glyph `logo` en `app/js/ui/icons.js` — replica el mark actual.
- `app/manifest.json`: `background_color` / `theme_color`.
- `index.html`: `og:image` y `theme-color`.
- Tagline "Read. Understand. Remember." está en inglés; la app es `lang: es`.
