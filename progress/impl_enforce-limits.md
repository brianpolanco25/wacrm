# Informe del implementer — f3.4 `enforce-limits`

Rama `saas/fase-3-facturacion`, worktree `.claude/worktrees/fase-3` (base `9adc3d5`).
Spec: `docs/saas/fase-3-facturacion.md` §4 «Aplicar los límites», §5 «Escalera de
vencimiento», «Lo que PayPal no hace» y «Criterios de aceptación».

## Commits

| SHA | Mensaje |
|---|---|
| `a6703da` | `feat: aplicar los límites del plan en los ocho puntos de la fase 3` |
| `16ccf85` | `feat: sembrar la prueba de 14 días sin romper la redención de invitaciones` |
| `1446796` | `fix: llevar el tope de difusión al núcleo y devolver las lecturas a las cuentas bloqueadas` |

Árbol limpio tras los tres commits. Nada pusheado; `main`, `dev` y
`feat/saas-multiempresa` intactos.

El tercer commit son las correcciones exigidas por `progress/review_enforce-limits.md`
(CHANGES_REQUESTED). Ver §«Correcciones tras la revisión» al final; el resto del informe
describe el estado final, no el original.

## Compuerta

Ejecutada en el worktree:

| Comando | Resultado |
|---|---|
| `npm run lint` | verde — 0 errores, 37 warnings (todos preexistentes, ninguno en archivos de esta feature) |
| `npm run typecheck` | verde |
| `TZ=UTC npm test` | verde — 105 archivos, 1193 tests (antes de la feature: 94 / 1068; antes de las correcciones: 103 / 1170) |
| `npm run build` | verde con las variables dummy de `docs/harness.md` |
| `scripts/replay-migrations.sh <worktree>` | salida 0 — 001→052 + `verify-schema.sql: OK` (las correcciones no tocan SQL; no se volvió a correr) |

## Arquitectura de la solución

Una capa nueva, `src/lib/billing/enforce.ts`, sobre la `entitlements.ts` de f0.3 (que
**no se toca**). Distingue dos clases de límite, y la distinción es el corazón del
diseño:

- **Límites de flujo** (`messages_out`, `ai_replies`, `broadcast_recipients`): se
  acumulan en `usage_counters` durante el mes natural. Se comprueban con `assertQuota`
  (f0.3, tal cual) y se suman con `recordUsage`, que envuelve la RPC `increment_usage`
  de la 041.
- **Límites de existencias** (`operators`, `numbers`, `knowledge_documents`): son un
  recuento de filas *ahora*. No son contadores: borrar un documento devuelve el hueco, y
  `usage_counters` —que solo sube— nunca podría expresarlo. Se comprueban con
  `assertStockLimit` contra un `count` en vivo y no se incrementa nada.

Errores tipados y su mapeo HTTP, en un solo sitio (`billingErrorPayload`), consumido
tanto por `toErrorResponse` (rutas del panel) como por `toApiErrorResponse` (sobre de
`/api/v1`):

| Error | HTTP | `code` | Campos |
|---|---|---|---|
| `QuotaExceededError` (f0.3) | 402 | `quota_exceeded` | `metric`, `limit`, `used`, `upgradeUrl` |
| `PlanLimitError` (nuevo) | 402 | `plan_limit_reached` | `metric`, `limit`, `used`, `upgradeUrl` |
| `FeatureNotAvailableError` (f0.3) | 402 | `feature_unavailable` | `feature`, `upgradeUrl` |
| `AccountLockedError` (nuevo) | 403 | `account_read_only` | `subscriptionStatus`, `upgradeUrl` |

`upgradeUrl` siempre `/billing`: el criterio de aceptación pide que el error diga **qué
límite** y **cómo ampliarlo**, no solo que se deniega.

### §5, la escalera, vive en `requireRole`

`requireRole(min)` con `min > 'viewer'` exige ahora `assertWritable(accountId)`. Una
cuenta `suspended`/`expired`/`past_due` pasada la gracia se comporta como si todos sus
miembros fueran `viewer`: se lee todo, no se escribe nada. **No se toca
`profiles.account_role`**, así que al regularizar vuelven los roles reales sin ningún
paso de reparación. `min === 'viewer'` corta antes: una lectura es una lectura, y así
ninguna ruta de listado paga el viaje a la capa de permisos.

`RequireRoleOptions.allowReadOnly` es la única excepción y solo la usa
`/api/billing/checkout` (POST y GET): pagar la factura es la salida del bloqueo, y una
cuenta suspendida que no pudiera llegar a su propio checkout quedaría encerrada — el
botón «Fix billing» del aviso devolvería un 403.

## Trazabilidad: los ocho puntos de §4

| Punto del spec | Dónde | Métrica/prestación | Test |
|---|---|---|---|
| `POST /api/account/invitations` | `route.ts` tras `requireRole('admin')` | `operators` (existencias: miembros + invitaciones vivas) | `src/app/api/account/invitations/route.test.ts` |
| `/api/whatsapp/send` | `sendMessageToConversation` (núcleo compartido) | `messages_out` | `src/lib/whatsapp/send-message.test.ts`, `src/app/api/whatsapp/send/route.test.ts` |
| `engineSendText` | `src/lib/flows/meta-send.ts` y `src/lib/automations/meta-send.ts` | `messages_out` | `src/lib/flows/meta-send.test.ts`, `src/lib/automations/meta-send.test.ts` |
| difusión (los tres caminos) | `src/lib/whatsapp/broadcast-core.ts` (`createBroadcast`/`deliverBroadcast`) + campaña completa en `/api/whatsapp/broadcast` | `broadcast_recipients` | `broadcast-core.test.ts`, `whatsapp/broadcast/route.test.ts`, `v1/broadcasts/route.test.ts`, `whatsapp/broadcast/[id]/resume/route.test.ts` |
| `dispatchInboundToAiReply` | `src/lib/ai/auto-reply.ts` | `ai_replies` + `ai_autoreply` | `src/lib/ai/auto-reply.test.ts` |
| `requireApiKey` (`/api/v1`) | `src/lib/auth/api-context.ts` | prestación `api` (+ solo lectura en métodos de escritura) | `src/lib/auth/api-context.test.ts` |
| `/api/v1/webhooks` | `route.ts`, GET y POST | prestación `webhooks` | `src/app/api/v1/webhooks/route.test.ts` |
| `/api/whatsapp/config` | `route.ts` (esta ruta no usa `requireRole`) | `numbers` + bloqueo de solo lectura explícito | `src/app/api/whatsapp/config/route.test.ts` |
| `/api/ai/knowledge` | `POST` | `knowledge_documents` | `src/app/api/ai/knowledge/route.test.ts` |

