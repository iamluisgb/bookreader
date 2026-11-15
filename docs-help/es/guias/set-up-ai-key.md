# Configura el agente

El agente es lo que convierte el lector en algo que responde. Tienes dos caminos y puedes cambiar
de uno a otro cuando quieras: **la demo gratuita** o **tu propia clave**.

## Camino 1: la demo (cero configuración)

La primera vez que pides algo, BookReader te da una **demo gratuita**: un cupo de preguntas para
probar el agente sin cuenta ni clave. No hay que activar nada; si quieres verlo o reiniciarlo:

1. Abre **Ajustes** (el engranaje).
2. Entra en **Agente**.
3. Pulsa **Probar la demo**.

Cuando se agota, la app te avisa y te ofrece poner tu clave. La demo sirve para probar; para leer
en serio, mejor tu clave.

!!! note "La demo pasa por nuestro gateway"
    Para darte una demo sin clave, la petición sale por un servicio nuestro que habla con el
    modelo. Con tu clave, en cambio, el navegador habla **directo** con tu proveedor.

## Camino 2: tu clave (BYOK)

«Bring your own key»: usas tu cuenta de un proveedor de IA y pagas a ese proveedor lo que gastes.
BookReader no cobra por el agente.

1. Abre **Ajustes → Agente**.
2. Elige **Proveedor**. Hay presets para `nan.builders`, **OpenAI**, **OpenRouter** y **Groq**.
   Con **Personalizado** vale cualquier servicio compatible con la API de OpenAI (un modelo local,
   una puerta de enlace de empresa…).
3. Pega tu **API key**.
4. Elige el **modelo**. Si tu proveedor no aparece en la lista, escribe su id o pulsa para
   refrescar el catálogo.
5. Guarda. La clave se queda **en este dispositivo**, no viaja en el backup ni en el sync.

!!! tip "Modelos con visión y dictado"
    Para explicar una figura o revisar un boceto, el modelo tiene que aceptar imágenes. Para dictar
    con tu proveedor en vez de con el navegador, configura un modelo de transcripción. Son dos
    ajustes opcionales dentro de la misma sección.

## Qué cambia con cada camino

|               | Demo                                 | Tu clave                                    |
| ------------- | ------------------------------------ | ------------------------------------------- |
| Configuración | Ninguna                              | Proveedor, clave y modelo                   |
| Coste         | Gratis, con cupo                     | Lo que te cobre tu proveedor                |
| Privacidad    | La petición pasa por nuestro gateway | El navegador habla directo con el proveedor |
| Límite        | Se agota                             | El de tu cuenta                             |
| Modelo        | El que sirve la demo                 | El que elijas                               |

## Si el agente no contesta

- **«Falta la API key» o «API key inválida»**: revisa que has pegado la clave entera y que
  corresponde al proveedor elegido.
- **La demo se ha agotado**: pon tu clave en **Ajustes → Agente** y sigue donde estabas.
- **El modelo no responde o tarda mucho**: prueba otro modelo del mismo proveedor; los de
  razonamiento largo tardan más.
- **No entiende una figura**: falta un modelo de visión.

## Siguiente paso

- [Pregúntale al libro](ask-the-book.md).
- [Cómo responde el agente](../explicacion/how-the-agent-works.md), si quieres saber qué hace con
  lo que le mandas.

---

_Actualizado el 15 de noviembre de 2026._
