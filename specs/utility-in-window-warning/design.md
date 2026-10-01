# p11.5 `utility-in-window-warning` — diseño

Leído contra `feat/precios-meta-directo` @ be8ca0f. Rutas y funciones citadas existen en esa rama
salvo las marcadas **(nuevo)**.

## Rama

Worktree hijo `pmd/template-window` en `.claude/worktrees/pmd-template-window`, desde be8ca0f. No
comparte archivos con p11.3 ni p11.4: se puede lanzar en paralelo.

## Supuestos sin verificar (Meta) — los confirma el humano

Fuente única en el repo: el encabezado de `progress/spec_facturacion-gestionada.md` (servicio:
1.000 gratis por número y mes, luego a tarifa de utilidad; RD en «Resto de Latinoamérica»: 0,0113
servicio/utilidad, 0,0740 marketing). No se consultó la web.

| Id | Supuesto | Efecto si es falso |
|---|---|---|
| S-U1 | Una plantilla de **utilidad** entregada dentro de la ventana de atención abierta se cobra a tarifa de utilidad y no consume ni aprovecha la cuota gratis de servicio. **Riesgo conocido**: en el modelo anterior de Meta, la utilidad dentro de la ventana era gratis; si eso sigue vigente tras el 01-10, el aviso de utilidad es falso. | `WARN_UTILITY_IN_WINDOW = false` (R5) apaga solo ese aviso; el de marketing sigue. |
| S-U2 | Una plantilla de **marketing** se cobra a tarifa de marketing también dentro de la ventana. | El aviso de marketing exageraría; se retira igual que el de utilidad. |
| S-U3 | La ventana de atención dura 24 h desde el último mensaje del cliente y la abre solo un mensaje del cliente. | `SAFE_WINDOW_MS` es una constante. |
| S-U4 | El cron de automatizaciones (`/api/automations/cron`) reanuda un `wait` con menos de 1 h de retraso. | Con más retraso, un paso tras un `wait` de 22 h podría salir con la ventana ya cerrada; el aviso solo sugiere un texto, no lo cambia, así que el error sería un consejo malo, no un envío fallido. |

## Función pura: `src/lib/automations/template-window.ts` (nuevo)

Sin imports de valor (solo `import type` de `@/types`), para que la use un componente cliente sin
arrastrar código de servidor. Por eso no importa `waitMs` del motor (privado y en un módulo que
importa `supabaseAdmin`) ni la constante de p11.3 (`src/lib/billing/service-cap.ts`, de servidor).

```ts
import type { AutomationTriggerType, WaitStepConfig } from '@/types';

/** S-U1. Ponerlo a false si Meta confirma que la utilidad en ventana es gratis. */
export const WARN_UTILITY_IN_WINDOW = true;
/** S-U3/S-U4: 24 h de ventana menos 1 h de margen para el cron. */
export const SAFE_WINDOW_MS = 23 * 60 * 60 * 1000;
/** Igual que SERVICE_FREE_TIER_PER_NUMBER de p11.3; aquí solo para el texto. Unificar si cambia. */
export const FREE_SERVICE_MESSAGES_PER_NUMBER = 1000;

export const OPEN_WINDOW_TRIGGERS: readonly AutomationTriggerType[] = [
  'new_message_received', 'first_inbound_message', 'keyword_match',
  'interactive_reply', 'new_contact_created',
];

export type TemplateWindowWarning = 'utility' | 'marketing';

export interface WindowStep {            // lo mínimo de BuilderStep
  cid: string;
  step_type: string;
  step_config: Record<string, unknown>;
  branches?: { yes: WindowStep[]; no: WindowStep[] };
}
export interface WindowTemplate { name: string; language?: string | null; category: string }

export function waitDurationMs(cfg: Partial<WaitStepConfig>): number;
// Igual que waitMs del motor: days 86_400_000, hours 3_600_000, si no 60_000; Math.max(1_000, amount * unit).
// amount no numérico o negativo → 1_000 (lo que haría el motor con Math.max).

export function templateWindowWarnings(
  triggerType: AutomationTriggerType,
  steps: WindowStep[],
  templates: WindowTemplate[],
  opts?: { warnUtility?: boolean }       // por defecto WARN_UTILITY_IN_WINDOW
): Map<string, TemplateWindowWarning>;
```

Algoritmo: si el disparador no está en `OPEN_WINDOW_TRIGGERS`, mapa vacío. Si no, recorrido en
orden con `elapsed` (ms acumulados):

- `wait` → `elapsed += waitDurationMs(cfg)`.
- `condition` → recorrer `branches.yes` y `branches.no` con el `elapsed` actual (cada rama devuelve
  su propio total); al volver, `elapsed = max(totalYes, totalNo)`. El máximo es conservador con lo
  que hace hoy el motor (los pasos del padre tras una condición salen sin esperar a la rama, deuda
  anotada abajo) y con lo que haría si se corrige.
