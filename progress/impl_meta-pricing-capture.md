# impl s10.1 `meta-pricing-capture`: done (opción B, `message_charges`)

Rama `fg/pricing-capture` (worktree `.claude/worktrees/fg-pricing-capture`), base 4ad530f.
Commit: `09dd755 feat: registrar lo que Meta cobra por cada mensaje en message_charges (s10.1)`.

## 1. Análisis del bloqueo inicial (conservado)

La primera pasada paró sin código; el líder decidió la opción B y reescribió la sección del spec.

### Bloqueo 1 — `messages` no tiene `delivered_at` ni `whatsapp_config_id`
- `messages` (001 + 009/010/033/035/039) tiene: id, conversation_id, sender_type, sender_id,
  content_type, content_text, media_url, media_type, template_name, message_id, status, created_at,
  reply_to_message_id, interactive_reply_id, interactive_payload, ai_generated. Nada más.
- La 053 añadió `whatsapp_config_id` a **`conversations`** y **`broadcasts`**, no a `messages`
  (053_whatsapp_config_multi_number.sql:112-124). La sección «Lo que ya existe» del spec se equivoca.
- `delivered_at` existe en `broadcast_recipients` (001:327), no en `messages`. El espejo de estados
  sobre `messages` solo escribe `status` (route.ts, `handleStatusUpdate`, paso 1).
- Por eso el índice `(whatsapp_config_id, delivered_at) WHERE pricing_category IS NOT NULL` no se
  puede crear. Y no hay nombre equivalente al que adaptarse: habría que añadir columnas.
- Además, contar por número usando `conversations.whatsapp_config_id` no sirve para el pasado: la
  conversación se vuelve a sellar con el último número al que escribió el cliente (fase 4 §1,
  route.ts ~1634), así que el número de un mensaje viejo no queda fijo.

### Bloqueo 2 — las difusiones no pasan por `messages` (y es el grueso de este cliente)
- `broadcast-core.ts`, `api/whatsapp/broadcast/route.ts` y `use-broadcast-sending.ts` solo
  escriben en `broadcasts`/`broadcast_recipients`. Ninguna difusión crea fila en `messages`.
  `handleStatusUpdate` casa el `wamid` con `broadcast_recipients.whatsapp_message_id` aparte.
- Si guardamos `pricing` solo en `messages`, las plantillas de marketing masivas (el perfil del
  cliente según el spec: «volumen alto de plantillas de marketing») **no quedarían registradas**, y
  el checkpoint «broadcast de 1.000 marketing con 900 entregados suma 900» no se podría cumplir.
  Sí pasan por `messages` el inbox, la API v1, automatizaciones y flujos (`meta-send.ts`), así que
  las dos tablas no se solapan: no habría doble conteo.

### Opciones para el líder o el spec_author (decide el humano)
**A. Columnas en las dos tablas** (lo más cerca del spec):
  - `messages`: + `pricing_category`, `pricing_billable`, `pricing_type`, + `delivered_at timestamptz`
    (lo escribe `handleStatusUpdate` en `delivered`, o en `read` si sigue NULL), + `whatsapp_config_id`
    (lo sella el propio estado: `processWebhook` ya conoce `config.id` por el `phone_number_id`, así
    que no hay que tocar las rutas de inserción). Índice parcial `(whatsapp_config_id, delivered_at)`.
  - `broadcast_recipients`: + las tres columnas de pricing (ya tiene `delivered_at`; el número sale de
    `broadcasts.whatsapp_config_id`). Índice parcial `(broadcast_id, delivered_at)`.
  - Inconveniente: s10.4 y s10.5 cuentan con una UNION de dos tablas sin `account_id` propio (las
    dos cuelgan de un padre), y el «orden de entrega» cruza las dos.
**B. Libro de cargos propio (lo que recomiendo)**: tabla nueva `message_charges` (`account_id`,
  `whatsapp_config_id`, `wamid`, `source` messages|broadcast, `message_ref`/`recipient_ref`,
  `pricing_category`, `pricing_billable`, `pricing_type`, `delivered_at`), UNIQUE
  `(whatsapp_config_id, wamid)`, índice `(account_id, delivered_at) WHERE delivered_at IS NOT NULL`.
  La escribe `handleStatusUpdate` (upsert con `ON CONFLICT DO NOTHING` para el pricing, y
  `delivered_at` solo si es NULL). Ventajas: una sola fuente para el corte y el panel, `account_id`
  directo (CP3 sencillo, auditable por `service-role-audit`), número exacto por mensaje, y no
  agranda la tabla más caliente (`messages`) ni bloquea su escritura durante la migración (CP11:
  crear una tabla nueva no toma lock sobre `messages`). Inconveniente: más alcance que el spec y
  cambia lo que s10.4/s10.5 dan por hecho.

