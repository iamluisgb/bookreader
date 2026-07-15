# Guía: cuenta en la plataforma de monetización (BookReader Pro)

> Objetivo: dejar operativa la plataforma de pagos para vender **BookReader Pro
> ($29 one-time, $19 precio de lanzamiento 72h)** según `LAUNCH_PLAN.md`, con los
> dos requisitos que fijó el plan: **Merchant of Record** (gestiona el IVA — clave
> facturando desde España) y **license keys con API de validación llamable desde
> el frontend** (la app no tiene backend propio de datos).

## Cambio respecto al LAUNCH_PLAN: Lemon Squeezy → Polar

El plan (2026-06) eligió Lemon Squeezy. Desde entonces el terreno cambió:

- Stripe compró Lemon Squeezy (2024) y en enero de 2026 LS confirmó que todo su
  futuro es la migración a **Stripe Managed Payments**, cuyo preview público abrió
  en febrero de 2026. Abrir una tienda nueva en LS hoy es construir sobre una
  plataforma en liquidación: migración forzosa en meses, con el gate de licencias
  ya integrado.
- **Stripe Managed Payments** es MoR pero **no tiene license keys nativas**:
  habría que generarlas y validarlas nosotros (más Worker, más superficie).
- **Paddle** es MoR sólido pero tampoco tiene license keys nativas y su approval
  de nuevos sellers es lento.
- **Polar** (polar.sh) cumple los dos requisitos tal cual: MoR + benefit de
  license keys con **endpoints públicos de validación/activación** (sin backend
  propio). Fees del plan Starter: **5% + $0.50** — exactamente las que asumía el
  plan para LS, así que el neto de ~$17-18 por venta a $19 **no cambia**. Extras:
  open source y muy conocida en el público de HN/indie (encaja con el
  posicionamiento del producto), checkout embebible, cupones para el precio de
  lanzamiento, y sandbox completo para probar sin dinero real.

**Decisión: Polar.** Gumroad queda intacto como pivotada nº 4 (bundle
infoproducto), no como plataforma principal.

---

## Paso 1 — Crear la cuenta y la organización

1. Ve a <https://polar.sh> → **Sign up**. Login con GitHub (recomendado: enlaza
   con el repo público y el perfil de indie dev) o Google/email.
2. Crea la **organización** (= la "tienda"): nombre `BookReader` (o la marca
   final), slug corto — aparece en las URLs de checkout y del portal de cliente.
3. En *Settings* de la organización completa identidad visual (logo, color):
   es lo que ve el comprador en el checkout.

> Crea también una cuenta en **sandbox.polar.sh** (entorno separado, mismas
> APIs): ahí se hace toda la integración antes de tocar producción.

## Paso 2 — Verificación de identidad y cobros (España)

Polar paga vía **Stripe Connect Express**. En *Finance → Payout account*:

1. País: **España**. Tipo: individual/autónomo (o SL si la tienes).
2. KYC de Stripe: DNI/NIE, dirección, y **IBAN** para los payouts.
3. Datos fiscales: al ser Polar el **Merchant of Record**, el cliente le compra
   a Polar y Polar te liquida a ti. Tú no emites factura a cada comprador ni
   gestionas el IVA de cada país; declaras lo que Polar te paga (ingreso por
   servicios a una empresa extranjera). Confírmalo con tu gestor, pero ese es
   exactamente el motivo por el que el plan exigía MoR.
4. La verificación puede tardar de minutos a 1-2 días. **Hazla el día 1**: sin
   payout account verificada no hay ventas reales. (Los primeros payouts pueden
   retenerse unos días extra, comportamiento estándar de Stripe con cuentas nuevas.)

## Paso 3 — Crear el producto "BookReader Pro"

En *Products → New product*:

- **Nombre**: BookReader Pro. Descripción corta orientada a beneficio
  ("Anki export, plantillas HQ&A, mapas mentales, quizzes, perfiles").
- **Pricing**: **One-time purchase**, **$29 USD**.
- **Precio de lanzamiento $19**: crea un **Discount** (*Products → Discounts*):
  tipo fixed amount −$10 (o percentage ~34%), con **fecha de expiración a las
  72h del lanzamiento**. Mejor cupón visible que bajar el precio: el tachado
  `$29 → $19` es parte del empuje de urgencia.
