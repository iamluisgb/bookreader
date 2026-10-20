# Estrategia de precios de BookReader: revisión de la propuesta

> Investigación del 2026-10-20. **Lo decidido está en [ADR-060](../DECISIONS.md)**, que simplifica esta
> propuesta: Drive gratis, pruebas de 60 días, sin precio de lanzamiento de Plus, sin PPP ni referidos.

Leyenda: **[D]** dato verificado en una fuente (lista al final) · **[I]** inferencia mía.

## 1. Veredicto

La estructura es buena y hay que mantenerla: núcleo gratis, pago único para lo que no nos cuesta nada y suscripción solo para lo que sí cuesta. Es el modelo de Obsidian, que da la app gratis sin límites y cobra únicamente Sync y Publish [D]. Propongo seis cambios: los cinco primeros afectan a precio y empaquetado y el sexto, al mensaje.

**Mantener**
- **Pro como pago único de 29 $ y 19 $ de lanzamiento.** No genera coste recurrente, así que el pago único no pierde dinero con nadie. El público de iA Writer y Ulysses castiga la suscripción para funciones locales: el paso de Ulysses a suscripción en 2017 recibió muchas críticas [D]. Con las comisiones de Polar (5 % + 0,50 $), a 19 $ te quedan unos 17,5 $ netos y a 29 $, 27 $ [D, del repo].
- **BYOK gratis y sin límite.** Raycast hace lo mismo: 50 mensajes de regalo una sola vez y después tu propia key [D]. Para el público de HN es un argumento de confianza.
- **Plus como producto de lo recurrente.** El sync, el MCP remoto y la inferencia sí tienen coste.

**Cambiar**

1. **Plus a 7 $/mes o 60 $/año, en vez de 6 $ o 48 $.** Obsidian cobra solo por el sync 4 $/mes en el plan de 1 GB y 8 $/mes en el de 10 GB, ambos en facturación anual [D]. Plus da 10 GB **más** el MCP **más** IA por 4 $/mes en anual, la mitad que Obsidian Plus por menos producto. Readwise completo cuesta 9,99 $ anual y 12,99 $ mensual [D]. Con 60 $/año (5 $/mes) sigues por debajo de los dos y no pareces la opción barata. El mensual a 7 $ empuja hacia el anual. Además, los 0,50 $ fijos de Polar se comen el 13 % de un cobro de 6 $ y solo el 6 % de uno de 60 $ [I, calculado]. El descuento anual queda en un 29 %. Lo habitual en SaaS es un 16,7 % («dos meses gratis») [D, Recurly], pero aquí conviene inclinar la balanza hacia el anual por las comisiones fijas y la retención [I].
2. **Plus incluye Pro mientras pagas, y tras 12 meses pagados Pro queda tuyo para siempre.** Hoy dice «todo lo de Pro mientras dure», y eso huele a alquiler. Sketch y Panic Nova venden licencias que siguen funcionando aunque dejes de pagar las actualizaciones [D]. Aplicar esa idea quita el miedo a perderlo todo y elimina el agravio para quien deja Plus [I]. A quien ya tenga Pro se le mantiene el descuento: primer año a 45 $ (–25 %).
3. **El trial pasa a ser un *reverse trial* de Pro y un trial de Plus que arranca cuando hay intención.** Las funciones de Pro no nos cuestan nada, así que todo usuario nuevo puede tenerlas 14 días y después volver a gratis conservando lo que creó (tarjetas, mapas) en solo lectura o exportable. La cifra de que un reverse trial sube un 10–40 % la conversión freemium no tiene fuente primaria [no verificado]. Aun así, el mecanismo encaja: lo gratis ya es generoso y lo de pago se descubre usándolo [I]. Los 14 días de Plus **no** empiezan al instalar. Empiezan cuando el usuario pulsa «Conectar con Claude», «Sync» o agota la demo de IA.
4. **El trial de Plus sigue sin tarjeta, con un límite contra el abuso.** Los trials con tarjeta convierten mucho más (48,8 % frente a 18,2 % en B2B SaaS) pero captan de 3 a 4 veces menos registros [D, First Page Sage]. Sin cuentas ni tarjeta, el riesgo es que alguien encadene trials. Por eso el trial lleva un tope propio de inferencia (unos 0,50 $) y de almacenamiento (1 GB). Ligarlo a un email no rompe la promesa de no tener cuentas si el email solo se usa para emitir la licencia de prueba en Polar [I]. 14 días está bien: en RevenueCat la conversión del mensual se estanca a partir de 10–16 días, y las apps de IA convierten peor con trials más largos [D, datos de apps móviles con tarjeta].
5. **Lifetime y PPP solo para Pro, nunca para Plus.** Los relatos de AppSumo en Indie Hackers repiten el mismo patrón: el comprador de lifetime casi nunca pasa a recurrente y queda como cliente de soporte para siempre [D, anecdótico]. Un lifetime de Plus garantiza perder dinero con la inferencia y R2 [I]. Para la paridad de poder adquisitivo, Polar se integra con ParityDeals y crea cupones por país [D]. Aplícalo a Pro, que no tiene coste marginal, con descuentos de hasta el 50–60 %. En Plus, un 30 % como máximo, porque la IA y R2 se pagan en dólares. Estudiantes: un 40 % en todo, como Obsidian (40 %) y Readwise (50 %) [D].
6. **El MCP no lleva tier propio: es el titular de Plus.** Readwise ofrece un MCP alojado dentro de su plan de pago [D, fuente secundaria]. Granola da el MCP en el plan gratis limitado a 30 días de notas y reserva herramientas para el de pago [D]. En los dos casos el MCP es un gancho dentro del plan, no un complemento aparte. Un tercer SKU también rompe la regla de pocos tiers. El patrón de Granola ya lo tienes: MCP local de solo lectura gratis y MCP remoto con `search_library` y escritura en Plus. En la landing, Plus debe venderse como «Tu biblioteca entera dentro de Claude y ChatGPT, en todos tus dispositivos», no como «sync gestionado» [I].

