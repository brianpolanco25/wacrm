# Review — f0.3 entitlements

**Veredicto:** APPROVED

Alcance revisado: `2645848` aislado (`git diff 2645848^..2645848`) en
`saas/fase-0-cimientos`, worktree `.claude/worktrees/agent-a85d874ab350adc04`
(HEAD `324f087`, limpio). Diff neto: dos archivos nuevos,
`src/lib/billing/entitlements.ts` (244 líneas) y
`src/lib/billing/entitlements.test.ts` (363 líneas, 25 tests). Cero SQL, cero
rutas, cero `package.json`. No existe `progress/impl_entitlements.md`; usé
`progress/impl_fase-0.md` como referencia y partí del diff.

## Compuerta

Ejecutada por mí en el worktree, con las variables dummy de `docs/harness.md`:

| Comando | Resultado |
|---|---|
| `npm run lint` | verde (0 errores, 37 warnings preexistentes) |
| `npm run typecheck` | verde |
| `TZ=UTC npm test` | verde — 83 archivos, 873 tests |
| `npm run build` | verde |
| `KEEP=1 scripts/replay-migrations.sh <worktree>` | verde — 001→041, 047 y `verify-schema.sql: OK` (n/a para el diff, necesario para las pruebas de base de C3/C4) |

## Trazabilidad criterio ↔ test

Criterios de `docs/saas/fase-0-cimientos.md` §3. Leí cada test, no solo su
nombre.

- **C1 «`getEntitlements` devuelve el plan de prueba para una cuenta sin
  suscripción»**: [x] `src/lib/billing/entitlements.test.ts:119` ›
  *"resolves an account with no subscription row to the trial plan (pro,
  trialing, not read-only)"*. Con `h.state.subscription = null` afirma
  `planId='pro'`, `status='trialing'`, `readOnly=false`, `trialEndsAt=null`
  y que límites y prestaciones son los de Pro — no se conforma con que no
  lance. Complementado por `:130` (cuando sí hay fila manda la fila) y
  `:174` (estado desconocido → `trialing`, `entitlements.ts:187-190`).
  La existencia real de la fila `pro` la garantiza
  `supabase/ci/verify-schema.sql` (`count(*) = 3` en `plans`), no el test,
  que trabaja contra un doble.
- **C2 «`assertQuota` lanza cuando el contador supera el límite y no lanza
  cuando el límite es `null`»**: [x] cinco tests, los dos lados del criterio:
  - `:251` *"throws QuotaExceededError with metric/limit/used when used + n
    exceeds the limit"* — `inicio`/`ai_replies` 500, usado 500 → comprueba la
    clase del error y sus tres campos.
  - `:267` *"accounts for n: 498 used + 2 passes, + 3 throws"* — fija el
    borde exacto (`used + n > limit`, `entitlements.ts:243`).
  - `:278` *"does not throw when the limit is null (unlimited) and never
    reads the counter"* — además de no lanzar con `value = 10.000.000`,
    afirma que no se consultó `usage_counters`: prueba el corto de
    `entitlements.ts:231`, no solo el resultado.
  - `:289` métrica desconocida, `:298` fila ausente = 0, `:331` un error de
    lectura se propaga (no degrada a «sin límites»), `:319` el contador se lee
    del mes natural en curso en UTC (`period_start = 2026-09-01` con reloj
    falso en `2026-09-30T23:30Z`).
- **C3 «`increment_usage` es correcto bajo concurrencia: 100 llamadas
  simultáneas dejan el contador exactamente en 100»**: [x] base real, no
  vitest. SQL: `progress/checks_billing-model.sql:230-297` (parte C).
  Lo corrí yo contra el contenedor del harness: fixture, barrera de reloj
  común y `xargs -P 90` con 90 sesiones `psql` como `service_role`.
  Resultado: **una sola fila** en `usage_counters`
  (`period_start = 2026-09-01`) con **`value = 90`**, cero errores.
  90 y no 100 porque la imagen trae `max_connections = 100` y el
  `docker restart` que exige subirlo está bloqueado por permisos en mi
  entorno; la corrida completa a 100 (con muestreo de `pg_stat_activity`)
  consta en `progress/review_billing-model.md` §C7. Un `upsert` que perdiera
  actualizaciones fallaría igual con 90.
- **C4 «Un usuario autenticado no puede escribir en `subscriptions` (prueba
  contra la RLS, no solo contra la ruta)»**: [x] base real.
  `progress/checks_billing-model.sql:45-161` (parte A), ejecutada por mí:
  salida silenciosa = todas las aserciones pasan. **Control negativo mío**:
  añadí `CREATE POLICY tmp_sabotage ON subscriptions FOR UPDATE TO
  authenticated USING (true) WITH CHECK (true)` y la misma parte A falló con
  `an authenticated user managed to UPDATE 1 subscription row(s)` — la
  comprobación no es vacua. Política borrada después; `pg_policy` sobre
  `subscriptions` queda con una sola entrada, `subscriptions_select`
  (`polcmd = 'r'`).
