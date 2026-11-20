# Review — p16.5 audit-engines (ronda 2)

**Veredicto:** APPROVED

Rama `fix/audit-engines`: `f4dad32` (ronda 1) + `a8d006c` (cambios de la revisión). La ronda 1 salió CHANGES_REQUESTED por CP3 (consultas de servicio sin `account_id`) y por tres tests que faltaban; lo que se encontró entonces se resume abajo.

## Compuerta (ronda 2, ejecutada por mí en el worktree)
- lint (`npx eslint . --ignore-pattern '.claude/**'`): verde (0 errores).
- typecheck: verde.
- `TZ=UTC npm test`: verde, 419 archivos / 6393 tests (esta vez tampoco falló el `middleware.test.ts` que es inestable con carga).
- build (variables dummy): verde.
- replay-migrations: n/a (sin SQL).

## Tests rojos sin el arreglo
- Ronda 1: con el código de `main` fallan los 5 tests nuevos (E1, E2, E3 ×2, E5).
- Ronda 2: quité `stepsChanged` del PATCH y devolví el reclamo a 10 s → fallan "renaming with the same steps keeps the parked run pending…" y "una fila reclamada cuyo intento nunca termina vuelve sola…".

## Reformateo de prettier
Pasé por prettier la versión anterior de `steps-tree.ts`, `engine/route.ts` y `[id]/route.ts` y la comparé con la nueva. Solo cambian E1, E2 y la guarda `stepsChanged` + `accountId`. Todo lo demás es formato.

## Cambios requeridos de la ronda 1
1. [x] `replaceSteps(automationId, accountId, input)` filtra por `.eq('account_id', accountId)` en los dos UPDATE (`steps-tree.ts:48`, `:65`), y `[id]/route.ts:163` le pasa `accountId`. El test de fuga usa filas de la cuenta B con el **mismo** `automation_id` y quedan intactas.
2. [x] `steps-tree.test.ts` › "does not touch a run already running, nor its log".
3. [x] `flows/engine.test.ts` › "a button back to its own menu, tapped twice in a row, re-sends the menu each time": `send.buttons` ×2, sin `advance_cycle`, la ejecución sigue `active`.
4. [x] Si falla el UPDATE de `automation_logs`, se registra con `console.error` (`steps-tree.ts:67-68`).
5. [x] `queue.test.ts` › "una fila reclamada cuyo intento nunca termina vuelve sola…": a 59 s el barrido no la toca; a 61 s la reintenta (`attempt 2`, `delivered`).

## Ajustes del líder
- **E2, `stepsChanged`** (`steps-tree.ts:88-127`). Compara una firma de `[step_type, config con claves ordenadas, ramas yes/no solo si es condition]`, recorrida en orden.
  - ¿Puede dar «iguales» con pasos distintos? Revisé cada caso:
    - Orden: es posición en el array, así que sale en la firma.
    - Rama y padre: el anidamiento yes/no sale en la firma.
    - Configuración anidada: `sortKeys` es recursivo y los arrays mantienen su orden.
    - Claves en otro orden: se tratan como iguales, que es lo correcto porque jsonb no guarda el orden.
    - Ramas que ignora la firma en un paso que no es `condition`: `insertSteps` (`:157`) tampoco las guarda, así que no se pierde nada.
    - Entrada plana de plantilla: pasa por `seedsToTree` igual que en `insertSteps`.
    - `id` que mande el cliente: no entra en la firma; si los pasos son iguales no se reemplaza nada y los ids guardados se mantienen. No hace daño.
    - `undefined` frente a ausente: `JSON.stringify` los trata igual, y jsonb también.
    - `loadStepsTree` ordena por `position` global, lo que mantiene el orden dentro de cada padre.

    No encontré ningún falso «iguales».
  - ¿Da «distintos» siempre? No: el builder envía `toApiSteps` (`step_type`, `step_config`, `branches`) a partir de `fromServerSteps`, que copia `step_config` tal cual. El test de la ruta reproduce ese guardado con las claves en otro orden y comprueba que la ejecución sigue `pending` y los ids no cambian.
  - Si falla la lectura, cuenta como «distintos» y se reemplaza, que es el comportamiento anterior.
  - Tests: `steps-tree.test.ts` › "the stored tree, resent as is (other key order), is unchanged" / "a different config, branch or order is a change"; `[id]/route.test.ts` › las dos de PATCH.
