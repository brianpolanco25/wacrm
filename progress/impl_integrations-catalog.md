# impl n13.1 `integrations-catalog`

Estado: **done** (pendiente de reviewer). Rama `feat/integraciones` (worktree
`/mnt/nvme-big/Dev/apps/cabbity/wacrm/.claude/worktrees/integraciones`), desde `main` @ 5f64211.
Nada pusheado; `main` intacto.

## Plan (de specs/integrations-catalog/tasks.md)

T1 migración 091 + verify + checks SQL · T2 validación pura · T3 rutas de plataforma · T4 UI de
plataforma · T5 entitlement `integrations` · T6 núcleo HTTP · T7 petición + ejecutor · T8 rutas de
cuenta · T9 soporte/rotación/docs · T10 Ajustes → Integraciones · T11 aislamiento · T12 compuerta,
CHANGELOG, informe. Todas hechas.

## Commits

| SHA | Mensaje | Tasks |
|---|---|---|
| 2dab443 | feat: catálogo de integraciones — migración 091, validación y rutas de plataforma (incluye el spec) | T1, T2, T3 |
| a70baa4 | feat: ejecutor de integraciones con guardas SSRF y entitlement `integrations` | T5, T6, T7 |
| f3fb5ca | feat: activación de integraciones por cuenta con credencial cifrada | T8, T9 |
| d49fea2 | feat: panel de plataforma para el catálogo de integraciones | T4 |
| 5acee9a | feat: Ajustes → Integraciones para activar y probar integraciones | T10 |
| d87162b | test: aislamiento entre cuentas de las integraciones | T11 |
| ee06411 | docs: CHANGELOG de integraciones y ajuste de las guardas de catálogo | T12 |

