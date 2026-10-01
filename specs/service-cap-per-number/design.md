# p11.3 `service-cap-per-number` — diseño

Leído contra `feat/precios-meta-directo` @ be8ca0f. Rutas, funciones y migraciones citadas existen
en esa rama salvo las marcadas **(nuevo)**.

## Rama

Worktree hijo `pmd/service-cap` en `.claude/worktrees/pmd-service-cap`, desde be8ca0f; se integra
en `feat/precios-meta-directo`. **Conflicto previsible con p11.4** (`ai-single-reply`): las dos
tocan `src/lib/ai/auto-reply.ts` y `auto-reply.test.ts`. Los cambios son en zonas distintas (aquí
una compuerta antes de `claimInboundAutoReply`; en p11.4, el texto antes de `engineSendText`), así
que el merge es pequeño; si el líder las lanza en paralelo, integrar p11.3 primero.

## Supuestos sin verificar (Meta) — los confirma el humano

No hay documentación de Meta en el repo sobre la cuota gratis más allá del encabezado de
`progress/spec_facturacion-gestionada.md` y de `KNOWN_PRICING_TYPES` en
`src/lib/whatsapp/message-charges.ts`. No se consultó la web (regla del humano).

| Id | Supuesto | Efecto si es falso |
|---|---|---|
| S-C1 | Desde el 2026-10-01 Meta regala 1.000 mensajes de **servicio entregados** por **número** y mes; los siguientes se cobran. | El umbral `SERVICE_FREE_TIER_PER_NUMBER = 1000` es una constante: se cambia en un sitio. |
| S-C2 | Los mensajes de servicio llegan en el webhook de estados con `pricing.category = 'service'`; dentro de la cuota con `billable = false`, después con `billable = true`. | Si `billable` no pasa a `true`, solo queda el conteo (R4 sigue funcionando por `used >= 1000`). |
| S-C3 | Las respuestas dentro de la ventana gratuita de 72 h de un anuncio Click to WhatsApp llegan con `pricing.type = 'free_entry_point'` y **no** consumen los 1.000. | Si sí los consumen, `used` subestima: el `billable > 0` del R4 corrige en cuanto Meta empieza a cobrar. |
| S-C4 | El mes de la cuota es el mes natural en **UTC**. | Desfase de horas en el corte de mes (RD es UTC−4: la IA se reanuda a las 20:00 del último día). Aceptable para un aviso. |
| S-C5 | La cuota es por **número de teléfono** (`phone_number_id`), no por WABA. | Con varios números en un WABA el conteo por número sobreestima lo que queda; el `billable > 0` sigue siendo exacto. |
| S-C6 | El estado `delivered` llega en segundos. | Lo enviado y aún no entregado no cuenta: la IA puede pasarse unos pocos mensajes del umbral. Aceptable. |

## Decisión: qué cuenta como «cuota gratis consumida»

Se eligió **`pricing_category = 'service'` entregados en el mes, excluyendo `pricing_type =
'free_entry_point'`**, más el atajo **«hay algún `service` con `pricing_billable = true` este mes»**.

- **Por qué no `pricing_type = 'free_customer_service'`**: depende de una etiqueta exacta que no está
  verificada para el modelo del 01-10 (es la del modelo anterior, `KNOWN_PRICING_TYPES` la conoce
  porque se vio antes); si Meta la renombra, el conteo queda en 0 sin aviso y la pausa nunca salta.
- **Por qué no `pricing_billable = false`**: también es `false` en la ventana de 72 h de un anuncio
  (S-C3) y en cualquier otra gratuidad futura; contaría como cuota cosas que no la consumen.
- **Por qué el atajo `billable > 0`**: es la prueba directa de que Meta ya está cobrando servicio en
  ese número. Corrige los casos en que el conteo subestima: mes en el que la 075 se aplicó a mitad
  (no hay filas de antes), envíos con el mismo número fuera del CRM que se registraron sin
  `whatsapp_config_id`, o S-C3/S-C5 falsos.
- Filas con `pricing_type` NULL **sí** cuentan (`IS DISTINCT FROM`).

## Migración `supabase/migrations/080_service_cap.sql` (nuevo)

Siguiente al último número en `supabase/migrations/` de esta rama (079). Al integrarse con la fase
10 quedará 075–080 en orden (077 y 078 viven en `feat/facturacion-gestionada`; la 080 no depende de
ellas). Idempotente, como 075/079:

