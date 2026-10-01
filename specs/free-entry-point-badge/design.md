# p11.6 `free-entry-point-badge`: diseño

## Rama

`pmd/free-entry-point-badge` desde `feat/precios-meta-directo` @ be8ca0f, en el worktree hijo
`.claude/worktrees/pmd-free-entry-point-badge`:

```bash
git worktree add .claude/worktrees/pmd-free-entry-point-badge -b pmd/free-entry-point-badge be8ca0f
```

Las migraciones 080 y 081 son de p11.3 y p11.4 (otro spec_author) y **esta usa la 082**. Si al
integrar todavía no existen la 080 y la 081, el replay aplica 001–076 + 079 + 082 sin problema:
la 082 solo depende de `conversations` (001/017/053). En producción, la 082 se despliega con
el resto de la fase 10/11 (075–083, en orden).

## Supuestos sin verificar (Meta), que debe confirmar el humano

En el repo no hay documentación de Meta sobre `referral`. Lo que sigue sale del conocimiento
general del modelo y **no se ha comprobado**. Se cierra con el §Guion manual de `requirements.md`.

| Id | Supuesto | Si es falso |
|---|---|---|
| S-E1 | El mensaje entrante que abre una conversación desde un anuncio CTWA trae `messages[].referral` como objeto con `source_type` (`'ad'` o `'post'`), `source_id`, `source_url`, `headline`, `body`, `media_type`, `image_url`/`video_url`/`thumbnail_url` y `ctwa_clid`. | Si la clave tiene otro nombre, `parseReferral` devuelve `null`, no se guarda nada y no hay insignia: no rompe nada (R6). Si `source_type` usa otro valor, cae en `ctwa_other` y queda sin insignia (lado seguro). |
| S-E2 | La ventana gratis se abre solo con anuncios CTWA (`source_type = 'ad'`) y con el botón de llamada a la acción de una página de Facebook. Las publicaciones orgánicas no la abren. El botón de página **no** trae `referral`. | La insignia sale en menos casos de los reales, nunca en más. Si se confirma que `post` también es gratis, basta con añadir `ctwa_organic` a `FREE_WINDOW_SOURCES`. |
| S-E3 | La ventana dura 72 h y solo se abre si el negocio responde en las primeras 24 h tras el mensaje del cliente. | Si se cuenta desde la primera respuesta del negocio, la ventana real termina después de `entry_point_at + 72 h` y la insignia se apaga antes de tiempo (lado seguro). Si dura menos de 72 h, `FREE_WINDOW_HOURS` se baja (una constante y el CHECK de la 082). |
| S-E4 | Dentro de la ventana Meta no cobra ninguna categoría, tampoco plantillas de marketing o utilidad, y lo marca en el estado con `pricing.type = 'free_entry_point'` (ya en `KNOWN_PRICING_TYPES` de s10.1). | El `tooltip` dice «Meta no cobra los mensajes de esta conversación». Si las plantillas sí se cobran, se ajusta el texto, sin migración. |
| S-E5 | `messages[].timestamp` es una cadena con segundos Unix, el mismo contrato que ya usa `processMessage` (`parseInt(message.timestamp) * 1000`). | R10 cubre el caso inválido: se usa la hora de recepción y no se abre ventana. |

## Migración `supabase/migrations/082_conversation_entry_point.sql` (nuevo)

Idempotente y con el mismo cuidado de locks que la 075 (CP11: `conversations` la toca el webhook
en cada entrante con `bump_conversation_on_inbound`).

```sql
-- cabecera: qué guarda, por qué en conversations y no en messages (ver Alternativas),
-- por qué NOT VALID, supuestos S-E1…S-E3.
SET lock_timeout = '5s';

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS entry_point_source   TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS entry_point_at       TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS free_window_until    TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS entry_point_referral JSONB;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.conversations'::regclass
                   AND conname = 'conversations_entry_point_source_check') THEN
    ALTER TABLE conversations ADD CONSTRAINT conversations_entry_point_source_check
      CHECK (entry_point_source IS NULL
             OR entry_point_source IN ('ctwa_ad', 'ctwa_organic', 'ctwa_other')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.conversations'::regclass
                   AND conname = 'conversations_free_window_check') THEN
    ALTER TABLE conversations ADD CONSTRAINT conversations_free_window_check
      CHECK (free_window_until IS NULL
             OR (entry_point_at IS NOT NULL
                 AND free_window_until <= entry_point_at + interval '72 hours')) NOT VALID;
  END IF;
END
$$;

RESET lock_timeout;
```