Todos con `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Compuerta (ejecutada una vez, al final, en el worktree)

- `npm run lint` → exit 0, `0 errors, 34 warnings`. Las 34 son previas: `main` da las mismas 34;
  `eslint` sobre los 50+ archivos `.ts/.tsx` del diff no da ninguna.
- `npm run typecheck` → exit 0.
- `TZ=UTC npm test` → **336 archivos, 5062 tests, todos verdes** (16,8 s).
- `npm run build` (variables dummy de `docs/harness.md`) → exit 0. Tabla de rutas con
  `ƒ /platform/integrations`, `ƒ /platform/integrations/[id]`, `ƒ /api/platform/integrations{,/[id],/[id]/operations,/[id]/operations/[opId]}`,
  `ƒ /api/account/integrations{,/[integrationId],/[integrationId]/test}`. Confirma que el segmento
  estático `integrations` convive con `/platform/[id]`.
- `scripts/replay-migrations.sh <worktree>` → `ok 091_integrations.sql`, `verify-schema.sql: OK`,
  exit 0 (también la 091 aplicada dos veces sobre la base viva: exit 0, y verify otra vez OK).

Gate dirigido de las rutas tocadas: 29 archivos, 267 tests en verde (lista abajo).

## Criterio ↔ test

| Req | Test (archivo › `it`) |
|---|---|
| R1 | replay + `checks_integrations-catalog.sql` (A, C); bloque `-- 091` en `supabase/ci/verify-schema.sql` |
| R2 | `checks_…sql` (B: SELECT en las 4 tablas como `authenticated` y `anon`, INSERT/UPDATE/DELETE como `authenticated` → `insufficient_privilege`); verify: RLS activa, sin políticas, sin privilegios para `anon`/`authenticated` |
| R3 | `checks_…sql` › `account_integrations_enabled_has_credential` (UPDATE credential = NULL en fila activa → check_violation) |
| R4 | `src/app/api/platform/integrations/route.test.ts` › `401 without a session`, `403 for a company owner…`, `401 / 403 without writing` (y en `[id]`, `operations`, `operations/[opId]`); `tenant-isolation.test.ts` › `(6) the platform routes 403 the owner of A and write nothing` |
| R5 | `src/lib/integrations/catalog-validate.test.ts` › `validateIntegrationInput (R5)` (slug, name, description/credential_help, logo_url, 15 `base_url` inválidas incl. `http://`, `https://10.0.0.1`, `https://localhost`, `https://u:p@x.com`, query; cabeceras prohibidas incl. `Host`; test_path); `route.test.ts` › `201 creates a draft…`, `400 with the field…`, `400 when the host does not resolve…`, `409 on a duplicate slug` |
| R6 | `catalog-validate.test.ts` › `validateIntegrationInput update (R6)`; `[id]/route.test.ts` › `applies a partial edit…`, `400 when trying to change the slug`, `404 for a missing integration` |
| R7 | `catalog-validate.test.ts` › `validateOperationInput (R7, R9)`; `[id]/operations/route.test.ts` (201, 400 `path`, 409 `key`, 404); `[id]/operations/[opId]/route.test.ts` |
| R8 | `catalog-validate.test.ts` › `validateRelativePath (R8)` y `placeholders must match the path params (R8)` (`/a/{id}` ✓, sin param ✗, param de más ✗, `/../x` ✗, `/a?b=1` ✗, `//evil.com/x` ✗) |
| R9 | `catalog-validate.test.ts` › `round-trips the Health "crear cita" example`, `rejects param %o` (12 casos), `a path param must be required`, `GET and DELETE take no body params`, `rejects output %o`, `accepts object and array outputs` |
| R10 | `exports no DELETE (R10)` en `route.test.ts`, `[id]/route.test.ts`, `[id]/operations/[opId]/route.test.ts`; `[id]/route.test.ts` › `retiring leaves the account activations untouched`; R14/R30 con integración inactiva (abajo) |
| R11 | `platform-integrations.test.tsx` › `lists every integration with status, active operations and accounts`; `platform-integration-editor.test.tsx` (4 casos); `integration-form.test.ts` (6 casos, cuerpo exacto de POST/PATCH); `platform-shell.test.tsx` › nav con `/platform/integrations` y `platformSectionFor('/platform/integrations/<uuid>') → integrations`; `route.test.ts` › `lists every integration with active operations and enabled accounts (R11)` |
| R12 | `plan-catalog.test.ts` › `feature keys are exactly the ones the 041 seed documents plus later migrations add`; `checks_…sql` (D) `count = 0` |
| R13 | `[integrationId]/route.test.ts` › `402 without the integrations feature (R13)`, `is allowed without the plan feature`; `[integrationId]/test/route.test.ts` › `402 without the plan feature`; `account/integrations/route.test.ts` › `planAllows false without the feature` |
| R14 | `account/integrations/route.test.ts` › `returns the exact shape…` (forma exacta; ni cifrado ni claro ni `"credential"`), `a draft or retired integration without activation does not appear`, `…comes back as retired`, `canManage is false inside a support session` |
| R15 | `[integrationId]/route.test.ts` › `stores encrypt(credential)…` (`decrypt(row) === entrada`), `a second call replaces…`, `400 for %s` (`\r\n`, control, 4097, vacío, espacios, no-string), `accepts exactly 4096`, `404 for an inactive or unknown integration` |
| R16 | `403 for agent/viewer (R16)` en PUT, DELETE y test |
| R17 | `[integrationId]/route.test.ts` › `clears the credential and keeps the row; repeating answers 200 the same`, `404 without a row for this account` |
| R18 | `[integrationId]/test/route.test.ts` (200 sin cuerpo remoto, `auth_failed`, 404, 429); `execute.test.ts` › `HTTP %i → %s` (200, 204, 401, 403, 500, 302), `timeout → unreachable`, `a private DNS answer → unreachable without a request`, `rate limited → { rateLimited: true }` |
| R19 | `integration-card-state.test.ts` (15: estado × rol → acciones, etiqueta, PUT → POST test, PUT fallido no prueba); `integrations-settings.test.tsx` (4 estados, solo lectura con `canManage: false`, `••••4242`, sin plan, vacío) |
| R20 | `execute.test.ts` › `expectNoSecretsLeaked` (credenciales A/B y parámetro centinela ausentes de `console.*` y de `integration_calls`) en éxito, 500, invalid_params, excepción de BD y fallo de registro; grep abajo |
| R21 | `request.test.ts` › `encodes "../admin" inside the same origin and prefix` (`%2E%2E%2Fadmin`), `"@evil.com" does not change the host`, `a value that would be normalized as a dot segment is blocked` |
| R22 | `http.test.ts` › `R22: a private resolution is blocked without calling fetch` |
| R23 | `http.test.ts` › `R23: a 302 to an internal host is an http_error, never followed` (un `fetch`, `redirect: 'manual'`) |
| R24 | `http.test.ts` › `R24: aborts after INTEGRATION_TIMEOUT_MS and reports timeout` (relojes simulados) |
| R25 | `http.test.ts` › `R25: a large content-length is refused without reading the body`, `R25: a stream past 256 KiB … is cut and cancelled` (`cancel` llamado) |
| R26 | `http.test.ts` › `R26: the 61st call of an account … another account is not` |
| R27 | `request.test.ts` › `validateCallParams (R27)` (coerción y cada `problem`), `builds path, ordered query, flat JSON body and fixed headers`; `execute.test.ts` › éxito JSON, texto, cabecera propia, 500, `a database exception becomes error and never throws` |
| R28 | `execute.test.ts` › fila exacta en `success…`, `records a row per outcome with the right shape`, `a failed log insert keeps the result and logs only the code` |
| R29 | `request.test.ts` › cabeceras exactas con y sin cuerpo |
| R30 | `execute.test.ts` › `not_enabled (R30), without a request` (retirada, sin activar, operación retirada/inexistente, sin plan, slug inexistente sin fila de registro) |
| R31 | `tenant-isolation.test.ts` › `integrations (n13.1, service role)` casos (1)–(6) + edición del operador; auditoría de consultas sin alcance vacía (afterEach) |
| R32 | `support-scope.test.ts` (PUT/DELETE/POST test → `block`, GET → `pass`); `middleware.test.ts` (PUT y POST test → 403 en sesión de soporte); `403 inside a support session` en las tres rutas de cuenta |
| R33 | `reencrypt.test.ts` › `covers every encrypted column…` (incluye `account_integrations.credential`), `rotates an integration credential and skips a deactivated (NULL) one`; `docs/security.md` |
| R34 | `platform-integrations.test.tsx` › `es and en have the same keys and placeholders (R34)` (`Platform.integrations`, `Platform.shell.nav.integrations`, `Platform.plans.features.integrations`); `integrations-settings.test.tsx` › idem (`Settings.integrations`, `Settings.sections.integrations`); render en es y en sin claves crudas |
| R35 | diff abajo |