```sql
SET lock_timeout = '5s';   -- falla en vez de esperar si algo retiene accounts (patrón de la 075)

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS service_cap_action text NOT NULL DEFAULT 'warn';
-- DEFAULT constante: en PG ≥ 11 no reescribe la tabla.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.accounts'::regclass
                   AND conname = 'accounts_service_cap_action_check') THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_service_cap_action_check
      CHECK (service_cap_action IN ('warn', 'pause_ai'));
  END IF;
END $$;

COMMENT ON COLUMN accounts.service_cap_action IS '…p11.3: qué hace la IA al agotar los 1.000 de servicio de un número…';

CREATE OR REPLACE FUNCTION public.service_quota_usage(p_account_id uuid, p_since timestamptz)
RETURNS TABLE (whatsapp_config_id uuid, used bigint, billable bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT mc.whatsapp_config_id,
         count(*)                                    AS used,
         count(*) FILTER (WHERE mc.pricing_billable) AS billable
  FROM message_charges mc
  WHERE mc.account_id = p_account_id
    AND mc.whatsapp_config_id IS NOT NULL
    AND mc.pricing_category = 'service'
    AND mc.status IN ('delivered', 'read')
    AND mc.delivered_at >= p_since
    AND mc.pricing_type IS DISTINCT FROM 'free_entry_point'
  GROUP BY mc.whatsapp_config_id
$$;

REVOKE ALL ON FUNCTION public.service_quota_usage(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.service_quota_usage(uuid, timestamptz) TO service_role;

RESET lock_timeout;
```

- Usa el índice `message_charges_account_delivered_idx` (075, `(account_id, delivered_at)`). Sin
  índice nuevo: el volumen es por cuenta y mes.
- `SECURITY INVOKER` + solo `service_role`: la RLS de `message_charges` (075) deja leer solo a
  `admin+`, y el aviso de la bandeja es para todos los miembros; por eso la ruta llama con rol de
  servicio **y** `p_account_id` de la sesión (CP3).
- `accounts_update` (017) ya deja a un `admin` cambiar su fila: no hace falta política nueva.
- CP11: la 080 no toca `messages`, `conversations` ni `message_charges` (solo crea una función que
  la lee). El `ALTER TABLE accounts` toma un lock breve; con `lock_timeout` no puede colgar el
  webhook más de 5 s, y reintentar el `db push` es seguro.
- `supabase/ci/verify-schema.sql`: bloque `-- 080` tras el `-- 079` dentro del único `DO`: columna
  con default `'warn'`, CHECK presente, función presente, `has_function_privilege('authenticated',
  …, 'EXECUTE') = false` y `= true` para `service_role`.

## Lógica: `src/lib/billing/service-cap.ts` (nuevo)

```ts
export const SERVICE_FREE_TIER_PER_NUMBER = 1000; // S-C1
export type ServiceCapAction = 'warn' | 'pause_ai';

export function asServiceCapAction(v: unknown): ServiceCapAction; // 'pause_ai' o 'warn'
export function serviceMonthWindow(now: Date): { monthStart: Date; resetsAt: Date }; // UTC (S-C4)
export function serviceCapState(
  row: { used: number; billable: number } | undefined
): { used: number; billable: number; exhausted: boolean };          // R4, puro

export async function loadServiceUsage(
  db: SupabaseClient, accountId: string, now?: Date
): Promise<Map<string, { used: number; billable: number; exhausted: boolean }>>;
// rpc('service_quota_usage', { p_account_id: accountId, p_since: monthStart }); lanza si { error }.

export async function isAiPausedByServiceCap(
  db: SupabaseClient,
  args: { accountId: string; conversationId: string; sealedConfigId: string | null; now?: Date }
): Promise<boolean>;
```

`isAiPausedByServiceCap` (R9–R13), en este orden y con salida temprana:

1. `accounts.select('service_cap_action').eq('id', accountId).maybeSingle()` → si no es
   `pause_ai`, `false` (el caso común cuesta una consulta y no toca `message_charges`).
2. `subscriptions.select('meta_billing').eq('account_id', accountId).maybeSingle()` →
   `metaBillingOf()` de `src/lib/whatsapp/payment-method.ts`; `managed` → `false`. (Cuando s10.3 se
   integre y `getEntitlements()` exponga `metaBilling`, puede leerse de ahí; no es requisito.)
