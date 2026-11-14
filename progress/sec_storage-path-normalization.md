# Auditoría: normalización de rutas de Storage tras validar (wacrm)

- Alcance: `main` @ 7bc2fd2. Solo lectura. Ramas `feat/*` fuera de alcance; el caso
  de `feat/support-media-signing` ya lo tiene el reviewer.
- Auditor: security_auditor · 2026-11-05
- Resumen: **1 crítico, 1 alto, 1 medio, 2 bajos.**

## Causa raíz (verificada)

1. `parseStorageObjectUrl` (`src/lib/media/storage-url.ts:65-80`) parte el
   `pathname` (ya normalizado por `new URL`) y **luego** aplica
   `decodeURIComponent` a cada segmento. Lo que sale son bytes crudos: `/`, `\`,
   `..`, `%2e`, `\t`, `\n`, `?`, `#`. Esos bytes no pasaron nunca por la
   normalización.
2. `accountIdFromPath` (`storage-url.ts:104-109`) solo mira el primer segmento
   textual (`account-<x>`) y no comprueba que sea un UUID.
3. `@supabase/storage-js@2.108.2` (`dist/index.cjs:1528`, `_getFinalPath`)
   interpola el `path` **sin codificar**: `${bucketId}/${path.replace(/^\/+/,'')}`.
   Las operaciones afectadas y su URL:
   - `download` (L1185): `${url}/object/${_path}`, o `render/image/authenticated/...` si lleva transform.
   - `createSignedUrl` (L1043): `${url}/object/sign/${_path}`.
   - `upload`/`update` (L627-629): `_removeEmptyFolders` + `_getFinalPath`. No resuelve `..` ni `\`.
   - `createSignedUploadUrl` (L747/819), `info` (L1218), `exists` (L1241) y `getPublicUrl` (L1321): el mismo patrón.
   - `remove` (L1366), `copy` (L973) y `move` (L928) mandan las rutas en el **cuerpo
     JSON**. El fetch no las normaliza; la normalización depende del servidor de
     Storage y aquí no se verificó.
4. Al construir el `Request`, `fetch` (undici, WHATWG URL) hace varias cosas:
   convierte `\` en `/`, quita `\t` y `\n`, interpreta `%2e%2e` como `..`,
   resuelve los `..`, toma `?` como inicio de la query y `#` como fragmento.

Lo comprobé en Node 25.9 con el `StorageClient` real y un `fetch` que captura la
URL (`new Request(url).url` da el mismo resultado). Todas las entradas son
`https://proj.supabase.co/storage/v1/object/public/chat-media/<v>`:

| `<v>` (almacenado en `media_url`) | `ref.path` | `accountIdFromPath` | URL final de `download` |
|---|---|---|---|
| `account-A%2F..%2Faccount-B%2Fx.png` | `account-A/../account-B/x.png` | A ✅ | `/storage/v1/object/chat-media/account-B/x.png` |
| `account-A/..%5Caccount-B%5Cx.png` | `account-A/..\account-B\x.png` | A ✅ | `/storage/v1/object/chat-media/account-B/x.png` |
| `account-A/%252e%252e/account-B/x.png` | `account-A/%2e%2e/account-B/x.png` | A ✅ | `/storage/v1/object/chat-media/account-B/x.png` |
| `account-A/.%09./account-B/x.png` | `account-A/.\t./account-B/x.png` | A ✅ | `/storage/v1/object/chat-media/account-B/x.png` |
| `account-A/%0A..%2Faccount-B/x.png` | `account-A/\n../account-B/x.png` | A ✅ | `/storage/v1/object/chat-media/account-B/x.png` |
| `account-A/..%2F..%2Fflow-media%2Faccount-B%2Fx.png` | `account-A/../../flow-media/...` | A ✅ | `/storage/v1/object/flow-media/account-B/x.png` (**otro bucket**) |
| `account-A/..%2F..%2F..%2F..%2F..%2Frest%2Fv1%2Fprofiles%3Fselect%3D*%23` | `account-A/../../../../../rest/v1/profiles?select=*#` | A ✅ | **`/rest/v1/profiles?select=*`** (sale de Storage) |
| `account-A/../account-B/x.png` (sin codificar) | `account-B/x.png` | B ❌ | se rechaza bien |
| `account-A/%2e%2e/account-B/x.png` | `account-B/x.png` | B ❌ | se rechaza bien |

