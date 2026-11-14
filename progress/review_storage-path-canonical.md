# Review — m14.3 storage-path-canonical

**Veredicto:** APPROVED

Rama `feat/storage-path-canonical`, 1 commit `c373c91` sobre main @ 7bc2fd2. 11 archivos, coinciden con el informe.

## Compuerta (dirigida, ejecutada por el reviewer en el worktree)
- lint: verde (0 errores, 34 warnings preexistentes, ninguno en archivos tocados)
- typecheck: verde
- test: `TZ=UTC npx vitest run src/lib/media src/lib/whatsapp/outbound-media.test.ts src/lib/whatsapp/template-header-handle.test.ts src/lib/storage src/lib/security src/lib/exports src/lib/whatsapp/send-message.test.ts src/lib/flows` → 22 archivos, 604 tests verdes
- build / `npm test` completo: no corridos (instrucción del líder: gate dirigido)
- replay-migrations: n/a (sin SQL)
- Prueba de detección: con `storage-url.ts`, `outbound-media.ts` y `template-header-handle.ts` de 7bc2fd2 y los tests nuevos → 47 fallos, de ellos los 24 C1/H1 del describe nuevo de `tenant-isolation.test.ts` (12+12). Restaurado a HEAD, árbol limpio.

## Trazabilidad criterio ↔ test
- A1 vectores de la auditoría rechazados: [x] `src/lib/media/storage-url.test.ts` › `parseStorageObjectUrl — non-canonical paths (m14.3)` › `rejects %s` (16 vectores, con y sin origin) + `rejects an encoded bucket segment`
- A1 ida y vuelta `new URL`: [x] `storage-url.test.ts` › `isCanonicalStoragePath` › `requires the URL round trip…`
- A1 nombres legítimos (buildMediaPath, inbound, espacios, acentos, puntos, mayúsculas, legacy): [x] `accepts the names buildMediaPath writes…`, `accepts legacy names with spaces…`
- A1 `assertStoragePathOwnedBy` UUID estricto / prefijo `account-A` vs `account-Ab`: [x] `assertStoragePathOwnedBy` › `refuses %s` (8 casos), `accepts exactly…`, `hands legacy…`
- A2 resolveOutboundMedia forbidden, mensaje conservado, sin storage ni Meta: [x] `src/lib/whatsapp/outbound-media.test.ts` › `resolveOutboundMedia — encoded traversal (m14.3)` (asserta `downloads == []`, `upload` no llamado; caso legítimo con acentos sigue enviando)
- A2 ensureImageHeaderHandle forbidden, sin storage/fetch/Meta: [x] `src/lib/whatsapp/template-header-handle.test.ts` › `ensureImageHeaderHandle — encoded traversal (m14.3)`
- A3 fake normaliza como fetch: [x] `tenant-isolation.test.ts` › `the fake resolves a traversal the way fetch does` (guarda contra falso verde)
- A3 C1/H1 punta a punta, describe nuevo al final, describes previos intactos: [x] `C1: POST /api/v1/messages refuses media_url %s` (403, sin envíos, B intacto) y `H1: template submit refuses header %s` (400 /another account/) — verificado que fallan sin el arreglo
- A4 extensión `[a-z0-9]{1,8}`: [x] `src/lib/storage/upload-media.test.ts` › `whitelists the extension…`; CHANGELOG Security: [x]

## Verificación adversarial propia (Node 25.9, `new URL` = lo que hace fetch sobre la URL de `_getFinalPath`, `storage-js/dist/index.cjs:1528`, `download` L1185)
- Script: para cada URL aceptada, compara `{bucket,path}` validado con los segmentos decodificados de `new URL(origin + '/storage/v1/object/' + bucket + '/' + path)` (search/hash vacíos).
- Vectores pedidos: `%EF%BC%8E%EF%BC%8E`, `%E2%80%A4`, `%E3%80%82`, `%C2%A0..`, `..;`, `%20..`, `..%20`, `%E2%80%8B`, `%E2%80%A8`, `%E2%80%AE` → aceptados pero **el path pedido es idéntico al validado** y queda dentro de `account-A/` (WHATWG no hace IDNA/NFKC en el path; no son dot-segments). `%C0%AE`, `%ED%A0%80` (surrogate) → null (decode lanza). `%2E%2E%2F`, `%5C`, `%09`, `%0D`, `%00`, `%7F`, `%3F`, `%23`, `%25`, `%252e`, `//`, `%2F%2F`, `x.png%20` (espacio final que el parser recorta) → null. `./x`, `%2E/x` en la entrada → resueltos por `new URL` antes de partir; path validado = path pedido (decisión 5 correcta).
- Prefijos/caso: `account-<A>x`, `account-<A truncado>`, `ACCOUNT-<A>`, `account-<A>%20`, `account-<A>.` → forbidden.
- Fuzz 300k combinaciones codificadas (64k aceptadas) + 300k crudas sobre `isCanonicalStoragePath` (incl. `\uD800`, `．`, ` `, `;|^\``) → **0 discrepancias** entre path validado y path en el cable.
- Ida y vuelta (decisión 2): con `%` prohibido, todo escape del pathname lo introduce el codificador WHATWG (UTF-8 válido de caracteres no `/`/`.`), así que `decodeURIComponent` por segmento es inversa exacta; un servidor que decodifique no puede reintroducir `/`, `.` ni `%`.
- `accounts.id` es UUID (`supabase/migrations/…:60`), en minúscula al serializar: el control exacto no rechaza rutas de `buildMediaPath`.

