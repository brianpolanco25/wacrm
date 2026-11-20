# Review — p16.3 audit-db-privileges

**Veredicto:** APPROVED

Rama `fix/audit-db-privileges`, commit `e54e5f8`. Diff: `supabase/migrations/098_audit_privilege_hardening.sql`,
`supabase/ci/verify-schema.sql` (bloque 098), `CHANGELOG.md`. Coincide con el informe.

## Compuerta (ejecutada por el revisor)
- `npx eslint . --ignore-pattern '.claude/**'`: verde
- `npm run typecheck`: verde
- `TZ=UTC npm test`: verde — 417 archivos / 6375 tests (el flaky de `middleware.test.ts` no apareció)
- `npm run build`: no corrido (el diff no toca TS; el líder pidió lint/typecheck/test)
- `KEEP=1 scripts/replay-migrations.sh <worktree>`: verde, 001–098 ok, `verify-schema.sql: OK`, salida 0

## Comprobación contra el Postgres del harness
- **Idempotencia**: 098 aplicada dos veces más sobre la base ya migrada → sin error; `verify-schema.sql` vuelve a pasar.
- `progress/checks_audit-db-privileges.sql`: 16 PASS, 0 FAIL (reproducido).
- SQL extra del revisor (no en el repo; mismo patrón, transacción con ROLLBACK, roles simulados con `SET ROLE`):
  - signup con `SET ROLE supabase_auth_admin` (rol de GoTrue) → `handle_new_user` crea perfil owner: PASS
  - alta por invitación (`raw_user_meta_data.invite_token`, rama 090) como `supabase_auth_admin` → perfiles admin y agent en la cuenta: PASS
  - `set_member_role` llamado por el owner como `authenticated` (viewer↔agent): PASS
  - `avatar_url` editable; `UPDATE ... SET email = email` (sin cambio) no falla: PASS
  - owner sube, reemplaza (UPDATE) y borra en chat-media y flow-media; admin sube y reemplaza; agent reemplaza (upsert): PASS
  - trigger de difusión disparado por `authenticated`: INSERT (`sent`) + UPDATE (`failed`) → `sent_count=0, failed_count=1`: PASS
  - `anon` → 42501 en `_bcast_bump`; `service_role` sí puede cambiar `profiles.email`: PASS
- **Aserciones de verify-schema fallan sin 098** (revertido cada objeto dentro de una transacción y corrido el verify nuevo):
  C1 (función de 034) → `does not guard profiles.email`; C2 (política de 017) → `profiles_insert policy must not exist`;
  C3 (×5: GRANT a authenticated y, aparte, REVOKE a service_role) → error correspondiente en las 10 pruebas;
  C4 (política de 023 upload chat y de 020 delete flow) → `write policies must exclude viewers`.

## `current_user` en los caminos legítimos (C1/C2)
Todas las funciones que escriben en `profiles` son `SECURITY DEFINER` con dueño `postgres` (consultado en `pg_proc`):
`handle_new_user`, `redeem_invitation`, `remove_account_member`, `set_member_role`, `transfer_account_ownership` →
`current_user = postgres`; la guarda (solo `authenticated`) no les afecta. Las altas de plataforma
(`provisioning.ts:116` `inviteUserByEmail`, `:159` `createUser`) usan `supabaseAdmin()` → GoTrue inserta en `auth.users`
como `supabase_auth_admin` → trigger definer. Rutas de plataforma que tocan `profiles` usan `supabaseAdmin()`
(`service_role`). No existe sincronización de email Auth→`profiles` en las migraciones (ningún trigger sobre UPDATE de `auth.users`).

## Trazabilidad criterio ↔ comprobación
No hay vitest posible (política/grant/trigger de Postgres); el spec lo resuelve con SQL + `verify-schema.sql`.
- C1 «authenticated no cambia email; full_name sí»: [x] checks › `PASS C1` ×2; verify › cuerpo de la función. Leído: el UPDATE corre con `SET LOCAL ROLE authenticated`.
- C1 precondición «ningún cliente actualiza `profiles.email`»: [x] grep propio: única escritura de navegador `src/components/settings/profile-form.tsx:143-149` (`full_name`, `avatar_url`); el email va por `auth.updateUser` (`:161`).
- C2 «sin `profiles_insert`; `handle_new_user` sigue creando»: [x] checks › `PASS C2` ×2; verify › `pg_policies`. Grep: ningún `insert`/`upsert` sobre `profiles` en `src/` ni `mcp-server/`.
- C3 «5 funciones solo service_role; triggers siguen»: [x] checks › `PASS C3` (×5 authenticated, anon, service_role, trigger); verify › `has_function_privilege` anon/authenticated/service_role. Llamadores: `record_webhook_failure` solo `src/lib/webhooks/queue.ts:307` con el `db` que llega de `supabaseAdmin()`; las otras cuatro sin llamadores en `src/` (`_bcast_bump` solo desde el trigger definer).
- C4 «viewer no sube/reemplaza/borra; agent sí; SELECT intactas»: [x] checks › `PASS C4` ×3 + extra del revisor (owner/admin/agent). Las políticas SELECT de 044 no se tocan en 098. Enum `account_role_enum` = `{owner,admin,agent,viewer}` (sin `ADD VALUE` posteriores). Ningún flujo de viewer sube: `uploadAccountMedia` solo en `message-composer.tsx` (deshabilitado si `!canSend`; `/api/whatsapp/send` exige `requireRole('agent')`), `template-manager.tsx` (sync exige admin) y `node-config-form.tsx` (flujos exigen agent); avatares van al bucket `avatars`, no afectado.

