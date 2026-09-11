# Security operations

Operational notes for the security controls that need configuration or
a runbook: key rotation, the platform webhook verify token, private
attachment buckets and the tenant-isolation checks. Everything here is
server-side; none of it changes the UI.

## Encryption key rotation

Every stored credential — `whatsapp_config.access_token` /
`verify_token`, `ai_configs.api_key` / `embeddings_api_key` and
`webhook_endpoints.secret` — is encrypted at rest with AES-256-GCM by
`src/lib/whatsapp/encryption.ts`.

### Variables

| Variable                  | Required | Meaning                                                                                              |
| ------------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `ENCRYPTION_KEY`          | yes      | The active key: 32 bytes as 64 hex characters (`openssl rand -hex 32`). `encrypt()` always uses it.  |
| `ENCRYPTION_KEY_PREVIOUS` | no       | Zero or more retired keys, comma-separated, same format. Decrypt-only. Leave unset until you rotate. |

### How ciphertexts are versioned

New values look like `k3f9a1c2e:<iv>:<ciphertext>:<tag>`. The prefix is
a **key id**: the first 8 hex characters of `SHA-256(key bytes)`. It is
derived from the key itself rather than from a counter, so there is no
extra `ENCRYPTION_KEY_VERSION` to keep in sync between staging and
production, and any number of retired keys can sit in
`ENCRYPTION_KEY_PREVIOUS` without further configuration. The id reveals
nothing usable about the key.

Two older shapes still decrypt: `<iv>:<ct>:<tag>` (GCM, written before
key ids existed) and `<iv>:<ct>` (the original CBC). Neither carries a
key id, so every key in the ring is tried. Rows in either shape are
rewritten under the active key the next time they are used (the
`isLegacyFormat` write-back in the send path and the webhook), and by
the script below.

Trying more than one key is safe for GCM, which authenticates itself,
but not for CBC, which does not: the wrong key clears PKCS#7 padding
about once in 240 attempts and Node will happily hand back the
resulting bytes. Since the write-backs re-encrypt whatever `decrypt()`
returns, that would mean storing noise over the only copy of a
customer's token. So a CBC plaintext is accepted only when it decodes
as **strict UTF-8** (no U+FFFD substitution), and when exactly **one**
key in the ring produces an acceptable plaintext. A ciphertext really
written by a ring key always decrypts under that key, so a second hit
proves a collision: `decrypt()` throws, the write-back never runs, and
the account shows `token_corrupted` — recoverable by re-entering the
secret — instead of being silently destroyed.

The residual limit is worth stating plainly: a CBC row whose key is
**not** in the ring at all is already unreadable, and there is nothing
left to compare a candidate plaintext against. One in a few hundred
thousand of those (padding _and_ UTF-8 by chance, much rarer for a
long token) is still returned as garbage and can still be rewritten.
Keeping a retired key in `ENCRYPTION_KEY_PREVIOUS` until the
re-encryption script reports a clean run is what keeps that case out
of reach.

### The new format is one-way

`encrypt()` emits the four-part shape unconditionally, and the
`decrypt()` of any earlier release rejects it (`unrecognised format
(expected 1 or 2 colons, got 3)`). That has two consequences worth
planning for:

- **Rows convert themselves.** Every pre-existing row counts as legacy,
  so the write-backs in the send path and the webhook rewrite it in the
  new shape the first time the account sends a message or Meta
  re-verifies the webhook. This happens under normal traffic, with no
  rotation and no script run.
- **Rolling the application back is not free.** Once a row has been
  converted, an older build cannot read it: that account gets
  `token_corrupted` and has to re-enter its WhatsApp token, AI provider
  key or webhook secret. There is no downgrade script, and there is no
  way to tell from the outside which rows have already converted. If a
  rollback is a realistic part of the release plan, take a backup of
  `whatsapp_config`, `ai_configs` and `webhook_endpoints` before
  deploying, and restore those tables together with the old build.

### Rotation runbook

1. Generate a new key: `openssl rand -hex 32`.
2. Set `ENCRYPTION_KEY_PREVIOUS` to the **old** value of
   `ENCRYPTION_KEY` (append with a comma if it already holds a key), set
   `ENCRYPTION_KEY` to the new one, and restart the app. From this point
   new secrets are written under the new key and old rows still decrypt.
