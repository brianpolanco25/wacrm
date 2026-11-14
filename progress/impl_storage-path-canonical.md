# impl m14.3 storage-path-canonical

## Plan (ejecutado)
1. storage-url.ts: path canónico (lista negra + ida y vuelta con new URL), accountIdFromPath con UUID estricto, assertStoragePathOwnedBy, isOnOrigin para el fallback.
2. outbound-media.ts / template-header-handle.ts: validación centralizada; URL de nuestro origen que no parsea → forbidden.
3. fake-supabase.ts: clave de objeto normalizada como fetch.
4. tenant-isolation.test.ts: describe nuevo al final (C1/H1).
5. buildMediaPath: extensión en lista blanca [a-z0-9]{1,8}.
6. Tests, CHANGELOG (Security), compuerta dirigida, commit.

## Rama y commits
- Rama `feat/storage-path-canonical` (worktree `.claude/worktrees/storage-path-canonical`), base main @ 7bc2fd2.
- `c373c91` fix: rutas de Storage canónicas antes de cualquier lectura con rol de servicio (m14.3)

## Archivos
- `src/lib/media/storage-url.ts`: `parseStorageObjectUrl` parte el pathname SIN filtrar vacíos y devuelve null si `isCanonicalStoragePath(bucket, path)` falla. Nuevas exportaciones: `isCanonicalStoragePath`, `isOnOrigin`, `assertStoragePathOwnedBy`, `StoragePathForbiddenError`. `accountIdFromPath` exige UUID completo; `legacyOwnerFromPath` comparte la regex.
- `src/lib/whatsapp/outbound-media.ts`: `assertMediaPathOwnedBy(ref|path, accountId, db)` delega en `assertStoragePathOwnedBy` (legacy sigue con lookup en `profiles`); `resolveOutboundMedia`: URL en el origen de Supabase que no parsea → `OutboundMediaError('forbidden', …)` en vez de `{ link }`.
- `src/lib/whatsapp/template-header-handle.ts`: mismo fallback forbidden; pasa el ref completo al control.
- `src/lib/storage/upload-media.ts`: extensión con lista blanca `^[a-z0-9]{1,8}$` tras minúsculas, si no `bin`.
- `src/lib/security/fake-supabase.ts`: `storageRequestKey(bucket, path)` (exportada) = `new URL('http://x/o/'+bucket+'/'+path)` pathname+search; `download` compara por esa clave.
- Tests: `storage-url.test.ts`, `outbound-media.test.ts`, `template-header-handle.test.ts`, `upload-media.test.ts`, `tenant-isolation.test.ts` (describe nuevo al FINAL; describes existentes intactos).
- `CHANGELOG.md`: entrada «Security: attachment URLs with encoded path traversal» en Unreleased.

