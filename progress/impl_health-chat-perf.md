# impl n15.6 `health-chat-perf-y-mensajes`

Rama `fix/health-chat-perf` (worktree `.claude/worktrees/health-chat-perf`), commit `a2eff35`.
Spec: `/mnt/nvme-big/Dev/apps/cabbity-health/docs/audit/2026-11-20-crm-chat.md` §W.1–W.3.

## Plan (hecho)

1. W.1 caché de clave y plan en `requireApiKey`; `Promise.all` en handlers v1 con viajes independientes.
2. W.2 búsqueda de conversaciones con join interno.
3. W.3 helper común edit/revoke extraído de los ecos; corto-circuito en el webhook; unsupported/contacts/system.

## Cambios

- `src/lib/auth/api-context.ts`: `Map` por proceso, TTL 30 s, para la fila de la clave (por `key_hash`) y las entitlements (por `account_id`, cacheando el resultado de `assertPlanFeature(…,'api')`). Solo se cachean aciertos: clave desconocida o plan sin `api` se vuelven a consultar. `assertWritable` reutiliza las entitlements cacheadas (sin viaje). `__resetApiKeyCacheForTests`.
  - La caché está en `requireApiKey`, no en `getEntitlements`/`findActiveKeyByHash`, para no volver obsoletos los paneles de facturación/plataforma que usan esas funciones.
- `GET /api/v1/conversations` y `GET /api/v1/conversations/{id}` (`readSerialized`, usado también por PATCH): `loadAccountAiOn` en `Promise.all` con la consulta. `GET …/{id}/messages`: puerta de propiedad y página en paralelo; la página solo se devuelve si la conversación es de la cuenta.
- W.2 `src/app/api/v1/conversations/route.ts`: con `search`, select `contact:contacts!inner(…)` + `.or(name/phone ilike, { referencedTable: 'contact' })`. Desaparecen la consulta previa a `contacts` y el `.in('contact_id', ≤500 ids)`.
- `src/lib/security/fake-supabase.ts`: `or(expr, { referencedTable })` modelado solo para embeds `!inner` (lanza si no lo es).
- W.3 `src/lib/whatsapp/coexistence-webhook.ts`: nuevos `MessageRewrite`, `parseMessageRewrite` y `applyMessageRewrite` (extraídos de `parseMessageEchoes`/`applyEchoRewrite`, sin cambio de comportamiento de los ecos).
- `src/app/api/whatsapp/webhook/route.ts`: `edit`/`revoke` tras el corto-circuito de reacciones → `applyMessageRewrite` sobre la conversación; no inserta, no bump, no IA/automatizaciones/flows; sin original → `console.warn` solo con ids (wamid, originalId, type). `unsupported` → `[Unsupported message type: <unsupported.type>]`, `unavailable` si algún `errors[].code === 131060`. `contacts` → `«nombre teléfono»` por tarjeta (una por línea; sin datos → `[Unsupported message type: contacts]`). `system` → `system.body` (sin cuerpo → `[Unsupported message type: system]`).
- CHANGELOG (Unreleased).

## Criterio ↔ test

| Criterio | Test |
|---|---|
| W.1 caché reutiliza dentro de la ventana | `src/lib/auth/api-context.test.ts` › «reuses the key and the plan within the window» |
| W.1 expira (clave revocada deja de valer) | «asks again once the window expires, so a revoked key stops working» |
| W.1 distingue claves / no cachea desconocidas | «tells keys apart and never caches an unknown key» |
| W.1 no cachea plan sin `api` | «does not cache a plan without the api feature» |
| W.1 Promise.all (contrato intacto) | tests existentes de `src/app/api/v1/conversations/**` siguen verdes |
| W.2 búsqueda con muchas coincidencias | `src/app/api/v1/conversations/route.test.ts` › «una búsqueda con cientos de coincidencias pagina sin listar ids de contacto (n15.6)» (600 contactos; sin filtro `in contact_id`); aislamiento por cuenta: test existente «nunca mezcla cuentas…» |
| W.3 edit | `src/app/api/whatsapp/webhook/route.test.ts` › «an edit rewrites the original row and inserts nothing» |
| W.3 revoke | «a revoke marks the original as deleted and inserts nothing» |
| W.3 original no encontrado → log con ids | «a revoke whose original is unknown logs ids only and inserts nothing» |
| W.3 unsupported con subtipo / 131060 | «an unsupported message keeps its real subtype, and 131060 reads as unavailable» |
| W.3 contacts | «a shared contact is stored with its name and phone» |
| W.3 system | «a system message stores its body» |
| Ecos de coexistencia sin regresión | `src/lib/whatsapp/coexistence-webhook.test.ts` (verde) |

