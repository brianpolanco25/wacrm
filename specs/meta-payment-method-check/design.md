# p11.1 `meta-payment-method-check` — diseño

Leído contra `feat/superadmin` @ 4ad530f. Rutas, funciones y migraciones citadas existen en esa
rama salvo las marcadas **(nuevo)**.

## Rama recomendada

**`feat/precios-meta-directo` desde `feat/superadmin` @ 4ad530f, ya**, con `meta_billing` tratada
como ausente (todas las cuentas `direct`) hasta que s10.2 se integre. Motivos:

- Es urgente (01-10) y s10.2 (`fg/rate-card`) está `in_progress`, sin integrar en
  `feat/facturacion-gestionada`. Esperarla no aporta nada que esta feature necesite: solo lee
  `subscriptions.meta_billing`, y `metaBillingOf()` (abajo) funciona con y sin la columna.
- Misma base que la fase 10 (`feat/superadmin` @ 4ad530f), así que integrar luego en
  `feat/facturacion-gestionada` es un merge normal. Conflictos previsibles y pequeños: s10.6 toca
  `whatsapp-config.tsx` y la ficha del superadmin; s10.4 toca `BillingStatusAlert` (aquí no se
  toca: el banner es un componente aparte).
- Desde `main` no: `main` aún tiene `messages/ko.json` y no tiene la fase 9 (CP6 cambiaría).

Despliegue: no sale a producción sin la fase 9 en `main`. Si la fase 9 no llega a tiempo, el
camino es cherry-pick sobre `main` añadiendo las claves también en `ko.json`; es decisión del
humano. **Orden de migraciones en remoto**: el remoto está en la 066 (memoria del proyecto). Si 079
se aplica antes que 075–078, el `supabase db push` siguiente encontrará migraciones locales
anteriores a la última remota y exigirá `--include-all`. Lo decide y ejecuta el humano.

## Supuestos sin verificar (Meta) — los debe confirmar el humano

Ninguno de estos campos aparece en `progress/meta_embedded-signup-verificacion.md`,
`progress/meta_app-review.md`, `src/lib/whatsapp/*`, `054_embedded_signup.sql`,
`067_token_renewal.sql` ni `docs/`. No se consultó la web (regla del humano).

| Id | Supuesto | Endpoint / campo | Estado |
|---|---|---|---|
| S-M1 | El nodo WABA expone `primary_funding_id` (id de la fuente de pago / línea de crédito) y se puede leer con el token de Embedded Signup (`whatsapp_business_management`). | `GET /v21.0/{waba_id}?fields=id,primary_funding_id` | **sin verificar** |
| S-M2 | Si el WABA no tiene método de pago, la respuesta es 2xx con `id` y **sin** `primary_funding_id`. Riesgo: Graph omite campos que el token no puede ver, y eso sería un falso «sin método de pago». Por eso R13 (interruptor) y el guion manual paso 1. | mismo | **sin verificar** — el riesgo principal |
| S-M3 | `payment_configurations` **no** sirve aquí: por lo que se recuerda, es la arista de WhatsApp Payments (cobros a clientes finales en India/Brasil), no la facturación de Meta. No se usa. | `GET /{waba_id}/payment_configurations` | **sin verificar** |
| S-M4 | URL del Billing Hub: `https://business.facebook.com/billing_hub/payment_settings/`. Sin `asset_id`/`business_id` en la query para no depender de parámetros no verificados. | constante `META_BILLING_HUB_URL` | **sin verificar** |
| S-M5 | Un token de usuario de sistema (configuración manual) con `whatsapp_business_management` lee el mismo campo; sin ese permiso Meta responde error con `code` 10/200 → `unknown`. | mismo | **sin verificar** |
| S-M6 | Desde el 2026-10-01 Meta no entrega mensajes de un WABA sin método de pago. Dato del líder; condiciona el texto del banner. | — | **sin verificar** en el repo |
| S-M7 | Una línea de crédito compartida por un partner (WABA en el portafolio de Cabbity, cuentas `managed`) aparece como `primary_funding_id`. Solo afecta a la ficha del superadmin: el cliente `managed` no ve banner. | mismo | **sin verificar** |
| S-M8 | `account_review_status` del WABA es la revisión de la cuenta, no el pago: no se usa. | — | **sin verificar** |

