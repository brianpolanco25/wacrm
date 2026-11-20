# impl p16.6 `audit-client` (fixes.md §F, audit-lean.md 1 y 2)

## Plan
1. F1: `key={conversation.id}` en `<MessageComposer>` (`message-thread.tsx`); confirmar el cleanup de desmontaje del composer.
2. F2: helper `fetchAllPages` con `.range()` (páginas de 1000, `.order('id')`) en las lecturas de audiencia «all», etiquetas, campo personalizado, exclusión y relectura de destinatarios; trocear `.in('id', …)` a 500; lanzar si la exclusión falla.
3. Sacar `resolveAudience` (y sus dos auxiliares) a nivel de módulo para testearla sin renderizador de hooks.
4. Tests vitest, CHANGELOG, compuerta, commit.

## Rama y commits
- Rama `fix/audit-client` (worktree `.claude/worktrees/audit-client`), desde `main` 63f581e.
- Commit: `4643ed6` fix: difusiones paginadas y composer remontado por conversación.

## Criterio ↔ test
| Criterio | Test |
|---|---|
| F1: el composer se remonta al cambiar de conversación | `src/components/inbox/message-thread.test.ts` › `keys <MessageComposer> by conversation id` |
| F2: 2 500 contactos → 2 500 destinatarios (audiencia «all») | `src/hooks/use-broadcast-sending.test.ts` › `audience "all" with 2 500 contacts resolves all 2 500` |
| F2: etiqueta con 2 500 miembros, `.in(id)` troceado ≤ 500 | ídem › `a tag with 2 500 members resolves 2 500, chunking the .in(id)` |
| F2: exclusión de > 1000 miembros completa | ídem › `excludes every member of an excluded tag with more than 1000` |
| F2: error en exclusión → no se envía | ídem › `throws when the exclusion read fails, so nothing is sent` |
| F2: relectura de 2 500 `broadcast_recipients` | ídem › `fetchBroadcastRecipients` › `re-reads all 2 500 recipient rows` |
| Review 1: fila repetida entre páginas (offset desplazado) sale una vez | ídem › `a row re-read across pages is sent once` |
| Deuda: búsqueda CSV por teléfono troceada a 500 | ídem › `a CSV of 1 200 phones looks them up in chunks of at most 500` |

Los seis fallan con el código de `main` (comprobado con `git stash`). El fake de Supabase del test corta toda lectura a 1000 filas como PostgREST.
«No se envía» se cubre así: `resolveAudience` lanza y en `createAndSendBroadcast` es el paso 1, antes de insertar el broadcast o llamar a `/api/whatsapp/broadcast`.

## Ronda 2 (review_audit-client.md, CHANGES_REQUESTED)
- Commit 2: `0e49bad fix: difusión sin duplicados entre páginas y búsqueda CSV troceada`. Compuerta verde (lint 0 errores, typecheck, 6383 tests, build); en la primera pasada un test ajeno falló una vez y pasó al repetir la suite (carga de otros worktrees en paralelo). Cambios:
  1. Rama `all` de `resolveAudience` deduplica por `id` (`new Map(rows.map(c => [c.id, c]))`): la paginación por offset puede releer una fila si entra un contacto entre páginas, y `broadcast_recipients` no tiene UNIQUE (broadcast_id, contact_id).
  2. Comentario de la exclusión corregido: se aplica a todos los tipos, CSV incluido (sus contactos ya son filas reales).
  3. `upsertCsvContacts`: `.in('phone', …)` troceado a `IN_CHUNK` (500).
  4. CHANGELOG matizado (campo personalizado, cada contacto una vez, búsqueda CSV troceada).
- Los dos tests nuevos fallan sobre el commit 1 (comprobado con `git stash`).

## F1: cleanup confirmado
`src/components/inbox/message-composer.tsx` (efecto de desmontaje, ~líneas 206-214): `clearTimer()`, `cancelledRef = true`, `recorderRef.current?.stop()` (libera micrófono) y `removeStaged(draftRef.current?.path)` (borra el adjunto subido sin enviar). Con la `key`, cambiar de conversación desmonta y ejecuta ese cleanup; `text` y `draft` vuelven a vacío.
No hay `@testing-library` en el repo (solo `renderToStaticMarkup`), así que el test de F1 fija la `key` sobre el fuente.
Verificación manual (opcional): escribir texto en el chat A, pulsar el chat B → el composer aparece vacío.

## Verificación contra base real
No aplica: sin SQL ni migraciones.

## Decisiones
- Orden estable: `.order('id')` (todas las tablas leídas tienen PK `id`: `contacts`, `contact_tags`, `contact_custom_values`, `broadcast_recipients`).
- La lectura de campo personalizado también se pagina (mismo patrón sin límite, el spec dice «lecturas sin límite de audiencia»).
- `resolveAudience`, `upsertCsvContacts`, `resolveCustomFieldAudience` pasan de closures del hook a funciones de módulo con `accountId` como parámetro; sin cambio de comportamiento. Exportados: `fetchAllPages`, `fetchBroadcastRecipients`, `resolveAudience`.
- La relectura de destinatarios ya no devuelve el texto fijo `Failed to fetch broadcast recipients` a secas: ahora añade `: <mensaje de PostgREST>`.
- Atajo anotado en código (`shortcut:`): una página de menos de 1000 filas se toma como la última; si el `max-rows` del servidor bajara de 1000, habría que bajar `READ_PAGE`.

## Compuerta
`npx eslint . --ignore-pattern '.claude/**'` (0 errores, warnings preexistentes), `npm run typecheck`, `TZ=UTC npm test` (419 archivos, 6381 tests verdes), `npm run build` con variables dummy: verde.

## Variables de entorno nuevas
Ninguna.

## Deuda fuera de alcance (no arreglada)
- `fetchCustomValueIndex`: trocea a 500 contactos, pero no pagina; 500 contactos × 3+ campos personalizados superan 1000 filas y las variables quedan vacías.
- `fetchCustomValueIndex` ignora `error` de la consulta.
- `src/lib/whatsapp/broadcast-resume.ts:189`: la reanudación en servidor relee destinatarios sin `.range()` (señalado por el reviewer).
- `message-composer.tsx:403-408`: una subida en curso al cambiar de conversación deja el objeto huérfano en el bucket (no se cuela en el chat siguiente).
