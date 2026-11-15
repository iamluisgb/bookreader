# Cómo responde el agente

El agente no «se lee el libro» de una vez: busca, elige pasajes y responde con ellos delante. Saber
cómo funciona explica por qué acierta, por qué a veces no encuentra algo y por qué la cita es la
parte que importa.

## El recorrido de una pregunta

1. **Entiende la pregunta** y el contexto: el capítulo abierto, el **objetivo de lectura** y la
   plantilla de la conversación.
2. **Busca en el libro.** BookReader tiene el texto segmentado en el dispositivo y usa ese índice
   para localizar los pasajes que tratan el asunto. No busca en internet.
3. **Recorta.** No manda el libro entero: manda los pasajes que caben en el presupuesto de la
   pregunta, priorizando el capítulo que estás leyendo.
4. **Responde y cita.** La respuesta llega con referencias al capítulo y la página. Al tocar una,
   el lector salta al pasaje.

Por eso una pregunta pequeña funciona mejor: «qué dice aquí sobre X» encuentra mejor que «resúmeme
el libro».

## El objetivo cambia la respuesta

El **objetivo de lectura** no es decoración: decide qué es relevante. «Por qué importa» y «Con
números» lo usan para conectar el pasaje con lo que estás intentando aprender. Sin objetivo, esas
dos acciones te lo piden antes de seguir.

Las **plantillas de libreta** hacen lo mismo con la forma: una plantilla de resumen pide tesis e
ideas; una de estudio, preguntas. La misma pregunta con otra plantilla da otra respuesta.

## Qué modelo hay detrás

- **Demo**: el modelo de la casa, a través de nuestro gateway, con un cupo de prueba.
- **Tu clave**: el proveedor y el modelo que elijas. BookReader habla con cualquier servicio
  compatible con la API de OpenAI.
- **Visión**: explicar una figura o revisar un boceto necesita un modelo que acepte imágenes.
- **Dictado**: si configuras un modelo de transcripción, la voz va a tu proveedor en vez de al
  dictado del navegador.

El modelo cambia la calidad, no la regla: la respuesta se sostiene en los pasajes que cita.

## Dónde puede fallar

- **No encuentra el término.** El libro lo llama de otra forma. Prueba con las palabras del autor o
  con **Dónde más lo trata**.
- **Cita bien y concluye mal.** Pasa: el modelo interpreta. Por eso la cita está a un toque; si no
  sostiene la respuesta, gana la cita.
- **Un PDF escaneado.** No hay texto que buscar. La página se ve, pero el agente no puede leerla.
- **Un libro muy largo.** El recorte prioriza el capítulo; para el libro entero, una pregunta
  concreta encuentra más que una general.
- **Sin conexión.** Responde con los pasajes del propio libro, sin razonar sobre ellos; las
  preguntas quedan en cola hasta que vuelve la red.

## Lo que no hace

- No busca en la web ni trae fuentes de fuera.
- No inventa citas: si no hay pasaje, lo dice.
- No genera artefactos nuevos sin conexión ni sin modelo.
- No manda tu biblioteca a nadie: manda la pregunta y los pasajes que hacen falta.

## Siguiente

- [Qué pasa con tus datos](your-data.md).
- [Formatos y límites](../referencia/formats-and-limits.md).

---

_Actualizado el 15 de noviembre de 2026._
