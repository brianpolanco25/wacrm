# Implementación f1.1 — pick-available-agent (corrección de revisión)

**Estado: BLOCKED.** La corrección de seguridad y pruebas está commiteada y
la compuerta está verde, pero queda el bloqueo de i18n detallado abajo.

## Rama y commits

- Rama: `saas/fase-1-bandeja`
- Implementación original: `20fbd9c`
- Corrección: `fac4d40` (`fix: aísla la selección de operador disponible`)
- El commit preexistente `1292984` corresponde a f1.2 y no fue modificado.

## Cambios

- `pick_available_agent` conserva ejecución solo para `service_role`; se
  revocó `authenticated`, eliminando la lectura cross-tenant posible desde
  una RPC `SECURITY DEFINER` con `p_account_id` controlado por cliente.
- Las lecturas y la actualización de `conversations` de `auto-reply.ts`
  ahora filtran simultáneamente por `id` y `account_id`.
- `verify-schema.sql` comprueba que el RPC existe, que `service_role` puede
  ejecutarlo y que `authenticated` no.
- Se añadió `progress/checks_pick-available-agent.sql`, ejecutable contra el
  Postgres local del harness, y se documentaron 042/043 en Unreleased.

## Criterios y pruebas

| Criterio | Evidencia |
| --- | --- |
| Cargas 5/2/9 escogen carga 2 | SQL local: inserta 5 abiertas, 2 pendientes y 9 abiertas; valida el agente ligero. |
| Latido de diez minutos no es elegible | SQL local: deja solo ese agente stale y un viewer; valida `NULL`. |
| Sin conectado devuelve `NULL` sin lanzar | SQL local; además `engine.test.ts` y `auto-reply.test.ts` cubren el resultado `NULL` como cola. |
| Viewer no es elegible | SQL local con presencia `online` para viewer; valida `NULL`. |
| Cesión IA no pisa humano | `src/lib/ai/auto-reply.test.ts`, caso de hilo ya poseído por humano. |
| Fuga entre cuentas | SQL local comprueba que A no devuelve el agente online de B y que `authenticated` recibe `insufficient_privilege`; test Vitest verifica ambos filtros `account_id` de `auto-reply`. |

## Verificaciones ejecutadas

- `npx vitest run src/lib/ai/auto-reply.test.ts src/lib/automations/engine.test.ts` — 49 pruebas verdes.
- `scripts/replay-migrations.sh "$(pwd)"` con `KEEP=1` — migraciones
  001--043 y `verify-schema.sql` verdes.
- `progress/checks_pick-available-agent.sql` contra ese Postgres local —
  verde; transacción revertida al terminar.
- Compuerta CI completa verde: `npm run lint` (37 warnings preexistentes),
  `npm run typecheck`, `TZ=UTC npm test` (83 archivos, 895 pruebas) y
  build con las variables dummy de `docs/harness.md`.

## Manual, entorno y alcance

- No hay servicios externos ni guion manual para esta corrección.
- No se añadieron variables de entorno ni dependencias.
- Se mantuvo el contrato de `NULL`: sin agente elegible la conversación queda
  en la cola común.
- Se restringió el RPC a procesos de servidor porque no existe un llamador de
  cliente en §1; una futura interfaz que lo necesite deberá implementar una
  RPC autenticada que derive/valide la cuenta antes de conceder ejecución.
- La rama ya contenía el trabajo de f1.2 (`handoff_message`) y el reformateo
  previo del motor de automatizaciones. Esta corrección no añadió trabajo de
  §2 ni reescribió los commits preexistentes; separar históricamente esos
  commits requiere una decisión de integración fuera de esta feature.
- El repositorio solo registra catálogos de interfaz completos en inglés y
  coreano. No se añadió un `messages/es.json` parcial, porque el cargador lo
  preferiría al fallback completo en inglés y degradaría las claves no
  traducidas. Completar y habilitar ese catálogo es una deuda de
  internacionalización transversal, no un cambio seguro de §1.
