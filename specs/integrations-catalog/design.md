# n13.1 `integrations-catalog` — diseño

Lee antes `requirements.md` (R1–R35, decisiones D1–D6). Este documento implementa las
recomendaciones de D1–D6; si el humano elige otra alternativa, cambian las secciones señaladas.

## 1. Modelo: declarativo (D1)

Una **integración** es una fila con un origen HTTPS fijado por el operador y un esquema de
autenticación; sus **operaciones** son filas que describen una petición (método, ruta con
marcadores, parámetros tipados, salidas). Un único ejecutor (`src/lib/integrations/execute.ts`)
convierte «operación + parámetros + credencial de la cuenta» en una petición HTTP.

Por qué, frente a conectores codificados:

- **Health no tiene aún las rutas.** Con datos, el operador da de alta «crear cita» el día que Health
  la publique, sin PR ni despliegue del CRM.
- **El mismo dato sirve a los tres puntos de uso.** `description` + `params` es casi literalmente
  el esquema de herramienta de OpenAI/Anthropic/Gemini (n13.3); el nodo de flow (n13.2) y el paso de
  automatización (n13.4) consumen la misma firma.
- **Superficie de seguridad única.** SSRF, timeout, tamaño y registro viven en un núcleo; un
  conector codificado por integración repetiría (o olvidaría) cada guarda.

Lo que se pierde: OAuth2, paginación, transformaciones de respuesta y cuerpos anidados. Son deuda
(requirements, «Fuera de alcance»); si una aplicación nuestra los necesita, se añade un `kind`
nuevo al ejecutor, no un conector por integración.

**Alternativa descartada** — conectores en código (`src/lib/integrations/connectors/health.ts`):
más expresivo, pero acopla el calendario del CRM al de cada app y obliga a desplegar para corregir
una ruta. **Importar OpenAPI**: deuda; el modelo está pensado para que un importador futuro solo
tenga que producir filas de `integration_operations`.

## 2. Migración `supabase/migrations/091_integrations.sql`

Número: la última en `main` es `089_whatsapp_coexistence_batches.sql`; la **090** queda reservada
para la fase 12 (`feat/invitacion-directa`, en paralelo). Anótalo en la cabecera: «090 reservada
por la fase 12; si al fusionar no existe, el hueco es intencional (ya hay 081 y 085)».

Idempotente (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, CHECK añadidos en bloques
`DO` que comprueban `pg_constraint`, `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`). `SET LOCAL
lock_timeout = '5s'` al principio, como 080. La cabecera lleva, en su propia línea, el marcador que
lee `plan-catalog.test.ts` (§7):

```
-- Claves de `features` añadidas: integrations.
```

