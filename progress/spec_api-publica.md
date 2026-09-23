# API pública para clientes (fase 7, fuera de docs/saas/)

Pedido por el humano el 2026-09-15 sobre `main` @ 3b82698 (programa SaaS + fase 6 + marca
Cabbity). Objetivo: que un cliente pueda, con una API key propia, enviar mensajes por
plantilla, administrar plantillas, etiquetas y contactos, exportar chats y recibir webhooks,
con las mejores prácticas de seguridad, y que exista una sección de documentación donde vea
cómo configurarlo y qué puede hacer.

## 0. Decisión: dentro de Next.js, no un servicio Node aparte

**Se construye sobre `/api/v1` en este repo.** Razones, por peso:

1. **Ya existe el 60 %.** `src/lib/auth/api-context.ts` (`requireApiKey`), `src/lib/api-keys/*`
   (claves `wacrm_live_…`, SHA-256, prefijo visible, revocación), `src/lib/api/v1/*` (sobre
   `{data}/{error}`, paginación keyset, `ApiError`), `src/lib/rate-limit.ts`, `src/lib/webhooks/*`
   (firma HMAC estilo Stripe, guarda SSRF, autodesactivación), y rutas de mensajes, contactos,
   conversaciones, difusiones y webhooks. Un servicio aparte tendría que reimplementar o importar
   todo eso, más la puerta de facturación (`assertPlanFeature`, `assertWritable`), el cifrado
   versionado de secretos y el resolvedor multinúmero.
2. **La lógica de dominio es compartida.** Enviar una plantilla pasa por
   `src/lib/whatsapp/send-message.ts` y `template-send-builder.ts`, los mismos que usa la bandeja.
   Dos procesos con dos copias de esa lógica divergen; un solo proceso no.
3. **Un despliegue, una compuerta.** CI, Dockerfile, Dokploy, migraciones y la suite de
   aislamiento de inquilinos (`src/lib/security/tenant-isolation.test.ts`) ya cubren `/api/v1`.
   Un segundo servicio duplica pipeline, secretos y superficie de ataque.
4. **Las route handlers de Next 16 son Node puro** (`Request`/`Response` estándar, `after()` para
   trabajo tras responder). No hay nada en el alcance pedido que Next no pueda hacer: lo único
   que pide un proceso de larga duración —reintentos de webhooks y exportaciones grandes— se
   resuelve con cola en Postgres + ruta cron protegida por secreto, el patrón que ya usan
   `/api/automations/cron` y `/api/flows/cron`.

**Cuándo sí convendría separar** (y qué se deja preparado para que sea posible): si la API llega a
un volumen que compite con el panel por CPU en la misma instancia, o al desplegar varias
instancias (fase 5 §1: el limitador en memoria deja de limitar). Por eso todo lo nuevo vive en
`src/lib/api/v1/*` y `src/lib/webhooks/*` sin importar nada de `src/components` ni de
`src/app/(dashboard)`: el día que haga falta, esas carpetas se mueven a un `apps/api` con el
mismo Postgres sin tocar el dominio.

## Supuestos del líder (revisables por el humano)

- S-A1. Rama `feat/api-publica` desde `main` @ 3b82698; worktree `.claude/worktrees/api-publica`.
  Dos ramas de trabajo en paralelo que nacen de ella y se fusionan al cerrar: `api/recursos`
  (a7.1 → a7.2 → a7.3 → a7.5, en serie) y `api/webhooks` (a7.4). Documentación (a7.6 → a7.7)
  sobre la integración de ambas. Migraciones: 061 (a7.1), 062 (a7.4), 063 (a7.5).
- S-A2. **Las API keys se crean solo desde el panel** (Ajustes → API, rol admin+), nunca con otra
  API key. Una clave que fabrica claves es escalada de privilegios silenciosa; el pedido «que un
  usuario pueda crear su apikey» se cumple con el autoservicio del panel, que ya existe, más
  caducidad, rotación y enlace a la documentación.
- S-A3. **Sin dependencias nuevas.** Validación a mano como el resto de `/api/v1`, OpenAPI
  generado desde un registro tipado propio, documentación en componentes TSX. Si un implementer
  concluye que necesita una (p. ej. `zod`), se bloquea y pregunta.