- **C5 «La aplicación se comporta igual que antes: ninguna ruta cambia de
  respuesta»**: [x] tres evidencias independientes. (a) El diff solo añade
  dos archivos bajo `src/lib/billing/`, ninguno bajo `src/app/`. (b)
  `grep -rn "entitlements|getEntitlements|assertQuota|hasFeature"` sobre
  `src/` excluyendo el propio módulo: **cero resultados** — nadie lo importa,
  la capa está «sin cablear» tal como exige el spec. (c) Suite completa en
  verde (873/873).

Interfaz contra el spec: `Entitlements`, `getEntitlements`, `hasFeature` y
`assertQuota(accountId, metric, n?)` coinciden. El módulo añade `trialEndsAt`
al tipo y exporta `assertFeature`, `isReadOnly`, `currentPeriodStart`,
`normalizeLimits`, `TRIAL_PLAN_ID` y dos errores tipados: aditivo, no
contradice el spec.

## Aislamiento (CP3, mirado a mano)

`getEntitlements` y `assertQuota` corren con `supabaseAdmin()`, que salta la
RLS. Las tres consultas del módulo:

- `entitlements.ts:178-182` `subscriptions` → `.eq('account_id', accountId)`. ✓
- `entitlements.ts:192-196` `plans` → `.eq('id', planId)`. Correcto: `plans`
  es catálogo global, no tiene columna `account_id` (`041:54-63`). ✓
- `entitlements.ts:233-239` `usage_counters` → `.eq('account_id', accountId)`
  + `metric` + `period_start`. ✓

Test de fuga: `entitlements.test.ts:144` › *"always filters subscriptions and
usage by account_id (leak test)"*. El doble registra cada `.eq()` y el test
afirma `['account_id', ACCOUNT]` en la consulta de `subscriptions` y en la de
`usage_counters`. Es un test de forma (el doble no simula dos inquilinos
reales), pero caza exactamente la regresión que importa: quitar el filtro.

## Checkpoints

- **CP1 Compuerta**: [x] los cuatro comandos ejecutados por mí, verdes.
- **CP2 Migraciones**: [x] n/a — el diff no contiene SQL. Aun así corrí
  `replay-migrations.sh` (verde) porque C3/C4 se prueban en base.
- **CP3 Aislamiento**: [x] tres consultas con rol de servicio, dos filtradas
  por `account_id` y la tercera sobre una tabla sin inquilino; test de fuga
  presente y leído.
- **CP4 Tests**: [x] los cinco criterios cubiertos; los dos que exigen base
  real tienen su SQL en `progress/checks_billing-model.sql` y los ejecuté yo,
  uno con control negativo.
- **CP5 Sin dependencias nuevas**: [x] `git diff 2645848^..2645848 --
  package.json package-lock.json` vacío.
- **CP6 i18n**: [x] n/a — sin UI ni cadenas nuevas. Los mensajes de error son
  de servidor, para el log/mapeo de fase 3.
- **CP7 Next 16**: [x] n/a — no se usa ninguna API de framework: TypeScript
  puro más el cliente de Supabase.
- **CP8 Alcance**: [x] dos archivos nuevos en `src/lib/billing/`, justo lo que
  §3 pide. Nada tocado fuera.
- **CP9 Documentación**: [~] `CHANGELOG.md:42-45` documenta el módulo y dice
  explícitamente que no lo llama ninguna ruta (entró en `8854c65`, commit de
  f0.4). **No existe `progress/impl_entitlements.md`**: el informe vive
  agregado en `progress/impl_fase-0.md`, que coincide con el diff en commit,
  cobertura y decisiones. Estado aceptado por el líder al lanzar la revisión;
  no bloquea, pero queda anotado.
- **CP10 Git**: [x] `2645848` en `saas/fase-0-cimientos`, mensaje en español
  con prefijo `feat:` y `Co-Authored-By`. `git branch -r --contains 2645848`
  vacío. `main` en `46a0999` y `feat/saas-multiempresa` en `593b92f`,
  intactas.
- **CP11 Lo entrante nunca se bloquea**: [x] verificado por ausencia: nadie
  importa el módulo (grep en (c) de C5), así que ni el webhook de WhatsApp ni
  ninguna otra ruta puede lanzar `QuotaExceededError` ni consultar
  `subscriptions` hoy. Cuando la fase 3 lo cablee, este checkpoint hay que
  volver a comprobarlo de verdad: los hallazgos 1, 2 y 4 de abajo son
  precisamente las trampas de ese momento.

## Hallazgos (archivo:línea)

Ninguno bloquea: el módulo no lo llama nadie y los cinco criterios de §3 se
cumplen. Todos son deuda que la **fase 3** hereda al cablearlo. Contrastados
con el skill `code-review` a nivel `high` sobre `2645848^..2645848`; de sus
nueve hallazgos comparto siete y descarto dos (ver abajo).