Mientras no se confirmen S-M1/S-M2, la interpretación es conservadora: solo una respuesta 2xx que
trae el `id` pedido y nada en `primary_funding_id` cuenta como `missing`; todo lo demás es
`unknown`, que no pinta banner rojo.

## Migración `supabase/migrations/079_meta_payment_status.sql` (nuevo)

Siguiente libre tras 074 en esta rama; 075–078 están reservadas a la fase 10. Idempotente.

```sql
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS meta_payment_status TEXT;
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS meta_payment_checked_at TIMESTAMPTZ;
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS meta_payment_error TEXT;

-- CHECK en un DO, como whatsapp_config_provisioned_via_check en la 054.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.whatsapp_config'::regclass
                   AND conname = 'whatsapp_config_meta_payment_status_check') THEN
    ALTER TABLE whatsapp_config ADD CONSTRAINT whatsapp_config_meta_payment_status_check
      CHECK (meta_payment_status IS NULL OR meta_payment_status IN ('ok','missing','unknown'));
  END IF;
END $$;

-- El barrido ordena por esto (NULL primero) y filtra connected.
CREATE INDEX IF NOT EXISTS whatsapp_config_meta_payment_checked_idx
  ON whatsapp_config (meta_payment_checked_at NULLS FIRST)
  WHERE status = 'connected' AND waba_id IS NOT NULL;

-- R2/R3: el inquilino no escribe el estado; cambiar WABA o token lo invalida.
CREATE OR REPLACE FUNCTION whatsapp_config_guard_meta_payment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.meta_payment_status := NULL; NEW.meta_payment_checked_at := NULL; NEW.meta_payment_error := NULL;
    ELSIF NEW.waba_id IS DISTINCT FROM OLD.waba_id OR NEW.access_token IS DISTINCT FROM OLD.access_token THEN
      NEW.meta_payment_status := NULL; NEW.meta_payment_checked_at := NULL; NEW.meta_payment_error := NULL;
    ELSE
      NEW.meta_payment_status := OLD.meta_payment_status;
      NEW.meta_payment_checked_at := OLD.meta_payment_checked_at;
      NEW.meta_payment_error := OLD.meta_payment_error;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS whatsapp_config_guard_meta_payment ON whatsapp_config;
CREATE TRIGGER whatsapp_config_guard_meta_payment
  BEFORE INSERT OR UPDATE ON whatsapp_config
  FOR EACH ROW EXECUTE FUNCTION whatsapp_config_guard_meta_payment();
-- + COMMENT ON COLUMN para las tres columnas.
```

- `current_user = 'authenticated'` como discriminador: mismo criterio que
  `034_fix_profiles_update_rls.sql` (PostgREST cambia de rol por petición; el rol de servicio entra
  como `service_role`, las migraciones como `postgres`). Sin `auth.role()`, que depende del
  esquema de GoTrue y no está garantizado en la imagen de `replay-migrations.sh`.
- RLS: las políticas de la 017 (`whatsapp_config_select` para miembros, `update` para `admin`)
  siguen valiendo; el disparador es lo que impide que un admin se marque `ok`. Sin cambios de RLS.
- Sin `ON DELETE CASCADE` nuevo. Ningún estado nuevo en `status`.
- `supabase/ci/verify-schema.sql`: bloque `-- /079 --` dentro del único `DO` con asserts de las
  tres columnas, la restricción, el índice y el disparador.
- `progress/checks_meta-payment-method-check.sql`: guiones de R1 (CHECK), R2 y R3 con
  `SET ROLE authenticated` / `service_role` y `set_config('request.jwt.claims', …)`.

## Lógica: `src/lib/whatsapp/payment-method.ts` (nuevo)

