-- Post-migration assertions for the CI job in
-- `.github/workflows/migrations.yml`.
--
-- `supabase db reset` already fails on any statement Postgres rejects,
-- so this is not about syntax. It's about the quieter failure: a
-- migration that applies cleanly and does nothing. Every DDL statement
-- in this repo is guarded with IF NOT EXISTS / ON CONFLICT so the files
-- can be re-run safely, and that same guard turns a typo'd object name
-- into a silent no-op with a green checkmark.
--
-- Keep this thin. It is a smoke test for "did the migrations actually
-- build the schema", not a spec of it — asserting every column here
-- would just be the migrations restated in a second place, drifting.
DO $$
BEGIN
  -- The core tables, from 001.
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'public.messages is missing — migrations did not apply';
  END IF;
  IF to_regclass('public.whatsapp_config') IS NULL THEN
    RAISE EXCEPTION 'public.whatsapp_config is missing — migrations did not apply';
  END IF;

  -- Supabase provides the storage schema; migrations 016/020/023 write
  -- to it. If it is absent the bucket migrations silently accomplish
  -- nothing, which is precisely the case a plain "no errors" run hides.
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE EXCEPTION
      'storage.buckets is missing — the storage schema was not available when the bucket migrations ran';
  END IF;

  -- Buckets are UPSERTed, so their absence means the INSERT never ran.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'chat-media') THEN
    RAISE EXCEPTION 'the chat-media bucket row was not created (migration 023)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'flow-media') THEN
    RAISE EXCEPTION 'the flow-media bucket row was not created (migration 016)';
  END IF;

  -- Account scoping (017) is load-bearing for every RLS policy.
  IF to_regclass('public.accounts') IS NULL THEN
    RAISE EXCEPTION 'public.accounts is missing — migration 017 did not apply';
  END IF;

  -- Assignment integrity (040): the FK is dropped-then-added, so a typo
  -- in the ADD would leave the column unconstrained with no error.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_assigned_agent_id_fkey'
      AND conrelid = 'public.conversations'::regclass
      AND contype = 'f'
      AND confdeltype = 'n'   -- ON DELETE SET NULL, never CASCADE
  ) THEN
    RAISE EXCEPTION
      'conversations_assigned_agent_id_fkey is missing or not ON DELETE SET NULL (migration 040)';
  END IF;
  IF to_regclass('public.idx_conversations_account_assignee') IS NULL THEN
    RAISE EXCEPTION 'idx_conversations_account_assignee is missing (migration 040)';
  END IF;

  -- Billing model (041): the four tables, the atomic counter RPC, the
  -- seeded catalogue, and RLS on the one table a tenant must never write.
  IF to_regclass('public.plans') IS NULL THEN
    RAISE EXCEPTION 'public.plans is missing (migration 041)';
  END IF;
  IF to_regclass('public.subscriptions') IS NULL THEN
    RAISE EXCEPTION 'public.subscriptions is missing (migration 041)';
  END IF;
  IF to_regclass('public.usage_counters') IS NULL THEN
    RAISE EXCEPTION 'public.usage_counters is missing (migration 041)';
  END IF;
  IF to_regclass('public.billing_events') IS NULL THEN
    RAISE EXCEPTION 'public.billing_events is missing (migration 041)';
  END IF;
  IF to_regprocedure('public.increment_usage(uuid, text, bigint)') IS NULL THEN
    RAISE EXCEPTION 'increment_usage(uuid, text, bigint) is missing (migration 041)';
  END IF;
  -- The seed is an UPSERT, so a typo'd VALUES list would leave the
  -- catalogue empty with a green run.
  IF (SELECT count(*) FROM public.plans) <> 3 THEN
    RAISE EXCEPTION
      'expected exactly 3 rows in plans (inicio/pro/negocio), found % (migration 041)',
      (SELECT count(*) FROM public.plans);
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.subscriptions'::regclass) THEN
    RAISE EXCEPTION 'RLS is not enabled on subscriptions (migration 041)';
  END IF;
  -- Billing rows must never be swept away by deleting an account: both
  -- FKs are dropped-then-added with ON DELETE RESTRICT, so a regression
  -- back to CASCADE (or a typo'd ADD) has to fail loudly here.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'subscriptions_account_id_fkey'
      AND conrelid = 'public.subscriptions'::regclass
      AND contype = 'f'
      AND confdeltype = 'r'   -- ON DELETE RESTRICT, never CASCADE
  ) THEN
    RAISE EXCEPTION
      'subscriptions_account_id_fkey is missing or not ON DELETE RESTRICT (migration 041)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'usage_counters_account_id_fkey'
      AND conrelid = 'public.usage_counters'::regclass
      AND contype = 'f'
      AND confdeltype = 'r'   -- ON DELETE RESTRICT, never CASCADE
  ) THEN
    RAISE EXCEPTION
      'usage_counters_account_id_fkey is missing or not ON DELETE RESTRICT (migration 041)';
  END IF;

  -- Platform AI keys (047): an account may leave its own key empty and
  -- fall back to the deployment's. DROP NOT NULL is a no-op when it has
  -- already run, which is exactly the silent case worth asserting.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ai_configs'
      AND column_name = 'api_key'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'ai_configs.api_key is still NOT NULL (migration 047)';
  END IF;

  -- Who paid for each AI call (047). Without this column platform-funded
  -- spend is indistinguishable from BYO spend and fase 3 cannot bill it.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ai_usage_log'
      AND column_name = 'key_source'
      AND is_nullable = 'NO'
      AND column_default = '''account''::text'
  ) THEN
    RAISE EXCEPTION
      'ai_usage_log.key_source is missing, nullable or lacks the ''account'' default (migration 047)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_usage_log_key_source_check'
      AND conrelid = 'public.ai_usage_log'::regclass
      AND contype = 'c'
  ) THEN
    RAISE EXCEPTION
      'ai_usage_log_key_source_check is missing (migration 047)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'ai_usage_log'
      AND indexname = 'idx_ai_usage_log_account_source_created'
  ) THEN
    RAISE EXCEPTION
      'idx_ai_usage_log_account_source_created is missing (migration 047)';
  END IF;
  -- The playground spends provider tokens too (047 widened 033's domain).
  -- Without this value its rows are rejected and the spend goes unlogged.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_usage_log_mode_check'
      AND conrelid = 'public.ai_usage_log'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%playground%'
  ) THEN
    RAISE EXCEPTION
      'ai_usage_log_mode_check does not accept ''playground'' (migration 047)';
  END IF;

  -- Fase 1 (042/043): the agent picker RPC and the two ai_configs
  -- columns. CREATE OR REPLACE / ADD COLUMN IF NOT EXISTS would hide a
  -- typo'd name behind a green run.
  IF to_regprocedure('public.pick_available_agent(uuid, interval, boolean)') IS NULL THEN
    RAISE EXCEPTION 'pick_available_agent(uuid, interval, boolean) is missing (migration 042)';
  END IF;
  IF has_function_privilege(
    'authenticated',
    'public.pick_available_agent(uuid, interval, boolean)'::regprocedure,
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated must not execute pick_available_agent (migration 042)';
  END IF;
  IF NOT has_function_privilege(
    'service_role',
    'public.pick_available_agent(uuid, interval, boolean)'::regprocedure,
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'service_role must execute pick_available_agent (migration 042)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ai_configs' AND column_name = 'handoff_mode'
  ) THEN
    RAISE EXCEPTION 'ai_configs.handoff_mode is missing (migration 043)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_configs_handoff_mode_check'
      AND conrelid = 'public.ai_configs'::regclass
      AND contype = 'c'
  ) THEN
    RAISE EXCEPTION 'ai_configs_handoff_mode_check is missing (migration 043)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ai_configs' AND column_name = 'handoff_message'
  ) THEN
    RAISE EXCEPTION 'ai_configs.handoff_message is missing (migration 043)';
  END IF;
  -- The seeded default is the feature, not decoration: without it an
  -- account that never opens Settings -> AI keeps handing off in silence.
  -- It is deliberately English (the product ships en/ko catalogues) and
  -- must stay byte-identical to DEFAULT_HANDOFF_MESSAGE in
  -- src/lib/ai/handoff-message.ts.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ai_configs'
      AND column_name = 'handoff_message'
      AND column_default LIKE '%Thanks for writing to us. A member of our team will continue this conversation shortly.%'
  ) THEN
    RAISE EXCEPTION 'ai_configs.handoff_message lost its seeded English default (migration 043)';
  END IF;

  -- Migración 051: la reserva por mensaje entrante que sustituye a la
  -- guarda global «la cuenta tiene automatizaciones → la IA se calla».
  IF to_regclass('public.inbound_auto_replies') IS NULL THEN
    RAISE EXCEPTION 'inbound_auto_replies is missing (migration 051)';
  END IF;
  -- La exclusión mutua ES la clave primaria, y tiene que ser message_id
  -- A SECAS: con (account_id, message_id) dos respondedores con distinta
  -- cuenta no chocarían y el cliente podría recibir dos respuestas.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.inbound_auto_replies'::regclass
      AND contype = 'p'
      AND conkey = ARRAY[
        (SELECT attnum FROM pg_attribute
          WHERE attrelid = 'public.inbound_auto_replies'::regclass
            AND attname = 'message_id')
      ]::smallint[]
  ) THEN
    RAISE EXCEPTION 'inbound_auto_replies must be keyed on message_id alone (migration 051)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'inbound_auto_replies_responder_check'
      AND conrelid = 'public.inbound_auto_replies'::regclass
      AND contype = 'c'
  ) THEN
    RAISE EXCEPTION 'inbound_auto_replies_responder_check is missing (migration 051)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname = 'inbound_auto_replies' AND relrowsecurity
  ) THEN
    RAISE EXCEPTION 'inbound_auto_replies must have RLS enabled (migration 051)';
  END IF;
  -- Sin políticas: es estado interno del webhook, solo lo toca el rol de
  -- servicio. Una política aquí sería una fuga, no una mejora.
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'inbound_auto_replies'
  ) THEN
    RAISE EXCEPTION 'inbound_auto_replies must have no RLS policies (migration 051)';
  END IF;

  -- Migration 044 flips both media buckets private and swaps the public
  -- SELECT policies for account-scoped ones. The UPDATE and the CREATE
  -- POLICY are both guarded, so a typo'd bucket id or policy name would
  -- leave the buckets public with a green run — assert the outcome.
  IF EXISTS (
    SELECT 1 FROM storage.buckets
    WHERE id IN ('chat-media', 'flow-media') AND public IS DISTINCT FROM FALSE
  ) THEN
    RAISE EXCEPTION 'a media bucket is still public (migration 044)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'Members can read chat media' AND cmd = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'the account-scoped chat-media read policy is missing (migration 044)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'Members can read flow media' AND cmd = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'the account-scoped flow-media read policy is missing (migration 044)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname IN ('Chat media is publicly readable', 'Flow media is publicly readable')
  ) THEN
    RAISE EXCEPTION 'a public media read policy survived migration 044';
  END IF;

  -- PayPal catalogue (045): ids per billing cycle.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plans'
      AND column_name = 'provider_plan_id_month'
  ) THEN
    RAISE EXCEPTION 'plans.provider_plan_id_month is missing (migration 045)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plans'
      AND column_name = 'provider_plan_id_year'
  ) THEN
    RAISE EXCEPTION 'plans.provider_plan_id_year is missing (migration 045)';
  END IF;

  -- Checkout intent (048): the table the webhook will use to match an
  -- event with an account and a plan, its uniqueness guard, its
  -- non-destructive FK, and the RLS that keeps tenants out of it.
  IF to_regclass('public.checkout_intents') IS NULL THEN
    RAISE EXCEPTION 'public.checkout_intents is missing (migration 048)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'checkout_intents_provider_subscription_key'
      AND conrelid = 'public.checkout_intents'::regclass
      AND contype = 'u'
  ) THEN
    RAISE EXCEPTION
      'checkout_intents UNIQUE (provider, provider_subscription_id) is missing (migration 048)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'checkout_intents_account_id_fkey'
      AND conrelid = 'public.checkout_intents'::regclass
      AND contype = 'f'
      AND confdeltype = 'r'   -- ON DELETE RESTRICT, never CASCADE
  ) THEN
    RAISE EXCEPTION
      'checkout_intents_account_id_fkey is missing or not ON DELETE RESTRICT (migration 048)';
  END IF;
  IF to_regclass('public.checkout_intents_account_created_idx') IS NULL THEN
    RAISE EXCEPTION 'checkout_intents_account_created_idx is missing (migration 048)';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.checkout_intents'::regclass) THEN
    RAISE EXCEPTION 'RLS is not enabled on checkout_intents (migration 048)';
  END IF;
  -- Write policies here would let a tenant claim someone else's paid
  -- subscription; the only writer is the service role.
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'checkout_intents'
      AND cmd <> 'SELECT'
  ) THEN
    RAISE EXCEPTION
      'checkout_intents has a write policy — only the service role may write it (migration 048)';
  END IF;

  -- Redeeming an invitation (049): the RESTRICT above blocks the
  -- DELETE of the invitee's empty personal account unless
  -- `redeem_invitation()` knows about `checkout_intents`. If a future
  -- migration replaces the function and forgets that clause, accepting
  -- an invitation starts failing with a raw 23503 for anyone who ever
  -- abandoned a checkout.
  IF (
    SELECT prosrc FROM pg_proc
    WHERE oid = 'public.redeem_invitation(text)'::regprocedure
  ) NOT LIKE '%checkout_intents%' THEN
    RAISE EXCEPTION
      'redeem_invitation() does not handle checkout_intents; the RESTRICT FK of 048 will break invitation redemption (migration 049)';
  END IF;

  -- ------------------------------------------------------------
  -- 050: marca de agua del webhook de PayPal.
  -- ------------------------------------------------------------
  -- Sin `last_event_at` el manejador no puede distinguir un evento que
  -- llega tarde de uno nuevo, y un ACTIVATED reentregado reactivaría
  -- una suscripción cancelada.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'subscriptions'
      AND column_name = 'last_event_at'
  ) THEN
    RAISE EXCEPTION 'subscriptions.last_event_at is missing (migration 050)';
  END IF;
  -- La cola de reconciliación: eventos verificados que no se pudieron
  -- aplicar quedan con processed_at NULL y `error` puesto.
  IF to_regclass('public.billing_events_unprocessed_idx') IS NULL THEN
    RAISE EXCEPTION 'billing_events_unprocessed_idx is missing (migration 050)';
  END IF;

  -- ------------------------------------------------------------
  -- 046: la prueba de 14 días.
  -- ------------------------------------------------------------
  -- Sin el trigger, una cuenta nueva nace sin fila en `subscriptions`:
  -- sigue funcionando (la capa de permisos la resuelve al plan `pro`)
  -- pero nadie puede decirle cuándo termina su prueba.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.accounts'::regclass
      AND tgname = 'on_account_created_seed_trial'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION
      'on_account_created_seed_trial is missing on accounts (migration 046)';
  END IF;

  IF to_regprocedure('public.seed_account_trial()') IS NULL THEN
    RAISE EXCEPTION 'seed_account_trial() is missing (migration 046)';
  END IF;

  IF to_regprocedure('public.trial_period()') IS NULL THEN
    RAISE EXCEPTION 'trial_period() is missing (migration 046)';
  END IF;

  -- La prueba tiene que apuntar a un plan que exista en el catálogo, o
  -- el trigger falla en silencio (su bloque EXCEPTION solo avisa) y
  -- cada alta nace sin suscripción.
  IF NOT EXISTS (SELECT 1 FROM plans WHERE id = 'pro') THEN
    RAISE EXCEPTION
      'the trial plan ''pro'' is missing from the catalogue (migrations 041 + 046)';
  END IF;

  -- ------------------------------------------------------------
  -- 052: redeem_invitation() frente a la semilla de pruebas.
  -- ------------------------------------------------------------
  -- 046 pone una fila en `subscriptions` por CADA cuenta y 041 la ata
  -- con ON DELETE RESTRICT. Si una migración futura reemplaza
  -- `redeem_invitation()` y se deja estas dos tablas fuera, aceptar una
  -- invitación deja de funcionar para todo el mundo con un 23503 en
  -- crudo — no es un caso raro, es el camino normal.
  IF (
    SELECT prosrc FROM pg_proc
    WHERE oid = 'public.redeem_invitation(text)'::regprocedure
  ) NOT LIKE '%subscriptions%' THEN
    RAISE EXCEPTION
      'redeem_invitation() does not handle subscriptions; the RESTRICT FK of 041 plus the trial seed of 046 break invitation redemption (migration 052)';
  END IF;

  IF (
    SELECT prosrc FROM pg_proc
    WHERE oid = 'public.redeem_invitation(text)'::regprocedure
  ) NOT LIKE '%usage_counters%' THEN
    RAISE EXCEPTION
      'redeem_invitation() does not handle usage_counters; the RESTRICT FK of 041 breaks invitation redemption (migration 052)';
  END IF;

  -- ------------------------------------------------------------
  -- 056: ciclo de facturación y el índice de recibos (§6).
  -- ------------------------------------------------------------
  -- Sin `subscriptions.cycle`, un cliente que pasa de mensual a anual
  -- con el `revise` de PayPal sigue renovándose por el ciclo con el que
  -- CONTRATÓ: paga un año y se le extiende un mes.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'subscriptions'
      AND column_name = 'cycle' AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION
      'subscriptions.cycle is missing or not text (migration 056)';
  END IF;

  -- La restricción es lo que impide que un ciclo inventado ('week')
  -- entre por una escritura futura y haga que la renovación no sepa
  -- cuánto extender.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.subscriptions'::regclass
      AND conname = 'subscriptions_cycle_check'
  ) THEN
    RAISE EXCEPTION
      'subscriptions_cycle_check is missing (migration 056)';
  END IF;

  -- Los recibos de §6 se buscan por el `billing_agreement_id` que vive
  -- dentro del payload. Sin este índice parcial la consulta recorre la
  -- bitácora entera de todos los inquilinos en cada carga de Ajustes.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'billing_events_sale_subscription_idx'
  ) THEN
    RAISE EXCEPTION
      'billing_events_sale_subscription_idx is missing (migration 056)';
  END IF;

  -- ------------------------------------------------------------
  -- 053: varios números por empresa (fase 4 §1, f4.2).
  -- ------------------------------------------------------------
  -- El UNIQUE(account_id) de la 017 tiene que haber DESAPARECIDO: si
  -- sigue ahí, conectar un segundo número revienta con 23505 y toda la
  -- feature es decorativa.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.whatsapp_config'::regclass
      AND conname = 'whatsapp_config_account_id_key'
  ) THEN
    RAISE EXCEPTION
      'whatsapp_config_account_id_key still exists — migration 053 did not drop the one-number-per-account UNIQUE';
  END IF;

  -- Y el UNIQUE GLOBAL de la 013 tiene que SEGUIR ahí. Es lo que hace
  -- que un `phone_number_id` entrante resuelva a un único dueño; su
  -- pérdida devolvería el issue #136 (mensajes entrantes descartados
  -- en silencio) y sería carísima de detectar.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.whatsapp_config'::regclass
      AND conname = 'whatsapp_config_phone_number_id_key'
  ) THEN
    RAISE EXCEPTION
      'whatsapp_config_phone_number_id_key is missing — migration 053 must NOT touch the global UNIQUE of 013';
  END IF;

  -- Destino de ON CONFLICT del upsert idempotente (f4.1).
  IF to_regclass('public.whatsapp_config_account_phone_key') IS NULL THEN
    RAISE EXCEPTION
      'whatsapp_config_account_phone_key is missing (migration 053)';
  END IF;

  -- Un solo predeterminado por cuenta, garantizado por la base.
  IF to_regclass('public.whatsapp_config_one_default_per_account') IS NULL THEN
    RAISE EXCEPTION
      'whatsapp_config_one_default_per_account is missing (migration 053)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'whatsapp_config'
      AND column_name = 'is_default'
  ) THEN
    RAISE EXCEPTION 'whatsapp_config.is_default is missing (migration 053)';
  END IF;

  -- Las dos columnas de enrutado y, sobre todo, el modo de borrado de
  -- sus claves foráneas: `n` = SET NULL. Un CASCADE aquí borraría las
  -- conversaciones o las campañas del cliente al desconectar un número
  -- (CP2), y es el tipo de error que solo se descubre en producción.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.conversations'::regclass
      AND contype = 'f'
      AND confrelid = 'public.whatsapp_config'::regclass
      AND confdeltype = 'n'
  ) THEN
    RAISE EXCEPTION
      'conversations.whatsapp_config_id is missing or its FK is not ON DELETE SET NULL (migration 053)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.broadcasts'::regclass
      AND contype = 'f'
      AND confrelid = 'public.whatsapp_config'::regclass
      AND confdeltype = 'n'
  ) THEN
    RAISE EXCEPTION
      'broadcasts.whatsapp_config_id is missing or its FK is not ON DELETE SET NULL (migration 053)';
  END IF;

  -- Registro integrado (054). Las tres columnas son ADD COLUMN IF NOT
  -- EXISTS, así que un nombre mal escrito aplicaría en verde y dejaría
  -- la ruta guardando en una columna que no existe.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'whatsapp_config'
      AND column_name = 'registration_pin'
  ) THEN
    RAISE EXCEPTION 'whatsapp_config.registration_pin is missing (migration 054)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'whatsapp_config'
      AND column_name = 'token_expires_at'
  ) THEN
    RAISE EXCEPTION 'whatsapp_config.token_expires_at is missing (migration 054)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'whatsapp_config'
      AND column_name = 'provisioned_via'
      AND is_nullable = 'NO'
      AND column_default LIKE '%manual%'
  ) THEN
    RAISE EXCEPTION
      'whatsapp_config.provisioned_via is missing, nullable or not defaulted to manual (migration 054)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.whatsapp_config'::regclass
      AND conname = 'whatsapp_config_provisioned_via_check'
      AND contype = 'c'
  ) THEN
    RAISE EXCEPTION
      'whatsapp_config_provisioned_via_check is missing (migration 054)';
  END IF;

  -- El índice único (account_id, contact_id) de la 036 se MANTIENE:
  -- f4.2 decidió no partir conversaciones por número.
  IF to_regclass('public.idx_conversations_account_contact') IS NULL THEN
    RAISE EXCEPTION
      'idx_conversations_account_contact is missing — 036 must survive 053';
  END IF;

  RAISE NOTICE 'schema verification passed';
END
$$;

-- Two things this file has already been burned by, both verified in CI
-- rather than assumed:
--
-- 1. It must contain EXACTLY ONE statement. `supabase db query --file`
--    sends the whole file as a prepared statement, and a second
--    top-level statement fails with the distinctly unhelpful "cannot
--    insert multiple commands into a prepared statement" (commit
--    f91a6c8). Add assertions INSIDE the DO block above; do not append
--    a second one.
--
-- 2. A RAISE in here really does fail the job. A deliberately false
--    assertion (commit 42c7db0, run 31579334056) surfaced as
--    `failed to execute query: error: ...` and exited 1. This is not a
--    decorative green tick.