```sql
CREATE TABLE IF NOT EXISTS integrations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text NOT NULL UNIQUE,
  name             text NOT NULL,
  description      text,
  logo_url         text,
  base_url         text NOT NULL,
  auth_scheme      text NOT NULL,
  auth_header_name text,
  credential_help  text,
  test_path        text NOT NULL,
  is_active        boolean NOT NULL DEFAULT false,   -- nace en borrador
  sort_order       integer NOT NULL DEFAULT 0,
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- CHECKs (en DO): integrations_slug_format  slug ~ '^[a-z][a-z0-9-]{1,39}$'
--                 integrations_base_url_https base_url LIKE 'https://%'
--                 integrations_auth_scheme   auth_scheme IN ('bearer','header')
--                 integrations_header_name   auth_scheme <> 'header' OR auth_header_name IS NOT NULL
--                 integrations_test_path     test_path LIKE '/%'

CREATE TABLE IF NOT EXISTS integration_operations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id       uuid NOT NULL REFERENCES integrations(id) ON DELETE RESTRICT,
  key                  text NOT NULL,
  name                 text NOT NULL,
  description          text NOT NULL,
  method               text NOT NULL,
  path                 text NOT NULL,
  params               jsonb NOT NULL DEFAULT '[]'::jsonb,
  outputs              jsonb NOT NULL DEFAULT '[]'::jsonb,
  response_description text,
  is_active            boolean NOT NULL DEFAULT true,
  sort_order           integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (integration_id, key)
);
-- CHECKs: key ~ '^[a-z][a-z0-9_]{1,63}$'; method IN ('GET','POST','PUT','PATCH','DELETE');
--         path LIKE '/%'; jsonb_typeof(params) = 'array'; jsonb_typeof(outputs) = 'array'

CREATE TABLE IF NOT EXISTS account_integrations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  integration_id   uuid NOT NULL REFERENCES integrations(id) ON DELETE RESTRICT,
  is_enabled       boolean NOT NULL DEFAULT false,
  credential       text,            -- encrypt() de src/lib/whatsapp/encryption.ts; NULL al desactivar
  credential_last4 text,
  enabled_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  enabled_at       timestamptz,
  last_tested_at   timestamptz,
  last_test_status text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, integration_id)
);
-- CHECKs: account_integrations_enabled_has_credential  NOT is_enabled OR credential IS NOT NULL
--         account_integrations_test_status  last_test_status IS NULL OR
--                                           last_test_status IN ('ok','auth_failed','unreachable','error')

CREATE TABLE IF NOT EXISTS integration_calls (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  integration_id  uuid NOT NULL REFERENCES integrations(id) ON DELETE RESTRICT,
  operation_key   text,                         -- NULL = prueba de conexión
  source          text NOT NULL,
  outcome         text NOT NULL,
  status_code     integer,
  latency_ms      integer NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- CHECKs: source IN ('test','flow','ai','automation')   -- los tres últimos los usan n13.2–n13.4
--         outcome IN ('ok','http_error','timeout','too_large','unreachable','blocked',
--                     'rate_limited','invalid_params','not_enabled','error')
CREATE INDEX IF NOT EXISTS integration_calls_account_created_idx
  ON integration_calls (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS account_integrations_integration_idx
  ON account_integrations (integration_id) WHERE is_enabled;

-- updated_at: update_updated_at_column() de 001, en integrations, integration_operations y
-- account_integrations.

-- RLS y privilegios: las cuatro solo para el rol de servicio (patrón de 089).
ALTER TABLE <cada una> ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON <cada una> FROM anon, authenticated;
GRANT ALL ON <cada una> TO service_role;
COMMENT ON TABLE … / COMMENT ON COLUMN account_integrations.credential IS 'encrypt(); nunca en claro';
```

Notas:

- **Sin políticas.** El navegador nunca toca estas tablas: todo pasa por `/api/platform/integrations`
  y `/api/account/integrations`. Así ninguna tabla entra en el reparto de 057/072
  (`can_read_account` / `can_write_account`) ni en `SUPPORT_WRITABLE_TABLES` /
  `SUPPORT_REFUSED_TABLES` de `src/lib/auth/support-scope.ts`, y las aserciones de
  `verify-schema.sql` que exigen esos predicados en toda política siguen pasando.
- `ON DELETE CASCADE` desde `accounts` es la convención del repo para filas de la propia cuenta
  (028, 078, 083, 089): solo se dispara si se borra la empresa entera. Hacia `integrations`,
  `RESTRICT`, y no hay ruta de borrado (R10).
- `integration_calls` no tiene columna de error en texto: el `outcome` cerrado y el `status_code`
  bastan, y no hay texto remoto que pueda filtrar datos de pacientes (Health es una app médica).
- **Sin `INSERT` de datos.** Ni integraciones sembradas ni `integrations` añadida a ningún plan (D2).

**`supabase/ci/verify-schema.sql`**, bloque `-- 091`: las cuatro tablas existen; `relrowsecurity`
en las cuatro; ninguna fila de `pg_policies` para ellas; `has_table_privilege('authenticated', …,
'SELECT')` falso en las cuatro; `account_integrations_enabled_has_credential` existe; las FK a
`integrations` con `confdeltype = 'r'`.

**`progress/checks_integrations-catalog.sql`** (checkout principal,
`/mnt/nvme-big/Dev/apps/cabbity/wacrm/progress/`): con `KEEP=1 scripts/replay-migrations.sh`,
insertar una integración, una operación y una activación sintéticas y comprobar: cada CHECK de §2
rechaza su caso; `SET ROLE authenticated` → `permission denied` en `SELECT` de cada tabla;
`DELETE FROM integrations` con activación → `foreign_key_violation`; `select count(*) from plans
where features ? 'integrations'` = 0.

## 3. Archivos

Nuevos (todos con test co-ubicado salvo las páginas):

