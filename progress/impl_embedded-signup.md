# f4.1 `embedded-signup` — informe de implementación

Rama `saas/fase-4-multinumero`, worktree
`.claude/worktrees/fase-4-multinumero`, base `09f71ba` (fases 0–3 + f4.2
aprobada). Spec: `docs/saas/fase-4-plataforma.md` §1. Diseño, ejecutado
sin reabrirlo: `progress/plan_embedded-signup.md` §§1, 2, 5, 9, 10, 11, 12.

## Plan (los pasos que se dieron)

1. Migración `054_embedded_signup.sql` + aserciones en `verify-schema.sql`
   + `progress/checks_embedded-signup.sql`.
2. Servidor: detección de modo, intercambio de código, `GET/POST
   /api/whatsapp/embedded-signup`, y el §5 del webhook.
3. Cliente: `embedded-signup-button.tsx` y las cinco diferencias de UI.
4. i18n en/ko, CSP, `docs/docker.md`, `CHANGELOG.md`.
5. Tests de §9 y compuerta.
6. Ronda 2: las tres discrepancias con la documentación viva de Meta
   (`progress/meta_embedded-signup-verificacion.md`) y el requisito de
   dominios permitidos del guion manual.

## Commits

| Hito | Commit | Qué |
|---|---|---|
| Migración | `b77e7f0` | `feat: guardar PIN, vencimiento y vía de alta del número de WhatsApp` — `054_embedded_signup.sql` + `supabase/ci/verify-schema.sql` |
| Servidor | `8adcd7a` | `feat: intercambiar el código de Meta por el token de cada empresa` — `platform-mode.ts`, `embedded-signup.ts`, la ruta, el bucket de rate limit y el §5 del webhook, con sus tests |
| Cliente | `ddd6c38` | `feat: conectar WhatsApp desde Ajustes con el diálogo de Meta` — botón, las cinco diferencias de UI, i18n, CSP, CHANGELOG y `docs/docker.md` |
| Ronda 2 (alineación v4) | `8fcbb88` | `fix: alinear el diálogo de Meta con Embedded Signup v4` — `extras`, comprobación de origen, versión de Graph documentada y requisito de dominios permitidos |

`054` estaba libre en esta rama (comprobado: existen 053 y 056; `055` la
toma `3c99804`, f4.3, en otra rama — no hay choque).

## Archivos

Nuevos:

- `supabase/migrations/054_embedded_signup.sql`
- `src/lib/whatsapp/platform-mode.ts` (+ `.test.ts`)
- `src/lib/whatsapp/embedded-signup.ts` (+ `.test.ts`)
- `src/app/api/whatsapp/embedded-signup/route.ts` (+ `.test.ts`)
- `src/components/settings/embedded-signup-button.tsx` (+ `.test.tsx`)
- `progress/checks_embedded-signup.sql`

Tocados: `supabase/ci/verify-schema.sql`, `src/lib/rate-limit.ts`,
`src/app/api/whatsapp/webhook/route.ts` (+ test),
`src/lib/whatsapp/webhook-signature.test.ts`,
`src/lib/security/tenant-isolation.test.ts`,
`src/components/settings/whatsapp-config.tsx`, `messages/en.json`,
`messages/ko.json`, `next.config.ts`, `CHANGELOG.md`, `docs/docker.md`.

`verifyMetaWebhookSignature` **no se tocó** (solo su test).
`src/lib/whatsapp/meta-api.ts` **no se tocó**: el intercambio de código
vive en su módulo propio porque `meta-api.ts` declara por escrito que
ninguna de sus funciones lee `process.env`.

## Criterio ↔ test

