# Propuesta · Añadir un dispositivo al sync de BookReader

Estado: **IMPLEMENTADA** F1, F2, F3 y el borrado con prueba de clave (2026-11-25; ver CHANGELOG).
**Descartadas** por decisión de Luis: 2b (la clave de recuperación sola no basta; se sigue pidiendo
la licencia) y F5 (`customer_id` de Polar). Cambio sobre §5: «empezar de cero» sin la clave no se
prohíbe, se **apunta** 7 días y un dispositivo con la clave lo cancela.
Origen: Luis activó el sync en el PC del trabajo y le resultó confuso. Para entrar
hizo falta (1) la misma licencia `BKRD-…` que en los demás dispositivos y (2) o el
«Enlace para otro dispositivo» o la «Clave de recuperación» `XXXX-…`.

Código leído: `app/js/sync/bookreader-auth.js`, `app/js/sync/sync-crypto.js`,
`app/js/sync/switch.js`, `app/js/app.js` (`recibirEmparejamiento`),
`app/js/ui/app-settings.js` (panel `appset-br-*`), `app/js/license.js`,
`workers/sync/src/index.js` (`issueToken`, `userIdOf`, `status`, `wipeUser`),
`workers/sync/src/mcp.js` y ADR-056.

---

## 1. Qué protege cada clave (hoy)

| Pieza | Qué es | Quién la ve | Para qué sirve |
|---|---|---|---|
| **Licencia** `BKRD-…` | La license key de Polar | El servidor, en cada `POST /v1/sync-token` | **Quién eres y dónde están tus datos.** El Worker la valida contra Polar y da un token `br-sync-…` de 24 h. El espacio del usuario es `sha256('bookreader-sync:' + USER_SALT + licencia)` (`userIdOf`). **Licencia distinta = espacio distinto.** |
| **Clave del sync** | 32 bytes aleatorios generados en el primer dispositivo (`C.generateKey`) | Solo los dispositivos. Excepción: al crear un token MCP, la app la manda al Worker y este la guarda cifrada con una clave derivada del token (`mcp.js`) | **Qué se puede leer.** De ella salen por HKDF una clave AES-GCM (contenido y nombres) y una HMAC (rutas opacas). El servidor guarda bytes cifrados. |
| **Clave de recuperación** `XXXX-…` | **La misma clave del sync**, en Crockford base32: 52 caracteres + 2 de control, 14 grupos | Quien la guarde | Teclear la clave del sync en otro dispositivo. No es una clave aparte ni una contraseña: es la clave entera. |
| **Enlace para otro dispositivo** | `…/app/#pair=<clave del sync en b64url>.<licencia en b64url>` | Quien lo reciba. El fragmento no llega a ningún servidor | Lleva **las dos cosas**: la licencia y la clave. **No caduca:** vale mientras la licencia esté activa y nadie pulse «Empezar de cero». |

**¿Es de extremo a extremo?** Sí. La clave del sync no sale de la licencia a propósito (ADR-056 §4):
la licencia llega al servidor, así que una clave derivada de ella la podríamos descifrar nosotros. La
clave de recuperación **es** la clave que descifra. Para leer los datos hacen falta las dos piezas: la
licencia lleva al espacio y la clave lo descifra. El enlace las junta en un solo secreto.

Un fichero de control (`bookreader/keycheck`, cifrado con la clave) permite probar una clave sin
descifrar datos reales. Su ruta es un HMAC de la propia clave, así que **una clave ajena lo busca en
otra ruta y recibe un 404** (`keyOpens`).

## 2. Qué pasa hoy en cada caso límite

