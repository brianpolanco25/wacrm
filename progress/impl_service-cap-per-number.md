# p11.3 `service-cap-per-number` — informe del implementer

## Plan (de `specs/service-cap-per-number/tasks.md`)

1. T1 Migración 080 + bloque `-- 080` en `verify-schema.sql` + `checks_service-cap-per-number.sql`.
2. T2 `src/lib/billing/service-cap.ts` (constante, `asServiceCapAction`, `serviceMonthWindow`,
   `serviceCapState`, `loadServiceUsage`, `isAiPausedByServiceCap`) y sus tests.
3. T3 Compuerta en `src/lib/ai/auto-reply.ts` antes de `claimInboundAutoReply`.
4. T4 Ruta `GET/PATCH /api/whatsapp/service-cap` + caso A↔B en `tenant-isolation.test.ts`.
5. T5 Hook `use-service-cap.ts`, `service-cap-alert.tsx` montado en la bandeja, claves `Inbox.serviceCap.*`.
6. T6 `service-cap-settings.tsx` en Ajustes → WhatsApp, claves `Settings.whatsapp.serviceCap.*`.
7. T7 Test del webhook (CP11) y evidencia de CP8.
8. T8/T9 Informe, CHANGELOG, compuerta.

## Rama y commits

Rama `pmd/service-cap` (worktree `.claude/worktrees/pmd-service-cap`), base `be8ca0f`. Sin push.

| Commit | Qué |
|---|---|
| `4138911` | wip: migración 080, verify-schema, `service-cap.ts` + tests, compuerta en auto-reply |
| `19b8126` | feat: ruta, tests de auto-reply, fuga A↔B |
| `37677f1` | feat: aviso de bandeja, Ajustes → WhatsApp, i18n es/en |
| `e5b53fb` | test: webhook CP11, hook R8; CHANGELOG |

HEAD = `e5b53fb`.

## Estado de la compuerta

Por indicación del líder (máquina con carga ~20), corrí **tests por archivo** y `npm run typecheck`
una vez; la compuerta completa (lint, suite entera, build, réplica) la corre el líder.

| Comprobación | Resultado |
|---|---|
| `npx vitest run src/lib/billing/service-cap.test.ts` | 26/26 |
| `npx vitest run src/lib/ai/auto-reply.test.ts` | 63/63 (9 nuevos) |
| `npx vitest run src/app/api/whatsapp/service-cap/route.test.ts` | 14/14 |
| `npx vitest run src/lib/security/tenant-isolation.test.ts -t service-cap` | 2/2 (la auditoría de rol de servicio corre en cada caso) |
| `npx vitest run src/components/inbox/service-cap-alert.test.tsx` | 12/12 |
| `npx vitest run src/components/settings/service-cap-settings.test.tsx` | 14/14 |
| `npx vitest run src/hooks/use-service-cap.test.ts` | 3/3 |
| `npx vitest run src/app/api/whatsapp/webhook/route.test.ts` | 57/57 (1 nuevo) |
| `npm run typecheck` | exit 0 (antes de añadir `use-service-cap.test.ts`, que es trivial en tipos) |
| `npm run lint`, `TZ=UTC npm test` completo, `npm run build` | **no corridos por mí** (los corre el líder) |
| `scripts/replay-migrations.sh` + `checks_service-cap-per-number.sql` | ver «Verificaciones contra base real» |

## Criterio ↔ test

