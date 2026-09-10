# Fase 0 — Cimientos

**Peso**: 1 semana · **Bloquea**: todas las demás fases

Pone la base de datos y los ayudantes de servidor que las fases 1 y 3
necesitan, sin cambiar todavía ningún comportamiento visible. Al terminar
esta fase la aplicación se comporta exactamente igual que antes.

## Objetivo

1. Arreglar la columna de asignación de conversaciones, que hoy es una
   referencia suelta sin integridad.
2. Crear el modelo de facturación y el ayudante de permisos, **sin
   aplicar límites todavía**.

## Fuera de alcance

- Aplicar cuotas o bloquear nada por plan. Eso es la fase 3.
- Integrar PayPal. Solo se crea el modelo, agnóstico a la pasarela.
- Tocar la interfaz.

## 1. Integridad de la asignación

### Problema

`conversations.assigned_agent_id` se creó en `001_initial_schema.sql`
como `UUID` a secas: sin `REFERENCES`, sin índice.

Dos consecuencias reales:

- Al expulsar a un operador de la empresa, sus conversaciones quedan
  apuntando a un usuario que ya no existe. La interfaz muestra
  «Asignado» sin nombre, y no hay forma de reasignarlas en bloque.
- Cualquier consulta del tipo «mis chats» o «chats sin asignar» hace
  recorrido de tabla.

### Migración `040_conversation_assignment_integrity.sql`

```sql
-- Limpiar referencias huérfanas antes de imponer la restricción.
UPDATE conversations c
   SET assigned_agent_id = NULL
 WHERE c.assigned_agent_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = c.assigned_agent_id);

ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_assigned_agent_id_fkey;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_assigned_agent_id_fkey
  FOREIGN KEY (assigned_agent_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- La consulta caliente es "conversaciones de esta empresa por asignado",
-- incluida la variante "sin asignar" (assigned_agent_id IS NULL).
CREATE INDEX IF NOT EXISTS idx_conversations_account_assignee
  ON conversations(account_id, assigned_agent_id);
```

`ON DELETE SET NULL` y no `CASCADE`: borrar a un operador **nunca** puede
borrar conversaciones de clientes. La conversación vuelve a la cola sin
asignar, que es el comportamiento correcto.

### Criterios de aceptación

- [ ] Borrar un usuario de `auth.users` deja sus conversaciones con
      `assigned_agent_id IS NULL` y no borra ninguna fila de
      `conversations`.
- [ ] `migrations.yml` pasa contra una base limpia.
- [ ] `supabase/ci/verify-schema.sql` comprueba que la restricción y el
      índice existen.

## 2. Modelo de facturación

Cuatro tablas. La pasarela queda detrás de una columna `provider` para
que añadir tarjetas más adelante sea aditivo y no una reescritura.

### Migración `041_billing_model.sql`

```sql
-- Catálogo. Se siembra desde la migración; el inquilino no lo edita.
CREATE TABLE IF NOT EXISTS plans (
  id                text PRIMARY KEY,          -- 'inicio' | 'pro' | 'negocio'
  name              text NOT NULL,
  price_usd_month   numeric(10,2) NOT NULL,
  price_usd_year    numeric(10,2),
  limits            jsonb NOT NULL DEFAULT '{}'::jsonb,
  features          text[] NOT NULL DEFAULT '{}',
  is_public         boolean NOT NULL DEFAULT true,
  sort_order        integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS subscriptions (
  account_id               uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  plan_id                  text NOT NULL REFERENCES plans(id),
  provider                 text NOT NULL DEFAULT 'paypal',
  provider_subscription_id text UNIQUE,
  status                   text NOT NULL DEFAULT 'trialing'
                             CHECK (status IN ('trialing','active','past_due',
                                               'suspended','cancelled','expired')),
  trial_ends_at            timestamptz,
  current_period_end       timestamptz,
  grace_until              timestamptz,
  cancel_at_period_end     boolean NOT NULL DEFAULT false,
  addons                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- Contadores de consumo del ciclo. Una fila por métrica y periodo.
CREATE TABLE IF NOT EXISTS usage_counters (
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  metric       text NOT NULL,      -- 'messages_out'|'ai_replies'|'broadcast_recipients'
  period_start date NOT NULL,
  value        bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, metric, period_start)
);

-- Bitácora de eventos de la pasarela. `provider_event_id` único es la
-- idempotencia: PayPal reenvía eventos y no podemos procesarlos dos veces.
CREATE TABLE IF NOT EXISTS billing_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          text NOT NULL,
  provider_event_id text NOT NULL,
  event_type        text NOT NULL,
  payload           jsonb NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  error             text,
  UNIQUE (provider, provider_event_id)
);
```