En las dos: el CHECK de `messages` debe ir `NOT VALID` (las filas previas son NULL por
construcción). Si no, `ADD COLUMN … CHECK` recorre la tabla entera con ACCESS EXCLUSIVE, lo que
bloquea también la inserción de entrantes. Para el índice: sin `CONCURRENTLY`
(el `db push` de Supabase corre cada archivo en una transacción, mismo criterio que la 064), con
`SET LOCAL lock_timeout`. Ojo: `scripts/replay-migrations.sh` corre con psql en autocommit, así que
NO detectaría un `CONCURRENTLY` mal puesto.

### Otros hallazgos para el spec (sin tocar)
- Categorías de Meta que el CHECK del spec no recoge y que pueden llegar: `marketing_lite` (MM
  Lite) y `referral_conversion` (modelo CBP). Ojo también a la grafía: Meta puede mandar
  `authentication-international` con guion. Mi propuesta: pasar los guiones a guion bajo antes del
  CHECK, y que lo desconocido se ignore con un `console.warn`. Pero cómo se factura `marketing_lite`
  lo tiene que decidir el humano.
- Deuda previa: el espejo de `messages.status` no aplica la escalera de estados
  (`isValidStatusTransition` solo se usa en difusiones), así que un `delivered` que llega tarde
  puede pisar un `read`. Esto no es del alcance de s10.1.


## 2. Plan ejecutado
1. Migración `075_message_charges.sql`: tabla, índices, RLS, `message_charge_next_status()` y
   `record_message_charge()` (única vía de escritura). Aserciones en un bloque `-- 075` dentro del
   DO de `verify-schema.sql`, justo después de `-- /074`.
2. `src/lib/whatsapp/message-charges.ts`: `parseStatusPricing` y `recordMessageCharge`, que no lanza.
   Va fuera de `route.ts` porque Next solo admite exports de handler ahí.
3. `handleStatusUpdate` (webhook): paso 3 nuevo, después de los espejos `messages`/`broadcast_recipients`
   y antes del fan-out. `WhatsAppStatus.pricing` declarado; `resolveStatusContactId` pasa a
   `resolveStatusContact` (devuelve también el teléfono del contacto).
4. Tests vitest (webhook, módulo, fuga A↔B) + `progress/checks_meta-pricing-capture.sql` contra Postgres.

## 3. Archivos
- `supabase/migrations/075_message_charges.sql` (nuevo)
- `supabase/ci/verify-schema.sql` (bloque `-- 075`)
- `src/lib/whatsapp/message-charges.ts` y `.test.ts` (nuevos)
- `src/app/api/whatsapp/webhook/route.ts`, `route.test.ts`
- `src/lib/security/tenant-isolation.test.ts`
- `CHANGELOG.md` (Unreleased, con aviso de migración)