3. Número: `sealedConfigId` si existe en `whatsapp_config` con ese `account_id`; si no,
   `resolveWhatsAppConfig(db, { accountId, conversationId })` (sin `withToken`). Error de resolución
   → `false`.
4. `loadServiceUsage` → `exhausted` de ese número.
5. Cualquier excepción en 1–4 → `console.warn('[service-cap] …', mensaje)` y `false` (R11, falla
   abierta).

Todas las consultas van con el cliente de rol de servicio que ya usa `auto-reply.ts`
(`src/lib/ai/admin-client.ts`) y filtran por `account_id` (o `id` de la cuenta). Fallar abierto es
deliberado: el humano eligió `pause_ai` para ahorrar, pero un error nuestro no debe dejar a sus
clientes sin respuesta; el coste es como mucho unas respuestas de más.

## Cambios en `src/lib/ai/auto-reply.ts`

- El `select` de `conversations` suma `whatsapp_config_id`.
- Tras `if (conv.ai_reply_count >= …) return;` y **antes** de `claimInboundAutoReply`:

  ```ts
  if (await isAiPausedByServiceCap(db, {
    accountId, conversationId, sealedConfigId: conv.whatsapp_config_id ?? null,
  })) {
    console.info(`[ai auto-reply] account ${accountId}: free service quota of this number is spent and the account chose pause_ai — not replying.`);
    return;
  }
  ```

  Antes de la reserva, por la misma razón que las compuertas de facturación del archivo: una
  respuesta que no vamos a mandar no debe quedarse la reserva del entrante (así una automatización
  aún puede contestar ese mensaje; los agentes lo ven en la bandeja). No se toca
  `ai_autoreply_disabled` (la pausa no es pegajosa: se va sola con el mes, R13) ni se manda el
  aviso de traspaso.
- La cabecera del archivo (lista de «Eligibility gates») gana la línea nueva.

## Ruta `src/app/api/whatsapp/service-cap/route.ts` (nuevo)

Route Handler de Next 16 (`node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`:
`GET` no se cachea por defecto y además lee cookies; `PATCH` nunca se cachea).

- `GET()`: `getCurrentAccount()` (cualquier miembro, como `GET /api/billing/status`).
  1. `subscriptions.meta_billing` con `ctx.supabase` + `.eq('account_id', ctx.accountId)` →
     `metaBillingOf`. `managed` → 200 `{ metaBilling: 'managed', action, freeTier, monthStart,
     resetsAt, numbers: [] }` sin RPC.
  2. `accounts.service_cap_action` con `ctx.supabase.eq('id', ctx.accountId)`.
  3. `whatsapp_config.select('id, label, display_phone_number, is_default, created_at')` con
     `ctx.supabase` + `.eq('account_id', ctx.accountId)`, orden por defecto primero (como
     `listWhatsAppConfigs`).
  4. `loadServiceUsage(supabaseAdmin(), ctx.accountId)` — **único** uso del rol de servicio, con el
     `account_id` de la sesión (CP3).
  5. Une 3 y 4 (`serviceCapState(map.get(id))`). Error en 1–4 → 500 `{ error: 'Failed to load the
     service quota' }` (R8).
- `PATCH(request)`: `requireRole('admin')`; JSON inválido o `action` fuera de
  `('warn','pause_ai')` → 400; `ctx.supabase.from('accounts').update({ service_cap_action
  }).eq('id', ctx.accountId).select('service_cap_action').maybeSingle()`; sin fila → 404; 200
  `{ action }`. Sin rol de servicio: lo protege `accounts_update` (017).
- Respuesta de error con `toErrorResponse` como el resto de rutas.
- Si `src/lib/security/service-role-audit.ts` exige registrar rutas con `supabaseAdmin()`, se
  registra con el motivo «conteo de cargos para miembros sin RLS de admin; filtra por la cuenta de
  la sesión».

## Cliente

- `src/hooks/use-service-cap.ts` **(nuevo)**: `useServiceCap()` → `ServiceCapStatus | null`, con
  las tres reglas de `src/hooks/use-billing-status.ts` (clave por `accountId`, fallo = `null`, TTL
  60 s) y `refresh()` para Ajustes tras el PATCH. Sin dependencia nueva.