| Caso | Qué hace el código | Qué ve el usuario | Problema |
|---|---|---|---|
| **Dispositivo nuevo, misma licencia, sin clave** | `enable()` → `status().objects > 0` → `needs-key` | Panel «Ya tienes datos sincronizados…» con un campo para la clave y «Perdí la clave: empezar de cero» | Funciona, pero pide algo que el usuario tiene en *otro* dispositivo. El texto manda a «abrir el enlace» sin decir dónde se genera. |
| **Licencia distinta, sin clave** | `enable()`: el espacio de esa licencia tiene 0 objetos → **genera una clave nueva, escribe el keycheck y queda `ready`** | «Sync de BookReader activado» | **El caso de Luis: espacio nuevo y vacío, en silencio.** Este dispositivo sube lo suyo ahí y nunca se cruza con los demás. Nada avisa. |
| **Licencia distinta + clave de recuperación** | Solo se llega si el espacio ya tiene datos (`needs-key`). Si estaba vacío, `useKey` → `keyOpens` → `null` → error `empty` | «Con la licencia de este dispositivo no hay nada sincronizado. Usa en los dos la misma licencia.» | Aviso correcto, pero tarde y sin salida: no dice cuál es la licencia buena ni cómo ponerla. |
| **Licencia distinta + enlace** | `recibirEmparejamiento` compara licencias y pregunta «Este dispositivo tiene otra licencia… se usará la suya» → `License.activate(licencia del enlace)` | Un diálogo | El mejor caso de hoy. `activate` gasta una activación de Polar (tope 5). |
| **Licencia distinta y el dispositivo ya tenía clave** | `enable()` con `hasKey()`: `keyOpens` → `null` (espacio vacío) → **escribe el keycheck con la clave vieja en el espacio nuevo** | «Activado» | Segundo camino al espacio vacío en silencio. |
| **Clave perdida en todos los dispositivos** | Solo queda «Empezar de cero» → `DELETE /v1/all` (borra objetos, blobs, tokens MCP, perfil público) y `enable()` | Diálogo de confirmación con `danger` | Correcto e inevitable con E2E. Riesgo aceptado en ADR-056 §4. |
| **Enlace «caducado»** | No existe: el enlace no caduca. Deja de abrir solo si alguien pulsó «Empezar de cero» (clave rotada → `wrong_key`) o la licencia caducó | «Esa clave no es la de tu sync…» o «Tu suscripción no está activa» | Que no caduque es el problema de seguridad: queda en el chat, el correo o el historial con la licencia y la clave, para siempre. |
| **Enlace cortado al copiarlo** | `consumePairLink` → `{ broken: true }` | «El enlace está incompleto…» | Bien resuelto. |
| **Dispositivo con datos locales previos** | `switch.activate` → el primer ciclo hace merge por unión (`applyLibrary`) y LWW: sube todo lo local y baja lo remoto | Nada en especial | Al espacio **bueno**: se mezcla sin preguntar (libros de prueba incluidos), pero no se pierde nada. Al espacio **vacío equivocado**: lo local se queda allí, separado. Se arregla emparejando después, porque la unión no borra. |
| **Dispositivo en Google Drive que abre el enlace** | Guarda la clave y manda a Ajustes → Datos para migrar | Aviso | Bien: no cambia de proveedor sin preguntar. |

**Resumen:** el modelo criptográfico está bien. Lo que confunde es que la identidad (licencia) y la
clave viajan por caminos distintos, y que el único paso que puede salir mal en silencio, una licencia
distinta, lo resuelve `enable()` creando un espacio nuevo.

## 3. Las tres ideas de partida: veredicto

### Idea 1: enlace/QR que lo lleve todo, un paso en el nuevo dispositivo

**Aceptada, con un cambio: enlace de un solo uso y que caduca a los 10 minutos.** El enlace de hoy ya
lo lleva todo (licencia + clave), así que el UX de «un paso» ya existe. Faltan tres cosas:

1. Que caduque y sea de un solo uso. Hoy es una credencial permanente que se copia al portapapeles y
   acaba en WhatsApp o en el correo.
2. Un QR. Del ordenador al móvil, copiar un enlace es el paso que más falla.
3. Que el dispositivo de origen vea cuándo se usó («Chrome en Windows se ha emparejado»). Así un uso
   que no ha hecho uno mismo se detecta.

Diseño, con un relevo cifrado en el Worker:

- El origen genera un secreto `s` de 16 bytes y cifra `{v:2, key, license}` con AES-GCM (clave
  `HKDF(s, 'bookreader-pair/v2')`). Sube el cifrado a `POST /v1/pair` con su token. El Worker guarda
  `{id, user, blob, expires_at = ahora + 10 min}` y devuelve `id`.
