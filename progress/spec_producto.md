# Ajustes de producto (fase 6, fuera de docs/saas/)

Pedidos por el humano el 2026-09-14 sobre el programa SaaS ya completo
(`feat/saas-multiempresa` @ 0e85b2d). Rama `saas/producto`, worktree
`.claude/worktrees/producto`. Cuatro features en serie, en este orden, porque
comparten `messages/*.json`: p6.1 → p6.2 → p6.3 → p6.4.

Supuestos del líder (revisables por el humano):
- S-P1. El nombre visible pasa a «Cabbity CRM»; el `name` de `package.json` (`wacrm`), el
  `project_id` de Supabase, los nombres de ramas, el repositorio y las variables de entorno
  no cambian (CP5 y coste sin beneficio para el usuario).
- S-P2. Solo cambia el precio del plan `inicio`: 35 USD/mes. El anual mantiene el descuento
  relativo actual (anual = mensual × 10 → 350). `pro` y `negocio` siguen en 79/790 y 199/1990.
- S-P3. El idioma por defecto pasa a español; inglés y coreano siguen disponibles. CP6 pasa a
  exigir `messages/es.json`, `messages/en.json` y `messages/ko.json` con el mismo conjunto de
  claves.

## 1. Renombrar a Cabbity CRM (`p6.1`)

Todo texto visible para el usuario que hoy diga «WaCRM», «wacrm» o variantes pasa a
«Cabbity CRM»: `<title>` y `metadata` de Next, catálogos `messages/en.json` y `messages/ko.json`
(y `es.json` cuando exista), correos/plantillas que salgan de la app, textos de onboarding,
nombre del producto en PayPal (`PAYPAL_PRODUCT_NAME` por defecto) y en el mensaje de
transición de la IA si lo menciona. No se tocan identificadores técnicos (S-P1).

Criterios:
- [ ] `grep -rniE "wa ?crm" src messages` no devuelve ningún texto visible; los restos son
      identificadores técnicos justificados uno a uno en el informe.
- [ ] Test que fija el título/metadata con «Cabbity CRM».

## 2. Banner del tiempo restante del trial (`p6.2`)

En la cabecera del dashboard (`src/components/layout/header.tsx`), visible para todos los
miembros de una cuenta cuya suscripción esté en `trialing`: «Tu prueba termina en N días»
(y «hoy» cuando quede menos de un día), con un enlace a `/billing` para elegir plan. Desaparece
al contratar. Cuando la prueba ha vencido y la cuenta ya no está `trialing`, no aparece (la
escalera de la fase 3 ya tiene sus avisos). Lee el estado por el mismo camino que la pantalla de
suscripción (f3.5), sin consulta nueva por página: reutiliza o extiende el resumen de cuenta que
ya expone `use-auth`/`account`. Precedente de banner: `impersonation-banner.tsx`.

Criterios:
- [ ] Con `trialing` y `trial_ends_at` a 5 días → banner con «5 días» y enlace a `/billing`.
- [ ] Con `active` → sin banner. Con `trialing` vencido pero aún no procesado → «hoy».
- [ ] Textos en los catálogos exigidos por CP6.

## 3. Plan Inicio a 35 USD (`p6.3`)

Migración `059_plan_inicio_35.sql`, idempotente: `UPDATE plans SET price_usd_month = 35,
price_usd_year = 350 WHERE id = 'inicio'`. Aserción en `verify-schema.sql`. Si el catálogo de
PayPal ya tuviera planes creados (`provider_plan_id_*` no nulos), el precio en PayPal NO se
edita: se documenta en el informe que hay que crear planes versionados nuevos con el bootstrap
de f3.1 (los planes de PayPal son inmutables con suscriptores). En local no hay ninguno.

Criterios:
- [ ] Tras el replay, `plans` muestra inicio 35/350, pro 79/790, negocio 199/1990.
- [ ] La UI de `/billing` y de Ajustes → Suscripción muestran 35 sin cambio de código (leen de
      `plans`); test si algún texto tenía el precio fijo.

## 4. Español por defecto (`p6.4`)

Crear `messages/es.json` con exactamente las mismas claves que `messages/en.json`, traducido
al español neutro, con el mismo formato ICU (plurales, variables) y sin dejar claves en inglés.
`NEXT_PUBLIC_APP_LOCALE` pasa a valer `es` por defecto en `src/i18n/request.ts`; inglés y
coreano siguen disponibles cambiando la variable. Actualizar `CHECKPOINTS.md` (CP6) y los
contratos de `implementer.md`/`reviewer.md` para exigir los tres catálogos. El test existente
`src/i18n/messages.test.ts` debe cubrir `es` (mismas claves, mismos placeholders que `en`).

