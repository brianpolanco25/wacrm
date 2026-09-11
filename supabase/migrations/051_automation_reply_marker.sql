-- ============================================================
-- 051_automation_reply_marker.sql — Fase 1 (SaaS): constancia de
-- quién respondió automáticamente a CADA mensaje entrante.
--
-- El problema que cierra
-- ----------------------
-- `src/lib/ai/auto-reply.ts` tenía una guarda de alcance equivocado: si
-- la cuenta tenía UNA sola automatización activa con disparador
-- `new_message_received` o `keyword_match`, el agente de IA se callaba
-- en TODA la cuenta. Crear una automatización de palabra clave para
-- contestar «horario» dejaba mudo al agente en todos los chats, en
-- silencio y sin señal en la interfaz.
--
-- La intención sí era correcta: nunca mandar dos respuestas automáticas
-- al mismo mensaje del cliente. Lo que faltaba era el dato — «¿respondió
-- una automatización a ESTE mensaje?» — y esta tabla es ese dato.
--
-- Cómo garantiza el «nunca dos»
-- -----------------------------
-- No es un registro que se consulta: es una RESERVA. Los dos
-- respondedores automáticos (motor de automatizaciones e IA) insertan
-- aquí ANTES de enviar. La clave primaria sobre `message_id` deja que
-- Postgres —no la aplicación— elija un único ganador por mensaje
-- entrante, así que el resultado no depende del orden ni de la latencia
-- de los dos despachos.
--
--   - La PK es `message_id` a secas, NO (account_id, message_id). Con
--     la clave compuesta, dos inserciones con distinto `account_id` no
--     chocarían y la exclusión mutua se perdería. `messages.id` ya es
--     único global; `account_id` viaja al lado porque toda consulta con
--     rol de servicio se filtra por cuenta (no hay RLS que la proteja).
--   - Quien pierde la reserva no envía. Para la IA eso es «abstenerse»;
--     el motor de automatizaciones reserva pero ignora el resultado —
--     las automatizaciones son deterministas y configuradas por el
--     usuario, así que siempre ganan sobre el modelo.
--   - Dirección del fallo: ante un error de base se asume «ya hay
--     respuesta» y no se envía. Se prefiere responder de menos a
--     responder dos veces.
--
-- Borrados en cascada
-- -------------------
-- Las dos cascadas apuntan de padre a hijo y solo borran esta marca
-- derivada; ninguna puede borrar datos de clientes:
--   - `message_id` → `messages(id)`: al borrarse la conversación (y con
--     ella el mensaje) la marca deja de tener sentido. Es la recogida de
--     basura de la tabla, sin cron.
--   - `account_id` → `accounts(id)`: mismo criterio y misma forma que el
--     resto del esquema multiempresa (017).
--   - `automation_id` → `ON DELETE SET NULL`: es una pista de auditoría;
--     borrar la automatización no puede liberar la reserva, o el mensaje
--     quedaría abierto a una segunda respuesta.
--
-- RLS: activada y SIN políticas. Nadie con clave `anon`/`authenticated`
-- lee ni escribe aquí; es estado interno del despacho del webhook, que
-- corre con `service_role` (que salta la RLS por definición). El patrón
-- deliberado es el de `checkout_intents`, pero más estricto: aquí no hay
-- nada que enseñar en la interfaz.
--
-- Idempotente — safe to re-run: CREATE TABLE/INDEX IF NOT EXISTS,
-- restricciones creadas solo si faltan, ENABLE ROW LEVEL SECURITY es
-- idempotente por sí mismo.
-- ============================================================

CREATE TABLE IF NOT EXISTS inbound_auto_replies (
  -- Identidad y candado a la vez: un mensaje entrante, una respuesta
  -- automática.
  message_id UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  responder TEXT NOT NULL,
  automation_id UUID REFERENCES automations(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Quién reservó. Con CHECK explícito porque el valor lo escribe código de
-- servidor y un typo silencioso ('automations') convertiría la marca en
-- inútil para el diagnóstico.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'inbound_auto_replies_responder_check'
      AND conrelid = 'public.inbound_auto_replies'::regclass
  ) THEN
    ALTER TABLE inbound_auto_replies
      ADD CONSTRAINT inbound_auto_replies_responder_check
      CHECK (responder IN ('automation', 'ai'));
  END IF;
END
$$;

-- Lecturas y purgas por cuenta («qué respondió la cuenta X y cuándo»).
CREATE INDEX IF NOT EXISTS idx_inbound_auto_replies_account_created
  ON inbound_auto_replies(account_id, created_at DESC);

ALTER TABLE inbound_auto_replies ENABLE ROW LEVEL SECURITY;