- Enlace y QR: `https://bookreader.raiatech.com/app/#pair2=<id>.<s>`. `s` va en el fragmento, así que
  el servidor tiene el cifrado pero no la clave para abrirlo.
- El nuevo dispositivo hace `POST /v1/pair/<id>/claim` sin token, con Origin comprobado y límite por
  IP. El Worker devuelve el blob y **lo borra** en la misma operación. El dispositivo lo descifra con
  `s` y sigue el camino de hoy: `License.activate` si hace falta, después `useKey` y `activate`.
- El origen consulta `GET /v1/pair/<id>` cada 2 s mientras enseña el QR. Cuando cambia a `claimed`,
  pinta «Emparejado: {dispositivo}» (de `License.deviceLabel`, que el nuevo manda al reclamar).

¿Por qué no un QR con la clave dentro, sin servidor? Funcionaría sin red, pero un QR fotografiado o
un enlace reenviado seguirían valiendo para siempre. Con el relevo, el servidor no ve nada en claro
y el enlace muere en cuanto se usa.

### Idea 2: pedir solo la clave de recuperación y derivar de ella el espacio

**Parcialmente aceptada. «Derivar el espacio de la clave» tal cual, no:** el espacio tiene que
seguir atado a una licencia que paga, porque las cuotas, el periodo de gracia y la purga van por
licencia. Hay dos variantes, de menos a más:

- **2a (recomendada ya): detectar el desajuste.** El cliente calcula `pid = HMAC(clave, 'bookreader/keycheck')`,
  la ruta del keycheck que **ya existe en todos los espacios**. La manda a `POST /v1/key-owner {pid}`
  (con token). El Worker contesta solo `{ elsewhere: true|false }`: si esa ruta existe en el espacio
  de **otro** usuario. Con eso, `useKey` deja de decir «no hay nada sincronizado» y dice que la clave
  es de un sync abierto con otra licencia. No filtra nada: solo contesta a quien ya tiene la clave
  (el `pid` es un HMAC de 256 bits). Necesita un índice `objects(path)`.
- **2b (decisión de Luis): la clave de recuperación basta.** Al conectar, cada dispositivo deja en
  su espacio un «sobre» con la licencia cifrada con la clave del sync (`bookreader/license`, cifrado
  como cualquier fichero). Con solo la clave de recuperación, `POST /v1/key-owner` sin token (límite
  por IP) devuelve ese sobre. El cliente lo abre, activa la licencia y se empareja. Un paso, sin
  licencia a mano.
  **Coste en seguridad:** hoy la clave de recuperación sola no sirve, porque hace falta también la
  licencia. Con 2b pasa a ser una credencial completa, como el enlace actual. El texto de «Guardar en
  un fichero» ya lo trata así («Guárdala en un sitio seguro»). Los usuarios existentes no tienen que
  hacer nada: el sobre lo escribe el primer dispositivo conectado que sincronice después del
  despliegue.

Recomendación: **2a en la primera fase y 2b como decisión aparte.** 2a arregla la confusión. 2b
cambia lo que significa la clave de recuperación y conviene decidirlo con eso delante.

### Idea 3: nunca crear un espacio vacío en silencio

**Aceptada sin matices.** Es el arreglo más barato y el que habría evitado el caso de Luis. El
servidor **no puede saber** que hay datos bajo otra licencia, porque no la conoce. Por eso la
respuesta es preguntar:

- En `enable()`, cuando no hay clave local y el espacio está vacío, ya no se crea la clave
  directamente. Devuelve `{ state: 'first-device?' }` y la UI pregunta si es el primer dispositivo
  (textos en §7). «Ya lo uso en otro» lleva al panel de emparejar (QR o clave) y no crea nada.
- El mismo caso con `hasKey()` y espacio vacío (licencia cambiada en un dispositivo que ya tenía
  clave) pasa por la misma pregunta, en lugar de reescribir el keycheck.
