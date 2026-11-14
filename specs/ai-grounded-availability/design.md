# n13.7 `ai-grounded-availability` — diseño

Base: `main` @ a4726df. Requisitos en `requirements.md` (R1–R43). Proyecto `wacrm` (Next 16 +
Supabase); sin skill de dominio: guía en `AGENTS.md` y `node_modules/next/dist/docs/`.

## 1. Decisiones para el humano (aprobar o pedir cambios)

| # | Decisión | Alternativa descartada y por qué |
|---|----------|----------------------------------|
| D1 | **Capa 1 = inyección de datos en vivo en el system prompt** (lecturas configurables, plantillas de fecha, caché 60 s). Es la única capa que pone los huecos reales delante del modelo **sin depender de que decida llamar** y sin que tenga que inventar argumentos (`location_id`, `membership_id` vienen fijados por el admin). Coste: 1 llamada a Health por lectura y minuto como mucho por cuenta y proceso. | — (pedida por el humano). |
| D2 | **Capa 2 = guardia del texto final** (detector de afirmaciones de agenda es/en + una vuelta correctiva + traspaso si sigue sin fundamentar). Es agnóstica del proveedor (no toca los adaptadores) y solo actúa cuando no hubo datos: con la lectura en vivo `ok` el turno ya está fundamentado y la guardia no gasta nada. | `tool_choice` forzado (D3). |
| D3 | **No se fuerza `tool_choice`**. | Forzar la primera vuelta a la operación: (a) cuesta una vuelta y una llamada a Health en TODOS los turnos, también «gracias»; (b) obliga al modelo a rellenar argumentos requeridos que puede no saber (inventaría `location_id`); (c) Anthropic no admite `tool_choice` forzado con *extended thinking* y Gemini exige `mode: ANY` + `allowedFunctionNames`: tres caminos distintos en los adaptadores; (d) no impide que en la vuelta final invente igualmente. La capa 1 da lo mismo sin esos costes. |
| D4 | **Guardia destructiva declarativa** en `integration_operations.ai_policy.requires_prior` (columna jsonb, 095), evaluada en el bucle **antes** de ejecutar, con evidencia de **turnos anteriores** de la conversación (no del actual) leída de `integration_calls` (nueva columna `conversation_id`). Exigir turno anterior garantiza que entre la consulta de disponibilidad y la cancelación hubo al menos un mensaje al cliente (donde se ofrecieron los huecos). | (a) Evidencia del turno actual: el modelo podría llamar a `find_availability` y cancelar en la misma vuelta sin ofrecer nada. (b) Política en el registro de código (`INTEGRATION_CATALOGS`) en vez de columna: evita migración y choque con n13.8, pero deja fuera las integraciones creadas desde el panel de plataforma (n13.1) y crea dos fuentes de verdad para el loader, que hoy solo lee la base. |
| D5 | **Las lecturas en vivo NO cuentan como evidencia** para `requires_prior` (se marcan `ai_preload = true`). Se ejecutan en todos los turnos: contarlas anularía la guardia. Consecuencia: aunque el modelo ya tenga los huecos en el prompt, para cancelar debe haber llamado explícitamente a `find_availability` en un turno anterior. Si no, recibe `policy_requires_prior`, la llama, ofrece huecos y la cancelación queda para el siguiente mensaje (un mensaje más al cliente en el peor caso). | Contar la lectura en vivo + comprobar por regex que el mensaje anterior del bot mencionaba horas: frágil y no demuestra que se ofrecieran. |
| D6 | **«Con resultado» = `outcome = 'ok'`** (2xx), aunque la lista venga vacía. Si se exigiera no vacía, un paciente sin huecos disponibles en 14 días nunca podría cancelar por la IA. | Exigir lista no vacía (bloqueo permanente). |
| D7 | **Fallo de la guardia de texto ⇒ traspaso** (`[[HANDOFF]]`) en `auto_reply` y playground. Falso positivo conocido: una cuenta **sin** lectura en vivo que responde horarios de apertura de sus instrucciones («abrimos los sábados de 8 a 12») recibe una vuelta correctiva y, si insiste, traspasa. Con lectura en vivo `ok` no ocurre. | Solo registrar en consola (no es garantía); reescribir el texto quitando horas (destroza la respuesta). |
| D8 | Ventana de evidencia: **24 h** (la ventana de sesión de WhatsApp). Caché: **60 s** ok / **10 s** fallo, override `AI_LIVE_DATA_TTL_MS`. Máximo **3** lecturas por integración y bloque de **6 000 bytes** por lectura. | Caché más larga: un hueco recién ocupado por otro canal se seguiría ofreciendo (Health responde `409 slot_unavailable` al reservar, así que el daño es acotado; 60 s es el compromiso). |