### Criterio ↔ test (los de la fase que tocan a esta feature)

| Criterio de aceptación | Archivo | `it` |
|---|---|---|
| «Superar `messages_out` bloquea el envío con un error que dice qué límite se alcanzó y cómo ampliarlo» | `src/app/api/whatsapp/send/route.test.ts` | *"402s over messages_out, naming the metric, the limit and where to raise it"* — comprueba `code`, `metric`, `limit`, `used`, `upgradeUrl` y que el texto nombra la métrica |
| ídem, a nivel del núcleo | `src/lib/whatsapp/send-message.test.ts` | *"refuses the send when the monthly allowance is spent — Meta is never called"* |
| «Una cuenta `suspended` no puede enviar, difundir ni usar IA» | `src/app/api/whatsapp/send/route.test.ts` | *"403s an admin of a suspended account — every member behaves as a viewer"* |
| | `src/lib/auth/account.test.ts` | *"refuses an OWNER of a locked account — everyone drops to viewer"* |
| | `src/lib/ai/auto-reply.test.ts` | *"does not reply while the account is read-only"* |
| | `src/app/api/whatsapp/broadcast/route.test.ts` | *"402s over the limit and sends to nobody"* (el bloqueo por suspensión llega vía `requireRole`, probado en `account.test.ts`) |
| «Una cuenta `suspended` **sigue recibiendo** mensajes entrantes» (CP11) | `src/app/api/whatsapp/webhook/route.test.ts` | *"stores the inbound message with the subscription suspended and every quota spent"* y *"never asks the billing layer anything while storing an inbound"* |
| «Un usuario autenticado no puede modificar su propia suscripción ni sus contadores, comprobado contra la RLS» | base real | `progress/checks_enforce-limits.sql` parte G |
| «Los roles reales no se tocan» (§5) | `src/lib/auth/account.test.ts` | *"does not rewrite the member's real role"* |
| «La contratación sigue siendo posible con la suscripción vencida» (§5, botón para regularizar) | `src/app/api/billing/checkout/route.test.ts` | *"lets a SUSPENDED account reach its checkout — it is the way out of the lock"* |
| Contar **después** del éxito, nunca antes | `send-message.test.ts` *"does not count a send that failed to persist"*; `flows/meta-send.test.ts` *"does not count a send whose row failed to persist"*; `broadcast/route.test.ts` *"counts only the recipients that actually received the message"*; `auto-reply.test.ts` *"does not count when the send itself throws"* |
| «La clave de plataforma también es cobrable» (f0.4, `keySource`) | `src/lib/ai/auto-reply.test.ts` | *"counts a reply paid for with the PLATFORM key exactly the same"* |
| `trialing` puede contratar | `src/app/api/billing/checkout/route.test.ts` | *"lets a trialing account contract"* |

`src/lib/billing/enforce.test.ts` (26 tests) cubre la capa en sí: la escalera de estados
en `assertWritable` (incluida la gracia de `past_due` por ambos lados), `assertPlanFeature`,
los bordes de `assertStockLimit` (`used + n > limit`, `null` = sin límite, métrica
desconocida), `recordUsage` (argumentos exactos de la RPC, delta ≤ 0, y que se traga
errores y excepciones) y el cuerpo que sale por el cable.

**Tests de fuga entre cuentas** (CP3), uno por punto que consulta con rol de servicio:
`enforce.test.ts` × 3 (`assertWritable`, `assertPlanFeature`, `recordUsage`),
`invitations/route.test.ts`, `ai/knowledge/route.test.ts`, `whatsapp/config/route.test.ts`,
`v1/webhooks/route.test.ts`, `flows/meta-send.test.ts`, `automations/meta-send.test.ts`,
`auto-reply.test.ts`, `broadcast/route.test.ts`, `billing/status/route.test.ts`.

## Migraciones

### `046_seed_trials.sql`

- `trial_period()` — la duración en un solo sitio (14 días).
- `seed_account_trial()` + trigger `on_account_created_seed_trial` `AFTER INSERT ON
  accounts`. Cubre los **dos** caminos por los que nace una cuenta: `handle_new_user()`
  (017) y `remove_account_member()` (018). `SECURITY DEFINER` y `OWNER TO postgres`
  porque `subscriptions` tiene RLS sin política de escritura. Bloque `EXCEPTION` como el
  de `handle_new_user`: un fallo sembrando la prueba no puede impedir un alta.
- Retroactivo: una fila por cada cuenta existente, con los 14 días contados **desde el
  despliegue**, no desde `accounts.created_at` — contarlos desde el alta dejaría a todos
  los clientes actuales con la prueba vencida el mismo día.
- Plan de la prueba: `pro`, el mismo que ya devolvía `getEntitlements()` para una cuenta
  sin fila. Aplicar la migración no cambia lo que nadie puede hacer: es una
  materialización, no una decisión nueva.

### `052_redeem_invitation_billing.sql`

