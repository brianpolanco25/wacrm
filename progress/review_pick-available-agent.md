# Review — f1.1 pick-available-agent (re-revisión tras corrección)

**Veredicto:** APPROVED

Revisado en `/Users/brian/Documents/Dev/projects/wacrm/.claude/worktrees/fase-1`,
HEAD `a492504`, limpio. Commits de la feature: `20fbd9c` (original) y `fac4d40`
(corrección). Rango leído: `20fbd9c^..a492504` (contiene además `1292984` y
`a492504`, que son f1.2, ya aprobada).

## Compuerta

Ejecutada por el reviewer, no leída del informe:

```
npm run lint && npm run typecheck && TZ=UTC npm test && <vars dummy> npm run build
```

- lint: **verde** (0 errores, 37 warnings preexistentes)
- typecheck: **verde**
- test: **verde** — 84 archivos, 913 pruebas
- build: **verde** (exit 0)
- `KEEP=1 scripts/replay-migrations.sh <worktree>`: **verde** — 001–043 aplicadas
  y `verify-schema.sql` OK.
- `progress/checks_pick-available-agent.sql` contra ese Postgres: **verde**
  (`BEGIN / DO / DO / ROLLBACK`, exit 0), ejecutado por el reviewer.

## Hallazgos anteriores — estado

1. **Fuga cross-tenant por la RPC `SECURITY DEFINER`** → **CERRADO**.
   `042_pick_available_agent.sql:79-81` revoca `PUBLIC`, `anon` y `authenticated`
   y solo concede `service_role`. Comprobado en vivo contra el contenedor:
   `has_function_privilege` = `authenticated:f`, `anon:f`, `service_role:t`,
   `PUBLIC:false`, `prosecdef=true`, `search_path=public`. Los dos llamadores
   usan `supabaseAdmin()` (`src/lib/ai/auto-reply.ts:275`,
   `src/lib/automations/engine.ts:525`). El comentario de cabecera ya describe
   lo que el SQL hace.
2. **Consultas service-role de `conversations` sin `account_id`** → **CERRADO**.
   `src/lib/ai/auto-reply.ts:76` (lectura) y `:167-170` (escritura de cesión)
   filtran `.eq('id', …).eq('account_id', accountId)`. Test que lo ata:
   `src/lib/ai/auto-reply.test.ts:344` › "scopes the service-role conversation
   read and handoff write to its account", que compara la lista completa de
   filtros registrados por el mock (`:352-362`), no solo su presencia.
3. **Cobertura de base real inexistente** → **CERRADO**.
   `progress/checks_pick-available-agent.sql` existe, lo corrí yo y sale 0.
   Además ejecuté una sonda independiente (ver Trazabilidad).
4. **CP9** → **CERRADO**. `progress/impl_pick-available-agent.md` existe y
   coincide con el diff; `CHANGELOG.md` (Unreleased) documenta 042 y 043 y avisa
   de la migración requerida.
5. **Alcance excedido de `20fbd9c`** → **ACEPTADO por decisión del líder**.
   Verificado que el reformat de `engine.ts` no cambia comportamiento: formateé
   con prettier las dos versiones del archivo (`20fbd9c^` y `20fbd9c`) y el
   único diff funcional es el bloque `round_robin` (601 líneas de diff bruto →
   1 hunk de conducta). El segundo hunk residual
   (`contact_custom_values.upsert`) es puro encadenado de prettier.

CP6 (i18n): aplicada la regla vigente — `messages/en.json` y `messages/ko.json`,
sin `es.json`. Comprobada la paridad de claves de todo el catálogo: 0 claves
solo-en, 0 solo-ko; las ocho nuevas (`Settings.aiConfig.handoffMode*`,
`handoffPickAgent`, `handoffFixedNeedsAgent`, `handoffMessage*`) están en ambos
y son exactamente las que usa `src/components/settings/ai-config.tsx`.

Guarda «`fixed` necesita destino» (arreglada en `a492504`, f1.2) → **CERRADA**:
`src/app/api/ai/config/route.ts:207-219` valida el **estado fusionado** (cuerpo
+ fila almacenada), con tests en `src/app/api/ai/config/route.test.ts:262`
("requires a member agent when handoff_mode is fixed"), `:313-324` (cuerpo con
solo `handoff_agent_id: null` sobre una fila `fixed` almacenada) y `:328`
(`handoff_mode: 'fixed'` a secas sobre una fila que ya tiene destino).