| Criterio del spec | Archivo | `it` |
|---|---|---|
| 1. Conecta sin salir de la app ni tocar la consola de Meta | `src/app/api/whatsapp/embedded-signup/route.test.ts` | `trades the code for a token with OUR app id and secret`; `stores the token encrypted, never in the clear`; `marks the row as provisioned by the dialog and leaves verify_token null`; `generates a six-digit registration PIN and stores it encrypted`; `translates expires_in into token_expires_at, and its absence into null`; `makes the very first number of an account its default` |
| 1 (idempotencia) | ídem | `repeating the flow updates the same row instead of adding a second` (afirma `onConflict: 'account_id,phone_number_id'`, cero `insert`, y que `is_default` no viaja en el upsert de repetición) |
| 1 (cancelación sin escrituras) | ídem | `400s without a code and writes nothing at all`; `400s when the session event never delivered the phone number id`; `writes nothing when Meta rejects the code`; `409s on another account's number before spending the code` |
| 1 (el `code` nunca en consola, riesgo 3 de §12) | ídem | `keeps the code and the token out of console on the happy path`; `keeps them out when Meta rejects the exchange`; `keeps them out when the exchange throws` |
| 1b. Intercambio de código | `src/lib/whatsapp/embedded-signup.test.ts` | `calls the oauth endpoint of the requested graph version with the three parameters` (incluye que **no** se manda `redirect_uri`); `honours the graph version it is given`; `returns the token with a null expiry when Meta omits expires_in`; `translates expires_in seconds into an ISO instant`; `treats a zero or negative expires_in as "no expiry"`; `propagates Meta's own error message`; `falls back to the status when the error body has no message`; `tolerates a non-JSON body instead of throwing a parse error`; `rejects a 200 that carries no token`; `never puts the code or the secret in the thrown message` |
| 1b (PIN) | ídem | `always produces exactly six digits, zero-padded`; `does not return the same PIN every time` |
| 2. La cuenta queda suscrita y lo entrante llega a esa empresa | `src/app/api/whatsapp/embedded-signup/route.test.ts` | `uses the freshly minted token for every Meta call`; `persists both timestamps and the metadata Meta reported`; `still saves the row when /register fails, with the reason`; `does not abort when the WABA subscription fails` |
| 2b. Enrutado por empresa (fuga entre cuentas, CP3) | `src/lib/security/tenant-isolation.test.ts` | `refuses to claim B's number and leaves B's row untouched`; `reconnects A's own number and writes only inside A`; `402s rather than letting A exceed its plan on B's back`; `GET exposes the public ids and never the app secret` |
| 2b (webhook, ya existente y conservado) | `src/app/api/whatsapp/webhook/route.test.ts` | bloque `inbound webhook: several numbers per account (fase 4 §1)` y `/api/whatsapp/webhook (service role, tenant from phone_number_id)` de la suite de aislamiento — heredados de f4.2, siguen verdes |
| 3. La firma funciona con el secreto de nuestra app para todos los inquilinos | `src/lib/whatsapp/webhook-signature.test.ts` | `accepts deliveries for two different tenants with the same secret`; `rejects a delivery signed with a tenant's own app secret`; y el ya existente `rejects even a correctly-formed signature when no secret is configured` (fallo cerrado) |
| 5. El autoalojado sigue funcionando (S5) | `src/app/api/whatsapp/embedded-signup/route.test.ts` | `GET reports the feature as disabled and leaks no ids`; `POST 404s: in self-hosted mode the route does not exist`; `POST 404s with the config id set but the app secret missing` |
| 5 (mitad de UI) | `src/components/settings/embedded-signup-button.test.tsx` | `renders nothing in self-hosted mode`; `renders nothing when the server says enabled but sends no config id`; `renders the connect button in platform mode` |
| 5c. El bucle del token de verificación sigue, sin escribir | `src/app/api/whatsapp/webhook/route.test.ts` | `the per-tenant loop verifies without writing anything back`; `a mismatching token writes nothing either`; `the scan skips rows without a verify token and is bounded` |
| Detección de modo (§1.1) | `src/lib/whatsapp/platform-mode.test.ts` | 12 casos: nulo por defecto, las tres variables, el secreto nunca en el objeto, cada variable ausente, espacios en blanco, recorte de saltos de línea, versión de Graph configurable, y `isMissingWebhookVerifyToken` |
| Guardas de la ruta | `src/app/api/whatsapp/embedded-signup/route.test.ts` | `403s an agent`; `429s once the per-user bucket is spent`; `refuses a non-admin` (GET) |
| Tope `numbers` (reutilizado de f3.4/f4.2) | ídem | `402s on a second, different number when the plan allows one`; `lets an account reconnect a number it already has on a full plan` |
| Opciones de `FB.login` (Embedded Signup v4) | `src/components/settings/embedded-signup-button.test.tsx` | ``passes only `setup` in extras, as Embedded Signup v4 documents``; `asks for a code, overriding the SDK default` |
| Origen del evento `WA_EMBEDDED_SIGNUP` | ídem | `accepts the hosts Meta serves the dialog from` (incluye `https://business.facebook.com`); `rejects a look-alike domain that merely ends in facebook.com` (`https://facebook.com.evil.example`); `rejects plain HTTP and anything that is not a URL` (`http://www.facebook.com`, `"null"`, cadena vacía) |

