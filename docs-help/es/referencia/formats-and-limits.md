# Formatos y límites

## Lo que abre

| Formato           | Se lee                       | Índice                                 | Texto para el agente | Figuras                  |
| ----------------- | ---------------------------- | -------------------------------------- | -------------------- | ------------------------ |
| **EPUB** sin DRM  | Sí, con tipografía ajustable | Del nav/NCX del libro, con sus niveles | Sí                   | Sí, con modelo de visión |
| **PDF** con texto | Sí, con zoom y ajuste        | De los **marcadores** (outline)        | Sí                   | Sí, con modelo de visión |
| **PDF** escaneado | Sí, como imagen              | Solo si trae marcadores                | **No**               | Sí, con modelo de visión |

Y lo que **no** abre: MOBI, AZW3, CBZ/CBR, EPUB o PDF con DRM (los de Kindle o Adobe), y cualquier
cosa que no sea EPUB o PDF. Un `.bookreader` (un libro con sus notas, exportado por la app) sí se
puede importar.

## EPUB

- El texto se reflowa: puedes cambiar fuente, tamaño, columnas e interlineado.
- El índice sale de la tabla de contenidos del propio EPUB y conserva sus niveles. La marca de
  «estás aquí» baja contigo por el capítulo.
- Los números de página del índice son una estimación del lector, no la paginación de una edición
  impresa.

## PDF

- Es una maqueta fija: el texto no se reflowa. Puedes hacer zoom y elegir el ajuste: **Página**,
  **Ancho** o **Texto** (recorta los márgenes blancos).
- **El índice sale de los marcadores.** Un PDF impreso desde Chrome o desde Word suele no tenerlos:
  se abre bien, pero el sidebar sale vacío. No es un fallo de la subida.
- Si no hay capa de texto (un escaneo), se puede leer y ver, pero **no** buscar dentro ni citar
  pasajes. El agente no tiene nada que leer.
- **Zona**: puedes recortar una figura o una ecuación y mandarla con la pregunta. Eso usa visión,
  así que necesita un modelo que acepte imágenes.

## Tamaños y almacenamiento

- Los libros se guardan en el navegador. Un libro de cientos de MB tarda en entrar y ocupa espacio
  del dispositivo; el navegador puede pedirte permiso para dar más cuota.
- El **sync con Drive** sube los datos siempre; los **archivos de los libros** solo si lo activas.
  Los de más de 50 MB no se suben solos: se piden desde el menú del libro.
- Un enlace de estantería compartida con los libros dentro tiene un tope de 100 MB; sin libros, el
  enlace es ligero.

## Cuentas y cupos

- **Libros y lector**: gratis, sin cuenta.
- **Agente**: demo gratuita con cupo, o tu clave (pagas al proveedor).
- **Plus**: 8 €/mes cuando salga; incluye el MCP, el sync de BookReader y la IA incluida. Todo lo
  demás de BookReader sigue siendo gratis.

## Siguiente

- [Lee un libro](../guias/read-a-book.md).
- [Cómo responde el agente](../explicacion/how-the-agent-works.md).

---

_Actualizado el 15 de noviembre de 2026._
