-- ============================================================
-- 098_audit_privilege_hardening.sql — cierra cuatro huecos de la
-- auditoría del 2026-11-20 (progress/audit-2026-11-20/audit-auth.md
-- hallazgos 1, 2, 3 y 5). Todos se alcanzan hablando con Supabase
-- directamente con la clave anon, sin pasar por ninguna ruta.
--
-- C1  profiles.email deja de ser editable por el navegador. Las rutas
--     de plataforma resuelven personas por email (promover operador,
--     altas de miembros): un usuario que se reescribía el email podía
--     acabar recibiendo el rol de operador de otra persona.
-- C2  Fuera la política profiles_insert: con ella, un usuario sin fila
--     de perfil (bootstrap fallido en handle_new_user) podía insertarse
--     en cualquier cuenta como owner. Las filas las crean el trigger
--     (SECURITY DEFINER) y el rol de servicio; ningún cliente inserta.
-- C3  Cinco funciones SECURITY DEFINER sin comprobación de llamante
--     quedan solo para service_role. Los triggers de difusión siguen
--     funcionando: corren como el dueño (postgres).
-- C4  Un viewer ya no puede subir, sobrescribir ni borrar media de chat
--     o de flujos. Las políticas SELECT no cambian.
--
-- Idempotente: CREATE OR REPLACE, DROP ... IF EXISTS, REVOKE/GRANT.
-- ============================================================

-- C1 ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_profile_privilege_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.account_role IS DISTINCT FROM OLD.account_role
      OR NEW.account_id IS DISTINCT FROM OLD.account_id
      OR NEW.email IS DISTINCT FROM OLD.email)
     AND current_user = 'authenticated'
  THEN
    RAISE EXCEPTION
      'account_role, account_id and email cannot be changed directly; use the account member/invitation RPCs'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_profile_privilege_columns() OWNER TO postgres;

-- C2 ---------------------------------------------------------
DROP POLICY IF EXISTS profiles_insert ON public.profiles;

-- C3 ---------------------------------------------------------
REVOKE ALL ON FUNCTION public.record_webhook_failure(uuid, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._bcast_bump(uuid, text, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recompute_broadcast_counts(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.merge_duplicate_contacts() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.merge_duplicate_conversations() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_webhook_failure(uuid, int) TO service_role;
GRANT EXECUTE ON FUNCTION public._bcast_bump(uuid, text, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.recompute_broadcast_counts(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.merge_duplicate_contacts() TO service_role;
GRANT EXECUTE ON FUNCTION public.merge_duplicate_conversations() TO service_role;

-- C4 ---------------------------------------------------------
-- Mismo texto que 023 y 020 más `AND p.account_role <> 'viewer'`.
DROP POLICY IF EXISTS "Members can upload chat media" ON storage.objects;
CREATE POLICY "Members can upload chat media"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'chat-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
        AND p.account_role <> 'viewer'
    )
  );

DROP POLICY IF EXISTS "Members can update chat media" ON storage.objects;
CREATE POLICY "Members can update chat media"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'chat-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
        AND p.account_role <> 'viewer'
    )
  );

DROP POLICY IF EXISTS "Members can delete chat media" ON storage.objects;
CREATE POLICY "Members can delete chat media"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'chat-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
        AND p.account_role <> 'viewer'
    )
  );

DROP POLICY IF EXISTS "Members can upload flow media" ON storage.objects;
CREATE POLICY "Members can upload flow media"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'flow-media'
    AND (
      EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid()
          AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
          AND p.account_role <> 'viewer'
      )
      -- Legado (pre-020): carpeta con el user_id del que subió.
      OR auth.uid()::text = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can update flow media" ON storage.objects;
CREATE POLICY "Members can update flow media"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'flow-media'
    AND (
      EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid()
          AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
          AND p.account_role <> 'viewer'
      )
      OR auth.uid()::text = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can delete flow media" ON storage.objects;
CREATE POLICY "Members can delete flow media"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'flow-media'
    AND (
      EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid()
          AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
          AND p.account_role <> 'viewer'
      )
      OR auth.uid()::text = (storage.foldername(name))[1]
    )
  );