- Sin `DEFAULT` (Postgres 17 no reescribe la tabla al añadir columnas anulables sin default) y
  sin índice: la insignia se lee de la fila que la bandeja ya carga (`CONVERSATION_SELECT =
  "*, …"` en `src/lib/inbox/conversations.ts`) y del payload de Realtime (`conversations` ya
  está en `supabase_realtime`, 001). El `UPDATE` de Realtime en
  `src/app/(dashboard)/inbox/page.tsx` hace `{ ...c, ...conv }`, así que las columnas nuevas llegan
  sin tocar la página.
- `NOT VALID`: todas las filas previas son NULL, así que no hay nada que validar, y validarlo
  supondría recorrer la tabla con lock. Igual criterio que el informe de s10.1.
- RLS: no cambia. Las políticas `conversations_select/update` de la 017 siguen valiendo. Un
  agente podría escribir estas columnas desde el navegador, pero solo afectaría a la insignia de
  su propia cuenta y no se factura nada con ellas. No se añade disparador de guarda (ver
  Alternativas).
- `supabase/ci/verify-schema.sql`: bloque `-- 082 -- … -- /082 --` dentro del único `DO`,
  después del bloque de la última migración presente, con las cuatro columnas (consulta a
  `information_schema.columns`) y los dos CHECK (`pg_constraint`).

## Lógica pura: `src/lib/whatsapp/entry-point.ts` (nuevo)

Va fuera de `route.ts` porque Next solo admite exports de handler ahí (el mismo motivo que
`message-charges.ts`).

```ts
export const FREE_WINDOW_HOURS = 72;
export const ENTRY_POINT_SOURCES = ['ctwa_ad', 'ctwa_organic', 'ctwa_other'] as const;
export type EntryPointSource = (typeof ENTRY_POINT_SOURCES)[number];
/** Orígenes que abren ventana gratis (S-E2). Solo anuncios. */
export const FREE_WINDOW_SOURCES: readonly EntryPointSource[] = ['ctwa_ad'];

export interface ParsedReferral {
  source: EntryPointSource;
  /** Lista blanca de R7, cadenas de ≤ 500. */
  referral: Partial<Record<'source_type' | 'source_id' | 'source_url' | 'headline' | 'ctwa_clid', string>>;
}
export function parseReferral(raw: unknown): ParsedReferral | null;

export interface EntryPoint {
  entry_point_source: EntryPointSource;
  entry_point_at: string;          // ISO
  free_window_until: string | null; // ISO
  entry_point_referral: ParsedReferral['referral'];
}
/** R8–R10. Puro: el reloj entra como argumento. */
export function computeEntryPoint(parsed: ParsedReferral, timestamp: unknown, nowMs: number): EntryPoint;

/**
 * R11, R14, R16. Nunca lanza. Escribe solo si `previousAt` (lo que la conversación ya tenía)
 * es NULL o anterior a `ep.entry_point_at`. Si no, devuelve sin escribir.
 * UPDATE conversations SET … WHERE id = conversationId AND account_id = accountId
 *   AND (entry_point_at IS NULL  -> .is('entry_point_at', null)
 *        | entry_point_at = previousAt -> .eq('entry_point_at', previousAt))
 * El filtro optimista sobre el valor leído evita que un entrante más viejo, procesado a la vez,
 * pise a uno más nuevo.
 */
export async function recordEntryPoint(
  admin: SupabaseClient, accountId: string, conversationId: string,
  previousAt: string | null, ep: EntryPoint
): Promise<void>;
```

- `parseReferral`: `typeof raw !== 'object' || raw === null || Array.isArray(raw)` da `null`. El
  `source_type` se lee en minúsculas y recortado.
- `computeEntryPoint`: `Number(timestamp)` debe ser entero finito ≥ 0 y
  `≤ nowMs/1000 + 300`. Si no lo es, se usa `entry_point_at = new Date(nowMs)` y
  `free_window_until = null`. Si lo es y el origen está en `FREE_WINDOW_SOURCES`, la ventana va
  hasta `ts*1000 + 72 h` (justo en el límite del CHECK).
- Errores de `recordEntryPoint`: `console.error('[webhook] entry point update failed:',
  error.message)` sin contenido del mensaje, el teléfono ni el referral.

## Enganche en el webhook: `src/app/api/whatsapp/webhook/route.ts`

- `interface WhatsAppMessage`: añadir `referral?: unknown` con un comentario que cite S-E1
  (`unknown` a propósito: la forma no está verificada y la valida `parseReferral`).