1. `src/lib/billing/entitlements.ts:230` — **`assertQuota` trata cualquier
   clave de `plans.limits` como métrica de `usage_counters`**, pero solo
   `messages_out`, `ai_replies` y `broadcast_recipients` se incrementan por
   RPC. `assertQuota(acc, 'operators')` leería una fila que nunca existe,
   `used = 0`, y no lanzaría jamás: un plan Inicio con tope de 3 operadores
   admitiría 50 sin un solo error, en silencio. Los topes de cardinalidad
   (`operators`, `contacts`, `numbers`, `knowledge_documents`) y el ajuste
   `retention_months` necesitan otro camino (contar filas), o `assertQuota`
   debe rechazar métricas que no sean de consumo. El propio test `:278` usa
   `retention_months` como ejemplo de «cuota ilimitada», lo que refuerza la
   confusión.
2. `src/lib/billing/entitlements.ts:103` — **una prueba vencida nunca pasa a
   solo lectura.** `isReadOnly` ignora `trialEndsAt`, que el módulo expone
   pero no consume. Un inquilino en `trialing` con `trial_ends_at` en el
   pasado sigue con Pro completo; sin suscripción en la pasarela no llegará
   ningún webhook que lo cambie, y no hay cron de expiración en el repo. La
   fase 3 debe cerrar esto en `isReadOnly` (ya recibe `now`) o con un job.
3. `src/lib/billing/entitlements.ts:186` — **la ausencia de fila en
   `subscriptions` concede Pro sin fecha de caducidad.** Es la regla que pide
   el spec («ninguna cuenta existente se queda sin permisos»), correcta para
   la ventana de migración, pero sin suelo: borrar la fila de un moroso —paso
   intermedio del procedimiento de baja documentado en `041:38-42`— le
   *sube* el plan. Cuando la fase 3 siembre suscripciones para todas las
   cuentas, esta caída debería resolver al plan más barato o anclarse a
   `accounts.created_at`.
4. `src/lib/billing/entitlements.ts:233` — **`assertQuota` + `increment_usage`
   es comprobar-luego-actuar, no atómico**, pese a que el spec cita
   `claim_ai_reply_slot` como patrón. `increment_usage` (`041:170-186`) es un
   upsert sin `WHERE value < limite`, a diferencia del `UPDATE ... WHERE
   ai_reply_count < max_replies` de la 029. Dos webhooks simultáneos con
   `used = 2999` y tope 3000 pasan los dos y el contador acaba en 3001. La
   fase 3 necesita un tope en la RPC o comparar el valor devuelto **después**
   de incrementar; conviene decidirlo antes de cablear.
5. `src/lib/billing/entitlements.ts:104` — `past_due` con `grace_until` nulo
   nunca es solo lectura. Es la única rama donde fallar-abierto cuesta dinero
   directo: si el manejador de PayPal marca `past_due` sin sellar la gracia,
   el inquilino queda operativo indefinidamente. Un suelo por defecto
   (`updated_at + N días`) lo cierra.
6. `src/lib/billing/entitlements.ts:127-136` — `normalizeLimits` descarta los
   valores malformados y descartar **es** ilimitado (`:231` retorna en
   `undefined`), justo lo contrario del principio que el módulo declara en
   `:169-172` («no degradar a sin límites»). Un `{"ai_replies": "500"}`
   escrito a mano en `plans.limits` deja esa métrica sin tope, sin error ni
   traza. Debería lanzar como lo hace el plan ausente, o al menos avisar.
7. `src/lib/billing/entitlements.ts:205-212` — `subscriptions.addons` se
   ignora. La columna existe (`041:79`) para llevar extras (asientos,
   números) y este módulo es la única fuente de verdad de lo permitido: un
   complemento comprado no cambiaría ningún límite. Fusionar `addons` sobre
   los límites del plan, o dejar la columna documentada como no usada hasta
   que la fase 3 fije su forma.
8. Zona horaria del periodo (ya anotado en `progress/review_billing-model.md`,
   lo confirmo desde este lado): `currentPeriodStart` (`entitlements.ts:116-120`)
   calcula el mes en UTC, mientras `increment_usage` (`041:179`) usa
   `date_trunc('month', now())::date`, que depende del `TimeZone` de la
   sesión. En un Postgres que no esté en UTC, el primer y el último día del
   mes la RPC escribe una fila que `assertQuota` no lee. El comentario de
   `:113-115` asume la sesión en UTC, que es el caso en Supabase; es una
   suposición, no una garantía del código.

Del `code-review` **descarto** dos: las dos vueltas a base de
`getEntitlements` (`:192`) —la ganancia solo importa cuando esto sea camino
caliente, y ese es el momento de medir, no ahora— y la falta de un
`assertWritable`, que es diseño de la fase 3 y no un defecto de este diff.

## Cambios requeridos

Ninguno para f0.3.

Para el líder, dos cosas que **no** deben perderse al planificar la fase 3:
los hallazgos 1, 2 y 4 son fallos que fallan **abiertos** (no cobran de más:
dejan pasar), así que no se notarán en producción hasta que alguien mire la
factura; y CP11 vuelve a estar en juego el día que `assertQuota` entre en el
camino del webhook.
