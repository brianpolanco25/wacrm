# impl s9.12 `impersonate-no-reason`

## Plan

1. `DEFAULT_SUPPORT_REASON` en `support-cookie.ts` (junto a `MIN_REASON_LENGTH`), reexportado desde `impersonation.ts`.
2. `POST /api/platform/impersonate`: `reason` opcional. Vacío o ausente: texto por defecto. Escrito y con menos de 10 caracteres: 400.
3. Ficha `/platform/[id]`: el botón de sesión de soporte deja de depender del motivo. Texto de ayuda nuevo en es/en.
4. `PresenceHeartbeat`: sale temprano durante la sesión. `useAuth()` expone `supportSession`.
5. Revisar los demás efectos del CRM que escriben en tablas cerradas durante la sesión.
6. `docs/security.md`, `CHANGELOG.md`, compuerta y commits.

## Rama y commits

Rama `platform/impersonate-no-reason` (worktree `.claude/worktrees/impersonate-no-reason`), base `feat/superadmin` @ 0ffe368.

- `320ed22` chore: prettier en `use-auth.tsx` y `presence-heartbeat.tsx`. Solo formato: estaban con comillas dobles, fuera de `.prettierrc`. Va aparte para que el diff funcional se lea bien.
- `7b91ff5` feat: la feature.

Sin migración. Sin variables de entorno nuevas.

## Criterio ↔ test

| Criterio | Archivo | `it` |
| --- | --- | --- |
| Sin reason: se abre la sesión y la fila lleva el texto por defecto | `src/app/api/platform/impersonate/route.test.ts` | `opens a session without a reason and records the default text` |
| Reason en blanco o `null` cuenta como ausente | ídem | `treats a blank or null reason as no reason` |
| El texto por defecto cumple el CHECK de la 055 (≥10) | ídem | `keeps the default text long enough for the CHECK of migration 055` |
| Reason escrito y corto: 400, sin fila ni cookie | ídem | `refuses a written reason too short to mean anything` |
| Reason largo: se guarda (con trim) | ídem | `records actor, account, moment and reason, …` y `trims the reason before storing it` (los dos ya existían) |
| Ficha: el botón de sesión de soporte no está `disabled` con el motivo vacío, «Suspender» sí; el texto de ayuda se muestra (es y en) | `src/components/platform/platform-provisioning.test.tsx` | `[%s] the support-session button works with an empty reason; suspending does not (s9.12)` |
| Heartbeat: con sesión de soporte no se llama al RPC, no se ponen listeners y no hay `console.error` | `src/components/presence/presence-heartbeat.test.tsx` | `never calls touch_presence during a support session, and logs nothing` |
| Heartbeat: si la sesión se abre con el efecto ya corriendo, deja de latir antes del re-render | ídem | `stands down when a session opens while it is running (before the re-render)` |
| Heartbeat: sin sesión sigue latiendo (regresión) | ídem | `beats right away and every HEARTBEAT_MS …`, `does nothing until the account is known`, `stops beating and detaches its listeners on cleanup` |

Se reescribieron los tests que esperaban 400 sin motivo: `refuses without a reason` pasa a ser el primer `it` de la tabla, y `refuses a reason too short` ya no trata los espacios como motivo corto.

## Verificación contra base real

No aplica: no hay SQL nuevo. El texto por defecto tiene 50 caracteres, muy por encima del CHECK `char_length(btrim(reason)) >= 10` (055/058). Hay un test que lo comprueba contra `MIN_REASON_LENGTH`.

## Compuerta

- `npm run lint`: 0 errores (34 avisos, todos anteriores y en archivos que no toqué).
- `npm run typecheck`: limpio.
- `TZ=UTC npm test`: 252 archivos, 3509 tests, todos en verde.
- `npm run build` con las variables dummy: correcto.

## Verificación manual pendiente

1. Con `npm run dev` y un operador, entra en `/platform/<id>` con el Motivo vacío. «Abrir una sesión de soporte» está activo y «Suspender» no.
2. Pulsa el botón. Debe llevarte a `/dashboard` con el banner de sesión. Comprueba la fila: `SELECT reason FROM impersonation_log ORDER BY started_at DESC LIMIT 1;` debe devolver «Acceso del operador desde la consola de plataforma».
3. Con la sesión abierta, deja la pestaña abierta más de un minuto con la consola del navegador a la vista. No debe aparecer `[PresenceHeartbeat] touch_presence failed`.
4. Sal de la sesión y escribe «abc» como motivo. La petición devuelve 400 y aparece un toast con el error.

## Decisiones donde el spec era ambiguo