### T11 — prueba de mutación (anotada y revertida)

- Quitar `.eq('account_id', accountId)` de la lectura de activaciones de `loadAccountIntegrations`
  (`src/lib/integrations/account.ts`) → **rojo**: `(1) GET as A…` y `(2) PUT as A…`.
- Quitarlo del `update` de `disableAccountIntegration` → **rojo**: `(3) DELETE as A…`.
- Quitarlo de `loadActivation` en `execute.ts` → **rojo**: `(4) POST test…` y `(5) executeIntegrationOperation…`.
- Revertido: `git diff` vacío en esos archivos y el bloque vuelve a 7/7 verde.

## Verificación contra base real (`progress/checks_integrations-catalog.sql`)

`KEEP=1 scripts/replay-migrations.sh <worktree>` + `docker exec -i <c> psql … -v ON_ERROR_STOP=1 < checks…sql`,
exit 0, todo en una transacción con ROLLBACK:

```
PASS integrations_slug_format / integrations_base_url_https / integrations_auth_scheme
PASS integrations_header_name / integrations_test_path
PASS integration_operations_key_format / _method / _path / _params_array / _outputs_array
PASS account_integrations_enabled_has_credential / account_integrations_test_status
PASS integration_calls_source / integration_calls_outcome
PASS desactivar y reactivar respetan el CHECK
PASS select {integrations, integration_operations, account_integrations, integration_calls} (authenticated denied) y (anon denied)
PASS insert integrations / update account_integrations / delete integration_calls / update integration_operations (authenticated denied)
PASS DELETE integrations con activación → foreign_key_violation
PASS ningún plan trae integrations (count = 0)
```

Nota: `plans.features` es `text[]`, no `jsonb`; el `features ? 'integrations'` del design no aplica
y el check usa `'integrations' = ANY (features)`.

## R20 — `grep -rn "decrypt(" src/lib/integrations src/app/api/account/integrations`

Fuera de tests, solo `execute.ts`:

```
src/lib/integrations/execute.ts:246:      decrypt(activation.credential)
src/lib/integrations/execute.ts:326:        decrypt(activation.credential)
```

(Más dos usos en archivos `*.test.ts`, que comprueban que lo guardado descifra a la entrada.)

## R35 / CP5 / CP8 — `git diff --stat main..HEAD`