- Opcional, en la fase 3: Polar devuelve `customer_id` al validar (**hay que comprobar el campo**
  contra la API real). Si el Worker guarda `hash(customer_id)` en `users`, puede decir «este
  cliente tiene otro espacio con datos» cuando el usuario tiene **dos licencias de la misma
  cuenta**. Con las `TEST_LICENSES` no funciona: no tienen cliente.

## 4. Flujo actual y propuesto (pasos del usuario)

### Camino principal: tengo otro dispositivo a mano

**Hoy (6–8 pasos, en dos dispositivos):**
1. En el dispositivo viejo: Ajustes → Datos → Sync de BookReader → «Enlace para otro dispositivo».
2. Mandarse el enlace (correo, chat…) porque se copia al portapapeles.
3. En el nuevo: abrir el enlace en el navegador donde se usará la app.
4. Si tenía otra licencia, confirmar «Usar la del enlace».
5. Esperar a «Dispositivo emparejado».
   (Si el usuario empieza por Ajustes en el nuevo, lo cual es natural, va a «Activar», y con otra
   licencia acaba en el espacio vacío sin enterarse.)

**Propuesto (3 pasos):**
1. En el dispositivo viejo: Ajustes → Datos → **«Añadir un dispositivo»**. Sale un QR y «Copiar
   enlace», válido 10 minutos.
2. En el nuevo: escanear el QR con la cámara (o abrir el enlace).
3. Listo. El viejo dice «Emparejado: Chrome en Windows» y el nuevo, «Tus notas y tu progreso ya
   están aquí».

Si el usuario empieza en el nuevo y pulsa «Activar el sync», la app pregunta si es su primer
dispositivo, y la respuesta «Ya lo uso en otro» le explica el paso 1.

### Camino manual: no tengo el otro dispositivo, tengo la clave guardada

**Hoy:** poner en el nuevo **la misma licencia** (Ajustes → Licencia) → Ajustes → Datos → Activar →
(si la licencia es otra: espacio vacío en silencio y fin) → pegar la clave de 54 caracteres → «Usar
la clave».

**Propuesto con 2a:** Activar → «Ya lo uso en otro» → «Con mi clave de recuperación» → pegar la
clave. Si la licencia no cuadra, el aviso lo dice y manda a Licencia. Ya no hay espacio vacío.

**Propuesto con 2b:** Activar → «Ya lo uso en otro» → pegar la clave. La licencia se activa sola.

### Perdí la clave en todos los dispositivos

Igual que hoy («Empezar de cero»), con dos cambios de texto: decir cuántos objetos hay en el sync
(`status().objects`) y mandar antes a «Descargar un backup» de este dispositivo.

## 5. Impacto en seguridad

| Cambio | Mejora | Empeora | Neto |
|---|---|---|---|
| Enlace de un solo uso y 10 min (idea 1) | El enlace deja de ser una credencial permanente en chats y correos. El origen ve quién lo usó. | El servidor guarda unos minutos un blob con licencia + clave, cifrado con un `s` que nunca recibe. Para leerlo haría falta además el enlace. | **Mejor.** Hoy la misma información vive para siempre en el portapapeles y el historial. |
| QR | — | Alguien que fotografíe la pantalla tiene 10 minutos y un solo uso, y el origen lo vería. | Aceptable. |
| 2a · `key-owner` con token | — | Revela si una ruta existe en otro espacio, solo a quien ya tiene la clave. | Neutro. |
| 2b · la clave sola basta | UX | La clave de recuperación pasa de factor a credencial completa. El endpoint sin token es un oráculo de «existe/no existe» sobre un HMAC de 256 bits: no se puede enumerar, pero lleva límite por IP. | **Peor en teoría y menor en la práctica:** la licencia y la clave suelen guardarse en el mismo sitio. Decisión explícita. |
| Pregunta «¿primer dispositivo?» (idea 3) | Evita espacios fantasma. | — | Mejor. |

Hallazgo aparte, fuera del alcance: **la licencia sola basta para borrar el sync.** Con ella se saca
un token y se llama a `DELETE /v1/all`, sin probar que se tiene la clave. Se cierra pidiendo en
`/v1/all` una prueba de la clave, por ejemplo el `pid` del keycheck: solo la tiene quien puede
descifrar. Sería un ítem de 1–2 h.

