# p16.3 audit-db-privileges — informe de implementación

## Plan

1. Grep de escrituras de navegador sobre `profiles` (C1/C2) en `src/` y `mcp-server/`.
2. Grep de llamadores de las cinco funciones (C3).
3. Migración `098_audit_privilege_hardening.sql` (C1–C4), idempotente.
4. Aserciones en `supabase/ci/verify-schema.sql`.
5. SQL de comprobación contra el Postgres del harness, con control negativo sin 098.
6. Compuerta, CHANGELOG, commit.

## Rama y commits

- Rama `fix/audit-db-privileges` (worktree `.claude/worktrees/audit-db-privileges`), desde `main`.
- Commit `e54e5f8` `fix: endurece privilegios de base de datos (auditoría 2026-11-20)`.

Archivos: `supabase/migrations/098_audit_privilege_hardening.sql`, `supabase/ci/verify-schema.sql`
(bloque `-- 098`), `CHANGELOG.md`.

## Pre-comprobaciones (grep)

- **Escrituras de `profiles` desde cliente**: la única es `src/components/settings/profile-form.tsx:144`,
  `update({ full_name, avatar_url })`. Ningún `insert`/`upsert` en `src/` ni `mcp-server/` (mcp-server no
  toca `profiles`). En SQL, todos los `INSERT/UPDATE profiles` están en funciones SECURITY DEFINER
  (`handle_new_user`, RPCs de miembros/invitaciones) o en backfills: corren como `postgres`, no les afecta
  el trigger ni la falta de política. → No hay uso legítimo; no procede `blocked`.
- **C3 llamadores**: `record_webhook_failure` solo desde `src/lib/webhooks/queue.ts:307`, con el `db` que
  le pasan `dispatchWebhookEvent` (las 3 llamadas de `whatsapp/webhook/route.ts` pasan `supabaseAdmin()`),
  el cron (`webhooks/cron/route.ts`, `supabaseAdmin()`) y `retryDelivery` (rutas `account` y `v1`, ambas
  `supabaseAdmin()`). `_bcast_bump` solo desde `broadcast_recipient_aggregate_trigger` (SECURITY DEFINER).
  `recompute_broadcast_counts`, `merge_duplicate_contacts`, `merge_duplicate_conversations`: sin
  llamadores en código (mantenimiento manual).

## Criterio ↔ comprobación

No hay test vitest posible: todo es política/grant/trigger de Postgres, que el runner no ejecuta
(`fake-supabase.ts` no carga migraciones). Cada criterio se prueba en
`progress/checks_audit-db-privileges.sql` (bloques DO que dan PASS o abortan con FAIL, todo en una
transacción con ROLLBACK) y queda fijado en CI por `verify-schema.sql`.

| Criterio | Comprobación en checks_audit-db-privileges.sql | Aserción CI (verify-schema.sql, bloque 098) |
|---|---|---|
| C1 `authenticated` no cambia `profiles.email` | `PASS C1: UPDATE profiles SET email -> 42501` | cuerpo de `enforce_profile_privilege_columns` contiene `NEW.email IS DISTINCT FROM OLD.email` |
| C1 `full_name` sigue editable | `PASS C1: full_name sigue editable` | — |
| C2 sin `profiles_insert` | `PASS C2: INSERT profiles -> 42501 (sin política)` | `profiles_insert` no existe en `pg_policies` |
| C2 `handle_new_user` sigue creando perfil | `PASS C2: handle_new_user sigue creando el perfil` | — |
| C3 anon/authenticated sin EXECUTE en las 5 | `PASS C3: authenticated -> 42501 en ...` (×5), `PASS C3: anon -> 42501 ...` | `has_function_privilege` anon/authenticated = false, service_role = true, para las 5 |
| C3 service_role ejecuta | `PASS C3: service_role ejecuta record_webhook_failure`, `recompute ejecuta` | idem |
| C3 triggers de difusión siguen | `PASS C3: trigger de difusión cuenta (service_role)` (sent_count=1 tras `delivered`), `... disparado por authenticated sin error` | — |
| C4 viewer no sube/sobrescribe/borra | `PASS C4: viewer no puede subir, sobrescribir ni borrar media` | las 6 políticas INSERT/UPDATE/DELETE contienen `viewer` |
| C4 viewer sigue leyendo | `PASS C4: el viewer sigue leyendo (3 objetos)` | (las SELECT de 044 ya tienen su aserción) |
| C4 agent sí | `PASS C4: el agent sube y borra media` (chat y flow) | — |

