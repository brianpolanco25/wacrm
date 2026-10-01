# impl p11.6 `free-entry-point-badge`

Estado: **done (compuerta parcial en verde, por orden del humano)**: lint, typecheck y la suite completa de
tests en verde. `build` y la réplica de migraciones quedan **pendientes** (más abajo).

- Rama: `pmd/entry-point` · worktree `.claude/worktrees/pmd-entry-point` · base `feat/precios-meta-directo` @ be8ca0f
- Spec: `specs/free-entry-point-badge/` (requirements, design, tasks) · Migración **082**

## Plan (de `specs/free-entry-point-badge/tasks.md`)

1. T1 Migración 082 + bloque `-- 082 --` en `verify-schema.sql` + `progress/checks_free-entry-point-badge.sql`.
2. T2 `src/lib/whatsapp/entry-point.ts` (`parseReferral`, `computeEntryPoint`, `recordEntryPoint`, constantes) + test.
3. T3 Enganche en `processMessage` después del bump, tras la frontera de idempotencia, en su propio `try`.
4. T4 Caso A↔B en `tenant-isolation.test.ts`.
5. T5 Campos en `Conversation` + `src/lib/inbox/free-window.ts` + test.
6. T6 `src/hooks/use-minute-clock.ts` + test con temporizadores falsos.
7. T7 `FreeWindowBadge` + claves es/en + test.
8. T8 Montaje en `conversation-list.tsx` y cabecera de `message-thread.tsx`.
9. T9 Revisión de alcance (`git diff --stat be8ca0f`).
10. T10 Compuerta, CHANGELOG, informe, commits.

Un implementer anterior hizo T1–T8 y el CHANGELOG (commits 21949d0, 61e46a4, 5bc3284). En esta sesión
revisé esos commits contra el spec (estaban completos), moví las claves i18n al final de `Inbox`
(dfaf8f6) e hice T9 y T10.

## Commits (`git log --oneline be8ca0f..HEAD`)

| Commit | Qué |
|---|---|
| 21949d0 | `chore:` prettier en `conversation-list.tsx` y `message-thread.tsx` antes de tocarlos (solo formato) |
| 61e46a4 | `feat:` migración 082, `entry-point.ts`, enganche en el webhook, tests de webhook, de librería y de fuga A↔B, `verify-schema.sql` |
| 5bc3284 | `feat:` `free-window.ts`, `use-minute-clock.ts`, `FreeWindowBadge`, montaje en lista y cabecera, tipos, i18n, CHANGELOG |
| dfaf8f6 | `chore:` claves `Inbox.freeWindow` movidas al final de su sección en es/en (menos conflictos con otras ramas de la fase) |

## Criterio ↔ test

