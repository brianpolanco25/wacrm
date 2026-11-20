# Review — n15.6 health-chat-perf-y-mensajes

**Verdict:** APPROVED (round 2, `59e3ff8`; round 1 was CHANGES_REQUESTED, see below)

Branch `fix/health-chat-perf` (`a2eff35`), range `main..fix/health-chat-perf`. Spec: `cabbity-health/docs/audit/2026-11-20-crm-chat.md` §W.1–W.3.
Skills run (both finished): `code-review` (high, 9 findings), `ponytail-review` (verdict Ship, 3 nice-to-haves).

## Gate (scoped, run by the reviewer)
- eslint on the touched files: 0 errors (1 old warning, `downloadMedia` unused, also on main)
- typecheck: green
- `TZ=UTC vitest` (src/app/api/v1, api-context, security, whatsapp/webhook, coexistence): 31 files, 604/604 green
- build: n/a (no framework or config changes). replay-migrations: n/a (no SQL)

## Criterion ↔ test traceability
- W.1 cache reuses the key and the plan within the window: [x] `api-context.test.ts` › "reuses the key and the plan within the window"
- W.1 expires after the TTL / a revoked key stops working: [x] "asks again once the window expires…" (29 s → hit, 31 s → 401)
- W.1 tells keys apart, unknown keys not cached: [x] "tells keys apart and never caches an unknown key"
- W.1 a plan without `api` is not cached: [x] "does not cache a plan without the api feature"
- W.1 two valid keys from **different accounts** each get their own account and their own plan: [ ] no test (see change 2)
- W.1 Promise.all leaves results and errors unchanged: [x] existing tests in `src/app/api/v1/conversations/**` stay green. I checked that `loadAccountAiOn` never throws (it returns false), so a 404 is still a 404.
- W.2 search with hundreds of matches, no `in contact_id`: [x] `conversations/route.test.ts` › "una búsqueda con cientos de coincidencias…" (600 contacts, 50 + cursor)
- W.2 matches by name and phone: [x] existing tests `?search=ana` / `?search=0102`
- W.2 account isolation: [x] "nunca mezcla cuentas, ni siquiera con filtros y búsqueda"
- W.2 against real PostgREST: manual script in the implementer's report (`contact:contacts!inner` + `contact.or=`; PostgREST does filter parent rows with `!inner`). OK.
- W.3 edit rewrites the original, no insert, no fan-out: [x] webhook `route.test.ts` › "an edit rewrites…" (filters `conversation_id` + `message_id`; no upsert/rpc/flows/automations/AI)
- W.3 revoke → `[deleted]`: [x] "a revoke marks the original as deleted…"
- W.3 original not found → log with ids only: [x] "a revoke whose original is unknown…"
- W.3 caption edit on media: [x] covered by the shared helper's tests in `coexistence-webhook.test.ts` › "edit of an attachment row → bare new caption, media intact"
- W.3 unsupported with subtype, 131060 → `unavailable`: [x] "an unsupported message keeps its real subtype…"
- W.3 contacts / system: [x] "a shared contact is stored…", "a system message stores its body"
- W.3 no cross-account rewrite: [x] the update filters by the `conversation_id` the webhook resolved within the account (`accountId` from the config), so a forged `original_message_id` cannot reach another account

## Checkpoints
- CP1 Gate: [x] (scoped, as instructed by the leader)
- CP2 Migrations: [x] n/a
- CP3 Isolation: [x] queries still filter by `account_id`; the cache is keyed by `key_hash` / `account_id`. Missing test for the cache across two accounts (change 2).
- CP4 Tests: [ ] missing a test for an expired key in the cache (change 1) and for two accounts (change 2)
- CP5 No deps: [x]
- CP6 i18n: [x] n/a
- CP7 Next 16: [x] n/a (no framework APIs)
- CP8 Scope: [x]
- CP9 Docs: [x] CHANGELOG Unreleased; no new env vars. [ ] stale comment in the revoke route (change 1)
- CP10 Git: [x] one commit in Spanish with prefix and Co-Authored-By; nothing pushed
- CP11 Inbound never blocked: [x] edit/revoke and the new types never throw; `applyMessageRewrite` returns false on error

