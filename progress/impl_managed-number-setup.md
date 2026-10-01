# impl s10.6 `managed-number-setup`

## Plan
1. `token-renewal.ts`: además del filtro SQL (`token_expires_at IS NOT NULL`), descartar en JS cualquier fila sin caducidad antes de contar o renovar: se salta en silencio (sin `console.*`, sin escribir, sin contarla). Tests: config manual de cuenta `managed` (usuario de sistema) y fila sin caducidad que se colara por el filtro.
2. Checklist de la opción A (`src/components/settings/managed-setup-checklist.tsx`, nuevo): crear el WABA en el Business Manager de Cabbity CRM, registrar el número, token de usuario de sistema permanente, verificación del nombre visible, dónde pegar cada dato. Casillas en estado local (no persisten). Se pinta solo si `metaBilling === 'managed'`; la página lo lee de `subscriptions.meta_billing` con el cliente del navegador (RLS 041, filtrado por `account_id`), sin tocar rutas. i18n `Settings.managedSetup` (es/en).
3. Ficha del superadmin: sección de números extraída a `src/components/platform/platform-numbers.tsx` (para no chocar con s10.4 en la ficha): WABA id y `phone_number_id` con botón copiar, modo de conexión (Embedded Signup / manual) y, para cuentas `managed`, etiqueta «En el portafolio de Cabbity CRM». `loadNumbers` añade `provisioned_via` al select (ya filtrado por `account_id`). Enlace al Billing Hub: la URL no está en esta rama (solo en p11.1, otra rama): se omite. i18n `Platform.numbers` (es/en).
4. Tests: checklist solo en `managed` + casillas; `token-renewal` ignora sin caducidad; ficha muestra ids, modo y etiqueta; `loadNumbers` lleva `provisioned_via` y sigue filtrado por cuenta.
5. CHANGELOG (Unreleased); compuerta; commits.

## Estado: done (pendiente de reviewer)

Rama `fg/number-setup` (worktree `.claude/worktrees/fg-number-setup`), base `feat/facturacion-gestionada` @ bfe366f. HEAD `6bb0565`. Sin push. Sin migración.

| Commit | Qué |
|---|---|
| `0957cb8` | feat: checklist de la opción A en Ajustes → WhatsApp, guarda de `token-renewal` para filas sin caducidad, i18n `Settings.managedSetup` y `Platform.numbers` (es/en) |
| `846fcf2` | feat: sección de números de la ficha (ids con copiar, modo de conexión, etiqueta de portafolio), `loadNumbers` con `provisioned_via` |
| `6bb0565` | docs: CHANGELOG (Unreleased) y `docs/security.md` («Managed numbers use permanent tokens») |

## Archivos
- `src/lib/whatsapp/token-renewal.ts` (+ test): filtro en código de filas sin `token_expires_at` antes de contar; tipo `token_expires_at: string | null`.
- `src/components/settings/managed-setup-checklist.tsx` (nuevo, + test): `ManagedSetupChecklist`, `fetchMetaBilling`, `toggleStep`, `MANAGED_SETUP_STEPS`, `META_STEPS`.
- `src/components/settings/whatsapp-config.tsx`: lee `meta_billing` y pinta el checklist después de la lista de números. En cuentas `managed`, el acordeón «Conexión manual» del modo plataforma arranca abierto.
- `src/components/platform/platform-numbers.tsx` (nuevo, + test): `AccountNumbersCard`, `copyId`, tipo `WhatsAppNumber` (antes local en la ficha).
- `src/components/platform/platform-account-detail.tsx`: la tarjeta «Conexión con WhatsApp» se reemplaza por `<AccountNumbersCard numbers metaBilling />`, y la interfaz local pasa al componente nuevo. No toqué nada más de la ficha.
- `src/lib/platform/accounts.ts` (+ test): `AccountNumber.provisionedVia`, columna `provisioned_via` en el select de `loadNumbers`.
- `messages/es.json`, `messages/en.json`: `Settings.managedSetup.*`, `Platform.numbers.*`.
- `CHANGELOG.md`, `docs/security.md`.

## Criterio ↔ test