`createSignedUrl` resuelve igual (`/storage/v1/object/sign/chat-media/account-B/x.png`).
`MEDIA_BUCKETS.has(ref.bucket)` no protege: el bucket que se comprueba es el del
segmento 4, y el destino real lo decide la normalización.

El cliente admin (`createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)`,
p. ej. `src/lib/ai/admin-client.ts:9`) manda `apikey` y `Authorization: Bearer
<service_role>` en todas las peticiones de Storage. Un `download` desviado es, por
tanto, un **GET con rol de servicio contra cualquier ruta del origen Supabase**:
otros buckets, `/rest/v1/*` (PostgREST sin RLS) y `/auth/v1/admin/*`.

---

## C1 — CRÍTICO · `resolveOutboundMedia`: lectura cruzada entre cuentas y GET con rol de servicio

- **Dónde:** `src/lib/whatsapp/outbound-media.ts:233-246`. El check está en
  `assertMediaPathOwnedBy` (L192-219, que usa `accountIdFromPath`, L197) y la
  operación en `storage.from(ref.bucket).download(ref.path)` (L246).
- **Entradas que controla el atacante.** Cualquier miembro o API key de la cuenta A:
  - `POST /api/v1/messages` (`src/app/api/v1/messages/route.ts:106,146`, `body.media_url`), con API key.
  - `POST /api/whatsapp/send` (`src/app/api/whatsapp/send/route.ts:53,85,168`).
    Ambas van por `sendMessageToConversation` (`src/lib/whatsapp/send-message.ts:380-396`, con `supabaseAdmin().storage`).
  - Nodo de flow con `media_url` → `engineSendMedia` (`src/lib/flows/meta-send.ts:270-277`, `db.storage` admin) ← `src/lib/flows/engine.ts:664`.
  - Cabecera multimedia de plantilla: `header_media_url` de la plantilla o
    `headerMediaUrl` por envío → `resolveTemplateHeaderMedia`
    (`outbound-media.ts:290-320`). Se llama desde `send-message.ts:396` y desde
    `broadcast-core.ts:404-414` (difusiones, también con `/api/whatsapp/broadcast`,
    `route.ts:327`).
- **Vector:** `media_url = <NEXT_PUBLIC_SUPABASE_URL>/storage/v1/object/public/chat-media/account-<A>%2F..%2Faccount-<B>%2F<obj>`.
  Vale cualquiera de las variantes de la tabla.
- **Explotable: sí, de punta a punta.** El origen coincide, el bucket es
  `chat-media` y `accountIdFromPath` devuelve A, así que el check pasa. Con rol de
  servicio se descarga el objeto de B, se sube a Meta (`uploadMedia`) y se envía
  como adjunto al destinatario que el atacante elija, por ejemplo su propio
  WhatsApp. **El atacante recibe el archivo de la otra cuenta.**
- **Impacto:**
  - **Lectura** de cualquier objeto en `chat-media` y `flow-media` de cualquier
    cuenta: adjuntos de clientes, documentos e imágenes.
  - **Salida a otros buckets privados** (`../../<bucket>/...`): exportaciones de
    conversaciones de otras cuentas (bucket de `src/lib/exports/jobs.ts`,
    `<account_id>/<job_id>.<ext>`) y avatares. Para el bucket de exportaciones
    hace falta conocer `job_id`, que es un UUID.
  - **SSRF con credencial de servicio** contra el mismo origen: `GET
    /rest/v1/<tabla>?select=*` (BD entera sin RLS) y `GET /auth/v1/admin/users`.
    La exfiltración depende de que Meta acepte el MIME de la respuesta.
    `mimeTypeFor` usa `blob.type` (`application/json`), así que Meta probablemente
    la rechaza. Aun así es un GET privilegiado a ciegas, y hay un **oráculo de
    existencia**: el código `not_found` (404/403 de Storage) se distingue de
    `upload_failed` (los bytes se leyeron). No probé contra un Supabase real si
    Kong enruta el `..` que ya resolvió el cliente; el cliente sí envía
    `/rest/v1/...` literal.
  - No se ve escritura ni borrado por esta vía: solo hay `download`.