| Req | Archivo | `it` |
|---|---|---|
| R1 | `supabase/ci/verify-schema.sql` (`-- 080`), `progress/checks_service-cap-per-number.sql` | columna NOT NULL default `'warn'`, CHECK; checks: default warn, `foo` → check_violation, NULL → not_null_violation |
| R2 | `progress/checks_service-cap-per-number.sql` | bloque R2: A → A1 `3:1`, A2 `1:0`; B → `2:2`; nov vacío; sept incluye `x-old` (`4:2`). Exclusiones: otra categoría, `sent`, `failed`, anterior a `p_since`, `whatsapp_config_id` NULL, `free_entry_point`, otra cuenta. `pricing_type` NULL cuenta |
| R3 | verify-schema + checks | `authenticated`/`anon` → `insufficient_privilege`; `service_role` ejecuta y ve las filas |
| R4 | `src/lib/billing/service-cap.test.ts` | `999 used and nothing billable is not exhausted`, `1000 used is exhausted`, `any billable service message is exhausted even with a low count`, `31 Dec 23:59 UTC resets on 1 Jan of the next year`, `29 Feb of a leap year belongs to February`, `uses UTC, not the local clock…` |
| R5 | `src/app/api/whatsapp/service-cap/route.test.ts` | `an agent gets the exact shape, without Meta, counted for its own account (R5)`, `managed → numbers: [] and the rpc is never called (R5, A6)`, `no session → 401` |
| R6 | `route.test.ts` / `src/lib/security/tenant-isolation.test.ts` | `A never sees B's numbers or B's exhausted count (R6, CP3)`, `B sees its own number exhausted` / `A sees only its own number at 0 — never B's exhausted one`, `PATCH writes A's setting and leaves B untouched` |
| R7 | `route.test.ts` | `an admin switches to warn: 200 and only A is written (R7)`, `switching to pause_ai never writes B (fuga)`, `400 for an unknown value / a missing action / a non-string action, nothing written`, `400 for invalid JSON`, `below admin → 403, nothing written`, `no session → 401`; checks R7 (RLS `accounts_update`) |
| R8 | `route.test.ts`, `use-service-cap.test.ts`, `service-cap-alert.test.tsx` | `the rpc failing → 500 with a generic error, no internals (R8)`, `a 500 resolves to null and is not cached`, `a network error resolves to null`, `null (no data / failed read, R8) → nothing` |
| R9 | `src/lib/ai/auto-reply.test.ts` | `pause_ai + exhausted number: no reservation, no model, no send, no usage (R9)` (además: no toca la conversación; `console.info` con la cuenta) |
| R10 | `auto-reply.test.ts`, `service-cap.test.ts` | `warn: replies as today and never asks for the count (R10)`, `managed account: replies…`, `pause_ai with the number under the free tier: replies (R10)`, `pause_ai with no number to resolve: replies (R10)`; `in warn, never pauses and never calls the RPC (R10)`, `in a managed account…` |
| R11 | `service-cap.test.ts`, `auto-reply.test.ts` | `fails open (R11)…` × 5 (accounts, subscriptions, whatsapp_config, RPC con error, RPC lanza); `the count failing fails open: the reply goes out (R11)` |
| R12 | `service-cap.test.ts`, `auto-reply.test.ts` | `pauses when the sealed number is exhausted…`, `with no sealed number, falls back to the default number (R12)`, `with no default, falls back to the oldest number`, `a sealed number of ANOTHER account never resolves (CP3)…`, `a sealed id that no longer exists falls back to the default`; `pause_ai + exhausted default number with a NULL-sealed thread also pauses (R12)`, `every service-cap read is scoped to the dispatching account (CP3)` |
| R13 | `service-cap.test.ts` | `on the 1st at 00:00:01 UTC asks from the new month and, with no rows, does not pause (R13)` |
| R14 | `src/app/api/whatsapp/webhook/route.test.ts` | `persists the inbound, calls the AI dispatch, and nothing is sent` (el despacho simulado corre el `isAiPausedByServiceCap` real) |
| R15 | evidencia abajo | — |
| R16 | `src/components/inbox/service-cap-alert.test.tsx` | `exhausted + warn…`, `exhausted + pause_ai: says the AI is paused until the reset date`, `pause_ai in English formats the date in English`, `two exhausted numbers are both named…`, `managed → nothing`, `null… → nothing`, `no exhausted number → nothing` |
| R17 | `src/components/settings/service-cap-settings.test.tsx` | `0 used`, `734 used`, `exhausted by count shows the tag`, `exhausted by billable with a low count shows the tag too`, `managed, unknown billing or no data → nothing`, `English` |
| R18 | `service-cap-settings.test.tsx` | `shows both options with the current one checked`, `warn checked by default`, `disabled without permission`, `enabled with permission`, `hidden for managed, without data or without numbers`, `sends a PATCH with the exact body and keeps the new action`, `a non-OK response reverts to the previous action`, `a network error reverts too` |
| R19 | `service-cap-alert.test.tsx` | `Inbox.serviceCap / Settings.whatsapp.serviceCap has the same keys in es and en`, `…has the same placeholders in es and en`, `the design keys are all there` |