## 2. Propuesta mejorada

| | **Gratis** | **Pro**: pago único | **Plus**: suscripción |
|---|---|---|---|
| Precio | 0 | **29 $** (19 $ las primeras 72 h) | **7 $/mes · 60 $/año** (lanzamiento: 48 $ el primer año para quien entre en las primeras 2 semanas) |
| Lector, subrayados, libreta, export, backup | ✓ | ✓ | ✓ |
| Agente con BYOK sin límite y demo de 30 llamadas | ✓ | ✓ | ✓ |
| MCP local de solo lectura | ✓ | ✓ | ✓ |
| Flashcards, Anki, repaso, mapas, infografías, plantillas, perfiles, libros vía Drive | 14 días (reverse trial) | ✓ para siempre | ✓, y tuyo para siempre tras 12 meses pagados |
| Sync E2E (10 GB) | | | ✓ |
| MCP remoto y búsqueda en toda la biblioteca | | | ✓ |
| Inferencia incluida | | | ✓ (tope, ver la regla) |

- **Trial de Plus:** 14 días sin tarjeta que arrancan al mostrar intención. Tope de prueba: 1 GB y unos 0,50 $ de inferencia.
- **Descuentos:** quien ya tenga Pro paga 45 $ el primer año de Plus. Estudiantes, –40 %. PPP con ParityDeals: hasta –60 % en Pro y –30 % en Plus. Referidos: +30 días de Plus por cada amigo que pague, como hace Readwise con su trial [D].
- **Lifetime:** no.

**Regla para los topes de IA**
1. Tope de coste: **el 25 % del ingreso neto mensual del plan**, unos 1,50 $ al mes con 60 $/año. Se revisa con datos reales a las 4 semanas. Hoy no está medido: la estimación de 0,005 $ por pregunta da unas 300 respuestas [I].
2. Se muestra en respuestas («~300 respuestas este mes») y nunca en tokens ni créditos, como ya fija ADR-031 §7. Las acciones caras anuncian su coste antes de lanzarse.
3. **Al llegar al tope, nada se rompe.** La app ofrece pasar a BYOK con un clic o esperar a la recarga, y nunca cobra excedentes automáticos. La crisis de Cursor en 2025 vino de cambiar «500 peticiones» por «20 $ de uso» sin explicarlo bien, con cobros inesperados que acabaron en reembolsos y disculpa pública [D]. Tener BYOK como red de seguridad es una ventaja que Cursor no tenía [I].
4. Si menos del 5 % llega al tope, se dice «uso normal sin preocuparte» y la cifra aparece solo en el medidor [I].

## 3. Riesgos

- **Tres ofertas confunden.** El paywall de cada función debe ofrecer una sola cosa: Pro en las funciones locales y Plus en sync, MCP e IA. La tabla completa solo aparece en /pricing [I].
- **Coste de inferencia sin medir.** Es el riesgo principal del margen. Con el peor caso de 2 $ al mes, el plan mensual de 7 $ deja unos 4 $ netos [I, calculado].
- **Trial sin tarjeta y sin cuentas.** Hay riesgo de que se encadenen. Se mitiga con el tope de prueba y la licencia ligada a un email.
- **Distribución.** El precio sostenible depende sobre todo de llegar a tu nicho. No encontré datos fiables de ventas tras un Show HN [hueco en la investigación]. Hay una oportunidad documentada: cerraron Omnivore (noviembre de 2024) y Pocket (julio de 2025), y sus usuarios se repartieron entre Readwise, Instapaper y alternativas autoalojadas [D]. Canales por orden de prioridad [I]:
  1. Show HN centrado en «local-first + MCP sobre tus libros».
  2. Directorios de MCP: Glama, Playbooks y el directorio de conectores de Claude.
  3. r/ObsidianMD, r/Anki, r/PKMS y el foro de Obsidian, con un caso de uso concreto y sin anuncios.
  4. Una página de migración desde Pocket u Omnivore.
  5. Product Hunt como canal secundario.