64 archivos, +10 231 / −14. Ninguno de `src/app/api/whatsapp/webhook/route.ts`, `src/lib/flows/`,
`src/lib/automations/`, `src/lib/ai/`, `package.json` (comprobado con `git diff --name-only`). Sin
dependencias nuevas. Fuera de la lista de archivos del design se tocaron, por necesidad de la compuerta:
`src/i18n/messages.test.ts`, `src/lib/billing/unlimited-plan.test.ts`,
`src/lib/billing/managed-plan.test.ts`, `src/middleware.test.ts` (ver decisiones).

## Verificación en navegador

No hecha (no hay Supabase local con datos para levantar `npm run dev` con sesión de operador). La UI
queda cubierta con marcado estático (`renderToStaticMarkup`) y funciones puras; sin capturas.
Aserciones de UI que sí corren: `data-status` por tarjeta, `data-action` por estado y rol, `••••4242`,
`id="int-slug"` con `disabled` en edición, filas `data-param-row`/`data-output-row`, enlace a `/billing`
sin plan. `aria-busy` está puesto en «Probar conexión», «Guardar y probar» y «Desactivar» mientras hay
petición en curso, pero no se comprobó en navegador.

## Guion manual (pendiente de humano, servicio externo)

1. En `/platform/integrations`, crear «Prueba httpbin»: `base_url = https://httpbin.org`,
   `auth_scheme = bearer`, `test_path = /bearer`; abrirla y marcar «Visible para los clientes».
2. En `/platform/plans`, marcar «Integraciones con otras apps» en el plan de una cuenta de prueba
   (ningún plan la trae de serie).
3. En esa cuenta, Ajustes → Integraciones → Activar con `abc123` → la prueba se lanza sola y sale
   «Conexión correcta.». Cambiar en el panel `test_path = /status/401` → «Probar conexión» →
   «La app rechazó la credencial.».
4. `select outcome, status_code, source from integration_calls order by created_at desc limit 2;` →
   dos filas `test` (`ok` 200, `http_error` 401), sin rastro de `abc123` en ninguna tabla salvo el
   cifrado de `account_integrations.credential`.
5. Abrir una sesión de soporte sobre esa cuenta: la pestaña se ve en solo lectura; un `PUT`/`POST
   …/test` a mano responde 403 (`support_session_forbidden`).

## Decisiones donde el spec era ambiguo o chocaba con el repo

1. **Plan ilimitado (074) y gestionado (077).** Sus guardas exigían que la semilla tuviera *toda*
   feature del inventario; con D2 (`integrations` apagada en todos los planes) fallaban. Ahora excluyen
   las features que una migración posterior declara con el marcador `Claves de \`features\` añadidas`.
   Consecuencia: el plan **ilimitado** de los operadores tampoco trae `integrations`; si se quiere, se
   marca en `/platform/plans`. **El líder/humano debería confirmarlo.**
2. **Textos con «Cabbity».** `src/i18n/brand.test.ts` exige que toda mención a «Cabbity» diga
   «Cabbity CRM». Por eso `Platform.plans.features.integrations` quedó «Integraciones con otras apps» /
   «Integrations with other apps» (el design pedía «…con apps Cabbity»), y el subtítulo del panel y la
   descripción de Ajustes no nombran la marca.
3. **Etiquetas idénticas es/en.** `Settings.integrations.credentialLabelBearer` («Token») y
   `credentialLabelHeader` («{header}») añadidas a `IDENTICAL_TO_SOURCE_OK` con motivo.
   `params.in_query` en es: «Consulta (query)».
4. **Defensa de ruta más allá del origen (R21).** Además de exigir el mismo origen, el ejecutor exige
   que el parser de URL no normalice la ruta montada (el WHATWG trata `%2E%2E` como `..`) y que se
   quede bajo el prefijo de `base_url`; si no, `blocked`. Los valores de marcador codifican también `.`
   (`../admin` → `%2E%2E%2Fadmin`, como pide el spec). Las plantillas rechazan además `%`.
5. **`credential_last4`.** Solo se guarda si la credencial tiene ≥ 12 caracteres; con menos, NULL y la
   UI muestra `••••` (enseñar 4 de una credencial de 6 la entregaría casi entera). Se rechazan también
   espacios al principio o al final (error de pegado), además de control y saltos de línea.
6. **Prueba sobre integración retirada.** `testIntegrationConnection` devuelve null (404) si la
   integración está inactiva; la tarjeta «Retirada» solo ofrece «Desactivar».
7. **Estado de tarjeta.** Prioridad Retirada > Requiere plan > Activa / No activada. Sin plan, una
   integración ya activada muestra «Requiere plan» y solo «Desactivar».
