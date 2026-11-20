# Audit: background engines and outbound webhooks (wacrm)

Read-only. Nothing in the repo was changed, no tests or builds were run. Every finding below was traced through the code and its callers; none was reproduced by executing it.

Paths are relative to `/mnt/nvme-big/Dev/apps/cabbity/wacrm`.

---

## 1. Manual engine endpoint accepts a caller-supplied `conversation_id` and writes into it without account scope

- **Severity:** must. **Confidence:** high.
- **Where:** `src/app/api/automations/engine/route.ts:36-46`, `src/lib/automations/engine.ts:772-774`, `src/lib/automations/meta-send.ts:278-309`, `src/lib/flows/meta-send.ts:173-199, 340-365, 568-594`.
- **What the code does:** `POST /api/automations/engine` copies `body.context` into the run and strips only `inbound_message_id`. `resolveConversationId` returns `context.conversation_id` as-is when present. The senders then insert into `messages` with that `conversation_id` and update `conversations ... .eq('id', conversationId)` through the service-role client, with no `account_id` filter. `resolveWhatsAppConfig` does scope the conversation by account, but on a miss it falls through to the account default instead of failing.
- **Failure case:** an `agent` of account A posts `{trigger_type:'tag_added', contact_id:<own contact>, context:{tag_id:<own tag>, conversation_id:<conversation of account B>}}` with an automation that has a `send_message` step. The WhatsApp message goes to A's own contact, but a `sender_type='bot'` row with A's text is inserted into B's thread and B's `last_message_text` / `last_message_at` are overwritten. Needs B's conversation UUID, so it is not guessable, but it is a cross-tenant write on the admin client. The same hole inside one account: passing another contact's conversation id files the message in the wrong thread. The `conversation_idle` condition (`engine.ts:929-953`) also reads `messages` of that foreign conversation.
- **Smallest fix:** in the route, `delete context.conversation_id` next to the existing `delete context.inbound_message_id`. The engine then falls back to the contact's own conversation, which is already account-scoped (`engine.ts:777-782`). Add one case to `engine/route.test.ts`.

## 2. Saving an automation corrupts every run parked on a `wait`

- **Severity:** must. **Confidence:** high on the mechanism, medium on how often it bites (depends on how many automations have waits inside branches).
- **Where:** `src/lib/automations/steps-tree.ts:36-47`, `supabase/migrations/006_automations.sql:124` (`parent_step_id ... ON DELETE SET NULL`), `src/lib/automations/engine.ts:278-293`, `src/app/api/automations/[id]/route.ts:146-149`.
- **What the code does:** every PATCH that carries `steps` runs `replaceSteps`, which deletes all `automation_steps` rows and re-inserts them. A parked run is stored as `(parent_step_id, branch, next_step_position)`. The delete nulls `parent_step_id` on every pending row of that automation. On resume, `parentStepId === null` selects root steps with `position >= next_step_position`.
- **Failure case:** root = `[condition(0){yes:[wait 1d, send "follow up"]}, send B(1), send C(2)]`. A contact is parked in the yes branch with `next_step_position = 1`. The owner fixes a typo and saves. Next day the cron resumes with a null parent and runs root steps from position 1: the customer gets B and C a second time and never gets "follow up". For a top-level wait the position goes stale the same way: inserting a step before the wait makes parked runs resume one step early (re-running the wait or the step before it).
- **Second defect in the same function:** delete and insert are two calls with no transaction. If the insert fails (for example a `step_type` the CHECK rejects), the automation is left with zero steps and the route returns 500.
- **Smallest fix:** store the id of the wait step on the pending row and resume from "the step after that id" instead of a position; fail the pending row when the id no longer exists. Cheaper stopgap: in `replaceSteps`, mark this automation's `pending` rows `failed` before deleting, so an edit cancels parked runs instead of misdirecting them.
- **Tests:** none cover resume after an edit, or a wait inside a branch.

## 3. Outbound webhook: an attempt in flight is re-claimed by the next sweep (duplicate delivery, and a success can be overwritten by a failure)

- **Severity:** should. **Confidence:** high.
- **Where:** `src/lib/webhooks/queue.ts:236-262` (claim), `286-306` (`markFailed`), `511-517` (sweep scan), `src/lib/webhooks/deliver.ts` (first attempt).
- **What the code does:** `claimDelivery` bumps `attempt` and writes `status: 'pending'` but leaves `next_attempt_at` in the past. The sweep selects `status in (pending, failed) and next_attempt_at <= now`. The optimistic lock on `attempt` only stops two sweeps that read the same snapshot.
- **Failure case:** an event is enqueued and its first attempt is waiting on a receiver that takes 3 s. The per-minute cron fires in that window, sees the row as due with `attempt = 1`, claims it to 2 and posts the same envelope again. If the first attempt returns 200 and the second times out, `markFailed` (which filters only by id) flips the row from `delivered` back to `failed`, so it is delivered a third time a few minutes later, and `record_webhook_failure` counts a failure against a healthy endpoint. Same overlap between two sweeps when one runs past a minute (100 rows, 5 s timeout, plus exports, token renewal and payment sweeps in the same request).
- **Smallest fix:** in `claimDelivery`, also set `next_attempt_at` to now + 2 × `DELIVERY_TIMEOUT_MS`. The row is then invisible to other sweeps while in flight and still recovers on its own if the process dies mid-attempt. Add `.eq('attempt', row.attempt)` to the updates in `markFailed` / `markDelivered` so a stale attempt cannot overwrite a newer result.