| Archivo | Qué |
|---|---|
| `src/lib/integrations/types.ts` | Tipos de §4–§6 y constantes `INTEGRATION_TIMEOUT_MS = 10_000`, `INTEGRATION_MAX_RESPONSE_BYTES = 262_144`, `INTEGRATION_USER_AGENT`. |
| `src/lib/integrations/catalog-validate.ts` | Validación pura de integración y operación (R5–R9). Devuelve `{ ok: true, value } \| { ok: false, error, field }` como `validatePlanInput` (`src/lib/billing/plan-catalog.ts`). |
| `src/lib/integrations/request.ts` | Puro: `validateCallParams`, `buildIntegrationRequest` (R21, R27, R29). |
| `src/lib/integrations/http.ts` | Núcleo de red: `performIntegrationRequest` (R22–R26). |
| `src/lib/integrations/execute.ts` | `executeIntegrationOperation`, `testIntegrationConnection`, registro en `integration_calls` (R18, R20, R27, R28, R30). Único lugar con `decrypt`. |
| `src/lib/integrations/account.ts` | Lecturas/escrituras de `account_integrations` por cuenta, rol de servicio, siempre `.eq('account_id', accountId)` (R14, R15, R17). |
| `src/lib/platform/integrations.ts` | Escrituras del catálogo (patrón `src/lib/platform/plans.ts`): `createIntegration`, `updateIntegration`, `createOperation`, `updateOperation`, `loadPlatformIntegrations`, `loadPlatformIntegration`, `IntegrationExistsError`, `OperationExistsError`. |
| `src/app/api/platform/integrations/route.ts` | `GET` lista + recuentos, `POST` crea (R4, R5, R11). |
| `src/app/api/platform/integrations/[id]/route.ts` | `GET` detalle con operaciones, `PATCH` (R6, R10). Sin `DELETE`. |
| `src/app/api/platform/integrations/[id]/operations/route.ts` | `POST` operación (R7). |
| `src/app/api/platform/integrations/[id]/operations/[opId]/route.ts` | `PATCH` operación (R7, R10). Sin `DELETE`. |
| `src/app/api/account/integrations/route.ts` | `GET` catálogo + estado de la cuenta (R14). |
| `src/app/api/account/integrations/[integrationId]/route.ts` | `PUT` activar / cambiar credencial, `DELETE` desactivar (R13, R15–R17). |
| `src/app/api/account/integrations/[integrationId]/test/route.ts` | `POST` probar (R13, R18). |
| `src/app/(platform)/platform/integrations/page.tsx` | `guardPlatformPage()` + `<PlatformIntegrations />`. |
| `src/app/(platform)/platform/integrations/[id]/page.tsx` | `guardPlatformPage()` + `<PlatformIntegrationEditor id={id} />`; `params: Promise<{ id: string }>`. |
| `src/components/platform/platform-integrations.tsx` | Lista (R11). |
| `src/components/platform/platform-integration-editor.tsx` | Formulario + operaciones con editor de filas de `params`/`outputs` (R11). |
| `src/components/platform/integration-form.ts` | Estado puro del formulario → cuerpo de POST/PATCH (patrón `plan-form.ts`). |
| `src/components/settings/integrations-settings.tsx` | Pestaña del cliente (R19). |
| `src/components/settings/integration-card-state.ts` | Puro: estado de tarjeta + rol → acciones visibles; secuencia activar → probar. |

Modificados:

| Archivo | Cambio |
|---|---|
| `src/lib/billing/plan-catalog.ts` | `'integrations'` al final de `PLAN_FEATURES` (R12). |
| `src/lib/billing/plan-catalog.test.ts` | El test «feature keys are exactly the ones the 041 seed documents» pasa a leer 041 ∪ toda migración con la línea `Claves de \`features\` añadidas:`; renombrado en consecuencia. No se edita la 041. |
| `src/lib/rate-limit.ts` | `RATE_LIMITS.integrationCall = { limit: 60, windowMs: 60_000 }` con comentario (por cuenta, todas las integraciones, por proceso). |
| `src/lib/auth/support-scope.ts` (+ test) | `{ path: '/api/account/integrations' }` en `SUPPORT_SESSION_BLOCKED` y línea en el comentario (R32). |
| `src/lib/whatsapp/reencrypt.ts` (+ test) | `{ table: 'account_integrations', columns: ['credential'] }` en `ENCRYPTED_COLUMNS` (R33). |
| `src/lib/whatsapp/encryption.ts` | Solo el comentario de cabecera que enumera columnas cifradas. |
| `src/components/platform/platform-shell.tsx` (+ test) | `'integrations'` en `PlatformSection` y en `PLATFORM_NAV` (`/platform/integrations`, icono `Blocks` de lucide), entre `rates` y `operators`. |
| `src/components/settings/settings-sections.ts` | `'integrations'` en `SETTINGS_SECTIONS` tras `webhooks`; `SECTION_META.integrations` (`Blocks`, grupo `workspace`, no `adminOnly`: cualquier miembro ve el estado). |
| `src/app/(dashboard)/settings/page.tsx` | `integrations: <IntegrationsSettings />`. |
| `src/lib/security/tenant-isolation.test.ts` | Bloques de R31 y waivers (§8). Semillas de las cuatro tablas en el `FakeDatabase` del archivo. |
| `messages/es.json`, `messages/en.json` | §9. |
| `docs/security.md` | `account_integrations.credential` en la lista de secretos cifrados; párrafo de SSRF de integraciones. |
| `CHANGELOG.md` | Unreleased. |