- **El cupón va pre-aplicado en el propio Checkout Link** (al crear el link en
  el dashboard, asóciale el discount; si la UI no lo permitiera, genera el link
  ya con `?discount_code=LAUNCH` y usa **siempre ese URL canónico**). No
  depender de que el tráfico lleve el parámetro: durante el lanzamiento la
  mayoría de visitas llegan por enlaces que no controlamos (HN, Reddit, boca a
  boca) y cualquier enlace desnudo mostraría $29 en plena ventana de $19. Al
  expirar las 72h, el mismo link vuelve solo a $29 — sin tocar nada.

## Paso 4 — Benefit: license key

En el producto → *Benefits → Add benefit → License Keys*:

- **Prefijo**: `BKRD` (facilita soporte: se reconoce la key a simple vista).
- **Expiración**: ninguna (compra única de por vida — es el pitch anti-suscripción).
- **Activations limit**: **5** — es el "número de dispositivos". Cada navegador
  del usuario registra una activación; 5 cubre móvil+portátil+tablet con margen
  y frena el compartir la key en masa.
- **Cuenta con activaciones "fantasma"**: si el navegador purga el storage (ver
  paso 6), el usuario re-activa sin haber cambiado de dispositivo y consume un
  slot nuevo. Por eso el límite es 5 y no 3, y por eso la desactivación
  self-service **no es opcional**.
- Deja habilitado que el usuario pueda **desactivar instancias** desde el portal
  de cliente (libera hueco si cambia de máquina o si una purga le quemó un slot).

El comprador recibe la key por email automáticamente y puede recuperarla siempre
en el portal de cliente de Polar (menos tickets de "he perdido mi licencia").

## Paso 5 — Checkout en la landing/app

Dos opciones, de menos a más integrado:

1. **Checkout Link** (0 código): URL generada en el dashboard → botón "Get Pro"
   en la landing. Suficiente para lanzar.
2. **Embed/overlay**: script de Polar para abrir el checkout encima de la app
   sin salir de ella — mejor conversión en el *paywall en el momento de
   intención* (prioridad nº 5 del plan). Se añade en la fase de gate de features.

Configura en *Settings → Webhooks* nada por ahora: **no hay backend que
escuchar**; el gate se resuelve 100% con la validación de license key del paso 6.

## Paso 6 — Validar la key desde el frontend (sin backend)

Polar expone endpoints **públicos** (pensados para clientes sin servidor) en el
customer portal API. **CORS verificado (2026-07-15)**: el preflight contra
`api.polar.sh` responde `access-control-allow-origin: *`, así que son llamables
desde GitHub Pages sin proxy — el supuesto arquitectónico central del plan se
sostiene.

- `POST https://api.polar.sh/v1/customer-portal/license-keys/activate`
  — primera vez en un dispositivo: `{ key, organization_id, label }` →
  devuelve una `activation.id`. Guardar `key` + `activation_id` en IndexedDB.
- `POST https://api.polar.sh/v1/customer-portal/license-keys/validate`
  — en arranques posteriores: `{ key, organization_id, activation_id }` →
  200 si sigue válida.

Reglas para BookReader (coherentes con local-first/offline):

- Validar **en background al arrancar**, no bloquear la app: si no hay red,
  **la última validación buena vale** (cachear `validatedAt` y aceptar hasta
  **30 días** offline — ventana única y fija; 14 días rozaría el pitch de
  lector offline). Un lector que se bloquea sin red mataría el posicionamiento.
- **`label` de activación legible**: `<navegador> · <SO>` (p.ej.
  `Safari · iPhone`). Es lo que el usuario ve en el portal de cliente al
  desactivar instancias — un label opaco convierte "libera un hueco" en un
  ticket de soporte.
- Si la validación devuelve inválida/revocada → degradar a Free con aviso, no
  borrar datos.
- El `organization_id` es público (va en el frontend sin problema). No hay
  secretos de Polar en el cliente.