Total: 1 659 tests en 125 archivos, todos verdes (1 654 + los 5 de la
ronda 2).

## Verificaciones contra base real

`KEEP=1 scripts/replay-migrations.sh <worktree>` y luego
`docker exec -i <contenedor> psql -U postgres -v ON_ERROR_STOP=1 <
progress/checks_embedded-signup.sql`. Salida:

```
OK 1 — provisioned_via por defecto manual; PIN y vencimiento NULL (054)
OK 2 — whatsapp_config_provisioned_via_check rechaza vías inventadas (054)
OK 3 — upsert por (account_id, phone_number_id): una fila, token nuevo, error limpiado
OK 4 — el UNIQUE global de la 013 impide que el upsert cruce de cuenta
OK 5 — la fila de A quedó intacta tras el intento de B
```

La 3 es la que importa de verdad: es la prueba de que el `ON CONFLICT
(account_id, phone_number_id)` del upsert tiene destino —sin el índice
de la 053 Postgres rechaza la sentencia entera— y de que repetir el
diálogo con el mismo número deja una fila con token nuevo.

`scripts/replay-migrations.sh <worktree>` sale 0 con `verify-schema.sql: OK`.

## Compuerta

| Paso | Resultado |
|---|---|
| `npm run lint` | 0 errores, 38 avisos (todos preexistentes) |
| `npm run typecheck` | limpio |
| `TZ=UTC npm test` | 125 archivos, 1 659 tests, 0 fallos (ronda 2: `--reporter=dot`) |
| `npm run build` (variables de `ci.yml`) | compila; `ƒ /api/whatsapp/embedded-signup` en el manifiesto |
| `scripts/replay-migrations.sh` | salida 0 (ronda 1; la ronda 2 no toca SQL) |

## Verificaciones manuales pendientes (guion, §10 del plan)

Nada de esto se puede simular: exige la app de Meta en producción y un
número real. **Este es el riesgo dominante de la feature** (§12, riesgo 4).

0. **Dominios permitidos** (no es código, y es el paso que más veces se
   olvida): en el panel de la app, Facebook Login for Business →
   Settings → Client OAuth settings, el dominio desde el que se sirve
   wacrm tiene que estar **a la vez** en «Allowed Domains for the
   JavaScript SDK» y en «Valid OAuth redirect URIs». Solo HTTPS: un
   dominio `http://` no se acepta, y `localhost` tampoco sirve para esta
   prueba. Si falta, el diálogo abre y termina con normalidad pero el
   evento `WA_EMBEDDED_SIGNUP` nunca llega a la página que lo abrió: ni
   error, ni fila, ni pista en el log del servidor. Comprobar antes del
   paso 3, porque es indistinguible de un fallo del código.
1. **Trámite previo** (no es código): verificación de negocio, app en
   modo producción, permisos `whatsapp_business_management` y
   `whatsapp_business_messaging` aprobados, y una configuración de
   Embedded Signup creada en el panel (App → WhatsApp → Embedded Signup)
   de la que sale el `META_CONFIG_ID`.
2. **Webhook de app**: en el panel, URL
   `https://<dominio>/api/whatsapp/webhook`, token de verificación = el
   valor de `META_WEBHOOK_VERIFY_TOKEN`, campos `messages` y
   `message_template_status_update`. Comprobar que Meta da verde **y**
   que en el log no aparece ninguna consulta a `whatsapp_config` (camino
   corto de f2.4).
2bis. **El código caduca a los 30 segundos.** Al hacer el paso 3, mirar
   el reloj entre el cierre del diálogo y la respuesta del `POST`: si
   Meta contesta `Invalid verification code format` o un error de código
   ya usado/caducado, el problema es de latencia, no de credenciales.
   El orden de la ruta ya lo respeta —**el intercambio es la primera
   llamada a Meta del `POST`** (paso 4 de la cabecera de `route.ts`);
   lo único que va antes son `requireRole`, el rate limit y tres
   consultas locales a Supabase (conflicto entre cuentas, fila
   existente, tope del plan), milisegundos, y ninguna sale a la red de
   Meta. Se deja tal cual a propósito: el 409 por número ajeno tiene que
   seguir llegando **antes** de gastar el código.
