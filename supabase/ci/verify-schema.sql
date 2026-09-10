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