- **E3, reclamo de 60 s**: `CLAIM_LEASE_MS = 60_000` (`queue.ts:35`, `:252`). El reintento manual no cambia, porque reinicia el `next_attempt_at`. Una entrega cuyo proceso muere vuelve en el barrido del minuto siguiente.
- **E5, solo cuentan los nodos que envían** (`flows/engine.ts:604-610`, `:643-652`). `SENDING_NODE_TYPES = send_message, send_media, send_buttons, send_list, collect_input`. Contrasté la lista con la unión `FlowNodeConfig` (`flows/types.ts:184-193`): fuera de la lista quedan `start`, `condition`, `set_tag`, `handoff` y `end`. `handoff` y `end` terminan la llamada, así que no pueden repetirse. La lista está completa. Test: "a non-sending loop (condition → set_tag → same condition) ends normally".

## Trazabilidad criterio ↔ test
- E1: [x] `src/app/api/automations/engine/route.test.ts` › "drops a caller-supplied conversation_id…"
- E2 (pending → failed, motivo en el log): [x] `src/lib/automations/steps-tree.test.ts` › "saving cancels the runs parked…"
- E2 (`running` intacta): [x] "does not touch a run already running, nor its log"
- E2 (fuga entre cuentas): [x] "leaves another account’s rows with the same automation id alone"
- E2 (guardar sin cambios no cancela): [x] `src/app/api/automations/[id]/route.test.ts` › "renaming with the same steps…" / "different steps replace them…"
- E3 (reclamada no vencida): [x] `src/lib/webhooks/queue.test.ts` › "una fila reclamada no aparece como vencida…"
- E3 (intento viejo no pisa): [x] "un intento viejo no pisa el resultado…"
- E3 (proceso muerto vuelve solo): [x] "una fila reclamada cuyo intento nunca termina vuelve sola…"
- E4 (Santo Domingo con hora fija, ventana que cruza medianoche, variable de entorno, zona inválida, sin zona): [x] `src/lib/automations/engine.test.ts`, bloque `time_of_day — evaluated in the account zone`
- E5 (`A → A` envía una vez y falla): [x] `src/lib/flows/engine.test.ts` › "a cycle of auto-advancing nodes…"
- E5 (los bucles legítimos no fallan): [x] "a button back to its own menu…" y "a non-sending loop…"

## Checkpoints
- CP1 Compuerta: [x]
- CP2 Migraciones: [x] n/a
- CP3 Aislamiento: [x] los UPDATE nuevos con rol de servicio filtran por `account_id`, con test de fuga. Las consultas que solo leen `automation_steps` (`loadStepsTree`/`stepsChanged`) filtran solo por `automation_id`, como antes. Esa tabla no tiene `account_id` y el PATCH ya comprobó antes que la automatización es de la cuenta.
- CP4 Tests: [x]
- CP5 Sin dependencias: [x]
- CP6 i18n: [x] `config.timeOfDayHint` en es y en
- CP7 Next 16: [x] no se usa ninguna API de framework nueva
- CP8 Alcance: [x] `[id]/route.ts` lo justifica el ajuste de E2. El resto, igual que en la ronda 1.
- CP9 Documentación: [x] CHANGELOG y `docs/docker.md`. **Pendiente para el humano o el líder:** añadir `AUTOMATION_DEFAULT_TIMEZONE` a `.env.local.example` (el implementer no tiene permiso).
- CP10 Git: [x] dos commits `fix:` con Co-Authored-By, sin push
- CP11 Entrante: [x] no se toca

## Riesgos que quedan (no bloquean, deuda anotada)
1. Si `replaceSteps` falla después de cancelar (el `delete` o el `insert`), las ejecuciones aparcadas ya están `failed` aunque los pasos no hayan cambiado. El spec descartó la transacción.
2. Un `markFailed` de un intento viejo sigue llamando a `record_webhook_failure`. La rama `dead` de «endpoint borrado» (`queue.ts:352-359`) no filtra por `attempt`. Con un reclamo de 60 s el solapamiento es muy improbable. Ya está en la deuda del informe.
3. E5: un bucle sin nodos que envían, como `set_tag add X → set_tag remove X → …`, puede disparar automatizaciones `tag_added` hasta el tope de 64 vueltas (unas 32 altas reales), y esas automatizaciones sí pueden enviar. Ya pasaba en `main`; no lo empeora este cambio.
4. E1 descarta siempre el `conversation_id` del llamador, así que `conversation_idle` no aplica en los disparos manuales. Es lo que pidió el spec.

## Hallazgos (archivo:línea)
Ninguno bloqueante.