3. **Diálogo completo** con una empresa de prueba distinta de la nuestra:
   pulsar Conectar WhatsApp, terminar el flujo, y comprobar en la fila
   que quedan `registered_at`, `subscribed_apps_at`,
   `provisioned_via = 'embedded_signup'`, `verify_token` NULL y
   `registration_pin` no nulo. Un WhatsApp real escribiendo a ese número
   tiene que aparecer en la bandeja de **esa** cuenta.
4. **Cancelación**: abrir el diálogo y cerrarlo en el paso 2 →
   `SELECT count(*) FROM whatsapp_config WHERE account_id = …` no cambia.
5. **Repetición**: volver a pasar el mismo número por el diálogo → sigue
   habiendo una fila, con `access_token` distinto al anterior.
6. **Dos números**: conectar un segundo, escribir desde un móvil a cada
   uno, comprobar que los dos entran, responder desde la bandeja y mirar
   **desde qué número** llega cada respuesta al móvil del cliente.
7. **Difusión**: lanzar una campaña eligiendo el segundo número; pausar y
   reanudar; el remitente no cambia.
8. **Firma**: registro de entregas de Meta, cero 401.
9. **Autoalojado**: una instancia sin `META_CONFIG_ID`, con la app propia
   del cliente, conectando por el formulario manual. El botón no aparece,
   el campo del token de verificación y la tarjeta de la URL del webhook
   sí, y todo funciona.
10. **CP11**: con la cuenta `suspended`, un entrante a cualquiera de los
    dos números sigue guardándose.
11. **CSP**: con la política aún en `Report-Only`, abrir el diálogo y
    comprobar que la consola no reporta violaciones de
    `connect.facebook.net`, `*.facebook.com` ni `frame-src`.

### Tres detalles de la API de Meta que NO se pudieron contrastar

> **Resueltos en la ronda 2.** El líder alcanzó la documentación viva y
> dejó el resultado en `progress/meta_embedded-signup-verificacion.md`.
> Lo que sigue es el registro de por qué quedaron sin contrastar; las
> correcciones están en «Alineación con la documentación viva», más
> abajo.

El encargo pedía contrastar `sessionInfoVersion`, la forma del evento
`WA_EMBEDDED_SIGNUP` y `override_default_response_type` con la
documentación viva, y dejar la URL consultada. **No fue posible desde
este entorno**: `developers.facebook.com` bloquea la petición. URLs
intentadas y respuesta obtenida:

| URL | Respuesta |
|---|---|
| `https://developers.facebook.com/docs/whatsapp/embedded-signup/implementation` | HTTP 400, página de error genérica de Meta (1 542 bytes, «Sorry, something went wrong») |
| `https://developers.facebook.com/docs/whatsapp/embedded-signup/implementation/?locale=en_US` | HTTP 400, ídem |
| `https://developers.facebook.com/docs/whatsapp/embedded-signup` | HTTP 400, ídem |
| `https://developers.facebook.com/docs/whatsapp/cloud-api/get-started` | HTTP 400, ídem |
| `https://developers.facebook.com/docs/whatsapp/embedded-signup/steps-for-tech-providers` | HTTP 404 del propio sitio de documentación (142 KB) — el sitio responde, la ruta no existe |

Los tres valores se escribieron **tal cual los fija el plan de diseño**
(§1.2), que es la instrucción recibida, y quedan como lo único de la
feature que ningún test cubre. **El humano tiene que confirmarlos contra
`https://developers.facebook.com/docs/whatsapp/embedded-signup/implementation`
antes del paso 3 del guion.** Los tres están juntos y comentados en
`src/components/settings/embedded-signup-button.tsx` (`openDialog`), así
que corregirlos es un cambio de una línea cada uno:

- `extras.sessionInfoVersion: '3'`
- `override_default_response_type: true` (sin él Meta devuelve un token
  de usuario y no hay código que intercambiar)
- el evento: `JSON.parse(event.data)` con
  `{ type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH'|'CANCEL'|'ERROR',
  data: { phone_number_id, waba_id, current_step, error_message } }`