- S-A4. Los scopes nuevos siguen el patrón `recurso:accion`: `tags:read`, `tags:write`,
  `templates:read`, `templates:write`, `conversations:export`. Se añaden a `API_SCOPES` y a
  `SCOPE_DESCRIPTIONS`; el panel los muestra al crear una clave.
- S-A5. La documentación para desarrolladores es **pública** (sin sesión), en `/developers`, en
  **español e inglés** (el coreano cae a inglés). La prosa larga vive en archivos de contenido por
  idioma, no en `messages/*.json`; los textos de interfaz de esa sección (menú, botones) sí van a
  los tres catálogos (CP6). `docs/public-api.md` pasa a ser un puntero a `/developers` para no
  mantener dos fuentes.
- S-A6. Reintentos de webhook: 5 intentos con espera 1 min, 5 min, 30 min, 2 h, 12 h; luego
  `dead`. Retención de entregas 30 días; de archivos de exportación 7 días.
- S-A7. La API sigue detrás de `assertPlanFeature(accountId, 'api')` como hoy. No se añaden
  cupos nuevos por plan en esta fase; exportaciones y sincronización de plantillas llevan su
  propio cubo de rate limit por cuenta en lugar de un cupo de facturación.

## Seguridad transversal (lo comprueba el reviewer en todas las features)

- Toda consulta con `supabaseAdmin()` filtra `.eq('account_id', ctx.accountId)` (o por FK
  verificada antes) y tiene test de fuga en la suite de aislamiento. Un recurso de otra cuenta
  responde `404`, nunca `403`.
- Las claves solo existen hasheadas; ningún log, informe ni respuesta contiene la clave completa,
  un secreto de webhook ni una URL firmada más de una vez.
- Toda URL que el servidor vaya a llamar pasa por `src/lib/webhooks/ssrf.ts` (`https://` y
  destino público) en el momento de la entrega, no solo al registrar.
- Comparaciones de secretos en tiempo constante (`timingSafeEqual`).
- Cuerpos JSON con tope de 1 MiB y `Content-Type: application/json` obligatorio en escrituras;
  campos desconocidos se ignoran, tipos incorrectos dan `bad_request` con el nombre del campo.
- Todas las respuestas de `/api/v1` llevan `Cache-Control: no-store`, `X-Request-Id` y el sobre
  de error incluye `request_id`. Sin CORS (servidor a servidor).
- Los mensajes de error no exponen SQL, rutas del servidor ni detalles de Meta más allá de su
  código y mensaje público.
- Operaciones costosas (sync de plantillas, exportaciones, crear webhooks) tienen su propio cubo
  en `RATE_LIMITS` además del general por clave (120/min).
- Ninguna feature toca `.env.local`; las variables nuevas se documentan en `.env.local.example`
  y en `docs/security.md`.

## 1. Endurecer la capa común (`a7.1` `api-hardening`)

Migración `061_api_idempotency.sql`: tabla `api_idempotency_keys(id, account_id, api_key_id,
idempotency_key, request_hash, response_status, response_body jsonb, created_at, expires_at)`,
`UNIQUE(api_key_id, idempotency_key)`, RLS solo `service_role`, índice por `expires_at`.

- Header `Idempotency-Key` (1–255 chars) en `POST /api/v1/messages` y `POST /api/v1/broadcasts`:
  misma clave + mismo cuerpo → misma respuesta guardada (con header `Idempotent-Replayed: true`);
  misma clave + cuerpo distinto → `409 idempotency_mismatch`; caduca a las 24 h. Helper
  `withIdempotency(ctx, request, handler)` en `src/lib/api/v1/idempotency.ts`, reutilizable por
  las escrituras que vengan.
- `X-Request-Id` (uuid) en toda respuesta de `/api/v1`, `request_id` en el sobre de error;
  `Cache-Control: no-store`. Se centraliza en `respond.ts` para que las rutas no lo repitan.
- Tope de cuerpo (1 MiB) y `Content-Type` en `requireApiKey` o en un helper `readJsonBody`.
- Panel (Ajustes → API): caducidad opcional al crear (30/90/365 días/nunca, usa `expires_at`
  que ya existe), **rotar** (`POST /api/account/api-keys/[id]/rotate`: crea una clave nueva con los
  mismos scopes, marca la vieja con `revoked_at = now() + 24 h` de gracia y avisa), enlace a
  `/developers`. Textos en es/en/ko.