| Criterio | Test |
|---|---|
| Checklist con los pasos de la opción A (WABA en el BM de Cabbity, registrar número, token de usuario de sistema permanente, nombre visible, dónde pegar cada dato) | `src/components/settings/managed-setup-checklist.test.tsx` › `renders the five steps of option A, in order, for a managed account`; `names the real buttons and fields of the manual form in the paste step` |
| Solo para cuentas `managed` | ídem › `renders nothing when meta_billing is direct` / `… is null`; `Settings → WhatsApp wires the checklist to meta_billing` › `reads meta_billing for the current account and hands it to the checklist`, `opens the manual fold by default only for managed accounts` |
| Cada paso dice que es un trámite en Meta | ídem › `says every Meta step is paperwork in Meta, to verify in the Business Manager` |
| Casillas locales, sin persistir | ídem › `starts with every box unticked; a ticked one is marked done`; `toggleStep (the box state, local only)` › `ticks and unticks without touching the input set`; el texto `localOnly` se comprueba en el test de «trámite en Meta» |
| Sin enlaces a URLs de Meta que no estén en el repo | ídem › `carries no link (no Meta URL exists in the repo for these screens)` |
| La lectura de `meta_billing` filtra por `account_id`; lo desconocido no cuenta como `managed` | ídem › `fetchMetaBilling` › `reads only the account's own subscription row, scoped by account_id`, `reads %j as %s` (3), `a failed read is unknown (null), never managed` |
| `token-renewal` salta configs sin `token_expires_at` sin warning | `src/lib/whatsapp/token-renewal.test.ts` › `renewExpiringTokens and permanent (system-user) tokens (s10.6)` › `skips a manual config without expiry silently: no call, no write, no warning`, `drops a row without expiry even if one ever slips past the query filter`. Lo comprobé por mutación: sin la guarda, el segundo test falla porque esa fila se manda a Meta. Ya existía `only looks at embedded_signup rows…`, que cubre el caso del filtro SQL |
| Ficha: `waba_id` y `phone_number_id` visibles, con copiar | `src/components/platform/platform-numbers.test.tsx` › `shows the WABA id and the phone_number_id of every number, each with a copy button`; `copyId` (2); `the operator file uses the numbers section` › `shows ids, mode and the portfolio tag for a managed company` |
| Ficha: modo de conexión (Embedded Signup / manual) | ídem › `shows the connection mode: Embedded Signup or manual`, `a number from an older payload without the mode reads as manual` |
| Ficha: etiqueta «En el portafolio de Cabbity CRM» solo en `managed` | ídem › `tags every number «En el portafolio de Cabbity CRM» on a managed account only`, `a direct company: ids and mode, no portfolio tag` |
| Sin enlace al Billing Hub (no está en esta rama) | ídem › `carries no link to Meta (the Billing Hub URL is not on this branch)` |
| Datos de la ficha con alcance por cuenta (CP3); el token no sale | `src/lib/platform/accounts.test.ts` › `s10.6: each number carries its WABA id, phone_number_id and connection mode, for this account only` (columnas del select con `waba_id` y `provisioned_via`, sin `access_token` ni `*`, `.eq('account_id', A)`, nada de B), `s10.6: a row without a known provisioned_via reads as manual`. Siguen en verde los tests previos `never hands the operator a customer access token` y `scopes EVERY service-role query…` |
| i18n es/en | `managed-setup-checklist.test.tsx` › `Settings.managedSetup keys (CP6: es and en)` (2); `platform-numbers.test.tsx` › `Platform.numbers keys (CP6: es and en)`, `renders in English`; `src/i18n/messages.test.ts`, `brand.test.ts`, `icu-safety.test.ts` en verde |

**Fuga A↔B:** no toqué ninguna ruta. El checklist lee con el cliente del navegador bajo RLS (`subscriptions_select`, 041) con `.eq('account_id', accountId)`. La ficha añade una sola columna a una consulta con rol de servicio que ya estaba filtrada, y el test nuevo de `accounts.test.ts` lo comprueba.

## Compuerta (worktree, HEAD 6bb0565)
- `npm run lint`: 0 errores, 34 warnings, las mismas de antes. Ninguna en archivos nuevos. La de `whatsapp-config.tsx` (`user` en las deps del efecto de carga) es anterior a este cambio.
- `npm run typecheck`: verde.
- `TZ=UTC npm test`: 267 archivos, **3808 tests** en verde.
- `npm run build` (variables dummy): verde.
- Sin SQL: no corrí `replay-migrations.sh` (no hay migración).

## Verificaciones contra base real
Ninguna: no hay migración ni RPC nuevos. La lectura de `subscriptions.meta_billing` desde el navegador usa la política `subscriptions_select` de la 041. s10.3 ya la comprobó (`progress/checks_managed-plan.sql`, bloque 3: el propietario de A lee su fila y no la de B).

## Verificaciones manuales pendientes (las hace el humano)
1. Con una cuenta `managed` (asignada desde la ficha, s10.3), entrar a Ajustes → WhatsApp como su propietario. Debe salir la tarjeta «Alta del número en el portafolio de Cabbity CRM» con 5 pasos y las casillas desmarcadas. Marcar dos y recargar: vuelven a estar desmarcadas. Pulsar «Añadir número»: en modo plataforma, «Conexión manual (avanzado)» sale ya desplegada.
2. Con una cuenta `direct`, la misma pantalla no muestra la tarjeta y el acordeón sale cerrado.
3. En el Business Manager de Cabbity, seguir los pasos con un número de prueba. Pegar el phone_number_id, el WABA id y el token de usuario de sistema, guardar y usar «Probar conexión». En base, la fila debe quedar con `provisioned_via = 'manual'` y `token_expires_at` NULL. Tras un minuto de cron (`/api/webhooks/cron`), `token_renewal_attempted_at` sigue NULL y el log no tiene líneas de `[token-renewal]` para esa fila.
4. **Verificar en el Business Manager** lo que el checklist da por cierto sin que esté en el repo: que el token de usuario de sistema puede generarse «sin caducidad» con `whatsapp_business_messaging` y `whatsapp_business_management`, que Meta lo muestra una sola vez, que el número se verifica con un código y que el nombre visible pasa por revisión con restricciones de envío mientras tanto. Si algo no cuadra, se corrige el texto en `messages/{es,en}.json` › `Settings.managedSetup.steps`.
5. En `/platform/[id]` de esa cuenta: cada número muestra el id del WABA y el id del número con botón copiar (pegar en otro sitio para comprobarlo), «Configuración manual» y «En el portafolio de Cabbity CRM». En una cuenta conectada por el diálogo sale «Conectado con el diálogo de Meta (Embedded Signup)» sin la etiqueta.

