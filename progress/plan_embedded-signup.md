# Plan f4.1 `embedded-signup` + f4.2 `multi-number`

Pase de diseño (agente Plan, Opus, solo lectura) del 2026-09-11 sobre el worktree
`.claude/worktrees/integracion`, rama `saas/integracion`, HEAD `9680b68` (fases 0+1+2).
El agente no tenía herramientas de escritura; el líder persistió el texto tal cual.

## 0. Estado del terreno (hechos verificados, no supuestos)

- La migración **015 no tiene RPC ni funciones**: solo añade tres columnas (`registered_at`, `subscribed_apps_at`, `last_registration_error`) y un índice parcial. Las "dos llamadas" que menciona la spec son **TypeScript**: `registerPhoneNumber()` (`src/lib/whatsapp/meta-api.ts` L123) y `subscribeWabaToApp()` (L167), ya llamadas desde `POST /api/whatsapp/config`. El implementer no debe buscar `SELECT ... FROM rpc`.
- El `UNIQUE(account_id)` lo pone **017** (`supabase/migrations/017_account_sharing.sql` L319–327, constraint `whatsapp_config_account_id_key`). Aparte existe **013**, `UNIQUE(phone_number_id)` global (`whatsapp_config_phone_number_id_key`) — **esa no se toca**: es lo que garantiza que el webhook resuelva un único dueño por número.
- `graphify affected "whatsapp_config"` devuelve `No unique node match` y `graphify explain` da grado 1. Es la limitación documentada en `CLAUDE.md`: el esquema es una isla sin aristas hacia TS. **El censo de consultas de abajo sale de grep y es la fuente de verdad**; no se puede delegar en graphify.
- `verifyMetaWebhookSignature` (`src/lib/whatsapp/webhook-signature.ts`) ya usa `META_APP_SECRET` global y falla cerrado. **No necesita ni un cambio.**
- El camino corto de f2.4 (`META_WEBHOOK_VERIFY_TOKEN`) ya está en `webhook/route.ts` L130–157; el bucle vive en L160–212.
- `src/lib/billing/enforce.ts` (`assertStockLimit`, métrica `numbers`) **no existe en esta rama**: llega con el merge de fase 3. Ver §7.

### Censo completo de consultas a `whatsapp_config` (23 sitios)

| Archivo | Línea | Forma actual | Qué pasa con multi-número |
|---|---|---|---|
| `src/app/api/whatsapp/webhook/route.ts` | 163 | `select('id, verify_token')` sin filtro | bucle de verificación — §5 |
| " | 196 | `update(verify_token)` por `id` | escritura desde GET no autenticado — se retira, §5 |
| " | 313 | `.eq('phone_number_id', …)` | **ya correcto**, no cambia. Ver §6.3 |
| `src/app/api/whatsapp/config/route.ts` | 89, 276, 371, 463 | `.eq('account_id').maybeSingle()` / `update`/`delete` por cuenta | → lista / por `id` |
| " | 214 | conflicto por `phone_number_id` entre cuentas | **se conserva tal cual** |
| `src/app/api/whatsapp/config/verify-registration/route.ts` | 59 | `.eq('account_id').maybeSingle()` | → por `config_id` en query string |
| `src/app/api/whatsapp/broadcast/route.ts` | 126 | `.single()` | → `resolveWhatsAppConfig` con el número de la difusión |
| `src/app/api/whatsapp/react/route.ts` | 93 | `.single()` | → el de la conversación |
| `src/app/api/whatsapp/media/[mediaId]/route.ts` | 53 | `.single()` | → el de la conversación, o el predeterminado |
| `src/app/api/whatsapp/templates/sync/route.ts` | 139 | `.single()` | → predeterminado (§6.7, deuda) |
| `src/app/api/whatsapp/templates/submit/route.ts` | 143 | `.single()` | ídem |
| `src/app/api/whatsapp/templates/[id]/route.ts` | 143, 287 | `.single()` | ídem |
| `src/lib/whatsapp/send-message.ts` | 262 | `.single()` | núcleo — `resolveWhatsAppConfig` |
| " | 280 | `update(access_token)` por `id` | ya por `id`, no cambia |
| `src/lib/whatsapp/broadcast-core.ts` | 118 | `.single()` | por número de la difusión |
| `src/lib/whatsapp/broadcast-resume.ts` | 209 | `.single()` | **debe leer el número de la difusión**, no el predeterminado |
| `src/lib/whatsapp/resolve-conversation.ts` | 59 | `.select('id').maybeSingle()` | «¿hay algún número?» → `limit(1)` |
| `src/lib/flows/meta-send.ts` | 87, 197, 363 | `.single()` | el de la conversación |
| `src/lib/automations/meta-send.ts` | 139 | `.single()` | el de la conversación |
| `src/lib/api/v1/contacts.ts` | 78 | `.select('user_id').maybeSingle()` | `limit(1)` ordenado — solo es un usuario de auditoría |
| `src/components/settings/whatsapp-config.tsx` | `fetchConfig` | `.maybeSingle()` | → lista |
| `src/components/settings/settings-overview.tsx` | 125 | `.maybeSingle()` | → `count` + predeterminado |
| `src/app/(dashboard)/inbox/page.tsx` | 204 | `.select('status').maybeSingle()` | → «¿alguno conectado?» |
| `src/lib/whatsapp/reencrypt.ts` | 26 | tabla entera | no cambia |

**Los ocho `.single()` son el riesgo real**: hoy no fallan porque el UNIQUE garantiza ≤1 fila. Al retirarlo, `.single()` con 2 filas devuelve PGRST116 y **el envío deja de funcionar en toda cuenta con dos números**. Ninguno puede quedarse sin tocar.

---

## 1. f4.1 — Registro integrado, extremo a extremo

### 1.1 Detección de modo (servidor, en runtime)

Nuevo `src/lib/whatsapp/platform-mode.ts`:

```ts
export interface PlatformSignupConfig {
  appId: string
  configId: string
  graphVersion: string   // 'v21.0', alineado con META_API_VERSION de meta-api.ts
}
/** Modo plataforma = las tres variables de servidor presentes y no vacías. */
export function getPlatformSignupConfig(): PlatformSignupConfig | null
```

Lee `META_APP_ID`, `META_CONFIG_ID`, `META_APP_SECRET`, con `.trim()` en las tres (misma razón que f2.4: valores que llegan de un fichero de secretos con salto de línea). Devuelve `null` si falta alguna. `META_APP_SECRET` **no se expone nunca**: solo participa en la decisión.