- Códigos nuevos en `ApiErrorCode`: `idempotency_mismatch`, `payload_too_large`,
  `unsupported_media_type`, `conflict`.

Criterios:
- [ ] Test: dos POST iguales con la misma `Idempotency-Key` producen un solo mensaje y la segunda
      respuesta lleva `Idempotent-Replayed`; cuerpo distinto → 409; otra clave de API con la misma
      `Idempotency-Key` no ve la respuesta ajena (fuga).
- [ ] Test: cuerpo de 1 MiB + 1 → 413; `text/plain` → 415.
- [ ] Test: rotar deja dos claves activas 24 h y la vieja deja de autenticar después.
- [ ] Replay de migraciones verde con aserción en `verify-schema.sql`.

## 2. Etiquetas (`a7.2` `tags-v1`)

Sin migración. Scopes `tags:read`, `tags:write`.

- `GET /api/v1/tags` (paginado, `?search=`), `POST /api/v1/tags` `{name, color?}` (find-or-create
  por nombre, insensible a mayúsculas, 200/201), `GET|PATCH|DELETE /api/v1/tags/{id}` (`DELETE`
  quita también sus `contact_tags`).
- `POST /api/v1/contacts/{id}/tags` `{tag_ids: [...]}` y `DELETE /api/v1/contacts/{id}/tags/{tagId}`
  por id (hoy solo se puede por nombre dentro de `PATCH /contacts/{id}`, que se mantiene).
- Reutiliza `src/lib/contacts/tag-write.ts` y dispara `tag-events.ts` (las automatizaciones por
  etiqueta deben reaccionar igual que desde el panel).

Criterios:
- [ ] Tests de las 7 operaciones, incluido fuga (`tag` de otra cuenta → 404 en GET/PATCH/DELETE y
      al asignar a un contacto).
- [ ] Test: asignar una etiqueta por API dispara el mismo evento que el panel.

## 3. Plantillas (`a7.3` `templates-v1`)

Sin migración. Scopes `templates:read`, `templates:write`. Envuelve lo que ya hace el panel en
`src/lib/whatsapp/meta-api.ts` (`submitMessageTemplate`, `editMessageTemplate`,
`deleteMessageTemplate`) y `template-validators.ts`; no se duplica lógica de Meta.

- `GET /api/v1/templates` (paginado; filtros `status`, `language`, `category`, `search`),
  `GET /api/v1/templates/{id}`: devuelve nombre, idioma, categoría, estado de Meta, componentes,
  `rejection_reason`, `quality_score`, y la **lista de variables** que espera el cuerpo (para que
  el cliente sepa qué `params` pasar a `POST /messages`).
- `POST /api/v1/templates`: crea y envía a Meta (201, estado `PENDING`); `PATCH` edita y reenvía;
  `DELETE` borra en Meta y en local. Los errores de Meta salen como `meta_error` (502) con su
  código público. Con varios números, `whatsapp_config_id`/`from` opcional como en `/messages`.
- `POST /api/v1/templates/sync`: sincroniza desde Meta; cubo `templatesSync` 6/min por cuenta;
  devuelve `{synced, created, updated, status_changes: [...]}`.
- Documentar en la referencia cómo se relacionan `templates` y `POST /messages type=template`.

Criterios:
- [ ] Tests con Meta simulado (fetch mock) de crear/editar/borrar/sync y de fuga entre cuentas.
- [ ] Test: `GET /templates/{id}` expone las variables `{{1}}…{{n}}` del cuerpo en orden.
- [ ] Test: el cubo de `sync` responde 429 con `Retry-After`.

## 4. Webhooks duraderos y panel (`a7.4` `webhooks-durable`)

Migración `062_webhook_deliveries.sql`: `webhook_deliveries(id, account_id, endpoint_id, event,
payload jsonb, attempt int, status pending|delivered|failed|dead, next_attempt_at, last_status_code,
last_error, created_at, delivered_at)`, índices por `(status, next_attempt_at)` y
`(endpoint_id, created_at desc)`, RLS: lectura para miembros, escritura solo `service_role`.

