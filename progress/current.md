# Estado actual

Actualizado: 2026-09-14. 27 de 27 features aprobadas (programa SaaS 22 + fase 6 de producto 5). `feat/saas-multiempresa` @ 50c9758
integra fases 0–4 y la fase 6 (Cabbity CRM, banner de trial, Inicio a 35 USD, español por defecto, BSUID de WhatsApp); migraciones hasta la 060. Base local Supabase (Docker) al día con las 60. Nada pusheado. Este archivo se regenera desde `feature_list.json`
(fuente de verdad); las notas de trabajo de los agentes van a `progress/impl_*.md`, no aquí.

## Ramas

| Fase | Rama | Worktree | Base |
|---|---|---|---|
| 0 | `saas/fase-0-cimientos` | `.claude/worktrees/agent-a85d874ab350adc04` | feat/saas-multiempresa |
| 1 | `saas/fase-1-bandeja` | `.claude/worktrees/fase-1` | saas/fase-0-cimientos |
| 2 | `saas/fase-2-seguridad` | `.claude/worktrees/agent-a4220e4b5ba8896fd` | feat/saas-multiempresa |
| 3 | `saas/fase-3-facturacion` | `.claude/worktrees/fase-3` | saas/fase-0-cimientos |
| 4 | `saas/fase-4-plataforma` | `.claude/worktrees/fase-4` | saas/integracion |
| 4 (f4.2) | `saas/fase-4-multinumero` | `.claude/worktrees/fase-4-multinumero` | saas/integracion @ e6ceba2 |

## Features

