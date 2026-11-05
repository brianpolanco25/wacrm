# n13.1 `integrations-catalog` — requisitos

**Fase 13** (`feature_list.json`, `sdd: true`). Redactada el 2026-11-03 por `spec_author`.
Base de lectura: `feat/integraciones` @ 5f64211 (= `main`). Migración **091** (la 090 la reserva la
fase 12, `feat/invitacion-directa`, en paralelo). i18n: `es` (defecto) y `en`; sin `ko` (CP6).

## Contexto

Pedido del humano (2026-11-03): «Como Super administradores debemos poder crear unas integraciones
que pueden utilizar los clientes con algunas de nuestras aplicaciones. Por ejemplo Cabbity Health,
app de gestión médica con una API para crear citas, consultar doctores, etc.».

Hechos que fijan el diseño:

- Cabbity Health (`/mnt/nvme-big/Dev/apps/cabbity-health`, Laravel 12) expone `/api/v1` con Bearer
  de Sanctum; el tenant sale del token, no del host. Sus módulos de pacientes (1.3) y citas (1.4)
  están en `spec_ready`: **hoy no existe ninguna ruta de citas ni de doctores**. El CRM no puede
  acoplarse a endpoints concretos: la integración tiene que describirse con **datos** que el
  operador carga cuando Health los publique.
- El panel de plataforma (`src/app/(platform)/platform/*`, `requirePlatformAdmin`) ya administra
  catálogos globales sin `account_id` (planes, s9.3; tarifas de Meta, 076) con rol de servicio.
- Ningún proveedor de IA tiene tool calling hoy (`src/lib/ai/providers/*`); los flows
  (`src/lib/flows/engine.ts`) y las automatizaciones (`src/lib/automations/engine.ts`, paso
  `send_webhook`) existen y ya hacen salidas HTTP con guardas SSRF.

## Alcance y división (decisión D4)

El encargo completo (catálogo + activación + primer punto de uso) no cabe en una feature revisable.
Esta spec cubre **catálogo + activación por cuenta + ejecutor común**; el punto de uso pasa a
features siguientes de la fase, que el líder debe dar de alta:

- **n13.2 `integration-flow-node`** — nodo de flow `integration_call`: elige una integración activa
  de la cuenta y una operación, mapea sus parámetros desde `{{vars.X}}` / campos del contacto, llama
  a `executeIntegrationOperation` (R27) y guarda la respuesta (o los `outputs` declarados) en
  `flow_runs.vars`, con salida de éxito y de fallo. Requiere ampliar el CHECK
  `flow_nodes_node_type_check` (010/016). **Recomendado como primer punto de uso**: el motor existe
  y la IA aún no sabe llamar herramientas.
- **n13.3 `integration-ai-tools`** — las operaciones activas de la cuenta como herramientas de la IA
  de respuesta automática (tool calling en `src/lib/ai/providers/*`), usando `description` y
  `params` del catálogo como esquema.
- **n13.4 `integration-automation-step`** — paso de automatización `integration_call` en
  `AutomationStepType` (`src/types/index.ts`) y `src/lib/automations/engine.ts`.

## Criterios de aceptación de partida (encargo del líder)

- **A1** Catálogo en `/platform/integrations`: crear, editar y desactivar integraciones (nombre,
  slug, descripción, logo, URL base, esquema de autenticación) y sus operaciones (método, ruta,
  parámetros tipados con descripción, descripción en lenguaje natural, qué devuelven). Modelo
  declarativo recomendado y justificado; la decisión es del humano (D1).
- **A2** Ajustes → Integraciones: el cliente ve el catálogo activo, activa con sus credenciales
  (cifradas en reposo, nunca devueltas), prueba la conexión y desactiva. Limitación por plan
  propuesta y marcada como decisión (D2).
- **A3** Primer punto de uso elegido y justificado; IA y automatizaciones como features siguientes
  (resuelto arriba: n13.2–n13.4, fuera de esta spec).
