# p16.1 audit-whatsapp-inbound — informe del implementer

## Plan
1. A1/A2 en `src/lib/contacts/dedupe.ts` (`findExistingContact`): LIKE sobre `phone_normalized`; exacta primero, luego solo variante troncal 0 (`phoneVariants`). Revisar llamadores.
2. A3 en `src/app/api/whatsapp/webhook/route.ts`: try/catch por change, por estado y por mensaje; decrypt protegido; timestamp tolerante.
3. A4 misma ruta: `messages.status` solo avanza (condición `.in('status', …)` en el UPDATE); `broadcast_recipients` con `.eq('status', leído)`.
4. A5 `src/lib/whatsapp/meta-api.ts`: `metaFetch` de módulo con `AbortSignal.timeout`.
5. Tests que fallen sin cada arreglo; compuerta; CHANGELOG; commit.

## Rama y commits
- Worktree `/mnt/nvme-big/Dev/apps/cabbity/wacrm/.claude/worktrees/audit-whatsapp-inbound`, rama `fix/audit-whatsapp-inbound` (sobre `fix/health-chat-perf`).
- `5fb7f49` fix(whatsapp): mensajes entrantes que se perdían o caían en otro contacto (p16.1)
- `6cbc150` fix(contacts): casa números nacionales guardados sin código de país (p16.1, ajuste A2)
- `de8809a` fix(whatsapp): cambios de la revisión de p16.1
- `dc26617` fix(contacts): un nacional guardado con su 0 troncal casa con el internacional (ronda 3)

## Criterio ↔ test
Todos los tests nuevos se comprobaron en rojo con `git stash` del archivo de producción correspondiente.