### R15 / CP8 (salidas)

`git diff --stat be8ca0f -- src/app/api/whatsapp/webhook/route.ts src/lib/billing/enforce.ts
src/lib/flows/meta-send.ts src/lib/automations/meta-send.ts src/app/api/whatsapp/send/route.ts
src/lib/whatsapp/broadcast-core.ts` → vacío (ninguno tocado).

`grep -rn isAiPausedByServiceCap src | cut -d: -f1 | sort | uniq -c`:

```
   4 src/app/api/whatsapp/webhook/route.test.ts
   3 src/lib/ai/auto-reply.ts
   4 src/lib/billing/service-cap.test.ts
   2 src/lib/billing/service-cap.ts
```

Fuera de los tests, solo `auto-reply.ts` lo importa. (El test del webhook lo carga con
`vi.importActual` para el caso R14.)

## Verificaciones contra base real

- `scripts/replay-migrations.sh` con 001–076 + 079 + 080: **no pude completarla**. Tres intentos:
  el primero quedó colgado esperando el arranque (>10 min, Docker al 100 % de CPU con otras
  réplicas de agentes en paralelo); el segundo y el tercero murieron con `container … is not
  running` durante el arranque del contenedor (la imagen inicializa la base y el contenedor
  desaparece; no es un fallo de SQL: el script no llegó a aplicar ninguna migración). Además
  vi en el scratchpad compartido una salida ajena (de la rama con la 082), señal de que varias
  réplicas corrían a la vez; el script escribe en `/tmp/replay-out.txt` fijo, compartido entre
  réplicas concurrentes.
  Cuarto intento (al cerrar): mismo `container … is not running`, exit 1. **La réplica y los
  checks SQL quedan para el líder** cuando Docker esté libre.
- `progress/checks_service-cap-per-number.sql`: escrito, **pendiente de ejecutar** por la misma
  causa. Cubre R1, R2 (exacto, con cada exclusión), R3 (authenticated/anon/service_role) y R7
  (RLS `accounts_update`). Uso: `KEEP=1 scripts/replay-migrations.sh .claude/worktrees/pmd-service-cap`
  y `docker exec -i <contenedor> psql -U postgres -h localhost -d postgres -v ON_ERROR_STOP=1 <
  progress/checks_service-cap-per-number.sql` → `NOTICE: checks_service-cap-per-number: OK`.
- Idempotencia y `--single-transaction` (T1): pendientes con la réplica:
  `docker exec -i <c> psql … -v ON_ERROR_STOP=1 < supabase/migrations/080_service_cap.sql` dos veces y
  `psql --single-transaction … < 080_service_cap.sql`. La migración usa `ADD COLUMN IF NOT EXISTS`,
  CHECK dentro de `DO` con `IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION` y REVOKE/GRANT
  repetibles; `SET lock_timeout`/`RESET` funcionan dentro de una transacción.

## Verificación manual pendiente (Meta real; la hace el humano)

Supuestos S-C1…S-C6 implementados tal cual, sin verificar (no se consultó la web):

1. En un número `direct` real, responder desde el inbox dentro de la ventana y consultar
   `select pricing_category, pricing_type, pricing_billable, status from message_charges order by
   created_at desc limit 5;`. Anotar aquí el `pricing_type` literal (S-C2).
2. Cuando un número pase de 1.000 servicio en el mes, comprobar que la fila 1.001 llega con
   `pricing_billable = true` (S-C1, S-C2) y que el aviso aparece en ≤ 60 s (TTL del hook).
3. Recibir un mensaje desde un anuncio Click to WhatsApp y responder: comprobar `pricing_type =
   'free_entry_point'` y que ese mensaje no sube `used` (S-C3).
4. Comparar el corte de mes del Business Manager con el de UTC (S-C4).
5. S-C5 (cuota por `phone_number_id`) y S-C6 (`delivered` llega en segundos): observar en el paso 2.

Guion en el CRM (sin Meta): en Ajustes → WhatsApp, con una cuenta `direct` y al menos un número,
aparece la tarjeta «Cuota gratis de Meta»; un admin cambia a «Pausar la IA del número» (toast de
guardado); un agente ve la tarjeta deshabilitada. Con un `UPDATE message_charges` local para pasar
de 1.000 en un número, la bandeja muestra la franja ámbar.