| Fase | Feature | Estado | Nota |
|---|---|---|---|
| 0 | f0.1 assignment-integrity | done |  |
| 0 | f0.2 billing-model | done | APPROVED tras 324f087 (RESTRICT, 047_ai_platform_key.sql, checks SQL). Fase 1 y 3 deben fusionar saas/fase-0-cimientos para heredar la 04… |
| 0 | f0.3 entitlements | done |  |
| 0 | f0.4 platform-ai-key | done | Corrección 8909d90 (key_source en ai_usage_log vía 047, guardado sin bloqueo, camino BYO→plataforma). Segunda ronda CHANGES_REQUESTED: en… |
| 1 | f1.1 pick-available-agent | done | APPROVED tras fac4d40 (RPC restringida a service_role, SQL de comprobación) y la decisión CP6 = en + ko. |
| 1 | f1.2 handoff-message | done | APPROVED tras a492504. Default sembrado en inglés (decisión del líder); incluye el arreglo de la guarda fixed/destino heredada de f1.1. |
| 1 | f1.3 attention-state-list | done | Corrección 4c63367 (fallo de red = desconocido, guarda en el filtro, closed excluido, TTL en caché). APPROVED. |
| 1 | f1.4 per-message-guard | done | CHANGES_REQUESTED: el motor ignora la reserva al reanudar un wait (doble envío); afirmaciones falsas sobre la garantía; IA responde en hi… |
| 1 | f1.5 ai-replies-counter | done | APPROVED. Fase 1 completa en saas/fase-1-bandeja @ 96e02fa (incluye fase 0). |
| 2 | f2.1 private-media | done | Migración 044 solo se aplica en producción tras verificar envíos por media id. |
| 2 | f2.2 tenant-isolation-suite | done | Segunda ronda CHANGES_REQUESTED (menor): el waiver de automations/select por id bendice la lectura del motor que 8413526 arregló; falta c… |
| 2 | f2.3 versioned-encryption | done | CHANGES_REQUESTED: el anillo de claves en CBC (no autenticado) puede sobrescribir tokens con basura; formato nuevo irreversible sin aviso… |
| 2 | f2.4 platform-verify-token | done | CHANGES_REQUESTED (menor): tests dependen del entorno, falta .trim() y warn en el 403, variable ausente en docker.md, sin informe. APPROV… |
| 3 | f3.1 paypal-client-catalog | done | APPROVED tras la corrección d44d68e. El cambio de tsconfig (allowImportingTsExtensions) fue aprobado. |
| 3 | f3.2 checkout-flow | done | CHANGES_REQUESTED: la FK RESTRICT de checkout_intents rompe redeem_invitation() (borra la cuenta personal vacía del invitado); guardián a… |
| 3 | f3.3 paypal-webhook | done | CHANGES_REQUESTED: re-contratar tras cancelar nunca activa (guarda por provider_subscription_id); reenvío de PayPal choca con UNIQUE y la… |
| 3 | f3.4 enforce-limits | done | CHANGES_REQUESTED: broadcast_recipients solo en la ruta del panel (v1/broadcasts y resume sin tope ni conteo); comentario del lote falso … |
| 3 | f3.5 subscription-settings-ui | done | CHANGES_REQUESTED: re-contratar tras cancelar deja la fila active+cancel_at_period_end y el webhook no adopta la suscripción nueva (paga … |
| 4 | f4.1 embedded-signup | done | Reviewer APPROVED (b77e7f0, 8adcd7a, ddd6c38) pero el líder verificó la doc viva de Meta (progress/meta_embedded-signup-verificacion.md):… |
| 4 | f4.2 multi-number | done | APPROVED (ff3dca4, 9b054ef, 09f71ba); fusionada ff en saas/integracion. Migración 053: retira UNIQUE(account_id), índice (account_id, pho… |
| 4 | f4.3 platform-admins-panel | done | APPROVED (47a091c, 1b989f4, 1ff573c; migración 058; manual_hold_* en subscriptions). Tras f4.4 y tras fusionar fase 3 en saas/integracion… |
| 4 | f4.4 impersonation-audit | done | CHANGES_REQUESTED: el panel habla con Supabase desde el navegador con el JWT del operador, así que en soporte ve SUS datos etiquetados co… |
| 6 | p6.1 rebrand-cabbity | done | Nombre visible: Cabbity CRM. No se toca package.json name (CP5) salvo que el humano lo pida. |
| 6 | p6.2 trial-banner | done |  |
| 6 | p6.3 plan-prices-35 | done | Migración 059; plan inicio a 35 USD/mes; anual con el mismo descuento relativo que hoy. |
| 6 | p6.4 spanish-default | done | Crea messages/es.json completo, NEXT_PUBLIC_APP_LOCALE por defecto es; CP6 pasa a exigir es+en+ko con las mismas claves. Va la última par… |
| 6 | p6.5 whatsapp-bsuid | done | Aprobado por el humano el 2026-09-14; va detrás de p6.4 en saas/producto. Migración 060. Spec en progress/spec_producto.md#5 (verificado … |

## Integración

`saas/integracion`: fases 0+1 (96e02fa) + fase 2 (9680b68) + fase 3 (63280f2 + fix e6ceba2,
informe `progress/impl_integracion-fase-3.md`): una sola contabilización de `ai_replies`
(`recordUsage` de f3.4; `countAiReply` de f1.5 retirado), fixtures de `plans`/`subscriptions`
en la suite de aislamiento y waiver estrecho para `plans` (tabla global sin `account_id`).
1554 tests; replay 040–052 + 056 verde. Pendiente: traer e6ceba2 a `saas/fase-4-plataforma`
cuando f4.4 termine; fusionar `saas/fase-4-multinumero` y `saas/fase-4-plataforma` en
`saas/integracion` al cerrar cada una.

## Decisiones tomadas por el líder (no están en la spec)

- CP6 = `messages/en.json` + `messages/ko.json`; no existe `es.json` y no se crea.
- 041 editada en sitio (CASCADE → RESTRICT); 043 editada en sitio (default del aviso en inglés).
- Numeración: 040–041, 047 fase 0; 042–043, 051 fase 1; 044 fase 2; 045–046, 048–050, 052, 056
  fase 3; 053 f4.2; 054 f4.1; 055, 057 f4.4.
- Fase 4: orden f4.4 → f4.2 → f4.1 → f4.3; plan en `progress/plan_embedded-signup.md`.
- Impersonación: lectura real por RLS (predicado de sesión de soporte, solo SELECT), guarda de
  mutaciones en el cliente de navegador, revocación por fila abierta, accountId efectivo en el
  navegador = cuenta impersonada.
- Re-contratar tras cancelar: el webhook adopta la suscripción nueva sobre filas con
  `cancel_at_period_end`.

## Fase 6 (ajustes de producto, 2026-09-14)

Rama `saas/producto` (worktree `.claude/worktrees/producto`), fusionada ff en
`feat/saas-multiempresa` @ 50c9758. Spec en `progress/spec_producto.md`. Nombre visible Cabbity
CRM (no el técnico); banner de trial en cabecera; plan Inicio 35/350 (059); `es.json` completo y
`NEXT_PUBLIC_APP_LOCALE` por defecto `es` (CP6 = es+en+ko); BSUID/usernames de WhatsApp (060:
`contacts.wa_user_id`, `wa_username`, `phone` nullable; webhook por BSUID; envío con `recipient`).
Deuda: botón `REQUEST_CONTACT_INFO` en plantillas; planes de PayPal ya creados no se reprecian,
se versionan con el bootstrap de f3.1.

## Pendiente para el humano

- `.env.local.example` (bloqueado a los agentes): `ENCRYPTION_KEY_PREVIOUS`,
  `META_WEBHOOK_VERIFY_TOKEN`, `PAYPAL_WEBHOOK_ID`, `META_CONFIG_ID`, `META_GRAPH_VERSION`,
  `NEXT_PUBLIC_APP_LOCALE` (defecto `es`).
- Commitear en `feat/saas-multiempresa` el estado del harness que sigue sin commit: `CHECKPOINTS.md`
  (CP6 = es+en+ko), `.claude/agents/*.md`, `docs/harness.md`, `feature_list.json`, `progress/`.
- Migraciones remotas: APLICADAS el 2026-09-15 al proyecto Supabase `wacrm` (ref gjrbkxnbgsuzaqfjopof)
  con `supabase db push` tras reparar el historial (001–039 marcadas como aplicadas); copia previa en
  `~/Documents/Dev/backups/wacrm-20260915-1146/`. El remoto está en la 060.
- Sandbox de PayPal: pasos 6–8 de `progress/impl_subscription-settings-ui.md` y el guion de
  `progress/impl_paypal-webhook.md`; bootstrap del catálogo (`progress/impl_paypal-client-catalog.md`).
- Alta del primer administrador de plataforma: SQL manual en `progress/impl_impersonation-audit.md`.
- Trámite con Meta para f4.1 (verificación de negocio, app en producción, permisos, configuración
  de Embedded Signup).
- Ramas: `feat/saas-multiempresa` = `dev` = `main` = 4756a47, pusheadas el 2026-09-15 por orden del
  humano (ff, sin PR). El push a `main` dispara el build de imagen y el webhook de Dokploy.
- Deuda de producto: automatizaciones de un miembro expulsado quedan sin dueño; cupo de IA agotado
  no cede ni avisa; adjuntos no visibles durante el soporte (storage.objects fuera de 057);
  plantillas por WABA y conversaciones por número (fuera de f4.2).

## Incidencias

- 2026-09-10 noche: límite de sesión; cuatro agentes murieron y se relanzaron.
- 2026-09-11: `progress/current.md` fue sobrescrito por notas de un agente de integración;
  se conservó en `progress/scratch_integracion-fase-2.md` y este archivo se regeneró.
- 2026-09-11 noche: dos agentes se colgaron (watchdog de 600 s): el implementer de la 4ª ronda de
  f4.4 (dejó trabajo sin commitear, retomado por otro) y el reviewer de f4.2 (esperaba una
  compuerta en segundo plano; relanzado con la compuerta en primer plano).
- 2026-09-11/12 noche: racha de cuelgues del watchdog (5 agentes, incluido uno que solo leía
  docs y el skill code-review): parece del entorno, no del trabajo. f4.4 dejó WIP commiteado
  (8590794, 1366 tests verdes) y se relanzó solo para cerrar; f4.2 se relanza sin code-review.

## f4.2 — multi-number: implementación terminada, pendiente de revisión

Commits en `saas/fase-4-multinumero`: `ff3dca4` (migración 053 + resolvedor), `9b054ef`
(envío, difusiones, recepción), `09f71ba` (rutas de configuración y UI). Compuerta y replay
verdes; `progress/checks_multi-number.sql` con 7 bloques OK contra el Postgres del harness.
Informe en `progress/impl_multi-number.md`.

Plan ejecutado (de `progress/plan_embedded-signup.md` §6, §7, §9, §12):

1. Migración `053_whatsapp_config_multi_number.sql` + aserciones en `verify-schema.sql`.
2. `src/lib/whatsapp/resolve-config.ts` (resolvedor único, orden fijo) + test.
3. Recepción: sellado de `conversations.whatsapp_config_id` en el webhook.
4. Envío: `send-message.ts`, `/api/whatsapp/send`, `/api/v1/messages` (`from`),
   `resolve-conversation.ts`, `flows/meta-send.ts` ×3, `automations/meta-send.ts`,
   `react`, `media`, plantillas (predeterminado, deuda anotada).
5. Difusiones: `broadcasts.whatsapp_config_id` al crear; `broadcast-core` y
   `broadcast-resume` resuelven por la difusión.
6. Rutas de configuración: `GET/POST/DELETE /api/whatsapp/config`,
   `PATCH/DELETE /api/whatsapp/config/[id]`, `verify-registration?config_id=`.
7. UI: lista de números + formulario, `settings-overview`, `inbox/page`.
8. Tope `numbers` solo para pares nuevos (conserva la semántica de f3.4) + 2 tests.
9. Tests §9 filas 4, 4b, 4c, 4d, 5b + suite de aislamiento; `checks_multi-number.sql`.
10. Compuerta + replay; `CHANGELOG.md`, `docs/public-api.md`; informe.

Terminado. Commit `fb95a3e` en `saas/fase-4-plataforma` (37 archivos). Compuerta verde:
lint 0 errores / 34 avisos (los 37 preexistentes menos tres que las guardas nuevas
satisfacen), typecheck limpio, `TZ=UTC npm test` 109 archivos y 1 329 tests, build OK con
`ƒ Proxy (Middleware)`. `scripts/replay-migrations.sh` salida 0 con `verify-schema.sql: OK`
(057 solo cambia comentarios) y `progress/checks_impersonation-audit.sql` re-ejecutado
contra el contenedor: `NOTICE: checks_impersonation-audit: OK`. Sin claves i18n nuevas
(CP6: `en.json` y `ko.json` intactos y en paridad). Informe: sección «Tercera ronda» de
`progress/impl_impersonation-audit.md`. Pendiente de re-revisión.
