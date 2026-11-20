# Review — p16.6 audit-client

**Veredicto:** APPROVED (ronda 2, commit `0e49bad` sobre `4643ed6`)

## Compuerta (ronda 2, ejecutada por mí en el worktree con las variables dummy de CI)
- lint: verde (0 errores; los warnings ya existían)
- typecheck: verde
- `TZ=UTC npm test`: 6381 en verde y 2 en rojo, los dos ajenos a la rama:
  - `src/middleware.test.ts` (cron de coexistencia, timeout)
  - `src/lib/ai/tools/live-render.test.ts` › "2 000 slots → ≤ 6 000 bytes"
  - Corridos solos pasan: 97/97. La rama no toca esos archivos.
  - Fallaron por carga: en paralelo yo corría vitest de mutación.
- build: verde
- replay-migrations: no aplica, no hay SQL

## Ronda 2: cambios requeridos
1. Dedupe por `id` en la audiencia `all`: [x]
   - `use-broadcast-sending.ts:253-255`: `new Map(rows.map((c) => [c.id, c]))`.
   - Test: "a row re-read across pages is sent once". Repite `c999` entre páginas y espera 2500 filas, con `c999` una sola vez.
   - Mutación: si quito el dedupe, el test falla.
2. Comentario de exclusión en CSV: [x] `:285-286` corregido; ahora coincide con el código.

Extras que pidió el líder:
- `upsertCsvContacts` trocea `.in('phone')` en grupos de `IN_CHUNK` (500): [x] `:341-356`.
  - Conserva los filtros `account_id` y `user_id` y el manejo de error.
  - Cada trozo devuelve como mucho 500 filas: hay UNIQUE (account_id, phone_normalized), así que no llega al tope de 1000.
  - Test: "a CSV of 1 200 phones looks them up in chunks of at most 500", que comprueba los trozos `[500, 500, 200]`. Mutación: con trozos de 5000, falla.
- CHANGELOG: [x] menciona el campo personalizado, «each contact once» y las búsquedas CSV troceadas.

## Trazabilidad criterio ↔ test (ronda 1, sigue en pie)
- F1 «`key={conversation.id}` en `<MessageComposer>`»: [x] `src/components/inbox/message-thread.test.ts`.
  - Es una regex sobre el código fuente, que el spec permite: el repo no tiene DOM renderer.
  - El cleanup de desmontaje está en `message-composer.tsx:206-214`.
- F2, todos en `src/hooks/use-broadcast-sending.test.ts`:
  - 2 500 contactos → 2 500 destinatarios: [x]
  - Etiqueta de 2 500 y `.in(id)` de 500 o menos: [x]
  - Exclusión de más de 1000: [x]
  - Error en la exclusión → lanza antes del INSERT y del envío: [x]
  - Relectura de 2 500 destinatarios: [x]
  - Mutaciones de la ronda 1: sin paginar fallan 4 tests; con `IN_CHUNK=5000` falla 1.

## Checkpoints
- CP1 Compuerta: [x] (los dos fallos de arriba se deben a carga y son ajenos a la rama)
- CP2 Migraciones: [x] no hay SQL
- CP3 Aislamiento: [x] no hay `supabaseAdmin`; las lecturas de contactos mantienen `account_id`
- CP4 Tests: [x]
- CP5 Sin dependencias nuevas: [x]
- CP6 i18n: [x] sin textos de UI nuevos
- CP7 Next 16: [x] no usa APIs de framework
- CP8 Alcance: [x]
  - El diff grande del hook de la ronda 1 es casi todo reindentado: tres closures pasan a funciones de módulo.
  - Se conservan el orden de pasos, el manejo de errores, el dedupe del CSV y el filtro del campo personalizado.
- CP9 Documentación: [x]
- CP10 Git: [x] dos commits en `fix/audit-client`, en español y con Co-Authored-By; nada pusheado
- CP11 Entrante: [x] no se toca

## Deuda fuera de alcance (no bloquea)
- `fetchCustomValueIndex` (`:149`): no pagina e ignora `error`. Con 500 contactos y 3 o más campos, las variables `{{n}}` quedan vacías.
- `src/lib/whatsapp/broadcast-resume.ts:189`: la reanudación en servidor relee los destinatarios sin `.range()`.
- `message-composer.tsx:403-408`: una subida en curso al cambiar de conversación deja el objeto huérfano en el bucket.
- La paginación por offset aún puede saltarse una fila si se borra un contacto o una etiqueta entre páginas. En la exclusión eso sería un fallo abierto, pero raro.