## Decisiones donde el spec era ambiguo

- **Fecha del aviso en UTC.** `resetsAt` se formatea con `useFormatter().dateTime(…, { dateStyle:
  'long', timeZone: 'UTC' })` en vez de `toLocaleDateString(locale)` del diseño: en RD (UTC−4) la
  fecha local sería el último día del mes, que contradice «hasta el día 1». Así dice «1 de
  noviembre de 2026»; la IA se reanuda en realidad a las 20:00 locales del 31 (S-C4), antes, nunca
  después.
- **Plurales ICU.** `Inbox.serviceCap.numbers` y `paused` usan `{count, plural, …}` («este
  número»/«estos números»), con los mismos placeholders en es y en. Números con `{x, number}`.
- **Clave extra `Settings.whatsapp.serviceCap.saved`** para el toast de éxito (el diseño solo
  listaba `saveFailed`).
- **Revertir en error (R18) sin jsdom.** El repo no tiene jsdom ni testing-library, así que el
  guardado vive en `saveServiceCapAction(next, previous, fetchImpl)` (exportado) y se prueba
  directo: cuerpo exacto del PATCH y que devuelve la anterior si falla. El componente usa ese
  resultado para fijar la selección y lanzar `toast.error(t('saveFailed'))`. El render (marcado,
  deshabilitado, oculto) se prueba estático.
- **`GET` sin números**: no llama a la RPC (nada que contar). `managed` tampoco (R5).
- **`PATCH` responde 500 genérico** si el UPDATE devuelve error (el diseño no lo listaba; mismo
  criterio que R8).
- **R12 sin `conversationId` en `resolveWhatsAppConfig`**: el sellado ya se miró (con su
  `account_id`); pasarlo solo repetiría la lectura. Cae al por defecto y al más antiguo igual.
- **Hook**: el estado guarda el `accountId` para el que se leyó y devuelve `null` si no coincide
  con la cuenta actual (regla 1, sin enseñar la cuota de la cuenta anterior durante el cambio).
- **80 %**: fuera de alcance según `requirements.md` (p11.7); no implementado.

## Variables de entorno nuevas

Ninguna. `docs/docker.md` no cambia; `.env.local.example` no se toca.

## Notas de despliegue

- La 080 va tras 075–079. Si llega al remoto antes que 077/078 (otra rama), `supabase db push
  --include-all` (decisión del humano). No depende de 077/078.
- CP11: la 080 no toca `messages`, `conversations` ni `message_charges`; el `ALTER TABLE accounts`
  lleva `lock_timeout = 5s`.
- Conflicto previsible con p11.4 en `src/lib/ai/auto-reply.ts`/`auto-reply.test.ts` (zonas
  distintas: aquí la compuerta antes de `claimInboundAutoReply` y un `describe` nuevo al final del
  test). Con p11.6 en `webhook/route.test.ts` (aquí solo un `describe` añadido al final) y en
  `inbox/page.tsx` (aquí dos líneas: import y `<InboxServiceCapAlert />` tras la franja de
  WhatsApp desconectado). `messages/*.json`: claves nuevas al final de `Inbox` y de
  `Settings.whatsapp`.

## Deuda detectada fuera de alcance

- `src/app/(dashboard)/inbox/page.tsx` no está formateado con prettier (dos comas finales que
  prettier quita); dejé esas líneas como estaban para no ensuciar el diff con p11.6.
- `scripts/replay-migrations.sh` escribe en `/tmp/replay-out.txt` fijo: con réplicas
  concurrentes, el mensaje de error de una puede ser el de otra. Debería usar `mktemp`.
- Con varios agentes a la vez, los contenedores de réplica quedan vivos (`KEEP=1`) y saturan
  Docker; los arranques nuevos mueren o tardan >10 min.

## Segunda ronda

Rama `pmd/service-cap`, commit `0912d47` (sobre e5b53fb): `fix: tipar el rpc sustituido en el test del tope de servicio (p11.3)`.

- Punto 1 (bloqueante): `src/lib/billing/service-cap.test.ts` sustituye `client.rpc` con el alias local
  `type RpcFn = (name: string, args: Record<string, unknown>) => unknown` en lugar de `Function`.