- `send_template` con `elapsed < SAFE_WINDOW_MS` → buscar la plantilla con `name ===
  cfg.template_name` y `(language ?? 'en_US') === (cfg.language || 'en_US')` (misma clave que
  `SendTemplateFields`); `category === 'Utility'` → `'utility'` si `warnUtility`; `'Marketing'` →
  `'marketing'`; resto, nada.

Las categorías vienen como `'Marketing' | 'Utility' | 'Authentication'` porque así las guarda
`normalizeCategory` de `src/lib/whatsapp/template-sync.ts` (CHECK de `message_templates.category`
en `001_initial_schema.sql`). Lo desconocido no avisa.

## UI: `src/components/automations/automation-builder.tsx`

- Los datos ya están: `ResourcesProvider` carga las plantillas `APPROVED` de la cuenta con `select("*")`
  (incluye `category`), y `useBillingStatus()` (`src/hooks/use-billing-status.ts`) da `metaBilling`
  sin petición propia. **Sin consulta nueva.**
- Contexto nuevo `TemplateWindowContext` (`Map<cid, TemplateWindowWarning>`), calculado con
  `useMemo(() => templateWindowWarnings(state.trigger_type, state.steps, templates), […])` dentro de
  un componente hijo de `ResourcesProvider` (para leer `useResources().templates`), que envuelve el
  contenido actual de la línea `<ResourcesProvider>` … `</ResourcesProvider>`. Se recalcula solo al
  cambiar disparador, pasos o plantillas (R10).
- En `StepEditor`, `case "send_template"`: tras `<SendTemplateFields …/>`, `<TemplateWindowNotice
  kind={warnings.get(step.cid)} metaBilling={metaBilling} />`.
- En `StepRenderer`, en la cabecera plegada junto a `previewFor(step)`: `<TemplateWindowBadge />`
  si hay aviso (icono `AlertTriangle` de `lucide-react`, `text-amber-500`, `aria-label` y `title`
  con `t('templateWindow.badge')`).

### `src/components/automations/template-window-notice.tsx` (nuevo)

`TemplateWindowNotice({ kind, metaBilling })` y `TemplateWindowBadge()`: presentacionales, sin
efectos. `Alert` de `src/components/ui/alert.tsx` con la variante por defecto (no `destructive`):
es un consejo. Exporta también el proveedor del contexto y su hook para poder probarlos aislados
(R10). Si el implementer prefiere dejar el proveedor dentro de `automation-builder.tsx`, el test de
R10 renderiza `AutomationBuilder` con `ResourcesProvider` mockeado.

## Claves i18n (`Automations.builder.templateWindow.*`, es y en)

- `title` — «Ventana de atención abierta»
- `utility` — «Esta automatización responde a un mensaje del cliente: un mensaje de texto normal
  cuesta lo mismo o menos que esta plantilla de utilidad.»
- `marketing` — «Esta automatización responde a un mensaje del cliente: esta plantilla se cobra a
  tarifa de marketing, la más cara. Un mensaje de texto normal cuesta menos.»
- `quotaNote` — «Las plantillas no entran en los {freeTier, number} mensajes de servicio gratis del
  mes.»
- `badge` — «Plantilla con la ventana abierta: puede costar más que un texto»

`en` es la fuente de verdad (CP6); el implementer redacta el inglés con el mismo sentido.

## Manejo de errores

No hay red ni base en este camino. Plantillas aún sin cargar → mapa vacío (sin aviso, sin
parpadeo de error). `useBillingStatus()` en `null` → se trata como `direct` (sale la frase de la
cuota, que es la de más clientes).

## Next 16

Solo componentes cliente existentes (`"use client"` ya en `automation-builder.tsx`); ninguna API
de framework nueva. React 19: el cálculo va en `useMemo`, sin `Date.now()` en render.

## Deuda detectada (fuera de alcance, no se toca)

`executeStepsFrom` (`src/lib/automations/engine.ts`): un `wait` dentro de una rama de `condition`
suspende solo la rama; el bucle del padre sigue y ejecuta en el acto los pasos posteriores a la
condición. Probablemente no es lo que espera el autor. Se anota para el humano.

## Alternativas descartadas

- **Aviso en el servidor al guardar** (`src/lib/automations/validate.ts`): convertiría un consejo en
  un error o en un campo nuevo de la respuesta; el encargo es solo UI.
- **Contar «ventana abierta» por la última actividad real del contacto**: depende de cada
  conversación, no del diseño de la automatización; en el builder no hay contacto.
- **Avisar en todos los disparadores**: con `tag_added` o `time_based` la ventana puede estar
  cerrada y la plantilla es la única forma de escribir; el aviso sería un mal consejo.
- **Nodo de plantilla en flujos para avisar ahí también**: es una feature nueva, no un aviso.
