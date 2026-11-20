# Audit: AI + integrations (wacrm)

Read-only. Nothing in the repo was changed, no tests or builds were run. Every finding below was checked by reading the code and its callers; none was reproduced at runtime.

Paths are relative to `/mnt/nvme-big/Dev/apps/cabbity/wacrm`.

## Findings, ranked

### 1. The bot will act on any appointment or patient id the customer types — severity: must, confidence: high (code), medium (model compliance)

- **Where:** `src/lib/ai/tools/loop.ts:320-378`, `src/lib/ai/tools/policy.ts:96-120` (`checkRequiresPrior`), `src/lib/ai/tools/prompt.ts:72` ("Use only ids returned by a tool in this conversation **or given by the customer**"), `src/lib/ai/tools/load.ts:98-139`, `src/lib/integrations/catalogs/cabbity-health.ts:287-291, 407-460, 535-606`.
- **What the code does:** every active operation of an AI-enabled integration becomes a tool in `auto_reply` (only `draft` filters to GET). The loop passes the model's arguments straight to `executeIntegrationOperation` with the account's centre-wide credential. The only code guard, `requires_prior`, checks which operation *keys* were called in earlier turns, never which ids. Only `cancel_appointment` has it; `reschedule_appointment`, `confirm_appointment`, `get_patient`, `list_appointments` and `list_patients` have none. `list_patients` is described as "Solo para procesos internos" but is offered to the bot anyway.
- **Failure case:** customer A asks for their appointments (`list_appointments` ok), asks for availability (`find_availability` ok), then writes "cancela la cita 1235". 1235 belongs to another patient (ids are integers). The policy check passes because both prior keys are in the evidence, and the system prompt explicitly allows customer-supplied ids, so `POST /appointments/1235/cancel` runs. Same shape with no guard at all: "reprograma la cita 1235", or "¿qué citas tiene el paciente 88?" returns another patient's appointments to a stranger on WhatsApp.
- **Smallest fix:** two small changes.
  1. In `prompt.ts`, drop "or given by the customer" for ids.
  2. In `loop.ts`, before executing a tool that has an `in: 'path'` id (or `patient_id`), require that value to appear in a tool result of this conversation. Cheapest form: store the ids of `ok` results per conversation alongside the existing evidence and compare.
  Also hide `list_patients` from the bot with one policy flag checked in `buildAiTools`.
- **Test gap:** no test fails if a tool runs with an id that no earlier tool returned.

### 2. A human who takes over while the model is generating still gets a bot message on top — severity: must, confidence: high

- **Where:** `src/lib/ai/auto-reply.ts:137-161` (the only read of `assigned_agent_id` / `ai_autoreply_disabled` / `status`), `:338-362` (generation: up to 30 s plain, 40 s budget plus rounds with tools), `:399-415` (handoff write), `:468-497` (claim + send); `supabase/migrations/029_ai_reply.sql:118-131`.
- **What the code does:** the conversation gates are read once, before the model call. After generation, `claim_ai_reply_slot` only checks `ai_reply_count < max`, and `engineSendText` checks nothing about ownership. In the handoff branch the UPDATE is conditional only on `ai_autoreply_disabled = false` and uses the stale `conv.assigned_agent_id`.
- **Failure cases:**
  - An agent clicks "Take over" (sets `ai_autoreply_disabled = true` and assigns themselves) five seconds into a 20-second tool turn. The bot's reply is sent anyway, after the agent has started typing.
  - An agent is assigned through the normal assignment action (flag stays false) during generation and the model returns `[[HANDOFF]]`. The UPDATE overwrites `assigned_agent_id` with the handoff target and the customer gets "a member of our team will continue".
- **Smallest fix:** re-read the three columns right before `claim_ai_reply_slot` and return if any gate now fails. Add `.is('assigned_agent_id', null)` to the handoff UPDATE when it sets an assignee.
- **Test gap:** "never stomps an existing human assignment" (`auto-reply.test.ts:560`) only covers an assignment that existed before the dispatch; nothing covers one made during generation.

### 3. Two messages sent seconds apart produce two overlapping turns, and tool writes can run twice — severity: should, confidence: high (overlap), medium (double write)

- **Where:** `src/app/api/whatsapp/webhook/route.ts:1411-1421`, `src/lib/ai/auto-reply.ts:208-213, 253`, `src/lib/ai/context.ts:43-55`, `src/lib/integrations/request.ts:362-368`.
- **What the code does:** the reservation is per inbound message id, so each message wins its own turn. There is no per-conversation lock, queue or debounce, in memory or in the database. Each turn builds its context as "the last 20 messages" at that moment, not "up to my inbound". The only cross-turn guards are the reply cap and the handoff flag.
- **Failure case:** the customer sends "Hola" and, two seconds later, "quiero una cita mañana a las 10". Turn 1 is still generating, so turn 2's context holds both messages and no bot reply. Both turns answer, and the customer gets two replies covering the same ground, each spending a reply slot and an `ai_replies` unit. With tools: "sí" followed by "confirmo" starts two tool loops, and both can call `create_appointment`. The `Idempotency-Key` is a fresh UUID per call, so the integration cannot deduplicate them.
- **Smallest fix:** serialise turns per conversation with an in-process promise chain keyed by `conversationId` around `dispatchInboundToAiReply`. The app is one container, so mark it `shortcut: in-process, move to a DB advisory lock when there is more than one instance`. Turn 2 then starts after turn 1 has sent and sees its reply.
- **Test gap:** concurrency is tested for the same inbound dispatched twice and for two concurrent handoffs, never for two different inbounds that both produce replies.