| Req. | Archivo | `it` |
|---|---|---|
| R1 | `supabase/ci/verify-schema.sql` (bloque `-- 082 --`) + `progress/checks_free-entry-point-badge.sql` | aserción de las cuatro columnas anulables sin default y de los dos CHECK (**réplica pendiente**) |
| R2 | `progress/checks_free-entry-point-badge.sql` | `entry_point_source = 'foo'` → 23514; los tres valores y NULL pasan (**pendiente de ejecutar**) |
| R3 | `progress/checks_free-entry-point-badge.sql` | ventana sin `entry_point_at` → 23514; 72 h + 1 s → 23514; 72 h exactas pasa (**pendiente de ejecutar**) |
| R4 | revisión de la 082 + `checks_…sql` (`convalidated = false`) | revisado a mano (abajo); consulta pendiente de ejecutar |
| R5 | `src/lib/whatsapp/entry-point.test.ts` | `R5: source_type 'ad' da ctwa_ad`, `R5: source_type 'post' da ctwa_organic`, `R5: se lee en minúsculas y recortado`, `R5: otro valor o su ausencia da ctwa_other` |
| R6 | ídem | `R6: %s devuelve null sin lanzar` (undefined, null, cadena, número, array, booleano) |
| R7 | ídem | `R7: conserva solo la lista blanca de cadenas, truncadas a 500` |
| R8 | ídem | `R8: anuncio con timestamp válido abre la ventana de 72 h exactas`, `R8: acepta hasta 5 min de adelanto del reloj de Meta` |
| R9 | ídem | `R9: orgánico guarda origen y entrada sin ventana`, `R9: ctwa_other guarda origen y entrada sin ventana`, `solo los anuncios abren ventana (S-E2)` |
| R10 | ídem | `R10: timestamp %s usa la hora de recepción y no abre ventana` ('abc', '', '-1', +1 h, +301 s, decimal, Infinity, undefined, null, objeto, enorme) |
| R11 | `entry-point.test.ts` | `sin valor previo: UPDATE filtrado por id, account_id e is(null)`, `con valor previo más viejo: filtro optimista eq sobre el leído`, `con valor previo más nuevo o igual: no escribe`, `con valor previo ilegible: no escribe` |
| R11 | `src/app/api/whatsapp/webhook/route.test.ts` | `R11: un referral de anuncio guarda ctwa_ad y la ventana de 72 h, filtrado por id y account_id`, `R11: un referral más antiguo que el guardado no pisa la conversación`, `R11: un referral más nuevo que el guardado escribe con el filtro optimista` |
| R12 | `route.test.ts` | `R12: una repetición de Meta no toca las columnas de punto de entrada`, `R12: el mismo payload dos veces escribe una sola vez` |
| R13 | `route.test.ts` | `R13: un entrante sin referral no escribe y la ventana abierta sigue igual` |
| R14 | `route.test.ts` | `R14: si el update del punto de entrada falla, el mensaje, el bump, el resto del pipeline y el 200 siguen`, `R14: si el update lanza, el pipeline sigue igual` |
| R14 | `entry-point.test.ts` | `R14: error de Supabase -> console.error de una línea, sin lanzar ni filtrar el referral`, `R14: excepción del cliente -> console.error, sin lanzar`, `R14: un from() que lanza de forma síncrona tampoco escapa` |
| R10/CP11 | `route.test.ts` | `CP11/R10: un timestamp futuro guarda el origen con la hora de recepción y sin ventana`, `CP11: un timestamp no numérico responde 200 y no deja escapar la excepción` |
| R15 | `route.test.ts` | `R15: con la cuenta en solo lectura (manual_hold) guarda el entrante y su punto de entrada` |
| R16 | `src/lib/security/tenant-isolation.test.ts` | `p11.6: un entrante con referral de anuncio por el número de A guarda el punto de entrada en A y no toca la conversación de B (mismo teléfono)`; `entry-point.test.ts` › `R16: el account_id del llamante siempre va en el filtro` |
| R17 | `src/lib/inbox/free-window.test.ts` | `R17: una ventana futura en una cuenta direct devuelve su fecha`, `… pasada devuelve null`, `… termina justo ahora devuelve null`, `R17: NULL o ausente devuelve null`, `R17: una cadena inválida devuelve null` |
| R18/R19 | `src/components/inbox/free-window-badge.test.tsx` | `pinta el texto, el title y el gancho data-free-window`, `lleva icono además del color (nunca solo color)`, `acepta clases extra (la cabecera la oculta en móvil)`; el montaje en lista (`ConversationItem`) y en cabecera (junto al `<Badge>` de `sessionInfo`, `hidden sm:inline-flex`) se comprueba revisando el diff de 5bc3284 |
| R20 | `src/hooks/use-minute-clock.test.ts` | `el intervalo es de 60 s`, `no avanza antes de 60 s y avanza a los 60 s con la hora nueva`, `la limpieza para el intervalo y no deja temporizadores vivos`, `montar y desmontar varias veces no acumula intervalos` |
| R21 | `free-window.test.ts` | `R21: en una cuenta managed no hay insignia`, `R21: mientras metaBilling no se conozca no hay insignia` |
| R22 | `free-window-badge.test.tsx` | `%s tiene badge y tooltip con el placeholder {until}`; además `src/i18n/messages.test.ts` e `icu-safety.test.ts` en verde |
| R23 | revisión del diff (T9) | ver §Alcance |
| — | `route.test.ts` | `una reacción con referral no pasa por el punto de entrada` |

## Compuerta

- `npm run lint`: 0 errores, 34 avisos. Los 4 avisos de los archivos tocados (`downloadMedia` sin usar en
  `route.ts`, `<img>` en `conversation-list.tsx`, `ScrollArea` sin usar y la dependencia `tQuote` en
  `message-thread.tsx`) ya estaban en be8ca0f: lo comprobé corriendo eslint sobre la versión base.