- `npm run lint`: `✖ 34 problems (0 errors, 34 warnings)` (avisos preexistentes, ninguno en el archivo tocado;
  `npx eslint src/lib/billing/service-cap.test.ts` sale limpio con código 0).
- `npm run typecheck`: limpio.
- `npx vitest run src/lib/billing/service-cap.test.ts`: 1 archivo, 26 tests en verde.
- No se repitieron la suite completa ni el build (indicación del líder).
- Punto 2 (réplica de migraciones con Docker): **pendiente**. Docker está apagado por orden del humano;
  no se intentó. Queda por correr `scripts/replay-migrations.sh` y `progress/checks_service-cap-per-number.sql`.

## Tercera ronda

Rama `pmd/service-cap`, commit `29fb4bc fix: tope de servicio vedado a soporte y caché sin carreras (p11.3)`
sobre 0912d47. Responde a «Cambios requeridos (segunda ronda)» de `progress/review_service-cap-per-number.md`.

### Cambios

1. **PATCH vedado a soporte** (hallazgo 1). `src/app/api/whatsapp/service-cap/route.ts`: `await
   assertNotSupportSession(ctx)` justo después de `requireRole('admin')`, el mismo patrón que `api-keys`,
   `webhooks`, `members`, `invitations` y `transfer-ownership`. Ahora devuelve 403 y marca la acción
   como 403 en `impersonation_actions`, en vez del 404 por RLS. En `whatsapp-config.tsx`, `ServiceCapCard`
   recibe `canEdit={canEditSettings && !supportSession}`. `supportSession` sale de `useAuth()`, que es
   el mecanismo que ya usa el cliente para detectar la sesión (`presence-heartbeat.tsx`). No invento
   otro.
2. **Carrera en la caché** (hallazgo 2). `src/hooks/use-service-cap.ts`: hay un contador de generación
   por cuenta (`generation`), y `cache.set` solo se hace si la petición sigue siendo la última lanzada
   para esa cuenta. La petición vieja sigue resolviendo a quien la esperaba, pero ya no escribe en la
   caché. `__resetServiceCapCache` también vacía el contador.
3. **`chosen` se limpia al refrescar** (hallazgo 3, el recomendado). `service-cap-settings.tsx`: cuando
   llega un `status` nuevo (otro objeto: el refresh tras guardar o el TTL), se borra `chosen`. Uso el
   patrón de React de ajustar el estado durante el render cuando cambia una prop (`seenStatus`), no un
   efecto. Este caso no tiene test, porque el repo no tiene jsdom y el test del componente es un render
   estático que no recorre transiciones de estado.
4. Hallazgos 4 y 5: no se tocan, por orden del líder.

### Criterio ↔ test (nuevos)

| Criterio | Test |
|---|---|
| PATCH con sesión de soporte → 403, ningún UPDATE | `src/app/api/whatsapp/service-cap/route.test.ts` › `a support session → 403 and nothing written (s9.5, 072)` |
| A lenta + B forzada que termina antes → la caché se queda con B | `src/hooks/use-service-cap.test.ts` › `a slow request A cannot overwrite a forced request B that finished first` |

Comprobé que los dos tests detectan el fallo. Sin el cambio en la ruta, el test de soporte falla (200).
Con el `cache.set` incondicional, el test de la carrera falla. Restaurado el código, los dos pasan.

### Verificación

- `npm run lint`: 0 errores, 34 advertencias (las mismas que ya había).
- `npm run typecheck`: exit 0.
- `TZ=UTC npx vitest run` sobre `route.test.ts`, `use-service-cap.test.ts`, `service-cap-settings.test.tsx`
  y `src/lib/security/tenant-isolation.test.ts`: 4 archivos, 146/146.
- No repetí la suite completa ni el build, por orden del líder.
- Prettier pasado en los seis archivos tocados.
- **Réplica de migraciones: no corrida.** Docker sigue apagado por orden del humano. Esta ronda no toca
  SQL, pero sigue pendiente el cambio requerido 3 de la segunda ronda: la 080 no va al remoto hasta que
  `scripts/replay-migrations.sh` y `progress/checks_service-cap-per-number.sql` salgan en verde.
- Ninguna conexión de red fuera de la máquina.