8. **429 de la prueba.** `testIntegrationConnection` no expone el `reset` del cubo; la ruta responde 429
   con `Retry-After: 60` (la ventana del cubo). La llamada limitada sí queda registrada (`rate_limited`).
9. **Plazo de 10 s.** Se implementa con `AbortController` + `setTimeout` (no `AbortSignal.timeout`) para
   que cubra también la lectura del cuerpo y lo controlen los relojes simulados.
10. **Operaciones: PATCH completo desde la UI.** El editor manda la operación entera en cada guardado;
    la API sigue aceptando PATCH parcial y combina con lo guardado (R7–R9).
11. **`key` editable.** Una operación puede cambiar de `key` (409 si choca). n13.2 debería referirse a
    la operación por id o asumir que el operador no renombra claves en uso.
12. Las cuatro tablas añadidas vacías al `seed()` de `tenant-isolation.test.ts`, sembradas por el bloque
    nuevo; `base_url` de la semilla es un literal TEST-NET-3 (`203.0.113.10`) para que
    `isDeliverableUrl` pase sin DNS, con `fetch` simulado.

## Decisiones D1–D6 tal como quedaron

D1 declarativo (integración + operaciones como filas, un ejecutor). D2 feature booleana `integrations`,
ninguna migración la da a ningún plan (incluidos ilimitado y gestionado). D3 sesión de soporte
bloqueada para escribir (middleware + `assertNotSupportSession`); GET abierto con `canManage: false`.
D4 punto de uso fuera (n13.2–n13.4); `executeIntegrationOperation` no tiene llamador de producción
todavía. D5 desactivar pone `credential = NULL` y `credential_last4 = NULL`, conserva la fila.
D6 10 s, 256 KiB, 60/min por cuenta (`RATE_LIMITS.integrationCall`).

## Variables de entorno

Ninguna nueva. `docs/docker.md` y `.env.local.example` sin cambios.

## Deuda detectada (fuera de alcance, no arreglada)

- CSP: el logo de la integración se pinta con `<img src=logo_url>` (https del operador); si la CSP pasa
  de Report-Only a enforce, `img-src` tendrá que admitir esos orígenes o servirse por proxy.
- `npx prettier --check src/components/settings` marca 17 archivos previos sin formatear (no tocados).
- `src/lib/whatsapp/send-message.test.ts:189` tiene un warning de lint previo (`_args` sin usar).
- Rate limit por proceso (como todo `rate-limit.ts`) y DNS rebinding: riesgos residuales ya documentados.
- `integration_calls` crece sin purga ni visor (deuda del spec).
- `src/middleware.ts` sigue con ese nombre aunque Next 16 lo marca obsoleto en favor de `proxy.ts`.

## Ronda 2 (revisión `progress/review_integrations-catalog.md`)

Commits sobre `ee06411`, misma rama y worktree:

| SHA | Hallazgo | Cambio |
|---|---|---|
| 7093949 | 1 (SSRF, autorizado por el líder en el helper compartido) | `isPrivateOrReservedIp` (`src/lib/webhooks/ssrf.ts`) expande la IPv6 a sus 8 grupos y comprueba el IPv4 incrustado en IPv4-mapped (hex `::ffff:7f00:1` y con puntos), IPv4-compatible (`::7f00:1`, `::127.0.0.1`) y NAT64 `64:ff9b::/96`; `64:ff9b:1::/48` (NAT64 local) cuenta como privado; una IPv6 que no se puede leer cuenta como reservada. `http.ts` rechaza con `isForbiddenHost` el literal privado/nombre interno ANTES del resolutor (también si se inyecta uno), sin `fetch`. Arregla también los webhooks de cliente (CHANGELOG, sección de seguridad). |
| 02093ff | 2 (R5) | `validateIntegrationInput(…, 'create')` rechaza `is_active: true` (400 `field: is_active`) y no copia `is_active`; `createIntegration` inserta siempre `is_active: false`; el formulario de alta ya no manda `is_active` ni pinta el interruptor (solo en edición). |
| 4ec171d | 3 | `buildIntegrationRequest` lee los valores con `hasOwnProperty` (`ownValue`): un opcional `constructor`/`toString`/`valueOf` omitido ya no sale como función heredada en query ni fuerza cuerpo. |
| 42c3f47 | 5 | `validateCredential` solo admite ASCII imprimible (`/[^\x20-\x7e]/` → 400): comillas tipográficas, letras con tilde o NBSP dan 400 al guardar, no `unreachable` al probar. |
| c91a215 | 4 | `PATCH /api/platform/integrations/[id]`: si cambia el **origen** de `base_url`, `auth_scheme` o `auth_header_name` (sin distinguir mayúsculas) y hay cuentas con la integración activada → 409 `{ code: 'integration_in_use', field, accountsEnabled }` sin tocar nada. Con `reset_activations: true` desactiva en todas las cuentas (credencial, last4 y última prueba a NULL) y luego guarda. Cambiar solo el prefijo de ruta en el mismo origen no lo pide. El editor muestra un diálogo de confirmación (`Platform.integrations.errors.inUseTitle/inUse/inUseConfirm`, es/en, ICU plural) y reenvía con `reset_activations`. `docs/security.md` y CHANGELOG actualizados; el CHANGELOG ya llama a la feature «Integrations with other apps» (nota menor de CP9). |