### RLS

- `plans`: lectura para cualquier usuario autenticado (es el catálogo
  público). Sin escritura desde el cliente.
- `subscriptions`: lectura para miembros de la cuenta
  (`is_account_member(account_id)`). **Sin escritura desde el cliente
  bajo ninguna circunstancia** — solo el rol de servicio, desde el
  webhook de la pasarela. Un inquilino que pueda escribir su propia
  suscripción se regala el plan Negocio.
- `usage_counters`: lectura para `admin`+. Escritura solo por RPC.
- `billing_events`: sin acceso desde el cliente.

### Incremento atómico

Mismo patrón que `claim_ai_reply_slot`, que ya existe en el repo: la
comprobación y el incremento ocurren en una sola sentencia para que dos
peticiones simultáneas no puedan pasarse del límite.

```sql
CREATE OR REPLACE FUNCTION increment_usage(
  p_account_id uuid,
  p_metric     text,
  p_delta      bigint DEFAULT 1
) RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO usage_counters (account_id, metric, period_start, value)
  VALUES (p_account_id, p_metric, date_trunc('month', now())::date, p_delta)
  ON CONFLICT (account_id, metric, period_start)
  DO UPDATE SET value = usage_counters.value + EXCLUDED.value
  RETURNING value;
$$;
```

El periodo se ancla al mes natural y no al ciclo de facturación del
cliente, a propósito: es más simple de razonar y de auditar. Si más
adelante hay que alinearlo al ciclo, se cambia aquí y en un solo sitio.

### Semilla de planes

Los tres planes con sus límites y prestaciones, tal como quedaron en el
resumen ejecutivo. Los números son revisables **hasta** que haya un
cliente pagando; después, cambiarlos a la baja rompe contratos.

Prestaciones que se declaran en `features`:
`ai_autoreply`, `ai_knowledge`, `auto_assign`, `api`, `webhooks`,
`multi_number`, `priority_support`.

Límites que se declaran en `limits`:
`operators`, `contacts`, `messages_out`, `ai_replies`,
`broadcast_recipients`, `knowledge_documents`, `numbers`,
`retention_months`.

## 3. Capa de permisos

Módulo nuevo: `src/lib/billing/entitlements.ts`.

```ts
export interface Entitlements {
  planId: string
  status: SubscriptionStatus
  limits: Record<string, number | null>   // null = sin límite
  features: string[]
  /** Solo lectura: la suscripción venció y pasó la gracia. */
  readOnly: boolean
}

export async function getEntitlements(accountId: string): Promise<Entitlements>
export function hasFeature(e: Entitlements, feature: string): boolean
export async function assertQuota(accountId: string, metric: string, n?: number): Promise<void>
```

En esta fase se **crea y se prueba, pero no se llama desde ninguna ruta**.
Cablearla es la fase 3. Separarlo así permite revisar el modelo sin
arriesgar una regresión en producción.

Una cuenta sin fila en `subscriptions` resuelve al plan de prueba con
estado `trialing`. Ninguna cuenta existente se queda sin permisos por
efecto de esta migración.

### Criterios de aceptación

- [ ] `getEntitlements` devuelve el plan de prueba para una cuenta sin
      suscripción.
- [ ] `assertQuota` lanza cuando el contador supera el límite y no lanza
      cuando el límite es `null`.
- [ ] `increment_usage` es correcto bajo concurrencia: 100 llamadas
      simultáneas dejan el contador exactamente en 100.
- [ ] Un usuario autenticado **no** puede escribir en `subscriptions`
      (prueba contra la RLS, no solo contra la ruta).
- [ ] La aplicación se comporta igual que antes de la fase: ninguna ruta
      cambia de respuesta.

## 4. Decisión a cerrar en esta fase

**Supuesto S1 — la IA la paga el servicio.** Si se confirma, hace falta
además:

- Una clave del proveedor de modelos a nivel de plataforma, como variable
  de entorno, usada cuando la cuenta no trae la suya.
- `ai_configs.api_key` pasa a ser opcional.
- La métrica `ai_replies` empieza a contar en la fase 1 aunque no se
  aplique el límite hasta la fase 3, para tener datos reales con los que
  fijar las cuotas durante la beta.

Coste adicional estimado: 3 días dentro de esta misma fase.
