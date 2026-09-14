# Implementación f0.2 — billing-model (corrección tras CHANGES_REQUESTED)

Spec: `docs/saas/fase-0-cimientos.md` §2 (con el §4/S1 que se saca de aquí).
Revisión atendida: `progress/review_billing-model.md`.

## Rama y commits

- Rama: `saas/fase-0-cimientos`
  (worktree `/Users/brian/Documents/Dev/projects/wacrm/.claude/worktrees/agent-a85d874ab350adc04`).
- `62a0742` — implementación original de f0.2 (previa, no reescrita).
- **`324f087`** — `fix: proteger los datos de facturación al borrar una cuenta`
  (esta corrección). Archivos: `supabase/migrations/041_billing_model.sql`,
  `supabase/migrations/047_ai_platform_key.sql` (nuevo),
  `supabase/ci/verify-schema.sql`, `CHANGELOG.md`.
- Los commits de f0.4 (`afbaecb`, `8854c65`) no se han tocado, según la
  decisión del líder.

## Hallazgos del reviewer, uno a uno

| # | Hallazgo | Qué se hizo |
|---|---|---|
| 1 | `ON DELETE CASCADE` en `subscriptions` y `usage_counters` | Ambas FK pasan a `ON DELETE RESTRICT`, declaradas con nombre explícito y drop-then-add (patrón de 040) dentro de la propia 041, editada en sitio. |
| 2 | Falta comprobación SQL contra base real | `progress/checks_billing-model.sql`, ejecutado contra el Postgres del harness. Cubre RLS de escritura/lectura, el `REVOKE` de la RPC, RESTRICT por cada FK y las 100 llamadas concurrentes. Cada aserción tiene control negativo verificado. |
| 3 | Alcance mezclado con f0.4 (`ai_configs.api_key`) | El `ALTER TABLE ai_configs ... DROP NOT NULL` sale de 041 y va a `047_ai_platform_key.sql`, con su aserción en `verify-schema.sql`. 041 ya no menciona S1 salvo por su ausencia. |
| 4 | Sin informe ni CHANGELOG en el commit aislado | Este informe y la entrada Unreleased actualizada en `CHANGELOG.md` (dentro del commit). |

## Semántica de borrado y cómo se limpia una cuenta

`RESTRICT` en vez de `CASCADE`, y no un `SET NULL`: `subscriptions.account_id`
es la clave primaria y `usage_counters.account_id` forma parte de la suya, así
que no pueden quedar huérfanos apuntando a nada.

Consecuencia buscada: **`DELETE FROM accounts WHERE id = ...` falla** con
`foreign_key_violation` mientras la cuenta tenga suscripción o contadores. Es
un freno deliberado: el resto del esquema (17 tablas desde 017/026/029/030…)
cuelga de `accounts` con `CASCADE`, de modo que un borrado accidental de la fila
de la cuenta hoy arrasa con todo. Con estas dos FK en `RESTRICT`, ese borrado ya
no ocurre por descuido: hay que desmontar la facturación antes, a mano.

Procedimiento controlado para dar de baja una cuenta (rol de servicio, en una
transacción):

```sql
BEGIN;
-- 1. Cancelar primero en la pasarela (fuera de la base). Sin esto, PayPal
--    sigue cobrando y llegan webhooks de una cuenta que ya no existe.
-- 2. Archivar si hace falta conservarlo (exportar a CSV / tabla histórica).
SELECT * FROM subscriptions  WHERE account_id = :account_id;
SELECT * FROM usage_counters WHERE account_id = :account_id;
-- 3. Retirar las filas de facturación, explícitamente.
DELETE FROM usage_counters WHERE account_id = :account_id;
DELETE FROM subscriptions  WHERE account_id = :account_id;
-- 4. Ahora sí, la cuenta (y su cascada de datos operativos).
DELETE FROM accounts WHERE id = :account_id;
COMMIT;
```

`billing_events` **no** tiene clave ajena a `accounts` a propósito: es la
bitácora de la pasarela y sobrevive al borrado de la cuenta, que es lo que se
quiere para auditar cobros y reembolsos. La secuencia completa está probada en
la parte B de `checks_billing-model.sql`.

No hay ninguna ruta ni servicio en el repo que borre cuentas hoy
(`src/app/api/account/**` sólo tiene `api-keys`, `invitations`, `members`,
`transfer-ownership`), así que `RESTRICT` no rompe ningún camino existente. Si
la fase 4 añade «cerrar cuenta», tendrá que seguir el procedimiento de arriba.

`plan_id → plans(id)` se queda en la acción por defecto (`NO ACTION`): retirar
un plan del catálogo mientras alguien lo tiene contratado debe fallar, y eso ya
lo hace.