No se tocan: `src/app/api/whatsapp/webhook/route.ts` (CP11), `src/lib/flows/*`,
`src/lib/automations/*`, `src/lib/ai/*` (n13.2–n13.4), `package.json` (CP5). Sin variables de
entorno nuevas (`docs/docker.md` no cambia).

## 4. Validación del catálogo (`catalog-validate.ts`)

```ts
export type AuthScheme = 'bearer' | 'header';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type ParamLocation = 'path' | 'query' | 'body';
export type ParamType = 'string' | 'integer' | 'number' | 'boolean';
export type OutputType = ParamType | 'object' | 'array';

export interface OperationParam {
  name: string; in: ParamLocation; type: ParamType; required: boolean;
  description: string; enum?: string[];
}
export interface OperationOutput { name: string; path: string; type: OutputType; description: string; }

export interface IntegrationWrite {
  slug?: string; name?: string; description?: string | null; logo_url?: string | null;
  base_url?: string; auth_scheme?: AuthScheme; auth_header_name?: string | null;
  credential_help?: string | null; test_path?: string; is_active?: boolean; sort_order?: number;
}
export interface OperationWrite {
  key?: string; name?: string; description?: string; method?: HttpMethod; path?: string;
  params?: OperationParam[]; outputs?: OperationOutput[]; response_description?: string | null;
  is_active?: boolean; sort_order?: number;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string; field: string };

export function validateIntegrationInput(body: unknown, mode: 'create' | 'update'): Validation<IntegrationWrite>;
export function validateOperationInput(body: unknown, mode: 'create' | 'update', existing?: OperationWrite): Validation<OperationWrite>;
export function validateRelativePath(path: unknown): boolean;            // R8
export function pathPlaceholders(path: string): string[];                // '{id}' → ['id']
export function normalizeBaseUrl(input: unknown): string | null;         // https, sin user/pass/query/hash, sin '/' final
```

- `base_url`: `normalizeBaseUrl` + rechazo de literal privado (`isPrivateOrReservedIp` de
  `src/lib/webhooks/ssrf.ts`) y de `localhost`/`.localhost`/`.local`/`.internal`; la ruta de
  plataforma, además, `await isDeliverableUrl(base_url)` antes de escribir (400 `base_url` si
  falla). Sin excepción para desarrollo, igual que los webhooks (`normalizeWebhookUrl`): en local
  se usa un túnel https.
- Cabeceras prohibidas para `auth_header_name` (comparación sin mayúsculas): `host`,
  `content-length`, `content-type`, `transfer-encoding`, `connection`, `keep-alive`, `upgrade`,
  `cookie`, `set-cookie`, `user-agent`, `accept`, `proxy-authorization`, `te`, `trailer`.
  `authorization` se permite (esquemas tipo `Token xxx`: el cliente pega el valor completo).
- En `update`, `validateOperationInput` combina lo nuevo con `existing` para comprobar R8/R9
  (marcadores ↔ params; `GET`/`DELETE` sin `body`), así un PATCH que solo cambia `method` a `GET`
  con params `body` ya existentes también da 400.

## 5. Petición (`request.ts`)

