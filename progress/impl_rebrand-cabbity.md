# p6.1 — `rebrand-cabbity`

Spec: `progress/spec_producto.md` §1 y supuesto S-P1.
Rama: `saas/producto` (worktree `.claude/worktrees/producto`).
Commit: `e76954c` — `feat: renombrar el producto visible a Cabbity CRM`.
Base: `0e85b2d`.

## Plan ejecutado

1. Inventariar los usos de «wacrm» con `grep -rniE "wa ?crm" src messages docs/docker.md`
   (122 coincidencias) y clasificarlos en «texto visible» / «identificador técnico».
2. Confirmar en `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/generate-metadata.md`
   que el `export const metadata: Metadata` estático del layout raíz sigue siendo la API
   de Next 16 (lo es; `title.default` + `title.template` sin cambios de forma).
3. Renombrar el texto visible: metadata raíz, catálogos `en`/`ko`, marca de PayPal,
   mensajes de error de WhatsApp, diálogo de invitación, valor por defecto de
   `PAYPAL_PRODUCT_NAME` y `docs/docker.md`.
4. Fijar el resultado con tests.
5. Compuerta + CHANGELOG + informe.

## Qué cambió (texto visible)

| Sitio | Antes | Ahora |
|---|---|---|
| `src/app/layout.tsx` `metadata.title.default` | `wacrm` | `Cabbity CRM` |
| `src/app/layout.tsx` `metadata.title.template` | `%s — wacrm` | `%s — Cabbity CRM` |
| `messages/{en,ko}.json` `Sidebar.title` | `CRM Template for WhatsApp` / `WhatsApp용 CRM 템플릿` | `Cabbity CRM` |
| `messages/{en,ko}.json` — 6 claves con «wacrm» en el texto | `wacrm` | `Cabbity CRM` |
| `src/app/api/billing/checkout/route.ts` `BRAND_NAME` | `wacrm` | `Cabbity CRM` |
| `src/app/api/whatsapp/config/route.ts` (409 de número duplicado) | `…one wacrm user.` | `…one Cabbity CRM user.` |
| `src/app/api/whatsapp/embedded-signup/route.ts` (mismo 409) | `…one wacrm user.` | `…one Cabbity CRM user.` |
| `src/components/settings/invite-member-dialog.tsx` (fallback del nombre de cuenta, sale en el mensaje de WhatsApp) | `our wacrm account` | `our Cabbity CRM account` |
| `scripts/paypal-bootstrap-catalog.ts` `DEFAULT_PRODUCT_NAME` | `'wacrm'` inline | constante exportada `'Cabbity CRM'` |
| `scripts/paypal-bootstrap-catalog.ts` descripción del plan de PayPal | `wacrm <plan> plan, billed…` | `Cabbity CRM <plan> plan, billed…` |
| `docs/docker.md` L103 (dominio donde se sirve el producto) y L174 (`PAYPAL_PRODUCT_NAME`) | `wacrm` | `Cabbity CRM` |

Las 6 claves de catálogo tocadas (mismas en `en` y `ko`):
`Settings.invite.whatsappMessage`, `Settings.templates.deleteMetaDesc`,
`Settings.templates.deleteLocalDesc`, `Settings.whatsapp.registered`,
`Settings.whatsapp.pinHint`, `Settings.aiConfig.description` — más `Sidebar.title`,
que no contenía «wacrm» (ver «Decisiones»). El criterio lo cubre
`src/i18n/brand.test.ts`, que recorre el catálogo entero.

Tras el cambio: `grep -rniE "wa ?crm" messages` → **0 coincidencias**.

## Criterio ↔ test

