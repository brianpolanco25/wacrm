-- ============================================================
-- 044_private_media_buckets.sql
--
-- Makes the two media buckets private and replaces their "anyone with
-- the URL can read" policies with account-scoped ones.
--
-- Why. `chat-media` (023) and `flow-media` (016) were created with
-- `public = TRUE` and a SELECT policy that was literally
-- `USING (bucket_id = 'chat-media')`: any holder of a URL could read any
-- account's attachment — invoices, ID documents, voice notes. Writes were
-- already scoped to the account that owns the path's first segment
-- (`account-<uuid>`, migrations 020/023); reads were not. The bucket was
-- public for one reason only: Meta fetched outbound media from it at
-- send time. Outbound sends now upload the bytes to Meta and send by
-- media id (`src/lib/whatsapp/outbound-media.ts`), so nothing outside
-- this app needs to read these buckets any more.
--
-- ┌─────────────────────────────────────────────────────────────────┐
-- │ DEPLOY ORDER — read before applying to production.              │
-- │                                                                 │
-- │ Apply this migration ONLY AFTER the release that sends media by │
-- │ media id is live in production and you have verified that       │
-- │ outbound attachments (composer, Flow send_media node, template  │
-- │ media headers in a broadcast) still reach the recipient. That   │
-- │ code works with the buckets public or private; the OLD code     │
-- │ (Meta fetching a public link) breaks the moment this runs.      │
-- │ CI replays every migration on a clean database, so this file is │
-- │ exercised there regardless — the ordering constraint is about   │
-- │ production only. See docs/security.md, "Private attachments".   │
-- └─────────────────────────────────────────────────────────────────┘
--
-- What the UI does afterwards: `messages.media_url` and Flow node
-- `media_url` keep the `…/object/public/<bucket>/<path>` shape as their
-- stored form; the browser exchanges it for a 10-minute signed URL via
-- `createSignedUrl` with the user's own session (`src/lib/media/
-- signed-url.ts`). The storage API checks the SELECT policy below before
-- signing, so the same rule gates direct reads and signed URLs.
--
-- Legacy paths. Migration 016 wrote flow media under `<auth.uid()>/…`
-- and 020 kept those writable by their uploader. The read policies below
-- resolve that uploader's account and accept every member of it, so an old
-- attachment remains visible after its uploader shares the account or leaves.
-- The same clause is included for chat-media for uniformity; it never had
-- uid-scoped paths, so it matches nothing there.
--
-- Rollback: `UPDATE storage.buckets SET public = TRUE WHERE id IN
-- ('chat-media','flow-media')` plus re-creating the two dropped policies
-- from 016/023. Signed URLs and media-id sends keep working either way.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. Buckets go private
-- ============================================================
UPDATE storage.buckets
SET public = FALSE
WHERE id IN ('chat-media', 'flow-media')
  AND public IS DISTINCT FROM FALSE;

-- ============================================================
-- 2. Reads: account members only
--
-- Same predicate shape as the write policies from 020/023: the path's
-- first segment must be `account-<account_id>` for the caller's account,
-- OR (legacy) a uid whose account includes the caller.
-- ============================================================
DROP POLICY IF EXISTS "Chat media is publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Flow media is publicly readable" ON storage.objects;

DROP POLICY IF EXISTS "Members can read chat media" ON storage.objects;
CREATE POLICY "Members can read chat media"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'chat-media'
    AND (
      EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid()
          AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
      )
      OR EXISTS (
        SELECT 1 FROM public.profiles legacy_uploader
        WHERE legacy_uploader.user_id::text = (storage.foldername(name))[1]
          AND is_account_member(legacy_uploader.account_id)
      )
    )
  );

DROP POLICY IF EXISTS "Members can read flow media" ON storage.objects;
CREATE POLICY "Members can read flow media"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'flow-media'
    AND (
      EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid()
          AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
      )
      OR EXISTS (
        SELECT 1 FROM public.profiles legacy_uploader
        WHERE legacy_uploader.user_id::text = (storage.foldername(name))[1]
          AND is_account_member(legacy_uploader.account_id)
      )
    )
  );
