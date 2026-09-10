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
key id, so they are tried against the active key first and then each
previous key in order. Rows in either shape are rewritten under the
active key the next time they are used (the `isLegacyFormat` write-back
in the send path and the webhook), and by the script below.

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
   and `webhook_endpoints` in batches of 100 (`--batch-size N` to
   change), rewrites only the columns that are not yet under the active
   key, and prints a per-table summary. Node 24 runs the TypeScript
   directly; the `MODULE_TYPELESS_PACKAGE_JSON` warning it prints is
   harmless (`--disable-warning=MODULE_TYPELESS_PACKAGE_JSON` hides it).

4. A row that cannot be decrypted with any configured key is counted as
   `failed`, logged with its table, column and id, and left untouched;
   the script exits 1. Do not proceed to step 5 while anything is
   failing — fix the key ring or have the owner re-enter that secret.
5. When a clean run reports `failed 0` everywhere, remove the old key
   from `ENCRYPTION_KEY_PREVIOUS` and restart.

The same procedure recovers from a suspected key leak; the only
difference is urgency. Until step 5 the old key can still read every
row it ever wrote, so treat steps 2–5 as one change window.

## Webhook verification token

Meta verifies a webhook URL with a `GET ?hub.mode=subscribe&hub.verify_token=…`
challenge. Two ways to answer it:

| Mode                                                         | Configuration                                                                                              | What the `GET` does                                                                                                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform (one Meta app, every tenant behind one webhook URL) | `META_WEBHOOK_VERIFY_TOKEN=<random string>` — the same value you type into the Meta app's webhook settings | Compares against the variable in constant time and answers. **Never reads `whatsapp_config`.** Per-tenant verify tokens stop being credentials. |
| Self-hosted (one install per business)                       | variable unset                                                                                             | Unchanged: walks `whatsapp_config`, decrypts each `verify_token` and answers when one matches.                                                  |

Set the variable once the deployment is registered as a single Meta app;
leave it unset for a self-hosted instance where each tenant brings their
own app. An empty value counts as unset.

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
   JWT before it signs, and migration 044's policy is "members of the
   account named by the path's first segment (or the legacy uploader)" —
   so isolation is enforced by the same rule that gates a direct read,
   with no service-role code path to audit and no new route. Signing
   works the same on a still-public bucket; if it fails for any reason
   the stored URL is used as-is, which is exactly what worked before.

3. **Migration 044** sets `public = FALSE` on both buckets, drops the
   two `… is publicly readable` policies and creates `Members can read
chat media` / `Members can read flow media` with the write policies'
   predicate. Legacy `<auth.uid()>/…` paths from migration 016 stay
   readable by their uploader. `verify-schema.sql` asserts both buckets
   are private and both policies exist.

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

### What is verified manually

Signed-URL expiry (a URL older than ten minutes must be refused) and the
RLS policy itself (a user in account B asking to sign or read account
A's object must fail) are enforced by Supabase, not by application code,
so they are checked against a real project rather than in unit tests.

### Known debt

- The media-id cache lives in process memory. A small table keyed on
  `(phone_number_id, bucket, path)` with Meta's ~30-day expiry would
  survive restarts and multiple instances; it was left out so 044 stays a
  pure privatisation step.
- `GET /api/v1/conversations/{id}/messages` returns `media_url` in the
  stored public shape. After 044 an integrator cannot fetch it directly;
  a follow-up should return a signed URL (service role, scoped to the
  key's account) or a proxy route.