## 4. Qué medir los primeros 3 meses y cuándo cambiar

| Métrica | Umbral | Acción |
|---|---|---|
| Conversión de activos semanales a Pro | <1 % con más de 500 activos / >5 % | Revisar el paywall y el reverse trial / subir Pro a 39 $ |
| Conversión del trial de Plus a pago | <10 % / >25 % | Pedir tarjeta o acortar a 7 días / mantener |
| Parte de Plus en anual | <40 % | Reforzar el anual en el paywall |
| Coste de inferencia por usuario de Plus (p50 y p95) | p95 >2 $/mes | Bajar el tope o cambiar de modelo, nunca en silencio |
| % de usuarios de Plus que llegan al tope | >10 % | Subir el tope o crear un nivel superior |
| Churn mensual de Plus | >8 % | Encuestar al cancelar |
| Reembolsos | >5 % | El mensaje promete algo que el producto no da |
| Uso del MCP remoto en el trial y conversión de quien lo usa | Si convierte el doble que el resto | Llevarlo al hero de la landing |

Referencia de conversión [D, Lenny/Poyar, más de 1.000 productos]: en freemium self-serve, entre el 3 % y el 5 % es bueno y entre el 6 % y el 8 %, excelente. En trials, entre el 8 % y el 12 % es bueno y entre el 15 % y el 25 %, excelente. En apps móviles, freemium convierte de descarga a pago un 2,2 % de mediana frente al 12,1 % del paywall duro [D, RevenueCat 2025, vía resúmenes].

## Fuentes

- https://obsidian.md/pricing [D]: Sync a 4 $ anual o 5 $ mensual, estudiantes –40 %, Catalyst 25 $ como donativo
- https://obsidian.md/sync [D]: Standard 1 GB a 4 $ y Plus 10 GB a 8 $ (anual)
- https://readwise.io/pricing [D]: 9,99 $ anual o 12,99 $ mensual, Lite 5,59 $, trial de 30 días, +30 días por referido, estudiantes –50 %
- https://docs.readwise.io/tools/mcp [D] y https://contextbolt.com/blog/readwise-mcp/ [secundaria]
- https://www.granola.ai/blog/granola-mcp y https://www.layer3labs.io/guides/granola-mcp [D, MCP gratis limitado frente a pago]
- https://manual.raycast.com/billing y https://manual.raycast.com/ai/byoai.md [D]
- https://techcrunch.com/2025/07/07/cursor-apologizes-for-unclear-pricing-changes-that-upset-users/ [D]
- https://help.nova.app/faqs/purchasing/ · https://www.sublimehq.com/store/text [D]
- https://tidbits.com/2017/08/10/ulysses-writing-app-moves-to-subscription-pricing/ · https://9to5mac.com/2017/08/16/opinion-subscription-based-apps-future-implode/ [D]
- https://www.lennysnewsletter.com/p/what-is-a-good-free-to-paid-conversion [D, de pago, cifras vía resumen]
- https://www.revenuecat.com/blog/growth/free-trial-length [D, apps móviles, agosto de 2025 a julio de 2026]
- https://www.revenuecat.com/blog/growth/hard-paywall-vs-freemium · https://subscriptioninsider.com/article-type/news/revenuecats-state-of-subscription-apps-2025-report-ais-dominance-retention-challenges-and-the-shift-away-from-pure-subscriptions [D, secundaria]
- https://firstpagesage.com (vía https://www.shno.co/marketing-statistics/free-trial-conversion-statistics) [D, secundaria: 48,8 % frente a 18,2 %]
- https://recurly.com/research/saas-benchmarks-for-subscription-plans [D: descuento anual más común del 16,7 %]
- https://www.indiehackers.com/post/4-years-into-an-appsumo-lifetime-deal-the-unvarnished-math-and-a-question-i-m-stuck-on-4dd2b262ac · https://www.indiehackers.com/post/appsumo-pros-and-cons-after-over-200-000-in-sales-9cceeb46a9 [anecdótico]
- https://polar.sh/docs/features/integrations/paritydeals.md · https://www.paritydeals.com/integrations/polar/ [D]
- https://www.saasmag.com/reverse-trials-replacing-freemium-saas/ [no verificado: +10–40 % atribuido a Elena Verna]
- https://alternativeto.net/news/2025/5/after-17-years-mozilla-is-shutting-down-the-popular-bookmarking-tool-pocket-and-fakespot [D]

**Huecos:** no hay un dato verificado del porcentaje que elige el plan anual ni de ventas tras un Show HN o Product Hunt. Las cifras de RevenueCat son de apps móviles con trials que llevan tarjeta, así que no se trasladan tal cual a una PWA sin tarjeta.