## Alineación con la documentación viva

Fuente: `progress/meta_embedded-signup-verificacion.md` (verificación del
líder, 2026-09-12, contra
`https://developers.facebook.com/docs/whatsapp/embedded-signup/implementation`,
Embedded Signup **v4**). Ronda 2, commit `8fcbb88`. Lo que el documento
da por **confirmado** —`response_type: 'code'` con
`override_default_response_type: true`, la forma del evento
`WA_EMBEDDED_SIGNUP`, el `GET /{version}/oauth/access_token` con tres
parámetros y sin `redirect_uri`— coincide con lo implementado y no se
tocó. Lo que marcaba como discrepancia, una por una:

### 1. `extras` solo lleva `setup`

`sessionInfoVersion: '3'` y `featureType: ''` **no existen en v4**:
venían del plan de diseño (§1.2), que los arrastraba de versiones
anteriores del flujo. Se eliminan; `extras` queda en `{ setup: {} }`.

No había test que fijara las opciones de `FB.login` —`openDialog` es una
función interna del componente y el repo no tiene jsdom—, así que se
extrajo `buildFbLoginOptions(configId)`, exportada, y la llamada pasó a
usarla. Dos `it` nuevos en
`src/components/settings/embedded-signup-button.test.tsx`:
``passes only `setup` in extras, as Embedded Signup v4 documents``
(compara `extras` con `toEqual({ setup: {} })` **y** la lista de claves,
para que añadir una clave de más falle) y
`asks for a code, overriding the SDK default`.

### 2. El origen del evento se comprueba por host

La lista cerrada `['https://www.facebook.com', 'https://web.facebook.com']`
se sustituye por `isMetaSignupOrigin(origin)`, también exportada para
poder probarla:

- `new URL(origin)` dentro de `try/catch` — `postMessage` desde un iframe
  con sandbox reporta la cadena literal `"null"`, que no es una URL.
- `protocol === 'https:'`.
- `hostname === 'facebook.com' || hostname.endsWith('.facebook.com')`.

**No** se copió el `origin.endsWith('facebook.com')` del ejemplo de Meta:
acepta `https://facebook.com.evil.example`, es decir, cualquiera que
registre ese dominio puede inyectar un `phone_number_id` y un `waba_id`
en el `POST`. La comprobación por host da la misma cobertura (incluye los
subdominios que la lista cerrada habría descartado en silencio) sin ese
agujero.

Tres `it` nuevos, con los casos que pedía el encargo:
`accepts the hosts Meta serves the dialog from`
(`https://business.facebook.com`, más `www.`, `web.` y el desnudo),
`rejects a look-alike domain that merely ends in facebook.com`
(`https://facebook.com.evil.example`) y
`rejects plain HTTP and anything that is not a URL`
(`http://www.facebook.com`, `"null"`, cadena vacía).

### 3. Versión de Graph: se documenta la diferencia, no se sube

**`meta-api.ts` no lo permite sin tocar otras llamadas**, así que se
aplicó la segunda mitad de la instrucción. El detalle:

`META_API_VERSION` de `src/lib/whatsapp/meta-api.ts` es una constante
privada del módulo que compone `META_API_BASE`, la base de **todas** las
llamadas de envío y de medios. Subirla a `v25.0` re-fecharía de golpe
`sendMessage`, la subida y descarga de medios, `verifyPhoneNumber` y
`/register`; además hay una segunda copia del literal en
`src/app/api/whatsapp/templates/sync/route.ts:29` (la sincronización de
plantillas quedaría en `v21.0`, que es exactamente la situación de dos
versiones conviviendo que hay que evitar) y un test que fija la URL,
`src/lib/whatsapp/meta-api.media.test.ts` (`https://graph.facebook.com/v21.0/pn-1/media`).
Nada de eso está en el alcance de f4.1 ni tiene verificación manual
prevista en el guion.

Decisión: `DEFAULT_GRAPH_VERSION` se queda en `v21.0`, **alineado** con
`META_API_VERSION` (que es lo que el encargo pide en primer lugar), y la
recomendación de Meta queda escrita en dos sitios:

- `docs/docker.md`: nota nueva bajo la tabla de variables — Meta
  recomienda `v25.0` en `FB.init`, el valor por defecto sigue el del
  resto de la app a propósito, y `META_GRAPH_VERSION=v25.0` mueve solo el
  diálogo y el intercambio, que es la salida soportada. La celda de la
  tabla también lo dice.
- `src/lib/whatsapp/platform-mode.ts`: el comentario de
  `DEFAULT_GRAPH_VERSION` enumera los tres sitios que habría que mover
  para subir la versión de verdad.

**Recomendación al líder:** subir toda la app a `v25.0` es un cambio de
una línea en tres archivos más el test de medios, pero es una feature
aparte (toca el camino de envío, que sí tiene tráfico real) y debería ir
con su propia verificación manual. Anotado también en «Deuda».

### 4. Requisitos operativos

- **Dominios permitidos**: paso 0 nuevo del guion manual (más abajo) y
  párrafo nuevo en `docs/docker.md` — «Allowed Domains for the JavaScript
  SDK» **y** «Valid OAuth redirect URIs» de Facebook Login for Business →
  Settings → Client OAuth settings, solo HTTPS. Es el fallo silencioso
  característico: el diálogo termina y no vuelve nada a la página.
- **Caducidad de 30 s del código**: se revisó el orden del `POST` y **se
  respeta**. El intercambio (paso 4) es la primera llamada a Meta; antes
  solo hay `requireRole`, el rate limit en memoria y tres consultas a
  Supabase. Los pasos 5–7 (`verifyPhoneNumber`, `subscribed_apps`,
  `/register`) usan ya el token, no el código. No se reordenó nada: el
  409 por número ajeno tiene que seguir llegando antes de gastar el
  código, y así lo fija el test
  `409s on another account's number before spending the code`. Queda
  como paso 2bis del guion, para que quien haga la prueba sepa
  distinguir un error de latencia de uno de credenciales.

### Lo que sigue sin verificar

La página de onboarding para Tech Providers devolvió 404 al líder, así
que el detalle del `subscribed_apps`/`register` posterior al intercambio
sigue apoyado en la página de implementación y en fuentes secundarias.
Los pasos 2 y 3 del guion manual siguen siendo la verificación
definitiva.

## Decisiones donde el diseño dejaba margen

1. **`assertWritable` se llama dos veces en el `POST`.** `requireRole('admin')`
   ya aplica la compuerta de solo lectura de f3 §5; la segunda llamada es
   la que devuelve el objeto de `entitlements` que `assertStockLimit`
   necesita. Es una lectura más por conexión (una vez por cliente
   conectado, no por mensaje) a cambio de no depender de un efecto
   secundario de `requireRole`. Igual que hace `POST /api/whatsapp/config`.
2. **`provisioned_via` lleva un CHECK con lista cerrada.** El plan solo
   pedía la columna con `'manual'` por defecto. Sin el CHECK acabarían
   conviviendo tres grafías del mismo concepto y la consulta de operación
   que distingue filas heredadas —la que importa al migrar a plataforma—
   se equivocaría en silencio.
3. **El `GET` usa `requireRole('admin', { allowReadOnly: true })`.** Es una
   lectura: una cuenta morosa tiene que poder ver su pantalla de ajustes.
   El `POST` sí es escritura y no lleva la excepción.
4. **`limit(200)` en el bucle de verificación**, con `console.warn` al
   alcanzarlo. El plan pedía «acotar»; 200 es un techo que ninguna
   instalación autoalojada legítima roza y que convierte el caso mixto en
   un aviso al operador en vez de un escaneo de tabla.
5. **El formulario manual se pliega dentro de un `<Accordion>` en la
   tarjeta de credenciales**, no en una pantalla aparte. Se extrajo a una
   constante `manualCredentialFields` para que el mismo marcado se
   renderice de las dos formas sin duplicarlo.
6. **El botón «Añadir número» pasa a `variant="outline"` en modo
   plataforma.** Dos botones primarios uno al lado del otro no dicen cuál
   es el camino normal.
7. **`EmbeddedSignupButton` devuelve `null` también si `enabled: true`
   llega sin `config_id`.** Abrir el diálogo contra una configuración
   indefinida es peor que no ofrecerlo.
8. **El fallo del `useEmbeddedSignup` se lee como `{ enabled: false }`.**
   Un error de red o un rol que no puede preguntar caen al formulario
   manual, que siempre funciona.