- `dispatchWebhookEvent` persiste una entrega por endpoint suscrito y hace el primer intento en
  `after()`; los fallos dejan `next_attempt_at` según S-A6. Ruta `GET /api/webhooks/cron`
  (secreto `WEBHOOK_CRON_SECRET` en `x-cron-secret`, mismo patrón que automations) drena lo
  vencido con **cupo por cuenta** en cada barrido (fase 5 §3) y purga entregas > 30 días. La
  autodesactivación a los 15 fallos consecutivos se conserva.
- Eventos nuevos en `WEBHOOK_EVENTS`, con `data` documentado: `conversation.closed`,
  `conversation.assigned`, `contact.created`, `contact.updated`, `contact.tag_added`,
  `contact.tag_removed`, `template.status_updated` (lo emite el sync), `broadcast.completed`.
  Se disparan desde la capa de dominio (no solo desde `/api/v1`), para que un cambio hecho en el
  panel también llegue al cliente.
- API: `GET /api/v1/webhooks/{id}/deliveries` (paginado, filtro `status`),
  `POST /api/v1/webhooks/{id}/deliveries/{deliveryId}/retry`, `POST /api/v1/webhooks/{id}/test`
  (entrega `ping` firmada). `POST /api/v1/webhooks/{id}/rotate-secret` devuelve el secreto nuevo
  una vez.
- Panel: pestaña **Ajustes → Webhooks** (`src/components/settings/webhooks-settings.tsx`,
  rutas con cookie `/api/account/webhooks*` que reutilizan la misma lib): listar, crear (secreto
  mostrado una vez), editar URL/eventos, activar/desactivar, borrar, ver últimas entregas con
  código y error, reintentar. Textos es/en/ko.

Criterios:
- [ ] Test: endpoint que responde 500 deja la entrega `failed` con `next_attempt_at` = +1 min; el
      cron la reintenta y, tras 5 fallos, la marca `dead`; un 200 en el 3.º intento → `delivered`.
- [ ] Test: el barrido reparte el cupo entre cuentas (una cuenta con 1 000 pendientes no bloquea a
      otra con 1).
- [ ] Test: SSRF comprobado en cada intento (una URL que pasa a resolver a 10.x se rechaza).
- [ ] Test de fuga: entregas de otra cuenta → 404; el panel no ve `secret`.
- [ ] Replay verde; `.env.local.example` y `docs/security.md` con `WEBHOOK_CRON_SECRET`.

## 5. Exportar chats (`a7.5` `exports-v1`)

Migración `063_export_jobs.sql`: `export_jobs(id, account_id, api_key_id, kind, params jsonb,
format json|csv, status queued|running|done|failed, row_count, file_path, error, created_at,
finished_at, expires_at)`; bucket privado `exports` en Storage (creado por migración como los
buckets existentes). Scope `conversations:export`.

- **Síncrono**: `GET /api/v1/conversations/{id}/export?format=json|csv` devuelve la conversación
  con todos sus mensajes (orden cronológico, campos estables: `id, direction, sender_type,
  content_type, text, media_url, template_name, status, whatsapp_message_id, created_at`) como
  descarga (`Content-Disposition`). Tope 10 000 mensajes; por encima, `409` con indicación de usar
  el asíncrono.
- **Asíncrono**: `POST /api/v1/exports` `{kind: "conversations", format, filters: {status?,
  contact_id?, from?, to?}}` → 202 con el job; se procesa en `after()` y, si se corta, lo retoma
  el cron de webhooks (mismo barrido, cupo aparte). `GET /api/v1/exports/{id}` devuelve estado y,
  cuando está `done`, `download_url` firmada 15 min (nueva en cada GET). `GET /api/v1/exports`
  lista. Cubo `exports` 10/hora por cuenta. Archivos y filas se purgan a los 7 días.
- Las `media_url` privadas (f2 `private-media`) se exportan como referencia firmada de corta
  duración o como ruta interna, nunca como URL pública permanente: decidir en el diseño y
  documentarlo.

Criterios:
- [ ] Tests de ambos caminos con Storage simulado; CSV con escape correcto (comas, comillas,
      saltos de línea, celdas que empiezan por `=`).
