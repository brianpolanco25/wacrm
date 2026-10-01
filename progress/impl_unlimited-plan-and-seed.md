# s9.7 `unlimited-plan-and-seed` — informe del implementer

## Plan

1. Migración `074_plan_ilimitado.sql`: plan `ilimitado` (upsert sin `provider_plan_id_*`), asignación manual idempotente
   a la cuenta de `brianmpolanco@gmail.com` con bitácora `plan_override` solo si cambia algo, concesión de
   `platform_admins` a `brianpolancodisenos@gmail.com`. Bloque `-- 074` en `verify-schema.sql`.
2. UI de s9.3: un ciclo sin publicar y con precio 0 dice «no se vende» en vez de ofrecer «Sincronizar» (400 seguro).
3. `supabase/seed.sql`: tres usuarios de laboratorio (operador, owner Cabbity en ilimitado, cliente demo incomplete),
   idempotente. Probarlo dos veces contra el Postgres del harness.
4. Tests: seed (sin secretos, idempotente, tres correos), 074 (features = inventario, límites nulos, no pública),
   catálogo público sin `ilimitado`, UI «no se vende».
5. Docs (`docs/security.md`, `docs/docker.md`), CHANGELOG.

## Rama y commits

Rama `platform/unlimited-seed` (worktree `.claude/worktrees/unlimited-seed`), base `feat/superadmin` @ bdc6783. Sin push.

- `8bafd6d` feat: plan ilimitado para la empresa propietaria y su operador (migración 074)
- `e153637` feat: semilla local con el operador, Cabbity en ilimitado y un cliente demo
- `7bf11d0` docs: operadores y plan ilimitado en producción, y la semilla local

## Compuerta (sin build, por regla del humano)

- `npm run lint`: 0 errores (35 warnings, todas previas; ninguna en archivos tocados).
- `npm run typecheck`: 0.
- `TZ=UTC npm test`: 249 archivos, 3505 tests, todos en verde.
- `scripts/replay-migrations.sh`: salida 0 (001…074 + verify-schema OK).
- Seed aplicado dos veces + `progress/checks_unlimited-plan-and-seed.sql`: salida 0, todos los NOTICE OK; `verify-schema.sql` re-ejecutado tras el seed: OK.
- `npm run build` NO ejecutado (regla del humano: descarga la fuente Inter de Google).

## Criterio ↔ test

| Criterio | Test |
|---|---|
| `ilimitado` con las 8 claves de límites a null | `src/lib/billing/unlimited-plan.test.ts` «has every limit key of the inventory, all null» |
| `ilimitado` con todas las features del inventario (plan-catalog.ts) | idem «has every feature of the inventory, in the inventory order» |
| Oculto, precio 0, sort 99, ON CONFLICT DO UPDATE, sin tocar `provider_plan_id_*` | idem «is hidden, free, last, and never touches the PayPal ids» |
| Asignación manual/active, bitácora plan_override con el motivo, operador por correo ON CONFLICT DO NOTHING, sin `manual_hold_*`, solo confirmados | idem «assigns it by hand, audited, and grants the operator by email» |
| `/api/billing/plans` no lista `ilimitado` | `src/app/api/billing/plans/route.test.ts` «never lists the unlimited plan of the 074 (hidden, free, no PayPal id)» |
| UI s9.3 lo muestra como «no se vende» (sin botón de sync) | `src/components/platform/platform-plans.test.tsx` «says «no se vende» for a never-published cycle without a price (ilimitado, 074)»; recuentos ajustados en «offers «Nuevo plan» and a sync button per sellable plan and cycle» y «offers «Despublicar» instead of sync…» |
| Paridad i18n de la clave nueva | test existente «Platform.plans catalogue (CP6)» en el mismo archivo (claves usadas por el componente presentes en es/en/ko) |
| Seed: cabecera solo local | `src/lib/platform/seed.test.ts` «says it is local-only in its header» |
| Seed: sin URLs remotas ni claves (`service_role`, `eyJ`…) | idem «has no remote project URL and no key» |
| Seed: los tres correos, contraseña solo en `crypt(…gen_salt('bf'))` | idem «creates the three accounts of the spec, with the lab password hashed» |
| Seed idempotente por construcción (todo INSERT con ON CONFLICT/NOT EXISTS, solo INSERT/UPDATE) | idem «is idempotent by construction» |
| Cabbity en ilimitado/manual/active, demo en inicio/incomplete | idem «gives Cabbity the unlimited plan by hand and leaves the demo unpaid» |
| CI usa `--no-seed`; config.toml declara el seed | idem «is only run by `supabase db reset --local`, never by CI or the replay» |
| Aserciones de esquema | `supabase/ci/verify-schema.sql`, bloque `-- 074` al final (existe, 4 planes en total, solo `ilimitado` oculto, oculto/0/99/sin PayPal, 8 límites null, features completas). Se relajó la aserción de la 041 «exactamente 3 planes» a «los 3 ids de la 041 existen»; el recuento total (4) pasa al bloque 074. |