El aviso 1 del encargo, resuelto. Con la 046 sembrando una fila por cuenta, el
`DELETE FROM accounts` de `redeem_invitation()` chocaba con el `ON DELETE RESTRICT` de la
041 y **nadie podía aceptar una invitación**. La 052 enseña a la función qué significa
cada fila (mismo criterio que la 049 con `checkout_intents`):

- `subscriptions` en `trialing` y sin `provider_subscription_id` → la prueba que se sembró
  sola. No es dato del cliente: se borra con la cuenta.
- `subscriptions` en cualquier otro estado o con identificador de la pasarela → hubo
  contratación. Cuenta como «tu cuenta ya contiene datos» y la invitación se rechaza con
  23505, igual que si hubiera contactos.
- `usage_counters` con `value > 0` → consumo medido, dato contable → cuenta como datos.
- `usage_counters` con `value = 0` → fila espuria; se borra.

No se aflojó ninguna FK.

### `supabase/ci/verify-schema.sql`

Siete aserciones nuevas: el trigger `on_account_created_seed_trial` sobre `accounts`,
`seed_account_trial()`, `trial_period()`, la existencia del plan `pro` en el catálogo (sin
él el trigger falla en silencio, porque su `EXCEPTION` solo avisa) y que `prosrc` de
`redeem_invitation()` menciona `subscriptions` y `usage_counters`.

## Verificaciones contra base real

`progress/checks_enforce-limits.sql`, corrido contra el Postgres del harness
(`KEEP=1 scripts/replay-migrations.sh`), salida silenciosa = todo pasó, exit 0. Las
cuentas se crean siempre por el camino real (INSERT en `auth.users` → `handle_new_user()`),
nunca insertando `accounts` a mano.

| Parte | Qué comprueba |
|---|---|
| A | Un alta normal nace con su prueba: `pro`, `trialing`, sin id de pasarela, `trial_ends_at` a ~14 días, exactamente una fila |
| B | Reejecutar la semilla no devuelve a `trialing` ni renueva la prueba de quien ya paga |
| C | **`redeem_invitation()` con la prueba sembrada acepta**: devuelve la cuenta anfitriona, borra la cuenta personal y su prueba, mueve el perfil y deja intacta la suscripción del anfitrión |
| D | Y protege lo que sí es facturación: 23505 con suscripción real (D1) y con consumo medido (D2); un contador a cero no bloquea y se borra (D3/D4) |
| E | `confdeltype = 'r'` en las dos FK — control negativo de C: si alguien las aflojara a CASCADE, la 052 dejaría de hacer falta sin que nadie se enterase |
| F | `increment_usage` sigue siendo solo de `service_role` (`authenticated` y `anon` sin EXECUTE) |
| G | Con `SET LOCAL ROLE authenticated`: el miembro **lee** su suscripción pero no la actualiza (0 filas), no puede insertar en `usage_counters` y no puede llamar a `increment_usage` |

**Controles negativos ejecutados** (para que las comprobaciones no sean vacuas):

1. Revertí `redeem_invitation()` a la versión de la 049 y volví a correr el fichero: falló
   exactamente con
   `update or delete on table "accounts" violates foreign key constraint
   "subscriptions_account_id_fkey"`, es decir el 23503 que el encargo anticipaba.
   Restaurada la 052, vuelve a pasar.
2. Borré el trigger `on_account_created_seed_trial` y corrí `verify-schema.sql`: falló con
   `on_account_created_seed_trial is missing on accounts (migration 046)`. Recreado,
   vuelve a dar `schema verification passed`.

## Verificaciones manuales pendientes

Nada de esto se puede automatizar aquí: depende de PayPal o de Meta.

1. **La escalera completa contra el sandbox de PayPal.** En el entorno de pruebas:
   contratar → forzar un `PAYMENT.FAILED` → comprobar que la app muestra el aviso
   «A payment did not go through» con la fecha de `grace_until` y que enviar sigue
   funcionando → esperar/forzar el paso a `suspended` → comprobar que el aviso pasa a
   «This account is read-only», que `/api/whatsapp/send` devuelve 403
   `account_read_only`, que `/billing` **sí** abre y que el botón «Fix billing» lleva
   allí → reactivar y comprobar que todo vuelve sin tocar roles.
   **Los dos peldaños comparten color**: `src/components/ui/alert.tsx` solo tiene
   `default` y `destructive`, y `billing-status-alert.tsx` usa `destructive` para ambos.
   Lo que hay que distinguir es el **icono y el título**, no un ámbar que no existe.
   Comprobar también, con la cuenta ya `suspended`, que `/api/ai/usage` y
   `/api/account/invitations` siguen respondiendo 200 en el navegador (§5: solo lectura,
   no ceguera).
2. **CP11 contra Meta de verdad.** Con la cuenta en `suspended`, enviar un mensaje al
   número del inquilino desde un WhatsApp real y comprobar que aparece en la bandeja.
   El test de vitest lo garantiza estructuralmente (el webhook no consulta la capa de
   facturación) pero no sustituye a ver el mensaje entrar.
3. **`numbers` con varios números.** Hoy `whatsapp_config` tiene `UNIQUE(account_id)`, así
   que el recuento es 0 o 1 y ningún plan puede tocar el tope. La comprobación está
   escrita contra el recuento y no contra el UNIQUE precisamente para que siga
   significando algo cuando f4.2 lo retire; hasta entonces solo se puede probar
   artificialmente (bajando `numbers` a 0 en `plans`).

## Decisiones donde el spec era ambiguo

1. **`messages_out` va en `sendMessageToConversation`, no en la ruta.** El spec nombra
   `/api/whatsapp/send`, pero ese núcleo lo comparte con `POST /api/v1/messages`. Un tope
   que solo honra el panel no es un tope. Es un superconjunto del spec, a favor del
   límite.
