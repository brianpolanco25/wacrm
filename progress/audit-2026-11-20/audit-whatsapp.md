# Audit — WhatsApp message path (wacrm)

Read-only. Nothing in the repo was changed, no tests or build were run. Every finding below was traced through the code and its callers; none was reproduced at runtime.

Paths are relative to `/mnt/nvme-big/Dev/apps/cabbity/wacrm`.

---

## 1. Inbound message is dropped for any contact saved with a formatted phone — MUST, confidence high

**Where:** `src/lib/contacts/dedupe.ts:40-63` (`findExistingContact`), reached from `src/lib/whatsapp/inbound-thread.ts:115-171` (`findOrCreateContact`), called by `src/app/api/whatsapp/webhook/route.ts:1037-1048`.

**What the code does:** the lookup pre-filters in SQL with `.like('phone', '%<last 8 digits>')` against the raw `phone` column. Phones are stored as typed: the contact form writes `phone.trim()` (`src/components/contacts/contact-form.tsx:163,177`) and the CSV import writes `row.phone` (`src/components/contacts/import-modal.tsx:277`). The unique index, however, is on the generated digits-only `phone_normalized` (`supabase/migrations/022_contact_phone_dedup.sql:118-120`).

**Failure case:** an agent saves a contact as `+1 (809) 555-1234` or `809-555-1234`. That customer writes in; Meta sends `18095551234`.
1. `LIKE '%95551234'` does not match `...555-1234` → "no existing contact".
2. Insert of `18095551234` → 23505 on `(account_id, phone_normalized)`.
3. The race recovery (`inbound-thread.ts:159-168`) calls the same lookup, which fails the same way.
4. `findOrCreateContact` returns null → `processMessage` returns at `route.ts:1048`.

The message is never stored and Meta already got its 200, so it is not retried. It repeats for every message from that person. The only trace is a `Error creating contact` log line. The same path breaks coexistence echoes/history (`coexistence-webhook.ts:489-495`) and the v1 API's contact resolution.

**Smallest fix:** filter on the normalized column: `.like('phone_normalized', `%${suffix}`)` in `findExistingContact`. One line.

**Test gap:** `src/lib/contacts/dedupe.test.ts` mocks the query, so no test fails on this. Add one case with a stored `+1 (809) 555-1234` and an inbound `18095551234`.

---

## 2. Last-8-digit match files one customer's messages under another customer — MUST, confidence high

**Where:** `src/lib/whatsapp/phone-utils.ts:25-33` (`phonesMatch`), used by `src/lib/contacts/dedupe.ts:58-62`; consumers: inbound webhook, coexistence history/address-book import (`coexistence-batches.ts` → `findOrCreateContact`), v1 broadcasts (`broadcast-core.ts:269-281`).

**What the code does:** two different numbers are "the same contact" when their last 8 digits are equal. The intent is trunk-prefix tolerance (`370063949836` vs `37063949836`). `.find()` returns the first fuzzy hit, with no preference for an exact match.

**Failure case:** Dominican area codes 809, 829 and 849 all end in 9. `1-809-555-1234` and `1-829-555-1234` share the last 8 digits `95551234`. Contact A (809) exists; a different person B (829) writes in:
- B's message lands in A's conversation, under A's name.
- The agent's reply goes to A's stored phone, not to B.
- If B's webhook carries a BSUID, it is written onto A's row (`inbound-thread.ts:123`), making the merge permanent.

The same holds for any two NANP numbers whose area codes end in the same digit (212/312/412…). In the v1 broadcast path the second number is silently not messaged (`broadcast-core.ts:278`).

**Smallest fix:** in `findExistingContact`, return an exact `normalizePhone` match first; accept a non-exact candidate only when it is a trunk-0 variant, using the existing `phoneVariants(a).includes(b)`. `phonesMatch` stays for the form's soft "possible duplicate" warning.

**Test gap:** `phone-utils.test.ts:44` pins the last-8 fallback; nothing asserts that two different area codes stay separate.

---

## 3. One throw in `processWebhook` discards the rest of the delivery — SHOULD, confidence high

**Where:** `src/app/api/whatsapp/webhook/route.ts:400-406` (single try/catch around the whole delivery), `:531` (`decrypt(config.access_token)`), `:778` and `:1186` (`new Date(parseInt(ts) * 1000).toISOString()`).

**What the code does:** entries → changes → statuses → messages are processed in nested loops with no per-item isolation. The 200 is sent before processing, so Meta never retries.

**Failure cases:**
- Account X's `access_token` cannot be decrypted (key rotation gone wrong, corrupt row). `decrypt` throws at `:531` for every delivery carrying a message for X. X loses all inbound, including plain text that needs no token. Every later change/entry in the same POST is lost too; Meta batches several WABAs of one app into one POST, so other tenants lose messages. The coexistence path already guards this exact call (`coexistence-webhook.ts:677-688`); the main path does not.
- A status or message with a missing/non-numeric `timestamp` → `RangeError: Invalid time value` → remaining statuses and all messages of that delivery are lost. This contradicts the CP11 rule the file cites at `:1023-1027`.