- `npm run typecheck`: salida 0.
- `TZ=UTC npm test`: 271 archivos y 3.884 tests en verde (pasada completa después del último cambio).
- `npm run build`: **NO ejecutado** por orden del humano (no saturar la máquina). Lo corre el líder sobre la
  rama integrada. El cambio no añade rutas ni APIs de framework: dos componentes cliente que ya tenían
  `"use client"`, un hook cliente y un módulo puro. `route.md` de los docs de Next 16 no trae avisos de
  deprecación que afecten al route handler del webhook (CP7).
- `scripts/replay-migrations.sh`: **NO ejecutado**. Docker está apagado por orden del humano.

## Verificaciones contra base real: PENDIENTES (Docker apagado por orden del humano)

Hay que ejecutarlas al encender Docker:

```bash
KEEP=1 scripts/replay-migrations.sh /Users/brian/Documents/Dev/projects/wacrm/.claude/worktrees/pmd-entry-point
# 082 por segunda vez (idempotencia, R1)
docker exec -i <contenedor> psql -U postgres -h localhost -d postgres -v ON_ERROR_STOP=1 \
  < supabase/migrations/082_conversation_entry_point.sql
docker exec -i <contenedor> psql -U postgres -h localhost -d postgres -v ON_ERROR_STOP=1 \
  < /Users/brian/Documents/Dev/projects/wacrm/progress/checks_free-entry-point-badge.sql
# esperado: NOTICE checks_free-entry-point-badge: OK
```

`progress/checks_free-entry-point-badge.sql` (ya escrito, con ROLLBACK al final) cubre R2, R3, R4
(`convalidated = false`), el filtro optimista de R11 y el filtro `id` + `account_id` de R16.

Revisión manual de la 082 (sustituye a la réplica hasta que se pueda correr):
- Idempotente: `ADD COLUMN IF NOT EXISTS` ×4 y cada CHECK dentro de `DO` con `IF NOT EXISTS` sobre
  `pg_constraint` (conrelid + conname).
- Nada destructivo: sin `DROP` ni `CASCADE`, sin `UPDATE` ni backfill.
- Locks (CP11): `SET lock_timeout = '5s'` antes de los `ALTER TABLE conversations` y `RESET` al final, como en
  la 075. Columnas sin `DEFAULT`, así que no se reescribe la tabla; CHECK `NOT VALID`, así que no se recorre.
- El CHECK de ventana admite justo `entry_point_at + 72 h`, que es lo que escribe `computeEntryPoint`.
- `verify-schema.sql`: bloque `-- 082 -- … -- /082 --` dentro del `DO` único, después del `/079`, con
  las cuatro columnas (tipo, anulables, sin default) y los dos CHECK (`contype = 'c'`).
- Solo depende de `conversations`. Si las 080/081 de otras ramas no están, el orden del replay no cambia.

## Verificación manual pendiente (necesita un anuncio CTWA real; la hace el humano)

1. Con la 082 aplicada, crear un anuncio Click to WhatsApp de prueba en el Business Manager hacia un número
   conectado, tocarlo desde un teléfono propio y enviar el mensaje prellenado.
2. `select entry_point_source, entry_point_at, free_window_until, entry_point_referral from conversations
   where id = '<id>';` Debe dar `ctwa_ad`, la hora del mensaje, +72 h y un `entry_point_referral` con
   `source_type = 'ad'`. Si `source_type` llega con otro valor, anotarlo (S-E1).
3. En una cuenta `direct`, comprobar que la lista y la cabecera muestran «Ventana gratis hasta …». En una
   `managed`, que no aparece.
4. Responder desde la bandeja antes de 24 h y comprobar en `message_charges` que la respuesta trae
   `pricing_type = 'free_entry_point'` y `pricing_billable = false` (S-E2, S-E3).
5. Comprobar si la ventana empieza al hacer clic o con la primera respuesta (S-E3): un mensaje enviado a las
   71 h del clic debe salir `free_entry_point`. Si Meta cuenta desde la respuesta, la insignia se apaga antes
   de tiempo, que es el lado seguro, y decide el humano.
6. Repetir con un clic desde una publicación orgánica (`post`) y con el botón de una página de Facebook: la
   conversación guarda `ctwa_organic`, sin insignia. Anotar si Meta marca esos mensajes `free_entry_point`
   (S-E2) para decidir si se amplía `FREE_WINDOW_SOURCES`.

## Supuestos de Meta sin verificar (design.md)