## Findings (file:line)
1. `src/lib/auth/api-context.ts:125` — a cache hit returns the row without rechecking `expires_at` / `revoked_at` (those checks live only in `findActiveKeyByHash`, `src/lib/api-keys/store.ts:68-74`). A key whose `expires_at` (or the end of its rotation grace window) falls inside the 30 s window keeps working after its deadline. That is deterministic and costs nothing to avoid, unlike a revoke on another replica, which the spec does accept.
2. `src/app/api/account/api-keys/[id]/route.ts:11` — the comment "Revocation is effective on the next request" is no longer true, now that a revoke can take up to 30 s per replica.
3. `src/lib/auth/api-context.test.ts` — no test with two valid keys from different accounts (A then B) that checks `ctx.accountId` and one `assertPlanFeature` per account. The code is correct today; the test guards the cache key.

## Required changes
1. In `requireApiKey`, on a cache hit, rerun the liveness check on the cached row (`revoked_at`/`expires_at` ≤ now → treat it as a miss, or 401), or cap the entry's `expiresAt` at `min(now+TTL, row.expires_at)`. Add a test: a key with `expires_at` 10 s out, cached, gets a 401 at +11 s without waiting out the TTL.
2. Update the comment at `src/app/api/account/api-keys/[id]/route.ts:11` (revocation takes up to 30 s on each replica, per the cache in `api-context.ts`). Optional: clear the local process's entry on revoke.
3. Add the cross-account cache test from finding 3.

## Debt / for the human (not required)
- edit/revoke run after find-or-create of contact/conversation: a revoke from an unknown sender creates a contact and conversation and fires `contact.created`/`conversation.created`; a revoke arriving on another number of the account can change the conversation's `whatsapp_config_id` (same as reactions today; the spec places it there).
- A revoke does not update `last_message_text`: the deleted text stays in the preview until the next message (the spec says "no cambian el último mensaje"; consider whether a revoke of the *last* message should).
- An edit/revoke that arrives before its original is lost (update with 0 rows); no tombstone.
- `contacts`/`system` go through unread, automations and AI as customer text (already true for their old markers; not a regression).
- `applyMessageRewrite` does not filter by `sender_type`; payloads are Meta-signed, but `.eq('sender_type','customer')` on the inbound path would be cheap hardening.
- `CONVERSATION_SELECT.replace('contact:contacts(', …)` is fragile; the fake throws without `!inner`, so the test would catch it. A `CONVERSATION_SELECT_INNER` constant would be clearer.
- Messages page in parallel with the ownership check: reads up to `limit+1` rows of a foreign conversation before the 404 (discarded, no leak).

## Round 2 (`59e3ff8`, re-reviewed only this commit)
- Change 1: [x] `api-context.ts:126-130` rechecks `revoked_at`/`expires_at` against the clock on every hit, before the rate limit and scope checks. Test "a cached key still dies at its expires_at, without waiting out the window" (expires_at +10 s, cached, 401 at +11 s with a single lookup).
- Change 2: [x] comment at `src/app/api/account/api-keys/[id]/route.ts:11` now says a revoke takes effect within 30 s on each replica.
- Change 3: [x] test "keys of two accounts each get their own account and their own plan" (A, B, A, B → own accountId; `assertPlanFeature` exactly `[acct-a]`, `[acct-b]`).
- Scoped gate: eslint on the 3 files clean; typecheck green; `TZ=UTC vitest` src/lib/auth + src/app/api/account/api-keys + src/app/api/v1: 589/589 green.
- CP4 and CP9 now [x]. The debt above is still for the human.