```ts
export interface BuiltRequest {
  url: string; method: HttpMethod;
  headers: Record<string, string>;   // sin la credencial: la añade execute.ts
  body: string | undefined;
}
export type ParamCheck =
  | { ok: true; values: Record<string, string | number | boolean> }
  | { ok: false; problem: 'unknown' | 'missing' | 'type' | 'enum' | 'too_long'; param: string };

export function validateCallParams(declared: OperationParam[], given: Record<string, unknown>): ParamCheck;
export function buildIntegrationRequest(
  integration: { base_url: string },
  operation: { method: HttpMethod; path: string; params: OperationParam[] },
  values: Record<string, string | number | boolean>
): BuiltRequest | { blocked: true };
export function authHeader(scheme: AuthScheme, headerName: string | null, credential: string): [string, string];
```

Coerción (los valores de un flow llegan como texto): `integer` ← número entero o `/^-?\d+$/`;
`number` ← número finito o cadena que `Number()` convierte en finito; `boolean` ← `true`/`false` o
`'true'`/`'false'`; `string` ← cadena de ≤ 2000 caracteres (también acepta número y lo pasa a texto).
`null`/`undefined`/`''` en un parámetro opcional = ausente.

Montaje: `path` → `encodeURIComponent(String(v))`, sin dejar marcadores; `query` →
`URLSearchParams` en el orden declarado; `body` → `JSON.stringify` de un objeto plano con los
parámetros `body` presentes (sin cuerpo si no hay ninguno). URL = `base_url + ruta + ?query`;
`new URL(url).origin !== new URL(base_url).origin` → `{ blocked: true }` (R21). Cabeceras fijas de
R29.

## 6. Red, ejecutor y registro

```ts
// http.ts
export interface IntegrationHttpDeps {
  fetch?: typeof fetch;                               // tests
  isDeliverable?: (url: string) => Promise<boolean>;  // por defecto isDeliverableUrl
  now?: () => number;
}
export type HttpOutcome = 'ok' | 'http_error' | 'timeout' | 'too_large' | 'unreachable' | 'blocked' | 'rate_limited';
export interface HttpResult { outcome: HttpOutcome; status: number | null; data: unknown; latencyMs: number; }

export async function performIntegrationRequest(
  accountId: string, req: BuiltRequest & { headers: Record<string, string> }, deps?: IntegrationHttpDeps
): Promise<HttpResult>;
```

Orden: `checkRateLimit(\`integrationCall:${accountId}\`, RATE_LIMITS.integrationCall)` →
`rate_limited`; `isDeliverable(url)` → `blocked`; `fetch(url, { method, headers, body, redirect:
'manual', signal: AbortSignal.timeout(INTEGRATION_TIMEOUT_MS) })`; `AbortError`/`TimeoutError` →
`timeout`; otro error de red → `unreachable`; `content-length` > máximo → cancelar cuerpo,
`too_large`; leer `res.body.getReader()` acumulando bytes y, al pasar el máximo, `reader.cancel()` y
`too_large`; 3xx o no-2xx → `http_error` (cuerpo descartado); 2xx → JSON si `content-type` contiene
`json` (JSON inválido → `http_error`), texto UTF-8 si no. `ok` solo en 2xx.

```ts
// execute.ts
export type IntegrationCallSource = 'test' | 'flow' | 'ai' | 'automation';
export type IntegrationCallOutcome = HttpOutcome | 'invalid_params' | 'not_enabled' | 'error';
export type IntegrationCallResult =
  | { ok: true; status: number; data: unknown; latencyMs: number }
  | { ok: false; outcome: Exclude<IntegrationCallOutcome, 'ok'>; status: number | null; latencyMs: number };

export async function executeIntegrationOperation(
  db: SupabaseClient,
  input: { accountId: string; integrationSlug: string; operationKey: string;
           params: Record<string, unknown>; source: Exclude<IntegrationCallSource, 'test'> },
  deps?: IntegrationHttpDeps & { entitlements?: (accountId: string) => Promise<Entitlements> }
): Promise<IntegrationCallResult>;

export type IntegrationTestStatus = 'ok' | 'auth_failed' | 'unreachable' | 'error';
export async function testIntegrationConnection(
  db: SupabaseClient, accountId: string, integrationId: string, deps?: IntegrationHttpDeps
): Promise<{ result: IntegrationTestStatus; status: number | null; testedAt: string }
          | { rateLimited: true } | null>;   // null = la cuenta no la tiene activada
```

