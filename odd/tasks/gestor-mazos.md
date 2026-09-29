# Feature: Gestor de mazos y reparación de identidad

Estado: **implementación en curso**. Rama: `feat/gestor-mazos` (a crear).
Alcance acordado: Fase 1 (reparar identidad) + Fase 2 (gestor en la biblioteca, creación a
mano **solo de texto**). Fase 3 (crear visuales a mano, con editor de oclusiones) queda fuera.

## Problema (diagnóstico verificado en código)

Síntoma reportado: *«borro un libro del dispositivo, lo vuelvo a descargar y las tarjetas no
salen en el menú para gestionarlas»*, más los «Mazos sin libro» que aparecieron en el selector
de repaso.

Causa raíz: **un mazo guarda el id de libro con el que se creó y nunca lo actualiza.**

| Pieza | Comportamiento hoy |
|---|---|
| Identidad del libro | Hash SHA-256 del contenido (`db.js:hashBuffer`). Los libros viejos conservan ids **heredados**: nombre de fichero o `epubjs:…` |
| `Aliases.reconcile()` | Corre en cada sync (`sync/engine.js:299`); remapea **subrayados y marcadores** únicamente. Los mazos nunca entran |
| `computeAliases()` | **Excluye a propósito los ids heredados** (`aliases.js`: «los legacy los trata purgeOrphans») → un mazo nacido bajo id heredado no puede enlazar por alias |
| `deleteBook()` | Solo pone tombstone al libro; **no toca sus mazos** (`library/store.js`) |
| Consecuencia | El mazo queda huérfano: sus vencidas cuentan en el total (por eso «Repasar hoy» las daba) pero ninguna fila lo alcanza, y el modal de flashcards (que filtra por `bookId === libro abierto`) no lo lista |

## Fase 1 — que los mazos sigan a su libro

1. **Reparación por título** (independiente del id, funciona aunque el registro viejo ya no
   exista): si el título normalizado del mazo coincide con el de exactamente UN libro de la
   biblioteca, el mazo se reasigna. Con títulos ambiguos (dos libros con el mismo título) **no
   se adivina**: el mazo queda como huérfano y se resuelve a mano.
2. **Remapeo en `reconcile()`**: sumar los mazos a lo que migra cuando cambia el id por alias.
3. **Reparación manual** desde el gestor: «asignar a…» un libro o «borrar mazo».

## Fase 2 — gestor de mazos (pantalla en la biblioteca)

Pantalla «Mazos» con **todos** los mazos agrupados por libro, y los huérfanos en su propia
sección (con las acciones de reparación de la Fase 1). De cada mazo: abrir, estudiar, editar
frente/dorso, suspender/reactivar, quitar tarjeta, **crear tarjeta a mano** (P→R y cloze),
borrar mazo. Nada de esto inventa UI nueva de cero: la edición y el borrado por tarjeta ya
existen en el modal de flashcards y en la sesión (se reutiliza el patrón).

## Work units

- [ ] **WU1** Reparación de identidad: `DB.remapDecks(from, to)` + matcher puro por título
      (`matchDecksByTitle(decks, books)`) + integración en `reconcile()` + aplicación idempotente
      al arrancar. Tests: heredado con título único → reparado; título ambiguo → intacto;
      correcto → intacto; idempotente.
- [ ] **WU2** Capa de datos del gestor: módulo `app/js/ai/deck-manager.js` con helpers puros
      (agrupar por libro/sin libro, validar y construir una tarjeta a mano con `uid`/`updatedAt`,
      resumen por mazo) + tests.
- [ ] **WU3** Pantalla «Mazos» en la biblioteca: entrada + vista (lista agrupada, abrir mazo,
      editar/borrar/suspender tarjeta, crear a mano, borrar mazo, reparar huérfano) + CSS.
- [ ] **WU4** Tests de la pantalla (Playwright) + precache del SW + docs (CHANGELOG/BACKLOG/DECISIONS).

## Límites / fuera de alcance

- Crear a mano tarjetas **visuales** (oclusión sobre figura) → Fase 3; necesita el editor de
  recuadros de la demo.
- Importar mazos de Anki, mover tarjetas entre mazos, duplicar mazo: no en esta entrega.
- El modal de flashcards queda como está (generar desde el libro).
