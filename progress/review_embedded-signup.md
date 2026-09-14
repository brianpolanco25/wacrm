# Review — f4.1 embedded-signup (re-revisión, ronda 2)

**Veredicto:** APPROVED

Rama `saas/fase-4-multinumero`, worktree `.claude/worktrees/fase-4-multinumero`, HEAD `8fcbb88`,
limpio. Esta ronda revisa `ddd6c38..8fcbb88` (1 commit, 5 archivos) contra la sección
«Discrepancias» de `progress/meta_embedded-signup-verificacion.md`. La aprobación de la ronda 1
(`09f71ba..ddd6c38`, 21 archivos) se mantiene y su detalle está al final; nada de lo que la
sostenía se ha roto. Todo ejecutado por mí, no leído del informe.

## Compuerta (ronda 2, paso a paso)

- `npm run lint`: **verde** — 0 errores, 38 avisos, los mismos 38 preexistentes de la ronda 1
  (ninguno nuevo en `embedded-signup-button.tsx` ni en `platform-mode.ts`).
- `npm run typecheck`: **verde**, sin salida.
- `TZ=UTC npm test -- --reporter=dot`: **verde** — 125 archivos, **1 659** tests, 0 fallos, 4,74 s.
  Son los 1 654 de la ronda 1 más los 5 `it` nuevos del commit; ninguno perdido.
- `npm run build` con las variables dummy de `docs/harness.md`: **verde**, manifiesto completo.
- `scripts/replay-migrations.sh`: **n/a** — el diff no toca `supabase/`. El replay verde de la
  ronda 1 (054, `verify-schema.sql: OK`) sigue vigente porque no hay SQL nuevo.

## Trazabilidad: las cuatro correcciones pedidas

- **D1 «`extras` solo con `setup: {}`»**: [x] `embedded-signup-button.tsx:143-160`
  `buildFbLoginOptions` devuelve `extras: { setup: {} }`; `sessionInfoVersion: '3'` y
  `featureType: ''` desaparecen del `FB.login` (`:287-290`, ahora una sola llamada a la función).
  Test leído: `embedded-signup-button.test.tsx` › «passes only `setup` in extras, as Embedded
  Signup v4 documents» — no se conforma con `toEqual({setup:{}})`, además afirma
  `Object.keys(options.extras) === ['setup']`, así que una clave añadida más adelante rompe el
  test. Y › «asks for a code, overriding the SDK default» fija `config_id`, `response_type:'code'`
  y `override_default_response_type: true`, que la doc viva sí confirma.
- **D2 «origen del evento por hostname, no por lista»**: [x] `embedded-signup-button.tsx:111-136`
  `isMetaSignupOrigin` parsea con `new URL`, exige `protocol === 'https:'` y `hostname` igual a
  `facebook.com` o terminado en `.facebook.com`. La constante `META_ORIGINS` de dos entradas se
  borra y el listener la usa en `:181`. Tests leídos, los tres `it`:
  - aceptación: `www.`, `web.`, **`https://business.facebook.com`** (el caso que la lista cerrada
    dejaba fuera) y el apex `https://facebook.com`;
  - rechazo del señuelo: **`https://facebook.com.evil.example`** y `https://notfacebook.com`
    (hostname `facebook.com.evil.example` no termina en `.facebook.com`) — esto es más estricto
    que el `origin.endsWith('facebook.com')` literal de la doc de Meta, y correctamente;
  - rechazo de **`http://www.facebook.com`**, de la cadena `'null'` de un iframe sandboxed y de `''`.
