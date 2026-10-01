# Review — s9.7 unlimited-plan-and-seed

**Veredicto:** APPROVED

Worktree `.claude/worktrees/unlimited-seed`, rama `platform/unlimited-seed`, rango `bdc6783..7bf11d0` (3 commits).
`npm run build` NO ejecutado por orden del líder (descarga la fuente de Google). Skill `code-review` no lanzado por orden del líder.

## Compuerta
- lint: verde (0 errores, 35 warnings previas, ninguna en archivos tocados)
- typecheck: verde
- test (`TZ=UTC npm test -- --reporter=dot`): verde, 249 archivos / 3505 tests
- build: no ejecutado (orden del líder)
- replay-migrations: verde (001…074 + verify-schema OK)
- Ejecutado por mí sobre el contenedor de la réplica (`KEEP=1`):
  - 074 aplicada una segunda vez sobre base limpia: `INSERT 0 1` (upsert del plan), DO sin filas, `INSERT 0 0` operador; 4 planes, 0 `platform_admins`, 0 filas en `impersonation_log` -> idempotente y 0 filas sin usuarios.
  - shim GoTrue + `seed.sql` dos veces: 1ª `3/3/1/1/1/1/1/0`, 2ª sin inserciones nuevas (solo UPDATE a valores absolutos). Sin errores.
  - `progress/checks_unlimited-plan-and-seed.sql`: salida 0, 11 NOTICE OK (3 usuarios/identidades, 1 fila plan_override del seed; `is_platform_admin(operador)` true y el resto false; Cabbity ilimitado/manual/active con 8 límites null y todas las features; Demo inicio/incomplete sin perfil; `platform_metrics()` comped 1, MRR 0; catálogo público = inicio/pro/negocio; 074 tras crear usuarios asigna y registra UNA vez; no pisa PayPal vivo; conserva `manual_hold_*`; ignora operador sin confirmar; 0 filas sin usuarios).
  - Comprobaciones extra mías (BEGIN/ROLLBACK): propietario sin confirmar -> la 074 no le asigna el plan (queda inicio/paypal/incomplete); correos con mayúsculas y espacios (`' BrianMPolanco@Gmail.com '`, `BrianPolancoDisenos@gmail.com`) -> asigna ilimitado/manual/active y concede 1 operador.
  - `verify-schema.sql` re-ejecutado tras el seed: OK.

## Trazabilidad criterio ↔ test
- C1 «plan `ilimitado`, is_public=false, límites null, todas las features, precio 0, sort 99, sin PayPal»: [x] `src/lib/billing/unlimited-plan.test.ts` › "has every limit key of the inventory, all null", "has every feature of the inventory, in the inventory order" (compara con `PLAN_FEATURES`/`PLAN_LIMIT_KEYS` de verdad), "is hidden, free, last, and never touches the PayPal ids"; + bloque `-- 074` de `verify-schema.sql` + réplica.
- C2 «asignación idempotente por correo, manual/active, 0 filas si no existe»: [x] `unlimited-plan.test.ts` › "assigns it by hand, audited, and grants the operator by email" (estático) + checks SQL 7, 10 y mi reaplicación.
- C3 «plan_override solo si se asignó»: [x] checks SQL 7 (una fila tras dos pasadas) y 8 (ninguna si salta).
- C4 «platform_admins por correo, ON CONFLICT DO NOTHING»: [x] test estático + checks 7 y 9.
- C5 «seed: operador con email_confirmed_at, crypt/gen_salt('bf'), platform_admins»: [x] `src/lib/platform/seed.test.ts` › "creates the three accounts of the spec, with the lab password hashed" + checks 1–2.
- C6 «seed: brianmpolanco con cuenta ilimitado/active»: [x] seed.test › "gives Cabbity the unlimited plan by hand and leaves the demo unpaid" + check 3.
- C7 «seed: cliente demo inicio/incomplete»: [x] mismo test + check 4.
- C8 «seed solo local: cabecera, sin URLs ni claves, idempotente»: [x] seed.test › "says it is local-only in its header", "has no remote project URL and no key", "is idempotent by construction" (solo INSERT/UPDATE, cada INSERT con ON CONFLICT/NOT EXISTS) + mi doble aplicación.
- C9 «CI con --no-seed, replay no lo toca»: [x] seed.test › "is only run by `supabase db reset --local`…"; leído a mano: `.github/workflows/migrations.yml:64` `supabase db reset --local --no-seed`, único `db reset` en workflows; `scripts/replay-migrations.sh:46` solo itera `supabase/migrations/*.sql` y luego `verify-schema.sql`.
- C10 «ilimitado fuera de `/api/billing/plans` y PlanPicker»: [x] `src/app/api/billing/plans/route.test.ts` › "never lists the unlimited plan of the 074…"; ruta filtra `.eq('is_public', true)` (`route.ts:38`), checkout rechaza `!plan.is_public` (`checkout/route.ts:205`); PlanPicker consume esa ruta.
- C11 «sync no permite publicarlo, UI dice “no se vende”»: [x] `plan-sync.ts:555` devuelve `no_price`; `src/components/platform/platform-plans.test.tsx` › "says «no se vende» for a never-published cycle without a price (ilimitado, 074)" (2 celdas, texto de `hint.notForSale`, y un ciclo con precio sin publicar conserva el botón).
- C12 «docs/security.md: producción y aviso de seed local»: [x] leído (`docs/security.md`, sección «Operators and the unlimited plan»).
- C13 «i18n clave nueva»: [x] `Platform.plans.hint.notForSale` en es/en/ko, sin placeholders; test CP6 existente del mismo archivo.
- Guion manual (`supabase db reset --local` con GoTrue real y login con las tres cuentas): presente en el informe.