## Criterio ↔ test
| Criterio | Test |
|---|---|
| A1 vectores rechazados (`%2F..%2F`, `%5C`, `%252e%252e`, `.%09.`, `%0A`, `%0D`, `%00`, `%7F`, `%3F`, `%23`, `%C0%AE`, `//`, `/` final, `%2F%2F`, otro bucket, `/rest/v1`) | `src/lib/media/storage-url.test.ts` › `parseStorageObjectUrl — non-canonical paths (m14.3)` › `it.each(VECTORS) 'rejects %s'`; `rejects an encoded bucket segment` |
| A1 ida y vuelta new URL | `storage-url.test.ts` › `isCanonicalStoragePath` › `requires the URL round trip to give back the same segments` |
| A1 nombres legítimos (buildMediaPath, espejo `inbound`, espacios, acentos, puntos, mayúsculas, legacy `<uid>/`) | `storage-url.test.ts` › `accepts the names buildMediaPath writes for uploads and the inbound mirror`; `accepts legacy names with spaces, accents, dots and capitals` |
| A1 `assertStoragePathOwnedBy` UUID estricto, sin prefijos (`account-A` vs `account-Ab`, id truncado, no-UUID, vacío, ajena) | `storage-url.test.ts` › `assertStoragePathOwnedBy` › `accepts exactly account-<A>/… for A`, `hands legacy <uid>/… paths back…`, `it.each … 'refuses %s'`; `path ownership helpers` › `reads the account id from an account-scoped path` |
| A2 resolveOutboundMedia: vectores → forbidden con mensaje actual, sin storage ni Meta | `src/lib/whatsapp/outbound-media.test.ts` › `resolveOutboundMedia — encoded traversal (m14.3)` › `it.each(TRAVERSALS) 'refuses %s with no storage or Meta call'`, `refuses a folder that only starts with the account id`, `still sends a legitimate name with spaces, accents and capitals` |
| A2 ensureImageHeaderHandle: vectores → forbidden, sin storage/fetch/Meta | `src/lib/whatsapp/template-header-handle.test.ts` › `ensureImageHeaderHandle — encoded traversal (m14.3)` › `it.each 'refuses %s with no storage, fetch or Meta call'`, `reads A's own canonical object and gets a handle` |
| A3 fake normaliza como fetch | `src/lib/security/tenant-isolation.test.ts` › `Storage paths: encoded traversal never reaches B (m14.3)` › `the fake resolves a traversal the way fetch does` |
| A3 C1 de punta a punta | mismo describe › `C1: POST /api/v1/messages refuses media_url %s, nothing sent` (12 vectores, 403, sin envíos a Meta, B intacto) |
| A3 H1 de punta a punta | mismo describe › `H1: template submit refuses header %s before calling Meta` (12 vectores, 400 /another account/, sin Meta) |
| A4 L1 extensión | `src/lib/storage/upload-media.test.ts` › `whitelists the extension to [a-z0-9]{1,8} and falls back to bin` |

Prueba de que los tests detectan el fallo: con `storage-url.ts`, `outbound-media.ts` y `template-header-handle.ts` de HEAD (7bc2fd2) y el fake/tests nuevos, los 24 tests C1/H1 del describe nuevo fallan; con el arreglo pasan.

## Compuerta (dirigida, en el worktree)
- `npm run lint`: 0 errores (34 warnings preexistentes, ninguno en archivos tocados).
- `npm run typecheck`: verde.
- `TZ=UTC npx vitest run src/lib/media src/lib/whatsapp/outbound-media.test.ts src/lib/whatsapp/template-header-handle.test.ts src/lib/storage src/lib/security`: 11 archivos, 371 tests verdes.
- Extra (consumidores adyacentes): `src/lib/exports/conversations.test.ts src/lib/whatsapp/send-message.test.ts src/lib/flows`: 9 archivos, 190 verdes.
- No se corrió `npm test` completo ni `build` (por instrucción). Sin SQL → sin replay de migraciones. Sin red real.

