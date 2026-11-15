---
updated: 2026-11-15
---

# Lee sin conexión

BookReader es una **PWA**: se instala como una app y funciona sin conexión con lo que ya tienes
descargado. No es un modo recortado: leer, subrayar, marcar y repasar funcionan igual.

## Instalarla

- **iPhone / iPad (Safari):** Compartir → **Añadir a pantalla de inicio**.
- **Android (Chrome):** menú → **Instalar aplicación** (o el aviso que aparece al entrar).
- **Escritorio (Chrome, Edge):** el icono de instalar de la barra de direcciones.

Instalada, se abre a pantalla completa y el libro que estás leyendo sigue donde lo dejaste.

## Qué funciona sin red

| Sí                                  | No                                              |
| ----------------------------------- | ----------------------------------------------- |
| Abrir y leer libros ya descargados  | Descargar un libro nuevo                        |
| Subrayar, notas, marcadores         | Buscar en la biblioteca entera                  |
| Repasar tarjetas y ejercicios       | Generar resumen, mapas o tarjetas nuevas        |
| El agente con los pasajes del libro | Explicar figuras (necesita un modelo de visión) |

El **progreso y las tarjetas** se guardan en el dispositivo aunque no haya red; si tienes sync, se
suben al recuperar la conexión.

## Preguntar en un avión

Sin conexión, el agente responde con los **pasajes del propio libro** (búsqueda local), con sus
anclas para saltar al texto. La pregunta queda en cola y se responde entera cuando vuelve la red.
Es recall, no una respuesta razonada: si no encuentra el pasaje, lo dice.

Antes de despegar, en el menú del agente, **Preparar para sin conexión** deja cacheado el resumen
del libro entero. Tarda un par de minutos y consume llamadas a tu modelo, así que hazlo con red.

!!! warning "La cola, en la conversación activa"
    Las preguntas hechas sin red se envían al volver la conexión **en la conversación en la que las
    hiciste**. Las de otro libro esperan a que abras ese libro.

## Libros en Drive

Un libro que solo está en tu Google Drive no se puede leer sin red hasta que lo descargas. En el
menú del libro, **Descargar**. Los libros que pesan más de 50 MB no se sincronizan solos: se piden
a mano.

## Siguiente paso

- [Sincroniza y guarda una copia](sync-and-backup.md).
- [Qué pasa con tus datos](../explicacion/your-data.md).

