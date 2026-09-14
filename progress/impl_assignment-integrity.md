# Implementación — assignment-integrity (f0.1)

**Estado:** listo para revisión  
**Rama:** `saas/fase-0-cimientos`  
**Worktree:** `.claude/worktrees/agent-a85d874ab350adc04`  
**Commit de la feature:** `96474fc feat: dar integridad referencial a conversations.assigned_agent_id`

## Corrección solicitada por revisión

- Se añadió `progress/checks_assignment-integrity.sql`, una prueba SQL de
  comportamiento reproducible para el `ON DELETE SET NULL` de la migración
  040. Inserta una conversación propiedad de un usuario y asignada a otro,
  elimina al agente y exige en una misma aserción que la conversación siga
  existiendo y que `assigned_agent_id` sea `NULL`.
- La prueba se envuelve en `BEGIN`/`ROLLBACK`, por lo que no deja filas de
  prueba y se puede ejecutar repetidamente contra el Postgres de replay.
- No se modificó el código ni la migración ya cubierta por `96474fc`: los dos
  hallazgos eran artefactos obligatorios del harness, que viven en el checkout
  principal y no se incluyen en commits del worktree. No se creó un commit
  vacío.

## Criterios de aceptación y pruebas

| Criterio | Evidencia |
| --- | --- |
| Borrar un usuario deja la conversación y anula `assigned_agent_id` | `progress/checks_assignment-integrity.sql`, bloque `DO`: crea dueño, agente, contacto y conversación; elimina al agente; exige que la fila del dueño persista con `assigned_agent_id IS NULL`. Ejecutado con salida 0 contra el replay local. |
| `migrations.yml` pasa contra una base limpia | `KEEP=1 /Users/brian/Documents/Dev/projects/wacrm/scripts/replay-migrations.sh "$(pwd)"` aplicó `001`–`041` y devolvió `verify-schema.sql: OK`. |
| `verify-schema.sql` comprueba restricción e índice | `supabase/ci/verify-schema.sql:45-59` comprueba la FK `conversations_assigned_agent_id_fkey`, `confdeltype = 'n'` e `idx_conversations_account_assignee`; pasó en el replay. |

## Verificaciones ejecutadas

1. Se inició el replay local con `KEEP=1` en el worktree; salida 0 para todas
   las migraciones `001`–`041` y `verify-schema.sql: OK`.
2. Contra el contenedor conservado `wacrm-migrations-81784` se ejecutó:

   ```sh
   docker exec -i wacrm-migrations-81784 psql -U postgres -h localhost -d postgres \
     -v ON_ERROR_STOP=1 -q \
     < /Users/brian/Documents/Dev/projects/wacrm/progress/checks_assignment-integrity.sql
   ```

   Salida 0, sin salida de error. El contenedor se eliminó al terminar.
3. `npm run lint` — verde; 37 warnings preexistentes.
4. `npm run typecheck` — verde.
5. `TZ=UTC npm test` — verde: 83 archivos y 873 pruebas.
6. Build con variables dummy documentadas — verde:

   ```sh
   NEXT_PUBLIC_SUPABASE_URL=https://ci.example.supabase.co \
   NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-dummy-anon-key \
   ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000 \
   META_APP_SECRET=ci-dummy-meta-secret npm run build
   ```

## Alcance, decisiones y deuda

- No hay consultas `supabaseAdmin()`, UI, i18n, dependencias ni servicios
  externos en f0.1; no hay guion manual pendiente. Tampoco hay variables de
  entorno nuevas.
- Para poder borrar un `auth.users` creado por el trigger de alta, la prueba
  elimina primero su cuenta personal de bootstrap: `accounts.owner_user_id`
  usa `ON DELETE RESTRICT`. Esa cuenta pertenece solo al agente de prueba y
  no a la conversación, cuyo dueño y cuenta son distintos. Esto modela la
  eliminación del operador sin confundirla con el propietario del chat.
- `CHANGELOG.md` Unreleased ya incluye la entrada visible de f0.1 en
  `### Fixed` (líneas 42–46); no se duplicó.
- Deuda fuera de alcance: los 37 warnings de ESLint y las advertencias de
  Turbopack sobre raíz/middleware aparecidas en build son preexistentes.