## 6. Cambios de código y Worker

**Worker (`workers/sync`)**
- `migrations/0010_pair.sql`: tabla `pair_codes (id TEXT PRIMARY KEY, user TEXT, blob TEXT, expires_at INTEGER, claimed_at INTEGER, claimed_by TEXT)` e índice por `expires_at`.
- `src/pair.js`: `POST /v1/pair` (con token, nunca en solo lectura, máximo 5 vivos por usuario), `POST /v1/pair/:id/claim` (sin token, Origin de la app, límite por IP, `DELETE … RETURNING` atómico, 410 si caducó o ya se usó) y `GET /v1/pair/:id` (con token, solo el dueño).
- Purga de códigos caducados en el cron que ya existe (`purgeChanges`, `purgeUploads`).
- 2a: `CREATE INDEX objects_path ON objects (path)` y `POST /v1/key-owner`.
- 2b (si se decide): la misma ruta sin token, que devuelve también el sobre `bookreader/license`.
- Rate limit nuevo: un namespace más en `wrangler.jsonc`. **Ojo: los namespaces son por cuenta, no por Worker**: elegir uno que no esté usado (ya lo están 2401-2406, 3101 y 3102).
- Tests en `workers/sync/test/pair.test.mjs`: un solo uso, caducidad, otro usuario no puede consultar el estado, carrera de dos `claim`.

**App**
- `bookreader-auth.js`: `createPairCode()`, `claimPairCode(id, s)` y `pairStatus(id)`. `enable()` devuelve `first-device?` en lugar de crear la clave. `useKey` distingue `empty` de `other_license` con 2a. Con 2b, se añade la escritura del sobre de licencia.
- `app.js`: `recibirEmparejamiento` acepta `#pair2=` y sigue aceptando `#pair=` (enlaces ya enviados).
- `app-settings.js`: «Enlace para otro dispositivo» pasa a «Añadir un dispositivo», con un diálogo de QR, cuenta atrás, «Copiar enlace» y estado. Nuevo paso «¿Primer dispositivo?». Se reescriben los textos del panel `pair`.
- QR: vendorizar `qrcode-generator` (~20 KB, MIT) en `app/vendor/`, cargado bajo demanda y precacheado en `sw.js` (gate `sw-precache`), o un generador propio de unas 300 líneas. Lo recomendado es vendorizar.
- `i18n`: textos ES/EN de §7.
- Tests E2E: ampliar `tests/bookreader-sync-files.spec.ts` y `tests/bookreader-sync-migrate.spec.ts` con `#pair2=`, licencia distinta + «Ya lo uso en otro», y un enlace reclamado dos veces.

**Coste aproximado**

| Fase | Contenido | Tamaño |
|---|---|---|
| F1 | Idea 3 (pregunta del primer dispositivo, sin Worker) + textos nuevos | **S** · ½ día |
| F2 | Idea 1: relevo `pair2`, QR, estado en el origen, tests | **M** · 2–3 días |
| F3 | 2a: `key-owner` + índice + aviso de licencia distinta | **S** · ½–1 día |
| F4 (opcional) | 2b: sobre de licencia + recuperación solo con la clave | **S–M** · 1–2 días, más la decisión |
| F5 (opcional) | `customer_id` de Polar para avisar de un segundo espacio del mismo cliente | **S** · tras Polar real |
| Aparte | Prueba de clave en `DELETE /v1/all` | **XS** |

Coste de infraestructura: despreciable. Cada emparejamiento son unas 3 escrituras D1 y unas 10
lecturas, sin R2.

## 7. Riesgos y migración de quien ya usa el sync

- **Enlaces `#pair=` ya enviados:** se siguen aceptando durante un tiempo (propuesta: hasta el
  lanzamiento público de Plus) y luego se retiran, porque son credenciales permanentes. La app deja
  de generarlos en cuanto sale F2.
- **Espacios fantasma ya creados (como el del PC de Luis):** no se pierde nada. Emparejar ese
  dispositivo con el espacio bueno hace merge por unión y sube lo local. El espacio huérfano se queda
  en el servidor bajo la otra licencia. Se puede ofrecer «Borrar el sync de esta licencia» o dejarlo
  a la purga.