- **A4** Seguridad: SSRF (https, host no privado, allowlist del operador), timeout, tamaño máximo de
  respuesta, rate limit por cuenta, registro de llamadas sin cuerpos, aislamiento multi-tenant (CP3),
  sesión de soporte (D3).
- **A5** Migración nueva tras la última, idempotente, con `verify-schema.sql` y
  `progress/checks_integrations-catalog.sql`. i18n es/en.

## Decisiones abiertas para el humano

| # | Decisión | Recomendación (lo que esta spec implementa) | Alternativa |
|---|---|---|---|
| D1 | Modelo de integración | **Declarativo**: integración + operaciones HTTP como filas; un ejecutor genérico. Cero despliegues por integración; sirve a Health antes de que sus rutas existan. | Conectores codificados (un módulo TS por integración). Más expresivos (OAuth, paginación, transformaciones), pero cada integración es un PR + despliegue. |
| D2 | Limitación por plan | **Entitlement booleano** `integrations` en `plans.features`, que el operador marca en `/platform/plans`. La migración no se lo da a ningún plan. | Lista de planes por integración (`integrations.plan_ids text[]`). Más fina; cuesta una columna y un editor. Se puede añadir después sin romper nada. |
| D3 | Sesión de soporte | ~~**Bloqueada** para escribir: activar, cambiar credencial, desactivar y probar dan 403, como las claves API (`/api/account/api-keys`). Leer el estado sí.~~ **Revertida por n13.6** (humano, 2026-11-05: «el superadmin debería poder hacerlo»): rige la alternativa. | **Vigente desde n13.6:** permitida con traza en `impersonation_actions` (acción `integration.enable` / `.test` / `.disable` / `.ai_settings` y slug, nunca la credencial ni su último 4); el operador ve el último 4 en la pantalla y puede pegar la credencial del cliente. |
| D4 | Punto de uso | **Fuera de n13.1**; n13.2 = nodo de flow. | Meter el nodo de flow aquí (feature ~2× más grande). |
| D5 | Desactivar | **Borra la credencial** (la columna queda `NULL`); reactivar exige pegarla de nuevo. | Conservarla cifrada para reactivar con un clic. |
| D6 | Números | Timeout 10 s, respuesta ≤ 256 KiB, 60 llamadas/min por cuenta (por proceso, como todo `rate-limit.ts`). | Otros valores; son constantes. |

## Requisitos (EARS)

### Esquema (migración 091)

- **R1** (A5) El sistema debe crear, en `supabase/migrations/091_integrations.sql` (idempotente), las
  tablas `integrations` (catálogo global, sin `account_id`), `integration_operations` (hija de
  `integrations`, `UNIQUE (integration_id, key)`), `account_integrations` (`UNIQUE (account_id,
  integration_id)`) e `integration_calls` (registro), con las columnas, CHECK y FK de `design.md` §2.
  Las FK hacia `integrations` deben ser `ON DELETE RESTRICT`.
  *Verificación:* `scripts/replay-migrations.sh` sale 0 y, aplicando la 091 dos veces, también;
  bloque `-- 091` en `supabase/ci/verify-schema.sql`; SQL de CHECK y FK en
  `progress/checks_integrations-catalog.sql`.
- **R2** (A4, CP3) Mientras el rol sea `anon` o `authenticated`, el sistema debe negar cualquier
  `SELECT`, `INSERT`, `UPDATE` o `DELETE` sobre las cuatro tablas; solo `service_role` las toca.
  *Verificación:* `checks_…sql` con `SET ROLE authenticated` → `permission denied` en cada tabla;
  aserción en `verify-schema.sql` de RLS activada y sin políticas ni privilegios para
  `anon`/`authenticated`.
- **R3** (A2, D5) Mientras `account_integrations.is_enabled` sea `true`, el sistema debe exigir
  `credential IS NOT NULL` (CHECK).
  *Verificación:* `checks_…sql`: `UPDATE … SET credential = NULL` en una fila activa viola el CHECK.

### Catálogo (operador de plataforma)

