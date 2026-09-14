# Review — f0.2 billing-model (re-revisión tras 324f087)

**Veredicto:** APPROVED

Alcance revisado: `62a0742` (original) + `324f087` (corrección) en
`saas/fase-0-cimientos`, worktree
`.claude/worktrees/agent-a85d874ab350adc04`. Diff neto de la feature:
`supabase/migrations/041_billing_model.sql`,
`supabase/migrations/047_ai_platform_key.sql`, `supabase/ci/verify-schema.sql`,
`CHANGELOG.md`. Cero archivos en `src/`.

## Compuerta

Ejecutada por el reviewer en el worktree, con las variables dummy de
`docs/harness.md`:

| Comando | Resultado |
|---|---|
| `npm run lint` | verde (0 errores, 37 warnings preexistentes) |
| `npm run typecheck` | verde |
| `TZ=UTC npm test` | verde — 83 archivos, 873 tests |
| `npm run build` | verde |
| `KEEP=1 scripts/replay-migrations.sh <worktree>` | verde — 001→041, 047 y `verify-schema.sql: OK` |

## Los cuatro hallazgos anteriores

| # | Hallazgo | Estado | Cómo lo comprobé |
|---|---|---|---|
| 1 | `ON DELETE CASCADE` en `subscriptions` y `usage_counters` | **cerrado** | `pg_constraint.confdeltype = 'r'` en las dos FK contra la base del harness; `041_billing_model.sql:86-90,108-112` usa drop-then-add con nombre explícito |
| 2 | Falta comprobación SQL contra base real | **cerrado** | `progress/checks_billing-model.sql` ejecutado por mí, salida 0; controles negativos reproducidos uno a uno (abajo) |
| 3 | Alcance mezclado con f0.4 (`ai_configs.api_key`) | **cerrado** | 041 ya no toca `ai_configs`; el `DROP NOT NULL` vive en `047_ai_platform_key.sql`, envuelto en `IF to_regclass(...) IS NOT NULL`. Número 047 y su permanencia en el commit de f0.2: decisión del líder |
| 4 | Informe y CHANGELOG ausentes | **cerrado** | `progress/impl_billing-model.md` existe y coincide con el diff; `324f087` actualiza la sección Unreleased (RESTRICT, 047) |

## Trazabilidad criterio ↔ prueba

No hay TypeScript en §2, así que no procede vitest; todo se prueba contra
Postgres real. Ejecuté yo cada prueba y su control negativo.

- C1 «Las cuatro tablas, la RPC y el catálogo sembrado existen»: [x]
  `supabase/ci/verify-schema.sql:63-84` — `to_regclass` × 4,
  `to_regprocedure('public.increment_usage(uuid, text, bigint)')`,
  `count(*) = 3` en `plans`. Replay verde.
- C2 «Las FK a `accounts` no son CASCADE»: [x] `verify-schema.sql:91-110`
  (`confdeltype = 'r'`). Saboteé la FK de `subscriptions` a `CASCADE` y
  `verify-schema.sql` falló con
  `subscriptions_account_id_fkey is missing or not ON DELETE RESTRICT`.
  Reejecutar 041 sobre la base saboteada la devolvió a `'r'`: la migración
  es idempotente y autoreparadora.
- C3 «Un usuario autenticado **no** puede escribir en `subscriptions`»: [x]
  `progress/checks_billing-model.sql:106-144` (parte A). Verificado:
  INSERT → `insufficient_privilege`; UPDATE y DELETE → `ROW_COUNT = 0`;
  la fila sigue en `inicio`/`trialing`. Controles negativos que yo mismo
  reproduje: con `CREATE POLICY ... FOR UPDATE` la comprobación falla con
  `an authenticated user managed to UPDATE 1 subscription row(s)`; con
  `FOR INSERT`, `...managed to INSERT into subscriptions`.
- C4 «Un miembro lee la suya y no la ajena»: [x] `checks:97-104` —
  `count = 1` sobre la propia, `count = 0` sobre la de otra cuenta.
- C5 «`increment_usage` no es invocable por el inquilino»: [x]
  `checks:146-156`. Control negativo:
  `GRANT EXECUTE ... TO authenticated` → falla con
  `an authenticated user managed to EXECUTE increment_usage`.
- C6 «Borrar una cuenta no destruye datos de facturación»: [x]
  `checks:169-227` (parte B), cada FK aislada. Controles negativos:
  volviendo cada FK a `CASCADE` por separado, falla con
  `deleting an account with a/an ... must be blocked by RESTRICT`.
- C7 «100 llamadas simultáneas a `increment_usage` dejan el contador en
  100»: [x] parte C. Lo corrí yo: `max_connections = 300`, fixture,
  100 `psql` con `xargs -P 100` y barrera de reloj. Resultado
  `usage_counters` = **1 fila** (`period_start = 2026-09-01`) con
  **`value = 100`**. Además muestreé `pg_stat_activity` durante la ventana:
  **100 backends simultáneos** ejecutando la sentencia — la concurrencia es
  real, no sesiones solapadas. Control negativo: con 5 incrementos, la
  aserción falla con `...must leave the counter at 100, found 5`.
- C8 «Ninguna ruta cambia de respuesta»: [x] el diff de f0.2 no toca `src/`;
  suite completa en verde. Además, `RESTRICT` no rompe ningún camino vivo:
  no existe hoy ninguna ruta ni servicio que borre `accounts`
  (`grep` de `.delete()` y `from('accounts')` en `src/` y `mcp-server/`), y
  `accounts_owner_user_id_fkey` **ya era** `RESTRICT` antes de esta feature,
  así que borrar el usuario dueño tampoco cambia de comportamiento.

## Checkpoints