## Verificación contra base real

- `KEEP=1 scripts/replay-migrations.sh "$(pwd)"`: 001–098 `ok`, `verify-schema.sql: OK`.
- `docker exec -i <c> psql ... -v ON_ERROR_STOP=1 < progress/checks_audit-db-privileges.sql`: 16 PASS, 0 FAIL.
- Idempotencia: 098 aplicada por segunda vez sobre la misma base → sin error; verify vuelve a pasar.
- **Control negativo** (migraciones hasta 097 y `verify-schema.sql` de `main`, mismo SQL con los FAIL
  convertidos en NOTICE): FAIL en C1 (email), C2 («la política dejó pasar el INSERT; lo paró solo
  UNIQUE»), C3 ×6 (las cinco funciones como authenticated, y `record_webhook_failure` como anon) y C4
  (el viewer borró 3 objetos y subió media). Es decir: cada comprobación falla sin el arreglo.
  Dato de paso: en esta imagen `authenticated` sí podía ejecutar los dos `merge_duplicate_*` (grant por
  defecto de Supabase), lo que confirma el caso «confianza media» del informe.
- Compuerta final: `scripts/replay-migrations.sh "$(pwd)"` salida 0; `npx eslint . --ignore-pattern
  '.claude/**' && npm run typecheck && TZ=UTC npm test && npm run build` en verde (ver nota de flaky).

## Decisiones donde el spec era ambiguo

- **Simulación de roles**: `auth.uid()` de la imagen `supabase/postgres:17.4.1.075` lee
  `request.jwt.claim.sub` (clave antigua), no `request.jwt.claims`. El SQL fija ambas.
- **Función de 036**: `merge_duplicate_conversations()`.
- **C4, rama legada de flow-media** (`auth.uid()::text = foldername[1]`, carpetas pre-020 por usuario):
  se conserva tal cual; el spec pide añadir la condición solo a la cláusula `EXISTS`. Un viewer aún puede
  escribir en una carpeta con su propio user_id, que no es de la cuenta ni la lee nadie más.
- Mensaje de error del trigger ampliado a «account_role, account_id and email».
- `verify-schema.sql` sigue siendo un único DO; el bucle de funciones va en un sub-bloque `DECLARE/BEGIN`.

## Verificaciones manuales pendientes

Ninguna obligatoria. Opcional tras desplegar en el proyecto real (no hecho; nunca contra remoto desde aquí):
`PATCH /rest/v1/profiles?user_id=eq.<self> {"email":"x@y"}` con JWT de usuario → 403/42501;
`POST /rest/v1/rpc/record_webhook_failure` con la anon key → 401/42501.

## Variables de entorno nuevas

Ninguna.

## Flaky observado

Dos pasadas completas de `npm test` (workers por defecto): `src/middleware.test.ts` «lets the coexistence
cron through ...» → timeout de 5000 ms (hace un `import()` dinámico de la ruta; con otros cinco implementers
corriendo, el import total llegó a 666 s agregados). Aislado: 84/84 en 3,5 s. Con `TZ=UTC npm test --
--maxWorkers=4`: 417 archivos / 6375 tests en verde, y `npm run build` compila. Este commit no toca TS.
Deuda: ese test es sensible a carga (sin timeout propio).

## Deuda fuera de alcance

- Rama legada de flow-media (ver arriba): se podría eliminar si ya no quedan objetos con carpeta por usuario.
- `fake-supabase.ts` (tenant-isolation) modela RLS de 017, incluida la inserción en `profiles`; no refleja 098.
- `scripts/replay-migrations.sh` escribe en `/tmp/replay-out.txt` fijo: replays concurrentes se pisan el log
  de error (no el resultado).
- Hallazgos 4, 6, 7 de `audit-auth.md` no están en la sección C.
