# Review — s10.1 meta-pricing-capture

**Veredicto:** APPROVED

Rama `fg/pricing-capture`, rango `4ad530f..09dd755` (1 commit). Diff = 8 archivos, los mismos que lista el informe §3.

## Compuerta (ejecutada por el revisor, comando a comando)
- lint: verde (0 errores, 34 warnings preexistentes; en archivos tocados solo `route.ts:5 downloadMedia`, previo).
- typecheck: verde.
- `TZ=UTC npm test`: verde, 253 archivos / 3538 tests.
- build (variables dummy de CI): verde.
- replay-migrations: verde (`075_message_charges.sql ok`, `verify-schema.sql: OK`).
- `progress/checks_meta-pricing-capture.sql` sobre la réplica: `NOTICE: checks_meta-pricing-capture: OK`.
- 075 reaplicada sobre sí misma con `psql --single-transaction`: sin errores (idempotente y válida en una transacción).
- SQL extra del revisor (scratchpad, ROLLBACK): sent→read sin delivered fija `delivered_at`=ts del read; delivered posterior con pricing → `updated`, status sigue `read`, `delivered_at` no se mueve; delivered anterior sin pricing → `delivered_at` adelanta (LEAST); sent tardío no retrocede ni pisa `sent_at`; read sin fila → `skipped`, 0 filas; cuenta inexistente → `foreign_key_violation` (la app lo convierte en `'error'`, no lanza).

## Trazabilidad criterio ↔ test
- C1 «pricing de mensaje de conversación»: [x] `route.test.ts` › "un estado con pricing de un mensaje de conversación se registra con el mensaje y el número que envió" (args exactos, `p_whatsapp_config_id` del webhook).
- C2 «pricing de destinatario de difusión»: [x] `route.test.ts` › "un destinatario de difusión (que no pasa por `messages`)…" (`p_broadcast_recipient_id`, teléfono por contacto).
- C3 «sin pricing no crea fila»: [x] `route.test.ts` › "un estado sin pricing no manda categoría…" + `message-charges.test.ts` › "sin pricing, o sin categoría utilizable…" + SQL §2 y extra (read sin fila).
- C4 «estado repetido no sobreescribe»: [x] semántica en SQL §1b (precio distinto en delivered no pisa); `route.test.ts` › "el estado repetido…" solo prueba lo que manda el webhook (`billable` no booleano → NULL). Suficiente: la regla vive en la RPC y se prueba contra Postgres.
- C5 «delivered tardío tras read no retrocede»: [x] SQL §1d + extra; aserción `message_charge_next_status('read','delivered')` en verify-schema; `route.test.ts` › "un delivered tardío tras read se manda tal cual".
- C6 «marketing_lite tal cual»: [x] `route.test.ts` › "una categoría desconocida (marketing_lite)…", `message-charges.test.ts`, SQL §5.
- C7 «CP11, cuenta incomplete/solo lectura»: [x] `route.test.ts` › "CP11: con la cuenta incomplete y en solo lectura…" (entrante upsert + espejo + cobro; `assertWritable`/`getEntitlements` no llamados).
- C8 «error nunca tumba el webhook»: [x] `route.test.ts` › "si la RPC falla, el webhook responde 200 y el fan-out del estado sale igual"; `message-charges.test.ts` › "un error de la RPC…" y "una excepción del cliente…" (`recordMessageCharge` envuelve todo en try/catch, `message-charges.ts:144-174`).
- C9 «RLS: A no lee cargos de B; admin+»: [x] SQL §7 (owner A 4, owner B 0, agent A 0).
- C10 «sin escritura desde cliente»: [x] SQL §7b/7c/7d (authenticated no inserta, no actualiza, no ejecuta la RPC) + verify-schema (privilegios de tabla y función).
- C11 «UNIQUE de wamid»: [x] SQL §6a + verify-schema.
- CP3 fuga A↔B en el webhook: [x] `tenant-isolation.test.ts` › "s10.1: el cobro de Meta de un wamid compartido se registra solo con las filas de la cuenta del número"; SQL §3 (`foreign`, A intacta, B sin fila).
- Verificación con Meta real: [x] guion manual en el informe §7.