- **Activaciones de Polar:** cada `License.activate` desde un enlace gasta una de las 5. Con
  emparejamientos de un solo uso es más fácil repetirlos, así que el diálogo debería decir qué
  dispositivo se añade y el panel de Licencia, cuántas quedan.
- **El Worker se despliega antes que la app** (regla del repo). Si el relevo falla, el QR no sale:
  el diálogo enseña «No se pudo crear el enlace» y no vuelve en silencio al enlace permanente.
- **Merge a ciegas de lo local:** fuera de esta propuesta. Si preocupa, F1 puede añadir a la pregunta
  «Este dispositivo tiene {n} libros: se suman a tu biblioteca».
- **Nada que migrar en los datos:** el modelo de cifrado, `userIdOf` y la clave no cambian. 2b solo
  añade un fichero cifrado más por espacio.

## 8. Textos de UI (español)

**Dispositivo con sync (antes «Enlace para otro dispositivo»)**
- Botón: «Añadir un dispositivo»
- Diálogo, título: «Añadir un dispositivo»
- Cuerpo: «Escanea este código con el otro dispositivo, o ábrele el enlace. Vale para un solo dispositivo durante 10 minutos.»
- Cuenta atrás: «Caduca en {min}:{seg}»
- Botón secundario: «Copiar enlace»
- Al copiar: «Enlace copiado. Ábrelo en el otro dispositivo antes de 10 minutos.»
- Al usarse: «Listo: {dispositivo} ya sincroniza contigo.»
- Caducado: «El código ha caducado. Crea otro cuando tengas el dispositivo a mano.» + «Crear otro»
- Error: «No se pudo crear el código. Comprueba la conexión e inténtalo otra vez.»

**Dispositivo nuevo**
- Recibiendo: «Conectando este dispositivo a tu sync…»
- OK: «Dispositivo añadido. Tus libros, notas y progreso ya están aquí.»
- Enlace usado o caducado: «Este enlace ya se usó o ha caducado. En tu otro dispositivo, ve a Ajustes → Datos → Añadir un dispositivo y crea uno nuevo.»
- Licencia distinta en el dispositivo: «Este dispositivo tiene otra licencia. Para unirlo a tu sync se usará la del otro dispositivo.» · [Usar esa licencia] [Cancelar]

**¿Primer dispositivo? (al pulsar «Activar el sync de BookReader» con el espacio vacío)**
- Título: «¿Ya usas el sync en otro dispositivo?»
- Cuerpo: «Si ya lo tienes en otro móvil u ordenador, conecta este a ese sync para no empezar uno vacío.»
- [Sí, ya lo uso en otro] → «En tu otro dispositivo, ve a Ajustes → Datos → Añadir un dispositivo y escanea el código. Si no lo tienes a mano, escribe aquí tu clave de recuperación.»
- [No, es el primero] → crea la clave como hoy.

**Clave de recuperación**
- Clave con licencia distinta (2a): «Esta clave es de un sync abierto con otra licencia. Pon aquí la misma licencia que en tus otros dispositivos (Ajustes → Licencia) y vuelve a probar.» · [Ir a Licencia]
- Clave que no es de ningún sync: «Esa clave no abre ningún sync. Revisa que esté entera y sea la última que guardaste.»
- Sustituye a «Con la licencia de este dispositivo no hay nada sincronizado. Usa en los dos la misma licencia.»

**Panel «hace falta la clave» (reescrito)**
- «Este sync ya tiene datos de otro dispositivo. Para verlos aquí, añade este dispositivo desde el otro (Ajustes → Datos → Añadir un dispositivo) o escribe tu clave de recuperación.»

**Empezar de cero**
- «Tu sync tiene {n} ficheros que solo se pueden leer con la clave perdida. Si los borras, lo que no esté en este dispositivo se pierde para siempre. Antes, descarga un backup de este dispositivo.» · [Descargar backup] [Borrar y empezar]

**Guardar la clave (con 2b)**
- «Con esta clave se puede abrir tu sync en cualquier dispositivo, sin nada más. Guárdala donde guardas tus contraseñas.»