3. Re-encrypt what is stored, first as a report and then for real:

   ```bash
   node --env-file=.env.local scripts/reencrypt-secrets.ts --dry-run
   node --env-file=.env.local scripts/reencrypt-secrets.ts
   ```

   The script needs `NEXT_PUBLIC_SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY` and
   `ENCRYPTION_KEY_PREVIOUS`. It walks `whatsapp_config`, `ai_configs`
   and `webhook_endpoints` in batches of 100 (`--batch-size N`, between
   1 and 1000), rewrites only the columns that are not yet under the
   active key, and prints a per-table summary. Node 24 runs the
   TypeScript directly; the `MODULE_TYPELESS_PACKAGE_JSON` warning it
   prints is harmless (`--disable-warning=MODULE_TYPELESS_PACKAGE_JSON`
   hides it).

   1000 is not a style preference: PostgREST truncates any response at
   `db-max-rows` (1000 on Supabase) without flagging that it did, so a
   larger page comes back short and reads exactly like the end of the
   table. The script refuses the value rather than clamp it, and pages
   until it gets an **empty** page, advancing by the number of rows it
   actually received.

4. A row that cannot be decrypted with any configured key is counted as
   `failed`, logged with its table, column and id, and left untouched;
   the script exits 1. Do not proceed to step 5 while anything is
   failing — fix the key ring or have the owner re-enter that secret.
5. When a clean run reports `failed 0` everywhere, remove the old key
   from `ENCRYPTION_KEY_PREVIOUS` and restart.

The same procedure recovers from a suspected key leak; the only
difference is urgency. Until step 5 the old key can still read every
row it ever wrote, so treat steps 2–5 as one change window.

### Why `allowImportingTsExtensions` is on in the root `tsconfig.json`

`scripts/reencrypt-secrets.ts` is executed by `node` directly (Node 24
strips the types; there is no build step for it), and Node resolves
relative specifiers literally — so its imports have to say
`../src/lib/whatsapp/encryption.ts`, extension included, which
TypeScript only allows with that flag. The flag is set at the root
rather than in a `scripts/tsconfig.json` because the repo compiles as
one project with `noEmit: true`: nothing is emitted, so the usual
hazard (emitting an import of a `.ts` path that no runtime can resolve)
cannot occur, and phase 3 already relies on the same flag for its own
Node-run scripts. Application code under `src/` must keep importing
through `@/…` without an extension — the flag permits the other style,
the review does not.

## Webhook verification token

Meta verifies a webhook URL with a `GET ?hub.mode=subscribe&hub.verify_token=…`
challenge. Two ways to answer it:

| Mode                                                         | Configuration                                                                                              | What the `GET` does                                                                                                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform (one Meta app, every tenant behind one webhook URL) | `META_WEBHOOK_VERIFY_TOKEN=<random string>` — the same value you type into the Meta app's webhook settings | Compares against the variable in constant time and answers. **Never reads `whatsapp_config`.** Per-tenant verify tokens stop being credentials. |
| Self-hosted (one install per business)                       | variable unset                                                                                             | Unchanged: walks `whatsapp_config`, decrypts each `verify_token` and answers when one matches.                                                  |

Set the variable once the deployment is registered as a single Meta app;
leave it unset for a self-hosted instance where each tenant brings their
own app. The value is trimmed before use, so surrounding whitespace (a
trailing newline from a secret file, a stray space in an `.env` line) is
not part of the token; an empty — or whitespace-only — value counts as
unset. A subscribe that does not match the platform token logs a
`console.warn` naming neither the supplied nor the expected value.

## Private attachments

The `chat-media` and `flow-media` Storage buckets hold every attachment
an agent sends, every file a Flow `send_media` node delivers, every
template header image and (since migration 039) a copy of everything
customers send in. Until migration 044 they were **public**: anyone
holding a URL could read any account's file. They were public for one
reason — Meta fetched outbound media from them at send time.

### How it works now

