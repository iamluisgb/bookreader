# Backup completo (mazos y artefactos) + lectura desde el backup

Estado: **implementación en curso**. Dos paquetes: la app (`app/js/backup.js`) y el MCP (`mcp/`).

## El problema

El backup de BookReader declara qué incluye y qué excluye **a propósito** (API key, texto
segmentado, ficheros de libros). Pero en ninguna de las dos listas están **los mazos de
flashcards** (`decks`, con su estado de repaso FSRS) ni **los artefactos del Studio**
(`artifacts`: resúmenes, mapas mentales, infografías, figuras).

Consecuencias reales:

1. **Restaurar un backup en otro dispositivo pierde las flashcards y los mapas mentales.** El
   backup existe para migrar entre dispositivos (P3, PWA local-first sin servidor): si el usuario
   no tiene sync, esos datos no viajan. La lista de tiendas del backup
   (`AI_STORES = ['convos','messages','notes','ratings','books']`) se usa **tanto para exportar
   como para importar**, así que el olvido es simétrico: no se exportan y no se restauran.
2. **El MCP no puede leerlos sin fuente viva.** El backup es el camino sin token ni Drive; hoy no
   lleva esos datos, así que las cuatro tools nuevas (`list_decks`, `get_deck`, `list_artifacts`,
   `get_artifact`) quedan apagadas para quien no quiera dar credenciales.

## Diseño

### A. App — el backup lleva los mazos y los artefactos
1. `AI_STORES` pasa a incluir `decks` y `artifacts`. El import es genérico (`DB.put(store, r)` por
   registro), así que con eso el round-trip queda completo; las claves (`decks.id`,
   `artifacts.key`) ya vienen en el registro.
2. Actualizar el comentario de cabecera (qué incluye / qué NO, y por qué): los binarios de libro y
   el texto segmentado **siguen fuera** (voluminosos y regenerables); los mazos y artefactos
   **entran** porque son datos del usuario que no se pueden regenerar.
3. Verificar que el resumen Markdown del backup no mienta (si enumera contenidos, sumar los nuevos)
   y que el import no rompa con backups VIEJOS (sin esos campos): la lista debe tolerar su ausencia
   (hoy ya lo hace: `if (!Array.isArray(records)) continue`).

### B. MCP — detectar la capacidad en la fuente de backup
4. `mcp/src/sources/backup-file.mjs`: `hasAgentData` deja de ser `false` fijo y pasa a
   **detectarse** al cargar (`Array.isArray(ai.decks) || Array.isArray(ai.artifacts)`), con
   métodos `decks(bookId)` / `artifacts(bookId)` que filtran los arrays planos del backup por
   `bookId`. Un backup viejo (sin esos campos) no anuncia las tools; uno nuevo sí.
5. Tests del MCP: el caso «un backup no anuncia las tools de agente» pasa a «un backup **sin**
   esos campos no las anuncia; con ellos, sí», y se agrega el round-trip de lectura desde un
   backup que los lleva.

## Work units

- [ ] **WU1** `app/js/backup.js`: `decks` + `artifacts` en `AI_STORES`, comentario de cabecera
  actualizado, round-trip verificado (export → import → los mazos y artefactos siguen ahí) con
  test. Incluye el resumen Markdown si enumera contenidos.
- [ ] **WU2** `mcp/src/sources/backup-file.mjs`: capacidad detectada + métodos, con los tests
  actualizados/nuevos y `npm test` del paquete en verde.

## Fuera de alcance
- Los ficheros de libro (EPUB/PDF) y el texto segmentado siguen fuera del backup.
- El token de Drive: se sigue ofreciendo como fuente viva, pero este camino no lo necesita.