## 4. Criterio ↔ test
| Criterio del spec | Test |
|---|---|
| Payload con `pricing`, mensaje de conversación | `route.test.ts` › «cobro de Meta por mensaje (s10.1)» › «un estado con pricing de un mensaje de conversación se registra con el mensaje y el número que envió» |
| Payload con `pricing`, destinatario de difusión | ídem › «un destinatario de difusión (que no pasa por `messages`) se registra con su fila» |
| Payload real de Meta parseado | `message-charges.test.ts` › «lee el payload real de Meta» |
| Sin `pricing` no crea fila | `route.test.ts` › «un estado sin pricing no manda categoría…»; `message-charges.test.ts` › «sin pricing, o sin categoría utilizable, devuelve null»; SQL §2 |
| Estado repetido no sobreescribe | `route.test.ts` › «el estado repetido (sent y luego delivered con pricing)…»; SQL §1b (precio distinto en delivered no pisa) |
| `delivered` tardío tras `read` no retrocede | `route.test.ts` › «un delivered tardío tras read se manda tal cual…»; SQL §1d; aserción de `message_charge_next_status` en verify-schema |
| Categoría desconocida (`marketing_lite`) se guarda tal cual | `route.test.ts` › «una categoría desconocida (marketing_lite) se guarda tal cual y avisa una sola vez»; `message-charges.test.ts` › «una categoría desconocida se guarda tal cual…»; SQL §5 |
| Error en este camino nunca tumba el webhook | `route.test.ts` › «si la RPC falla, el webhook responde 200 y el fan-out del estado sale igual»; `message-charges.test.ts` › «un error de la RPC…», «una excepción del cliente…» |
| CP11: entrante y estado con la cuenta `incomplete`/solo lectura | `route.test.ts` › «CP11: con la cuenta incomplete y en solo lectura, el entrante y el estado con pricing se guardan» |
| CP3: wamid compartido entre cuentas | `tenant-isolation.test.ts` › «s10.1: el cobro de Meta de un wamid compartido se registra solo con las filas de la cuenta del número»; SQL §3 (`foreign`); `message-charges.test.ts` › «un wamid de otra cuenta se avisa y no se toca» |
| RLS: A no lee cargos de B; admin+ | SQL §7 (owner A ve 4, owner B 0, agent de A 0; mutación agent→admin comprobada: la aserción salta) |
| UNIQUE de `wamid` | SQL §6a; verify-schema |

## 5. Verificación contra base real
- `KEEP=1 scripts/replay-migrations.sh` → salida 0 (`075 ok`, `verify-schema.sql: OK`).
- 075 ejecutada otra vez sobre sí misma: sin errores, es idempotente.
- `progress/checks_meta-pricing-capture.sql` → `NOTICE: checks_meta-pricing-capture: OK`. Cubre las
  transiciones de la RPC, la protección entre cuentas, `failed`, la categoría libre, UNIQUE/CHECK/NOT NULL,
  RLS + REVOKE (authenticated no inserta, no actualiza, no llama a la RPC) y ON DELETE SET NULL.
- 075 borrada y reaplicada con `psql --single-transaction`, como la corre `db push`: OK; después
  verify-schema y checks, OK. Así queda probado que `SET lock_timeout`/`RESET` funcionan dentro de una
  transacción. El replay normal corre en autocommit y no lo detectaría.
- Réplica limpia final (sin KEEP): salida 0.

## 6. Decisiones donde el spec era ambiguo
- **Una RPC en vez de upsert de PostgREST.** «Solo rellena lo que falta, nunca retrocede» no se puede
  expresar con `.upsert()`. `record_message_charge` es SECURITY INVOKER y solo la ejecuta `service_role`.
  Devuelve `inserted|updated|skipped|foreign`.
- **`wamid` UNIQUE global, como dice el spec, pero el ON CONFLICT lleva `WHERE mc.account_id =
  EXCLUDED.account_id`.** Meta no garantiza wamid único entre números (009); sin esa condición, un estado de
  B podría modificar la fila de A (CP3). En ese caso devuelve `foreign` y la app emite un `console.warn`.
  Consecuencia: si dos cuentas llegaran a compartir un wamid, la segunda no registra su cobro. Lo
  considero preferible a filtrar datos entre cuentas.
- **`whatsapp_config_id` = el número por el que llegó el estado** (`config.id` del `phone_number_id`), no
  el de la conversación o la difusión. Meta manda el estado por el número que envió, así que es el dato
  exacto, queda fijo y también cubre difusiones con `whatsapp_config_id` NULL (anteriores a la 053).
  Cumple la intención del spec («fijo aunque la conversación cambie de número»).
- **Se registra aunque el wamid no case ni con `messages` ni con `broadcast_recipients`** (referencias
  NULL). Hay dos casos: (a) carrera, cuando el `sent` le gana a la inserción del mensaje, y entonces un estado
  posterior rellena `message_id` por COALESCE; (b) envíos hechos fuera del CRM con el mismo número, que
  Meta igual cobra.
- **Estados sin `pricing`** (típicamente `read`): la RPC avanza una fila existente y nunca la crea.
- **`delivered_at`**: lo fija `delivered`, o `read` si `delivered` no llegó (leído implica entregado; si
  no, el corte perdería mensajes). Si después llega un `delivered` con timestamp anterior, el valor
  pasa a ese más temprano (`LEAST`). Se calcula solo cuando el estado resultante es `delivered`/`read`.