1. **Outbound media goes to Meta by id, not by link.** Before sending,
   `src/lib/whatsapp/outbound-media.ts` recognises a URL that points into
   one of our buckets, checks that the object's path belongs to the
   sending account (`account-<id>/…`, or a pre-020 `<uid>/…` path whose
   uploader is in the account), downloads the bytes with the service
   role, uploads them with `POST /{phone_number_id}/media` and sends
   `{ id }`. The id is cached in memory per (phone number, object) for a
   day. External links (an integrator's own CDN in the public API) still
   pass through as `{ link }`. Covered paths: the inbox composer and
   `POST /api/v1/messages` (`send-message.ts`), Flow `send_media` nodes
   (`flows/meta-send.ts`), template media headers in the dashboard
   broadcast, the public-API broadcast and its resume
   (`broadcast-core.ts`), and the Resumable-Upload sample for template
   creation (`template-header-handle.ts`).
2. **The browser asks for short-lived signed URLs.** The stored value in
   `messages.media_url` / a Flow node's `media_url` keeps the
   `…/storage/v1/object/public/<bucket>/<path>` shape. Everything that
   renders it (`useMediaBlobUrl` / `useMediaSrc` in
   `src/hooks/use-media-blob-url.ts`, the blob cache, downloads, the
   lightbox, the Flow builder's file link, the template header preview)
   exchanges it for a 10-minute signed URL through
   `src/lib/media/signed-url.ts` and renews it a minute before expiry
   while the element stays mounted.

   The signing goes through the user's **own** Supabase session
   (`createSignedUrl`), not a server endpoint with the service role. The
   storage API evaluates the bucket's SELECT policy against the caller's
   JWT before it signs, and migration 044's policy covers members of the
   account named by the path's first segment (or the account of the legacy
   uploader) —
   so isolation is enforced by the same rule that gates a direct read,
   with no service-role code path to audit and no new route. Signing
   works the same on a still-public bucket; if it fails for any reason
   the stored URL is used as-is, which is exactly what worked before.

3. **Migration 044** sets `public = FALSE` on both buckets, drops the
   two `… is publicly readable` policies and creates `Members can read
chat media` / `Members can read flow media` with the write policies'
   predicate. Legacy `<auth.uid()>/…` paths from migration 016 stay
   readable by every member of the uploader's account.
   `verify-schema.sql` asserts both buckets are private and both policies
   exist.

### Deploy order (production)

The code in (1) and (2) works with the buckets public **or** private.
The old code — Meta fetching a public link — stops working the moment
044 runs. So, in production:

1. Deploy the release that contains (1) and (2). Leave the buckets as
   they are.
2. Verify outbound attachments still arrive: send a photo and a document
   from the inbox, run a Flow with a `send_media` node, and send a
   broadcast with a template that has an image header. Check the
   recipient's phone, not just the 200 from the API.
3. Only then apply `supabase/migrations/044_private_media_buckets.sql`.
4. Verify in the browser that existing attachments (including ones
   uploaded before 2026 under the legacy path convention) still render,
   and that a direct `…/object/public/…` URL now answers 400.

Rollback if step 4 fails: `UPDATE storage.buckets SET public = TRUE WHERE
id IN ('chat-media','flow-media')` and re-create the two dropped policies
from migrations 016/023; nothing in the application depends on the
buckets being private.

### Verificación de Storage en un proyecto real

La comprobación SQL reproducible de RLS está en
`progress/checks_private-media.sql`; se ejecuta contra el Postgres local tras
aplicar las migraciones. La emisión y caducidad de URLs firmadas la hace el
servicio Storage, por lo que se verifica en un proyecto real **después** de
aplicar 044 y nunca contra producción durante CI. Con un objeto de la cuenta A
en `chat-media` y tokens de sesión desechables de A y B, ejecuta:

```bash
export SUPABASE_URL='https://<project>.supabase.co'
export SUPABASE_ANON_KEY='<anon-key>'
export A_ACCESS_TOKEN='<jwt-de-un-miembro-de-A>'
export B_ACCESS_TOKEN='<jwt-de-un-miembro-de-B>'
export OBJECT_PATH='account-<account-a>/private-media-check.txt'

sign_json="$(curl --fail-with-body -sS -X POST \
  "$SUPABASE_URL/storage/v1/object/sign/chat-media/$OBJECT_PATH" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $A_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' --data '{"expiresIn":1}')"
signed_path="$(node -e 'const x=JSON.parse(process.argv[1]); if (!x.signedURL) process.exit(1); process.stdout.write(x.signedURL)' "$sign_json")"

# A puede descargar; una URL pública directa y B no pueden hacerlo.
test "$(curl -sS -o /dev/null -w '%{http_code}' "$SUPABASE_URL/storage/v1$signed_path")" = 200
test "$(curl -sS -o /dev/null -w '%{http_code}' "$SUPABASE_URL/storage/v1/object/public/chat-media/$OBJECT_PATH")" -ge 400
test "$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $B_ACCESS_TOKEN" \
  "$SUPABASE_URL/storage/v1/object/authenticated/chat-media/$OBJECT_PATH")" -ge 400
test "$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  "$SUPABASE_URL/storage/v1/object/sign/chat-media/$OBJECT_PATH" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $B_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' --data '{"expiresIn":1}')" -ge 400

sleep 2
test "$(curl -sS -o /dev/null -w '%{http_code}' "$SUPABASE_URL/storage/v1$signed_path")" = 403
```

El último `test` conserva evidencia explícita del criterio de expiración: la
misma URL que funcionó debe devolver 403 tras su TTL de un segundo. Repite la
emisión con un segundo miembro de A y un objeto legado
`flow-media/<uid-del-uploader>/…` para confirmar que ambos siguen visibles.

### Known debt

- The media-id cache lives in process memory. A small table keyed on
  `(phone_number_id, bucket, path)` with Meta's ~30-day expiry would
  survive restarts and multiple instances; it was left out so 044 stays a
  pure privatisation step.
- `GET /api/v1/conversations/{id}/messages` returns `media_url` in the
  stored public shape. After 044 an integrator cannot fetch it directly;
  a follow-up should return a signed URL (service role, scoped to the
  key's account) or a proxy route.

## Platform operators and support sessions

The service has one role that lives outside every company:
`platform_admins` (migration 055). It is deliberately **not** a value of
`account_role_enum` — mixing "I administer my company" with "I administer
every company" in the same column turns any role-assignment bug into a
total escalation.

### Granting the first operator

There is no seed. Sowing an email or a uuid in a migration would put a
back door in the repository, so the first operator is created by hand
against the database — from the Supabase SQL editor or with the service
role.

```sql
-- Substitute the address. Idempotent.
INSERT INTO platform_admins (user_id, granted_by, note)
SELECT u.id, u.id, 'bootstrap operator'
FROM auth.users u
WHERE u.email = 'operator@example.com'
ON CONFLICT (user_id) DO NOTHING;

-- Check:
SELECT pa.user_id, u.email, pa.granted_at, pa.note
FROM platform_admins pa JOIN auth.users u ON u.id = pa.user_id;
```

Subsequent operators are granted by an existing one:

```sql
INSERT INTO platform_admins (user_id, granted_by, note)
SELECT incoming.id, granting.id, 'on-call support'
FROM auth.users incoming, auth.users granting
WHERE incoming.email = 'support@example.com'
  AND granting.email = 'operator@example.com'
ON CONFLICT (user_id) DO NOTHING;
```

Revoking:

```sql
DELETE FROM platform_admins WHERE user_id = (
  SELECT id FROM auth.users WHERE email = 'support@example.com'
);
```

Revoking also ends any support session that person had open: the server
re-reads `platform_admins` on every request (`resolveSupportSession`) and
so does the RLS predicate (`has_open_support_session`, migration 057).

### What a support session is

`POST /api/platform/impersonate` with `{ account_id, reason }` opens one.
The reason is mandatory and has a minimum length — it is the column that
makes the audit trail worth keeping. Every open and every close is a row
in `impersonation_log`.

A session lasts 30 minutes and is **read-only**, enforced in four places
because there are four ways out of this application:

| Layer                   | What it stops                                                                                                                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RLS (057)               | Only SELECT policies learned the support predicate, so the impersonated account cannot be written to at all — including by requests the browser sends straight to Supabase.                                                       |
| `middleware.ts`         | Any mutating request that reaches Next gets a 403, whatever route it was for.                                                                                                                                                     |
| `@/lib/supabase/client` | The browser client refuses `insert/update/delete/upsert/rpc` and every writing `storage` operation (uploads included), which is what stops an operator from editing **their own** company by mistake under the customer's banner. |
| Effective role `viewer` | Every `requireRole()` above `viewer` refuses.                                                                                                                                                                                     |

The operator never stops being themselves: `profiles.account_id` is never
moved. The account swap is derived per request from a signed, `httpOnly`
cookie plus the open row in `impersonation_log`, and it expires on its
own.

#### What the operator sees

Widening the SELECT policies (057) made the customer's rows readable, but
it also stopped RLS from being a filter for _one_ account: it now answers
"my account **or** the one I am supporting". So the browser is told which
account it is showing — the companion flag cookie `wacrm_support_active`
carries the impersonated `account_id`, `useAuth().accountId` returns it
while the session lasts, and every list in the panel filters by it
explicitly. Without that, contacts, conversations, pipelines and
broadcasts came back as both companies' rows merged under the customer's
name.

The flag grants nothing. It is readable and writable by the browser, and
all it does is add `account_id = <uuid>` to the operator's own queries —
a filter can only remove rows, and RLS still decides which ones come
back.

Two things a support session deliberately does **not** show:

- **Attachments.** The signed URL for every attachment is requested by
  the browser with the user's own JWT (`src/lib/media/signed-url.ts`), so
  the bucket policy decides — and the `storage.objects` policies were not
  widened. During a session no attachment of the customer's loads.
- **Lists that are scoped by the signed-in person rather than the
  account** — the template and tag managers' own `user_id` filters, and
  the notification bell. They come back empty, which is the truth: those
  rows are the operator's, not the customer's.

### Auditing

```sql
-- The last sessions, and whether they were closed.
SELECT actor_user_id, account_id, account_name, reason,
       started_at, expires_at, ended_at, ended_reason
FROM impersonation_log
ORDER BY started_at DESC
LIMIT 50;

-- Sessions still open right now.
SELECT * FROM impersonation_log
WHERE ended_at IS NULL AND expires_at > now();
```

`impersonation_log` has no foreign keys on purpose: the trail has to
survive deleting the audited account or the auditing user, which is
precisely when somebody would want to read it. That is also why it stores
`account_name` as a snapshot.

Rows whose deadline passed with nobody around to close them are swept the
next time any operator opens or closes a session. `expires_at` is on the
row regardless, so the real window is auditable even when `ended_at` is
still null.