- **R4** (A1) Cuando una petición a `/api/platform/integrations/**` no traiga sesión, el sistema debe
  responder 401; cuando la traiga de un usuario sin fila en `platform_admins` (incluido un `owner`),
  403, sin escribir nada.
  *Verificación:* tests de cada `route.test.ts` de plataforma y bloque en
  `src/lib/security/tenant-isolation.test.ts` (403 en todas las rutas y tablas intactas).
- **R5** (A1) Cuando el operador cree una integración, el sistema debe validar: `slug`
  `^[a-z][a-z0-9-]{1,39}$` y único (409 si existe); `name` 1–80; `description` 0–500;
  `logo_url` nulo o URL `https:`; `base_url` URL `https:` sin usuario/contraseña, sin query ni
  fragmento, cuyo host no sea literal privado ni `localhost`/`*.local`/`*.internal` y que
  `isDeliverableUrl` acepte; `auth_scheme` ∈ `bearer` | `header`; con `header`, `auth_header_name`
  `^[A-Za-z0-9-]{1,64}$` y fuera de la lista prohibida de `design.md` §4; `test_path` ruta relativa
  válida (R8); `credential_help` 0–500. Cualquier fallo → 400 con el campo; éxito → 201 con
  `is_active = false`.
  *Verificación:* `src/lib/integrations/catalog-validate.test.ts` (un caso por regla, incluido
  `http://`, `https://10.0.0.1`, `https://localhost`, `https://u:p@x.com`, cabecera `Host`) y
  `src/app/api/platform/integrations/route.test.ts` (201, 400, 409).
- **R6** (A1) Cuando el operador edite una integración, el sistema debe aplicar las mismas reglas que
  R5 a los campos presentes y rechazar con 400 cualquier intento de cambiar `slug`.
  *Verificación:* `src/app/api/platform/integrations/[id]/route.test.ts` (PATCH parcial, slug → 400,
  id inexistente → 404).
- **R7** (A1) Cuando el operador cree o edite una operación, el sistema debe validar: `key`
  `^[a-z][a-z0-9_]{1,63}$` y única en la integración (409); `name` 1–80; `description` 1–1000
  (obligatoria: es lo que leerá la IA en n13.3); `method` ∈ `GET` `POST` `PUT` `PATCH` `DELETE`;
  `path` según R8; `params` y `outputs` según R9; `response_description` 0–1000. Fallo → 400;
  éxito → 201/200.
  *Verificación:* `catalog-validate.test.ts` y
  `src/app/api/platform/integrations/[id]/operations/route.test.ts` +
  `[id]/operations/[opId]/route.test.ts`.
- **R8** (A1, A4) El sistema debe aceptar como `path` (y `test_path`) solo una ruta que empiece por
  `/`, sin `..`, sin `//`, sin `?`, `#`, `\`, espacios ni esquema, con marcadores `{nombre}`; y,
  para una operación, cuando el conjunto de marcadores no coincida exactamente con los parámetros
  `in: 'path'` declarados, debe rechazarla con 400.
  *Verificación:* `catalog-validate.test.ts` (`/a/{id}` con param `id` ✓; sin param ✗; param de más
  ✗; `/../x` ✗; `/a?b=1` ✗; `//evil.com/x` ✗).
- **R9** (A1) El sistema debe aceptar como `params` una lista de 0–30 objetos `{name, in, type,
  required, description, enum?}` con `name` `^[a-z][a-zA-Z0-9_]{0,63}$` único, `in` ∈ `path` |
  `query` | `body`, `type` ∈ `string` | `integer` | `number` | `boolean`, `description` 1–500,
  `enum` solo con `type: 'string'` (1–50 valores); todo parámetro `in: 'path'` debe ser
  `required: true`; y cuando `method` sea `GET` o `DELETE` no debe admitir `in: 'body'`. Como
  `outputs`, una lista de 0–30 `{name, path, type, description}` con `path` en notación de puntos
  (`data.items.0.id`) y `type` además ∈ `object` | `array`.
  *Verificación:* `catalog-validate.test.ts` (cada regla, ida y vuelta de un ejemplo de Health:
  «crear cita» `POST /appointments` con `doctor_id` integer body, `starts_at` string body).