- **Mitigación:**
  1. En `parseStorageObjectUrl`, rechazar (devolver un error, **no** `null`: `null`
     hace que el llamador lo trate como enlace externo y lo pase como `{ link }`)
     cualquier `path` decodificado que contenga `\`, `%`, `?`, `#`, caracteres de
     control (`[\u0000-\u001f\u007f]`), un segmento vacío, `.` o `..`.
     Mejor todavía, una lista blanca por segmento: `^[A-Za-z0-9_-][A-Za-z0-9._-]*$`.
     Es compatible con `buildMediaPath` (`account-<uuid>`, `inbound`,
     `<ts>-<base>.<ext>`) y con las rutas legacy `<uuid>/...`. Antes de cerrarla,
     comprobar en BD que no haya nombres legados fuera de la lista:
     `select name from storage.objects where bucket_id in ('chat-media','flow-media') and name !~ '^[A-Za-z0-9._/-]+$'`.
  2. **Comprobación de ida y vuelta** (defensa en profundidad):
     `new URL(`${origin}/storage/v1/object/${bucket}/${path}`).pathname` tiene que
     ser exactamente `/storage/v1/object/${bucket}/${path}`, y `search`/`hash`
     tienen que estar vacíos. Si no coincide, se rechaza.
  3. `accountIdFromPath`: exigir `^account-<uuid>$` con regex de UUID.
  4. En `resolveOutboundMedia`, un `media_url` con nuestro origen y prefijo
     `/storage/` que no parsea limpio tiene que dar `forbidden`, nunca
     `{ link: mediaUrl }`. Ese fallback le pasaría la URL rara a Meta: no es un
     cruce de cuentas, pero sí una vía de evasión.

## H1 — ALTO · `ensureImageHeaderHandle`: lectura cruzada de imágenes para la muestra de plantilla

- **Dónde:** `src/lib/whatsapp/template-header-handle.ts:62-67`
  (`parseStorageObjectUrl` → `assertMediaPathOwnedBy` → `source.storage.from(ref.bucket).download(ref.path)`, rol de servicio).
- **Entradas:** `header_media_url` al crear o editar una plantilla:
  - `src/app/api/v1/templates/route.ts:204`
  - `src/app/api/v1/templates/[id]/route.ts:193`
  - `src/app/api/whatsapp/templates/[id]/route.ts:174`
  - `src/app/api/whatsapp/templates/submit/route.ts:219`

  `template-validators.ts:156-163` solo comprueba que el esquema sea http(s).
- **Explotable: sí, con la misma causa que C1.** La salida está limitada a
  JPEG/PNG (L71-73) de hasta 5 MB.
- **Impacto:** lectura cruzada de imágenes de otras cuentas, y de cualquier
  bucket. La imagen se sube a Meta como muestra de la plantilla de A, y el
  atacante la ve en WhatsApp Manager y en el envío. Esa misma
  `header_media_url` vuelve a pasar por `resolveTemplateHeaderMedia` en cada
  envío (C1). Con un MIME no imagen no se exfiltra nada, pero el GET con rol de
  servicio se hace igual.
- **Mitigación:** la misma de C1. Arreglándolo en `storage-url.ts` queda cubierto
  sin tocar este archivo.

## M1 — MEDIO · Diseño: `parseStorageObjectUrl` devuelve un path no canónico como dato de confianza

- **Dónde:** `src/lib/media/storage-url.ts:76-80` y `104-109`.
- **Qué pasa:** el contrato («Object path inside the bucket, URL-decoded») invita
  a todos los consumidores a validar sobre una cadena que no es la que acaba en
  el cable. Hoy lo usan:
  - `outbound-media.ts` (C1) y `template-header-handle.ts` (H1): explotables.
  - `src/lib/media/signed-url.ts:99-110` y `blob-cache.ts`/`download.ts`/`use-media-blob-url.ts`:
    cliente del usuario. **No explotable**, porque la RLS de `storage.objects`
    evalúa el nombre ya normalizado por el servidor.
  - `src/lib/exports/conversations.ts:122` (`exportMediaReference`): solo
    serializa la cadena. **No explotable**, aunque puede emitir
    `storage://chat-media/account-A/../account-B/x`, que es engañoso.

  Cualquier ruta nueva con `supabaseAdmin()` que reutilice el parser hereda el
  fallo: es justo el caso que el reviewer encontró en `feat/support-media-signing`.