## 4. `time_of_day` condition is evaluated in the server's time zone (UTC), not the account's

- **Severity:** should. **Confidence:** high (the Dockerfile sets no `TZ`; no account time zone is read anywhere in the engine).
- **Where:** `src/lib/automations/engine.ts:914-928`; shipped template `src/lib/automations/templates.ts:56-79`.
- **What the code does:** `new Date().getHours()` against the `HH:mm-HH:mm` operand. The builder shows only the placeholder `HH:mm-HH:mm`, with no time zone hint.
- **Failure case:** the built-in "Out of Office" template uses `18:00-09:00` and tells the customer "offline right now (9am–6pm)". For an account in Santo Domingo (UTC-4) the window is really 14:00-05:00 local: customers writing at 3 pm get the out-of-office reply, and customers writing at 6 am get nothing.
- **Smallest fix:** add an optional `timezone` (IANA) to the condition config, defaulting to an account-level value, and compute the minutes with `Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })`. Until then, state "UTC" in the builder label.
- **Tests:** none for `time_of_day`.

## 5. A cycle of auto-advancing flow nodes sends up to 63 WhatsApp messages per inbound

- **Severity:** should. **Confidence:** high on engine behaviour, medium on likelihood (needs an author to draw the loop).
- **Where:** `src/lib/flows/engine.ts:609-660` (cap of 64 iterations), `src/lib/flows/validate.ts:95-135` (resolves references and reachability, no cycle check), `src/app/api/flows/[id]/route.ts:131-211` (PUT on an active flow runs no validation at all).
- **What the code does:** the loop comment says the validator "SHOULD catch but doesn't yet"; the only guard is the 64-iteration cap, and each `send_message` / `send_media` iteration sends for real.
- **Failure case:** `start -> send_message A -> next_node_key: A` (or `A -> B -> A`, or a condition with a constant result looping back through a send). It passes activation. One matching keyword makes the customer receive A 63 times within seconds, then the run fails with `advance_loop_overflow`. Each one consumes `messages_out` quota. The next keyword does it again.
- **Smallest fix:** in `advanceFromNodeKey`, keep a `Set` of node keys visited in this call and fail the run on a revisit. Legitimate loops always pass through a suspending node, which ends the call, so they are unaffected. Three lines plus one test.

## 6. A `wait` inside a condition branch does not hold the steps after the condition; a failed step inside a branch does not stop the run and the log ends as `success`

- **Severity:** should. **Confidence:** high.
- **Where:** `src/lib/automations/engine.ts:315-341, 344-363, 372-391`.
- **What the code does:** the nested `executeStepsFrom` parks the run and returns `void`; the parent loop then `continue`s to the next root step. On a nested failure it breaks its own loop and appends results with `status = null`; the parent again continues and finally writes its own `status`.
- **Failure cases:**
  - Root `[condition{yes:[wait 1h, send "reminder"]}, close_conversation]`: the conversation is closed immediately, and the log is overwritten from `partial` to `success` while a run is still parked.
  - Root `[condition{yes:[send_template (Meta rejects it)]}, add_tag "notified"]`: the tag is added anyway and the log shows `status: success` with an `error_message` set.
- **Smallest fix:** make `executeStepsFrom` return `'done' | 'parked' | 'failed'` and, in the condition branch of the parent loop, stop on anything other than `'done'` (writing `partial` or `failed`). To continue the root after a nested wait, the resume would need to walk back up to the parent scope; if that is out of scope, reject a wait inside a branch followed by root steps in `validate.ts`.
- **Tests:** none exercise nested branches with a wait or a failure.

## 7. Parked automation runs cannot be stopped, multiply per inbound, and are stranded by a restart

- **Severity:** should. **Confidence:** high.
- **Where:** `src/lib/automations/engine.ts:168-173` (resume), `src/app/api/automations/cron/route.ts:46-70`, `src/lib/automations/templates.ts:108-127`.
- **Failure cases:**
  - **Pause is ignored.** `resumePendingExecution` loads the automation by id and account without checking `is_active`. An owner who switches off an automation with a 1-day wait still has every parked contact messaged the next day. Fix: treat `is_active = false` as cancel (mark the pending row `failed` with a clear log detail).
  - **Shipped template sends one nudge per inbound.** "Follow-up Reminder" is `new_message_received -> wait 1 day -> send`, with no condition. A customer who writes 8 messages gets 8 identical nudges 24 h later, including when an agent already answered. Fix: add the existing `conversation_idle` condition (operand `1440`) around the send in the template.
  - **Crash strands rows.** The cron claims a row as `running`; nothing ever resets it. If the container is redeployed mid-run, the rest of that run never executes and the log stays `partial` forever. Fix: at the top of the cron, mark `running` rows older than about 15 minutes as `failed` and finalize their log. Do not re-queue them, because earlier steps may already have sent.
  - **Unchecked insert.** `engine.ts:318-331` does not check the result of the insert into `automation_pending_executions`; if it fails, the log says "waiting" and the run is gone. Fix: throw on error so the log records `failed`.

