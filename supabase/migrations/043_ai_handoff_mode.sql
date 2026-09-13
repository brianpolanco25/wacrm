-- ============================================================
-- 043_ai_handoff_mode.sql — Fase 1 (SaaS): modo de cesión y mensaje de
-- transición del agente de IA.
--
-- 1. `ai_configs.handoff_mode` — a quién cede la IA cuando el modelo
--    emite el centinela de cesión:
--      'fixed' → a la persona de `handoff_agent_id` (el comportamiento
--                que había cuando ese campo estaba relleno).
--      'queue' → a nadie: la conversación queda en la cola común.
--      'auto'  → al operador disponible con menos carga, vía
--                `pick_available_agent` (042). Si no hay nadie
--                conectado se comporta como 'queue'.
--
--    El backfill preserva el comportamiento actual de cada cuenta:
--    'fixed' si ya tenía un `handoff_agent_id`, 'queue' si no. Se hace
--    dentro del mismo bloque que crea la columna para que una
--    re-ejecución de la migración no pise una elección posterior del
--    administrador (p. ej. una cuenta que eligió 'queue' pero conserva
--    el agente configurado).
--
-- 2. `ai_configs.handoff_message` — texto que la IA envía al cliente
--    justo antes de ceder. Hoy la cesión ocurre en silencio: el texto
--    del modelo queda vacío y, desde fuera, el negocio simplemente dejó
--    de contestar. La cuenta lo edita en Ajustes → IA, y si lo deja
--    vacío no se envía nada (comportamiento actual, elegido a
--    propósito). Este mensaje NO consume cupo de respuesta
--    (`claim_ai_reply_slot`) ni cuenta como respuesta de IA: es un
--    acuse, no una respuesta.
--
--    DECISIÓN sobre el sembrado (fase 1, §2 pide «texto por defecto
--    sembrado en la migración y editable en Ajustes → IA»):
--
--    a) El DEFAULT se mantiene, y en PostgreSQL 11+ un `ADD COLUMN …
--       DEFAULT` rellena también las filas ya existentes. Es
--       deliberado: el objetivo de §2 es que ninguna cesión ocurra en
--       silencio, y una cuenta que ya tenía la IA configurada es
--       exactamente la que hoy está dejando clientes sin respuesta.
--       Consecuencia asumida y anotada en CHANGELOG: tras aplicar esta
--       migración, una cuenta existente empieza a enviar el aviso en su
--       siguiente cesión. Para desactivarlo se vacía el campo en
--       Ajustes → IA (la cadena vacía es un opt-out explícito).
--    b) El texto va en INGLÉS, no en español: el producto solo tiene
--       catálogos `messages/en.json` y `messages/ko.json`, `en` es el
--       locale por defecto, y sembrar en un idioma que la interfaz no
--       ofrece dejaría a la cuenta enviando a sus clientes un texto que
--       ni siquiera puede leer en su propio panel. Es idéntico al
--       `Settings.aiConfig.handoffMessagePlaceholder` de `en.json` y a
--       `DEFAULT_HANDOFF_MESSAGE` (`src/lib/ai/handoff-message.ts`),
--       que es lo que el formulario propone en un alta nueva; hay un
--       test que ata las tres copias (`handoff-message.test.ts`).
--
-- Idempotente — el bloque DO comprueba la existencia de la columna, la
-- otra usa ADD COLUMN IF NOT EXISTS, y la CHECK se suelta y se vuelve a
-- crear.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'ai_configs'
       AND column_name  = 'handoff_mode'
  ) THEN
    ALTER TABLE public.ai_configs
      ADD COLUMN handoff_mode text NOT NULL DEFAULT 'queue';

    -- Backfill: quien ya tenía destino fijo sigue teniéndolo.
    UPDATE public.ai_configs
       SET handoff_mode = 'fixed'
     WHERE handoff_agent_id IS NOT NULL;
  END IF;
END $$;

ALTER TABLE public.ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_handoff_mode_check;
ALTER TABLE public.ai_configs
  ADD CONSTRAINT ai_configs_handoff_mode_check
  CHECK (handoff_mode IN ('fixed', 'queue', 'auto'));

ALTER TABLE public.ai_configs
  ADD COLUMN IF NOT EXISTS handoff_message text
    DEFAULT 'Thanks for writing to us. A member of our team will continue this conversation shortly.';