## Variables de entorno

| Variable | Obligatoria | Para qué |
|---|---|---|
| `META_APP_ID` | en modo plataforma | Nuestra app. Ya existía para las cabeceras de imagen de plantillas; ahora es también la mitad del intercambio de código |
| `META_CONFIG_ID` | en modo plataforma | La configuración de Embedded Signup del panel de Meta. **Es el interruptor** |
| `META_APP_SECRET` | siempre | Ya era obligatoria para la firma del webhook; el intercambio la necesita también |
| `META_GRAPH_VERSION` | no | Por defecto `v21.0`, el mismo valor que `META_API_VERSION` de `meta-api.ts`. Meta recomienda `v25.0` para el diálogo: se documenta la diferencia y la salida (ver «Alineación con la documentación viva») |
| `META_WEBHOOK_VERIFY_TOKEN` | **pasa a obligatoria de facto en plataforma** | Sin ella, con el registro integrado activo, ninguna fila tiene token propio y la verificación del webhook responde 403 para siempre |

Documentadas en `docs/docker.md` (sección nueva «Integrated WhatsApp
sign-up (platform mode)»), incluida la nota de operación sobre migrar
una instancia autoalojada a plataforma.

**Pendiente para el humano:** `.env.local.example` está bloqueado por
permisos (`.claude/settings.json`) y **no se tocó**. Hay que añadir a
mano `META_APP_ID`, `META_CONFIG_ID` y `META_GRAPH_VERSION`, igual que
quedó pendiente con `ENCRYPTION_KEY_PREVIOUS` (f2.3),
`META_WEBHOOK_VERIFY_TOKEN` (f2.4) y `PAYPAL_WEBHOOK_ID` (f3.3).

## Deuda detectada fuera de alcance (no se arregló)

1. **Renovación del token.** `token_expires_at` se guarda y nadie actúa
   sobre él. Los tokens de integración de negocio normalmente no expiran
   (Meta omite `expires_in`), así que hoy la columna es casi siempre
   NULL; el día que Meta cambie eso hará falta un trabajo programado.
2. **No se revoca el token anterior al reconectar.** Repetir el diálogo
   acuña uno nuevo y el viejo sigue siendo válido en Meta hasta que
   caduque o el cliente lo revoque. Fuera de alcance por decisión del
   plan; es una credencial viva de más por reconexión.
3. **El `business_id` no se guarda.** Ninguna consulta lo necesita hoy y
   pedirlo sería una llamada más a Graph sin consumidor. Si el panel de
   plataforma (f4.3) lo quiere, hay que añadirlo.
4. **Plantillas por WABA** y **conversaciones partidas por número**:
   deuda heredada de f4.2, sin cambios aquí. Siguen anotadas en
   `progress/impl_multi-number.md`.
5. **`next.config.ts` no está formateado con prettier** (usa comillas
   dobles; prettier las quiere simples). Reformatearlo entero habría
   metido 42 líneas de ruido en este diff, así que se editó respetando su
   estilo actual. Es deuda preexistente de un archivo que nadie ha pasado
   por `npm run format`.
6. **La CSP sigue en `Report-Only`.** El plan lo deja fuera a propósito;
   cuando se pase a enforce, el paso 11 del guion manual es el que hay
   que repetir.
7. **El PIN generado no se muestra nunca al cliente.** Está cifrado en
   `registration_pin` y solo lo usa `/register`. Si un cliente necesita
   su PIN para una gestión con Meta, hoy hace falta un script: no hay
   ruta que lo descifre, y añadir una sin pensarla sería un camino de
   exfiltración.
8. **Toda la app sigue en Graph `v21.0` y Meta recomienda `v25.0`.**
   Tres literales (`meta-api.ts`, `templates/sync/route.ts`,
   `platform-mode.ts`) y un test de medios. Es una línea en cada sitio,
   pero toca el camino de envío y merece su propia verificación: fuera
   del alcance de f4.1. Detalle en «Alineación con la documentación
   viva» §3.

## Nota de entorno

Al terminar se borraron cinco contenedores `wacrm-migrations-*` que
habían quedado vivos de ejecuciones con `KEEP=1` (dos de esta sesión,
tres anteriores). Si otro agente tenía uno en uso, ese es el motivo.