- **D3 «`META_GRAPH_VERSION` por defecto alineado con `META_API_VERSION`»**: [x] comprobado en el
  fuente, no en el informe: `src/lib/whatsapp/meta-api.ts:12` `META_API_VERSION = 'v21.0'` y
  `src/lib/whatsapp/platform-mode.ts:32` `DEFAULT_GRAPH_VERSION = 'v21.0'`. Alineados.
  `docs/docker.md` coherente: la celda de la tabla dice «Defaults to `v21.0`, the same version the
  rest of the Graph calls use (`META_API_VERSION`)» y la nota nueva explica que Meta recomienda
  `v25.0` en `FB.init`, por qué el defecto no se mueve solo, y que `META_GRAPH_VERSION=v25.0`
  desplaza únicamente diálogo e intercambio. El `CHANGELOG` dice lo mismo en una línea. La opción
  de no subir toda la app a v25.0 es la correcta para el alcance de f4.1: `META_API_VERSION` cubre
  envíos, medios, `verifyPhoneNumber` y `/register`, y hay una segunda copia del literal en
  `templates/sync/route.ts` — subirla aquí habría dejado dos versiones conviviendo.
- **D4 «guion manual con dominios permitidos, TTL de 30 s y orden del POST»**: [x]
  - `progress/impl_embedded-signup.md:118-127` paso 0: «Allowed Domains for the JavaScript SDK»
    **y** «Valid OAuth redirect URIs» de Facebook Login for Business → Settings → Client OAuth
    settings, solo HTTPS, con el síntoma exacto del fallo silencioso (el diálogo termina y no
    vuelve nada). Réplica en `docs/docker.md`, párrafo «Allow your domain in the app panel».
  - `:139-149` paso 2bis: los 30 s de caducidad del código, con el síntoma que lo distingue de un
    fallo de credenciales.
  - Orden del `POST` **verificado por mí en el código**, no por el informe:
    `src/app/api/whatsapp/embedded-signup/route.ts` — `exchangeCodeForToken` en `:297` es la
    primera llamada a Meta; `verifyPhoneNumber` `:320`, `subscribeWabaToApp` `:339`,
    `registerPhoneNumber` `:357` van después y ya con el token. Antes del `:297` solo hay
    `requireRole` (`:155`), el rate limit (`:161`) y tres consultas a Supabase — nada sale a la red
    de Meta. El 409 por número ajeno sigue llegando antes de gastar el código, fijado por
    `route.test.ts:412` › «409s on another account's number before spending the code»
    (`fetchMock` no llamado, `upserts` vacío). Leído.

## Checkpoints (ronda 2)

- **CP1 Compuerta**: [x] cuatro pasos verdes, ejecutados por mí, uno a uno.
- **CP2 Migraciones**: [x] n/a en esta ronda — cero archivos de `supabase/` en el diff.
- **CP3 Aislamiento**: [x] ninguna consulta nueva. La única con rol de servicio de la feature
  (`route.ts:210`) no se toca y conserva su test de fuga en `tenant-isolation.test.ts`.
- **CP4 Tests**: [x] 5 `it` nuevos, los cinco leídos arriba; ninguno es un `expect(true)`.
- **CP5 Sin dependencias nuevas**: [x] `package.json`/`package-lock.json` no aparecen en el diff.
- **CP6 i18n**: [x] el diff no añade ni quita claves; `messages/*.json` intactos.
- **CP7 Next 16**: [x] el bloque `<Script>` no se toca (`strategy="afterInteractive"`, `onLoad`,
  `onError` en componente `'use client'`, ya contrastado contra
  `node_modules/next/dist/docs/01-app/03-api-reference/02-components/script.md` en la ronda 1).
  Las dos funciones nuevas son puras y no dependen del framework.
- **CP8 Alcance**: [x] 5 archivos, todos justificados por las cuatro discrepancias. Sin ruido de
  formato esta vez.
- **CP9 Documentación**: [x] `CHANGELOG.md` y `docs/docker.md` actualizados y coherentes entre sí
  y con el código. `.env.local.example` sigue como pendiente humano declarado.
- **CP10 Git**: [x] un commit, en español, `fix:` + `Co-Authored-By`. Worktree limpio. Sin push.
- **CP11 Lo entrante nunca se bloquea**: [x] el cambio vive en el componente de ajustes y en una
  constante; el webhook no se toca.

## Hallazgos (archivo:línea)