- **Mitigación:** **centralizar en `storage-url.ts`**. Que `parseStorageObjectUrl`
  devuelva solo paths canónicos (lista blanca + ida y vuelta de C1.1 y C1.2), y
  añadir un `assertStoragePathOwnedBy(ref, accountId)` único que encapsule el
  check de cuenta con UUID estricto. Los llamadores con rol de servicio no
  deberían poder llegar a `.from(bucket).<op>(path)` sin pasar por él. Una regla
  de lint o un wrapper `adminStorageObject(ref)` lo haría cumplir.

## L1 — BAJO · `buildMediaPath`: la extensión no se sanea

- **Dónde:** `src/lib/storage/upload-media.ts:65-66`. `ext = fileName.split(".").pop()`
  solo excluye `.`, así que puede contener `/`, `\`, `%`, `?`, `#`.
  Ejemplo: `x./%2e%2e/%2e%2e/account-B/y` → `account-A/<ts>-x./%2e%2e/%2e%2e/account-B/y` → `fetch` → `account-B/y`.
  Ojo: el `base` (`safeBase`) sí se sanea; lo que queda abierto es solo la extensión.
- **Explotable hoy: no.**
  - `uploadAccountMedia` (L120) usa el cliente del navegador del propio usuario,
    y la RLS de escritura evalúa el nombre final.
  - `mirror-inbound-media.ts:198-208` usa el rol de servicio, pero su extensión
    sale de un mapa fijo (`extensionForMime`, `src/lib/media/filename.ts:64-68`)
    y la cuenta viene de BD.
- **Riesgo latente:** escritura o sobrescritura cruzada (`upsert: true` en el
  mirror) si alguien reutiliza `buildMediaPath` con rol de servicio y un nombre
  de archivo del remitente.
- **Mitigación:** `ext = /^[a-z0-9]{1,10}$/.test(e) ? e : 'bin'`. Así encaja con la
  lista blanca de M1.

## L2 — BAJO · La prueba de aislamiento no cubre variantes codificadas

- **Dónde:** `src/lib/security/tenant-isolation.test.ts:1586-1604`. Solo prueba la
  ruta literal `account-acct-b/1-secret.png`. El `fake-supabase`
  (`src/lib/security/fake-supabase.ts:323,436`) indexa por la cadena `path` y no
  emula la normalización de URL, así que ningún test puede detectar C1 ni H1.
- **Mitigación:**
  - Tests unitarios de `parseStorageObjectUrl`/`assertMediaPathOwnedBy` con
    todos los vectores de la tabla (`%2F..%2F`, `%5C`, `%252e%252e`, `.%09.`,
    `%0A`, `%3F`, `%23`, salida a otro bucket y a `/rest/v1`). Todos tienen que
    dar `forbidden`.
  - En el fake, normalizar la clave con
    `new URL('http://x/o/' + bucket + '/' + path).pathname` para reproducir el
    comportamiento real de `fetch`.

---

## Revisado y sin hallazgo

- `src/lib/exports/jobs.ts:209-215,336,420-422,547`: el path lo construye el
  servidor (`<account_id>/<job_id>.<ext>`) desde BD, con formato de lista blanca.
  No hay entrada del usuario.
- `src/lib/whatsapp/mirror-inbound-media.ts`: cuenta desde BD, `mediaId` de un
  webhook firmado, extensión de mapa fijo y `stem` saneado por `buildMediaPath`.
- `src/lib/supabase/client.ts:170-240` (`guardReadOnly`): solo filtra
  operaciones; no construye paths.
- `src/components/settings/profile-form.tsx:124-136` y `deleteAccountMedia`
  (`upload-media.ts:146-152`): cliente del usuario, protegido por RLS.
- `cacheKey(phoneNumberId, bucket, path)` en `outbound-media.ts`: va por número,
  así que no hay envenenamiento entre cuentas.

## Prioridad de corrección

1. C1 + H1 + M1 juntos, con un único arreglo en `storage-url.ts`: lista blanca
   por segmento, ida y vuelta por `new URL`, `accountIdFromPath` con UUID
   estricto, y `forbidden` en lugar del fallback `{ link }` para URLs de nuestro
   origen que no parsean.
2. L2: tests con los vectores, en la misma feature.
3. L1: saneamiento de la extensión. Es de una línea.
4. Antes de desplegar la lista blanca, ejecutar el `select` de nombres legados de C1.1.