## Checkpoints
- CP1 Compuerta: [x] (build no corrido; diff sin TS)
- CP2 Migraciones: [x] número 098, idempotente (verificado), aserción por objeto, replay 0, sin CASCADE
- CP3 Aislamiento: [x] n/a (sin consultas nuevas con `supabaseAdmin()`)
- CP4 Tests: [x] SQL en `progress/checks_audit-db-privileges.sql`, reproducido; control negativo reproducido vía verify-schema
- CP5 Sin dependencias nuevas: [x]
- CP6 i18n: [x] n/a
- CP7 Next 16: [x] n/a
- CP8 Alcance: [x]
- CP9 Documentación: [x] CHANGELOG Unreleased con «Migration required»; sin variables nuevas
- CP10 Git: [x] un commit en español con prefijo y `Co-Authored-By`; nada pusheado; árbol limpio
- CP11 Entrante nunca se bloquea: [x] el webhook usa `service_role`; triggers de difusión verificados con service_role

## Hallazgos (no bloqueantes)
1. `supabase/migrations/098_audit_privilege_hardening.sql:111,126,141` — la rama legada de flow-media
   (`auth.uid()::text = foldername[1]`) sigue dejando escribir a un viewer en una carpeta con su propio user_id.
   Lo permite el spec (solo pide tocar el `EXISTS`); el informe lo anota como deuda. Nadie más lee esa carpeta.
2. `progress/checks_audit-db-privileges.sql` (último bloque) — el caso «trigger disparado por authenticated» solo
   comprueba que no hay error, no los contadores; lo cubrí con SQL extra (cuentan bien).
3. `src/components/settings/profile-form.tsx:153-157` — el comentario afirma que Supabase propaga el cambio de email
   a `profiles.email`; no hay tal sincronización en las migraciones. Preexistente y fuera de alcance, pero tras 098
   `profiles.email` queda obsoleto tras un cambio de correo en Auth y el usuario ya no puede corregirlo (antes podía,
   que era el hueco). Deuda: trigger `AFTER UPDATE OF email ON auth.users` que sincronice, si las rutas de plataforma
   que resuelven por email lo necesitan.
4. Producción: la seguridad de los triggers depende de que en el remoto las funciones sean de `postgres`
   (lo son en el replay). Antes de aplicar, conviene un
   `select proname, pg_get_userbyid(proowner), prosecdef from pg_proc where proname in ('broadcast_recipient_aggregate_trigger','handle_new_user','set_member_role','redeem_invitation')`
   en el remoto (lectura) — si alguna fuese de otro rol sin privilegio sobre `_bcast_bump`, los contadores de difusión fallarían.

## Contraste con `code-review` (nivel high)
Hallazgos del skill y su clasificación:
- Rama legada de flow-media sin chequeo de rol → coincide con mi hallazgo 1. No bloquea: el caso del informe
  (viewer borra `account-<id>/…`) queda cerrado; lo que resta es escribir en `<uid propio>/…`, carpeta que no es de
  la cuenta. Sí sobra en el CHANGELOG decir «flow media» sin matiz; menor.
- **Emails ya suplantados antes de 098 quedan congelados** → válido y relevante para producción, fuera del spec.
  No bloquea el merge, pero **antes de aplicar 098 en remoto** conviene la consulta de solo lectura
  `select p.user_id, p.email, u.email from profiles p join auth.users u on u.id = p.user_id where p.email is distinct from u.email;`
  y revisar a mano cada fila (no backfill ciego: hay desajustes legítimos por cambios de correo en Auth, ver hallazgo 3)
  y `select * from platform_admins` contra esa lista.
- `findProfileByEmail` usa `profiles.email` (no único, sin sincronizar) como identidad → coincide con mi hallazgo 3;
  deuda fuera de alcance (`src/lib/platform/provisioning.ts:67-88`).
- La aserción C4 de `verify-schema.sql:2735-2744` es por subcadena `viewer` y no detecta la rama legada → cierto;
  aceptable para el alcance del spec.
- Lista negra `<> 'viewer'` en vez de `is_account_member(..., 'agent')` → es exactamente el arreglo que pide el spec;
  el enum hoy solo tiene 4 valores. Deuda si se añade un rol.
- Predicado duplicado ×6 → descartado: el spec pide el arreglo más pequeño, sin refactor.
- `verify-schema.sql:2706` no comprueba que el trigger siga enganchado a `profiles` → cierto (hueco ya de 034); deuda.
- Usuarios sin perfil por bootstrap fallido sin vía de recuperación → preexistente; la política eliminada era el
  hueco, no una vía de recuperación legítima (ningún cliente insertaba). Deuda.

## Cambios requeridos
Ninguno.
