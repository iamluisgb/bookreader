# Tema accesible desde Ajustes generales

**Fecha**: 2026-10-05 · **Estado**: en curso

## Problema

El tema tiñe toda la app (`data-theme` en `<html>`, tokens de themes.css: estantería,
análisis, agente, ajustes, theme-color de la PWA), pero el único selector vive en
`#reading-pop` («Ajustes de lectura»), que solo existe con un libro abierto. Desde la
estantería no se puede cambiar.

## Decisión

- Añadir el selector de tema en **Ajustes generales → Aplicación**, junto al idioma
  (misma familia: apariencia global de la app).
- **Conservar** el acceso rápido en los ajustes de lectura: cambiar a noche leyendo es
  un gesto contextual. Ambos comparten la fuente de verdad (`settings.js`: `set()`
  persiste y `applySettings()` sincroniza todos los `.theme-btn` del documento).
- No mover fuente/ancho/papel/brillo/luz nocturna: sí son contextuales de la lectura.
- Esto enmienda la nota de cabecera de `app-settings.js` (el tema deja de ser
  exclusivamente "de lectura").

## Cambios

- `app/js/ui/app-settings.js` — bloque Tema en `appHtml()` (sección Aplicación),
  wiring en `wireApp()`, comentario de cabecera actualizado.
- `tests/theme-app-settings.spec.ts` — E2E: cambiar tema desde la estantería,
  persiste tras reload, swatch queda activo.
- `DECISIONS.md` — línea trazando la enmienda.

## Evidencia

- Commit `847e06e` — feat(ajustes): el tema también se cambia desde Ajustes generales → Aplicación.
- Test E2E en verde (`theme-app-settings.spec.ts`); suite completa: 830 pasan, 1 inestable
  preexistente en paralelo (pasa en aislado).
