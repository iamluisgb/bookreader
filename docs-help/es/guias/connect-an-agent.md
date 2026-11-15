# Conecta un agente a tu biblioteca

BookReader puede dejar que un agente de IA —Claude Code, Claude Desktop, Hermes u otro cliente con
**MCP**— consulte tus libros: subrayados, notas, estadísticas, mazos y el texto de los libros. Tú
decides qué puede ver cada token y lo revocas cuando quieras.

!!! note "Llega con Plus"
    Esta conexión forma parte de **BookReader Plus** y todavía está en pruebas. Cuando esté abierta,
    el interruptor aparecerá en **Ajustes → Datos**, dentro de la sección del sync de BookReader.

## Qué es MCP

MCP (Model Context Protocol) es un estándar para que un agente use herramientas de una app. En vez
de copiar y pegar pasajes, el agente pregunta a BookReader y recibe los resultados con su cita, sin
salir de la conversación.

## Crear un token

1. **Ajustes → Datos**.
2. En la sección del **sync de BookReader**, baja hasta **Agentes (MCP)**.
3. **Conectar un agente** y ponle un nombre: te servirá para reconocerlo en la lista y revocarlo.
4. Elige los permisos. Por defecto **solo puede leer** tus libros, subrayados, notas y mazos.
    Puedes marcar además:
    - cambiar mazos y tarjetas y crear resúmenes y mapas;
    - leer el texto de los libros;
    - organizar la biblioteca (estanterías, estado, títulos);
    - subir libros.
5. Copia el **token** en el momento: no se vuelve a enseñar. La app te da también el comando listo
   para Claude Code.

## Revocar

En la misma lista, cada agente muestra su último uso. **Revocar** corta el acceso al instante. Un
token por agente: si uno se filtra, revocas ese y los demás siguen.

## Cómo se protege

- El servidor de sync **no puede leer** tu biblioteca en reposo: está cifrada con una clave que solo
  tienen tus dispositivos.
- Para responder a una consulta, descifra **solo lo que el agente pide**, en memoria, mientras dura
  la petición.
- Los libros no se pueden borrar por MCP. Sí se pueden crear y editar tarjetas, resúmenes y
  estanterías, con los permisos de escritura.

## Si no aparece la sección

- **No tienes Plus o el sync de BookReader no está activo**: la sección de agentes vive dentro de
  ese panel. El sync de BookReader aún no está abierto al público; Google Drive sí, pero no expone
  MCP.
- **Has cambiado de dispositivo**: el token es del agente, no del dispositivo. Vuelve a crear uno
  si lo perdiste; no se puede recuperar.

## Siguiente paso

- [Cómo responde el agente](../explicacion/how-the-agent-works.md).
- [Qué pasa con tus datos](../explicacion/your-data.md).

---

_Actualizado el 15 de noviembre de 2026._