2. **Los demás `engineSend*` llevan el mismo control que `engineSendText`.** El spec
   nombra solo `engineSendText`, pero dejar `engineSendMedia`, `engineSendInteractive*` y
   `engineSendTemplate` sin contar convertiría el tope en una sugerencia: bastaría mandar
   un mensaje de botones en vez de texto para que saliera gratis. Son cuatro puntos de
   estrangulamiento en total (los dos `meta-send.ts`), dos líneas cada uno.
3. **Una respuesta de IA cuesta `ai_replies` **y** `messages_out`.** Es la lectura literal
   de la tabla de §4, donde `engineSendText` está en la fila de `messages_out` y
   `dispatchInboundToAiReply` en la de `ai_replies`, y la IA envía por el primero.
4. **`operators` cuenta miembros + invitaciones pendientes.** Contar solo miembros dejaría
   que un admin de un plan de 3 asientos repartiera diez enlaces y que el tope lo
   descubriera quien canjea el cuarto, cuando ya no hay forma amable de negárselo.
5. **Los límites de existencias fallan cerrados.** Si el `count` no se puede tomar, la
   ruta devuelve 500. «No pudimos contar» nunca puede leerse como «no usas ninguno».
6. **`requireApiKey` aplica el modo solo lectura por método HTTP** (`GET`/`HEAD` pasan,
   el resto exige cuenta escribible). Es lo único que esa función sabe de la petición, y
   en `/api/v1` toda escritura es POST/PATCH/PUT/DELETE.
7. **La prueba no vence sola.** La 046 siembra `trial_ends_at` pero nada mueve `trialing`
   a `expired` cuando pasa. Bloquear por prueba vencida no está en el spec (la escalera de
   §5 arranca en `active` y la conduce PayPal) y haría que cualquier instalación
   autoalojada se quedara en solo lectura a los 14 días. Queda como deuda, abajo.
8. **El estado de solo lectura no se refleja aún en la interfaz por botón.** El aviso
   persistente explica qué pasa y el servidor devuelve 403 a cada intento; deshabilitar
   cada control del panel según la suscripción es trabajo de f3.5 (§6), no de §4/§5.

## Variables de entorno nuevas

Ninguna. No se tocó `docs/docker.md` ni `.env.local.example` (este último está bloqueado
por permisos de todos modos).

## Sobre prettier

`npx prettier --write` sobre los archivos tocados reformateaba por completo nueve
ficheros preexistentes que no llevan punto y coma (`src/lib/flows/meta-send.ts`,
`src/app/api/whatsapp/config/route.ts`, …): 2.173 líneas de diff para 358 de cambio real.
Deshice esa parte y dejé el formato original de los archivos que ya existían; los
**archivos nuevos** sí están al 100 % en estilo prettier (`prettier --check` limpio sobre
los doce). Es la misma deuda que anotaron f0.4 y f1.1; formatear el repo entero merece su
propio commit, no colarse en este.

## Deuda detectada, fuera de alcance (no arreglada)

1. **Nada vence una prueba.** `trial_ends_at` se siembra pero no se aplica: una cuenta en
   `trialing` conserva los límites de Pro indefinidamente. Hace falta un trabajo
   programado (o una comprobación perezosa en `isReadOnly`) que la mueva a `expired`.
   Decidirlo es de producto: hacerlo hoy dejaría en solo lectura a toda instalación
   autoalojada a los 14 días de aplicar la 046.
2. **`requireRole` con `min > viewer` hace dos consultas más por petición**
   (`subscriptions` + `plans`, dentro de `getEntitlements`). No hay caché por petición.
   Con volumen conviene memorizarlo por `accountId` durante la vida de la petición.
3. **Solapamiento con f1.5 (`ai-replies-counter`, fase 1).** Esa feature tiene como
   alcance justo el `increment_usage(account_id,'ai_replies',1)` que esta implementa. Al
   fusionar fase 1 con fase 3 habrá conflicto en `src/lib/ai/auto-reply.ts`; la versión
   correcta es la de aquí (incluye además la prestación y la cuota).
4. **`/api/whatsapp/config` sigue resolviendo su cuenta a mano** en vez de por
   `requireRole`, así que cada control (rol, solo lectura, límite) hay que escribirlo
   dos veces. Migrar la ruta a `requireRole('admin')` es un cambio que merece su propia
   revisión.
5. **Las escrituras de `/api/v1` que no pasan por el núcleo de envío no comprueban
   cuotas de existencias.** `POST /api/v1/contacts` no mira el límite `contacts` (que
   existe en `plans` y no se aplica en ningún punto de §4 — el spec no lo lista).
6. **`billing_events` sigue sin FK a `accounts` a propósito**, así que la parte C del SQL
   no tiene nada que limpiar ahí. Si alguna vez se le añade, `redeem_invitation()`
   necesitará otra rama.
7. **El aviso consulta `/api/billing/status` una vez al montar el shell.** No se refresca
   solo: si la suscripción cambia mientras la pestaña está abierta, el aviso no se entera
   hasta la siguiente navegación completa. f3.5, que ya va a sondear el estado, es el
   sitio natural para arreglarlo.

---

# Correcciones tras la revisión (CHANGES_REQUESTED)

Informe del revisor: `progress/review_enforce-limits.md`. Cuatro cambios exigidos, los
cuatro hechos. Migraciones 046 y 052, `progress/checks_enforce-limits.sql`, CP11 y la
escalera de §5 **no se tocaron**: el revisor los dio por buenos y no hay motivo para
moverlos (las correcciones no incluyen una sola línea de SQL, así que tampoco se volvió a
correr el replay).

## Cambio 1 — `broadcast_recipients` al núcleo compartido

El mismo criterio que ya se había aplicado a `messages_out`, ahora en el otro metro. La
comprobación y el conteo viven donde vive el abanico, `src/lib/whatsapp/broadcast-core.ts`:

- `createBroadcast()` — `assertQuota(accountId, 'broadcast_recipients', deduped.length)`
  **antes del RPC de persistencia**. Es la negativa barata: si la campaña no cabe, no
  queda ni campaña que limpiar. Se mide después del dedup, es decir lo que de verdad se
  va a enviar.
- `deliverBroadcast()` — `assertQuota(plan.accountId, …, plan.planned.length)` antes del
  primer envío y `recordUsage(plan.accountId, …, sent)` después del abanico, contando solo
  lo que Meta aceptó. Esta es la que no se puede rodear: **todo** fan-out del producto
  pasa por aquí.
- `BroadcastPlan` gana `accountId`. En el plan y no en un parámetro para que un plan no
  pueda entregarse sin cuenta a la que cobrar; `planBroadcastResume()` lo rellena con la
  cuenta que ya resolvió para leer las filas, nunca con nada del cuerpo de la petición.

Con eso los tres caminos quedan cubiertos:

| Ruta | Bloqueo | Conteo | Notas |
|---|---|---|---|
| `POST /api/v1/broadcasts` | 402 sincrónico desde `createBroadcast` (sobre de `/api/v1`) | en `deliverBroadcast`, dentro de `after()` | el `after()` pasa a llevar `try/catch`: `deliverBroadcast` ahora puede lanzar, y una promesa rechazada ahí sería invisible. Se registra y se liquida el estado, que deja la campaña en `sending` con sus destinatarios `pending` — justo lo que Reanudar sabe recoger |
| `POST /api/whatsapp/broadcast/[id]/resume` | 402 sincrónico: `assertQuota` tras planificar y **antes** de `markBroadcastSending`, con el claim aún tomado, así que el `catch` lo libera | en `deliverBroadcast` | reanudar es enviar. Sin esto, una campaña de 5 000 abandonada a los 1 000 entregaba los otros 4 000 con la cuota agotada |
| `POST /api/whatsapp/broadcast` (panel) | por campaña, ver cambio 2 | `recordUsage` propio de la ruta (no usa `deliverBroadcast`) | sin doble conteo |

### Tests por ruta

| Archivo | `it` | Qué fija |
|---|---|---|
| `src/lib/whatsapp/broadcast-core.test.ts` | *"weighs the whole campaign before persisting anything"* | se mide la campaña, después del dedup |
| | *"refuses over the limit and persists no campaign at all"* | bloquea y **no** persiste (RPC sin llamar) |
| | *"weighs the caller account and no other (leak test)"* | fuga |
| | *"refuses the pass over the limit and messages nobody"* | `sendTemplateMessage` sin llamar, cero updates, cero conteo |
| | *"counts only the recipients Meta accepted"* | 2 planificados, 1 aceptado → `recordUsage(…, 1)` |
| | *"bills the account on the plan and no other (leak test)"* | fuga |
| `src/app/api/v1/broadcasts/route.test.ts` (nuevo) | *"weighs the whole campaign before persisting it"* | cableado de la ruta pública |
| | *"402s over the allowance, persists no campaign and messages nobody"* | 402 con el sobre de `/api/v1` (`error.code`, `error.metric`, `error.upgradeUrl`), RPC sin llamar |
| | *"counts only the recipients Meta accepted"* | `after()` ejecutado a mano; `sent`/`failed` y `recordUsage(…, 1)` |
| | *"weighs and bills the key holder and no other account (leak test)"* | fuga por clave de API |
| `src/app/api/whatsapp/broadcast/[id]/resume/route.test.ts` (nuevo) | *"weighs the pass it is about to deliver"* | 202 y cuota medida |
| | *"402s a pass that does not fit, delivers to nobody and frees the claim"* | 402, `markBroadcastSending` sin llamar, nada enviado, `releaseBroadcastDelivery` llamado |
| | *"counts only what the pass actually delivered"* | conteo del pase |
| | *"bills the account that owns the campaign and no other (leak test)"* | fuga + `planBroadcastResume` siempre con la cuenta del contexto |

En los dos ficheros nuevos el núcleo corre **de verdad** (solo se sustituyen la capa de
facturación, Meta y las búsquedas de contacto/plantilla), así que lo que prueban es el
cableado, no un mock.

## Cambio 2 — la difusión se mide POR CAMPAÑA

Decisión del líder, y es la buena: el corte por lote de 10 producía exactamente la
campaña a medias que el comentario decía evitar.

`POST /api/whatsapp/broadcast` acepta ahora un `broadcast_id` opcional (el asistente
`use-broadcast-sending.ts` lo manda en cada lote) y mide los destinatarios **pendientes**
de la difusión persistida, no los del cuerpo:

- En el **primer** lote todos los destinatarios están `pending`, así que lo que se pesa es
  la campaña entera: si no cabe, se rechaza antes del primer envío.
- En los lotes siguientes lo ya enviado está en `usage_counters`, de modo que
  `used + pendientes` sigue valiendo lo mismo (`used₀ + campaña`) y la comprobación **no
  puede** saltar a mitad de una campaña que cabía al empezar. Medir contra el *total* en
  vez de contra lo pendiente habría vuelto a partir la campaña por la mitad: es el motivo
  de elegir «pendientes» y está escrito en el comentario de `outstandingRecipients`.
- Un destinatario fallido ni está pendiente ni se cuenta: Meta lo rechazó, no es
  facturable y tampoco ocupa hueco.
- Nunca se pesa menos que los destinatarios del propio cuerpo (`Math.max`), así que un
  recuento rancio no cuela un lote gratis y un llamador directo sin `broadcast_id` sigue
  sujeto a su propia lista.