- En `processMessage`, **después** de comprobar `insertedRows` (frontera de idempotencia, R12) y
  justo después de `bump_conversation_on_inbound` y su `if (convError)`, antes de
  `reopenClosedConversation`:

  ```ts
  const referral = parseReferral(message.referral);
  if (referral) {
    try {
      await recordEntryPoint(supabaseAdmin(), accountId, conversation.id,
        conversation.entry_point_at ?? null,
        computeEntryPoint(referral, message.timestamp, Date.now()));
    } catch (err) { console.error('[webhook] entry point update failed:', …); }
  }
  ```

  El `try` es la red de seguridad aunque `recordEntryPoint` no lance (CP11, R14). `conversation`
  viene de `findOrCreateConversation`, que hace `select('*')`, así que `entry_point_at` ya está en
  la fila sin otra consulta. Si la conversación es nueva, es `undefined`, que se trata como NULL.
- Las reacciones salen antes (`message.type === 'reaction'`), así que no pasan por aquí. Es
  correcto: una reacción no abre conversación desde un anuncio.
- No se toca `enforce.ts`, `entitlements.ts` ni nada de la facturación. Lo entrante sigue sin
  mirar el estado de la cuenta (R15).

## Tipo: `src/types/index.ts`

`interface Conversation` gana los campos opcionales `entry_point_source?: 'ctwa_ad' |
'ctwa_organic' | 'ctwa_other' | null`, `entry_point_at?: string | null` y
`free_window_until?: string | null`. `entry_point_referral` no se tipa en el cliente porque no se
muestra.

## Insignia: lógica pura `src/lib/inbox/free-window.ts` (nuevo)

```ts
/** R17. null = sin insignia. */
export function freeWindowUntil(
  conversation: Pick<Conversation, 'free_window_until'>,
  nowMs: number,
  metaBilling: 'direct' | 'managed' | undefined
): Date | null;
```

Devuelve `null` si `metaBilling !== 'direct'`, si `free_window_until` es falsy o `Date.parse` da
`NaN`, o si `≤ nowMs`.

## Reloj: `src/hooks/use-minute-clock.ts` (nuevo)

`useMinuteClock(): number`, con el mismo patrón que `src/hooks/use-presence.ts`
(`useState(() => Date.now())` + `setInterval(() => setNow(Date.now()), 60_000)` en un
`useEffect` con limpieza). Lo usa una vez `ConversationList` y otra `MessageThread`. Nunca
`Date.now()` en el render (regla de pureza de React 19).

## Componente: `src/components/inbox/free-window-badge.tsx` (nuevo)

Presentacional y sin hooks de datos, con la forma de `attention-badge.tsx`:

```tsx
interface FreeWindowBadgeProps { label: string; title: string; className?: string }
export function FreeWindowBadge(props): JSX.Element
// <span data-free-window title={title} className="inline-flex … text-emerald-600 dark:text-emerald-400">
//   <Gift className="h-3 w-3 shrink-0" /> <span className="truncate">{label}</span></span>
```

Icono `Gift` de `lucide-react`, que ya es dependencia (está declarado en
`node_modules/lucide-react/dist/lucide-react.d.ts`). Lleva marca y color a la vez, nunca solo color.

## Montaje

- `src/components/inbox/conversation-list.tsx`:
  - `ConversationList`: `const now = useMinuteClock()`,
    `const metaBilling = useBillingStatus()?.metaBilling` (hook de
    `src/hooks/use-billing-status.ts`, que ya usa `whatsapp-config.tsx`, sin consulta nueva), y
    `const format = useFormatter()` de `next-intl`.
  - Se pasa a `ConversationItem` una prop nueva `freeWindowLabel?: string`, calculada en el padre
    con `freeWindowUntil(conversation, now, metaBilling)` y
    `t('freeWindow.badge', { until: format.dateTime(d, { weekday: 'short', day: 'numeric', hour:
    '2-digit', minute: '2-digit' }) })`. Se usa el namespace `Inbox` con un segundo
    `useTranslations('Inbox.freeWindow')` para no mezclarlo con `conversationList`.
  - En `ConversationItem`, la insignia va en la misma línea que `AttentionBadge` (un
    `flex gap-2`). Si no hay `attention`, va en su propia línea `mt-1`.
- `src/components/inbox/message-thread.tsx`: en la cabecera, justo después del `<Badge>` del
  temporizador de sesión (`sessionInfo`) y con el mismo `hidden sm:inline-flex`, así los teléfonos
  más estrechos conservan sitio para el nombre. Mismo cálculo con `conversation`, `useMinuteClock()`,
  `useBillingStatus()?.metaBilling` y `useFormatter()`.
- No se toca `src/app/(dashboard)/inbox/page.tsx`: el `select('*')` y el merge de Realtime ya
  traen las columnas.