## 2. Migración `supabase/migrations/095_ai_grounding.sql`

Idempotente, `SET lock_timeout = '5s'` como 094. RLS sin cambios (las tres tablas siguen sin
políticas: solo rol de servicio).

```sql
ALTER TABLE public.account_integrations
  ADD COLUMN IF NOT EXISTS ai_live_reads jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.integration_operations
  ADD COLUMN IF NOT EXISTS ai_policy jsonb;
ALTER TABLE public.integration_calls
  ADD COLUMN IF NOT EXISTS conversation_id uuid
    REFERENCES public.conversations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ai_preload boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS integration_calls_conversation_idx
  ON public.integration_calls (account_id, conversation_id, created_at)
  WHERE conversation_id IS NOT NULL;
-- DO $$ … guardas pg_constraint:
--   account_integrations_ai_live_reads_shape:
--     CHECK (jsonb_typeof(ai_live_reads) = 'array' AND jsonb_array_length(ai_live_reads) <= 3)
--   integration_operations_ai_policy_shape:
--     CHECK (ai_policy IS NULL OR jsonb_typeof(ai_policy) = 'object')
```

`ON DELETE SET NULL` (no CASCADE, CP2): borrar una conversación no borra el registro de llamadas.
Bloque `-- 095` en `supabase/ci/verify-schema.sql` (columnas, default, los dos CHECK, el índice y
`confdeltype = 'n'` de la FK). SQL de verificación en `progress/checks_ai-grounded-availability.sql`.

## 3. Tipos

### 3.1 `src/lib/integrations/types.ts` (aditivo; **n13.8 toca este archivo**, ver §13)

```ts
export type AiGroundClaim = 'schedule';
export const AI_GROUND_CLAIMS: readonly AiGroundClaim[] = ['schedule'];
export interface OperationAiPolicy {
  grounds?: AiGroundClaim[];
  /** Pasos en orden; cada paso, keys alternativas de la MISMA integración. */
  requires_prior?: string[][];
}
// OperationWrite.ai_policy?: OperationAiPolicy | null
// OperationRow.ai_policy: OperationAiPolicy | null
```

`IntegrationCallSource` no cambia. `executeIntegrationOperation` acepta en `input` dos campos
opcionales: `conversationId?: string | null` y `preload?: boolean`, que `recordIntegrationCall`
escribe en `conversation_id` / `ai_preload` (omitidos = `null` / `false`, filas idénticas a hoy).

### 3.2 `src/lib/integrations/catalogs/definition.ts`

`CatalogOperation.ai_policy?: OperationAiPolicy` (import type de `../types.ts`).

### 3.3 `src/lib/ai/tools/types.ts`

```ts
export const AI_LIVE_READS_MAX = 3;
export const AI_LIVE_DATA_MAX_BYTES = 6000;
export const AI_LIVE_DATA_DEFAULT_TTL_MS = 60_000;
export const AI_LIVE_DATA_FAIL_TTL_MS = 10_000;
export const AI_EVIDENCE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const AI_TRAIL_MAX = 50;

export interface AiLiveRead { operation: string; params: Record<string, string | number | boolean>; }
// AiTool += policy: OperationAiPolicy | null
// AiToolIntegration += liveReads: AiLiveRead[]
// ToolUseRecord += slug?: string; blocked?: 'policy'
// AccountIntegrationAiFields += aiLiveReads: AiLiveRead[];
//   aiReadOperations: { key: string; name: string; params: Pick<OperationParam,'name'|'type'|'required'|'description'|'enum'>[] }[]

export interface LiveDataBlock {
  integrationSlug: string; integrationName: string; operationKey: string;
  timeZone: string | null; loadedAt: Date;
  result: { ok: true; data: unknown } | { ok: false };
  grounds: AiGroundClaim[];
}
export interface PriorEvidence { integrationSlug: string; operationKey: string; }
```

## 4. Plantillas y validación de lecturas (`src/lib/ai/tools/live-templates.ts`, puro)