## Decisiones del implementer
1. RPC `record_message_charge` (SECURITY INVOKER, EXECUTE solo `service_role`): **aceptada**. Comprobado en SQL: `read` tras `delivered` avanza; `delivered` tardío tras `read` no retrocede y fija/adelanta `delivered_at` (LEAST ignora NULL); sin `pricing` y sin fila → `skipped`, no crea.
2. `wamid` UNIQUE global + `ON CONFLICT … WHERE mc.account_id = EXCLUDED.account_id` → `foreign`: **aceptada**. El fallo es hacia la infra-facturación de la segunda cuenta (nunca fuga ni cobro cruzado). Registrado en el informe §6 y §10 y con `console.warn` (`message-charges.ts:166`). Ver hallazgo 2.
3. `whatsapp_config_id` del webhook: **aceptada**. `processWebhook` (`route.ts:373-385`) toma `value.metadata.phone_number_id`, `resolveInboundConfig` (`route.ts:436-474`) exige exactamente una fila de `whatsapp_config` (descarta 0 y ≥2), y `account_id`/`config.id` salen de esa misma fila. Las referencias `message_id`/`broadcast_recipient_id` se resuelven con lecturas acotadas a la cuenta (`route.ts:590-594`, `637-641`). Una cuenta no puede acabar con cargos de otra.
4. Cobro sin `wamid` casado: **aceptada**. `POST` verifica HMAC-SHA256 sobre el cuerpo crudo antes de cualquier proceso (`route.ts:304-313`) y `verifyMetaWebhookSignature` falla cerrado sin `META_APP_SECRET`. La cuenta sale de `phone_number_id` dentro del cuerpo firmado; sin el App Secret no hay forma de inyectar cargos. Un reenvío de un payload firmado es idempotente por `wamid`.
5. `read` sin `delivered` fija `delivered_at`: **aceptada**; dicho en el informe §6 y en el comentario de la 075:42-45.
6. Índices en `message_id` y `broadcast_recipient_id`: **aceptada**.

## Checkpoints
- CP1: [x] compuerta verde ejecutada por el revisor.
- CP2: [x] 075 nueva, idempotente (`IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP POLICY IF EXISTS`), aplicable en una transacción, aserciones en verify-schema, replay 0. `account_id ON DELETE CASCADE` sigue el patrón de tablas de cuenta (solo borra al borrar la cuenta); el resto `SET NULL`.
- CP3: [x] RPC recibe `account_id` del config; lecturas con `.eq(...account_id)`; test de fuga + SQL §3/§7.
- CP4: [x] todos los criterios con test leído; lo de base real en `checks_meta-pricing-capture.sql`; lo de Meta, guion manual.
- CP5: [x] `package.json` sin cambios.
- CP6: [x] n/a (sin textos de UI).
- CP7: [x] sin APIs nuevas de framework (`after()` ya existía); helper fuera de `route.ts` por la restricción de exports de handler.
- CP8: [x] solo archivos justificados por la sección; deuda anotada en §10 sin tocar.
- CP9: [x] CHANGELOG Unreleased con «Migration required: 075» y «Deploy the migration before the code»; sin variables nuevas; informe coincide con el diff.
- CP10: [x] un commit en `fg/pricing-capture`, español, prefijo `feat:`, `Co-Authored-By`; sin push.
- CP11: [x] la 075 no altera `messages`; error del camino nunca lanza (test + try/catch); entrante guardado con cuenta en solo lectura (test). Ver hallazgo 1 sobre el lock de la FK.

## Hallazgos (archivo:línea) — ninguno bloqueante
1. `supabase/migrations/075_message_charges.sql:21-26` — el comentario dice que el SHARE ROW EXCLUSIVE sobre `messages`/`broadcast_recipients` dura «solo durante el CREATE TABLE»; con `db push` (una transacción por archivo) se mantiene hasta el COMMIT. Impacto real despreciable (el resto del archivo son índices sobre tabla vacía y funciones), y `lock_timeout = 5s` acota la espera en cola. Es inevitable con las FK que pide el spec. Corregir el comentario cuando se toque el archivo.
2. `src/lib/whatsapp/message-charges.ts:166-168` — el aviso `foreign` no incluye `wamid` ni `account_id`; si ocurre, el operador no puede localizar el cobro perdido de la segunda cuenta. Recomendable añadirlos (no son secretos) en s10.4 o antes.
3. `src/app/api/whatsapp/webhook/route.ts:635` (preexistente, no de este cambio) — `new Date(parseInt(status.timestamp) * 1000).toISOString()` lanza `RangeError` con un `timestamp` no numérico, lo que aborta el resto de estados y los entrantes del mismo `change`. Meta firma el cuerpo y siempre manda timestamp, pero conviene anotarlo como deuda CP11.

## Cambios requeridos
Ninguno.