## Verificaciones contra base real (Postgres del harness)

Archivos: `progress/checks_unlimited-plan-and-seed.sql` (aserciones) y
`progress/checks_unlimited-plan-and-seed_gotrue-shim.sql` (preparación). Orden y comandos en la cabecera del primero.

**Shim de GoTrue**: la imagen `supabase/postgres:17.4.1.075` trae el esquema `auth` base, sin migraciones de GoTrue: no hay
`email_confirmed_at`, no hay `auth.identities` y `confirmed_at` es una columna normal. En `supabase db reset --local` ese
esquema lo completa GoTrue antes de ejecutar el seed. Para probar el seed en el harness, el shim añade a mano esas columnas y la
tabla con la forma de GoTrue v2 (`confirmed_at` generada, `identities.email` generada, UNIQUE(provider_id, provider), permisos
como `auth.users`). No forma parte del repo.

Resultados (base limpia, seed ×2):
1. Tres usuarios, tres identidades `email` (provider_id = id), confirmados, forma auth correcta, bcrypt de `bcmp1994`; perfiles `owner` creados por `handle_new_user`; UNA fila plan_override del seed.
2. `is_platform_admin(operador)` true; los otros dos false; un único operador.
3. Cabbity: ilimitado/manual/active, sin id de pasarela, ciclo ni fechas, sin retención; límites 8×null; features = inventario; perfil completo y `onboarding_completed_at` sellado.
4. Empresa Demo: inicio/incomplete, sin perfil ni sello.
5. `platform_metrics()` como service_role: comped 1, MRR 0, paying 0, 2 incomplete + 1 active.
6. Catálogo público = inicio, pro, negocio.
7. Escenario de producción (usuarios ya existen, la 074 corre después, dos veces): asigna, UNA fila `migration_074` con motivo/actor/from/to correctos, concede el operador una vez.
8. No pisa una suscripción viva de PayPal (NOTICE y salta); no toca `manual_hold_*`.
9. Usuario sin confirmar con el correo del operador: no recibe el rol.
10. Base sin esos usuarios: 0 filas, sin error.

## Seed: quién lo ejecuta (verificado leyendo los archivos)

- `.github/workflows/migrations.yml`: `supabase db reset --local --no-seed` → CI no lo aplica. Se corrigió el comentario que decía «there is no seed script».
- `scripts/replay-migrations.sh`: solo itera `supabase/migrations/*.sql` y `supabase/ci/verify-schema.sql` → no lo aplica.
- `supabase/config.toml` no tenía `[db.seed]` (el CLI lo activa por defecto con `./seed.sql`); se añadió explícito (`enabled = true`, `sql_paths = ["./seed.sql"]`).
- `ci.yml` no toca Supabase.

## Verificaciones manuales pendientes (guion)