Criterios:
- [ ] `messages.test.ts` verde con `es` incluido: mismo conjunto de claves y mismos
      placeholders ICU que `en`.
- [ ] Con la variable sin definir, la app arranca en español; con `en` o `ko`, en esos idiomas.
- [ ] Ninguna clave de `es.json` es idéntica a la de `en.json` salvo nombres propios, siglas y
      valores que no se traducen (lista en el informe).
- [ ] `docs/docker.md` documenta el nuevo valor por defecto.

## 5. Nombres de usuario de WhatsApp y BSUID (`p6.5`, investigado; pendiente de decisión)

Contexto verificado el 2026-09-14 contra la documentación de Meta
(`developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids/`):

- Desde abril de 2026 todo webhook de mensajes trae `contacts[].user_id` (BSUID) y
  `messages[].from_user_id`, **siempre**; `contacts[].wa_id` y `messages[].from` (el teléfono)
  **se omiten** cuando el usuario usa nombre de usuario y no hemos interactuado con él en 30
  días ni está en nuestra libreta. `contacts[].profile.username` llega si lo tiene activado.
- El BSUID es único por par portafolio-de-negocio/usuario, con formato `CC.<hasta 128 alfanum>`
  (p. ej. `US.1349…`), y se regenera si el usuario cambia de número (llega un webhook de sistema).
- Enviar a un BSUID: campo `recipient` en lugar de (o además de) `to`; si van ambos, gana `to`.
  Disponible en la API desde julio de 2026.
- Los webhooks de estado traen `recipient_user_id` siempre y `recipient_id` (teléfono) solo si
  enviamos al teléfono.
- Si el usuario comparte su teléfono (botón `REQUEST_CONTACT_INFO` en plantillas, o compartir
  contacto), Meta lo añade a la «libreta» del negocio y vuelve a incluirlo en los webhooks.

Cómo nos afecta hoy: `src/app/api/whatsapp/webhook/route.ts` hace `normalizePhone(message.from)`
y `findOrCreateContact` por teléfono; sin `from`, el entrante se descarta o se crea un contacto
sin teléfono válido, y toda la salida (`meta-api.ts`, `to: string`) exige teléfono. La ventana
de 24 h, el ciclo de vida de difusiones por `recipient_id` y la API pública (`to` en E.164)
también asumen teléfono.

Cambio propuesto (una feature, con migración `060`):
1. `contacts`: columnas `wa_user_id` (BSUID, texto, índice único por `(account_id, wa_user_id)`)
   y `wa_username`; `phone` pasa a ser nullable con la invariante «teléfono o BSUID, al menos uno».
   Backfill: nada (los BSUID llegan con el tráfico).
2. Webhook: identificar al remitente por `from_user_id` **primero** y por `from` como
   complemento: si existe contacto con ese BSUID, actualizar teléfono/username si llegan; si no,
   buscar por teléfono (contactos anteriores) y guardarle el BSUID; si tampoco, crear el
   contacto con BSUID y username, sin teléfono. Guardar `username` para mostrarlo en la bandeja
   («@nombre») cuando no hay teléfono.
3. Envío (`meta-api.ts` y `send-message.ts`): `to` si hay teléfono, `recipient` si solo hay
   BSUID; estados por `recipient_user_id` además de `recipient_id`; difusiones: destinatarios
   por BSUID cuando falte teléfono.
4. Bandeja/contactos: mostrar `@username` o «Sin número» donde hoy va el teléfono; búsqueda por
   username; la API pública acepta `to` (E.164) o `to_user_id` (BSUID).
5. Plantilla con botón `REQUEST_CONTACT_INFO` opcional para pedir el teléfono cuando un flujo
   lo necesite (p. ej. exportar contactos).

Criterios:
- [ ] Un entrante sin `from` pero con `from_user_id` crea contacto y conversación y aparece en la
      bandeja con su `@username`; responder desde la bandeja envía con `recipient`.
- [ ] Un contacto existente por teléfono recibe su BSUID en el primer webhook que lo traiga, sin
      duplicarse; y uno creado por BSUID recibe el teléfono cuando Meta lo incluya.
- [ ] Los estados de entrega se casan por `recipient_user_id` cuando no hay `recipient_id`.
- [ ] Nada de esto rompe el camino actual con teléfono (tests existentes verdes) ni bloquea lo
      entrante (CP11).