```ts
export type MetaPaymentStatus = 'ok' | 'missing' | 'unknown';
export type MetaBilling = 'direct' | 'managed';

/** S-M4, sin verificar. Único sitio con la URL. */
export const META_BILLING_HUB_URL = 'https://business.facebook.com/billing_hub/payment_settings/';
export const PAYMENT_CHECK_TIMEOUT_MS = 5_000;
export const PAYMENT_SWEEP_LIMIT = 25;
export const PAYMENT_RECHECK_MS: Record<MetaPaymentStatus, number> =
  { missing: 60 * 60_000, unknown: 6 * 60 * 60_000, ok: 24 * 60 * 60_000 };

export interface PaymentCheckResult { status: MetaPaymentStatus; error: string | null }

export function isPaymentCheckDisabled(): boolean;          // META_PAYMENT_CHECK_DISABLED === '1'

/** Puro. R4. `body` es el JSON 2xx de Meta. */
export function classifyFundingResponse(wabaId: string, body: unknown): MetaPaymentStatus;

/** Nunca lanza. R4–R6. */
export async function fetchWabaPaymentStatus(args: {
  wabaId: string; accessToken: string;
}): Promise<PaymentCheckResult>;

/** Escribe con rol de servicio, `.eq('id', configId).eq('account_id', accountId)`. Nunca lanza. */
export async function recordPaymentStatus(
  db: SupabaseClient, scope: { accountId: string; configId: string },
  result: PaymentCheckResult, now?: Date,
): Promise<void>;

/** Lee la fila (id + account_id), descifra el token salvo que venga `accessToken`, comprueba y guarda.
 *  Devuelve null si la fila no existe en esa cuenta (R12) o no tiene waba_id. */
export async function checkAndRecordPaymentStatus(
  db: SupabaseClient, scope: { accountId: string; configId: string },
  opts?: { accessToken?: string; now?: Date },
): Promise<(PaymentCheckResult & { checkedAt: string }) | null>;

/** R9/R10. Barrido entre cuentas para el cron; nunca lanza. */
export async function sweepPaymentStatus(
  db: SupabaseClient, opts?: { now?: () => Date; limit?: number; check?: typeof fetchWabaPaymentStatus },
): Promise<{ enabled: boolean; scanned: number; checked: number; ok: number; missing: number; unknown: number }>;

/** R18. `row` es una fila de subscriptions leída con select('*'); sin columna → 'direct'. */
export function metaBillingOf(row: Record<string, unknown> | null): MetaBilling;

/** R15–R18, R23. Puro. */
export function metaPaymentBanner(
  rows: Array<{ status: string; provisioned_via: string | null; meta_payment_status: string | null }>,
  ctx: { metaBilling: MetaBilling; platformMode: boolean; disabled: boolean },
): { banner: 'missing' | 'unknown' | null; missingNumbers: number };
```

- La llamada HTTP vive en `src/lib/whatsapp/meta-api.ts` como helper nuevo, con el patrón del
  archivo (objeto de argumentos, `throwMetaError` → `MetaApiError`):
  `export async function getWabaFundingInfo(args: { wabaId: string; accessToken: string; signal?: AbortSignal }): Promise<{ id?: string; primary_funding_id?: string | null }>`
  sobre `${META_API_BASE}/${wabaId}?fields=id,primary_funding_id` (`META_API_VERSION` = `v21.0`,
  el mismo del resto de helpers). `fetchWabaPaymentStatus` le pasa
  `AbortSignal.timeout(PAYMENT_CHECK_TIMEOUT_MS)` y convierte cualquier excepción en `unknown`.
- Errores: se guarda `err.message.slice(0, 500)`; nunca el objeto entero (mismo criterio que
  `token-renewal.ts` y la cabecera de `embedded-signup/route.ts`). `ok`/`missing` dejan
  `meta_payment_error = NULL`.
- Barrido: una consulta `select('id, account_id, waba_id, access_token, meta_payment_status,
  meta_payment_checked_at').eq('status','connected').not('waba_id','is',null)
  .or('meta_payment_checked_at.is.null,meta_payment_checked_at.lt.<now-1h>')
  .order('meta_payment_checked_at', { ascending: true, nullsFirst: true }).limit(limit)`; luego
  filtra en JS por `PAYMENT_RECHECK_MS[status]`. Cada escritura va con `id` **y** `account_id`
  de la fila leída (CP3: la escritura no puede caer en otra cuenta aunque el id se cruce). Corre
  en ambos modos (plataforma y self-hosted): a diferencia de `renewExpiringTokens`, no necesita el
  secreto de la app, solo el token de la fila. Con el interruptor puesto devuelve
  `{ enabled: false, … }` sin consultar.