- **`failed`** es terminal y solo entra desde nada o `sent`. Un estado desconocido no cambia `status`.
- **`recipient_phone`**: `status.recipient_id` normalizado; si falta, el teléfono del contacto resuelto
  por BSUID. NULL si no hay ninguno.
- **Validación en código**: la categoría es texto recortado, no vacío y de 64 caracteres como máximo; si
  no, no hay fila. `billable` solo admite booleanos (otro valor llega como NULL y la RPC conserva lo que
  ya había). Lo desconocido (categoría o tipo) se guarda y avisa una vez por valor y proceso, con un tope
  de 200 valores recordados.
- **CHECK** solo en `status` (lista cerrada) y en que la categoría no sea vacía. La categoría es libre,
  como dice el spec.
- **Índices extra** sobre `message_id` y `broadcast_recipient_id` (parciales, NOT NULL). Sin ellos, el ON
  DELETE SET NULL recorrería la tabla entera por cada mensaje borrado en cascada al borrar una conversación.
- **CP11 en la migración**: no se altera `messages`. Las FK toman SHARE ROW EXCLUSIVE sobre `messages` y
  `broadcast_recipients` solo durante el CREATE TABLE (tabla vacía, sin validación), con
  `lock_timeout = 5s` para fallar en vez de bloquear los INSERT del entrante. Reintentar el `db push` es seguro.
- **RLS**: `can_read_account(account_id, 'admin')` (visible también en sesión de soporte, 057). Sin
  políticas de escritura y con REVOKE de INSERT/UPDATE/DELETE/TRUNCATE a anon/authenticated.
- `account_id` con ON DELETE CASCADE, como el resto de tablas de la cuenta.
- **Coste por evento**: cada estado hace una llamada RPC más, también los `read` sin pricing (para
  avanzar `status`).

## 7. Verificación manual pendiente (requiere Meta real)
1. Con la 075 aplicada en un entorno con número real, enviar una plantilla de marketing a un número propio.
2. `select wamid, status, pricing_category, pricing_billable, pricing_type, pricing_model, sent_at, delivered_at, whatsapp_config_id, message_id from message_charges order by created_at desc limit 5;`
   Debe aparecer una fila `marketing / true / regular / PMP` con `sent_at`, y tras abrirla `status = read`
   y `delivered_at` relleno.
3. Repetir con una difusión pequeña (2 contactos): `broadcast_recipient_id` relleno y `message_id` NULL.
4. Responder desde el inbox dentro de la ventana de 24 h: `pricing_category = service`. Comprobar el
   `pricing_type` que manda Meta (`free_customer_service` u otro) y si `billable` llega en false.
5. Revisar los logs: no debe aparecer `[message-charges] … unknown pricing category` con las categorías
   de la lista. Si aparece otra, anotarla para s10.2/s10.4.

## 8. Despliegue
Aplicar la 075 **antes** del código. Si el código va primero, cada estado registra un error
`record_message_charge` en el log. Es inocuo (los espejos de estado y el fan-out siguen), pero no se
captura el pricing hasta aplicar la migración.

## 9. Variables de entorno nuevas
Ninguna. `docs/docker.md` y `docs/security.md` no cambian (no hay cron, variables ni superficie nueva para el operador).

## 10. Deuda detectada (fuera de alcance, sin tocar)
- `messages.status` admite retroceder: el espejo no aplica la escalera de estados, así que un `delivered`
  tardío pisa un `read` en el inbox. `message_charges` sí la aplica.
- Lint: warning previo `'downloadMedia' is defined but never used` en `webhook/route.ts:5` (no es de este cambio).
- `verify-schema.sql`: s10.2 añade su bloque `-- 076` en el mismo sitio. Al integrar habrá un conflicto
  trivial; deben quedar los dos bloques seguidos.
- Para s10.4/s10.5: cuentan filas con `delivered_at` en el periodo. Si dos cuentas comparten un wamid,
  la segunda no tiene fila (decisión de §6).

## 11. Compuerta
`npm run lint` (0 errores, warnings previos), `npm run typecheck`, `TZ=UTC npm test` (253 archivos,
3538 tests), `npm run build` con variables dummy: los cuatro en verde. `scripts/replay-migrations.sh`:
salida 0. Checks SQL: OK.