**Decisión a confirmar por el humano (hallazgo 4):** implementé «confirmar y desactivar en todas»
(opción intermedia del reviewer). Alternativas: bloquear del todo el cambio con activaciones, o
permitirlo sin reset. `credentialDestinationChange`, `countEnabledActivations` y
`resetActivations` viven en `src/lib/platform/integrations.ts` (un `route.ts` de Next no puede
exportar helpers).

### Tests nuevos

- `src/lib/webhooks/ssrf.test.ts` › `flags IPv4-mapped in hex, IPv4-compatible and NAT64 forms of private IPv4` (14 formas), `allows the same forms when the embedded IPv4 is public`, y en `isDeliverableUrl` › `https://[::ffff:127.0.0.1]`, `https://[::ffff:169.254.169.254]`, `[::127.0.0.1]`, `[64:ff9b::a9fe:a9fe]` → false.
- `src/lib/integrations/catalog-validate.test.ts` › 5 `base_url` nuevas rechazadas (`[::ffff:127.0.0.1]`, `[::ffff:169.254.169.254]`, `[::ffff:7f00:1]`, `[::127.0.0.1]`, `[64:ff9b::a9fe:a9fe]`); `isForbiddenHost` › forma hex; `a create cannot be born active (R5)…`.
- `src/lib/integrations/http.test.ts` › `R22: the literal %s is blocked before fetch, even if the resolver says yes` (6 URLs, incl. las dos pedidas) y `R22: the real resolver refuses IPv4-mapped loopback too`.
- `src/app/api/platform/integrations/route.test.ts` › `R5: a POST asking for is_active: true is refused and creates nothing`, `R5: the row is stored inactive even with is_active: false in the body`.
- `src/components/platform/integration-form.test.ts` › el cuerpo de alta ya no lleva `is_active`.
- `src/lib/integrations/request.test.ts` › `parameters named like Object.prototype members` (3 casos; 2 fallan con el código anterior, comprobado).
- `src/app/api/account/integrations/[integrationId]/route.test.ts` › `400 for typographic quotes…`, `…a non-ASCII letter`, `…a non-breaking space`.
- `src/app/api/platform/integrations/[id]/route.test.ts` › `changing where the credential goes (review finding 4)` (5 casos: 409 por origen, 409 por esquema y cabecera, prefijo sin confirmación, reset desactiva todo y deja intacta otra integración, sin activaciones libre).
- `src/lib/security/tenant-isolation.test.ts` › `an operator moving the origin needs confirmation, then wipes every credential`, con dos waivers nuevos (recuento head y update de reset por `integration_id` + `is_enabled`, con motivo).

### Compuerta ronda 2

- Gate dirigido de cada hallazgo en verde (vitest de los archivos tocados).
- `npm run lint` → exit 0, 0 errores, 34 warnings (las mismas previas; ninguna en archivos del diff).
- `npm run typecheck` → exit 0.
- `TZ=UTC npm test` (una vez, al final) → **336 archivos, 5092 tests, todos verdes**.
- Build no corrido (instrucción del líder). Sin SQL nuevo: replay no repetido.

### Hallazgos no abordados (no bloqueantes, quedan como deuda)

6 (recuento `accountsEnabled` sujeto a `max_rows`), 7 (2xx con JSON inválido → `http_error`),
8 (cubo propio por usuario para «Probar»), 9 (DNS rebinding). Hallazgo/decisión 11 (`key`
editable) a anotar en el spec de n13.2.