| Criterio | Archivo | `it` |
|---|---|---|
| A1 contacto `+1 (809) 555-1234`, entrante `18095551234` → lo encuentra | `src/lib/contacts/dedupe.test.ts` | `finds a contact saved with a formatted phone (A1)` |
| A2 `18095551234` y `18295551234` distintos | idem | `keeps numbers that only share the last 8 digits apart (A2)` |
| A2 `370063949836` ↔ `37063949836` sigue casando (ambos sentidos) | idem | `returns a trunk-variant match` |
| A2 exacta antes que variante | idem | `prefers the exact match over a trunk variant` |
| A2 (ajuste del líder) guardado `809-555-1234` (y `555-1234`) + entrante `18095551234` → mismo contacto | idem | `finds a national number saved without country code` |
| A2 (ajuste) exacta gana a sufijo | idem | `prefers the exact match over a suffix match` |
| A2 (ajuste) sufijo más largo gana | idem | `prefers the longest suffix` |
| A2 (ajuste) sufijo < 7 dígitos no vale | idem | `ignores a suffix shorter than 7 digits` |
| A3 timestamp no numérico no tumba el siguiente mensaje | `src/app/api/whatsapp/webhook/route.test.ts` | `un timestamp no numérico no tumba el mensaje siguiente` |
| A3 token que no descifra → texto guardado | idem | `un access_token que no descifra no impide guardar el texto` |
| A3 un estado que lanza no impide los mensajes | idem | `un estado que lanza no impide guardar los mensajes del mismo change` |
| A3 change malformado no impide el siguiente | idem | `un change malformado no impide procesar el siguiente` |
| A4 `read` seguido de `delivered` deja `read` | idem | ``\`read\` seguido de \`delivered\` deja \`read\` en messages`` |
| A4 UPDATE de recipients exige el estado leído | idem | `el UPDATE de broadcast_recipients exige el estado que leyó` |
| A5 un helper pasa `signal` | `src/lib/whatsapp/meta-api.test.ts` | `sendTextMessage pasa un signal aunque el llamador no lo dé` |

Tests existentes cambiados:
- `dedupe.test.ts`: el stub ahora aplica el LIKE a la columna pedida (antes devolvía todo). El caso troncal se renombró (ya no es «via phonesMatch»). Prettier reformateó el archivo (comillas dobles → simples).
- `route.test.ts`: mock de `broadcast_recipients.update` pasa a cadena `eq().eq()` thenable (registra filtros); mock de `messages.update` registra el filtro `status` y simula la fila si `messageCurrentStatus` está fijado; `decrypt` puede lanzar con `decryptThrows`.
- `src/lib/security/fake-supabase.ts`: emula la columna generada `contacts.phone_normalized` (migración 022) en `getPath`. Sin esto, 27 tests de `tenant-isolation`, `coexistence-webhook` y `coexistence-batches` fallaban porque el fake no tenía la columna.

## Compuerta (en el worktree)
- `npx eslint . --ignore-pattern '.claude/**'`: 0 errores (34 warnings preexistentes).
- `npm run typecheck`: verde.
- `TZ=UTC npm test`: 417 archivos, 6398 tests verdes. En la primera pasada falló `src/middleware.test.ts` (cron de coexistencia); pasa sola (84/84) y en la segunda pasada completa: flaky por carga con otros implementers en paralelo, no relacionado.
- `npm run build` con variables dummy: verde.
- Sin SQL: no aplica `replay-migrations.sh`.

## Verificación contra base real
No hace falta: sin migraciones. El filtro `.in('status', …)` y `.eq('status', …)` son PostgREST estándar; `phone_normalized` existe desde la 022 (`GENERATED ALWAYS AS … STORED`, índice único por cuenta).

## Verificaciones manuales pendientes
- A5 contra Meta real: enviar un texto y un adjunto desde el inbox y recibir una foto entrante; deben funcionar igual que antes (el plazo solo actúa si Meta no responde en 15 s / 120 s).

## Ajuste del líder (segundo commit)
Regla de `findExistingContact`, en orden: (1) dígitos exactos; (2) variante troncal 0; (3) uno es sufijo del otro y el corto tiene ≥ 7 dígitos, gana el sufijo más largo. `18095551234`/`18295551234` siguen separados. El prefiltro SQL pasa de los últimos 8 a los últimos **7** dígitos de `phone_normalized`: con 8, un guardado de 7 dígitos (`5551234`) nunca entraba en el `LIKE '%95551234'`. Coste: algo más de candidatas en JS, sin cambio de índice. Los dos tests nuevos de sufijo fallan con la versión anterior (`git stash`). Compuerta repetida tras el ajuste: lint 0 errores, typecheck verde, build verde, `npm test` 6402 verdes; `src/middleware.test.ts` (cron de coexistencia) falló en 2 de 3 pasadas completas y pasa siempre solo: intermitente bajo carga, ajeno a este cambio.

## Ronda de revisión (`review_audit-whatsapp-inbound.md`, commit `de8809a`)
Todos los tests nuevos se comprobaron en rojo con `git stash` del archivo de producción.

| Cambio | Archivo | `it` |
|---|---|---|
| 1. Sufijo solo si faltan 1–3 dígitos; `555-1234` ↛ `18095551234`; `8095551234` ↛ `18295551234`; entrada `5551234` con 809 y 829 guardados → null | `src/lib/contacts/dedupe.test.ts` | `a suffix only stands for a missing country code (1-3 digits)` |
| 1. Empate de sufijo → null (añadido: el reviewer señaló que el empate lo decidía el orden de la base) | idem | `two equally good suffix candidates match neither` |
| 1. Sufijo más largo gana (ahora `95551234` vs `8095551234`, el caso viejo con `5551234` ya no es sufijo válido) | idem | `prefers the longest suffix` |
| 5. MX `+52 55 1234 5678` ↔ `5215512345678` (ambos sentidos) y AR `+54 11 …` ↔ `549 11 …` | idem | `Mexico 52/521 and Argentina 54/549 are the same mobile` |
| 5. Un `52…` no casa con otro país que comparte la cola | idem | `a 52 number does not match another country sharing only the tail` |
| 2. `broadcast_recipients` con `.in('status', estados previos válidos)` (ladder + failed filtrado por `isValidStatusTransition`) | `src/app/api/whatsapp/webhook/route.test.ts` | `el UPDATE de broadcast_recipients exige un estado previo válido` (sustituye al de `.eq`) |
| 3. Entry sin `changes` seguida de una válida | idem | ``una entry sin `changes` no impide procesar la siguiente`` |
| 3. `change` null | idem | `un change null no hace lanzar al propio catch` |
| No bloqueante: token indescifrable → no se llama a Graph, media null | idem | `con token indescifrable no se llama a Graph para la media` |
| Hallazgo 5: `template-sync.ts` y `embedded-signup.ts` usan `metaFetch` | `src/lib/whatsapp/template-sync.test.ts` (aserción en el test de paginación), `src/lib/whatsapp/embedded-signup.test.ts` (`calls the oauth endpoint…`, `asks for fb_exchange_token…`: `toEqual({method})` → `toMatchObject` + `signal`) | — |

- `metaFetch` vive ahora en `src/lib/whatsapp/meta-fetch.ts` (exportado) en vez de dentro de `meta-api.ts`: `src/app/api/whatsapp/embedded-signup/route.test.ts` mockea `meta-api` entero y el canje de token real (`embedded-signup.ts`) habría importado un `metaFetch` indefinido. Ninguno de los dos `fetch` nuevos traía `signal` propio; `metaFetch` respeta uno si se pasa.
- Hallazgo 6: comentario de `inbound-thread.ts` actualizado.
- CHANGELOG: regla de número nacional, MX/AR, y el plazo nombra los tres sitios.
- Compuerta: lint 0 errores; typecheck verde; `npm test` 6408 verdes y el único rojo `src/middleware.test.ts` (cron de coexistencia), que pasa solo 84/84 (flaky bajo carga, ajeno); build verde.

Riesgo residual (del reviewer, inherente a la regla de sufijo): un nacional de 10 dígitos guardado sin país casa con otro país cuyo `cc + nacional` coincida (`2025551234` ↔ `442025551234`) si es la única candidata.

## Ronda 3 (commit `dc26617`)
- `suffixLen` en `dedupe.ts`: si el número corto empieza por `0`, se compara sin ese 0 (longitud ≥ 7, faltan 1–3, `endsWith`).
- Test `src/lib/contacts/dedupe.test.ts` › `a national number saved with its trunk 0 matches the international one`: `07911 123456` ↔ `447911123456` y `06 12 34 56 78` ↔ `33612345678` casan; `0555-1234` ↛ `18095551234`. Falla sin el arreglo (`git stash`).
- Prefiltro SQL: el número sin el 0 es sufijo del entrante, así que comparten los últimos 7 dígitos y entran en `LIKE '%<últimos 7>'`; el stub del test aplica ese mismo LIKE a `phone_normalized`, de modo que el test lo comprueba.
- Compuerta: lint 0 errores, typecheck verde, `npm test` 6410 verdes (sin rojos esta vez), build verde.

Residual conocido (no se arregla): Argentina guardado `011 15 2345 6789` (troncal 0 + `15` de móvil) no casa con el entrante `5491123456789`; haría falta quitar el `15`, fuera del arreglo mínimo. Se crea un contacto nuevo (no se pierde el mensaje ni se funden personas).

## Decisiones donde el spec era ambiguo
- A2: candidata no exacta válida solo si `phoneVariants(entrante).includes(dígitos de la candidata)`. `phoneVariants` es simétrica para insertar/quitar el 0, así que cubre ambos sentidos. `phonesMatch` no se tocó y ya no se importa en `dedupe.ts`.
- Llamadores de `findExistingContact` revisados: webhook (`route.ts`, `resolveStatusContact`), `inbound-thread.ts`, `coexistence-webhook.ts`, `resolve-conversation.ts`, `api/v1/contacts.ts` (que usa `broadcast-core.ts` vía `findOrCreateContact`), `contact-form.tsx`. Todos quieren «el mismo número»; ninguno necesita cambio. Efecto visible: el aviso suave de «posible duplicado» del formulario ya no salta para números que solo comparten los últimos 8 dígitos (sí para variantes troncales). La importación CSV no llama a `findExistingContact` (usa `dedupeByPhone` + índice único).
- A3: timestamp ausente/no numérico → hora actual (`metaTimestampIso`). No reutilicé `parseTimestampSeconds` de `entry-point.ts` porque rechaza timestamps >5 min en el futuro, lo que cambiaría `created_at` de mensajes con reloj desfasado.
- A4: estados fuera de `sent/delivered/read/failed` (p. ej. `deleted`) ya no intentan el UPDATE de `messages` (antes fallaba contra el CHECK y solo se logueaba). El resto del handler (recipients, cobro, fan-out) sigue igual.
- A5: 15 s por defecto; 120 s para `uploadResumableMedia` (subida de bytes), `uploadMedia` y `downloadMedia`. El plazo de `downloadMedia` cubre también la lectura del cuerpo.

## Variables de entorno nuevas
Ninguna.

## Deuda fuera de alcance (no tocada)
- `metaFetch` de 15 s también corta envíos: si Meta acepta a los 16 s, el llamador lo da por fallido y un reintento puede duplicar (lo fija el spec).
- `metaTimestampIso` (webhook) duplica `timestampToIso` de `coexistence-webhook.ts` con bordes distintos (`'0'`).
- Hallazgos 4, 7, 8 de `audit-whatsapp.md` (otras features).
- El fan-out por mensaje (flows, automations, IA, webhooks) sigue serializado antes del siguiente insert de la misma entrega (nota «related» del hallazgo 6).
- `src/middleware.test.ts` flaky bajo carga.