**Decisión firme: no se usa ninguna variable `NEXT_PUBLIC_*`.** Las `NEXT_PUBLIC_` se inlinean en tiempo de build (`docker-compose.yml` las pasa como build args); un autoalojado que use la imagen publicada no podría activarlas sin reconstruir, y un operador de plataforma tendría que rebuildear para cambiar el `config_id`. En su lugar, el cliente pregunta al servidor:

**`GET /api/whatsapp/embedded-signup`** → `200 { "enabled": true, "app_id": "...", "config_id": "...", "graph_version": "v21.0" }` o `200 { "enabled": false }`. Requiere sesión (`requireRole('admin')`); `app_id` y `config_id` son públicos por diseño (viajan en la URL del diálogo de Meta), `app_secret` no sale jamás.

### 1.2 Flujo en el navegador

Nuevo componente cliente `src/components/settings/embedded-signup-button.tsx`.

1. Al montar: `fetch('/api/whatsapp/embedded-signup')`. Si `enabled === false`, el componente devuelve `null` (el formulario manual es lo único que se ve).
2. Carga del SDK con **`next/script`** — API verificada en `node_modules/next/dist/docs/01-app/03-api-reference/02-components/script.md` (props `src`, `strategy`, `onLoad`, `onReady`, `onError`; `afterInteractive` es el valor por defecto y el correcto aquí — `beforeInteractive` solo vale en `app/layout.tsx` y no queremos el SDK de Meta en todas las páginas). Ya hay precedente de `next/script` en `src/app/layout.tsx` L5.

```tsx
<Script
  src="https://connect.facebook.net/en_US/sdk.js"
  strategy="afterInteractive"
  onLoad={() => {
    window.FB.init({ appId, cookie: true, xfbml: false, version: graphVersion })
    setSdkReady(true)
  }}
  onError={() => setSdkError(true)}
/>
```

3. Escucha del evento de sesión **antes** de abrir el diálogo, con `useEffect` que registra y **desregistra** el listener:

```ts
function onMessage(ev: MessageEvent) {
  if (ev.origin !== 'https://www.facebook.com' && ev.origin !== 'https://web.facebook.com') return
  let payload: unknown
  try { payload = JSON.parse(ev.data as string) } catch { return }   // el SDK emite mensajes no-JSON
  const m = payload as { type?: string; event?: string; data?: Record<string, string> }
  if (m.type !== 'WA_EMBEDDED_SIGNUP') return
  if (m.event === 'FINISH') sessionRef.current = { phoneNumberId: m.data?.phone_number_id, wabaId: m.data?.waba_id }
  if (m.event === 'CANCEL') cancelRef.current = m.data?.current_step ?? 'unknown'
  if (m.event === 'ERROR')  errorRef.current  = m.data?.error_message ?? 'unknown'
}
```

Se guarda en `useRef`, no en estado: el callback de `FB.login` se dispara inmediatamente después y un `setState` no se habría propagado.

4. Apertura del diálogo:

```ts
window.FB.login(cb, {
  config_id: configId,
  response_type: 'code',
  override_default_response_type: true,   // sin esto Meta devuelve un token de usuario, no el código
  extras: { setup: {}, featureType: '', sessionInfoVersion: '3' },
})
```

5. Callback: `response.authResponse?.code` es lo único que importa.

### 1.3 `POST /api/whatsapp/embedded-signup` (servidor)

Cuerpo: `{ code, phone_number_id, waba_id }`. Los tres obligatorios (si Meta dio código pero el evento de sesión no llegó, 400 con mensaje accionable: «cierra y vuelve a intentarlo»).

Orden exacto de pasos, con qué hace cada fallo:

| # | Paso | Fallo ⇒ |
|---|---|---|
| 0 | `requireRole('admin')` + `checkRateLimit('embedded-signup:'+userId, { limit: 10, windowMs: 60_000 })` (bucket nuevo en `RATE_LIMITS`) | 403 / 429 |
| 1 | `getPlatformSignupConfig()`; si `null` → 404 `{ error: 'embedded_signup_disabled' }` | el modo autoalojado no expone la ruta |
| 2 | Conflicto entre cuentas: `supabaseAdmin().from('whatsapp_config').select('account_id').eq('phone_number_id', …).neq('account_id', accountId).maybeSingle()` — **copiado literal de `config/route.ts` L214**, mismo 409 y mismo texto | 409 |
| 3 | Tope de existencias `numbers` (§7) **solo si el par `(account_id, phone_number_id)` es nuevo** | 402 |
| 4 | **Intercambio de código**: `GET https://graph.facebook.com/{v}/oauth/access_token?client_id={META_APP_ID}&client_secret={META_APP_SECRET}&code={code}` — sin `redirect_uri` (Embedded Signup no lo usa) | 400, nada persistido |
| 5 | `verifyPhoneNumber({ phoneNumberId, accessToken })` → `display_phone_number`, `verified_name`, `quality_rating` | 400, nada persistido |
| 6 | `subscribeWabaToApp({ wabaId, accessToken })` → `subscribed_apps_at` | se registra el error, **no aborta** (mismo criterio que hoy) |
| 7 | `registerPhoneNumber({ phoneNumberId, accessToken, pin })` con PIN generado (§1.5) → `registered_at` | se guarda en `last_registration_error`, **no aborta** |
| 8 | `encrypt()` de `access_token` y del PIN (formato versionado de f2.3, sin tocar `encryption.ts`) | 500, nada persistido |
| 9 | `upsert` de la fila (§1.4) | 500 |

**El intercambio de código va en módulo propio**, `src/lib/whatsapp/embedded-signup.ts`, no en `meta-api.ts`: `meta-api.ts` documenta explícitamente que toda función recibe un objeto con parámetros nombrados y **nunca** lee de `process.env` (excepto `template-header-handle.ts`, que es el caso raro). Firma:

```ts
export interface ExchangeCodeArgs { code: string; appId: string; appSecret: string; graphVersion: string }
export interface ExchangedToken { accessToken: string; expiresAt: string | null }
export async function exchangeCodeForToken(args: ExchangeCodeArgs): Promise<ExchangedToken>
```

