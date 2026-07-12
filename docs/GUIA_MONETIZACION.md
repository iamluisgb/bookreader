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
  72h del lanzamiento** y aplicado automáticamente vía URL de checkout
  (`?discount_code=LAUNCH`). Mejor cupón visible que bajar el precio: el tachado
  `$29 → $19` es parte del empuje de urgencia.

## Paso 4 — Benefit: license key

En el producto → *Benefits → Add benefit → License Keys*:

- **Prefijo**: `BKRD` (facilita soporte: se reconoce la key a simple vista).
- **Expiración**: ninguna (compra única de por vida — es el pitch anti-suscripción).
- **Activations limit**: **5** — es el "número de dispositivos". Cada navegador
  del usuario registra una activación; 5 cubre móvil+portátil+tablet con margen
  y frena el compartir la key en masa.
- Deja habilitado que el usuario pueda **desactivar instancias** desde el portal
  de cliente (libera hueco si cambia de máquina).

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
customer portal API:

- `POST https://api.polar.sh/v1/customer-portal/license-keys/activate`
  — primera vez en un dispositivo: `{ key, organization_id, label }` →
  devuelve una `activation.id`. Guardar `key` + `activation_id` en IndexedDB.
- `POST https://api.polar.sh/v1/customer-portal/license-keys/validate`
  — en arranques posteriores: `{ key, organization_id, activation_id }` →
  200 si sigue válida.

Reglas para BookReader (coherentes con local-first/offline):

- Validar **en background al arrancar**, no bloquear la app: si no hay red,
  **la última validación buena vale** (cachear `validatedAt` y aceptar hasta
  ~14-30 días offline). Un lector offline que se bloquea sin red mataría el pitch.
- Si la validación devuelve inválida/revocada → degradar a Free con aviso, no
  borrar datos.
- El `organization_id` es público (va en el frontend sin problema). No hay
  secretos de Polar en el cliente.
- Que alguien técnico lo crackee es irrelevante a esta escala (decisión ya
  tomada en `LAUNCH_PLAN.md`).

## Paso 7 — Verificación end-to-end (en sandbox)

En `sandbox.polar.sh` con el producto replicado:

1. Compra con tarjeta de test de Stripe (`4242 4242 4242 4242`).
2. Llega el email con la license key.
3. `activate` desde la app → `validate` en recarga → gate Pro abierto.
4. Sexta activación (límite 5) → error controlado y mensaje claro en la UI.
5. Desactivar una instancia desde el portal de cliente → la activación 6 ya entra.
6. Revocar la key en el dashboard → la app degrada a Free sin romper.
7. Reembolso de la compra de test → comprobar qué pasa con la key (debe quedar
   revocada) y que la app lo maneja.

Solo cuando todo esto pasa en sandbox, repetir producto+discount en producción.

## Checklist final

- [ ] Cuenta y organización creadas en polar.sh (y en sandbox)
- [ ] Payout account (Stripe Express, España, IBAN) verificada
- [ ] Producto BookReader Pro one-time $29 + discount LAUNCH −$10 con expiración 72h
- [ ] Benefit license key: prefijo, sin expiración, 5 activaciones
- [ ] Checkout link en la landing (embed/overlay después, con el gate)
- [ ] Validación de key integrada: activate/validate + tolerancia offline
- [ ] Los 7 puntos de verificación en sandbox pasan
- [ ] Gestor consultado sobre la declaración de los payouts de Polar (MoR)

## Apéndice — por qué no las otras

| Plataforma | Estado 2026-07 | Por qué no |
|---|---|---|
| Lemon Squeezy | En sunset hacia Stripe Managed Payments | Tienda nueva = migración forzosa inminente |
| Stripe Managed Payments | Preview público (feb 2026) | MoR sí, pero sin license keys nativas → backend propio |
| Paddle | Estable | Sin license keys nativas; approval lento |
| Gumroad | Estable | Fees ~10%, checkout peor para software; reservado a la pivotada nº 4 (bundle) |
