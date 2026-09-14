# Informe del implementer — fase 0 (f0.1–f0.4)

Reconstruido por el líder a partir del informe que el agente devolvió por chat antes de que
existiera `progress/`. Rama `saas/fase-0-cimientos` (base `61c1fbb`), worktree
`.claude/worktrees/agent-a85d874ab350adc04`.

## Commits
| SHA | Feature | Mensaje |
|---|---|---|
| 96474fc | f0.1 | feat: dar integridad referencial a conversations.assigned_agent_id |
| 62a0742 | f0.2 | feat: crear el modelo de facturación (plans, subscriptions, usage_counters, billing_events) |
| 2645848 | f0.3 | feat: añadir la capa de permisos por plan (entitlements) sin cablearla |
| afbaecb | f0.4 | feat: permitir una clave de IA a nivel de plataforma (supuesto S1) |
| 8854c65 | docs | documentar la fase 0 en CHANGELOG y las claves de IA de plataforma |

## Compuerta declarada por el implementer
- `scripts/replay-migrations.sh` exit 0 (41 migraciones + verify-schema OK).
- lint 0 errores (37 warnings preexistentes), typecheck OK, build OK.
- test 871/873: los 2 fallos son `src/lib/dashboard/date-utils.test.ts` (TZ ≠ UTC, preexistente).

## Criterios ↔ cobertura declarada
- FK `ON DELETE SET NULL` + índice: verificado contra base real (`scratchpad/fase0-checks.sql`,
  ya no disponible; el reviewer debe rehacer la comprobación y guardarla en `progress/checks_fase-0.sql`).
- verify-schema: aserciones de constraint (`confdeltype='n'`), índice, 4 tablas, `increment_usage`,
  3 planes, RLS en `subscriptions`.
- `entitlements.test.ts`: plan de prueba sin suscripción; `assertQuota` con límite, `null`,
  métrica desconocida, fila ausente; `readOnly` por estado (`it.each`); test de fuga por `account_id`.
- `increment_usage` bajo concurrencia (100 → 100) y RLS de `subscriptions`/`usage_counters`/
  `billing_events`/`plans` con `SET ROLE authenticated`: verificados contra base real (mismo SQL perdido).
- S1: `AI_PLATFORM_OPENAI_API_KEY` y `AI_PLATFORM_ANTHROPIC_API_KEY`; `ai_configs.api_key` pasa a
  nullable en 041; `GET /api/ai/config` devuelve `platform_key_available`; tests en `config.test.ts`
  y en las rutas de config/test de IA.

## Decisiones
1. Dos variables de plataforma, una por proveedor.
2. `plans_select` solo `authenticated`; `anon` no lee el catálogo.
3. `cancelled` no es readOnly; estado desconocido → `trialing`; plan ausente o error de BD → lanza.
4. Exporta además `assertFeature`, `isReadOnly`, `currentPeriodStart`, `normalizeLimits`, `TRIAL_PLAN_ID`.

## Deuda declarada
- `date-utils.test.ts` depende de TZ.
- Un tenant con clave propia no puede volver a la de plataforma desde la UI (envía `''`).
- `AiConfig` no propaga `source` (propia/plataforma).
- Prettier reformateó por completo `src/lib/ai/config.ts`, `api/ai/config/route.ts`, `api/ai/test/route.ts`.
- `.env.local.example` no editado (bloqueado por permisos).