```ts
export const LIVE_TEMPLATE_RE = /\{\{\s*today(?:\+(\d{1,2})d)?\s*\}\}/g;
export function localDateInZone(now: Date, timeZone: string | null, plusDays = 0): string; // YYYY-MM-DD
export function resolveLiveTemplates(value: string, now: Date, timeZone: string | null): string;
export function hasUnknownTemplate(value: string): boolean; // `{{` que no casa con LIVE_TEMPLATE_RE o N fuera de 1..60
export function validateLiveReads(
  raw: unknown,
  operations: { key: string; method: HttpMethod; is_active: boolean; params: OperationParam[] }[],
  opts: { now: Date; timeZone: string | null }
): { ok: true; value: AiLiveRead[] } | { ok: false; error: string };
```

`localDateInZone` suma días sobre la fecha local (`Date.UTC(y, m-1, d + n)`), no sobre milisegundos,
para no fallar en cambios de hora. `validateLiveReads` (R2/R3/R5): array ≤ 3; `operation` string
existente, activa y `GET`; claves de `params` solo nombres de `callerParams`; valores escalares;
plantillas conocidas; luego `validateCallParams(op.params, resolved)` con `now` fijo. Reutiliza
`isValidTimeZone` (`prompt.ts`) y `callerParams` / `validateCallParams` (`request.ts`).

## 5. Ajustes → Integraciones

- `src/lib/integrations/account.ts`: `ACTIVATION_COLUMNS` añade `ai_live_reads`; la consulta de
  operaciones añade `params`; la vista devuelve `aiLiveReads` y `aiReadOperations` (solo `GET`
  activas, parámetros vía `callerParams`), ambos vacíos si no está activada (R6).
  `validateAiSettings` acepta `aiLiveReads` (forma superficial: array o null; R5) y lo deja en
  `value.ai_live_reads` sin validar contra operaciones; el mensaje «Send at least one of …» incluye
  `'aiLiveReads'`. Nueva `loadIntegrationOperationsForLiveReads(db, integrationId)` (catálogo
  global por id, sin `account_id`: waiver de n13.1).
- `src/app/api/account/integrations/[integrationId]/route.ts` (PATCH): si viene `ai_live_reads`,
  lee `ai_timezone` (del cuerpo si viene, si no de la fila de ESTA cuenta con
  `.eq('account_id', ctx.accountId)`) y las operaciones, y llama a `validateLiveReads`; error →
  400 `{error, field:'aiLiveReads'}`. Firma de Route Handler sin cambios (`params` es `Promise`,
  comprobado en `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`).
- `src/components/settings/integrations-settings.tsx`: el diálogo «Instrucciones para la IA» gana
  la sección «Datos en vivo antes de responder» (R7): lista de lecturas (select de operación con
  `aiReadOperations`; un `Input` por parámetro, numérico para `integer`/`number` salvo que contenga
  `{{`, select si hay `enum`, `Switch` para `boolean`), botón «Añadir» (deshabilitado con 3),
  «Quitar», texto de ayuda de plantillas y error del 400 en línea. El estado de la sección se
  extrae a un componente presentacional nuevo `src/components/settings/integration-live-reads.tsx`
  (props: `operations`, `value`, `onChange`, `disabled`, `error`) para poder testearlo con
  Testing Library como los demás componentes de `settings/`. Sin estilos nuevos: los primitivos de
  `@/components/ui`.
- i18n (`Settings.integrations`, es y en): `aiLiveTitle`, `aiLiveHint`, `aiLiveTemplatesHelp`
  (cita `'{{today}}'` y `'{{today+13d}}'` escapadas para ICU), `aiLiveOperation`, `aiLiveAdd`,
  `aiLiveRemove`, `aiLiveMax` (`{max}`), `aiLiveEmpty`, `aiLiveInvalid`.

## 6. Carga del toolset (`src/lib/ai/tools/load.ts`, `schema.ts`)

- `load.ts`: `account_integrations` selecciona además `ai_live_reads`; `integration_operations`
  además `ai_policy`. `AiToolIntegration.liveReads` = el array leído si es array de objetos con
  `operation` string (lo demás se descarta, R15). `ToolSourceRow.operation.aiPolicy` se propaga.
- `schema.ts` (`buildAiTools`): `AiTool.policy = sanitizePolicy(row.aiPolicy)` (forma inválida →
  `null`); la descripción de una herramienta con `requires_prior` termina con
  `" Requires a previous call (in an earlier message) to: <tool names>."` dentro del tope actual
  de 1024 caracteres (R26). Los nombres de herramienta se resuelven tras asignar todos los nombres
  (R6 de n13.3); una key de `requires_prior` sin herramienta en el turno se nombra por su key.

## 7. Lecturas en vivo (`src/lib/ai/tools/live.ts`, nuevo)

```ts
export async function loadLiveData(
  db: SupabaseClient,
  input: { accountId: string; toolset: AiToolset; conversationId: string | null; now: Date },
  deps?: { execute?: typeof executeIntegrationOperation; nowMs?: () => number }
): Promise<LiveDataBlock[]>;
export function invalidateLiveCache(accountId: string, integrationSlug: string): void;
export function __resetLiveCacheForTests(): void;
export function aiLiveDataTtlMs(): number; // AI_LIVE_DATA_TTL_MS
```

- Por integración del toolset y lectura: resuelve plantillas (zona = `integration.timezone`),
  clave `${accountId}\u0000${slug}\u0000${operation}\u0000${stableJson(params)}`; caché `Map` de
  módulo con `{expiresAt, result}`, inserción ordenada y desalojo de las más antiguas pasado 500
  (R11–R14). Fallo → entrada de 10 s.
- Miss → `execute(db, {accountId, integrationSlug, operationKey, params, source:'ai',
  conversationId, preload:true})` en `Promise.all`; una excepción = fallo (R15). `grounds` del bloque
  = `policy.grounds` de la herramienta del toolset con esa operación (o `[]` si la operación no está
  en el toolset por el tope de 20).
- Consola: `[ai live]` cuenta, slug, key, `ok|cache|<outcome>`; nunca params ni datos.

## 8. Render del bloque (`src/lib/ai/tools/live-render.ts`, puro) y prompt

```ts
export function renderLiveBlock(block: LiveDataBlock): string;           // R17–R19
export function buildLiveDataSection(blocks: LiveDataBlock[], opts: { mode: 'draft'|'auto_reply' }): string; // R16, R20, R21
```

- Lista = cuerpo si es array; si no, `body.data` si es array. Campo de fecha = `starts_at` si es
  ISO con offset (`/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/`), si no
  el primer campo escalar que lo sea. Día y hora local con `Intl.DateTimeFormat` en la zona del
  bloque (o la del offset del valor si la integración no tiene zona); día de la semana con
  `weekday: 'long'` en `en-US`; offset con la misma lógica que `formatNowInZone` (`prompt.ts`, se
  extrae a un helper compartido `offsetLabel`). Línea: `- 09:00–09:30 practitioner_name=Dra. Pérez
  membership_id=12 location_id=3` (sin el campo de fecha ni `ends_at`; valores string cortados a
  80 caracteres; objetos/arrays anidados omitidos).
- Corte a 6 000 bytes por días enteros; si no cabe ni el primero, por elementos; JSON compacto por
  puntos de código (como `successPayload` de `result.ts`).
- `buildSystemPrompt` (`src/lib/ai/defaults.ts`) gana `liveData?: LiveDataBlock[]`: la sección va
  justo después de la de herramientas; ausente o `[]` → texto idéntico (R16). Reglas en inglés,
  como el resto del andamiaje. Fallo (R21): `"<Integration> · <operation>: could not be loaded at
  <time>. Do not state any day, date or time as available. If the customer needs one, call the
  tool; if it fails, reply with exactly [[HANDOFF]]."` (la última frase solo en `auto_reply`).

## 9. Bucle (`src/lib/ai/tools/loop.ts`)

`ToolLoopArgs` gana `mode: AiToolMode`, `liveData?: LiveDataBlock[]`, `priorEvidence?:
PriorEvidence[]` (playground) y `conversationId?: string | null`. `ToolLoopDeps` gana
`loadEvidence?` (inyectable).

1. **Evidencia (R28, R31, R34)** — si alguna herramienta tiene `requires_prior`:
   `priorEvidence` del argumento (playground) o `loadPriorEvidence(db, accountId, conversationId,
   now)` (nuevo, en `src/lib/ai/tools/evidence.ts`): `integration_calls` →
   `select('integration_id, operation_key, created_at').eq('account_id', accountId)
   .eq('conversation_id', conversationId).eq('source','ai').eq('ai_preload', false)
   .eq('outcome','ok').gte('created_at', now-24h).order('created_at')` y mapa
   `integration_id → slug` vía `integrations` (catálogo global, por id). Error o sin
   `conversationId` → `[]`. Una sola vez, antes de la primera vuelta.
2. **Política (R29, R30)** — pura: `checkRequiresPrior(policy, slug, evidence): { ok: true } | { ok:
   false; missing: string[][] }` en `src/lib/ai/tools/policy.ts`. Recorre los pasos en orden sobre
   la evidencia de la misma integración, cada paso buscando una key de sus alternativas con índice
   mayor que el del paso anterior. Bloqueo → `errorPayload('policy_requires_prior')` ampliado con
   `required`, sin `execute`, sin contar en `executed`; `used.push({…, ok:false,
   blocked:'policy'})`. `OUTCOME_HINTS.policy_requires_prior` (en `result.ts`): `"This action is
   not allowed yet. First call: <tools>, and offer the customer the alternatives in this message.
   The action can only be done in a later message, after the customer has seen them."`
   `LoopErrorCode` gana `'policy_requires_prior'`.
3. **Ejecución** — `execute` recibe `conversationId` (R27). Tras un `ok` de una herramienta no
   `GET`, `invalidateLiveCache(accountId, slug)` (R13). Se lleva un conjunto `groundedThisTurn`:
   `true` si algún `liveData` con `grounds` incluye `'schedule'` y `ok`, o si alguna llamada `ok`
   del turno es de una herramienta con `grounds` `'schedule'` (R36).
4. **Guardia de texto (R35–R40)** — cuando la vuelta devuelve texto final, si
   `mode !== 'draft'`, el toolset tiene alguna herramienta con `grounds` `'schedule'`,
   `mentionsSchedule(text)` y `!groundedThisTurn`:
   - si no se ha hecho aún y no se alcanzó `AI_TOOL_MAX_CALLS` ni el presupuesto: una vuelta más
     con `toolChoice: 'auto'` y `systemPrompt + '\n\n' + GROUNDING_RETRY_NOTE` (constante en
     `grounding.ts`), mismos `steps` (el borrador no se reenvía); no incrementa `rounds`. Si pide
     herramientas, se ejecutan y el bucle sigue con el prompt original; la guardia no se repite.
   - si ya se hizo o no se puede: `text = HANDOFF_SENTINEL` (lo convierte en traspaso
     `parseGeneration` en `generate.ts`) y `console.warn('[ai grounding]', accountId, mode,
     'handoff')`.
   Resultado: `ToolLoopResult` gana `grounding?: 'retried' | 'handoff'` (para tests y el
   playground; no se persiste).
5. Sin herramientas con `grounds` ni `requires_prior`, el camino es el actual (R40).
   `toolChoice` sigue `'auto' | 'none'` (R41).

`src/lib/ai/tools/grounding.ts` (puro): `mentionsSchedule(text: string): boolean` (R35; normaliza
con `NFD` y quita diacríticos, insensible a mayúsculas, límites de palabra; meses es/en en forma
larga y abreviada de 3 letras con día) y `GROUNDING_RETRY_NOTE`.

`src/lib/ai/generate.ts`: `GenerateArgs.tools` gana `mode`, `liveData?`, `priorEvidence?`,
`conversationId?`, que pasa a `runToolLoop`. Sin herramientas, intacto.

## 10. Llamadores

- `src/lib/ai/auto-reply.ts`: tras `loadAiToolset`, `const liveData = toolset.tools.length ?
  await loadLiveData(db, {accountId, toolset, conversationId, now}) : []`; `buildSystemPrompt({…,
  liveData, now})`; `generateReply({…, tools: {toolset, db, accountId, mode:'auto_reply',
  liveData, conversationId}})`. Posición: después de `claimInboundAutoReply` y de
  `checkRateLimit` (R10), como ya está `loadAiToolset`.
- `src/app/api/ai/playground/route.ts`: igual con `conversationId: null`; lee `body.trail` con
  `readTrail` (nuevo en `tools-used.ts`: array ≤ 50, entradas `{slug, operation, ok:true}` válidas,
  sin `blocked`) → `priorEvidence` (R32); respuesta añade `grounding` si existe.
- `src/components/agents/ai-playground.tsx`: acumula los `toolsUsed` con `ok && !blocked && slug`
  de las respuestas anteriores y los manda como `trail`; reiniciar el chat lo vacía.
  `ToolsUsedLine` (`ai-tools-used.tsx`) marca las bloqueadas con un sufijo i18n
  (`AiTools.toolBlocked`, es/en).
- `src/app/api/ai/draft/route.ts`: `loadLiveData` + `liveData` en el prompt; `mode:'draft'` (sin
  guardia de texto, R39; sin `requires_prior` efectivo porque solo hay `GET`).

## 11. Catálogo Health y bootstrap

- `src/lib/integrations/catalogs/cabbity-health.ts`: `ai_policy` según R24 (constante
  `SCHEDULE = { grounds: ['schedule'] }`). Las descripciones no se tocan en esta feature (las
  cambia n13.8 en paralelo) salvo `cancel_appointment`, que gana: «Antes, en un mensaje anterior,
  localiza la cita y consulta find_availability para ofrecer otra fecha; el sistema bloquea la
  cancelación si no.»
- `src/lib/integrations/catalog-validate.ts`: `validateOperationInput` valida `ai_policy` (R23).
- `scripts/integrations-bootstrap-catalog.ts`: `'ai_policy'` en `OPERATION_SYNCED` (R25); en
  creación se escribe igual que el resto.

## 12. Seguridad y aislamiento

- Todas las lecturas con rol de servicio de tablas de cuenta llevan `.eq('account_id', …)`:
  `account_integrations` (load, PATCH) e `integration_calls` (evidencia). Test de fuga entre dos
  cuentas en `evidence.test.ts` (R34) y en el PATCH (una cuenta no valida contra la zona de otra).
- La caché indexa por `accountId` en la clave; test de no cruce (R14).
- Los datos en vivo son texto de un tercero: la sección los marca como datos, no instrucciones
  (R20); el render corta strings a 80 caracteres y descarta estructuras anidadas.
- `trail` del playground lo controla el cliente: solo puede habilitar la guardia en el propio
  playground de un agente de la cuenta, que de todos modos puede pedir la cancelación hablando.
  No afecta a `auto_reply`, que lee la base.
- Consola: nunca params, resultados, texto del modelo ni del cliente.

## 13. Dependencias y choques

- **n13.8 `health-document-normalize`** (en curso, rama `feat/health-document-normalize`) toca
  `src/lib/integrations/types.ts` (`OperationParam.normalize`), `request.ts`,
  `catalogs/cabbity-health.ts` (descripciones y `normalize`), `catalog-validate.ts` y quizá
  `bootstrap.test.ts`. Esta feature añade campos distintos en esos archivos (`ai_policy`,
  `OperationAiPolicy`). **Implementar sobre `main` después de fusionar n13.8**, o rebasar; no se
  duplica nada de n13.8 (ni `normalize` ni las descripciones de `document_number`/consentimiento).
- n13.2 (flows) reserva 092: esta usa 095.

## 14. Guion manual (R43)

Cuenta de pruebas con Health real (`docs/integrations/`), proveedor real, zona
`America/Santo_Domingo`, lectura en vivo `find_availability` con `location_id` y `membership_id`
fijos y `from={{today}}`, `to={{today+13d}}`:
1. Playground: «¿qué días tienen libres?» → solo días/horas del bloque (comparar con
   `GET /availability` a mano). Repetir en < 60 s: `integration_calls` no gana fila (caché).
2. Desactivar la clave en Health → «¿tienen algo el jueves?» → no afirma horas; ofrece consultar o
   traspasa.
3. Con cita existente: «quiero cancelar mi cita» → (motivo) «no puedo ir ese día» → la IA ofrece
   huecos y NO cancela en ese mensaje; «no, cancélala» + «sí» → cancela. Repetir forzando
   `cancel_appointment` en el primer mensaje: `toolsUsed` muestra la llamada bloqueada.
4. Repetir 1–3 con los tres proveedores (OpenAI, Anthropic, Gemini).

## 15. Archivos tocados

Nuevos: `supabase/migrations/095_ai_grounding.sql`, `src/lib/ai/tools/{live,live-templates,
live-render,evidence,policy,grounding}.ts` + sus `*.test.ts`,
`src/components/settings/integration-live-reads.tsx` + test, `progress/checks_ai-grounded-availability.sql`.
Modificados: `supabase/ci/verify-schema.sql`, `src/lib/integrations/{types,execute,account,
catalog-validate}.ts`, `src/lib/integrations/catalogs/{definition,cabbity-health}.ts`,
`scripts/integrations-bootstrap-catalog.ts`, `src/lib/ai/tools/{types,load,schema,loop,prompt,
result,tools-used}.ts`, `src/lib/ai/{defaults,generate,auto-reply}.ts`,
`src/app/api/ai/{playground,draft}/route.ts`,
`src/app/api/account/integrations/[integrationId]/route.ts`,
`src/components/settings/integrations-settings.tsx`, `src/components/agents/{ai-playground,
ai-tools-used}.tsx`, `messages/{es,en}.json`, `docs/docker.md` (`AI_LIVE_DATA_TTL_MS`),
`CHANGELOG.md`. Adaptadores de proveedor: **sin cambios** (D3).
