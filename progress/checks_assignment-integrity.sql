-- Behavioral acceptance check for f0.1 assignment-integrity.
--
-- Run after `KEEP=1 scripts/replay-migrations.sh <worktree>` against the
-- reported local container. Everything is rolled back so it is repeatable.
BEGIN;

DO $$
DECLARE
  v_owner_id uuid := '00000000-0000-0000-0000-000000000401';
  v_agent_id uuid := '00000000-0000-0000-0000-000000000402';
  v_contact_id uuid := '00000000-0000-0000-0000-000000000403';
  v_conversation_id uuid := '00000000-0000-0000-0000-000000000404';
  v_account_id uuid;
BEGIN
  -- The auth trigger creates a personal account/profile for each test user.
  INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
  VALUES
    (v_owner_id, 'authenticated', 'authenticated', 'assignment-owner@example.test', '{}'::jsonb, '{}'::jsonb),
    (v_agent_id, 'authenticated', 'authenticated', 'assignment-agent@example.test', '{}'::jsonb, '{}'::jsonb);

  SELECT account_id
    INTO v_account_id
    FROM profiles
   WHERE user_id = v_owner_id;

  INSERT INTO contacts (id, user_id, account_id, phone, name)
  VALUES (v_contact_id, v_owner_id, v_account_id, '+15550000401', 'Assignment check contact');

  -- The conversation's owner is deliberately not the assigned agent.
  INSERT INTO conversations (id, user_id, account_id, contact_id, assigned_agent_id)
  VALUES (v_conversation_id, v_owner_id, v_account_id, v_contact_id, v_agent_id);

  IF NOT EXISTS (
    SELECT 1
      FROM conversations
     WHERE id = v_conversation_id
       AND user_id = v_owner_id
       AND assigned_agent_id = v_agent_id
  ) THEN
    RAISE EXCEPTION 'test setup did not create an owner conversation assigned to another user';
  END IF;

  -- The agent's bootstrap account would otherwise retain auth.users through
  -- accounts.owner_user_id ON DELETE RESTRICT; it is unrelated to the
  -- owner's conversation and is removed only to model an operator deletion.
  DELETE FROM accounts WHERE owner_user_id = v_agent_id;
  DELETE FROM auth.users WHERE id = v_agent_id;

  -- One predicate proves both required outcomes: the row survived and its
  -- now-deleted assignee was nulled by the 040 foreign key action.
  IF NOT EXISTS (
    SELECT 1
      FROM conversations
     WHERE id = v_conversation_id
       AND user_id = v_owner_id
       AND assigned_agent_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'deleting an assigned agent must preserve the conversation and set assigned_agent_id to NULL';
  END IF;
END
$$;

ROLLBACK;