- Costo: ≤ 25 llamadas a Meta por minuto en el peor caso, y en régimen ~N/1 440 por minuto con
  N números `ok`. Un número `missing` se vuelve a mirar cada hora, para que el banner se apague
  solo tras añadir la tarjeta aunque nadie pulse el botón.

## Puntos de enganche

| Archivo | Cambio |
|---|---|
| `src/app/api/whatsapp/embedded-signup/route.ts` | Tras el paso 9 (upsert con `saved[0].id`), paso 10: `checkAndRecordPaymentStatus(supabaseAdmin(), { accountId, configId: saved[0].id }, { accessToken })` dentro de `try` propio; se añade `payment_status` al JSON. El `supabaseAdmin()` local ya existe en el archivo. No va antes del upsert: el disparador de R2 anularía el valor si viajara en el upsert del cliente del inquilino, y así el alta no espera a Meta para guardar. |
| `src/app/api/whatsapp/config/route.ts` | `POST`: tras guardar (rama update o insert), mismo paso 10 con el token en claro del formulario. `publicNumber()` gana `meta_payment_status`, `meta_payment_checked_at` (allow-list; `meta_payment_error` también, es mensaje de Meta sin secretos). |
| `src/app/api/whatsapp/config/payment-status/route.ts` (nuevo) | `POST` (R11/R12): `requireRole('admin')`, `checkRateLimit('meta-payment-check:'+userId, RATE_LIMITS.metaPaymentCheck)`, body `{ config_id }` (400 si falta), `checkAndRecordPaymentStatus(admin, { accountId, configId })` → `null` = 404 `{ error: 'not_found' }`. Con el interruptor: 409 `{ error: 'payment_check_disabled' }`. Route Handler de Next 16 con `POST(request: Request)` — sin caché por defecto para POST (`node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` §Caching). |
| `src/lib/rate-limit.ts` | `RATE_LIMITS.metaPaymentCheck: { limit: 6, windowMs: 60_000 }`. |
| `src/app/api/webhooks/cron/route.ts` | Tras `renewExpiringTokens`: `const payments = await sweepPaymentStatus(admin);` y `payments` como bloque aditivo del JSON (mismo patrón que `tokens`). Comentario de cabecera: punto 6. |
| `src/app/api/billing/status/route.ts` | El `select` de `subscriptions` pasa a `'*'` (la respuesta sigue siendo explícita; no se expone ninguna columna nueva) para leer `meta_billing` si existe vía `metaBillingOf`. Segunda consulta: `ctx.supabase.from('whatsapp_config').select('status, provisioned_via, meta_payment_status').eq('account_id', ctx.accountId)` (RLS + filtro explícito). Campo nuevo `metaPayment: metaPaymentBanner(rows, { metaBilling, platformMode: getPlatformSignupConfig() !== null, disabled: isPaymentCheckDisabled() })`. Si la lectura de `whatsapp_config` falla: `metaPayment: { banner: null, missingNumbers: 0 }` y log, nunca 500 (el banner de cobro de Cabbity no puede caer por esto). Cuando s10.3 exponga `entitlements.metaBilling`, se sustituye `metaBillingOf` por ese campo (nota en el código). |
| `src/hooks/use-billing-status.ts` | `BillingStatus` gana `metaPayment?: { banner: 'missing' | 'unknown' | null; missingNumbers: number }`. Sin request nueva (regla de la cabecera del hook). |
| `src/components/billing/meta-payment-alert.tsx` (nuevo) | `'use client'`, `MetaPaymentAlert()`: lee `useBillingStatus()`; `null` si no hay estado o `banner === null`. `missing` → `Alert variant="destructive"` con `CreditCard`, `t('metaPayment.missingTitle')`, `t('metaPayment.missingBody', { count })`, `AlertAction` con `<a href={META_BILLING_HUB_URL} target="_blank" rel="noopener noreferrer">` estilizado con `Button asChild`/clases de botón outline. `unknown` → `Alert` por defecto con `t('metaPayment.unknownTitle'/'unknownBody')` y el mismo enlace. Sin botón de cerrar (persistente). Sin `Date.now()` en render. |
| `src/app/(dashboard)/dashboard-shell.tsx` | `<MetaPaymentAlert />` justo después de `<BillingStatusAlert />`, con comentario. |
| `src/components/settings/whatsapp-config.tsx` | En la tarjeta de número (bloque `numbers.map`, junto a `last_registration_error`): `PaymentStatusBadge` (nuevo, `src/components/settings/payment-status-badge.tsx`, para poder testear sin montar las 1 300 líneas) y botón «Comprobar de nuevo» con `disabled={!canEditSettings || busy}` que llama a la ruta nueva y refresca la lista. Oculto si la cuenta es `managed` (se lee `metaPayment` de `useBillingStatus`, que ya distingue: añadir `metaBilling: 'direct'|'managed'` al cuerpo de `/api/billing/status` para esto). |
| `src/lib/platform/accounts.ts` | `AccountNumber` gana `metaPaymentStatus: MetaPaymentStatus | null`, `metaPaymentCheckedAt: string | null`, `metaPaymentError: string | null`; `loadNumbers` añade las tres columnas al `select` (sigue `.eq('account_id', accountId)` y sin `access_token`). |
| `src/components/platform/platform-account-detail.tsx` | `WhatsAppNumber` gana los tres campos; `Badge` junto al de `number.status` (`destructive` para `missing`, `outline` para `ok`, `secondary` para `unknown`/NULL), fecha con el formateador existente y el error en texto pequeño si `unknown`. |
| `docs/docker.md` | `META_PAYMENT_CHECK_DISABLED` en la tabla de variables (opcional; `1` apaga la comprobación) y nota de que el barrido va en `/api/webhooks/cron`. |
| `CHANGELOG.md` | Entrada en Unreleased. |