## Decisiones (spec ambiguo)
1. **Lista negra + ida y vuelta, no lista blanca `^[A-Za-z0-9_-][A-Za-z0-9._-]*$`** (la que sugería la auditoría): el líder exigió no romper adjuntos existentes con espacios/acentos, y la lista blanca los rechazaría. Se rechaza: segmento vacío, `.`, `..`, `\ % ? #`, U+0000–U+001F, U+007F, en bucket y path. La ida y vuelta es la red de seguridad independiente de la lista.
2. **Ida y vuelta por segmentos decodificados**, no comparación literal del pathname: `new URL` codifica espacios/acentos (`%20`, `%C3%A9`), así que la igualdad literal rechazaría nombres legítimos. Como `%` está prohibido en el path, decodificar el pathname resultante es la inversa exacta del codificador; se exige además search y hash vacíos y el mismo número de segmentos.
3. `parseStorageObjectUrl` devuelve **null** (no resultado marcado). Para no perder la mitigación 4 de la auditoría, los dos consumidores con rol de servicio comprueban `isOnOrigin(url, NEXT_PUBLIC_SUPABASE_URL)`: misma origen + no parsea → `forbidden` con el mensaje actual («media_url points at an attachment that belongs to another account»), en vez de pasar la URL a Meta como `{ link }`. Objetos de buckets no multimedia (avatars) en nuestro origen siguen yendo como `link` (comportamiento previo).
4. En `ensureImageHeaderHandle` el rechazo por origen aplica aunque no haya `source` (antes caía al fetch público); ningún llamador sin `source` usa nuestro origen.
5. Normalización de la URL de **entrada**: `new URL` ya resuelve `%2E`/`..` del input antes de partir; el path resultante es el que realmente se pide, así que se acepta y se valida la propiedad sobre él (test explícito: `account-A/%2e%2e/account-B/x` → ref de B → forbidden por propiedad).
6. `accountIdFromPath` también pasa a UUID estricto (el único uso era outbound-media). `assertStoragePathOwnedBy(ref, accountId)` compara igualdad exacta y exige que `accountId` sea UUID.
7. `assertMediaPathOwnedBy` acepta `StorageObjectRef | string` (string = `chat-media`) para no romper su API exportada.
8. Extensión: `{1,8}` según el criterio A4 (la auditoría decía 10). `extensionForMime` produce ≤4 caracteres; `pptx/docx/xlsx/jpeg/3gp` siguen pasando.
9. Prettier: aplicado a los archivos que ya estaban formateados en HEAD. `upload-media.ts`, `upload-media.test.ts`, `template-header-handle.ts` y su test no estaban formateados en HEAD (otro estilo, sin `;`); no se reformatearon enteros para no inflar el diff de un fix de seguridad.
10. Tests de outbound-media: `A`/`B` pasan a UUID reales (antes `acct-a`/`acct-b`, que ya no son carpetas de cuenta válidas). En tenant-isolation, cuyos ids de cuenta no son UUID, los vectores parten de la carpeta legacy `<USER_A>/` de A, que sí pasa el control de propiedad sobre la cadena decodificada.

## Verificaciones contra base real
No aplica (sin SQL, sin RLS nueva).

## Verificaciones manuales pendientes
1. **Antes de desplegar**, en Supabase real (lectura): 
   `select bucket_id, name from storage.objects where bucket_id in ('chat-media','flow-media') and (name ~ '[\\%?#[:cntrl:]]' or name ~ '(^|/)\.{1,2}(/|$)' or name ~ '//' or name ~ '/$');`
   Debe devolver 0 filas; las que salgan dejarían de poder enviarse/firmarse.
   Igualmente: `select name from storage.objects where bucket_id in ('chat-media','flow-media') and name ~ '^account-' and name !~ '^account-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/';` → 0 filas.
2. Smoke tras desplegar: enviar desde el inbox una imagen subida con nombre con espacios y acentos; enviar una plantilla con cabecera imagen subida. Ambas deben llegar.

## Variables de entorno nuevas
Ninguna.

## Deuda fuera de alcance (no arreglada)
- `src/app/api/media/sign/route.ts` (m14.1, rama `feat/support-media-signing`) tiene su propia validación: unificar con `assertStoragePathOwnedBy` tras fusionar ambas.
- No hay regla de lint/wrapper (`adminStorageObject(ref)`) que obligue a que todo `supabaseAdmin().storage.from(b).<op>(path)` pase por `assertStoragePathOwnedBy` (sugerencia M1 de la auditoría).
- `remove/copy/move` de storage-js mandan rutas en el cuerpo JSON; la normalización del servidor no está verificada (fuera de alcance; hoy no reciben paths del usuario con rol de servicio).
- El fake solo normaliza en `download`; `createSignedUrl`/`upload` siguen indexando literal (no hay consumidor con rol de servicio afectado).
- `exportMediaReference` y el cliente (`signed-url.ts`) ahora tratan URLs no canónicas como enlace externo (devuelven la URL original); no explotable (RLS), pero cambia la salida para esos casos raros.
- `CHANGELOG` en inglés por consistencia con el resto de la sección Unreleased.