## Criterio ↔ prueba

Los criterios de aceptación de f0.2 son propiedades del esquema y de la RLS: no
hay TypeScript en el alcance de esta sección, así que no se añade ningún test
vitest (los de `entitlements` son de f0.3 y ya existen). Todo se prueba contra
un Postgres real.

| Criterio del spec (§2/§3) | Prueba | Dónde |
|---|---|---|
| Las cuatro tablas, la RPC y el catálogo sembrado existen | Aserciones `to_regclass` / `to_regprocedure` / `count(*) = 3` | `supabase/ci/verify-schema.sql` (bloque «Billing model (041)»), replay verde |
| RLS encendida en `subscriptions` | `relrowsecurity` | `verify-schema.sql` |
| Las FK a `accounts` no son CASCADE | `confdeltype = 'r'` para `subscriptions_account_id_fkey` y `usage_counters_account_id_fkey` | `verify-schema.sql` |
| `ai_configs.api_key` es nullable (047) | `information_schema.columns.is_nullable` | `verify-schema.sql` |
| Un usuario autenticado **no** puede escribir en `subscriptions` | INSERT denegado (`insufficient_privilege`), UPDATE con `ROW_COUNT = 0`, DELETE con `ROW_COUNT = 0`, fila intacta al final | `progress/checks_billing-model.sql`, parte A |
| Un miembro sí lee su suscripción y no la de otra cuenta | `count(*) = 1` sobre la propia, `count(*) = 0` sobre la ajena | parte A |
| `increment_usage` no es invocable por el inquilino | `PERFORM increment_usage(...)` como `authenticated` → `insufficient_privilege` | parte A |
| Borrar una cuenta no destruye datos de facturación | `DELETE FROM accounts` bloqueado por la suscripción sola, y por los contadores solos; teardown controlado sí funciona | parte B |
| 100 llamadas simultáneas a `increment_usage` dejan 100 | 100 sesiones psql en paralelo con barrera de reloj; contador final `= 100` en exactamente 1 fila | parte C |
| Ninguna ruta cambia de respuesta | El diff no toca `src/`; compuerta completa en verde (873 tests) | — |

### Controles negativos (que las pruebas muerden de verdad)

Cada aserción se validó rompiendo a propósito la propiedad en una transacción
que después se revierte:

| Sabotaje | Resultado |
|---|---|
| `CREATE POLICY ... FOR ALL TO authenticated USING (true)` | falla: `a tenant read 1 subscription row(s) of another account` |
| `CREATE POLICY ... FOR INSERT` | falla: `an authenticated user managed to INSERT into subscriptions` |
| `CREATE POLICY ... FOR UPDATE` | falla: `an authenticated user managed to UPDATE 1 subscription row(s)` |
| `CREATE POLICY ... FOR DELETE` | falla: `an authenticated user managed to DELETE 1 subscription row(s)` |
| `GRANT EXECUTE ON increment_usage TO authenticated` | falla: `an authenticated user managed to EXECUTE increment_usage` |
| FK de `subscriptions` vuelta a `CASCADE` | falla: `deleting an account with a subscription must be blocked by RESTRICT` |
| FK de `usage_counters` vuelta a `CASCADE` | falla: `deleting an account with usage counters must be blocked by RESTRICT` |
| Sólo 5 incrementos en vez de 100 | falla: `...must leave the counter at 100, found 5` |

La primera versión de la parte B pasaba con la FK de `subscriptions` en
`CASCADE` (la de `usage_counters` bloqueaba el borrado y tapaba el fallo); por
eso cada FK se prueba aislada, con su propia fila y su propio intento.

## Verificaciones contra base real

Postgres del harness (`supabase/postgres:17.4.1.075`) levantado con
`KEEP=1 scripts/replay-migrations.sh "$(pwd)"`.

1. **Replay limpio**: 001→041 y 047 más `verify-schema.sql`, salida **0**.
2. **Idempotencia**: 041 y 047 reejecutados sobre la base ya migrada →
   sin error, `verify-schema.sql` sigue pasando.
3. **Autorreparación**: dejando a mano la FK en `CASCADE` (`confdeltype = 'c'`)
   y reejecutando 041, vuelve a `'r'`. Esto es lo que hace que editar 041 en
   sitio sea seguro para cualquier base local que ya la tuviera aplicada.
4. **Partes A y B** de `checks_billing-model.sql`: salida 0, todo en
   transacciones revertidas (repetible).
