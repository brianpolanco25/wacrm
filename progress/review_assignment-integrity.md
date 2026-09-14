# Revisión — f0.1 assignment-integrity

**Veredicto: APPROVED**

Revisión de corrección realizada el 2026-09-10 en la rama
`saas/fase-0-cimientos`, worktree
`/Users/brian/Documents/Dev/projects/wacrm/.claude/worktrees/agent-a85d874ab350adc04`.
Se revisaron el informe anterior y `progress/impl_assignment-integrity.md`.
Los dos bloqueantes anteriores están resueltos: existe la prueba SQL de
comportamiento y el informe individual de implementación.

## Contraste del diff y alcance

- `git log --oneline feat/saas-multiempresa..HEAD` contiene `96474fc` para
  f0.1 (además de los commits posteriores de f0.2–f0.4); el `git diff --stat`
  contra la base refleja el estado integrado de la fase.
- El diff propio de la feature, `git diff 96474fc^ 96474fc`, modifica solo
  `supabase/migrations/040_conversation_assignment_integrity.sql` y
  `supabase/ci/verify-schema.sql` (68 líneas añadidas). Coincide con el
  informe: no introduce dependencias, UI, i18n, rutas Next, servicios externos
  ni consultas `supabaseAdmin()`.
- La migración limpia referencias huérfanas (`040_conversation_assignment_integrity.sql:37-40`),
  crea la FK a `auth.users(id)` con `ON DELETE SET NULL` (`:43-48`) y el índice
  compuesto de la consulta caliente (`:50-52`). El DDL no contiene `CASCADE`.
  Es idempotente mediante `DROP CONSTRAINT IF EXISTS` y
  `CREATE INDEX IF NOT EXISTS`; el reviewer reaplicó 040 sobre la base de
  replay con éxito (el índice emitió únicamente el aviso esperado de que ya
  existía).
- `verify-schema.sql:45-58` comprueba la FK, su acción `confdeltype = 'n'` y
  el índice. `CHANGELOG.md:42-46` documenta la migración en Unreleased.

## Compuerta ejecutada por reviewer

Desde el worktree, salida 0:

```sh
npm run lint && npm run typecheck && TZ=UTC npm test && \
NEXT_PUBLIC_SUPABASE_URL=https://ci.example.supabase.co \
NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-dummy-anon-key \
ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000 \
META_APP_SECRET=ci-dummy-meta-secret npm run build
```

- lint: 0 errores; 37 advertencias no bloqueantes existentes fuera del diff de
  f0.1.
- typecheck: correcto.
- tests: 83 archivos y 873 pruebas correctas con `TZ=UTC`.
- build: correcto; solo advertencias no bloqueantes de raíz Turbopack y la
  convención deprecada `middleware`.

Para SQL, el reviewer ejecutó además:

```sh
KEEP=1 /Users/brian/Documents/Dev/projects/wacrm/scripts/replay-migrations.sh "$(pwd)"
docker exec -i wacrm-migrations-96228 psql -U postgres -h localhost -d postgres \
  -v ON_ERROR_STOP=1 -q \
  < /Users/brian/Documents/Dev/projects/wacrm/progress/checks_assignment-integrity.sql
docker exec -i wacrm-migrations-96228 psql -U postgres -h localhost -d postgres \
  -v ON_ERROR_STOP=1 -q < supabase/migrations/040_conversation_assignment_integrity.sql
```

El replay limpio aplicó `001`–`041`, incluida 040, y terminó con
`verify-schema.sql: OK`. La comprobación SQL de comportamiento terminó 0; su
`BEGIN`/`ROLLBACK` deja la base limpia. La segunda aplicación de 040 terminó 0.
El contenedor de replay se eliminó al finalizar.

## Trazabilidad de aceptación

| Criterio | Cobertura leída y ejecutada | Resultado |
|---|---|---|
| Borrar un usuario mantiene sus conversaciones y anula `assigned_agent_id` | `progress/checks_assignment-integrity.sql:5-64`, prueba de base real: crea dueño, agente, contacto y conversación asignada a un agente distinto (`:16-31`), borra el agente (`:43-47`) y exige que la conversación del dueño persista con asignación nula (`:49-60`). Ejecutada por reviewer contra el Postgres limpio de replay, salida 0. | Cubierto |
| `migrations.yml` pasa contra base limpia | `scripts/replay-migrations.sh "$(pwd)"` ejecutado por reviewer; reproduce la migración local y verificó 001–041 con salida 0. | Cubierto |
| `verify-schema.sql` comprueba restricción e índice | Leído `supabase/ci/verify-schema.sql:45-58`; valida la FK, `ON DELETE SET NULL` y el índice. Pasó dentro del replay del reviewer. | Cubierto |

No hay criterio dependiente de Meta, PayPal u otro servicio externo; por ello no
requiere guion manual. Para el criterio de base real, la prueba SQL sustituye
correctamente un test Vitest de unidad.

## Checkpoints

- **CP1 Compuerta:** Sí. Ejecutada por reviewer y verde, con evidencia arriba.
- **CP2 Migraciones:** Sí. Número 040 exigido por el spec, DDL idempotente,
  aserción de cada objeto nuevo en `verify-schema.sql`, replay limpio verde,
  comprobación comportamental verde y ningún `CASCADE` introducido.
- **CP3 Aislamiento:** No aplica al diff de f0.1: no añade ni modifica
  `supabaseAdmin()` ni una consulta de servicio.
- **CP4 Tests:** Sí. Todos los criterios tienen cobertura leída; el efecto de
  borrado se verificó con SQL reproducible contra base real en
  `progress/checks_assignment-integrity.sql` y fue ejecutado por reviewer.
- **CP5 Sin dependencias nuevas:** Sí. `package.json` y `package-lock.json` no
  forman parte del diff de `96474fc`.
- **CP6 i18n:** No aplica; no hay UI ni texto nuevo.
- **CP7 Next 16:** No aplica; la feature no usa APIs del framework.
- **CP8 Alcance:** Sí. La migración y su verificación de esquema son exactamente
  el alcance de la sección 1; los cambios integrados posteriores pertenecen a
  otras features y no se atribuyen a f0.1.
- **CP9 Documentación:** Sí. Existen y coinciden con el diff
  `progress/impl_assignment-integrity.md` y la prueba SQL individual; el
  CHANGELOG Unreleased contiene la entrada de la migración. No hay variables
  de entorno nuevas.
- **CP10 Git:** Sí para lo comprobable localmente. `96474fc` está en la rama de
  fase, usa el prefijo español `feat:` e incluye `Co-Authored-By`; el worktree
  está limpio, no tiene upstream configurado y ninguna referencia remota local
  contiene el commit.
- **CP11 Lo entrante nunca se bloquea:** No aplica: f0.1 no toca facturación,
  cuotas ni el webhook entrante.

## Hallazgos y evidencia final

Sin hallazgos bloqueantes ni cambios requeridos. No se realizaron cambios de
código, commits, push, PR ni merge durante esta revisión; únicamente se
actualizó este informe del harness.