- La búsqueda de la campaña filtra por `account_id`: un id de otro inquilino da 404, ni se
  mide ni se cobra. Si el recuento falla, **500** — «no pudimos contar» nunca es «no usas
  nada» (la misma regla que los límites de existencias).

El comentario de la ruta está reescrito y ya dice lo que el código hace; el del asistente
explica por qué manda el `broadcast_id`.

Tests en `src/app/api/whatsapp/broadcast/route.test.ts`:

| `it` | Qué fija |
|---|---|
| *"weighs the campaign, not the batch of ten the wizard sends"* | campaña de 25, lote de 10 → se mide 25 |
| *"402s a campaign of 25 with 20 left in the allowance, before the first send"* | **la decisión**: por lote (10 ≤ 20) habría pasado y muerto en el tercer lote; por campaña se rechaza ya, sin enviar ni contar |
| *"delivers the batch and counts it when the campaign fits"* | margen 30 → entrega los 10 y cuenta 10 |
| *"never weighs less than the recipients in the request"* | recuento a 0 → se pesa la lista del cuerpo |
| *"404s a campaign id that belongs to another account (leak test)"* | fuga: filtro `account_id` comprobado |
| *"fails closed when the campaign cannot be measured"* | 500, sin medir ni enviar |
| *"checks the whole campaign as one batch, before the first send"* | llamador directo sin `broadcast_id` |

## Cambio 3 — las lecturas vuelven a las cuentas bloqueadas

`GET /api/ai/usage` y `GET /api/account/invitations` son lecturas que piden `admin` por el
tipo de dato (gasto e información del equipo), no porque escriban. Ambas pasan
`{ allowReadOnly: true }`. El docstring de `RequireRoleOptions` se amplía para nombrar
este segundo uso legítimo y dejar claro que en una ruta que escribe sigue siendo un bug.

- `src/app/api/ai/usage/route.test.ts` › *"answers with the subscription suspended"*.
- `src/app/api/account/invitations/route.test.ts` › *"lists the invitations of a suspended
  account"* y, la otra mitad de la regla, *"still refuses to ISSUE one while the account is
  locked"* (403 `account_read_only`, nada insertado).

Los dos tests usan un `requireRole` que reproduce la regla real (rechaza salvo
`allowReadOnly`); la escalera en sí ya está probada contra el código real en
`src/lib/auth/account.test.ts`.

## Cambio 4 — hallazgos 7 y 8

- **Hallazgo 7** (`enforce.ts`): la cabecera ya no anuncia `contacts` entre lo que este
  módulo aplica. Dice lo contrario de forma explícita —`plans` lleva un tope `contacts`,
  §4 no lista ningún punto que lo aplique y no existe `assertStockLimit(…, 'contacts', …)`
  en el repo— para que el siguiente lector no lo dé por cubierto.
- **Hallazgo 8** (guion manual): corregido arriba. No hay ámbar; los dos peldaños usan
  `variant="destructive"` y se distinguen por icono y título.

## i18n y variables de entorno

Ninguna clave nueva: las correcciones no añaden texto de interfaz. Los dos mensajes nuevos
(`Broadcast not found`, `Could not measure this campaign against your plan limit`) son
cuerpos de error de API, del mismo tipo y en el mismo sitio que los que ya devolvía la
ruta. `en.json` y `ko.json` siguen en paridad total. Sin variables de entorno nuevas, así
que `docs/docker.md` no cambia; `.env.local.example` está bloqueado por permisos y no se
tocó.

## Deuda añadida (hallazgos 5, 6 y 9 del revisor)

8. **La prestación `webhooks` está aplicada a medias** (hallazgo 5). Solo se comprueba en
   la ruta de colección `/api/v1/webhooks`. `GET`/`PATCH`/`DELETE` de
   `/api/v1/webhooks/[id]` siguen abiertos y, lo que importa más, `dispatchWebhookEvent`
   (`src/lib/webhooks/deliver.ts`) no mira la prestación: una cuenta que baja de Pro a
   Inicio **sigue recibiendo** todas las entregas salientes, simplemente no puede listarlas
   ni crear otras. Fuera de alcance aquí porque §4 nombra la ruta de colección y porque
   apagar entregas en vuelo es una decisión de producto (¿se pierden o se encolan?), no una
   línea de código.
9. **`DELETE /api/whatsapp/config` sin compuerta de solo lectura** (hallazgo 6). El `POST`
   la recibió; el `DELETE` («Reset Configuration») no. Una cuenta bloqueada puede borrar su
   `whatsapp_config` y quedarse sin credenciales de Meta, lo que rompe la promesa de §5 de
   que al reactivar todo vuelve solo. No lo arreglo porque esa ruta tampoco tiene suelo de
   rol —un `viewer` ya puede hacerlo hoy—, así que «se comporta como un viewer» se cumple
   literalmente; el agujero real es la deuda 4 (migrar la ruta a `requireRole`), y ambas
   cosas deben resolverse juntas y con su propia revisión.
10. **La comprobación y el incremento no son atómicos** (hallazgo 9). `assertQuota` lee
    `usage_counters` y `recordUsage` sube después, así que con concurrencia se puede rebasar
    el tope por tantas unidades como envíos haya en vuelo. Se eligió la precomprobación
    —la decisión que f0.3 dejó abierta— para no cobrar intentos fallidos, y con difusiones
    medidas por campaña la ventana es mayor: dos campañas lanzadas a la vez pueden pasar
    ambas. Cerrarlo de verdad pide comparar el valor **devuelto** por `increment_usage` y
    compensar (o una reserva en la RPC), que es un cambio de la 041 y de todos los puntos
    de aplicación. Anotado, no arreglado.

---

# Ronda final — los tres defectos de seguimiento

El revisor **aprobó** `1446796` y dejó tres defectos anotados como «trabajo de
seguimiento» en la sección de contraste con `code-review` de
`progress/review_enforce-limits.md`. El líder decidió cerrarlos antes de fusionar la fase.
Commit: `08bc791` (`fix:`) sobre `saas/fase-3-facturacion`, 12 archivos, +464/−96, sin SQL.