- [ ] Test de fuga: `export` de conversación ajena → 404; job ajeno → 404; el filtro del job
      nunca sale de `account_id`.
- [ ] Test: URL firmada caduca y no se persiste.

## 6. Contrato OpenAPI (`a7.6` `openapi-spec`)

- Registro tipado en `src/lib/api/v1/openapi/` (un archivo por recurso) del que se genera un
  documento **OpenAPI 3.1** completo: seguridad `bearer`, scopes por operación, sobres, códigos de
  error, paginación, `Idempotency-Key`, esquemas de eventos de webhook (como `webhooks` de OpenAPI).
- `GET /api/v1/openapi.json` público, sin autenticación, con `Cache-Control` largo y `ETag`.
- Test que recorre `src/app/api/v1/**/route.ts`, extrae método+ruta y falla si alguna operación no
  está en el documento (y al revés). Test de que cada ejemplo del documento respeta su esquema
  (comprobación estructural propia; sin validador externo, S-A3).
- `mcp-server/` se actualiza para leer los endpoints nuevos (tags, templates, exports) con las
  mismas guardas de escritura que hoy.

Criterios:
- [ ] El test de cobertura pasa y protege las fases futuras (una ruta nueva sin documentar rompe
      CI).
- [ ] `curl /api/v1/openapi.json` devuelve un documento que un cliente OpenAPI estándar importa.

## 7. Sección de documentación para clientes (`a7.7` `developer-docs`)

Ruta pública `src/app/(public)/developers/` (grupo nuevo sin el layout del dashboard), es/en
con selector (S-A5), diseño con los tokens `--cb-*` de la marca Cabbity, navegación lateral,
bloques de código con botón copiar (sin resaltador externo), y modo oscuro.

Páginas:
1. **Empezar**: crear la clave en Ajustes → API (con captura), primera petición a `/me`,
   variables de entorno recomendadas, qué plan incluye la API.
2. **Autenticación y scopes**: tabla de scopes, principio de mínimo privilegio, rotación,
   caducidad, qué hacer si se filtra una clave.
3. **Convenciones**: sobre de respuesta, códigos de error, `request_id`, rate limits,
   paginación, idempotencia.
4. **Guías**: enviar un mensaje de plantilla de punta a punta (crear plantilla → esperar
   aprobación → enviar → seguir estado por webhook); sincronizar contactos y etiquetas; exportar
   conversaciones; recibir webhooks con verificación de firma en **Node, Python y PHP** y
   manejo de reintentos/duplicados.
5. **Referencia**: generada desde `/api/v1/openapi.json` en servidor (recurso → operación →
   parámetros, cuerpo, respuestas, ejemplos `curl`), para que nunca quede detrás del código.
6. **Webhooks**: eventos, `data` por evento, firma, semántica de entrega, panel.
7. **Integraciones**: servidor MCP (`mcp-server/`), enlaces al OpenAPI para generar SDKs.
8. **Changelog de la API** (`src/app/(public)/developers/changelog` alimentado por un archivo
   de contenido por versión).

Enlaces desde el panel: Ajustes → API y Ajustes → Webhooks apuntan aquí. `docs/public-api.md`
queda como puntero. `robots`/`sitemap` incluyen `/developers`.

Criterios:
- [ ] Test de que la referencia renderiza todas las operaciones del OpenAPI y de que ningún
      enlace interno de la sección está roto.
- [ ] Sin sesión se ve; con sesión no cambia. Lighthouse de accesibilidad ≥ 90 se comprueba a mano
      y se anota en el informe (no hay e2e).
- [ ] Textos de interfaz en es/en/ko; prosa en es/en (S-A5).

## Orden y paralelismo

```
main @ 3b82698
 └─ feat/api-publica
     ├─ api/recursos : a7.1 → a7.2 → a7.3 → a7.5   (en serie; comparten respond.ts/scopes.ts)
     └─ api/webhooks : a7.4                         (en paralelo; toca src/lib/webhooks y el panel)
 → fusión de ambas en feat/api-publica → a7.6 → a7.7
```

Estimación: 7 features, cada una 2–4 rondas implementer↔reviewer en Opus, como en las fases
anteriores. El humano hace el merge a `main`, el push y el PR.