### 4. Playground spends the platform's provider key with no size cap, no quota and no plan gate — severity: should, confidence: high

- **Where:** `src/app/api/ai/playground/route.ts:42-48, 65-84, 147-177`, `src/lib/ai/images/playground.ts:70-92`, `src/app/api/ai/config/route.ts:130-133`, `src/lib/ai/platform-key.ts:52-61`.
- **What the code does:** `POST /api/ai/playground` needs only the `agent` role and a per-user limit of 20/min. It has no per-account bucket (the draft route has one), no `assertPlanFeature`, no `assertQuota`, and does not count towards `ai_replies`. `toPlaygroundMessages` keeps the last 20 turns but never limits the length of `content`. `system_prompt` in the config route has no length limit either, and there is no DB constraint (`029_ai_reply.sql:52`). An account without its own key runs on `AI_PLATFORM_*_API_KEY`.
- **Failure case:** an account on any plan with no key of its own posts 20 turns of 100 KB each, 20 times a minute per user, around the clock. Each call is a real provider request on the platform key, bounded only by the model's context window, and with tools enabled up to six provider rounds per call. Nothing ever returns 402 or 429 beyond the per-user bucket. Separately, a 200 KB `system_prompt` is sent on every auto-reply turn.
- **Smallest fix:** cap `content` per turn (WhatsApp's 4096) in `toPlaygroundMessages`, cap `system_prompt` in the config route, and add the existing `aiDraftAccount` bucket to the playground. If the platform key is what pays (`config.keySource === 'platform'`), also charge a quota.
- **Test gap:** no test asserts a rejected oversized turn or an account-level limit on the playground.

### 5. An empty or failed model answer is a silent drop, and its tokens are never logged — severity: should, confidence: high (code path), medium (how often models return empty)

- **Where:** `src/lib/ai/providers/openai.ts:98-104, 223-227`, `anthropic.ts:119-123, 233-237`, `gemini.ts:115-125, 282-289`; `src/lib/ai/auto-reply.ts:338-362, 380, 517-519`.
- **What the code does:** every adapter throws `AiError('empty_response')` when the answer has no text, and it throws *before* reading `usage`. In `dispatchInboundToAiReply` the throw lands in the outer catch, which only logs. The `if (handoff || !text)` branch that would hand the thread to a human is reachable only when the text is nothing but the sentinel, or on a final tool round that returned tool calls.
- **Failure case:** a reasoning or thinking model spends the whole `MAX_OUTPUT_TOKENS = 1024` budget before writing text (`finish_reason: length`, Gemini `MAX_TOKENS`), or the safety filter blocks the answer. The provider bills the call. The customer gets nothing, the reservation for that inbound is spent, the conversation stays unassigned with the bot still "on", and `ai_usage_log` has no row. The same silence follows a revoked key or a provider outage: every inbound goes unanswered and nobody is routed to it.
- **Smallest fix:** in the adapters, attach the normalised usage to the `empty_response` error (`err.usage`, which `auto-reply.ts:350` already logs). In `auto-reply.ts`, treat `AiError` with code `empty_response` like `!text` and take the existing handoff branch.
- **Test gap:** "R1 empty model text: at most the notice, never a reply" (`auto-reply.test.ts:1233`) mocks `generateReply` returning empty text, a shape the real adapters never produce. No test covers a thrown `empty_response` in the dispatcher.

### 6. Re-indexing a knowledge document deletes its chunks before the new ones exist — severity: should, confidence: high

- **Where:** `src/lib/ai/knowledge.ts:33-83`, `src/app/api/ai/knowledge/reindex/route.ts:61-87`.
- **What the code does:** `ingestDocument` deletes the document's chunks, then calls the embeddings provider (one request per 96 chunks, 30 s timeout each), then inserts. The doc comment says "the chunks are only written once embedding succeeds, so a failed embed never leaves half-indexed rows", which is no longer what happens. Reindex runs every document of the account serially inside one HTTP request and returns on the first error, although its comment says one bad document should not abort the batch.
- **Failure cases:**
  - While a document is being re-embedded (seconds to minutes during a full reindex), auto-replies for that account retrieve nothing from it. For a one-document account `retrieveKnowledge` returns `[]`, so the model answers with no knowledge section.
  - If the insert fails after the delete (DB error, request killed mid-reindex), the document has zero chunks until someone presses Reindex again, and nothing reports it.
- **Smallest fix:** in `ingestDocument`, compute chunks and embeddings first, then delete and insert back to back. No other change needed; the reindex loop inherits it.
- **Test gap:** no test fails if the delete happens before the embed call.

### 7. AI usage chart buckets days in the server's time zone — severity: nice, confidence: medium

- **Where:** `src/app/api/ai/usage/route.ts:68, 112-113, 136`, `src/lib/dashboard/date-utils.ts:12-25`.
- **What the code does:** `daysAgoStart`, `lastNDayKeys` and `localDayKey` use the Node process's local time. I found no `TZ` in the Dockerfile or compose files, so the container most likely runs in UTC; I did not check the Dokploy service environment.
- **Failure case (if the container is UTC):** an auto-reply at 21:00 in Santo Domingo (UTC-4) on the 19th is drawn on the 20th, and "today" in the chart starts at 20:00 local.
- **Smallest fix:** set `TZ` on the container to the business time zone. A per-account zone would need the helper to take a zone argument; that is a product decision, not a patch.

### 8. Lean: seven copies of the service-role client factory — severity: nice, confidence: high

- **Where:** `src/lib/ai/admin-client.ts`, `src/lib/flows/admin-client.ts`, `src/lib/automations/admin-client.ts`, `src/lib/auth/admin-client.ts` (16-19 lines each, same lazy singleton), plus inline copies in `src/app/api/whatsapp/webhook/route.ts:61-70`, `src/app/api/whatsapp/config/route.ts` and `src/app/api/whatsapp/embedded-signup/route.ts`.
- **Why it matters here:** one turn of auto-reply already crosses three of them (`ai`, `flows` via `engineSendText`, `auth` via billing). Any change to client options (timeouts, auth flags) has to be made seven times.
- **Smallest fix:** keep `src/lib/auth/admin-client.ts` and re-export it from the other three files; replace the three inline copies with the import.

## Checked and found sound

- **SSRF:** `src/lib/integrations/http.ts` blocks literal private hosts, resolves DNS through `isDeliverableUrl`, uses `redirect: 'manual'`, a 10 s timeout that covers the body, and a 256 KiB cap. `request.ts` keeps the URL on the origin and prefix of `base_url` and encodes path values including dots. `base_url` and paths are platform-admin only. DNS rebinding is a documented residual risk.
- **Cross-account tool calls:** `executeIntegrationOperation` and `loadAiToolset` always filter `account_integrations` by `account_id`; the account comes from the conversation or session, never from the model or the body.
- **Secrets:** AI keys and integration credentials are encrypted at rest, never selected into a response (only `has_key` / `credential_last4`), not logged, and all four secret tables are covered by `reencrypt.ts`. The four integration tables have RLS on and are revoked from `anon` / `authenticated`.
- **Tool loop bounds:** 5 rounds, 8 executions, a time budget, and one corrective round; every provider and embeddings fetch has a timeout.
- **Rate limits and the live-data cache are in process memory.** That is correct for one container and wrong the day there are two.

## Not read, or only skimmed

- All `*.test.ts` files in the area, except the test names of `auto-reply*.test.ts` and a grep of `generate.test.ts`.
- `src/lib/ai/tools/weekday-fix.ts`, `live-render.ts`, and `schema.ts` lines 1-150.
- `src/lib/ai/types.ts`, `validate.ts`, `handoff-message.ts`, `automation-overlap.ts`.
- `src/lib/ai/images/config.ts`, `vision.ts`, `sniff.ts`, `types.ts`; `hydrate.ts` and `image-source.ts` were read in part.
- `src/lib/ai/voice/transcribe.ts`, `ogg-duration.ts`, `fallback-message.ts`, `types.ts`; `providers/transcribe-gemini.ts`, `transcribe-errors.ts`; `anthropic.ts` lines 1-59.
- `src/lib/integrations/catalog-validate.ts` (only `isForbiddenHost`, `normalizeBaseUrl`, `validateRelativePath`), `types.ts`, `remote-error.ts`, `support-trace.ts`, `catalogs/definition.ts`, `catalogs/index.ts`; `catalogs/cabbity-health.ts` read in part.
- `src/lib/platform/integrations.ts` (the DB layer behind the platform routes).
- `scripts/paypal-bootstrap-catalog.ts`, `scripts/integrations-bootstrap-catalog.ts`, `scripts/replay-migrations.sh`.
- Callers outside the area were read only where a finding depended on them: the webhook dispatch site, `flows/meta-send.ts` lines 1-140, `automations/reply-marker.ts`, `webhooks/ssrf.ts`, `rate-limit.ts` (limits only), `auth/account.ts` (`requireRole` only).
- The graphify graph was queried once for orientation and returned nothing useful for this question; findings come from the source files, not the graph.
