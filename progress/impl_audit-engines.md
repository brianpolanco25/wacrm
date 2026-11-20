# impl p16.5 `audit-engines`

Spec: `progress/audit-2026-11-20/fixes.md` §E (E1–E5); detalle `audit-engines.md` hallazgos 1–5.
Rama `fix/audit-engines` (worktree `.claude/worktrees/audit-engines`, desde `main`).

## Plan

1. E1: `delete context.conversation_id` en la ruta + test.
2. E2: `replaceSteps` cancela (`failed`) los `pending` de la automatización antes de borrar pasos; motivo en `automation_logs.error_message`. Test con base falsa.
3. E3: `claimDelivery` mueve `next_attempt_at` a ahora + 2 × `DELIVERY_TIMEOUT_MS`; `markDelivered`/`markFailed` filtran por `attempt`. Dos tests.
4. E4: `time_of_day` con `Intl.DateTimeFormat` en `cfg.timezone` → `AUTOMATION_DEFAULT_TIMEZONE` → reloj del servidor. Texto de ayuda es/en. docs/docker.md.
5. E5: `Set` de nodos visitados en `advanceFromNodeKey`. Test `A → A`.
6. CHANGELOG, compuerta, commit.

### Ronda 2 (review CHANGES_REQUESTED + ajustes del líder)

7. `replaceSteps(automationId, accountId, input)`: `account_id` en los dos UPDATE; error del UPDATE de logs a `console.error`.
8. Tests: fila `running` intacta; fuga real (misma `automation_id`, otra cuenta).
9. PATCH llama a `replaceSteps` solo si los pasos difieren (`stepsChanged`). Test de ruta.
10. E3: reclamo de 60 s (`CLAIM_LEASE_MS`). Test de recuperación con reloj falso.
11. E5: solo cuenta la repetición de nodos que envían. Tests de bucle sin envío y de menú que vuelve a sí mismo.

## Commits

- `f4dad32` fix: motores de automatizaciones, flujos y webhooks salientes (auditoría E1–E5).
- `a8d006c` fix: cambios de la revisión de p16.5 (motores y webhooks).

## Criterio ↔ test

Cada test se comprobó en rojo revirtiendo solo los archivos de código (9 fallos sin los arreglos, todos verdes con ellos).

| Criterio | Test |
| --- | --- |
| E1 `conversation_id` del llamador se descarta | `src/app/api/automations/engine/route.test.ts` › `drops a caller-supplied conversation_id (it would write into another account´s thread)` |
| E2 guardar con ejecución aparcada → `failed`, no se reanuda; log con motivo | `src/lib/automations/steps-tree.test.ts` › `saving cancels the runs parked on this automation, so the cron never resumes them` |
| E2 no toca las `running` ni su log | `steps-tree.test.ts` › `does not touch a run already running, nor its log` |
| E2 fuga: otra cuenta con la misma `automation_id` intacta (rojo sin el filtro `account_id`, comprobado) | `steps-tree.test.ts` › `leaves another account’s rows with the same automation id alone` |
| E2 (líder) mismos pasos → nada cambia | `src/app/api/automations/[id]/route.test.ts` › `renaming with the same steps keeps the parked run pending and the step ids` |
| E2 (líder) pasos distintos → se cancela | `[id]/route.test.ts` › `different steps replace them and cancel the parked run` |
| E2 comparación normalizada (orden de claves, rama, orden) | `steps-tree.test.ts` › `the stored tree, resent as is (other key order), is unchanged`, `a different config, branch or order is a change` |
| E3 fila reclamada no aparece vencida | `src/lib/webhooks/queue.test.ts` › `una fila reclamada no aparece como vencida mientras el intento vuela` |
| E3 intento viejo no pisa uno nuevo | `queue.test.ts` › `un intento viejo no pisa el resultado de uno más nuevo` |
| E3 reclamo de 60 s; fila huérfana vuelve sola | `queue.test.ts` › `una fila reclamada cuyo intento nunca termina vuelve sola al pasar el reclamo` |
| E4 zona de la condición (Santo Domingo, hora fija) | `src/lib/automations/engine.test.ts` › `with a zone in the condition, 3 pm in Santo Domingo is office hours` |
| E4 cae a `AUTOMATION_DEFAULT_TIMEZONE` | `engine.test.ts` › `falls back to AUTOMATION_DEFAULT_TIMEZONE` |
| E4 zona inválida = ausente | `engine.test.ts` › `an invalid zone counts as missing` |
| E4 sin zona, como hoy | `engine.test.ts` › `with no zone at all, keeps the server clock (TZ=UTC in tests)` |
| E5 `A → A` envía una vez y falla | `src/lib/flows/engine.test.ts` › `a cycle of auto-advancing nodes (A → A) sends once and fails the run` |
| E5 (líder) bucle sin envío `condición → set_tag → condición → rama no` termina bien | `flows/engine.test.ts` › `a non-sending loop (condition → set_tag → same condition) ends normally` |
| E5 (review) menú que vuelve a sí mismo, dos pulsaciones | `flows/engine.test.ts` › `a button back to its own menu, tapped twice in a row, re-sends the menu each time` |

