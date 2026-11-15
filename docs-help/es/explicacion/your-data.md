# Qué pasa con tus datos

La promesa de BookReader es corta: **tus libros se quedan en tu dispositivo** y a la IA solo le
llega lo necesario para responder. Esto es el detalle, sin letra pequeña.

## Dónde vive cada cosa

| Qué                                        | Dónde                                                           |
| ------------------------------------------ | --------------------------------------------------------------- |
| Libros (EPUB y PDF)                        | El almacenamiento del navegador en este dispositivo (IndexedDB) |
| Subrayados, notas, marcadores, ajustes     | El almacenamiento del navegador                                 |
| Tarjetas, repaso, libretas, conversaciones | IndexedDB                                                       |
| API key                                    | Solo en este dispositivo                                        |
| Sync con Google Drive                      | Una carpeta privada de **tu** Drive (`appDataFolder`)           |

No hay cuenta ni una base de datos nuestra con tu biblioteca. Si borras los datos del sitio en el
navegador, borras la biblioteca de ese dispositivo: por eso existe el backup.

## Qué ve la IA

Cuando preguntas, BookReader busca en el libro y manda al modelo:

- tu pregunta,
- los pasajes que ha encontrado,
- el objetivo y la plantilla de esa conversación.

No manda el libro entero por defecto, ni tu biblioteca, ni tus otras conversaciones. Si adjuntas una
figura o la página entera, manda esa imagen.

Con **tu clave**, la petición va del navegador **directo** a tu proveedor. Con la **demo**, pasa por
un servicio nuestro que habla con el modelo de la casa; es lo que permite probar sin cuenta.

## El sync

- **Google Drive**: los datos van cifrados en tránsito a una carpeta privada de tu Drive. El único
  servidor nuestro que interviene renueva el permiso de Google; no guarda tus libros.
- **Sync de BookReader** (Plus, muy pronto): cifrado **de extremo a extremo** en el navegador. El
  servidor guarda bloques que no puede leer; solo descifra lo que pide un agente autorizado, y solo
  mientras dura la petición.

## Qué se puede sacar

- **Backup JSON**: ajustes, subrayados, notas, libretas, conversaciones, mazos, ejercicios y
  artefactos. **Sin** la API key y **sin** los archivos de los libros.
- **Tarjetas a Anki**: `.apkg` o texto.
- **Subrayados y notas a Markdown**.
- **El libro original**, desde el menú del libro.

## Qué se mide

La app cuenta **visitas y activaciones** (por ejemplo, el primer mazo) con Umami, sin cookies y sin
datos personales ni del libro. **No hay telemetría de lectura**: no se mide qué lees, cuánto ni
dónde. La analítica nunca incluye la parte del enlace que lleva claves o el libro que estás
leyendo.

## Borrar

- **Un libro**: desde su menú. Se va la ficha y el fichero de ese dispositivo.
- **Todo**: borra los datos del sitio en el navegador. Antes, descarga un backup.
- **El sync**: desconectarlo deja de subir cambios; lo que ya está en Drive o en el sync de
  BookReader sigue allí hasta que lo borres desde su panel.

## Lo que no puedo prometer

- Un **PDF escaneado** sin texto no se puede buscar ni citar: no hay texto que mandar.
- Un **modelo** puede equivocarse aunque tenga el pasaje delante. Por eso cada respuesta lleva su
  cita: la cita manda.
- Si **pierdes todos tus dispositivos y la clave de recuperación** del sync de BookReader, lo
  sincronizado no se puede recuperar. Es el precio de que nadie más pueda leerlo.

## Siguiente

- [Cómo responde el agente](how-the-agent-works.md).
- [Sincroniza y guarda una copia](../guias/sync-and-backup.md).

---

_Actualizado el 15 de noviembre de 2026._