- **R10** (A1) El sistema no debe exponer ruta de borrado de integraciones ni de operaciones; cuando
  el operador ponga `is_active = false` en una integración o una operación, esta debe desaparecer
  del catálogo del cliente (R14) y el ejecutor debe rechazarla (R30) sin tocar las activaciones
  existentes.
  *Verificación:* ausencia de `DELETE` exportado en las rutas de plataforma (test que importa el
  módulo y comprueba `DELETE === undefined`); tests de R14 y R30 con integración inactiva.
- **R11** (A1) Cuando el operador abra `/platform/integrations`, el sistema debe listar todas las
  integraciones (activas o no) con nombre, slug, estado, número de operaciones activas y número de
  cuentas con la integración activada; y en `/platform/integrations/<id>`, el formulario de la
  integración y la lista editable de sus operaciones. Un usuario que no sea operador debe recibir
  el 404 de `guardPlatformPage`.
  *Verificación:* `src/components/platform/platform-integrations.test.tsx` y
  `platform-integration-editor.test.tsx` (marcado estático con catálogo precargado, como
  `platform-plans.test.tsx`); `src/components/platform/integration-form.test.ts` (estado del
  formulario → cuerpo exacto del POST/PATCH); `platform-shell.test.tsx` (entrada de navegación).

### Plan

- **R12** (A2, D2) El sistema debe reconocer `integrations` como clave de `plans.features`
  (`PLAN_FEATURES` en `src/lib/billing/plan-catalog.ts`), editable desde `/platform/plans`, sin que
  la migración la añada a ningún plan.
  *Verificación:* `src/lib/billing/plan-catalog.test.ts` (inventario = claves documentadas en 041
  ∪ 091; la clave que el código comprueba está en el inventario); `checks_…sql`: ningún plan
  sembrado tiene `integrations` tras la 091.
- **R13** (A2, D2) Cuando el plan de la cuenta no incluya `integrations`, el sistema debe responder
  402 (`billingErrorPayload`) a activar y a probar, permitir desactivar, y devolver en el `GET` del
  cliente `planAllows: false`.
  *Verificación:* `src/app/api/account/integrations/[integrationId]/route.test.ts` y
  `[integrationId]/test/route.test.ts` (402 y DELETE 200 sin la feature) y
  `src/app/api/account/integrations/route.test.ts`.

### Activación por cuenta (cliente)

- **R14** (A2) Cuando un miembro de la cuenta (cualquier rol) pida `GET /api/account/integrations`,
  el sistema debe devolver las integraciones activas del catálogo con sus operaciones activas
  (`key`, `name`, `description`, `method`) más, como `retired: true`, las inactivas que la cuenta
  aún tenga activadas; por cada una, el estado de **esa** cuenta (`enabled`, `credentialLast4`,
  `enabledAt`, `lastTestedAt`, `lastTestStatus`) y nunca `credential` ni su cifrado; y los
  indicadores `planAllows` y `canManage` (rol ≥ `admin`; n13.6: también en sesión de soporte,
  cuyo rol efectivo es `admin`) y `supportSession` (n13.6).
  *Verificación:* `src/app/api/account/integrations/route.test.ts` (forma exacta; búsqueda de la
  cadena cifrada y del texto claro en el JSON → ausente; integración inactiva sin activación → no
  aparece; con activación → `retired: true`).
- **R15** (A2) Cuando un `admin` u `owner` haga `PUT /api/account/integrations/{integrationId}` con
  `{ credential }`, el sistema debe validar `credential` (cadena de 1–4096 caracteres, sin
  caracteres de control ni saltos de línea), guardar `encrypt(credential)`
  (`src/lib/whatsapp/encryption.ts`), `credential_last4`, `is_enabled = true`, `enabled_by`,
  `enabled_at = now()`, poner `last_test_*` a `NULL`, y responder 200 con el estado de R14. Si la
  integración no existe o está inactiva → 404; credencial inválida → 400.
  *Verificación:* `[integrationId]/route.test.ts` (fila escrita con `decrypt(credential) ===
  entrada`, respuesta sin credencial, `\r\n` → 400, 4097 chars → 400, inactiva → 404, segunda
  llamada reemplaza la credencial sin duplicar fila).