Traduce `expires_in` (segundos, normalmente ausente en tokens de integración de negocio) a `expiresAt` ISO o `null`. Nunca registra el `code` ni el token en consola; en el catch, solo `error.message` de Meta.

### 1.4 Qué se guarda y en qué columna

| Columna | Origen | Nota |
|---|---|---|
| `account_id` | `requireRole('admin')` | clave de inquilino |
| `user_id` | el admin que abrió el diálogo | auditoría (NOT NULL FK) |
| `phone_number_id` | evento `WA_EMBEDDED_SIGNUP` `data.phone_number_id` | |
| `waba_id` | evento `data.waba_id` | |
| `access_token` | `encrypt(exchange.accessToken)` | versionado f2.3 |
| `verify_token` | **`NULL` siempre** | el webhook es de app; §5 |
| `display_phone_number` | `verifyPhoneNumber()` | **columna nueva** (053) |
| `verified_name` | `verifyPhoneNumber()` | **columna nueva** (053) |
| `registration_pin` | `encrypt(pin)` | **columna nueva** (054) |
| `token_expires_at` | `exchange.expiresAt` | **columna nueva** (054), nullable |
| `provisioned_via` | `'embedded_signup'` | **columna nueva** (054); `'manual'` por defecto |
| `registered_at` / `subscribed_apps_at` / `last_registration_error` | pasos 6–7 | ya existen (015) |
| `status` / `connected_at` | `'connected'` / `now()` | credenciales validadas contra Meta |
| `is_default` | `true` si la cuenta no tenía ninguno | **columna nueva** (053) |

**No se guarda**: el `code` (de un solo uso), el `business_id` (no lo necesita ninguna consulta; añadirlo sería una llamada extra a Graph sin consumidor).

### 1.5 El PIN

Los números creados por Embedded Signup **no traen verificación en dos pasos**, así que `POST /{phone_number_id}/register` exige un PIN que elegimos nosotros. Decisión: **generarlo en el servidor** con `crypto.randomInt(0, 1_000_000)` formateado a seis dígitos con ceros a la izquierda, y **guardarlo cifrado** en `registration_pin`. Sin guardarlo, una re-registración futura (cambio de app, recuperación) sería imposible sin que el cliente pase por el soporte de Meta. Es un secreto más, del mismo nivel que el token, y ya tiene el mecanismo de cifrado y de rotación.

Si el negocio ya tenía 2FA con su propio PIN, `registerPhoneNumber` falla con un mensaje claro de Meta; se guarda en `last_registration_error` y la UI muestra el campo de PIN manual que ya existe (`Settings.whatsapp.twoStepPin`) para reintentar por `POST /api/whatsapp/config`. **No se reintenta automáticamente.**

### 1.6 Si el usuario cierra el diálogo

Tres desenlaces, los tres sin ninguna escritura:

1. **`CANCEL`** — el evento trae `data.current_step`. El callback de `FB.login` llega sin `code`. El componente muestra un `toast.info` con el paso (clave i18n `signupCancelled`, con `{step}`) y **no llama al servidor**. Nada se persiste.
2. **`ERROR`** — `data.error_message` en un `toast.error`. Nada se persiste.
3. **Cierre de la ventana emergente sin evento** — `FB.login` devuelve `{ status: 'unknown' }` y ningún `authResponse`. Mensaje genérico («no se completó la conexión»). Nada se persiste.

Caso borde que hay que tratar explícitamente: **evento `FINISH` recibido pero sin `code`** (el usuario cerró la ventana justo al terminar). Tenemos `phone_number_id` y `waba_id` pero no podemos acuñar token. **No se escribe una fila a medias** — sería una configuración que aparece conectada y no envía nada. Se muestra «casi listo, vuelve a pulsar Conectar» y se descarta la sesión.

### 1.7 Idempotencia si repite el flujo

La escritura es **un solo `upsert` con `onConflict: 'account_id,phone_number_id'`** contra el índice único que crea la 053:

```ts
await supabase.from('whatsapp_config').upsert(row, { onConflict: 'account_id,phone_number_id' })
```

- Mismo número otra vez ⇒ una fila, token nuevo (el anterior sigue siendo válido en Meta; no lo revocamos), `registered_at`/`subscribed_apps_at` refrescados, `last_registration_error` a `NULL`. `is_default` **no** se toca en el update (el upsert escribe solo las columnas del objeto; se omite `is_default` cuando la fila ya existe, resolviéndolo con un `select` previo de una sola columna).
- Número distinto ⇒ fila nueva, la cuenta pasa a tener dos números (que es exactamente lo que f4.2 habilita).
- Número de otra cuenta ⇒ cortado en el paso 2 con 409, antes de gastar el código.
- `POST` concurrentes con el mismo número ⇒ el índice único los serializa; el segundo actualiza en vez de duplicar.

**Sin la 053 el upsert no tiene destino de conflicto** (`(account_id, phone_number_id)` no es único) y Postgres rechaza la sentencia. Es la razón dura del orden de §8.

### 1.8 El webhook a nivel de app

**No es código.** Se configura una vez en el panel de Meta (App → WhatsApp → Configuration → Webhook): URL `https://<dominio>/api/whatsapp/webhook`, token de verificación = el valor de `META_WEBHOOK_VERIFY_TOKEN`, campos suscritos `messages` y `message_template_status_update` (este segundo ya lo consume `handleTemplateWebhookChange`). El `GET` de f2.4 ya responde a esa verificación sin tocar la base. Va en el guion manual (§10) y en `docs/docker.md`.

---

## 2. Convivencia con el modo autoalojado (S5)

| | Plataforma | Autoalojado |
|---|---|---|
| Variables | `META_APP_ID` + `META_CONFIG_ID` + `META_APP_SECRET` + `META_WEBHOOK_VERIFY_TOKEN` | `META_APP_SECRET` (y opcionalmente `META_APP_ID` para plantillas con cabecera de imagen) |
| Botón «Conectar WhatsApp» | visible | **ausente** (`GET` devuelve `enabled:false` y el componente devuelve `null`) |
| Formulario manual (id de número, WABA, token, PIN) | **colapsado** dentro de un `<Accordion>` rotulado «conexión manual (avanzado)» — no se retira: es la vía de recuperación cuando el diálogo falla y la que usa el soporte | desplegado, tal cual hoy |
| Campo «token de verificación del webhook» | oculto, no se envía, se guarda `NULL` | visible, igual que hoy |
| Tarjeta «URL del webhook» con el botón de copiar | oculta (Meta ya lo tiene a nivel de app) | visible |
| `POST /api/whatsapp/embedded-signup` | operativo | **404** |
| Bucle de verificación del `GET` | nunca se ejecuta (camino corto de f2.4) | única vía |