- Que alguien técnico lo crackee es irrelevante a esta escala (decisión ya
  tomada en `LAUNCH_PLAN.md`).

### La purga de storage quema activaciones — mitigación en 3 frentes

Safari (ITP) borra IndexedDB/localStorage de webs **no instaladas** tras ~7 días
sin uso; otros navegadores purgan bajo presión de disco. La key y el
`activation_id` se pierden **juntos**, así que el usuario re-introduce la key y
consume un slot nuevo sin haber cambiado de dispositivo. Con límite 5, un lector
de iPhone que deja la app unas semanas puede agotarlos. Mitigación:

1. **El error de límite de activaciones nunca es un callejón sin salida**: el
   mensaje explica el porqué ("¿has borrado datos de navegación o reinstalado?")
   y enlaza **directamente al portal de cliente de Polar** para desactivar la
   instancia vieja y reintentar.
2. **La key + `activation_id` entran en el export/import de backup** (`.json`
   del LAUNCH_PLAN): restaurar un backup restaura la licencia **sin quemar
   activación** (validate con el `activation_id` restaurado, no re-activate).
3. **Empujar la instalación como PWA al activar Pro** ("instala BookReader para
   que tu licencia y tus libros no dependan de la limpieza del navegador"):
   una PWA instalada queda exenta de la purga de ITP y de paso mejora retención.

## Paso 6b — El trabajo de código tiene ticket propio: MON2

Esta guía cubre la plataforma; la contraparte en la app (módulo de licencia, UI
en Settings, puntos de gate por feature, paywall en momento de intención,
backup de la key, tests) está despiezada en **[BACKLOG.md → MON2](../BACKLOG.md)**
(`M`, ~1 día, coherente con la estimación del LAUNCH_PLAN). Nada de esto se
improvisa durante la semana de lanzamiento.

> **Enlace con el gateway (MON1):** cuando exista el gateway de tokens, los
> tokens Pro se emitirán contra la license key de Polar (el gateway la valida
> server-side y emite el token con routing al modelo bueno). MON2 no lo
> implementa, pero su módulo de licencia debe **exponer la key** para ese flujo
> futuro. Detalle en la ficha de MON1.

## Paso 7 — Verificación end-to-end (en sandbox)

En `sandbox.polar.sh` con el producto replicado:

1. Compra con tarjeta de test de Stripe (`4242 4242 4242 4242`).
2. Llega el email con la license key.
3. `activate` desde la app → `validate` en recarga → gate Pro abierto.
4. Sexta activación (límite 5) → error controlado con enlace al portal de
   cliente; desactivar una instancia desde ahí y reintentar debe funcionar.
5. Simular purga de storage (borrar IndexedDB a mano) → restaurar backup
   `.json` → la licencia vuelve **sin** consumir activación nueva.
6. Revocar la key en el dashboard → la app degrada a Free sin romper.
7. Reembolso de la compra de test → comprobar qué pasa con la key (debe quedar
   revocada) y que la app lo maneja.

Solo cuando todo esto pasa en sandbox, repetir producto+discount en producción.

## Checklist final

- [ ] Cuenta y organización creadas en polar.sh (y en sandbox)
- [ ] Payout account (Stripe Express, España, IBAN) verificada
- [ ] Producto BookReader Pro one-time $29 + discount LAUNCH −$10 con expiración 72h
- [ ] Discount **pre-aplicado en el Checkout Link** (no depender de `?discount_code=` en la URL)
- [ ] Benefit license key: prefijo, sin expiración, 5 activaciones
- [ ] Checkout link en la landing (embed/overlay después, con el gate)
- [ ] MON2 implementado (BACKLOG): módulo licencia + gate + paywall + key en backup
- [ ] Validación de key integrada: activate/validate + ventana offline 30 días
- [ ] Los 7 puntos de verificación en sandbox pasan (incluida purga + restore de backup)
- [ ] Gestor consultado sobre la declaración de los payouts de Polar (MoR)

## Situación fiscal en España (sin estar dado de alta como autónomo)

> Orientación, no asesoría. Confirmar con gestor antes de activar ventas reales.

"Darse de alta" son **dos organismos distintos** con costes y reglas diferentes:

### 1. Hacienda — alta censal (modelo 036/037): obligatoria y gratis

- Para ejercer actividad económica (aunque sea una venta de $19) la ley exige
  estar en el censo de empresarios **antes de empezar**. Se presenta online con
  Cl@ve/certificado digital en ~10 minutos. **No tiene coste ni cuota mensual**
  (el IAE está exento para personas físicas).
- Sin alta censal y con ventas: sanción típica de ~400 € si hay inspección, más
  recargos por lo no declarado.
- Los payouts de Polar se declaran en el **IRPF** siempre (rendimientos de
  actividad económica), estés de alta o no. Con alta, toca además el **modelo
  130** trimestral (pagos fraccionados; trámite, no coste extra).
- Ventaja del modelo MoR: el cliente le compra a Polar → **no gestionas IVA de
  compradores ni OSS**. Tu única relación fiscal es con Polar (servicio a
  empresa de EE. UU., sin IVA español).

### 2. Seguridad Social — RETA (la cuota de ~200-300 €/mes): depende de la habitualidad

- La ley exige RETA cuando la actividad es *habitual*, sin definirlo con cifras.
  La jurisprudencia acepta que ingresos **esporádicos y bajos** (el SMI anual se
  usa como referencia orientativa, no es regla escrita) no obligan al alta.
- Con un puñado de ventas sueltas, riesgo real muy bajo. Con ventas continuadas
  mes a mes deja de haber debate: es habitual aunque el importe sea modesto.
- **Cuándo darse de alta**: con tracción real (el objetivo del plan, 55-60
  ventas, ya lo es). La **tarifa plana** (~87 €/mes el primer año) se paga con
  5-6 ventas/mes a ~$17 netos.

### El alta censal crea obligaciones aunque no vendas nada

Presentar el 036/037 no cuesta dinero, pero desde la fecha de alta **hay que
presentar las declaraciones periódicas aunque salgan a cero** (el 130
trimestral, y el 303/390 de IVA si el alta lo incluye). No presentar una
declaración obligatoria, aunque sea a cero, son ~200 € de multa por modelo
(100 € si se regulariza fuera de plazo sin requerimiento). Por tanto:

- **No darse de alta "por si acaso" con meses de antelación**: minimizar los
  trimestres vacíos que declarar. Dos timings posibles:
  - *Estricto (riesgo cero)*: 036 con fecha de inicio justo antes de activar el
    checkout — la lectura literal es que "poner el producto a la venta" ya es
    inicio de actividad.
  - *Pragmático (lo habitual en indie)*: activar el checkout y presentar el 036
    **el mismo día de la primera venta**, con esa fecha de inicio. Polar no
    exige ser autónomo ni empresa para el alta (KYC de particular: DNI + IBAN
    personal), y el payout llega días después de la venta, así que el alta
    siempre puede preceder al cobro. La exposición real de esta ventana es
    mínima: si no hay ventas, no hay hecho imponible que inspeccionar.
- Si el lanzamiento no arranca, se presenta la **baja censal** (otro 036/037,
  también gratis) y se acaban las obligaciones.
- Pedir al gestor que configure el alta con las mínimas obligaciones posibles
  para este caso (servicios a empresa no establecida en la UE).

### Plan de acción resumido

1. Justo antes de activar el checkout de Polar → alta censal 036/037 (gratis).
2. Presentar los trimestrales (130 y, si aplica, 303) aunque sean a cero, y
   declarar los ingresos en la renta.
3. RETA con tarifa plana en cuanto haya ventas recurrentes.

## Apéndice — por qué no las otras

| Plataforma | Estado 2026-07 | Por qué no |
|---|---|---|
| Lemon Squeezy | En sunset hacia Stripe Managed Payments | Tienda nueva = migración forzosa inminente |
| Stripe Managed Payments | Preview público (feb 2026) | MoR sí, pero sin license keys nativas → backend propio |
| Paddle | Estable | Sin license keys nativas; approval lento |
| Gumroad | Estable | Fees ~10%, checkout peor para software; reservado a la pivotada nº 4 (bundle) |