- **R16** (A2) Cuando un `agent` o `viewer` intente activar, desactivar o probar, el sistema debe
  responder 403 sin escribir.
  *Verificación:* tests de las rutas de cuenta (403 con `requireRole('admin')`).
- **R17** (A2, D5) Cuando un `admin` haga `DELETE /api/account/integrations/{integrationId}`, el
  sistema debe poner `is_enabled = false`, `credential = NULL`, `credential_last4 = NULL` y
  conservar la fila (para el registro); repetirlo debe responder 200 igual; sin fila → 404.
  *Verificación:* `[integrationId]/route.test.ts`.
- **R18** (A2) Cuando un `admin` haga `POST /api/account/integrations/{integrationId}/test`, el
  sistema debe hacer `GET base_url + test_path` con la credencial de **esa** cuenta por el núcleo
  HTTP de R22–R28, guardar `last_tested_at` y `last_test_status` ∈ `ok` (2xx) | `auth_failed`
  (401/403) | `unreachable` (timeout, red, bloqueo SSRF) | `error` (resto, incluido 3xx y tamaño
  excedido), registrar la llamada con `source = 'test'` y responder 200 `{ result, status }` sin el
  cuerpo de la respuesta remota. Sin activación → 404; `rate_limited` → 429.
  *Verificación:* `[integrationId]/test/route.test.ts` y `src/lib/integrations/execute.test.ts`
  (`fetch` inyectado: 200, 401, 403, 500, 302, timeout, DNS privado → cada estado).
- **R19** (A2) Cuando el usuario abra Ajustes → Integraciones (`?tab=integrations`), el sistema debe
  mostrar una tarjeta por integración de R14 con logo (o inicial), nombre, descripción, operaciones
  y estado (`Activa` / `No activada` / `Requiere plan` / `Retirada`); a quien tenga `canManage`, los
  botones «Activar» (diálogo con un campo de contraseña etiquetado `Token` o con
  `auth_header_name`, y `credential_help`), «Probar conexión», «Cambiar credencial» y «Desactivar»
  (con confirmación); a los demás, solo lectura. La credencial guardada se muestra como
  `••••<last4>`. Tras activar, la UI debe lanzar la prueba sola y mostrar su resultado.
  *Verificación:* `src/components/settings/integrations-settings.test.tsx` (marcado estático por
  estado y por rol); `src/components/settings/integration-card-state.test.ts` (función pura
  estado → acciones visibles y secuencia PUT → POST test).

### Ejecutor y seguridad

- **R20** (A4) El sistema debe descifrar `account_integrations.credential` únicamente dentro de
  `src/lib/integrations/execute.ts`, y no debe incluir la credencial, las cabeceras, los parámetros
  ni los cuerpos de petición o respuesta en ningún `console.*`, fila de `integration_calls` ni
  respuesta HTTP del CRM.
  *Verificación:* `execute.test.ts` (espía de `console.error`/`console.warn` y de la inserción en
  `integration_calls`: la credencial y un parámetro centinela no aparecen en ningún argumento);
  `grep -rn "decrypt(" src/lib/integrations src/app/api/account/integrations` en el informe solo
  muestra `execute.ts`.
- **R21** (A4) Cuando el sistema construya la URL de una llamada, debe concatenar `base_url` y la
  ruta con los marcadores sustituidos por `encodeURIComponent(valor)`, y, si el origen resultante no
  es idéntico al de `base_url` (la allowlist del operador), no debe hacer la petición y debe
  devolver `blocked`.
  *Verificación:* `src/lib/integrations/request.test.ts` (`id = "../admin"` → `%2E%2E%2Fadmin`
  dentro del mismo origen; `id = "@evil.com"` no cambia el host).
- **R22** (A4) Cuando `isDeliverableUrl` (`src/lib/webhooks/ssrf.ts`) devuelva `false` para la URL
  final, el sistema no debe llamar a `fetch` y debe devolver/registrar `blocked`.
  *Verificación:* `src/lib/integrations/http.test.ts` (resolutor inyectado → privado; `fetch` no
  llamado).