Ronda 2: contra el código de `f4dad32` fallan los tests nuevos de mismos pasos (PATCH), bucle sin envío y recuperación del reclamo; el de fuga falla quitando el filtro `account_id`.

## Base real

No aplica: sin migraciones ni SQL nuevo. E2 se verificó contra las migraciones: `automation_pending_executions.status` tiene `CHECK (status IN ('pending','running','done','failed'))` (`006_automations.sql:129-130`), así que `failed` es válido. La tabla no tiene columna de motivo; el motivo va a `automation_logs.error_message` (y `status = 'failed'`, también admitido por su CHECK).

## Verificación manual pendiente

Ninguna que dependa de servicios externos.

## Decisiones

- E2 (ronda 2): `replaceSteps` recibe `accountId` y filtra por él los UPDATE de `automation_pending_executions` y `automation_logs` (único llamador: `PATCH /api/automations/[id]`). El `delete` de `automation_steps` sigue solo por `automation_id`, como antes. Si falla el UPDATE del log se registra con `console.error` (las ejecuciones ya están canceladas). El PATCH compara antes con `stepsChanged(id, steps)`: firma normalizada del árbol (tipo, config con claves ordenadas porque jsonb no conserva el orden, posición, rama y padre por anidamiento; acepta también la forma plana de las semillas); si la lectura falla, cuenta como cambio y reemplaza. Mensaje del log en inglés como el resto de mensajes del motor: «Cancelled: the automation was edited while this run was waiting». Sin transacción: si el insert falla tras el borrado se devuelve el error (500) como hoy; queda comentado en el código.
- E3: el reclamo dura `CLAIM_LEASE_MS = 60_000` (ajuste del líder, en lugar de 2 × timeout). Solo `markDelivered` y `markFailed` filtran por `attempt` (lo que pide el spec). El `record_webhook_failure` de un intento viejo sigue contando un fallo; con el reclamo que oculta la fila, el solapamiento ya no se da salvo reintento manual durante un intento en vuelo.
- E4: la lógica se extrajo a `inTimeOfDayWindow(operand, now, timezone?)` exportada (como `matchesWholeWord`) para probarla con reloj fijo. Se añadió `timezone?: string` a `ConditionStepConfig` (tipo), sin campo en el constructor. Texto de ayuda nuevo `automations.config.timeOfDayHint` bajo el operando cuando el sujeto es `time_of_day`.
- E5 (ronda 2): solo se marca ciclo cuando se repite un nodo que envía (`send_message`, `send_media`, `send_buttons`, `send_list`, `collect_input`; no hay nodo de plantilla en flujos). Condición, etiqueta y `start` pueden repetirse; el tope de 64 los sigue acotando. Motivo `advance_cycle` (evento y `end_reason`).
- Prettier sobre los archivos tocados reformateó por completo `steps-tree.ts`, `engine/route.ts` y (ronda 2) `automations/[id]/route.ts` (no tenían el formato del `.prettierrc`: punto y coma). En `docs/docker.md` se dejó solo la sección nueva (prettier reformateaba tablas ajenas).

## Variables de entorno nuevas

- `AUTOMATION_DEFAULT_TIMEZONE` (opcional, IANA). Documentada en `docs/docker.md`. **`.env.local.example` no se tocó (bloqueado por permisos)**: falta añadirla ahí.

## Deuda fuera de alcance

- Hallazgos 6, 7 y 8 de `audit-engines.md` (wait dentro de rama, pausa ignorada al reanudar, filas `running` huérfanas, duplicación del envío Meta, tablas sin purga).
- `senders` de `automations/meta-send.ts` / `flows/meta-send.ts` siguen actualizando `conversations` por id sin `account_id` (defensa en profundidad; E1 cierra la entrada).
- La actualización `dead` por endpoint borrado en `attemptDelivery` no filtra por `attempt`.
- El validador de flujos no detecta ciclos (el motor ya los corta).

## Compuerta (worktree, verde)

- `npx eslint . --ignore-pattern '.claude/**'`: 0 errores (34 warnings preexistentes, ninguno en archivos tocados).
- `npm run typecheck`: ok.
- `TZ=UTC npm test`: 418 archivos / 6385 tests ok, 7 skipped. En una primera pasada falló por timeout (5,8 s) `src/middleware.test.ts` › «lets the coexistence cron through…» con otros cinco implementers corriendo a la vez; no se tocó, pasa solo (84/84) y en la segunda pasada completa.
- `npm run build` con las variables dummy: ok.
- Sin SQL: `replay-migrations.sh` no aplica.

### Compuerta ronda 2 (`a8d006c`, verde)

- eslint: 0 errores. typecheck: ok. `TZ=UTC npm test`: 419 archivos / 6393 tests ok, 7 skipped (sin fallos). build con variables dummy: ok.
