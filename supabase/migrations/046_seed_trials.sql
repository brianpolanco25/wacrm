-- ============================================================
-- 046_seed_trials.sql — Fase 3 (SaaS): la prueba de 14 días
--
-- Hasta aquí `subscriptions` estaba vacía y `getEntitlements()` resolvía
-- una cuenta sin fila al plan `pro` en `trialing` con `trial_ends_at`
-- nulo (entitlements.ts, f0.3). Eso basta para decidir permisos, pero no
-- para decir «tu prueba termina el día X»: sin fila no hay fecha, ni
-- historial, ni nada que el área de suscripción (§6) pueda mostrar.
--
-- Esta migración materializa la prueba:
--
--   * Retroactivo — una fila `pro` / `trialing` por cada cuenta que ya
--     existe, con 14 días contados DESDE EL DESPLIEGUE, no desde el alta
--     de la cuenta. Contarlos desde `accounts.created_at` dejaría a todos
--     los clientes actuales con la prueba vencida el mismo día que se
--     aplica la migración, que es exactamente el regalo que no queremos
--     hacerle a nadie.
--   * Hacia adelante — un trigger `AFTER INSERT ON accounts`, que cubre
--     los dos caminos por los que nace una cuenta: `handle_new_user()`
--     (017, alta normal) y `remove_account_member()` (018, a quien
--     sacan de un equipo y recupera cuenta personal). Ponerlo en el
--     trigger y no en el código de la aplicación evita que un tercer
--     camino futuro se olvide de sembrar.
--
-- El plan de la prueba es `pro`: mismo valor que ya devolvía la capa de
-- permisos para una cuenta sin fila, de modo que aplicar esta migración
-- no cambia lo que nadie puede hacer. Es una materialización, no una
-- decisión nueva.
--
-- OJO, el enganche con 041: `subscriptions.account_id` es
-- `ON DELETE RESTRICT`. En cuanto TODA cuenta tiene fila, el
-- `DELETE FROM accounts` de `redeem_invitation()` (019/049) deja de
-- funcionar y aceptar una invitación revienta con 23503. Eso lo arregla
-- la 052, que va en el mismo commit; las dos son una sola unidad.
--
-- Lo que esta migración NO hace: vencer la prueba. Nada mueve
-- `trialing` a `expired` cuando pasa `trial_ends_at` — haría falta un
-- trabajo programado que esta fase no tiene dónde alojar. La fecha se
-- siembra para que la interfaz la muestre y para que ese trabajo, cuando
-- exista, tenga de dónde leer. Anotado como deuda en
-- `progress/impl_enforce-limits.md`.
--
-- Idempotente — safe to re-run: INSERT … ON CONFLICT DO NOTHING,
-- CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS + CREATE TRIGGER.
-- ============================================================

-- ============================================================
-- 1. Duración de la prueba, en un solo sitio
-- ============================================================
CREATE OR REPLACE FUNCTION public.trial_period()
RETURNS interval
LANGUAGE sql
IMMUTABLE
AS $$ SELECT interval '14 days' $$;

COMMENT ON FUNCTION public.trial_period() IS
  'Duración de la prueba gratuita (fase 3 §4). Cambiarla aquí la cambia para el retroactivo y para el trigger a la vez.';

-- ============================================================
-- 2. Semilla hacia adelante
--
-- SECURITY DEFINER y propiedad de postgres: `subscriptions` tiene RLS
-- activa y ninguna política de escritura (041), así que el INSERT solo
-- puede salir del dueño de la tabla. Sin esto, una cuenta creada por
-- cualquier camino que no sea el rol de servicio nacería sin fila.
--
-- `ON CONFLICT DO NOTHING`: si alguien (el webhook, una restauración)
-- ya puso la fila, esta no la pisa.
--
-- El bloque EXCEPTION replica la decisión de `handle_new_user()`: un
-- fallo sembrando la prueba no puede impedir que se cree la cuenta. Una
-- cuenta sin fila sigue funcionando — `getEntitlements()` la resuelve
-- al mismo plan `pro` en `trialing`, solo que sin fecha.
-- ============================================================
CREATE OR REPLACE FUNCTION public.seed_account_trial()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO subscriptions (account_id, plan_id, status, trial_ends_at)
  VALUES (NEW.id, 'pro', 'trialing', now() + trial_period())
  ON CONFLICT (account_id) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to seed the trial subscription for account %: %',
    NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.seed_account_trial() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_account_created_seed_trial ON accounts;
CREATE TRIGGER on_account_created_seed_trial
  AFTER INSERT ON accounts
  FOR EACH ROW EXECUTE FUNCTION public.seed_account_trial();

-- ============================================================
-- 3. Retroactivo
--
-- Una pasada sobre las cuentas que ya existen. `ON CONFLICT DO NOTHING`
-- hace la migración reejecutable sin renovar la prueba de nadie: quien
-- ya tiene fila (prueba o plan de pago) se queda como está.
-- ============================================================
INSERT INTO subscriptions (account_id, plan_id, status, trial_ends_at)
SELECT a.id, 'pro', 'trialing', now() + trial_period()
FROM accounts a
ON CONFLICT (account_id) DO NOTHING;