## Compuerta (acotada, por instrucción del líder)

- `npx eslint <tocados>`: 0 errores (1 warning previo: `downloadMedia` sin uso en el webhook, ya estaba en main).
- `npm run typecheck`: verde.
- `TZ=UTC npx vitest run src/app/api/v1 src/lib/auth/api-context src/lib/security src/app/api/whatsapp/webhook src/lib/whatsapp/coexistence`: 31 archivos, 604 tests verdes.
- No corridos: suite completa y `npm run build` (sin cambios de framework/config).
- Prettier sobre los tocados; reformateó `api-context.test.ts` entero (comillas dobles → simples), de ahí el diff grande de ese archivo.

## Verificación manual pendiente

- W.2 contra PostgREST real: que `contact:contacts!inner` + `or(..., {referencedTable:'contact'})` filtre las filas padre (el fake lo modela así). Guion: con una clave `conversations:read`, `GET /api/v1/conversations?search=<texto común>&sort=last_activity` → 200 y solo conversaciones cuyo contacto coincide por nombre o teléfono; probar un texto con cientos de coincidencias (antes 500).
- W.3 con un payload real de Meta (edit/revoke/unsupported/contacts entrantes): forma asumida según el spec (`edit.original_message_id`, `edit.message`, `revoke.original_message_id`, `unsupported.type`, `errors[].code`, `contacts[].name.formatted_name`, `contacts[].phones[].phone`, `system.body`).

## Decisiones donde el spec era ambiguo

- TTL 30 s (rango 30–60 del spec).
- edit/revoke van tras el find-or-create de contacto/conversación (como las reacciones, que es donde el spec sitúa el corto-circuito); un revoke de un remitente desconocido podría crear contacto/conversación vacíos, igual que hoy una reacción.
- Otros handlers v1 revisados: solo estos tres tenían viajes independientes en serie relevantes para el chat.

## Sin variables de entorno nuevas. Sin migraciones. Sin dependencias.

## Deuda fuera de alcance

- Warning previo de eslint `downloadMedia` sin uso en `src/app/api/whatsapp/webhook/route.ts`.
- Las filas viejas «[Unsupported message type: edit|revoke]» siguen así (las humaniza Health, S.8).

## Ronda 2 (commit `59e3ff8`)

Respuesta a `progress/review_health-chat-perf.md` (CHANGES_REQUESTED):

1. `src/lib/auth/api-context.ts`: después de la caché, `revoked_at`/`expires_at` ≤ ahora → 401, también en un acierto. Test `api-context.test.ts` › «a cached key still dies at its expires_at, without waiting out the window» (vence a +10 s, 401 a +11 s, una sola consulta al store).
2. `src/app/api/account/api-keys/[id]/route.ts:11`: el comentario ya dice que la revocación tarda hasta 30 s por réplica, por la caché de `api-context.ts`. No se vacía la entrada local al revocar (el reviewer lo marcó como opcional).
3. Test entre cuentas: «keys of two accounts each get their own account and their own plan» (A, B, A, B → la cuenta correcta en cada llamada y un `assertPlanFeature` por cuenta).

Compuerta acotada: eslint de los archivos tocados limpio, typecheck en verde, vitest de `api-context`, `account/api-keys` y `v1` con 256/256 en verde.