No se tocan: `src/app/api/whatsapp/webhook/route.ts` (CP11, R22), `src/lib/billing/enforce.ts`,
`src/lib/billing/entitlements.ts`, `src/components/billing/billing-status-alert.tsx`, las rutas de
envío (R23).

## Claves i18n (es y en, mismos placeholders)

- `Billing.metaPayment.missingTitle` — es: «Tu cuenta de WhatsApp no tiene método de pago en Meta»
- `Billing.metaPayment.missingBody` — es: «{count, plural, one {Un número} other {# números}} no
  {count, plural, one {tiene} other {tienen}} método de pago en Meta. Desde el 1 de octubre de 2026
  Meta no entrega los mensajes de esos números hasta que añadas una tarjeta en el Billing Hub de
  Meta. Los mensajes que te escriben siguen llegando.»
- `Billing.metaPayment.unknownTitle` — es: «No pudimos comprobar tu método de pago en Meta»
- `Billing.metaPayment.unknownBody` — es: «Revisa en el Billing Hub de Meta que tu cuenta de WhatsApp
  tenga una tarjeta: sin ella, desde el 1 de octubre de 2026 Meta no entrega tus mensajes.»
- `Billing.metaPayment.openBillingHub` — es: «Abrir Billing Hub de Meta»
- `Settings.whatsapp.paymentOk` / `paymentMissing` / `paymentUnknown` / `paymentPending` /
  `paymentCheckedAt` (`{date}`) / `paymentRecheck` / `paymentRecheckFailed`
- `Platform.paymentStatus` / `paymentOk` / `paymentMissing` / `paymentUnknown` / `paymentPending` /
  `paymentCheckedAt` (`{date}`)

Los textos finales de `missingBody` dependen de S-M6; el humano los aprueba en la revisión.

## Manejo de errores (resumen)

| Situación | Resultado |
|---|---|
| Meta 2xx con `primary_funding_id` | `ok`, error NULL |
| Meta 2xx con el `id` pedido y sin `primary_funding_id` | `missing`, error NULL |
| Meta error (permiso, token caducado, 5xx), red, timeout, JSON raro | `unknown`, error = mensaje |
| Fila sin `waba_id` | no se comprueba; queda NULL; sin banner |
| Falla la escritura del resultado | log, sin reintento inmediato; el barrido lo recoge (NULL o vencido) |
| Falla la lectura en `/api/billing/status` | `metaPayment.banner = null`, sin 500 |
| `META_PAYMENT_CHECK_DISABLED=1` | ninguna llamada; banner null; botón 409 |

## Tests (todos con `fetch` mockeado, sin red)

- `src/lib/whatsapp/payment-method.test.ts` (nuevo): clasificación (R4), permisos (R5), secretos
  (R6), barrido con reloj inyectado y límite (R9), fallo de una fila (R10), interruptor (R13),
  `metaBillingOf` (R18), `metaPaymentBanner` en todas las combinaciones (R15–R18, R23), escritura
  con `id` + `account_id` (CP3).
- `src/lib/whatsapp/meta-api.test.ts`: URL, método y cabecera de `getWabaFundingInfo`; error →
  `MetaApiError` con `code`.
- `src/app/api/whatsapp/embedded-signup/route.test.ts`: R7.
- `src/app/api/whatsapp/config/route.test.ts`: R8 y allow-list de `publicNumber` (R20).
- `src/app/api/whatsapp/config/payment-status/route.test.ts` (nuevo): R11, R12 (fuga A↔B), R13.
- `src/app/api/webhooks/cron/route.test.ts`: bloque `payments` (R9).
- `src/app/api/billing/status/route.test.ts`: R14 (sin `fetch`), R18, R19 (fuga A↔B), R13.
- `src/components/billing/meta-payment-alert.test.tsx` (nuevo): R15, R16, R17, R24.
- `src/components/settings/payment-status-badge.test.tsx` (nuevo): R20.
- `src/lib/platform/accounts.test.ts` y render de la ficha: R21.
- `src/app/api/whatsapp/webhook/route.test.ts`: entrante con número `missing` (R22).
- Si `src/lib/security/tenant-isolation.test.ts` cubre las rutas tocadas, las consultas nuevas
  pasan el `service-role-audit` sin waiver salvo el barrido (`whatsapp_config` select del cron,
  entre cuentas por diseño, waiver con motivo escrito).

## Alternativas descartadas

1. **Llamar a Meta al cargar Ajustes o en cada render del banner.** Una llamada por página y
   miembro, con la latencia de Meta en el camino del render y sin resultado para los agentes que
   nunca abren Ajustes. Se guarda en la fila y se refresca con barrido + botón.
2. **Guardar el estado en el upsert del alta con el cliente del inquilino.** Más simple, pero
   cualquier admin podría marcarse `ok` desde el navegador (la política `whatsapp_config_update`
   de la 017 se lo permite) y la ficha del superadmin mentiría. Disparador + escritura con rol de
   servicio.
3. **Ruta de cron propia.** Otra entrada en el programador que se puede olvidar; mismo argumento
   que llevó `renewExpiringTokens` a `/api/webhooks/cron`.
4. **Detectar la falta de pago por el error de envío del webhook de estados** (código de Meta de
   «problema de pago», `131042` según memoria, **sin verificar**). Es la señal más fiable porque es
   la que Meta da de verdad, pero obliga a tocar `webhook/route.ts`, que s10.1 está cambiando ahora
   y que CP11 protege; y solo avisa después de que un mensaje ya falló. Se propone como
   seguimiento (p11.x) una vez S-M1/S-M2 estén verificados.
5. **Bloquear envíos de números `missing`.** Meta ya los rechaza; bloquear aquí con un dato no
   verificado podría cortar números que sí pagan (S-M2). Solo aviso.
6. **Variante dentro de `BillingStatusAlert`.** Ese componente es la escalera de cobro de Cabbity y
   s10.4 le añade `statement_due`; mezclar el pago a Meta lo convierte en un punto de conflicto
   entre ramas y confunde dos deudas distintas. Componente aparte que comparte el hook.