Una sola bandera en el cliente (`enabled` del `GET`) gobierna las cinco diferencias. Nada de detectar modo en el cliente por su cuenta.

### `verifyMetaWebhookSignature` con `META_APP_SECRET` global es correcto en ambos modos

- **Plataforma**: todas las WABA de todos los inquilinos están suscritas a **nuestra** app (paso 6 de §1.3). Meta firma cada POST con el secreto de la app dueña de la suscripción, que es la nuestra, para todos. Un secreto verifica todo. La incoherencia que denuncia la spec desaparece por construcción: ya no hay inquilinos con token de app propia.
- **Autoalojado**: hay una app y un inquilino. El secreto es el de esa app.
- **Mezcla** (una instancia en modo plataforma donde queda una fila antigua con token de la app del cliente): sus webhooks se rechazan con 401, ruidosamente, en el log. **Es lo correcto y hay que documentarlo** como paso de migración: al pasar una instancia de autoalojado a plataforma, cada inquilino tiene que volver a conectar por el diálogo.

**La función no se toca.** Lo único que se añade es el test del criterio 3 (§9).

---

## 5. Código muerto: el bucle del token de verificación

`src/app/api/whatsapp/webhook/route.ts` L160–212. Qué se hace y qué no:

**Lo que NO se puede retirar mientras S5 esté en pie**: el bucle en sí. En autoalojado no hay `META_WEBHOOK_VERIFY_TOKEN` y es el único camino. Borrarlo rompería el criterio de aceptación 5.

**Lo que SÍ se retira en f4.1** (tres cambios, todos con test):

1. **La reescritura oportunista a GCM** (L191–207). Es una **escritura en la base disparada por un `GET` no autenticado** — cualquiera que adivine un token de verificación provoca un `UPDATE`. Con el anillo de claves de f2.3 `decrypt()` ya lee el formato heredado sin ayuda, y `scripts/reencrypt-secrets.ts` es el camino soportado para reescribir. Se borra el bloque y el `import { encrypt, isLegacyFormat }` queda reducido a `decrypt` (comprobar que `encrypt` no se usa en otro punto del archivo antes de quitarlo del import).
2. **Acotar la consulta**: `select('id, verify_token').not('verify_token', 'is', null).limit(200)`. En autoalojado hay una fila; el `limit` es un tope de seguridad para el caso mixto. Se registra un `console.warn` si se alcanza.
3. **Marcar el camino**: comentario de bloque encabezado `SELF-HOSTED ONLY (S5)` que explique que en modo plataforma este código es inalcanzable y que se borra el día que se retire el autoalojado.

Además, en modo plataforma se deja de **escribir** `verify_token`: `POST /api/whatsapp/embedded-signup` lo fija a `NULL` y la UI no ofrece el campo. Las filas antiguas conservan el suyo, inofensivo.

**Riesgo a nombrar**: `progress/impl_platform-verify-token.md` y `docs/docker.md` ya describen `META_WEBHOOK_VERIFY_TOKEN` como opcional. Con f4.1, en modo plataforma pasa a ser **obligatorio de facto** (sin él, el `GET` cae al bucle y ninguna configuración tiene token ⇒ 403 ⇒ Meta no verifica el webhook de app). `getPlatformSignupConfig()` **no** lo exige (son cosas distintas), pero el `GET /api/whatsapp/embedded-signup` debe devolver `enabled: true` con un `warning: 'missing_verify_token'` cuando `META_CONFIG_ID` está y `META_WEBHOOK_VERIFY_TOKEN` no, y la UI lo pinta como aviso para el operador. Y va en `docs/docker.md`.

---

## 6. f4.2 — Multi-número

### 6.1 Migración `053_whatsapp_config_multi_number.sql`

Números 046–052 están tomados por fase 3 (algunos aún no fusionados en esta rama: en el worktree solo se ven hasta la 051). **El implementer comprueba primero** `ls supabase/migrations/` en `saas/integracion` tras el merge de fase 3 y confirma que 053 sigue libre.

Contenido, en este orden:

1. `ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;`
2. `CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_account_phone_key ON whatsapp_config(account_id, phone_number_id);`
   Es redundante con el `UNIQUE(phone_number_id)` de 013 en términos de garantía, pero **hace falta igual**: es el `ON CONFLICT` destino del upsert de §1.7, y expresa la invariante en la forma que la lee el código. Comentario en el archivo explicándolo, para que nadie lo "simplifique" luego.
3. Columnas nuevas, todas `ADD COLUMN IF NOT EXISTS`:
   - `is_default BOOLEAN NOT NULL DEFAULT FALSE`
   - `display_phone_number TEXT`
   - `verified_name TEXT`
   - `label TEXT` — nombre que pone el usuario al número («Ventas», «Soporte»); cae de vuelta a `verified_name` → `display_phone_number` → `phone_number_id` en la UI.
4. `CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_one_default_per_account ON whatsapp_config(account_id) WHERE is_default;` — un solo predeterminado por cuenta, garantizado por la base, no por la aplicación.
5. Relleno: `UPDATE whatsapp_config SET is_default = TRUE WHERE is_default = FALSE AND id IN (SELECT DISTINCT ON (account_id) id FROM whatsapp_config ORDER BY account_id, created_at ASC);` — idempotente y respeta el índice parcial.
6. `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL;` — **`SET NULL`, jamás `CASCADE`** (CP2: borrar un número no puede borrar conversaciones). `CREATE INDEX ... ON conversations(whatsapp_config_id)`.
7. `ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL;`
8. Relleno de ambas: `UPDATE conversations c SET whatsapp_config_id = w.id FROM whatsapp_config w WHERE w.account_id = c.account_id AND c.whatsapp_config_id IS NULL AND w.is_default;` (ídem `broadcasts`). Es seguro porque antes de esta migración había como mucho un número por cuenta.

**RLS**: las políticas de 017 (L419–424) filtran por `is_account_member(account_id)`, no por unicidad. **No cambian.**