1. `supabase db reset --local` con el CLI real (no disponible en el harness): comprobar que el seed aplica sobre el esquema de GoTrue real y que se puede iniciar sesión en `/login` con los tres correos y `bcmp1994`: el operador aterriza en `/platform`, brianmpolanco entra directo a `/dashboard` (Cabbity, sin puerta), cliente.demo va a `/onboarding` paso 1.
2. En `/platform/plans`, `Ilimitado` sale como oculto, 0.00 USD, y ambos ciclos con «Sin precio: este ciclo no se vende…», sin botón de sincronizar.
3. Producción (lo hace el humano): crear `brianpolancodisenos@gmail.com` en Supabase Auth con contraseña propia y «Auto Confirm User», luego `db push`; comprobar con `SELECT … FROM platform_admins` y la ficha de Cabbity en el panel (plan Ilimitado, bitácora plan_override). Si Cabbity tuviese una suscripción viva de PayPal, la 074 emite NOTICE y no la toca: cancelarla y re-ejecutar el bloque o asignar desde el panel.

## Decisiones donde el spec era ambiguo

- **No se sella `onboarding_completed_at` en la 074** (se aparta de la recomendación del líder): el CHECK `accounts_onboarding_needs_profile` (073) impide sellar sin país/teléfono/sector/tamaño, y la migración no los conoce (inventar un teléfono de la empresa real no es aceptable). Además la puerta (`loadOnboardingState`) decide por el perfil, no por el sello. Consecuencia: el owner de Cabbity ve una vez el paso 1 (sin pago) y su equipo entra sin puerta. En el seed sí se rellena el perfil y se sella.
- **Solo usuarios confirmados** (`auth.users.confirmed_at IS NOT NULL`) en las dos búsquedas de la 074: endurecimiento no pedido. Con registro abierto, alguien podría crear una fila con ese correo antes del push; sin confirmar no entra, pero el rol quedaría esperando. Se usa `confirmed_at` (generada en GoTrue, presente también en el esquema base del harness) en vez de `email_confirmed_at`, que el harness no tiene.
- **No pisar una suscripción viva de PayPal**: el spec pedía `ON CONFLICT DO UPDATE` sin condición; se aplica la misma regla que `isLivePayPalSubscription` del panel (s9.4) para no dejar a PayPal cobrando algo que la app ya no ve. NOTICE y se salta la cuenta.
- **Bitácora solo si cambia algo**: la segunda pasada de la 074 no escribe fila. `details` lleva `from_plan`, `to_plan`, `from_provider` y `source` (`migration_074` o `seed`).
- Si el owner tuviera varias cuentas, la 074 recorre todas; en la práctica hay un índice único `idx_accounts_one_per_owner`.
- **UI «no se vende»**: un ciclo sin publicar y sin precio (>0) enseña una pista y no el botón de sincronizar; clave nueva `Platform.plans.hint.notForSale` en es/en/ko. Un ciclo con precio y sin publicar conserva el botón.
- Empresa Demo se queda **sin perfil de empresa** para probar la puerta entera (pasos 1 y 2).
- Ids fijos `5eed0000-…-00000000000{1,2,3}` en el seed para los usuarios nuevos; todo lo demás se busca por correo, así que si ya existía un usuario con ese correo se reutiliza.
- `pgcrypto` está en el esquema `extensions` de la imagen: se usa `extensions.crypt` / `extensions.gen_salt('bf')`.
- La descripción del plan evita `;` para que los tests que leen el SQL por sentencias no se confundan.

## Variables de entorno nuevas

Ninguna.

## Docs

- `docs/security.md`: nueva sección «Operators and the unlimited plan» (Operadores y plan ilimitado): qué hace la 074, procedimiento de producción, INSERT a mano, onboarding, cómo dar el plan a otra cuenta desde `/platform/<id>`, y que el seed es solo local con contraseñas públicas. Se reescribió el párrafo «There is no seed…» de «Granting the first operator», que ya no era cierto.
- `CHANGELOG.md` (Unreleased, al final del bloque): «Unlimited plan for the service owner, and a local seed», con aviso de migración.
- README y `docs/docker.md` no documentan `supabase db reset`: no se tocaron.
- `.env.local.example`: no se tocó.

## Deuda fuera de alcance (sin arreglar)

- Este replay no tiene el esquema de GoTrue, así que ninguna compuerta puede validar el seed. Si se quiere cubrir, `replay-migrations.sh` necesitaría un paso opcional con el shim, o un job de CI con el CLI sin `--no-seed`.
- El comentario de cabecera de `platform_admins` (055) todavía dice «Sin semilla»; es una migración ya aplicada y no se edita.