- `src/components/inbox/service-cap-alert.tsx` **(nuevo)**: `ServiceCapAlert({ status })` puro +
  envoltorio que usa el hook. Montado en `src/app/(dashboard)/inbox/page.tsx` dentro de la columna
  flex, justo después de la franja `whatsappConnected === false` y con su mismo estilo ámbar
  (`border-amber-500/20 bg-amber-500/10`, icono `AlertTriangle` de `lucide-react`, ya usado en
  `members-tab.tsx`). No se monta en el shell: el aviso es de la bandeja (A3), no de todas las páginas.
- `src/components/settings/service-cap-settings.tsx` **(nuevo)**: `ServiceUsageLine({ number,
  freeTier })` para la tarjeta de número y `ServiceCapCard({ status, canEdit, onSaved })` con dos
  opciones (`RadioGroup` de `src/components/ui/radio-group.tsx`, ya existente; no se instala nada). En `src/components/settings/whatsapp-config.tsx`: `ServiceUsageLine` bajo
  `PaymentStatusBadge` en cada tarjeta (por `row.id`), y `ServiceCapCard` como `Card` nueva antes de
  la de «media» (`t('mediaTitle')`). Ambas ocultas si `metaBilling === 'managed'` o si el hook es
  `null`.
- Fechas desde el dato, nunca desde el reloj en render (regla de React 19 que sigue
  `payment-status-badge.tsx`): `new Date(resetsAt).toLocaleDateString(locale)` con `useLocale()` de
  `next-intl`.

## Claves i18n (es y en, mismas claves y placeholders)

- `Inbox.serviceCap.title` — «Cuota gratis de Meta agotada»
- `Inbox.serviceCap.numbers` — «{numbers}: se usaron los {freeTier} mensajes de servicio gratis de
  este mes. Desde ahora Meta cobra cada respuesta de este número.»
- `Inbox.serviceCap.paused` — «La IA no responde sola desde este número hasta el {date}. El equipo
  puede seguir escribiendo.»
- `Inbox.serviceCap.warnOnly` — «La IA sigue respondiendo. Puedes pausarla en Ajustes → WhatsApp.»
- `Settings.whatsapp.serviceCap.usage` — «Mensajes de servicio este mes: {used} de {freeTier}
  gratis»
- `Settings.whatsapp.serviceCap.exhausted` — «Cuota gratis agotada»
- `Settings.whatsapp.serviceCap.cardTitle` / `cardDesc` — «Cuota gratis de Meta» / «Meta regala
  {freeTier} mensajes de servicio por número cada mes. Elige qué hace la IA cuando se acaban.»
- `Settings.whatsapp.serviceCap.warn` / `warnDesc`, `pauseAi` / `pauseAiDesc`
- `Settings.whatsapp.serviceCap.saveFailed`

Los textos exactos en `en` (fuente de verdad, CP6) los redacta el implementer con el mismo
significado. Los números con `{used, number}` ICU.

## Manejo de errores

| Dónde | Error | Resultado |
|---|---|---|
| `isAiPausedByServiceCap` | lectura o RPC | `console.warn`, `false` (la IA responde) |
| `GET` | cualquier lectura | 500 genérico; el hook da `null`; no hay aviso |
| `PATCH` | cuerpo inválido / rol / sin fila | 400 / 401-403 / 404, sin escritura |
| UI Ajustes | PATCH falla | revierte la selección, `toast.error(t('serviceCap.saveFailed'))` |

## Alternativas descartadas

- **Columna en `ai_configs`**: `loadAiConfig` ya la leería sin consulta extra, pero `warn` no tiene
  nada que ver con la IA y una cuenta sin IA configurada (sin fila en `ai_configs`) no podría guardar
  el ajuste. Se queda en `accounts`, como pidió el líder.
- **Ajuste por número**: la nota de la feature dice «por cuenta»; si hace falta por número, es una
  columna en `whatsapp_config` más adelante.
- **Contador materializado** (incrementar en el webhook al llegar `delivered`): añade escritura al
  camino del webhook (CP11) y un segundo origen de verdad junto a `message_charges`. La consulta
  agregada cuesta poco con el índice de la 075 y solo corre con `pause_ai` o al abrir la bandeja.
- **Meter el aviso en `GET /api/billing/status`**: lo pide cada página del CRM cada 30 s; el conteo
  solo hace falta en la bandeja y en Ajustes.
- **Fallar cerrado** (pausar si no se puede contar): ver §Lógica.