**Smallest fix:** wrap the body of the `for (const change …)` loop, and each `processMessage` / `handleStatusUpdate` call, in try/catch that logs and continues. Decrypt the token inside a try and pass `''` on failure (media then falls back to null; text is saved).

**Test gap:** no test in `route.test.ts` feeds an undecryptable token or a bad timestamp alongside a valid message.

---

## 4. A tenant-signed delivery can carry changes its secret does not vouch for — SHOULD, confidence high (a), medium (b)

**Where:** `src/lib/whatsapp/tenant-app-secret.ts:39-90, 207-232`; `src/app/api/whatsapp/webhook/route.ts:439-445`; `src/lib/whatsapp/template-webhook.ts:133-137, 184-187`.

**(a) Template events are neither verified per tenant nor account-scoped.**
`verifyTenantAppSignature` only checks the numbers named in `metadata.phone_number_id`. An entry is treated as account-level only when *all* its changes lack a number (`:81-84`). `handleTemplateWebhookChange` receives no `entry.id` and updates with the service-role client by `meta_template_id` alone (no unique index, only a plain index in migration 014).

Case: tenant T (has its own app secret stored) posts a body it signs itself, with one entry containing a `messages` change naming T's own number plus a `message_template_status_update` change with `message_template_id` of another account's template and `event: REJECTED`. Signature passes (claimed = T's number only). The victim's template row flips to `REJECTED` with T's `reason`; the quality variant sets `quality_score`. The attacker needs the victim's numeric template id.

**(b) Numbers beyond the 50th are not verified.**
`extractPhoneNumberIds` returns after 50 distinct ids (`:51`), but `processWebhook` processes every change. A sender whose secret covers 50 numbers can append a 51st change naming a victim's number: forged inbound messages into that account (stored, automations, AI reply). High bar (50 connected numbers sharing one secret), cheap to close.

**Smallest fix:** (a) pass `entry.id` and `auth` to the template handler; for `signer === 'tenant'` restrict the update to the `account_id`s returned by `wabaConfigsSignedBy(entry.id, …)`, and for platform to accounts whose `whatsapp_config.waba_id = entry.id`. (b) return a "too many" result and reject instead of truncating.

**Test gap:** `tenant-app-secret.test.ts` has no mixed-entry or >50 case; `template-webhook.test.ts` has no cross-account case.

---

## 5. Status webhooks can move `messages.status` backwards — SHOULD, confidence high

**Where:** `src/app/api/whatsapp/webhook/route.ts:755-767` (messages), `:799-815` (broadcast recipients).

**What the code does:** `broadcast_recipients` goes through `isValidStatusTransition`; `messages` gets an unconditional `.update({ status: status.status })`. No DB trigger on `messages` guards it (checked `supabase/migrations`).

**Failure cases:**
- Meta delivers `read` and `delivered` in separate POSTs; the two `after()` callbacks run concurrently or Meta retries the older one. `delivered` lands last → the inbox shows one grey double-tick forever on a message the customer read. A late `sent` after `failed` hides a failure.
- A status outside the CHECK (`001_initial_schema.sql:173` allows sending/sent/delivered/read/failed; Meta also sends e.g. `deleted`) makes the update fail; it is only logged.
- `broadcast_recipients`: the guard is read-then-write (`:780` read, `:811` write by id only). Two concurrent statuses both read `sent`, both pass, last writer wins → `delivered` can overwrite `read`, and the trigger-maintained counts follow.

**Smallest fix:** add the allowed previous states to both updates, e.g. for `delivered`: `.in('status', ['sending','sent'])`; for `read`: `['sending','sent','delivered']`; for `failed`: `['sending','sent']`. For recipients add `.eq('status', recipient.status)`. Reuse `RECIPIENT_STATUS_LADDER` to derive the list.

**Test gap:** `route.test.ts` has no out-of-order case for `messages`.

---

## 6. Meta calls have no timeout; one hung call stalls the delivery behind it — SHOULD, confidence high

**Where:** `src/lib/whatsapp/meta-api.ts` — `sendTextMessage` `:571`, `getMediaUrl` `:1397`, `uploadMedia` `:1459`, `downloadMedia` `:1478`, and the other send helpers. Only `syncSmbAppData` and the funding/pricing probes take a signal.

**What the code does:** bare `fetch` with no `AbortSignal`. The webhook processes messages strictly in sequence (`route.ts:533-554`), and media resolution runs before the insert (`:1099-1104`). `maxDuration = 60` is a Vercel setting; in the Docker container nothing cuts a stuck `after()`.

**Failure case:** Meta's Graph or CDN accepts the connection and stops responding during `getMediaUrl`/`downloadMedia` for an inbound photo. That `after()` never finishes; the text messages after it in the same POST are never stored. From the dashboard, `/api/whatsapp/send` hangs until the client gives up, and a retry can double-send.

Related, same root: each message also awaits flows, automations, the AI reply (30 s provider timeout) and public webhook dispatch before the next message in the POST is even inserted, so a burst of N messages appears in the inbox N × reply-time late.

**Smallest fix:** one module-level `metaFetch(url, init)` in `meta-api.ts` that adds `signal: init.signal ?? AbortSignal.timeout(15_000)` (longer for media transfer), used by every helper. Optional follow-up: insert all messages of a change first, then run the fan-out.

---

## 7. Media proxy marks tenant attachments as publicly cacheable and buffers them whole — NICE, confidence medium

**Where:** `src/app/api/whatsapp/media/[mediaId]/route.ts:76-90`; `src/lib/whatsapp/meta-api.ts:1474-1488`.

**What the code does:** the route is authenticated and account-scoped, but answers with `Cache-Control: public, max-age=86400`. `downloadMedia` reads the whole body into a `Buffer`; the mirror checks size first (`mirror-inbound-media.ts:177`), the proxy does not.

**Failure case:** with any shared cache in front (CDN, caching reverse proxy), the first agent's fetch of `/api/whatsapp/media/<id>` is stored and then served to a request without a session. Not verified whether such a cache exists in this deployment; without one the header is only wrong on paper. Separately, a 100 MB inbound document (the mirror skips it, so it stays on the proxy URL) is held fully in memory per view.

**Smallest fix:** `private, max-age=86400`. Return `response.body` as the stream instead of buffering.

---

## 8. Second `findOrCreateConversation` in the send route, without the race handling — NICE, confidence high

**Where:** `src/app/api/whatsapp/send/route.ts:214-247` vs `src/lib/whatsapp/inbound-thread.ts:204-302`.

**What the code does:** a private copy of find-or-create: select, then insert, no 23505 handling, no `whatsapp_config_id` seal.

**Failure case:** an agent clicks "send template" on a contact with no thread at the moment that contact's first inbound arrives (or double-clicks). Both selects see nothing; the unique index of migration 036 rejects the second insert; the route answers 500 "Failed to open a conversation for this contact" although the conversation now exists. Also, a conversation created here has `whatsapp_config_id` NULL even when the request carried `whatsapp_config_id`.

**Smallest fix:** on `error.code === '23505'` re-select and return the id (three lines), and include `whatsapp_config_id` in the insert when provided. Merging with the lib helper needs its config parameter made optional.

---

## Checked and found sound (no finding)

- Duplicate webhook delivery: `(conversation_id, message_id)` unique index + `ignoreDuplicates` (migration 037) stops double insert and double fan-out; unread bump is an atomic RPC.
- Concurrent contact/conversation creation: unique indexes 022 / 060 / 036 plus re-resolve on 23505 (apart from finding 1).
- `PARTNER_REMOVED` scoping for tenant-signed deliveries (`wabaConfigsSignedBy`).
- Status updates and reactions are account-scoped before writing.
- Coexistence batches: conditional claim, cursor, attempt cap, deadline.
- `/api/media/sign` and `outbound-media.ts`: account-prefix and traversal checks; the in-process media-id cache is only a cache.
- Cron route: constant-time secret, 503 when unset.

## Not read

- `src/app/api/whatsapp/embedded-signup/route.ts` and `config/route.ts` (+ `config/[id]`, `smb-sync`, `verify-registration`, `payment-status`), `service-cap`, `templates/*` routes — not opened.
- `src/lib/whatsapp/broadcast-resume.ts` and `broadcast/[id]/resume/route.ts` — output was truncated; not reviewed.
- `src/lib/media/blob-cache.ts`, `download.ts`, `filename.ts`, `gallery.ts`, `signed-url.ts`, `storage-url.ts` — only their use from the sign route and outbound media was read.
- `meta-api.ts` lines 126-540 and 625-1380 (registration, template submit, interactive builders) — only the outline and fetch calls were checked.
- `coexistence-batches.ts` lines 1-60 and the tail of `drainCoexistenceBatches` — skimmed.
- Rest of `src/lib/whatsapp` (encryption internals, embedded-signup, payment-method, token-renewal, template-*, resolve-config, resolve-conversation, recipient, entry-point, message-charges, reencrypt, platform-mode) — not read beyond grep.
- Downstream engines called from the webhook (`automations`, `flows`, `ai`, `webhooks/deliver`, `billing`) — only signatures and timeouts.
- All `*.test.ts` files — grepped for coverage of each finding, not read.