5. **Parte C (concurrencia)**: este Postgres **no trae `pg_background`** (sólo
   `dblink`, `pg_cron` y `pgcrypto` están disponibles), y `dblink` exigiría
   contraseña porque el rol `postgres` de esta imagen no es superusuario. Como
   indicó el líder, la concurrencia se simula con **100 sesiones `psql` en
   paralelo desde el shell** (`xargs -P 100`), cada una como `service_role`.
   Para que sean simultáneas de verdad y no simplemente solapadas, las 100
   esperan a un mismo instante de reloj (`pg_sleep` hasta `T`) y disparan a la
   vez. Resultado: una única fila en `usage_counters`
   (`period_start = 2026-09-01`) con `value = 100`.
   El driver exacto está en la cabecera del propio
   `progress/checks_billing-model.sql`.

## Verificaciones manuales pendientes

Ninguna. Nada de esta feature depende de Meta ni de PayPal: el modelo es
agnóstico a la pasarela y no hay integración todavía (eso es la fase 3).

## Decisiones donde el spec era ambiguo

- **`RESTRICT` y no una función de limpieza auditada.** El spec pedía
  «semántica segura explícita»; se eligió lo más simple que no añade código:
  la base impide el borrado y el procedimiento de baja queda documentado
  (arriba y en la cabecera de 041). Una función `purge_account()` sería código
  de fase 4 sin caso de uso hoy.
- **FK con nombre y drop-then-add** en lugar de `REFERENCES` en línea. Cuesta
  cuatro líneas y da idempotencia real: `CREATE TABLE IF NOT EXISTS` no corrige
  una tabla que ya existe con la semántica vieja.
- **Número 047** para S1, no 042: 042/043 son de la fase 1, 044 de la fase 2 y
  045/046 de la fase 3 (decisión del líder registrada en `progress/current.md`).
- **047 envuelto en `DO ... IF to_regclass('public.ai_configs') IS NOT NULL`**:
  hace la migración inofensiva en un despliegue que aún no tenga la tabla y
  explícitamente no-op al reejecutarse.
- **La aserción de 047 en `verify-schema.sql` es negativa** (`IF EXISTS ... AND
  is_nullable = 'NO' THEN RAISE`): es la única forma de detectar un `DROP NOT
  NULL` que no se aplicó, porque no crea ningún objeto que buscar.
- **`plans` sigue sin FK de borrado explícita**: `NO ACTION` ya bloquea retirar
  un plan contratado.

## Variables de entorno nuevas

Ninguna en esta feature. `AI_PLATFORM_OPENAI_API_KEY` y
`AI_PLATFORM_ANTHROPIC_API_KEY` son de f0.4 y ya están documentadas en
`docs/docker.md` (líneas 53-54, commit `8854c65`); 047 sólo mueve el cambio de
esquema que las acompaña. `.env.local.example` sigue bloqueado por permisos
(`Read(./**/.env*)` en `.claude/settings.json`): no se ha tocado.

## Compuerta

Ejecutada en el worktree, en orden, antes del commit:

| Comando | Resultado |
|---|---|
| `npm run lint` | PASS — 0 errores, 37 warnings preexistentes |
| `npm run typecheck` | PASS |
| `TZ=UTC npm test` | PASS — 83 archivos, 873 tests |
| `npm run build` | PASS (variables dummy de `docs/harness.md`) |
| `scripts/replay-migrations.sh "$(pwd)"` | PASS — salida 0 |

## Deuda detectada fuera de alcance (no arreglada)

- **`CHANGELOG.md` no está limpio para prettier** desde antes de esta feature:
  `npx prettier --check CHANGELOG.md` ya fallaba en `HEAD~1`. Las diferencias
  están todas en secciones publicadas (líneas 132+: `*texto*` vs `_texto_`,
  sangrado de listas); la sección Unreleased que toco sí queda como prettier la
  dejaría. No se reformatea el archivo entero para no meter 36 líneas de ruido
  ajeno en el diff. CI no corre `prettier --check`, así que no bloquea nada.
- **El resto del esquema cuelga de `accounts` con `CASCADE`** (17 tablas desde
  017 y siguientes). Borrar una cuenta sigue arrasando contactos,
  conversaciones y mensajes. Es preexistente y fuera del alcance de §2; ahora
  al menos está frenado de hecho por las dos FK de facturación.
- **`max_connections = 100` (3 reservadas) en la imagen del harness** deja la
  prueba de concurrencia una conexión corta. Se sube a 300 con `ALTER SYSTEM`
  como paso previo documentado en el guion. Si esta comprobación se
  automatizara, convendría que `scripts/replay-migrations.sh` aceptara
  parámetros de arranque de Postgres.
- **El grafo de graphify no ata tablas SQL con el código TS**, así que
  `graphify explain "subscriptions"` no encuentra las tablas nuevas hasta que
  el hook de post-commit reextrae. Conocido y documentado en `CLAUDE.md`.