## Desvíos declarados
1. No sellar `onboarding_completed_at`: **aceptado**. `src/lib/onboarding/state.ts`: con `status` ≠ `incomplete` y perfil incompleto, el owner va a `company` y el resto a `done`; nunca a `plan` (esa rama solo existe con `!paying`). Tras guardar, `api/onboarding/company/route.ts:97` recalcula el estado, sella (`stampCompleted`) y devuelve `done`; `onboarding-flow.tsx:284` navega a `/dashboard`. Cubierto por `state.test.ts` › "a manual plan (s9.4) without company data only shows step 1 to the owner".
2. Solo confirmados y no pisar PayPal vivo: **aceptado**, verificado en SQL (checks 8 y 9 + mi prueba del propietario sin confirmar). `confirmed_at` en GoTrue es `LEAST(email_confirmed_at, phone_confirmed_at)`, que ignora NULL: con Auto Confirm cumple.
3. Aserción de la 041: **no debilita**. «los 3 ids de la 041 existen» + «exactamente 4 filas» en el bloque 074 + «ninguno de los 3 se volvió oculto» equivalen, en base limpia, a {inicio, pro, negocio, ilimitado} exactos.
4. `[db.seed]` explícito y comentario del workflow: **aceptado**. CI sigue con `--no-seed` (confirmado leyendo el workflow); la réplica no lee `seed.sql`. `supabase db push` no aplica el seed sin `--include-seed`.

## Checkpoints
- CP1: [x] lint, typecheck, test en verde ejecutados por mí; build no ejecutado por orden del líder.
- CP2: [x] `074_plan_ilimitado.sql` con el número del spec, idempotente (verificado aplicándola dos veces), aserciones en `verify-schema.sql`, réplica 0, sin CASCADE.
- CP3: [x] n/a en código: sin consultas nuevas con `supabaseAdmin()`. La 074 filtra por correo del propietario y por `account_id` de su cuenta.
- CP4: [x] ver trazabilidad; SQL en `progress/checks_unlimited-plan-and-seed.sql`, guion manual en el informe.
- CP5: [x] `package.json` sin cambios.
- CP6: [x] `hint.notForSale` en los tres catálogos.
- CP7: [x] n/a (sin APIs de framework nuevas; solo JSX condicional en un componente existente).
- CP8: [x] 15 archivos, todos justificados por §s9.7 y el brief (UI «no se vende», config.toml, comentario del workflow).
- CP9: [x] CHANGELOG (Unreleased) con aviso de migración; sin variables nuevas; informe coincide con el diff.
- CP10: [x] 3 commits en español con prefijo y `Co-Authored-By`; sin push; `main` = 005f85a y `feat/superadmin` = bdc6783 intactos.
- CP11: [x] no toca el webhook de WhatsApp ni la ruta de entrada.

## Hallazgos (archivo:línea)
Ninguno bloqueante.
1. `docs/security.md` (sección «Operators and the unlimited plan», párrafo «The local seed») y `supabase/config.toml:26-33` — dicen «Never run it against a remote project» pero no nombran los dos comandos que lo harían: `supabase db push --include-seed` y `supabase db reset --linked` (que siembra por defecto). En producción el seed crearía el operador con una contraseña pública y `platform_admins`. Recomendado: nombrarlos explícitamente como prohibidos.
2. `progress/checks_unlimited-plan-and-seed.sql:1-14` — la cabecera no dice que hay que copiar la 074 a `/work/` dentro del contenedor (`docker cp …/074_plan_ilimitado.sql <c>:/work/`); sin eso el bloque 7 falla con `No such file or directory` (me pasó). Solo afecta al harness.
3. `supabase/seed.sql:117,139,163,181,207` — busca por `lower(u.email)` y no por `lower(btrim(u.email))` como la 074. Irrelevante en local (los usuarios los crea el propio seed), anotado por coherencia.
4. `progress/checks_unlimited-plan-and-seed.sql:264-278` — el caso «sin confirmar» solo cubre al operador; el del propietario lo comprobé yo aparte (no asigna). El test estático exige las dos guardas (`toHaveLength(2)`).

## Cambios requeridos
Ninguno. Recomendados (no bloquean): hallazgos 1 y 2.