- **R23** (A4) El sistema debe hacer cada petición con `redirect: 'manual'`, y cuando la respuesta
  sea 3xx debe tratarla como `http_error` sin seguirla.
  *Verificación:* `http.test.ts` (302 con `Location` interna → `http_error`, un solo `fetch`).
- **R24** (A4) Cuando la petición tarde más de `INTEGRATION_TIMEOUT_MS` (10 000), el sistema debe
  abortarla y devolver `timeout`.
  *Verificación:* `http.test.ts` (`fetch` inyectado que respeta la señal; reloj/`AbortSignal`
  simulado).
- **R25** (A4) Cuando la respuesta declare o acumule más de `INTEGRATION_MAX_RESPONSE_BYTES`
  (262 144), el sistema debe dejar de leer, cancelar el cuerpo y devolver `too_large`.
  *Verificación:* `http.test.ts` (`content-length` grande sin leer; stream de 300 KiB sin
  `content-length` → corte y `reader.cancel` llamado).
- **R26** (A4) Cuando una cuenta supere `RATE_LIMITS.integrationCall` (60/min, clave
  `integrationCall:<accountId>`), el sistema no debe hacer la petición y debe devolver/registrar
  `rate_limited`; el cubo de una cuenta no debe afectar a otra.
  *Verificación:* `http.test.ts` (61.ª llamada de A → `rate_limited`; primera de B → pasa) con
  `__resetRateLimitForTests`.
- **R27** (A3, A4) Cuando se llame a `executeIntegrationOperation(db, { accountId,
  integrationSlug, operationKey, params, source })`, el sistema debe validar `params` contra la
  declaración de la operación (desconocidos, requeridos ausentes, tipo o `enum` inválidos →
  `invalid_params` sin petición; coerción de cadena a `integer`/`number`/`boolean` según
  `design.md` §5), construir la petición (path / query / cuerpo JSON plano), añadir la autenticación
  (`Authorization: Bearer <cred>` o `<auth_header_name>: <cred>`) y devolver
  `{ ok: true, status, data }` (JSON parseado si `content-type` es JSON, texto si no) o
  `{ ok: false, outcome, status }`, **sin lanzar nunca**.
  *Verificación:* `request.test.ts` (cada regla de validación y coerción; forma exacta de la
  petición) y `execute.test.ts` (éxito JSON, éxito texto, 500 → `http_error`, excepción de BD →
  `error` sin lanzar).
- **R28** (A4) Cada vez que el ejecutor o la prueba resuelvan la integración para una cuenta, el
  sistema debe insertar una fila en `integration_calls` con `account_id`, `integration_id`,
  `operation_key` (NULL en pruebas), `source`, `outcome`, `status_code` y `latency_ms`, y nada más;
  un fallo al registrar no debe cambiar el resultado devuelto.
  *Verificación:* `execute.test.ts` (fila exacta por cada `outcome`; inserción que falla → mismo
  resultado + `console.error` sin datos sensibles).
- **R29** (A4) El sistema debe enviar siempre `Accept: application/json` y `User-Agent:
  Cabbity-CRM-Integrations/1`, y `Content-Type: application/json` solo cuando haya cuerpo.
  *Verificación:* `request.test.ts`.
- **R30** (A2, D2) Cuando la integración o la operación estén inactivas, la cuenta no la tenga
  activada, o su plan no incluya `integrations`, el sistema debe devolver `not_enabled` sin
  petición; cuando la integración (por slug) no exista, `not_enabled` sin fila de registro.
  *Verificación:* `execute.test.ts` (los cinco casos).

### Aislamiento, soporte y operación