## 8. Lean: the Meta send pipeline exists four times; engine tables have no retention

- **Severity:** nice. **Confidence:** high.
- **Duplicated code:** `sendViaMeta` (`src/lib/automations/meta-send.ts:123-314`) and `engineSendText`, `engineSendMedia`, `sendInteractiveViaMeta` (`src/lib/flows/meta-send.ts:76-203, 228-370, 426-599`) each repeat the same roughly 100 lines: `assertWritable` + `assertQuota`, account-scoped contact lookup, `resolveRecipient`, `resolveWhatsAppConfig`, the variant-retry loop, phone auto-correction, `messages` insert, `emitBotMessageSent`, `conversations` update, `recordUsage`. Only the Meta call and the inserted columns differ. The automations interactive path already delegates to the flows sender; the automations text path can do the same today (`flows/engineSendText` is a superset, it only adds `aiGenerated`), which removes about half of `automations/meta-send.ts`. A single `sendBotMessage(args, attempt, messageRow)` helper would remove about 300 lines and is the one place to add the missing `account_id` filter from finding 1.
- **Also duplicated:** `src/lib/automations/admin-client.ts` and `src/lib/flows/admin-client.ts` are identical apart from the header comment (16 lines each). `webhooks/*` and the broadcast routes already import the flows one.
- **Tables that only grow:** `automation_logs`, `automation_pending_executions` (done and failed rows), `flow_runs`, `flow_run_events` (several rows per inbound inside a flow) and `inbound_auto_replies` (one row per auto-answered inbound) have no purge anywhere in `src/` or the migrations. Only `webhook_deliveries` has one (30 days). `isDuplicateInbound` (`src/lib/flows/engine.ts:324-348`) loads every historical run id of the contact into an `.in()` filter, so its cost grows with that history. Smallest fix: a purge by `created_at` in the existing cron, as `purgeOldDeliveries` does.

---

## Checked and found sound

- SSRF guard for both outbound webhooks and the `send_webhook` step: private, loopback, link-local, CGNAT, IPv4-mapped and NAT64 addresses rejected, re-checked on every attempt, `redirect: 'manual'`, timeouts of 5 s and 10 s. DNS rebinding is documented in `ssrf.ts` as a residual risk, so it is a decision, not a finding.
- Tag-chain loop between automations is capped at depth 3 and the depth survives a wait.
- The per-inbound reply reservation between automations and the AI (`reply-marker.ts`) fails closed.
- Flow transitions and reprompts are claimed with a conditional UPDATE before sending.
- Webhook management (`manage.ts`) scopes every query by account; retry, test and rotate are rate-limited and admin-only.
- Broadcast resume claims the pass before planning.

## Not read

- `src/lib/flows/`: `edges.ts`, `layout.ts`, `templates.ts`, `types.ts`, `fallback.ts`; `validate.ts` only partly (header, graph section, grep for cycle handling).
- `src/lib/automations/`: `builder-tree.ts`, `template-window.ts`, `trigger-meta.ts`; `validate.ts` only by grep (wait, send_webhook, branches).
- `src/lib/webhooks/events.ts`; all `src/app/api/account/webhooks/**` and `src/app/api/v1/webhooks/**` routes except the panel retry route (the shared logic in `manage.ts` was read in full).
- `src/app/api/automations/[id]/duplicate/route.ts`, `src/app/api/flows/route.ts`, `src/app/api/flows/templates/route.ts`; GET handlers of `automations/[id]` and the first 60 lines of `flows/[id]/route.ts`.
- `src/lib/contacts/`: `dedupe.ts`, `display.ts`, `parse-contact-csv.ts`, `resolve-import-tags.ts`, `tag-api.ts`.
- `src/lib/inbox/attention.ts`, `src/lib/inbox/free-window.ts`, all of `src/lib/email/*`.
- `src/lib/flows/meta-send.ts` `engineSendMedia` body (lines 228-420) only by grep.
- Test files: only `engine.test.ts` (test names and the resume block) and grep over the others.
- Out of area but relevant to findings, not read: `src/app/api/whatsapp/webhook/route.ts` (the real caller of both engines), `src/lib/whatsapp/broadcast-core.ts` and `broadcast-resume.ts`, `src/lib/whatsapp/meta-api.ts` (whether Meta fetches have timeouts), the `record_webhook_failure` SQL body.
