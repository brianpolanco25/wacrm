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