Error conocido del spec (`account_role >= 'agent'`): la migración usa
`IN ('owner','admin','agent')` (`042:63`) y lo documenta en cabecera
(`042:12-18`). Verificado en base real que un `owner` conectado **sí** es
elegible y que `p_include_admins = false` lo excluye.

## Trazabilidad criterio ↔ prueba

- **C1 «tres conectados con cargas 5/2/9 → el de carga 2»**: [x]
  `progress/checks_pick-available-agent.sql:52-76` (ejecutado, verde) +
  sonda propia con los **tres** operadores con presencia `online` y cargas
  5/2/9 → devuelve el de carga 2. Implementación: `042:66-73`.
  Matiz: en el archivo de checks el agente de carga 9 (`owner_a`) no tiene fila
  en `member_presence`, así que el escenario real que prueba es 5 vs 2 (ver
  Hallazgos 1).
- **C2 «latido de diez minutos no elegible»**: [x]
  `checks_…sql:78-84` + sonda propia aislando ese caso (único candidato con
  `last_seen_at = now() - 10 min` → `NULL`). Implementación: `042:67-68`.
- **C3 «sin nadie conectado → `NULL`, sin lanzar»**: [x] base real
  (`checks_…sql:80-84` y sonda) + unitarios que prueban la conducta del
  llamador: `src/lib/ai/auto-reply.test.ts:314` › "auto mode with nobody online
  (NULL) behaves like queue and does not throw" (afirma que la RPC se llamó y
  que el update **no** lleva `assigned_agent_id`) y
  `src/lib/automations/engine.test.ts:179` › "leaves the conversation unassigned
  (no write, no failure) when nobody is online" (sin update y log
  `status: 'success'`).
- **C4 «un `viewer` nunca es elegible»**: [x] sonda propia con un `viewer`
  `online` y latido fresco como único candidato → `NULL`. En el archivo de
  checks va agrupado con el stale en una sola aserción (`:78-84`).
  Implementación: `042:63`.
- **C5 «la cesión de la IA no pisa a un humano»**: [x]
  `src/lib/ai/auto-reply.test.ts:328` › "never stomps an existing human
  assignment (auto mode, thread already owned)": con
  `assigned_agent_id: 'human-owner'` no hay llamada al modelo, ni RPC, ni
  escritura (`updatePayload` nulo). Reforzado en el código por la guarda
  `if (!conv.assigned_agent_id)` de `auto-reply.ts:156`.
- **Fuga entre cuentas (CP3)**: [x] `checks_…sql:86-105` (la cuenta A no
  devuelve al agente online de B; `authenticated` recibe
  `insufficient_privilege`) + `auto-reply.test.ts:344` + consulta de privilegios
  en vivo.
- **Cableado de automatizaciones**: [x] `engine.test.ts:149` › "assigns to
  whoever pick_available_agent returns, scoped to the account + contact":
  afirma los argumentos de la RPC, que **no** se toca `profiles` (el
  `.limit(1)` desapareció) y los filtros `account_id` + `contact_id` del update.

## Checkpoints

- **CP1 Compuerta:** [x] verde, ejecutada por mí.
- **CP2 Migraciones:** [x] 042 idempotente (`CREATE OR REPLACE`, `REVOKE`/`GRANT`
  reejecutables), 043 con bloque `DO` + `ADD COLUMN IF NOT EXISTS` + CHECK
  soltada y recreada; sin `CASCADE`; aserciones nuevas en
  `supabase/ci/verify-schema.sql:89-108` (existencia + los dos privilegios);
  replay 0.
- **CP3 Aislamiento:** [x] RPC solo `service_role`; ambas consultas service-role
  de `auto-reply.ts` y el update de `engine.ts` filtran por `account_id`, con
  test de fuga.
- **CP4 Tests:** [x] los cinco criterios con prueba leída; lo que exige base real
  tiene SQL en `progress/checks_pick-available-agent.sql`, ejecutado.
- **CP5 Dependencias:** [x] `package.json` y `package-lock.json` sin cambios en
  el rango.
- **CP6 i18n:** [x] `en.json` y `ko.json` con las mismas claves (verificado
  programáticamente, paridad total del catálogo).
- **CP7 Next 16:** [x] n/a — no se introduce API de framework; `route.ts` sigue
  el handler existente.