1. `src/components/settings/embedded-signup-button.tsx:308` —
   `version: settings.graph_version ?? 'v21.0'`: tercera copia del literal de versión, que no se
   mueve si alguien cambia `DEFAULT_GRAPH_VERSION`. Preexistente (no está en este diff) y sin
   efecto práctico, porque el `GET` siempre envía `graph_version` cuando la función está activa.
   Sustituir el literal por el import cuando se toque el archivo. No bloquea.
2. `isMetaSignupOrigin` confía en **cualquier** subdominio HTTPS de `facebook.com`. Es lo que
   documenta Meta y es deliberado (el listener solo guarda ids en un ref, y el servidor rechaza
   por 409 un número de otra cuenta antes de gastar el código), pero conviene tenerlo presente:
   la garantía real de aislamiento no está aquí, está en `route.ts:210`.
3. Siguen abiertos, sin cambio, los hallazgos 1 y 2 de la ronda 1 —`platformMode` colapsando
   «todavía no sé» a `false` (`whatsapp-config.tsx:71`) y `verify_token` puesto a NULL al guardar
   una fila heredada en modo plataforma (`:359`)—, ambos recomendados para f4.3, no condiciones
   de aprobación.
4. La verificación definitiva del contrato con Meta sigue siendo el paso 3 del guion manual. Lo
   que la ronda 2 ha hecho es cerrar la parte contrastable contra la documentación viva: ya no
   quedan claves inventadas en `extras` ni una lista de orígenes que Meta pueda invalidar en
   silencio. Condición de salida de la fase, no de esta revisión.

## Cambios requeridos

Ninguno.

---

## Anexo — ronda 1 (`09f71ba..ddd6c38`), aprobada, resumen

Compuerta verde en los cinco pasos (incluido `replay-migrations.sh` = 0 con
`verify-schema.sql: OK` y `progress/checks_embedded-signup.sql` ejecutado por mí en el contenedor
vivo: OK 1 a OK 5, `ROLLBACK` limpio). Trazabilidad de los criterios del spec §1:

- **C1** «conectar sin salir de la app»: `route.test.ts` › «trades the code for a token with OUR
  app id and secret», › «stores the token encrypted, never in the clear», › «marks the row as
  provisioned by the dialog and leaves verify_token null», › «generates a six-digit registration
  PIN and stores it encrypted», › «repeating the flow updates the same row instead of adding a
  second» (afirma `onConflict: 'account_id,phone_number_id'` y cero `insert`), más los cuatro «no
  escribe nada a medias» y los tres de «ni el código ni el token llegan a consola»;
  `embedded-signup.test.ts`, 12 `it` sobre `exchangeCodeForToken` y `generateRegistrationPin`.
- **C2** «suscripción y entrantes a la empresa correcta»: › «uses the freshly minted token for
  every Meta call», › «still saves the row when /register fails, with the reason», › «does not
  abort when the WABA subscription fails», más `tenant-isolation.test.ts` › «refuses to claim B's
  number and leaves B's row untouched» y › «reconnects A's own number and writes only inside A».
- **C3** «una firma para todos los inquilinos»: `webhook-signature.test.ts` › «accepts deliveries
  for two different tenants with the same secret» y › «rejects a delivery signed with a tenant's
  own app secret». `verifyMetaWebhookSignature` no se tocó.
- **C5** «autoalojado sigue funcionando»: › «GET reports the feature as disabled and leaks no
  ids», › «POST 404s: in self-hosted mode the route does not exist», y los tres de la UI en
  `embedded-signup-button.test.tsx`.

Aislamiento (CP3): única consulta con rol de servicio en `route.ts:210-215`, la comprobación de
propiedad cruzada, que filtra por `phone_number_id` + `.neq('account_id', …)`, selecciona solo
`account_id` y se usa por verdad/falsedad; con test de fuga. El resto va por el cliente con sesión
y lleva `.eq('account_id', accountId)`. Migración `054_embedded_signup.sql` idempotente, sin
`CASCADE` ni `DROP`, con cuatro aserciones nuevas en `verify-schema.sql`. Sin dependencias nuevas.
14 claves i18n, las mismas en `en.json` y `ko.json`.