## Claves i18n (es y en, mismo placeholder)

| Clave | en | es |
|---|---|---|
| `Inbox.freeWindow.badge` | `Free window until {until}` | `Ventana gratis hasta {until}` |
| `Inbox.freeWindow.tooltip` | `This customer came from a Click to WhatsApp ad. If you reply within 24 hours of their first message, Meta does not charge for the messages in this conversation until {until}.` | `Este cliente llegó desde un anuncio Click to WhatsApp. Si respondes en las 24 h siguientes a su primer mensaje, Meta no cobra los mensajes de esta conversación hasta {until}.` |

`en` es la fuente de verdad (CP6). Sin `ko`.

## Manejo de errores (resumen)

| Caso | Resultado |
|---|---|
| `referral` ausente o con forma rara | `null`, nada se escribe, el entrante sigue (R6, R13) |
| `timestamp` inválido o futuro | origen guardado, `free_window_until = NULL` (R10) |
| `UPDATE` falla o lanza | `console.error` de una línea; mensaje guardado, 200, resto del pipeline intacto (R14) |
| Repetición de Meta | sin escritura (R12) |
| Entrante con referral más antiguo que el guardado | sin escritura (R11) |
| `metaBilling` desconocido o `managed` | sin insignia (R21) |
| `free_window_until` corrupto en la fila | sin insignia (R17) |

## Tests (sin red)

- `src/lib/whatsapp/entry-point.test.ts`: R5–R10, y `recordEntryPoint` con un cliente falso
  (filtros `id` + `account_id`, `.is` cuando no había valor, `.eq` con el valor previo, sin
  escritura si es más viejo, sin lanzar si Supabase devuelve error o lanza).
- `src/app/api/whatsapp/webhook/route.test.ts`: casos de R11–R15 con payloads sintéticos que
  llevan `referral: { source_type: 'ad', source_id: '123', headline: 'Promo', ctwa_clid: 'x' }`.
- `src/lib/security/tenant-isolation.test.ts`: R16.
- `src/lib/inbox/free-window.test.ts`: R17, R21.
- `src/hooks/use-minute-clock.test.ts`: R20. El repo no tiene jsdom ni testing-library
  (comprobado en `node_modules`), así que el hook exporta `MINUTE_MS` y una función
  `startMinuteClock(setNow): () => void` (el cuerpo del efecto). El test la prueba con
  `vi.useFakeTimers()`: avanza 60 s, se llama a `setNow`, y la limpieza para el intervalo. No se
  añaden dependencias (CP5).
- `src/components/inbox/free-window-badge.test.tsx`: R18/R19 con `renderToStaticMarkup`, como
  `attention-badge.test.tsx`, más paridad de claves y placeholders con `messages/en.json` y
  `es.json` importados.
- `progress/checks_free-entry-point-badge.sql`: R2–R4.

## Alternativas descartadas

- **Guardar en `messages`**: `messages` es la tabla más caliente del entrante, y la insignia es
  de la conversación (la lista no carga mensajes). Habría que hacer un join o desnormalizar igual.
  `conversations` es una fila por contacto y cuenta (índice único de la 036), así que la última
  entrada por anuncio es justo el estado que se muestra.
- **Disparador de guarda como el de la 079** (solo `service_role` escribe): añade un disparador a
  `conversations`, que se actualiza en cada entrante, y un fallo suyo tumbaría el bump (CP11). El
  dato solo pinta una insignia de la propia cuenta y no factura nada, así que el riesgo no
  compensa.
- **Insignia también en orgánico/`ctwa_other`**: descartada por S-E2. Un falso «gratis» cuesta
  dinero y un falso «no gratis» no.
- **Leer la ventana de `message_charges.pricing_type`**: llega después de enviar, que es justo lo
  que la insignia quiere anticipar. Sirve para verificar (guion manual paso 3), no para avisar.
- **Mostrarla en `managed` como informativa**: confunde, porque Cabbity sí le cobra esos mensajes
  (decisión 3 de la fase 10).
- **Un `setInterval` por fila**: N temporizadores por cada render de la lista. Uno por
  componente basta.

## Next 16 / React 19 (CP7)

No se usa ninguna API nueva de framework: componentes cliente existentes (`"use client"` ya
presente en los dos archivos de la bandeja), `useTranslations` y `useFormatter` de `next-intl`
(exportados por `node_modules/next-intl/dist/types/react-client/index.d.ts`) y el route handler
existente sin cambiar su firma. El implementer confirma en
`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` que no hay
aviso de deprecación aplicable al route handler del webhook.