- **R31** (CP3) El sistema debe filtrar por `account_id` toda consulta de rol de servicio sobre
  `account_integrations` e `integration_calls`; las lecturas del catálogo global (`integrations`,
  `integration_operations`) y el recuento de cuentas activadas de R11 deben figurar como waivers
  con motivo en `tenant-isolation.test.ts`.
  *Verificación:* bloques nuevos en `src/lib/security/tenant-isolation.test.ts`: como actor de A,
  `GET`/`PUT`/`DELETE`/`test` sobre la integración que B tiene activada → no ve ni toca la fila de
  B (B byte a byte igual); `executeIntegrationOperation` para A usa la credencial de A aunque B
  esté sembrada primero con el mismo `integration_id`; auditoría de consultas sin alcance vacía.
- **R32** (A4, D3) — **Sustituido por n13.6** (D3 revertida): en sesión de soporte las escrituras
  bajo `/api/account/integrations` se permiten (`supportWriteVerdict` → `record`) y cada una deja
  su fila en `impersonation_actions` con la acción y el slug (`src/lib/integrations/support-trace.ts`).
  Texto original: mientras haya una sesión de soporte, el sistema debe bloquear `POST`, `PUT`,
  `PATCH` y `DELETE` bajo `/api/account/integrations` (middleware, `supportWriteVerdict`) y las
  rutas deben llamar a `assertNotSupportSession`; el `GET` debe seguir funcionando con la cuenta
  efectiva.
  *Verificación:* `src/lib/auth/support-scope.test.ts` (tres casos `block`, un `GET` `pass`) y
  tests de ruta con `ctx.impersonation` → 403.
- **R33** (A4) El sistema debe incluir `account_integrations.credential` en `ENCRYPTED_COLUMNS`
  (`src/lib/whatsapp/reencrypt.ts`), para que la rotación de `ENCRYPTION_KEY` la reescriba, y
  documentarla en `docs/security.md`.
  *Verificación:* `src/lib/whatsapp/reencrypt.test.ts` (la lista contiene la entrada; una fila con
  `credential` NULL se salta).
- **R34** (CP6) Cada texto nuevo de UI debe existir en `messages/es.json` y `messages/en.json` con la
  misma clave y los mismos placeholders ICU.
  *Verificación:* los `*.test.tsx` de R11 y R19 renderizan con los dos catálogos y comparan el
  conjunto de claves de `Platform.integrations`, `Settings.integrations`,
  `Platform.shell.nav.integrations`, `Settings.sections.integrations` y
  `Platform.plans.features.integrations`.
- **R35** (CP11) El sistema no debe tocar `src/app/api/whatsapp/webhook/route.ts` ni ninguna ruta
  de entrada; nada de esta feature corre en el camino de un mensaje entrante.
  *Verificación:* `git diff --stat` en el informe.

## Guion manual (servicio externo)

No hay API de Health con citas todavía. Para comprobar de punta a punta contra un servicio real:

1. En `/platform/integrations`, crear «Prueba httpbin» con `base_url = https://httpbin.org`,
   `auth_scheme = bearer`, `test_path = /bearer`; activarla.
2. En una cuenta con `integrations` en su plan, Ajustes → Integraciones → Activar con `abc123` →
   la prueba sale `ok`. Cambiar a `test_path = /status/401` → `auth_failed`.
3. `select outcome, status_code, source from integration_calls order by created_at desc limit 2;`
   → dos filas `test`, sin rastro de `abc123`.
4. Abrir una sesión de soporte sobre esa cuenta: la pestaña se ve con el aviso de soporte;
   «Probar» responde 200 y deja una fila en `impersonation_actions` cuyo `path` termina en
   `· integration.test · <slug>` (n13.6; antes de n13.6, 403).

## Fuera de alcance (deuda anotada)

Importar desde OpenAPI; subida de logo (solo URL https); OAuth2 y Basic; campos no secretos por
cuenta (p. ej. id de sucursal) y `base_url` por cuenta; cuerpos anidados; paginación; visor de
`integration_calls` en la UI y purga por antigüedad; lista de planes por integración (D2-B);
traza en la bitácora de plataforma de las ediciones del catálogo (como los planes, s9.3, no la
tienen); defensa contra DNS rebinding (riesgo residual ya documentado en `ssrf.ts`); los puntos de
uso n13.2–n13.4.