- **CP8 Alcance:** [x] con la salvedad ya decidida por el líder (material de §2
  y reformat en `20fbd9c`); el reformat se verificó neutro.
- **CP9 Documentación:** [x] informe + CHANGELOG; sin variables de entorno
  nuevas, así que `docs/docker.md` no aplica.
- **CP10 Git:** [x] commits en `saas/fase-1-bandeja`, en español con prefijo
  (`feat:`/`fix:`) y `Co-Authored-By`; `git branch --contains` de `20fbd9c` y
  `fac4d40` devuelve solo esa rama; `git ls-remote origin saas/fase-1-bandeja`
  vacío (sin push).
- **CP11 Entrante no bloqueado:** [x] nada del diff afecta la escritura del
  webhook.

## Hallazgos (no bloqueantes)

1. `progress/checks_pick-available-agent.sql:44-71` — el escenario «5/2/9» no
   pone presencia a `owner_a`, el agente de carga 9, así que la aserción real es
   «5 vs 2», no «5/2/9 con tres conectados». La dirección del `ORDER BY` sí
   queda cubierta (con orden invertido ganaría el de 5 y la aserción fallaría).
   Verifiqué el escenario completo con una sonda propia y pasa. Sugerencia para
   una futura iteración: añadir `(owner_a, account_a, 'online', …)` a la
   inserción de `member_presence`.
2. `progress/checks_pick-available-agent.sql:78-84` — «latido de 10 min» y
   «viewer» se comprueban con una sola aserción conjunta (`NULL` con ambos
   presentes). Separarlas hace que un fallo diga cuál de las dos condiciones se
   rompió. Ambas verificadas por separado en mi sonda.
3. `supabase/migrations/042_pick_available_agent.sql:49` — el umbral de
   obsolescencia (5 min, tal y como lo fija el spec) contradice el de la
   interfaz: `src/lib/presence.ts:23` marca a alguien offline a los
   `OFFLINE_AFTER_MS = 75_000`. Entre 75 s y 5 min la plantilla ve a esa persona
   «desconectada» y la RPC se la sigue asignando — y como ordena por carga
   ascendente, quien acaba de irse es justo el candidato más probable. Viene del
   spec, no del implementador: es material para el líder (unificar el valor o
   pasar `p_stale_after` desde `OFFLINE_AFTER_MS`).
4. `src/lib/automations/engine.ts:525-527` — un error de la RPC lanza y aborta
   **toda** la ejecución de la automatización (la marca `failed` y salta los
   pasos siguientes), mientras que el hermano
   `resolveHandoffTarget` (`src/lib/ai/auto-reply.ts:275-283`) degrada a cola.
   El código anterior tampoco abortaba. Asimetría deliberada según el informe,
   pero conviene documentarla o igualarla.
5. `supabase/migrations/042_pick_available_agent.sql:76` — la función
   `SECURITY DEFINER` no fija dueño, a diferencia de la convención del repo
   (`017:166`, `018:110`, `019:84`, `025:73`, `034:76`, `036`). En Supabase las
   migraciones corren como `postgres` y el replay confirma `owner=postgres`,
   así que hoy no rompe; en un despliegue con rol de migración propio la RPC
   correría con RLS y devolvería `NULL` siempre, en silencio.
   `ALTER FUNCTION public.pick_available_agent(uuid, interval, boolean) OWNER TO
   postgres;` lo cierra.
6. `supabase/migrations/042_pick_available_agent.sql:66-73` — el recuento de
   carga es lectura-y-luego-escritura: N cesiones concurrentes de la misma
   cuenta ven los mismos contadores y eligen al mismo agente. Con ráfagas
   (respuestas a un broadcast) el reparto puede quedar peor que aleatorio.
   Fuera de los criterios de §1; deuda anotada.

## Observaciones de integración (para el líder, no de la feature)

- El informe `progress/impl_pick-available-agent.md:3` sigue diciendo
  «Estado: BLOCKED» por el i18n, y sus cifras de la compuerta (83 archivos /
  895 pruebas) son anteriores a `a492504` (hoy 84 / 913). Conviene actualizarlo
  al cerrar la feature.
- `saas/fase-1-bandeja` salió de `8854c65`, anterior a la corrección `324f087`
  de fase 0: le faltan `supabase/migrations/047_ai_platform_key.sql` y la 041
  corregida. Lo dice ya la nota de f0.2 en `feature_list.json`; hay que fusionar
  fase 0 antes de integrar.