- **S-E1**: `messages[].referral` es un objeto con `source_type` (`ad`/`post`), `source_id`, `source_url`,
  `headline`, `ctwa_clid`… Si la forma es otra, `parseReferral` devuelve `null` y no se guarda nada.
- **S-E2**: la ventana gratis solo la abren los anuncios (`ad`). Lo orgánico y lo desconocido se guardan
  sin ventana.
- **S-E3**: la ventana dura 72 h desde el mensaje del cliente y solo se abre si el negocio responde en las
  primeras 24 h. Si dura menos, hay que bajar `FREE_WINDOW_HOURS` y el CHECK de la 082.
- **S-E4**: dentro de la ventana Meta no cobra ninguna categoría. Si las plantillas sí se cobran, basta
  ajustar el `tooltip`.
- **S-E5**: `timestamp` son segundos Unix en una cadena. Los inválidos o futuros caen en R10.

## Decisiones donde el spec era ambiguo

- **Zona horaria de la insignia**: `freeWindowDateTimeOptions()` le pasa a `format.dateTime` el `timeZone`
  del navegador de forma explícita. El repo no configura un `timeZone` global en next-intl y sin él avisa
  `ENVIRONMENT_FALLBACK` en cada llamada. Es la hora local del operador.
- **`title` de la fila**: si faltara `freeWindowTitle`, se usa el `label` como `title`. En la práctica
  siempre llegan los dos.
- **Previo ilegible en `recordEntryPoint`**: si el `entry_point_at` guardado no se puede parsear, se trata
  como «más nuevo» y no se escribe (lado conservador).
- **Envoltura del webhook**: `parseReferral` también va dentro del `try`, no solo la llamada a
  `recordEntryPoint`. Es una red más amplia para CP11 que la del boceto de design.md.
- **i18n**: las claves `Inbox.freeWindow` van al final de la sección `Inbox`, no al principio, para que choque
  menos al integrar con otras ramas (lo pidió el líder).

## Alcance (T9, R23)

`git diff --stat be8ca0f` no toca `src/lib/api/v1`, `enforce.ts`, `entitlements.ts`,
`message-charges.ts`, `src/lib/billing`, `src/lib/automations`, `src/lib/flows`, `src/lib/ai` ni
`src/app/(dashboard)/inbox/page.tsx`. Las columnas nuevas solo las leen `free-window.ts` y los dos
componentes de la bandeja. Archivos tocados: la 082, `verify-schema.sql`, `route.ts`/`route.test.ts` del
webhook, `entry-point.ts`(+test), `tenant-isolation.test.ts`, `types/index.ts`, `free-window.ts`(+test),
`use-minute-clock.ts`(+test), `free-window-badge.tsx`(+test), `conversation-list.tsx`, `message-thread.tsx`,
`messages/{es,en}.json` y `CHANGELOG.md`. Los diffs grandes de `conversation-list.tsx` y
`message-thread.tsx` vienen casi todos del commit de prettier aislado (21949d0); el cambio real está en
5bc3284 (+61/−10 y +34/−2).

## Variables de entorno nuevas

Ninguna. `.env.local.example` y `docs/docker.md` no se tocan.

## CHANGELOG

`[Unreleased]` › «Inbox: free entry-point window from Click to WhatsApp ads», con el aviso
«Migration required: `082_conversation_entry_point.sql`. Apply it before the code». Si el código llega
antes que la migración, el `UPDATE` falla con un `console.error` inocuo y el entrante sigue.

## Deuda fuera de alcance (no arreglada)

- `src/app/api/whatsapp/webhook/route.ts:1053` (`created_at: new Date(parseInt(message.timestamp) * 1000).toISOString()`)
  y `:648` (`tsIso`, mismo patrón en estados): con un `timestamp` no numérico lanzan `RangeError: Invalid
  time value`. El spec la cita como «`route.ts:635`»; con el código de ahora está en esas dos líneas. El test
  `CP11: un timestamp no numérico responde 200…` confirma que el handler la absorbe y responde 200, pero ese
  mensaje no se guarda. La lógica nueva no depende de esa conversión: usa su propio `parseTimestampSeconds`.
- Avisos de lint anteriores en los archivos tocados: `downloadMedia` sin usar (`route.ts:5`), `ScrollArea` sin
  usar y la dependencia `tQuote` que falta en un `useCallback` (`message-thread.tsx`).