- CP1 Compuerta: [x] los cuatro comandos ejecutados por mí, verdes.
- CP2 Migraciones: [x] 041 y 047 idempotentes (reejecuté ambas sobre la base
  ya migrada, sin error y con `verify-schema` verde), aserción por objeto
  nuevo, `ON DELETE RESTRICT` en las dos FK, ningún `CASCADE` nuevo.
- CP3 Aislamiento: [ ] n/a — no hay TypeScript ni `supabaseAdmin()` en el
  diff. `increment_usage` es `SECURITY DEFINER` con `REVOKE` de
  `public`/`anon`/`authenticated` y `GRANT` solo a `service_role`
  (`041:189-192`), verificado en base.
- CP4 Tests: [x] `progress/checks_billing-model.sql` ejecutado por mí con
  controles negativos; no procede vitest.
- CP5 Dependencias: [x] `git diff 96474fc 324f087 -- package.json
  package-lock.json` vacío.
- CP6 i18n: [ ] n/a — sin UI ni claves nuevas en f0.2.
- CP7 Next 16: [ ] n/a — sin API de framework en el diff.
- CP8 Alcance: [x] con la salvedad registrada: 047 implementa §4/S1 y viaja
  en el commit de f0.2 por decisión del líder (042–046 reservadas por otras
  fases). El resto del diff es §2 estricto.
- CP9 Documentación: [x] `progress/impl_billing-model.md` coincide con el
  diff commit a commit; Unreleased actualizado; sin variables de entorno
  nuevas en f0.2.
- CP10 Git: [x] `324f087` en `saas/fase-0-cimientos`, prefijo `fix:`, español,
  `Co-Authored-By`. `git branch -r --contains 324f087` vacío: nada pusheado.
  `main` en `46a0999` y `feat/saas-multiempresa` en `593b92f`, intactas.
- CP11 Entrantes no bloqueados: [x] el diff no toca el webhook; `RESTRICT`
  solo afecta a `DELETE FROM accounts`, que ningún camino de entrada ejecuta.

## Hallazgos (no bloqueantes)

Contrastados con el skill `code-review` a nivel `high` sobre
`96474fc..324f087`. Siete de sus nueve hallazgos caen en
`src/lib/billing/entitlements.ts` y `src/lib/ai/**` — código de f0.3 y f0.4,
fuera del diff de f0.2; van a los revisores de esas features, no aquí. Los
que sí tocan el diff de f0.2:

1. `src/app/api/ai/config/route.ts:271` — «nullable since migration 041»
   quedó **falso** al mover el `DROP NOT NULL` a 047 en `324f087`. Es la
   única referencia obsoleta que dejó esta corrección (verificado:
   `grep -rn "041" src docs mcp-server`; `src/lib/billing/entitlements.ts:3,169`
   siguen siendo correctas, apuntan al modelo de facturación). No es un fallo
   de comportamiento y el archivo pertenece a f0.4 —que sigue en `review`—,
   así que se le pasa a esa revisión en vez de bloquear f0.2. Mitigado: el
   CHANGELOG ya lista 047 como migración requerida y
   `verify-schema.sql:115-123` falla si no se aplicó.
2. `supabase/migrations/041_billing_model.sql:179` — `increment_usage` ancla
   el periodo con `date_trunc('month', now())::date`, que depende del
   `TimeZone` de la sesión, mientras `entitlements.currentPeriodStart()`
   (f0.3) lo calcula en UTC. En un despliegue cuyo Postgres no esté en UTC,
   el primer y el último día del mes la RPC escribiría una fila que
   `assertQuota` no lee. No bloquea f0.2: la RPC es literal del spec
   (`docs/saas/fase-0-cimientos.md:145-172`) y nadie llama a `assertQuota`
   todavía. Para f3.4: `date_trunc('month', now() AT TIME ZONE 'UTC')::date`
   en una migración nueva, o alinear el lado TS.
3. `supabase/ci/verify-schema.sql:80` — `count(*) <> 3` sobre `plans` fija el
   tamaño del catálogo. Cuando f3.x añada un plan (gratuito, enterprise), la
   aserción romperá en PRs no relacionados hasta que alguien edite el número.
   `count(*) FILTER (WHERE id IN ('inicio','pro','negocio')) = 3` caza el
   mismo error sin ser frágil. Suficiente para hoy.
4. `supabase/ci/verify-schema.sql:85-87` — CI solo comprueba que RLS está
   **encendida** en `subscriptions`. Una política de escritura añadida más
   adelante (fase 3, al cablear la pasarela) pasaría CI sin ruido: las
   propiedades de escritura solo las cubre `checks_billing-model.sql`, que CI
   no ejecuta. Sugerencia para f3.3: asertar que `pg_policies` no tiene
   ninguna política sobre `subscriptions` con `cmd <> 'SELECT'`.
5. Integración, para el líder: `041_billing_model.sql` se editó en sitio
   después de que `.claude/worktrees/fase-1` y `.claude/worktrees/fase-3`
   partieran de esta rama, y ambos worktrees siguen con la 041 vieja
   (`CASCADE` + el `ai_configs`). El merge conflictuará en ese archivo; si se
   resuelve mal, `verify-schema.sql:91-110` lo caza en CI. Numeración libre
   confirmada: 042/043 en fase 1, 044 en fase 2, 045 en fase 3, 047 aquí.
6. `progress/impl_billing-model.md:185-190` — deuda ya anotada por el
   implementer: `CHANGELOG.md` no pasa `prettier --check` desde antes de esta
   feature. CI no corre prettier; correcto no reformatear.

## Cambios requeridos

Ninguno para f0.2. Dos cosas que el líder debe encaminar fuera de esta
feature: el comentario obsoleto de `src/app/api/ai/config/route.ts:271`
(revisión de f0.4) y el desajuste de zona horaria del periodo (f3.4).