**`supabase/ci/verify-schema.sql`**: una aserción por objeto nuevo, dentro del único bloque `DO $$` (el archivo avisa por escrito de que no se puede añadir una segunda sentencia de nivel superior):
- `whatsapp_config_account_id_key` ya **no** existe en `pg_constraint`;
- `whatsapp_config_account_phone_key`, `whatsapp_config_one_default_per_account` existen (`to_regclass`);
- `conversations.whatsapp_config_id` y `broadcasts.whatsapp_config_id` existen y su FK es `ON DELETE SET NULL` (`confdeltype = 'n'`);
- `whatsapp_config_phone_number_id_key` **sigue** existiendo (regresión que costaría muy cara).

`scripts/replay-migrations.sh <worktree>` tiene que salir 0.

### 6.2 El resolvedor único

Nuevo `src/lib/whatsapp/resolve-config.ts` + `.test.ts`. **Todos** los sitios de la tabla de §0 pasan por aquí (salvo el webhook, que ya resuelve por `phone_number_id`).

```ts
export interface ResolveArgs {
  accountId: string
  /** Elección explícita del llamante (selector de la UI, `from` de /api/v1). */
  configId?: string | null
  /** Número por el que el cliente escribió; gana sobre el predeterminado. */
  conversationId?: string | null
  /** El sitio necesita el token descifrado. */
  withToken?: boolean
}
export async function resolveWhatsAppConfig(db, args): Promise<WhatsAppConfigRow>
```

**Orden de resolución, fijo y no negociable:**

1. `configId` explícito → `select('*').eq('id', configId).eq('account_id', accountId).maybeSingle()`. **El `.eq('account_id')` es obligatorio** (CP3: `db` puede ser el cliente de rol de servicio). Si no aparece: error `whatsapp_number_not_found`, 404.
2. `conversationId` → `conversations.whatsapp_config_id`, y desde ahí la fila por `id` + `account_id`. Si la columna es `NULL` (conversación anterior a la 053 en una cuenta sin predeterminado), se cae al paso 3.
3. Predeterminado: `.eq('account_id', accountId).eq('is_default', true).maybeSingle()`.
4. Único superviviente: `.eq('account_id', accountId).order('created_at').limit(1)` — red de seguridad si alguien borró el predeterminado por SQL.
5. Nada → `SendMessageError('whatsapp_not_configured', …, 400)` con **el mismo texto literal que hoy** (hay tests y traducciones que dependen de él).

`withToken: true` añade `decrypt(row.access_token)` y conserva la auto-reparación de CBC→GCM por `id` que ya hace `send-message.ts` L280 (esa sí se queda: viene de un camino autenticado).

Errores: reutiliza `SendMessageError` en el núcleo de envío y `BroadcastError` en difusiones — el resolvedor lanza un tipo propio `WhatsAppConfigError` y cada llamante lo remapea, para no atar `resolve-config.ts` a la familia de errores de envío.

### 6.3 Recepción: ya funciona, solo hay que sellar

`webhook/route.ts` L313 resuelve por `phone_number_id` y ya trata `length > 1` como error explícito (que sigue siendo imposible gracias a la 013). **Este bloque no se toca.** Lo que se añade, en `processMessage`, al encontrar o crear la conversación: sellar `conversations.whatsapp_config_id = config.id`.

- Conversación nueva ⇒ se inserta con la columna puesta.
- Conversación existente con `whatsapp_config_id` distinto (el cliente escribió a otro número de la misma empresa) ⇒ **se actualiza al número del mensaje entrante**. Consecuencia deliberada: la respuesta sale por el número al que escribió el cliente, que es lo único correcto desde el punto de vista del usuario final.