| Criterio del spec | Test | `it` |
|---|---|---|
| Test que fija el título/metadata con «Cabbity CRM» | `src/app/layout.test.ts` | `titles the app "Cabbity CRM" by default` |
| idem (plantilla por página) | `src/app/layout.test.ts` | `appends the brand to every per-page title` |
| idem (sin restos del nombre viejo) | `src/app/layout.test.ts` | `carries no trace of the previous name` |
| `grep` sin texto visible: catálogo `en` | `src/i18n/brand.test.ts` | `brand in messages/en.json > mentions no retired product name` |
| `grep` sin texto visible: catálogo `ko` | `src/i18n/brand.test.ts` | `brand in messages/ko.json > mentions no retired product name` |
| Nombre visible en la barra lateral (S-P1) | `src/i18n/brand.test.ts` | `names the sidebar after the product` (×2 locales) |
| Grafía única de la marca | `src/i18n/brand.test.ts` | `spells the brand the same way everywhere it appears` (×2 locales) |
| Marca en PayPal (pantalla de aprobación) | `src/app/api/billing/checkout/route.test.ts` | `shows the product's brand on PayPal's approval screen` |
| Valor por defecto de `PAYPAL_PRODUCT_NAME` | `src/lib/billing/paypal-bootstrap-catalog.test.ts` | `defaults the product name to the visible brand` |
| Marca en la descripción de cada plan de PayPal | `src/lib/billing/paypal-bootstrap-catalog.test.ts` | `names the brand in every plan description` |
| El `requestId` de idempotencia NO cambia (regresión que rompería el catálogo) | `src/lib/billing/paypal-bootstrap-catalog.test.ts` | `keeps the idempotency keys on their original prefix` |

`src/app/layout.test.ts` mockea `next/font/google` y `./globals.css`: fuera del
compilador de Next ninguno de los dos resuelve, y ninguno participa en las aserciones.

## Compuerta

Ejecutada paso a paso en el worktree, sobre el árbol commiteado:

- `npm run lint` → 0 errores, 35 warnings preexistentes (ninguno en archivos tocados
  salvo los que ya estaban: `src/i18n/request.ts`, etc.).
- `npm run typecheck` → limpio.
- `TZ=UTC npx vitest run --reporter=dot` → **144 archivos, 1958 tests, todos en verde**
  (antes: 142 archivos / 1947 tests).