## A — cambiar el número de WhatsApp ya no devuelve 402

**Qué estaba mal.** `src/app/api/whatsapp/config/route.ts` contaba los números de la
cuenta excluyendo por `phone_number_id` (`.neq('phone_number_id', …)`). Con
`UNIQUE(account_id)` en `whatsapp_config` la cuenta tiene una sola fila, y esa fila guarda
el número **viejo**: al guardar uno nuevo se contaba a sí misma → `used = 1`, `n = 1`,
`limit = 1` → `PlanLimitError`. `inicio` y `pro` traen `numbers: 1`, así que el recorrido
normal de alta (número de prueba de Meta → número de producción) devolvía 402 en los dos
planes baratos.

**Qué se hizo.** Se exclude por **identidad de fila**. La fila existente de la cuenta
(`select id, registered_at, phone_number_id … maybeSingle()`) ya se leía más abajo para
decidir si hay que llamar a `/register`; se subió por delante de la compuerta, que ahora
cuenta `whatsapp_config` de la cuenta con `.neq('id', existing.id)` cuando hay fila y sin
exclusión cuando no la hay. La lectura adelantada falla cerrado (500): no saber si existe
fila es no saber si el guardado es una edición.

Consecuencia honesta, escrita en el comentario: mientras viva el `UNIQUE(account_id)` la
cuenta **nunca** puede tener una segunda fila, así que el conteo siempre da 0 y el tope
multi-fila es inalcanzable. El cheque se deja escrito contra el conteo (no contra la
restricción) para que empiece a significar algo el día que f4.2 retire el `UNIQUE`.

**El test que canonizaba el fallo.** `config/route.test.ts:174` fijaba `numberCount = 1`,
valor que con el `UNIQUE` **solo** puede producir este escenario. Se sustituyó. Además el
doble de Supabase ya no devuelve un conteo fijo: aplica los filtros (`neq:id`) sobre un
estado de filas, de modo que un conteo excluido por `phone_number_id` daría 1 y el test
fallaría; antes pasaba con cualquiera de las dos implementaciones.

| Criterio | Test |
|---|---|
| Editar la fila existente con `numbers: 1` → 200 | `config/route.test.ts` › *"lets a 1-number plan swap its number: editing the row is not a second number"* (200, `updated.phone_number_id = 'pn-prod'`, `inserted === null`, filtro `['neq:id','cfg-1']`) |
| El 402 sigue existiendo, por un camino alcanzable | › *"402s when the plan leaves no room for the number being saved"* (plan con `numbers: 0`; documenta en el cuerpo que el caso multi-fila es inalcanzable hasta f4.2) |
| Aislamiento | › *"counts only this account, and asks the gate for this account (leak test)"* (`['account_id','acct-1']`, sin `neq:phone_number_id`, `assertWritable('acct-1')`) |
| Falla cerrado | › *"fails closed when the number count cannot be taken"* y › *"fails closed when the existing row cannot be read"* (500 y nada escrito) |

## B — §5 llega a flujos y automatizaciones

**Qué estaba mal.** `src/lib/flows/meta-send.ts` (tres puntos: texto, media, interactivos)
y `src/lib/automations/meta-send.ts` (uno) tenían `assertQuota` pero no `assertWritable`.
Los dos motores corren desde el `after()` del webhook con el cliente de rol de servicio,
así que **no** pasan por `requireRole`, que es donde vive la escalera de §5. Una cuenta
`suspended` con un flujo o una automatización `keyword_match` activa seguía respondiendo
sola a cada entrante hasta agotar la cuota mensual, mientras el cartel de la aplicación
decía que no se envía nada. §5 corta lo saliente.

**Qué se hizo.** `await assertWritable(accountId)` delante del `assertQuota` en los cuatro
puntos. Orden deliberado: a una cuenta en solo lectura ni se le pregunta cuánto cupo le
queda. Sigue el patrón de `src/lib/ai/auto-reply.ts:75`, el único camino que ya lo hacía.

**CP11, lo entrante nunca se bloquea.** El lanzamiento se hace lanzando, no callando, y eso
es seguro porque: (1) el entrante se guarda *antes* de que se despache a ningún motor
(`processMessage` persiste contacto, conversación y mensaje y sólo después llama a
`dispatchInboundToFlows` / `runAutomationsForTrigger`); (2) los dos motores tienen su
propio `try/catch` —el runner de flujos devuelve `no_match`, el de automatizaciones marca
el paso `failed`— así que la excepción no escapa al `after()`. Las tres cosas tienen test.

| Criterio | Test |
|---|---|
| Flujo de cuenta suspendida: no envía, no persiste, no cobra | `src/lib/flows/meta-send.test.ts` › *"engineSendText sends nothing, persists nothing and bills nothing"* (además `assertQuota` ni se llama) |
| Los otros dos senders del motor de flujos igual | › *"engineSendMedia and engineSendInteractiveButtons stop too"* |
| Se pregunta por la cuenta que envía (fuga) | › *"asks about the account it was told to send for (leak test)"* |
| Automatización de cuenta suspendida: no envía | `src/lib/automations/meta-send.test.ts` › *"sends nothing for a suspended account, and does not even weigh it"* y › *"asks about the account of the automation, not a fixed one (leak test)"* |
| El rechazo no escapa al webhook (flujos) | `src/lib/flows/dispatch.test.ts` › *"swallows the refusal instead of letting it reach the webhook"* |
| El rechazo no escapa al webhook (automatizaciones) | `src/lib/automations/engine.test.ts` › *"logs the refused send as a failed step and never throws"* |
| El entrante ya está guardado cuando se pregunta | `src/app/api/whatsapp/webhook/route.test.ts` › *"stores the inbound before either outbound engine is asked anything"* (cuenta los mensajes persistidos **en el momento** en que entra cada motor: 1) |