**Decisión de alcance, explícita:** el índice único `(account_id, contact_id)` de la migración **036 se mantiene**. Un contacto que escribe a dos números de la misma empresa sigue teniendo **una** conversación, no dos. Partirla en `(account_id, contact_id, whatsapp_config_id)` reintroduciría exactamente la ambigüedad de lectura que 036 arregló (issue #363) y obligaría a revisar cada `.eq('contact_id')` del repositorio. Queda anotado como deuda en el informe. El criterio «recibe correctamente en todos» se cumple igualmente: todo mensaje entrante a cualquier número de la cuenta se guarda y aparece en la bandeja.

### 6.4 Envío

- **`sendMessageToConversation`** (`send-message.ts` L262): sustituye el `.single()` por `resolveWhatsAppConfig(db, { accountId, conversationId, configId: args.whatsAppConfigId, withToken: true })`. El parámetro nuevo es opcional; por defecto gana el número de la conversación.
- **`/api/whatsapp/send`**: acepta `whatsapp_config_id` opcional en el cuerpo y lo pasa. La bandeja no lo manda (la conversación ya lo sabe); lo manda el camino «contacto → enviar plantilla», donde aún no hay hilo.
- **`/api/v1/messages`**: parámetro nuevo **`from`** (un `phone_number_id`, no un UUID interno — un cliente de API externo no conoce nuestros UUID). Se traduce a `configId` con un `select('id').eq('account_id').eq('phone_number_id', from)`. Si no coincide: `fail('bad_request', "'from' is not a connected number", 400)`. Documentar en `docs/public-api.md`.
- **`resolve-conversation.ts` L59**: la comprobación «¿hay WhatsApp?» pasa a `limit(1)`; y al **crear** la conversación se sella `whatsapp_config_id` con el resuelto (explícito o predeterminado).
- **`flows/meta-send.ts` (×3) y `automations/meta-send.ts`**: los motores conocen `conversationId`; se resuelve por conversación. Es lo correcto: una automatización responde por el número por el que entró el mensaje.
- **`react/route.ts`** y **`media/[mediaId]/route.ts`**: por conversación. En `media` hay que pasarle el `conversation_id` (hoy no lo recibe) — alternativa más barata y suficiente: resolver por el `messages.conversation_id` del medio si la ruta lo tiene a mano; si no, predeterminado con comentario. **Decisión: predeterminado**, porque el token de cualquier número de la misma WABA descarga cualquier medio de esa WABA; solo falla si la cuenta tiene números en WABA distintas, y eso se anota como deuda.

### 6.5 Difusiones

- `broadcasts.whatsapp_config_id` se fija **al crear** la difusión, desde el selector del asistente (`src/components/broadcasts/step4-schedule-send.tsx`, hook `src/hooks/use-broadcast-sending.ts`). Si no se elige, el predeterminado.
- `broadcast-core.ts` L118 y `broadcast-resume.ts` L209 resuelven **por `broadcast.whatsapp_config_id`**, nunca por el predeterminado. Es el punto más fácil de equivocar: reanudar una difusión por un número distinto del que la empezó rompe la ventana de 24 h y contamina la calidad de los dos números. Test dedicado.
- Si el número de una difusión se borró (`SET NULL`), reanudar da `BroadcastError('whatsapp_not_configured', …)` con texto que nombre la causa. Test.

### 6.6 UI de configuración

`src/components/settings/whatsapp-config.tsx` (921 líneas) pasa de «un formulario» a «una lista + un formulario»:

- Cabecera: botón «Conectar WhatsApp» (f4.1, solo en plataforma) y/o «Añadir número» (abre el formulario manual vacío).
- Una tarjeta por fila de `whatsapp_config`, ordenadas `is_default DESC, created_at ASC`: etiqueta, `display_phone_number`, insignia «predeterminado», estado de conexión, estado de registro (`registered_at` / `last_registration_error`), botones **Verificar** (llama a `verify-registration?config_id=…`), **Hacer predeterminado**, **Editar**, **Eliminar**.
- El bloque «Estado de registro», el interruptor de espejo de multimedia (`mirror_inbound_media`) y el diagnóstico se mueven **dentro** de cada tarjeta.
- El `ref` `loadedAccountIdRef` que evita re-hidratar el formulario cuando Supabase refresca el token se conserva; ahora protege también el formulario de «añadir».
- «Hacer predeterminado» ⇒ `PATCH /api/whatsapp/config/[id]` con `{ is_default: true }`. El servidor pone el resto a `false` y el nuevo a `true` **en una función SQL** o en dos escrituras ordenadas (primero limpiar, luego marcar) — el índice parcial rechazaría el orden inverso.
- `settings-overview.tsx` L125: `count` de números + el predeterminado para la etiqueta.
- `inbox/page.tsx` L204: `.eq('status','connected').limit(1)` → «hay al menos uno conectado».

Rutas nuevas/cambiadas de configuración:
- `GET /api/whatsapp/config` → `{ connected: boolean, numbers: [{ id, phone_number_id, display_phone_number, label, is_default, status, registered_at, last_registration_error }], phone_info }` (`phone_info` = el del predeterminado, para no romper a `settings-overview.tsx`).
- `POST /api/whatsapp/config` → si el cuerpo trae `config_id`, actualiza esa fila; si no, hace upsert por `(account_id, phone_number_id)`.
- `DELETE /api/whatsapp/config?id=…` → borra **una** fila. Sin `id` (llamada antigua), 400: borrar todos los números por error sería catastrófico.
- `GET /api/whatsapp/config/verify-registration?config_id=…` → sin parámetro, el predeterminado.

Cada uno de esos manejadores filtra por `account_id` **además** de por `id`, y lleva test de fuga entre dos cuentas (CP3).

### 6.7 Plantillas: alcance recortado, a propósito

`message_templates` es **por WABA** en Meta, y localmente tiene `UNIQUE(account_id, name, language)`. Una cuenta con dos números **en la misma WABA** (el caso normal) no tiene ningún problema: la misma plantilla vale para los dos. Dos números **en WABA distintas** sí lo tienen, y arreglarlo bien exige una columna `waba_id` en `message_templates` y repensar la unicidad.

**Decisión: fuera de alcance.** Las cuatro consultas de las rutas de plantillas resuelven al **predeterminado**, con un comentario que nombra la limitación, y queda anotado como deuda en `progress/impl_multi-number.md`. Añadirlo aquí duplicaría el tamaño de la feature y no lo pide ningún criterio de aceptación.

---

## 7. El tope `numbers` de f3.4

`assertStockLimit(accountId, 'numbers', 1)` cuenta filas de `whatsapp_config`. Hoy el `UNIQUE(account_id)` lo deja en 0 o 1 y ningún plan puede tocarlo. **Al retirar el UNIQUE pasa a ser real.** (Nota del líder: la ronda final de f3.4, commit `08bc791`, ya corrigió que el tope no cuente la fila que se edita; f4.2 debe conservar esa semántica en los dos puntos de escritura y añadir los tests de abajo si no existen.)

Regla en los dos puntos de escritura (`POST /api/whatsapp/config` y `POST /api/whatsapp/embedded-signup`):

```ts
const isNewNumber = !(await existsRow(accountId, phone_number_id))
if (isNewNumber) await assertStockLimit(accountId, 'numbers', 1)
```

Reconectar o rotar el token de un número ya existente **no consume cupo**. Dos tests: (a) una cuenta con `numbers: 1` y un número ya conectado puede re-guardar ese mismo número; (b) la misma cuenta recibe 402 `plan_limit_reached` al intentar un segundo número distinto, con `metric`, `limit`, `used` y `upgradeUrl`.

**Dependencia dura**: `src/lib/billing/enforce.ts` llega con el merge de fase 3 en `saas/integracion`. Recomendación: lanzar f4.2 **después** del merge de fase 3.

---

## 8. Orden: f4.2 antes que f4.1

**Recomendación: f4.2 primero, f4.1 después.** Cuatro razones, la primera es suficiente por sí sola:

1. **El upsert idempotente de f4.1 (§1.7) necesita el índice `(account_id, phone_number_id)` de la 053.** Sin él no hay destino de `ON CONFLICT` y la única alternativa es un `select`-then-`insert/update` con condición de carrera — que luego habría que reescribir.
2. Si f4.1 va primero, su `POST` tiene que escribir contra `UNIQUE(account_id)`: conectar un segundo número dispararía 23505 con un mensaje incomprensible. El código se escribiría dos veces.
3. Los ~15 sitios que f4.2 migra los tocaría f4.1 a ciegas (el registro integrado es precisamente lo que produce cuentas con varios números).
4. f4.2 no depende de nada de f4.1: el formulario manual ya existe y basta para probarlo de principio a fin, sin app de Meta en producción ni revisión de permisos aprobada. **Es la feature que se puede terminar hoy**, mientras el trámite con Meta (vía paralela de la spec) sigue su curso.

**Reparto: dos features, en este orden.** f4.2 y f4.1 son entregables independientes, cada uno con su compuerta y su informe. Fundirlas daría un diff de ~35 archivos imposible de revisar con criterio, contra CP8.

**Lo que queda fuera de las dos:**
- Partir conversaciones por número (036 se mantiene) — deuda anotada.
- `waba_id` en `message_templates` — deuda anotada.
- Revocar el token antiguo en Meta al reconectar.
- Renovación automática del token con `token_expires_at` (se guarda el dato, no se actúa sobre él).
- Panel de plataforma (f4.3) e impersonación (f4.4).
- Migrar filas heredadas de autoalojado a la app de plataforma.
- Flip de la CSP de `Report-Only` a enforce.

---

## 9. Tests vitest, criterio por criterio

Los cinco criterios de aceptación de la §1 de la fase 4, cada uno con su prueba (CP4). Los tests van junto al código, con el patrón `vi.hoisted` + `vi.mock('@supabase/supabase-js')` que usa `src/app/api/whatsapp/webhook/route.test.ts`.

| # | Criterio | Archivo | Qué prueba |
|---|---|---|---|
| 1 | Conecta sin salir de la app ni tocar la consola de Meta | `src/app/api/whatsapp/embedded-signup/route.test.ts` | Con `code`+`phone_number_id`+`waba_id` y `fetch` simulado: se llama a `oauth/access_token` con `client_id`/`client_secret` de entorno, se guarda una fila con el token **cifrado** (no en claro), `provisioned_via='embedded_signup'` y `verify_token` nulo. Más: repetir el flujo **no crea una segunda fila**; cerrar el diálogo (sin `code`) da 400 y **cero** escrituras; `META_CONFIG_ID` ausente ⇒ 404; el `code` **nunca** aparece en `console.*` |
| 1b | | `src/lib/whatsapp/embedded-signup.test.ts` | `exchangeCodeForToken`: URL y parámetros exactos, `expires_in`→`expiresAt`, error de Meta propagado con su mensaje, cuerpo no-JSON tolerado |
| 2 | La WABA queda suscrita y lo entrante llega a esa empresa | `src/app/api/whatsapp/embedded-signup/route.test.ts` | `subscribeWabaToApp` y `registerPhoneNumber` se llaman con el token **recién intercambiado** (no con uno antiguo) y sus marcas de tiempo se persisten; un fallo de `/register` **guarda igual** la fila con `last_registration_error` |
| 2b | | `src/app/api/whatsapp/webhook/route.test.ts` | Dos cuentas con números distintos: un entrante al número de A crea el mensaje **en A** y ninguna fila en B (test de fuga, CP3); y se sella `conversations.whatsapp_config_id` |
| 3 | La firma funciona con el secreto de nuestra app para todos los inquilinos | `src/lib/whatsapp/webhook-signature.test.ts` | Un cuerpo firmado con `META_APP_SECRET` se acepta **con dos configuraciones de cuentas distintas en la tabla**; firmado con otro secreto se rechaza; sin la variable, se rechaza (regresión de fallo cerrado) |
| 4 | Varios números: envía por el elegido y recibe en todos | `src/lib/whatsapp/resolve-config.test.ts` | Los cinco pasos del orden de resolución; explícito gana a conversación gana a predeterminado; un `configId` de **otra** cuenta da 404 (fuga, CP3); sin filas, el error y el texto de siempre |
| 4b | | `src/lib/whatsapp/send-message.test.ts` | Con dos números, se envía por el de la conversación; con `whatsapp_config_id` explícito, por ese; `.single()` con dos filas **ya no** revienta |
| 4c | | `src/lib/whatsapp/broadcast-resume.test.ts` | Reanudar usa el `whatsapp_config_id` **de la difusión**, no el predeterminado (la misma difusión con otro predeterminado sigue saliendo por el suyo) |
| 4d | | `src/app/api/whatsapp/webhook/route.test.ts` | Dos entrantes a dos números de **la misma** cuenta: los dos se guardan, y la conversación queda sellada con el último |
| 5 | El autoalojado sigue funcionando con app propia | `src/app/api/whatsapp/embedded-signup/route.test.ts` | Sin `META_CONFIG_ID`: `GET` devuelve `{enabled:false}` y `POST` da 404 |
| 5b | | `src/app/api/whatsapp/config/route.test.ts` | El camino manual completo (verificar → cifrar → registrar → suscribir → guardar) sigue verde sin ninguna variable de plataforma; y el tope `numbers` no bloquea re-guardar el número propio |
| 5c | | `src/app/api/whatsapp/webhook/route.test.ts` | Sin `META_WEBHOOK_VERIFY_TOKEN`, el bucle sigue verificando contra el token cifrado de la fila; **y ya no hace `UPDATE`** (aserción sobre `fromCalls`/llamadas de escritura) |

Extra de regresión: `src/lib/security/tenant-isolation.test.ts` gana una entrada por cada ruta nueva (`embedded-signup` GET/POST, `config/[id]` PATCH/DELETE), que es lo que hace que la suite de f2.2 rompa si alguien añade una ruta sin `.eq('account_id')`.

`progress/checks_embedded-signup.sql` y `progress/checks_multi-number.sql` (CP4, lo que exige base real): que el índice parcial impide dos predeterminados en la misma cuenta; que la FK de `conversations.whatsapp_config_id` es `SET NULL` y borrar un número deja las conversaciones vivas; que `UNIQUE(phone_number_id)` global sigue rechazando el mismo número en dos cuentas; que las políticas RLS de 017 siguen dando acceso a los `n` números a cualquier miembro.

---

## 10. Guion manual con Meta real

No hay e2e en este repo y estas dos cosas no se simulan. Va en `progress/impl_<name>.md`:

1. **Trámite previo** (vía paralela de la spec, no es código): verificación de negocio, app en producción, permisos `whatsapp_business_management` + `whatsapp_business_messaging` aprobados, y una **configuración de Embedded Signup** creada en el panel (App → WhatsApp → Embedded Signup) de la que sale el `META_CONFIG_ID`.
2. **Webhook de app**: en el panel, URL `https://<dominio>/api/whatsapp/webhook` + el valor de `META_WEBHOOK_VERIFY_TOKEN`, campos `messages` y `message_template_status_update`. Comprobar que Meta devuelve verde **y** que en el log no aparece ninguna consulta a `whatsapp_config` (el camino corto de f2.4).
3. **Diálogo completo** con una empresa de prueba distinta de la nuestra: conectar, comprobar que la fila queda con `registered_at` y `subscribed_apps_at`, y que un WhatsApp real enviando al número aparece en la bandeja de **esa** cuenta.
4. **Cancelación**: abrir el diálogo y cerrarlo en el paso 2 → verificar que no se creó ninguna fila.
5. **Repetición**: volver a pasar por el diálogo con el mismo número → sigue habiendo una fila, con token nuevo.
6. **Dos números**: conectar un segundo número, enviar desde un WhatsApp real a cada uno y comprobar que los dos entran; responder desde la bandeja y comprobar **desde qué número** llega cada respuesta al móvil del cliente.
7. **Difusión**: lanzar una campaña eligiendo el segundo número; pausar y reanudar; comprobar en el móvil que el remitente no cambió.
8. **Firma**: mirar el registro de entregas de Meta — cero 401.
9. **Autoalojado**: una instancia sin `META_CONFIG_ID`, con la app propia del cliente, conectando por el formulario manual. El botón no aparece y todo lo demás funciona.
10. **CP11**: con la cuenta `suspended` (fase 3), un entrante a cualquiera de los dos números sigue guardándose.

---

## 11. Variables de entorno nuevas (`docs/docker.md`)

Ninguna es `NEXT_PUBLIC_*` — ver §1.1 — así que **no tocan `docker-compose.yml`** (entran por `env_file`, cambiar el valor solo pide reiniciar el contenedor).

| Variable | Obligatoria | Para qué |
|---|---|---|
| `META_APP_ID` | en modo plataforma | Identificador de nuestra app. Ya existía para las cabeceras de imagen de plantillas (`template-header-handle.ts` L52); ahora es también la mitad del intercambio de código. Anotar que **pasa a ser obligatoria en plataforma** |
| `META_CONFIG_ID` | en modo plataforma | Identificador de la configuración de Embedded Signup del panel de Meta. **Es el interruptor**: definida ⇒ botón visible y ruta operativa; ausente ⇒ modo autoalojado |
| `META_GRAPH_VERSION` | no | Por defecto `v21.0`, el mismo `META_API_VERSION` de `meta-api.ts`. Existe para poder subir de versión sin desplegar código |

Y una nota de actualización sobre `META_WEBHOOK_VERIFY_TOKEN`: sigue siendo opcional en autoalojado pero **es obligatoria en plataforma** desde f4.1 (§5).

`.env.local.example` está **bloqueado a los agentes** (`.claude/settings.json`): las tres van en la lista «pendiente para el humano» del informe, igual que se hizo con `ENCRYPTION_KEY_PREVIOUS` (f2.3), `META_WEBHOOK_VERIFY_TOKEN` (f2.4) y `PAYPAL_WEBHOOK_ID` (f3.3).

**CSP (`next.config.ts`)**: el SDK de Facebook necesita `https://connect.facebook.net` en `script-src`, `https://*.facebook.com` en `connect-src` y `frame-src https://*.facebook.com` (el SDK planta un iframe de arbitraje de dominios cruzados). Hoy la política va como `Content-Security-Policy-Report-Only`, así que **no bloquea nada** — pero sin este cambio la consola se llena de violaciones y el día que se pase a enforce el registro integrado deja de funcionar. Se añaden **incondicionalmente** (no condicionadas a `META_CONFIG_ID`): `headers()` se serializa en el manifiesto de rutas durante `next build`, así que una condición sobre variables de entorno no sería fiable en la imagen de Docker. Añadirlas no debilita nada relevante: `script-src` ya lleva `'unsafe-inline'` y `'unsafe-eval'`. Comentario en el archivo explicando el porqué. **Nada que añadir para `graph.facebook.com`**: todas las llamadas a Graph son de servidor, y el comentario que ya está en el archivo lo dice.

---

## 12. Riesgos

1. **`.single()` con dos filas.** Ocho sitios. Si se escapa uno, la cuenta que conecte un segundo número deja de poder enviar por esa vía, en silencio hasta que alguien se queja. Mitigación: el censo de §0 es una lista de comprobación, y el test de `resolve-config` más los de envío/difusión cubren los caminos calientes. **Antes de cerrar f4.2, un `grep -rn "from('whatsapp_config')" src/` que devuelva cero `.single()` fuera de `resolve-config.ts`.**
2. **Reanudar una difusión por el número equivocado.** Rompe la ventana de 24 h y degrada la calidad de dos números a la vez. Mitigado con el test de §9 (4c).
3. **El `code` o el token en un log.** Un `console.error(err)` con el objeto de respuesta completo filtra credenciales al registro del hosting. Regla: en toda la ruta nueva, solo `err.message`. Test que afirma que el `code` no aparece en ninguna llamada a `console.*`.
4. **Deriva de la API de Embedded Signup.** `sessionInfoVersion: '3'`, la forma del evento `WA_EMBEDDED_SIGNUP` y el propio `override_default_response_type` son detalles de Meta que cambian sin avisar y **que ningún test puede validar**. El implementer contrasta cada uno con la documentación viva de Meta antes de escribirlo, y el guion manual (§10) es la única verificación real. Este es el riesgo dominante de f4.1.
5. **El token se cifra con la clave vigente** (`encrypt()` de f2.3, formato versionado). Si alguien despliega f4.1 con una `ENCRYPTION_KEY` distinta de la del entorno donde se conectó, el síntoma es el `token_corrupted` de siempre. Nada nuevo, pero el camino de recuperación ahora es «volver a pulsar Conectar», que es mejor que antes.
6. **Migración de una instancia autoalojada a plataforma.** Las filas viejas traen tokens de la app del cliente; sus webhooks empiezan a fallar la firma con 401. Hay que documentarlo como paso de operación (cada inquilino reconecta), no como error.
7. **Choque de numeración de migraciones.** 046–052 están tomadas en ramas que aún no están fusionadas en `saas/integracion`. Comprobar en el momento; si fase 3 creció, desplazar a 054/055.
8. **`enforce.ts` ausente.** §7. f4.2 se lanza después del merge de fase 3.
9. **CP8, alcance.** f4.2 toca ~25 archivos. La tentación de arreglar de paso el asunto de las plantillas por WABA o de partir conversaciones por número es fuerte. Las dos cosas se anotan como deuda en el informe y **no** entran en el diff.

### Archivos críticos

- `src/app/api/whatsapp/config/route.ts`
- `src/app/api/whatsapp/webhook/route.ts`
- `src/lib/whatsapp/send-message.ts`
- `src/lib/whatsapp/meta-api.ts`
- `src/components/settings/whatsapp-config.tsx`
