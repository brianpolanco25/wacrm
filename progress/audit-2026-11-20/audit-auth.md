# Audit: auth, authorization, tenant isolation (wacrm)

Read-only. Nothing in the repo was changed. No tests/build were run; every finding comes from reading the code and its callers. Paths are relative to `/mnt/nvme-big/Dev/apps/cabbity/wacrm`.

Overall: the route layer is in good shape. Every `/api/platform/**` route goes through `requirePlatformAdmin` (the two statement routes via `handleSettle`), every `/api/v1/**` route through `requireApiKey` with a scope, every `/api/account/**` route through `requireRole`/`getCurrentAccount`; service-role queries I read all carry `account_id`; cron endpoints answer 503 when the secret is unset and compare in constant time; tokens/keys use `randomBytes(32)`; `next=` is validated twice. All 60 tables have RLS enabled. The real holes are on the **database side, reachable by calling Supabase directly with the public anon key**, which the route-level tests cannot see.

---

## 1. A tenant can make themselves a platform operator by rewriting their own `profiles.email`

- **Severity:** must — **Confidence:** high (code path verified end to end; needs one operator action to trigger)
- **Where:** `src/lib/platform/provisioning.ts:67-88` (`findProfileByEmail`), `src/app/api/platform/operators/route.ts:97-112`, `supabase/migrations/017_account_sharing.sql:614-616` (`profiles_update`), `supabase/migrations/034_fix_profiles_update_rls.sql` (trigger `enforce_profile_privilege_columns`)
- **What the code does:** `POST /api/platform/operators` resolves the person to promote with `profiles.eq('email', email).limit(1)` (service role) and passes that `user_id` to `platform_grant_operator`. But `profiles.email` is a plain column the user may update on their own row: the `profiles_update` policy is `auth.uid() = user_id`, and the guard trigger only blocks changes to `account_role` and `account_id`. The app's own profile form never writes `email`, so nothing legit depends on it being writable.
- **Failure case:** Mallory (any signed-up user) runs, with her own session, `supabase.from('profiles').update({ email: 'nuevo.soporte@cabbity.com' }).eq('user_id', <her id>)`. Later an operator grants the operator role to `nuevo.soporte@cabbity.com`. If that person has not signed up yet, Mallory's row is the only match; if they have, `.limit(1)` with no order picks either. Mallory lands in `platform_admins` → can open a support session on every company, set member passwords, change plans. The route echoes back `person.email` (the spoofed value), so the operator sees nothing odd. Same lookup also feeds the "already a member / already exists" checks in `platform/accounts/route.ts:184`, `accounts/[id]/members/route.ts:131`, `members/create/route.ts:175`, so squatting an email also blocks the operator from provisioning that person.
- **Smallest fix:** one migration: add `OR NEW.email IS DISTINCT FROM OLD.email` to the condition in `enforce_profile_privilege_columns` (it already only fires for `current_user = 'authenticated'`). No app change needed.

## 2. A user without a profile row can insert one into any company as `owner`

- **Severity:** should — **Confidence:** medium (policy gap is certain; needs a profile-less authenticated user and the target account UUID)
- **Where:** `supabase/migrations/017_account_sharing.sql:617-618` (`profiles_insert WITH CHECK (auth.uid() = user_id)`), `supabase/migrations/034_fix_profiles_update_rls.sql` (trigger is `BEFORE UPDATE` only), `supabase/migrations/090_invite_direct_join.sql` (`handle_new_user` swallows bootstrap errors with `EXCEPTION WHEN OTHERS ... RAISE WARNING`)
- **What the code does:** the INSERT policy only checks that the row is the caller's own; `account_id` and `account_role` are free. The privilege trigger does not run on INSERT. Normally the `UNIQUE(user_id)` row created by `handle_new_user` blocks a second insert — but that trigger deliberately lets sign-up succeed with **no** profile when the account/profile bootstrap throws.
- **Failure case:** a user whose bootstrap failed (e.g. `auth.users.email` NULL — phone or anonymous sign-in, if ever enabled in Supabase — hits `profiles.email NOT NULL`; or any transient error inside the block) is authenticated with no profile. They run `supabase.from('profiles').insert({ user_id: me, full_name: 'x', email: 'x', account_id: '<victim account uuid>', account_role: 'owner' })`. `is_account_member` reads `profiles`, so they now have owner access to that company's contacts, messages, WhatsApp config. An ex-employee knows their old company's account UUID.
- **Smallest fix:** in the same migration as #1: `DROP POLICY profiles_insert ON profiles;` — no client code inserts profiles (grepped `src/` and `mcp-server/`); rows come from the trigger and the service role.

## 3. Five SECURITY DEFINER functions with no caller check are callable by anyone holding the anon key