## Decisiones donde la spec era ambigua
1. **De dónde sale `metaBilling` en Ajustes.** `getEntitlements()` es de servidor: importa el cliente de rol de servicio y no puede entrar en un componente de cliente. `/api/billing/status` no expone `metaBilling` en esta rama, y tocarlo chocaría con s10.4 (ese banner es de s10.4). La página lee `subscriptions.meta_billing` directamente con el cliente del navegador. Es el mismo patrón con el que ya lee `whatsapp_config`: RLS 041 más `.eq('account_id')`. Normaliza igual que `asMetaBilling`: solo `'managed'` es managed, y un error da `null`, que no pinta nada. El checklist solo orienta y no da permisos, así que una lectura del navegador basta.
2. **Dónde va el checklist.** Va como tarjeta propia, justo después de la lista de números y fuera del formulario. Así se ve antes de pulsar «Añadir número», que es cuando hacen falta los trámites en Meta. Además, en cuentas `managed` el acordeón de conexión manual sale abierto (`defaultValue`), porque para ellas es el único camino.
3. **Paso extra «Pegar los datos en el CRM».** El alcance pedía «dónde pegar cada dato». Es el quinto paso y el único marcado «En el CRM». Nombra los botones y campos reales con sus propias etiquetas (`addNumber`, `manualSetup`, `phoneNumberId`, `wabaId`, `accessToken`, `testConnection` de `Settings.whatsapp`), interpoladas, para que no se desincronicen.
4. **Método de pago del WABA.** La decisión 1 del humano dice que se paga con la tarjeta de Cabbity. Lo incluí en el texto del paso «Crear el WABA», no como paso aparte, junto con «la propiedad del WABA va por contrato».
5. **Marca.** `brand.test.ts` exige «Cabbity CRM» en cada mención de Cabbity en los catálogos. Por eso la etiqueta dice «En el portafolio de Cabbity CRM», no «… de Cabbity».
6. **Enlace al Billing Hub: omitido.** La URL (`https://business.facebook.com/billing_hub/payment_settings/`, supuesto S-M4) solo está en `be8ca0f` (p11.1), en otra rama, y no en `fg/number-setup`. Siguiendo la instrucción, no la dupliqué. Cuando p11.1 entre en la base, el enlace se añade a `AccountNumbersCard` reutilizando su constante.
7. **Fila sin `token_expires_at` que se colara por el filtro SQL.** Se descarta antes de contar: no suma a `scanned` ni a `skipped`. Es lo más literal de «se saltan sin warning», y deja `skipped` para lo que de verdad se pospone.
8. **Modo desconocido** (`provisioned_via` ausente o fuera del CHECK) se lee como `manual`, que es el default de la columna (054).
9. **Ficha.** Extraje la sección a `platform-numbers.tsx` para que el diff de `platform-account-detail.tsx` con s10.4 se limite a la interfaz y a una tarjeta.

## Variables de entorno nuevas
Ninguna. `docs/docker.md` sin cambios; `.env.local.example` no se tocó.

## Deuda detectada fuera de alcance
- `whatsapp-config.tsx` tiene muchos textos de toast en inglés fijo (`'Configuration cleared…'`, `'Webhook URL copied to clipboard'`, el banner «Stored token can't be decrypted»). Son anteriores a este cambio y no están en el catálogo.
- `/api/billing/status` no expone `metaBilling`. Si más pantallas del cliente lo necesitan, conviene añadirlo ahí (después de s10.4) y que el checklist lo tome de `useBillingStatus` en vez de leer la tabla.
- Un número manual que pegue un token de 60 días, y no uno de usuario de sistema, nunca se renueva ni avisa antes de caducar: el barrido solo mira `embedded_signup` y la fila no lleva fecha. Ya pasaba antes de s10.6. El checklist pide el token permanente, pero el CRM no lo comprueba. Se podría consultar `debug_token` al guardar, pero eso es una llamada a Meta y queda fuera de alcance.
- Conflictos de merge previsibles con s10.4: `CHANGELOG.md` (bloques Unreleased), `messages/*.json` (claves nuevas en `Settings` y `Platform`) y, en `platform-account-detail.tsx`, el bloque de imports y el hueco de la tarjeta de WhatsApp.