`executeIntegrationOperation`: integración por `slug` (catálogo, waiver) → si no existe,
`not_enabled` sin registro; activación con `.eq('account_id', accountId).eq('integration_id', …)`;
inactiva / sin activar / operación inactiva o inexistente / plan sin `integrations` (`hasFeature`
sobre `getEntitlements`, inyectable) → `not_enabled`; `validateCallParams` → `invalid_params`;
`buildIntegrationRequest` → `blocked`; `decrypt(credential)` + `authHeader`; `performIntegrationRequest`.
Todo envuelto en `try/catch` → `error`. Al final, `recordIntegrationCall` (privada) inserta la fila
de R28 con `account_id` explícito; si falla, `console.error('[integrations] could not record the
call:', error.code)` — solo el código, nunca el objeto con la fila.

`testIntegrationConnection`: misma resolución por `id` y cuenta; petición `GET base_url +
test_path`; mapeo de R18 (`ok` 2xx; `auth_failed` si `http_error` con 401/403; `unreachable` para
`timeout`/`unreachable`/`blocked`; `error` el resto); `rate_limited` → `{ rateLimited: true }` (la
ruta lo convierte en 429 con `rateLimitResponse`-like JSON); actualiza `last_tested_at` /
`last_test_status` con `.eq('account_id', accountId).eq('integration_id', integrationId)`.

## 7. Rutas

Todas siguen las convenciones existentes:

- **Plataforma** (patrón `src/app/api/platform/plans/route.ts`): `requirePlatformAdmin()` primero
  (401/403 con `toErrorResponse`), `checkRateLimit(\`platform:integrations:${userId}\`,
  RATE_LIMITS.adminAction)` en escrituras, validación → 400 `{ error, field }`, errores de
  unicidad `23505` → 409, resto 500 con mensaje fijo. `updated_by`/`created_by` = `ctx.userId`.
  `GET /api/platform/integrations` devuelve, por integración, `operationsActive` y
  `accountsEnabled` (recuento en JS de `select('integration_id').eq('is_enabled', true)` sobre
  `account_integrations`: lectura entre cuentas con waiver, solo ids).
  No se registran en `impersonation_log`: es catálogo global como `plans` (s9.3) y
  `recordPlatformAction` exige cuenta salvo `account_create`; la traza mínima es
  `created_by`/`updated_by`/`updated_at`.
- **Cuenta** (patrón `src/app/api/account/webhooks/route.ts` y `[id]/test/route.ts`):
  - `GET`: `getCurrentAccount()` (cualquier miembro; cuenta efectiva en soporte); lecturas con
    `supabaseAdmin()` de `@/lib/auth/admin-client`; `planAllows` con `hasFeature(await
    getEntitlements(ctx.accountId), 'integrations')`; `canManage` = rol ≥ `admin` y
    `!ctx.impersonation`.
  - `PUT` / `DELETE` / `POST test`: `requireRole('admin')` → `assertNotSupportSession(ctx)` →
    (`PUT` y `test`) `assertPlanFeature(ctx.accountId, 'integrations')` → rate limit
    (`admin:integrations:${userId}` con `adminAction` en `PUT`/`DELETE`; `test` usa el cubo
    `integrationCall` del núcleo) → `params` con `await` (Next 16). Errores por
    `toErrorResponse` (402 de facturación incluido).
  - `PUT` hace `upsert` con `onConflict: 'account_id,integration_id'` y `account_id:
    ctx.accountId` en la fila (la auditoría de inserciones lo exige).

Next 16 (CP7), comprobado en `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`
(«`params`: a promise…», líneas 82–95) y `…/page.md` (`params: Promise<{ slug: string }>`): las
rutas dinámicas reciben `{ params }: { params: Promise<{ id: string }> }` y hacen `await params`,
como las rutas existentes. `/platform/integrations` convive con el segmento dinámico `src/app/(platform)/platform/[id]`:
el App Router casa antes el segmento estático (`…/dynamic-routes.md` distingue *static* =
«literal matched exactly» de *dynamic*); el implementer lo confirma en la tabla de rutas de
`npm run build` y con un test de `platformSectionFor('/platform/integrations/<uuid>')`. `src/middleware.ts` sigue siendo el archivo de middleware del repo (la doc
`…/proxy.md` lo marca como obsoleto en favor de `proxy.ts`): no se renombra en esta feature.

## 8. Aislamiento (CP3) — `tenant-isolation.test.ts`

Semillas: integración `health` (id fijo) con operación `list_doctors`; activación de **B primero**
y luego de A para la misma integración, con credenciales distintas; una fila de `integration_calls`
de B.

Waivers nuevos (con motivo escrito, como los de `plans`):