## Checkpoints
- CP1: [x] gate dirigido verde por el reviewer (build/`npm test` completo excluidos por instrucción del líder)
- CP2: [x] n/a, sin SQL
- CP3: [x] los dos consumidores con rol de servicio (`outbound-media.ts:255`, `template-header-handle.ts:74`) pasan por `assertStoragePathOwnedBy` antes de `storage.from().download`; test de fuga A→B en `tenant-isolation.test.ts`
- CP4: [x] ver trazabilidad; guion manual (SQL de nombres legados en Storage real + smoke) en el informe
- CP5: [x] `package.json` sin cambios
- CP6: [x] n/a, sin UI
- CP7: [x] n/a, sin APIs de framework
- CP8: [x] solo los 11 archivos que A1–A4 justifican; `src/app/api/media/sign/route.ts` (m14.1) no tocado
- CP9: [x] CHANGELOG Unreleased › Security; informe coincide con el diff
- CP10: [x] 1 commit en español con prefijo y `Co-Authored-By`; nada pusheado
- CP11: [x] el webhook/espejo entrante no usa `parseStorageObjectUrl`; `buildMediaPath` con `extensionForMime` sigue igual

## Hallazgos (no bloqueantes)
1. `src/lib/whatsapp/outbound-media.ts:243` y `template-header-handle.ts:65` — `isOnOrigin` compara el origen entero, no el prefijo `/storage/` que sugería la auditoría: cualquier URL de nuestro origen que no parsea (p. ej. `/storage/v1/render/image/public/...` o un avatar con `%` en el nombre) ahora es `forbidden` en vez de `{ link }`. No hay en el repo productor de URLs `render/image` ni de esos nombres; más estricto es aceptable. Anotar si aparece un caso real.
2. `assertStoragePathOwnedBy` legacy (`storage-url.ts:240`): `legacyOwnerFromPath` es case-insensitive y la consulta a `profiles` con `uuid` también, así que `<UID-en-MAYÚSCULAS>/x` pasa el control y descarga un objeto distinto de `<uid>/x`. Solo alcanza objetos en una carpeta que nadie crea (la RLS legacy escribía en minúscula) y es comportamiento preexistente; no es fuga A→B. Deuda: normalizar a minúscula o exigir `uid === uid.toLowerCase()`.
3. Deuda ya declarada en el informe y aceptada: unificar `src/app/api/media/sign/route.ts` (m14.1) con `assertStoragePathOwnedBy` tras fusionar; wrapper/lint `adminStorageObject` (M1); `remove/copy/move` sin verificar.

## Contraste con `code-review high` (7bc2fd2..c373c91)
8 hallazgos, ninguno es una lectura cruzada que siga pasando. Valoración:
- **Conflictos con main @ b6719e0** (confirmado con `git merge-tree`): `CHANGELOG.md` y `src/lib/security/tenant-isolation.test.ts`. Ambos son apéndices al final (m14.1 y m14.3 añaden en el mismo sitio). **No bloquea la aprobación, pero hay que resolverlos al fusionar conservando las dos cosas**: el describe de m14.1 (sign route) y el describe `Storage paths: encoded traversal never reaches B (m14.3)` con sus 24 casos, y las dos entradas del CHANGELOG. Después de fusionar, volver a correr `src/lib/security` (son 604 verdes en la rama).
- Validación duplicada en `/api/media/sign` (m14.1): el spec la deja fuera expresamente. Es deuda: unificarla en una feature aparte.
- Fallback `isOnOrigin` más estricto (`render/image`, `//`, `/` final): ya está como hallazgo 1. Aceptado.
- Objetos de flow-media legacy con la extensión sin sanear (`62073d9`, p. ej. `…Foto__2.foto #2`): no es una regresión. Con `#` en el path, storage-js/fetch ya cortaba la petición en el `#`, así que esos objetos tampoco se podían descargar ni firmar antes. Las consultas SQL previas al despliegue los encuentran.
- Mensaje duplicado en `template-header-handle.ts:70` en vez de reutilizar `FOREIGN_MEDIA_MESSAGE`; el fake solo normaliza `download`; doble `isCanonicalStoragePath`; falta un wrapper único (M1). Son limpieza o deuda ya declarada y no bloquean.

## Antes de desplegar (del informe, obligatorio)
- Correr en Supabase real las dos consultas de solo lectura de `progress/impl_storage-path-canonical.md` › «Verificaciones manuales pendientes»: deben dar 0 filas; si no, esos adjuntos dejarán de enviarse.