- `npm run build` con `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `ENCRYPTION_KEY` (64 ceros) y `META_APP_SECRET` de CI → exit 0.

No hay SQL en esta feature, así que `scripts/replay-migrations.sh` no aplica
(no se tocó `supabase/`).

## Verificación contra artefacto real (no hay base de datos implicada)

En vez de SQL, la comprobación que importa aquí es que el título llega al HTML:

```
grep -o "<title>[^<]*</title>" .next/server/app/login.html
→ <title>Cabbity CRM</title>
```

Ejecutado sobre la salida del `npm run build` de la compuerta. No se añadió
`progress/checks_rebrand-cabbity.sql` porque no hay nada que consultar en Postgres.

## Verificación manual pendiente (depende de PayPal)

Sólo una, y no bloquea nada en local porque el catálogo de PayPal está vacío:

1. Con credenciales de sandbox en `.env.local`, correr
   `npx tsx scripts/paypal-bootstrap-catalog.ts`.
2. En el panel de PayPal sandbox → *Catalog › Products*, comprobar que aparece un
   producto llamado **Cabbity CRM** y seis planes cuya descripción empieza por
   «Cabbity CRM».
3. Iniciar un checkout desde `/billing` y comprobar que la página de aprobación de
   PayPal muestra «Cabbity CRM» como comercio (eso es `brand_name`).

## Decisiones donde el spec era ambiguo

- **`Sidebar.title` («CRM Template for WhatsApp» / «WhatsApp용 CRM 템플릿») → «Cabbity CRM».**
  Literalmente no casaba con el `grep` del criterio, pero es *el* nombre visible del
  producto —la marca junto al logotipo, presente en todas las pantallas— y S-P1 dice
  «el nombre visible pasa a Cabbity CRM». Dejarlo habría producido una aplicación cuya
  pestaña dice «Cabbity CRM» y cuya cabecera dice otra cosa. Es nombre propio, así que
  es idéntico en `en` y `ko` (`brand.test.ts` lo fija así a propósito).
- **`metadata.description` («Self-hostable CRM template for WhatsApp.») se queda.**
  Describe el producto, no lo nombra; cambiarla es decisión de marketing, no de esta
  feature.
- **Partículas coreanas.** «wacrm» y «Cabbity CRM» terminan ambos en consonante (m),
  así que `은`, `이`, `으로` y `와` siguen siendo las formas correctas en las cuatro
  frases afectadas. No hizo falta reescribir ninguna.
- **`prettier --write` sólo en los archivos nuevos.** `src/app/layout.tsx` y
  `src/components/settings/invite-member-dialog.tsx` no estaban formateados con
  prettier antes de esta rama (comillas dobles, clases Tailwind sin ordenar).
  Pasarles prettier convertía un diff de 2 líneas en uno de 32 y 53. Se revirtió y se
  dejó el cambio quirúrgico; `npx prettier --check src/app/layout.tsx` sigue avisando
  por esa deriva **preexistente** (ver «Deuda»).
- **`DEFAULT_PRODUCT_NAME` exportada.** El valor por defecto vivía inline dentro de
  `main()` de un script, que vitest no carga (`include` es `src/**`). Exportarlo como
  constante es el cambio mínimo que lo hace verificable desde
  `src/lib/billing/paypal-bootstrap-catalog.test.ts`, que ya importa de ese script.

## Restos de «wacrm», justificados uno a uno

`grep -rniE "wa ?crm" src messages docs/docker.md` deja 0 en `messages/` y estos en
`src/` y `docs/docker.md`. Ninguno es texto visible.

**Identificadores de protocolo — cambiarlos rompe integraciones de terceros ya desplegadas:**

- `src/lib/api-keys/keys.ts:25` `API_KEY_PREFIX = 'wacrm_live_'` (+ comentarios L15, L17, L18).
  Toda clave de API emitida hasta hoy empieza así y se valida contra el prefijo;
  cambiarlo invalidaría las claves de todos los clientes. Además está pensado para que
  los escáneres de secretos (GitGuardian) lo reconozcan.
- `src/lib/webhooks/deliver.ts:118-120` cabeceras `X-Wacrm-Event`, `X-Wacrm-Webhook-Id`,
  `X-Wacrm-Signature`, y `src/lib/webhooks/sign.ts:4,5,8,19,36` (constante y comentarios
  del formato de firma). Los receptores de webhooks ya verifican estas cabeceras por
  nombre; renombrarlas rompe silenciosamente cada integración.
- `src/app/api/v1/webhooks/route.ts:6` — comentario que documenta `X-Wacrm-Signature`.
- `src/lib/webhooks/endpoints.ts:11` — comentario que compara el prefijo del secreto con
  `wacrm_live_`.
- `src/lib/auth/api-context.ts:8` — comentario del formato `Authorization: Bearer wacrm_live_…`.
- `scripts/paypal-bootstrap-catalog.ts:176` `requestId: 'wacrm-<env>-<plan>-<cycle>-v1'`.
  Es la clave de idempotencia que PayPal usa para no duplicar planes. Cambiarla haría
  que la siguiente ejecución creara un segundo juego de planes junto a los existentes.
  Hay un test que lo fija (`keeps the idempotency keys on their original prefix`).

**Estado de sesión y de navegador — cambiarlos desloguea o resetea a usuarios vivos:**

- `src/lib/auth/support-cookie.ts:15,50` cookies `wacrm_support_session` y
  `wacrm_support_active` (+ comentario L57). Renombrarlas corta toda sesión de soporte
  en curso y el middleware dejaría de verlas.
- `src/lib/auth/impersonation.ts:105` `'wacrm:support-session:v1'` — cadena de separación
  de dominio dentro del HMAC. Cambiarla invalida todos los tokens de soporte firmados.
- `src/lib/themes.ts:28,48` `wacrm.theme` / `wacrm.mode`, `src/app/(dashboard)/inbox/page.tsx:28`
  `wacrm:inbox:contact-panel-open`, `src/components/flows/flow-editor-shell.tsx:50`
  `wacrm.flowEditor.view`. Claves de `localStorage`: cambiarlas perdería la preferencia
  guardada de cada usuario (tema, modo, panel abierto, vista del editor).

**Dominio de terceros / repositorio:**

- `src/app/api/account/invitations/route.ts:67,72,135` — `https://wacrm.tech` es el
  dominio del sitio de marketing (otro repositorio), usado como último recurso cuando no
  se puede derivar la URL base. Es una dirección real, no un texto de marca; cambiarla
  apuntaría a un dominio que no existe. Fuera del alcance de S-P1.
- `docs/docker.md:305,307` `-t wacrm .` y `… 3000:3000 wacrm` — etiqueta de la imagen
  Docker, alineada con el `name` de `package.json`, que S-P1 congela explícitamente.

**Comentarios de código que nombran el proyecto (no se compilan a nada visible):**
`src/app/api/whatsapp/config/route.ts:360`, `src/components/settings/invite-member-dialog.tsx:232`,
`src/components/flows/shared.tsx:75`, `src/components/billing/checkout-return.tsx:132`,
`src/lib/billing/paypal.ts:213`, `src/lib/whatsapp/template-webhook.ts:24`.
Se dejaron tal cual para no inflar el diff; son prosa interna sobre «el proyecto», no
sobre «la marca». Si el humano prefiere unificarlos, es un `sed` aparte sin riesgo.

**Fixtures de test** (`*.test.ts(x)`): `paypal-bootstrap-catalog.test.ts`,
`paypal.test.ts`, `use-auth.test.tsx`, `invitations.test.ts`, `keys.test.ts`,
`support-session-view.test.ts`, `tenant-isolation.test.ts`, `middleware.test.ts`,
`registration.test.ts`, `deliver.test.ts`, `api-context.test.ts`,
`v1/webhooks/route.test.ts`. Todos son valores de entrada que ejercitan los
identificadores técnicos de arriba (prefijos de clave, nombres de cookie, dominios de
ejemplo, `requestId`). Cambiarlos desalinearía los tests de lo que el código produce.
`src/i18n/brand.test.ts:18` contiene la expresión `/wa\s?crm/i` a propósito: es la que
detecta la regresión.

## Variables de entorno

Ninguna nueva. `PAYPAL_PRODUCT_NAME` ya existía; sólo cambia su **valor por defecto**
(`wacrm` → `Cabbity CRM`), documentado en `docs/docker.md` L174 y en el CHANGELOG,
con la nota de que quien ya tenga catálogo debe fijar `PAYPAL_PRODUCT_NAME=wacrm` para
seguir reutilizando el producto existente.

`.env.local.example` está bloqueado por permisos y **no se tocó**; tampoco hacía falta,
porque no hay variables nuevas y el archivo no fija valores por defecto de esta.

## Deuda detectada fuera de alcance (no arreglada)

1. **Deriva de formato.** `src/app/layout.tsx` y
   `src/components/settings/invite-member-dialog.tsx` no pasan `prettier --check` en
   `main`. No es de esta feature y arreglarlo aquí habría enterrado el rebrand en ruido
   de formato. Merece un `chore:` propio que pase prettier a todo el repo de una vez.
2. **El nombre del producto no tiene una única fuente.** Hoy vive repartido en el
   metadata, dos catálogos, una constante de la ruta de checkout y una del script de
   PayPal. Los tests nuevos cubren los cuatro sitios, pero un `BRAND` exportado desde
   `src/lib/` sería más barato de mantener. Fuera del alcance de §1.
3. **`CHECKPOINTS.md` CP6 sigue exigiendo sólo `en` + `ko`.** Correcto para esta
   feature; lo cambia p6.4 según S-P3.
4. **`src/lib/ai/handoff-message.ts`** no menciona la marca (lo verifiqué: el mensaje de
   transición por defecto es genérico), pero su comentario afirma «the product ships `en`
   and `ko` catalogues, `en` is the default locale». Eso dejará de ser cierto con p6.4.

## Fuera de alcance verificado (no hacía falta tocarlo)

- **Correos.** La aplicación no envía ninguno: las invitaciones se comparten como enlace
  copiable o mensaje de WhatsApp (`invite-member-dialog.tsx`); los correos de
  autenticación los emite Supabase con sus propias plantillas, fuera del repositorio.
- **Onboarding.** No hay texto de onboarding que nombre el producto
  (`grep -rln onboard src messages` sólo da la ruta de configuración de WhatsApp y las
  plantillas de flujos, ninguna con la marca).
- **Mensaje por defecto de la IA.** `DEFAULT_HANDOFF_MESSAGE` es «Thanks for writing to
  us. A member of our team will continue this conversation shortly.» — no nombra el
  producto, así que el spec («si lo menciona») no aplica.
- **`package.json` `name`, `project_id` de Supabase, nombres de tablas, rutas.** Intactos
  por S-P1.