- **Código de estado 200, no 201.** El líder pidió «→ 201», pero la ruta siempre ha respondido 200 al abrir sesión, y el test existente y el cliente lo dan por hecho. No cambié el contrato: los tests nuevos esperan 200.
- **«Sin body».** Si no hay body JSON, sigue siendo 400, porque `account_id` es obligatorio. «Sin motivo» significa un body sin `reason`, o con `reason` vacío o `null`.
- **Texto de ayuda.** El campo Motivo de la ficha solo alimenta suspender/reactivar y la sesión de soporte. Asignar plan tiene su propio campo, que sigue diciendo «Obligatorio». Invitar miembros no pide motivo en este repo (`AddMemberForm` solo pide correo y rol). Por eso la ayuda dice «obligatorio para suspender o reactivar, opcional para la sesión de soporte». No mencionar invitar evita prometer una validación que no existe.
- **Cliente.** Con el campo vacío, la ficha no manda `reason` y la ruta pone el texto por defecto. Con un motivo corto escrito, el botón sigue activo y la ruta responde 400, que se muestra en un toast. Así se cumple «solo deshabilitado mientras la petición está en vuelo».
- **Cómo sabe el cliente que hay sesión.** `useAuth()` no lo exponía, así que añadí `supportSession: boolean` (`supportFlag !== null`, con el mismo store de cookie que `accountId`). Además, cada latido vuelve a leer `supportSessionActive()` de `@/lib/supabase/client`. Así cubre el hueco entre que aparece la cookie y el re-render, por ejemplo con una sesión abierta en otra pestaña.
- **Testabilidad sin jsdom.** El cuerpo del efecto pasó a `startPresenceHeartbeat(accountId, supportSession, env)`, con `document`, `window` y el RPC inyectados. El componente solo lo cablea. El entorno de vitest es `node` y no se añaden dependencias.

## Otros efectos del CRM que escriben durante la sesión (revisión del punto 3)

Busqué en el código de navegador las escrituras y los `rpc()` hacia tablas cerradas por la 072 (`profiles`, `notifications`, `accounts`, …). Durante una sesión, `guardReadOnly` los rechaza todos.

| Sitio | Qué hace | ¿Automático? | Acción |
| --- | --- | --- | --- |
| `src/components/presence/presence-heartbeat.tsx` | `rpc('touch_presence')` cada 30 s, con foco y con visibilidad | Sí | **Silenciado** (esta feature) |
| `src/app/(dashboard)/notifications/page.tsx` `markRead` / `markAllRead` | `notifications.update(read_at)` | No, lo dispara un clic | Sin cambio. Durante la sesión la lista se filtra por la cuenta del cliente, donde el operador no tiene notificaciones, así que no hay filas sin leer que marcar. Si llegara a ocurrir, sale un toast y no un `console.error`. |
| `src/components/settings/profile-form.tsx` | `profiles.update` y subida de avatar | No, botón Guardar | Sin cambio: rechazado con toast (lo trató s9.5) |
| `src/components/settings/deals-settings.tsx` | `accounts.update` (moneda) | No, botón | Sin cambio: rechazado con toast |
| `src/components/inbox/message-thread.tsx` | `conversations.update({ unread_count: 0 })` al abrir una conversación | Sí | Sin cambio: `conversations` es escribible en sesión (072). Pasa y queda en `impersonation_actions`. No es ruido. |
| `src/hooks/use-auth.tsx`, `use-presence.ts`, `use-unread-notifications.ts`, `conversation-list.tsx`, `deal-form.tsx` | Solo `select` sobre `profiles`/`accounts`/`member_presence`/`notifications` | — | Lecturas, nada que silenciar |
| Tema y preferencias (`use-theme.tsx`, `appearance-panel.tsx`, `flow-editor-shell.tsx`, `inbox/page.tsx`) | `localStorage` | — | No tocan la base |

No encontré escrituras de `last_seen`, preferencias de usuario en la base ni locale persistido en `profiles`. El único `last_seen_at` es el de `member_presence`, que escribe `touch_presence`.

## Deuda detectada fuera de alcance

- `src/app/(dashboard)/contacts/page.tsx:154` filtra contactos por etiqueta con `rpc('filter_contacts_by_tags')`, que es una lectura. Durante una sesión de soporte, `guardReadOnly` rechaza todo `rpc()`, así que el operador ve el toast «no se pudieron cargar» al filtrar por etiqueta en la cuenta del cliente. No es una escritura y no deja `console.error`, pero es una función de lectura que el soporte no puede usar. Arreglarlo exige decidir si la RPC respeta la cuenta efectiva (SECURITY DEFINER resuelve la cuenta por `auth.uid()`). No lo toqué.
- `.env.local.example`: sin cambios (no hay variables nuevas).