| Tabla | op | by | Motivo |
|---|---|---|---|
| `integrations` | `select` | `id` / `slug` / — | Catálogo global sin `account_id` (091). |
| `integrations` | `insert`/`update` | — / `id` | Escritura del catálogo desde el panel, tras `requirePlatformAdmin()`. |
| `integration_operations` | `select`/`insert`/`update` | `integration_id` / `id` | Ídem, hija del catálogo. |
| `account_integrations` | `select` | `is_enabled` | Solo `GET /api/platform/integrations`: recuento de cuentas por integración; devuelve ids de integración, ningún dato de cuenta. |

Casos: (1) actor A, `GET /api/account/integrations` → `credentialLast4` de A, nada de B; (2) `PUT`
como A → solo cambia la fila de A, B byte a byte igual; (3) `DELETE` como A → ídem; (4) `POST test`
como A con `fetch` espía → la cabecera lleva la credencial de A; (5) `executeIntegrationOperation`
para A → credencial de A y fila de registro con `account_id = A`; (6) las cuatro rutas de
plataforma como `owner` de A sin `platform_admins` → 403 y tablas intactas.

## 9. i18n

`en` es la fuente; mismas claves y placeholders en `es`.

- `Platform.shell.nav.integrations` — «Integraciones» / «Integrations».
- `Platform.plans.features.integrations` — «Integraciones con apps Cabbity» / «Cabbity app integrations».
- `Platform.integrations.*`: `title`, `subtitle`, `empty`, `create`, `columns.{name,slug,status,operations,accounts}`,
  `status.{active,draft}`, `form.{name,slug,slugHelp,description,logoUrl,baseUrl,baseUrlHelp,authScheme,authBearer,authHeader,headerName,credentialHelp,testPath,testPathHelp,active,save,saved}`,
  `operations.{title,empty,add,key,name,description,descriptionHelp,method,path,pathHelp,params,outputs,responseDescription,active,save}`,
  `params.{name,in,type,required,description,enum,add,remove,in_path,in_query,in_body}`,
  `outputs.{name,path,type,description,add,remove}`, `errors.{field,exists,failed}` (`{field}` como placeholder).
- `Settings.sections.integrations` — «Integraciones» / «Integrations».
- `Settings.integrations.*`: `title`, `desc`, `empty`, `planRequired`, `upgrade`, `status.{active,inactive,planRequired,retired}`,
  `operations`, `activate`, `activateTitle`, `credentialLabelBearer`, `credentialLabelHeader` (`{header}`),
  `credentialSaved` (`{last4}`), `test`, `testing`, `testResult.{ok,auth_failed,unreachable,error}`,
  `lastTested` (`{when}`), `change`, `deactivate`, `deactivateConfirm` (`{name}`), `readOnly`, `failed`.

## 10. Errores

| Situación | Respuesta |
|---|---|
| Sin sesión / no operador | 401 / 403 (`toErrorResponse`) |
| Rol < admin, sesión de soporte | 403 |
| Plan sin `integrations` | 402 con `code`, `upgradeUrl` (`billingErrorPayload`) |
| Validación | 400 `{ error, field }` (mensajes en inglés, como el resto de la API interna; la UI traduce por `field`) |
| Slug / key duplicados | 409 |
| Integración inexistente o inactiva (cliente), sin activación (`DELETE`/`test`) | 404 |
| Cubo `integrationCall` agotado en `test` | 429 con `Retry-After` |
| Cualquier otro | 500 con mensaje fijo; `console.error` con contexto sin credenciales |

El ejecutor nunca lanza (R27): quien lo llame en n13.2–n13.4 decide qué hacer con `ok: false`.

## 11. Riesgos y notas

- **Rate limit por proceso** (`src/lib/rate-limit.ts`): con varias instancias el límite real se
  multiplica; mismo compromiso que el resto del repo.
- **DNS rebinding**: riesgo residual documentado en `src/lib/webhooks/ssrf.ts`; la comprobación de
  origen (R21) impide al menos cambiar de host.
- **Credenciales de Health**: un token de Sanctum de un usuario de Health hereda sus permisos; la
  ayuda (`credential_help`) debe pedir un usuario técnico con los permisos mínimos. Es texto del
  operador, no código.
- **`executeIntegrationOperation` sin llamador de producción en n13.1**: es la API que consumen
  n13.2–n13.4 y la prueba de conexión comparte su núcleo; queda justificada aquí para CP8.