Los dos tests estructurales de CP11 de la ronda anterior siguen verdes: la ruta del webhook
sigue sin consultar la capa de facturación por sí misma.

## C — una difusión rechazada ya no deja contactos detrás

**Qué estaba mal.** En `src/lib/whatsapp/broadcast-core.ts`, `findOrCreateContact` —que
**escribe**— corría antes del `assertQuota`. Una campaña de 2 000 direcciones rechazada por
cupo no dejaba difusión, pero sí hasta 2 000 contactos nuevos, y el comentario «Nothing has
been written yet at this point» era falso.

**Qué se hizo** (la opción que el revisor prefería): se parte el bucle en dos. Primero una
normalización que **no toca la base**: sanear el teléfono, descartar los que Meta no podría
marcar (siguen contando como `rejected`) y colapsar el mismo número listado dos veces
conservando la primera aparición. Se pesa ahí. Sólo después se resuelven los contactos y se
colapsa lo que haya caído en el mismo contacto.

Dos consecuencias que quedan escritas en el código:

- Lo que se pesa son los **teléfonos distintos válidos**, una cota superior: la resolución
  de contactos todavía puede colapsar dos números distintos que hagan *fuzzy match* con un
  mismo contacto, y esa campaña se rechaza un pelo antes de tiempo. Se equivoca hacia
  rechazar, que es el lado seguro de un tope, y `deliverBroadcast` vuelve a pesar las filas
  exactas antes del primer envío.
- El segundo `assertQuota` (el exacto, post-dedup) **se retiró**: era estrictamente
  redundante, porque su `n` nunca es mayor que el que ya pasó. Una llamada menos a
  `getEntitlements` por campaña.

La comprobación de «ningún teléfono válido» (400) se movió con la normalización, antes del
cupo: una lista de puro ruido sigue siendo un 400, no un 402.

| Criterio | Test |
|---|---|
| Se pesa antes de escribir nada | `src/lib/whatsapp/broadcast-core.test.ts` › *"weighs the whole campaign before writing anything at all"* (dos números distintos → se pesa 2) |
| Un número repetido se pesa una vez | › *"weighs a number the caller listed twice once"* |
| Rechazada: ni campaña ni contactos | › *"refuses over the limit and persists no campaign — nor any contact"* (`findOrCreateContact` **no** se llamó) |
| Se cobra a la cuenta del llamador | › *"weighs the caller account and no other (leak test)"* (sin cambios) |

## Compuerta (ronda final)

Ejecutada en el worktree `.claude/worktrees/fase-3`:

- `npm run lint`: 0 errores, 37 warnings (todos preexistentes, ninguno en archivos tocados).
- `npm run typecheck`: limpio.
- `TZ=UTC npm test`: 105 archivos, **1 204 tests** (antes 1 193; +11).
- `npm run build` con las variables dummy de `docs/harness.md`: `Compiled successfully`.
- `scripts/replay-migrations.sh`: **no se corrió**. Esta ronda no toca una sola línea de
  SQL (`git diff --stat` no incluye `supabase/`), y el replay ya salió 0 en las dos rondas
  anteriores.

## CP6 · i18n

Sin texto de interfaz nuevo. Lo único que se añade al cable son mensajes de error de API
(`AccountLockedError`, `PlanLimitError`), que ya viajaban y no pasan por los catálogos.
`messages/en.json` y `messages/ko.json` no se tocaron y siguen en paridad.

## Variables de entorno

Ninguna nueva. `docs/docker.md` no cambia; `.env.local.example` sigue bloqueado por
permisos y no se tocó.

## Prettier

Mismo desenlace que en las rondas anteriores, y merece repetirse porque casi se cuela:
`npx prettier --write` sobre los once archivos tocados reformateó por completo los ocho que
ya estaban fuera de estilo en `HEAD` (1 353 líneas de diff para ~360 de cambio real).
Se deshizo esa parte y se reaplicaron los cambios a mano sobre la versión de `HEAD`,
respetando el estilo de cada archivo (con o sin punto y coma, comillas). Los tres que sí
estaban limpios (`config/route.test.ts`, `flows/meta-send.test.ts`,
`automations/meta-send.test.ts`) quedan pasados por prettier. El diff final son 12 archivos
y +464/−96.

## Deuda nueva o confirmada

11. **La `assertWritable` de los motores paga un `getEntitlements` extra.** `assertQuota`
    no acepta unas `Entitlements` ya resueltas (f0.3 no le puso el parámetro), así que cada
    envío de flujo o automatización hace dos resoluciones de plan en vez de una. Es la
    deuda 2 de este mismo informe (enhebrar `Entitlements`), ahora con un caso más y en el
    camino más caliente del producto: un envío por cada entrante.
12. **El tope `numbers` no se puede probar de verdad hasta f4.2.** Mientras
    `whatsapp_config` tenga `UNIQUE(account_id)` el conteo excluyendo la fila editada es
    siempre 0: el único 402 alcanzable es el de un plan con `numbers: 0`, que no existe en
    la 041. Cuando f4.2 retire la restricción hay que volver aquí y añadir el test de dos
    filas contra `numbers: 1`.
13. **La deuda 9 (`DELETE /api/whatsapp/config` sin compuerta) sigue abierta** y ahora es
    más visible: era la vía de escape del defecto A («Reset Configuration» y volver a meter
    las credenciales). Arreglado A, el `DELETE` deja de ser un rodeo necesario, pero sigue
    permitiendo que una cuenta bloqueada se quede sin credenciales de Meta. Se resuelve con
    la deuda 4 (migrar la ruta a `requireRole`), juntas y con su propia revisión.