- **Severity:** should — **Confidence:** high for `record_webhook_failure`, `_bcast_bump`, `recompute_broadcast_counts` (no REVOKE at all → PUBLIC execute); medium for the two `merge_duplicate_*` (depends on Supabase's default grant to `anon`/`authenticated`, which later migrations 037+ revoke explicitly for exactly that reason)
- **Where:** `supabase/migrations/028_webhook_endpoints.sql:91-103`; `supabase/migrations/005_broadcast_counts_incremental.sql:36-44` and `:107-128`; `supabase/migrations/022_contact_phone_dedup.sql:111`; `supabase/migrations/036_conversation_contact_dedup.sql:116`. `supabase/ci/verify-schema.sql` asserts privileges on other functions but not these.
- **What the code does:** these run as `postgres`, bypass RLS, take an id from the caller and never look at `auth.uid()`.
- **Failure case:** a `viewer` (read-only role) lists the account's webhooks through `GET /api/account/webhooks` (any member may), then calls `POST <supabase>/rest/v1/rpc/record_webhook_failure {"endpoint_id":"<id>","max_failures":0}` → `is_active=false`; the company's integration stops receiving events, and creating/patching webhooks is admin-only everywhere else. With any leaked endpoint or broadcast UUID the same call works across companies and without logging in. `_bcast_bump(bid, 'sent_count', 100000)` rewrites any numeric column of any broadcast. `merge_duplicate_contacts()` is a no-op today (unique index) but is a full `GROUP BY` over every tenant's contacts on each anonymous call.
- **Smallest fix:** one migration: `REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon, authenticated; GRANT EXECUTE ... TO service_role;` for the five. `record_webhook_failure` is only called with the service role (`src/lib/webhooks/queue.ts:307`); the `_bcast_*` ones are only called from a SECURITY DEFINER trigger. Add the matching `has_function_privilege` asserts to `verify-schema.sql`.

## 4. During a support session the inbox shows the operator's own company's quick replies mixed with the customer's

- **Severity:** should — **Confidence:** high
- **Where:** `src/app/api/quick-replies/route.ts:11-17` (GET)
- **What the code does:** `const { supabase } = await getCurrentAccount()` then `select('*')` with **no** `account_id` filter, relying on RLS. Inside a support session `supabase` is the operator's own client and the SELECT policy is `can_read_account(account_id)` = member of **own** account OR open support session on the customer's (`057_support_session_reads.sql:139-150`). It is the only route that discards `ctx.accountId` this way.
- **Failure case:** an operator whose own company uses the CRM opens a support session on customer X and opens the inbox. `quick-reply-picker.tsx:42` and `message-composer.tsx:339` fetch this route and list both companies' replies together; one click sends Cabbity's canned text to customer X's contact from X's number. In Settings the operator's own replies appear as X's, and editing them returns `{ok:true}` while changing nothing (PATCH is scoped to X).
- **Smallest fix:** keep `accountId` from the context and add `.eq('account_id', accountId)` to the GET query (one line).
- **Test gap:** `support-session-view.test.ts` checks browser reads and mutating routes; no test covers a server GET that reads through RLS without the account key.

## 5. A `viewer` can overwrite or delete the company's chat and flow media

- **Severity:** should — **Confidence:** high (policy text), not exercised against a live DB
- **Where:** `supabase/migrations/023_chat_media.sql:88-122`, `supabase/migrations/020_account_sharing_followups.sql:70-118` (INSERT/UPDATE/DELETE policies on `storage.objects`); `044_private_media_buckets.sql` only replaced the SELECT ones
- **What the code does:** the write policies check only that the first folder is `account-<caller's account_id>`; role is not looked at. Every table policy for the same data requires `is_account_member(account_id, 'agent')`.
- **Failure case:** a read-only member runs `supabase.storage.from('chat-media').list('account-<id>')` then `.remove([...])` → every image, audio and document of the company's conversations is gone (no soft delete), and flow media referenced by live flows stops sending.
- **Smallest fix:** in those six policies add `AND p.account_role <> 'viewer'` to the `EXISTS (SELECT 1 FROM profiles p ...)` clause.

## 6. Invitation rate limits key on a header the client writes

- **Severity:** nice — **Confidence:** medium (bypass depends on the proxy in front; I did not inspect the Dokploy/Traefik config)
- **Where:** `src/app/api/invitations/[token]/peek/route.ts:45-51`, `src/app/api/invitations/[token]/redeem/route.ts:33-39,68-69`
- **What the code does:** both take the **leftmost** `X-Forwarded-For` entry as the client IP. A proxy that appends (rather than replaces) leaves the leftmost value attacker-chosen. `redeem` is keyed by IP only, although `rate-limit.ts` documents it as "per-IP+user".
- **Failure case:** `curl -H "X-Forwarded-For: $RANDOM" .../peek` gets a fresh 30/min bucket per request wherever the proxy forwards the header, so the limiter never trips. In the other direction, every user behind one office NAT shares 10 redeems/min. Tokens are 256-bit, so this is hardening, not an open door.
- **Smallest fix:** take the **last** XFF entry (the one the trusted proxy added), key `redeem` on `user.id` (it is already loaded two lines below), and move the duplicated `getClientIp` into `rate-limit.ts`.

## 7. Every cookie-authenticated API call validates the session against Supabase Auth twice

- **Severity:** nice — **Confidence:** medium (read from code, not measured)
- **Where:** `src/middleware.ts` (`supabase.auth.getUser()` on every matched request) and `src/lib/auth/account.ts:160-169` (`getCurrentAccount` calls `getUser()` again), followed by `profiles` and `accounts` lookups and, for any role above viewer, the entitlements read
- **Failure case:** one inbox action = 2 HTTP round trips to GoTrue + 2-3 PostgREST queries before the route does any work; with many agents polling this is the fixed cost of every request and GoTrue becomes the shared bottleneck.
- **Smallest fix:** in the middleware only, switch `getUser()` to `getClaims()` (present in the installed `@supabase/supabase-js` 2.107; verifies the JWT locally when the project uses asymmetric signing keys, and still refreshes the cookie). Routes keep `getUser()`.

## 8. Four copies of the service-role client, 23 copies of `UUID_RE`

- **Severity:** nice (lean) — **Confidence:** high
- **Where:** `src/lib/auth/admin-client.ts`, `src/lib/flows/admin-client.ts`, `src/lib/automations/admin-client.ts`, `src/lib/ai/admin-client.ts` — identical lazy `supabaseAdmin()` singletons, so the process holds four service-role clients; routes in this area import from three of them interchangeably (`quick-replies` from automations, `api-context` from flows, `media/sign` from auth). `const UUID_RE =` is declared 23 times in non-test files, in two variants (strict v1-5 and any-hex), so the same id can be a 404 in one route and accepted in another.
- **Smallest fix:** make three of the admin-client files re-export from one; export one `UUID_RE` (one already lives in `src/lib/platform/integrations.ts`).

---

## What `src/lib/security/tenant-isolation.test.ts` does NOT cover

It runs routes against `fake-supabase.ts` (an in-memory store with RLS simulated from migration 017) and checks that service-role queries carry `account_id`. It therefore cannot see:

- anything a client does by talking to Supabase directly instead of through a route — findings 1, 2, 3 and 5 all live there;
- real Postgres policies, grants, triggers and RPC bodies (the migrations are never executed by it; `verify-schema.sql` covers some grants but not the functions in #3);
- storage policies by role;
- reads through RLS during a support session (#4) — the fake models membership, not `has_open_support_session`;
- rate limiting.

## Not read

- `src/lib/api/v1/openapi/*`, `fake-idempotency-store.ts`, `respond.ts`, `tags.ts`, `templates.ts`, `contacts.ts`, `conversations.ts` (route guards and scopes checked by grep; bodies not read)
- `/api/v1` routes other than `messages`, `exports`, `exports/[id]` (only their `requireApiKey` scope lines)
- `src/lib/platform/*` except the people/operator parts of `provisioning.ts`; `platform/accounts/**` routes except `members/[userId]/password`, `operators`, `impersonate`, `statements/*/confirm|void`
- `src/lib/exports/conversations.ts`, `csv.ts`; `src/lib/supabase/client.ts`; `src/lib/security/fake-supabase.ts`, `service-role-audit.ts`
- `src/lib/auth/`: `join-flow.ts`, `signup-invite.ts`, `reset-password.ts`, `support-view.ts`, `impersonation-log.ts`, `platform-page.ts`
- `api/account/` routes: `invitations`, `transfer-ownership`, `api-keys/[id]/rotate`, `webhooks/[id]/*` (guards checked by grep only)
- `/api/billing/**`, `/api/whatsapp/**`, `/api/ai/**`, `/api/flows/**`, `/api/automations/[id]/**` (outside this area)
- Migrations: scanned by script for RLS-enabled, `USING (true)`, SECURITY DEFINER + `search_path` + grants; read in full only 017 (policies), 034, 090, and the function bodies cited above. Migration 071 (`platform_*_operator`), 072 body and non-definer functions were not reviewed.
- Live Supabase project settings (anonymous/phone sign-in, default function grants) and the Dokploy/Traefik proxy config were not inspected; findings 2, 3 (merge functions) and 6 say where they depend on them.
