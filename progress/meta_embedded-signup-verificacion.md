# Verificación de la API de Embedded Signup contra la documentación viva de Meta

Hecha por el líder el 2026-09-12, porque el implementer de f4.1 no pudo alcanzar
`developers.facebook.com` desde su entorno (HTTP 400). Fuente consultada:
`https://developers.facebook.com/docs/whatsapp/embedded-signup/implementation`
(Embedded Signup **v4**, la versión vigente). Búsqueda complementaria en la web.

## Confirmado (coincide con el plan y con lo implementado)

- `FB.login(cb, { config_id, response_type: 'code', override_default_response_type: true, extras: { setup: {} } })`.
- El evento de sesión llega por `window.message` con `type: 'WA_EMBEDDED_SIGNUP'` y
  `event` ∈ `FINISH | CANCEL | ERROR`. En `FINISH`, `data` trae `phone_number_id`,
  `waba_id`, `business_id` y, condicionalmente, `ad_account_ids`, `page_ids`,
  `dataset_ids`, `catalog_ids`, `instagram_account_ids`, `waba_ids`. En `CANCEL`,
  `data.current_step`. En `ERROR`, `error_message`, `error_code`, `session_id`, `timestamp`.
- El código devuelto se intercambia en el servidor con
  `GET /{version}/oauth/access_token?client_id=<META_APP_ID>&client_secret=<META_APP_SECRET>&code=<code>`.
  La respuesta es un token de sistema de integración de negocio acotado a los activos que
  el cliente concedió. No aparece `redirect_uri` en la descripción.
- **El código caduca a los 30 segundos**: el `POST /api/whatsapp/embedded-signup` debe
  intercambiarlo de inmediato, antes de cualquier otra llamada a Meta.

## Discrepancias con el plan / la implementación (a corregir en la ronda siguiente de f4.1)

1. **`sessionInfoVersion` y `featureType` no existen en v4.** La documentación vigente
   solo documenta `extras.setup`. El plan (§1.2) arrastraba `sessionInfoVersion: '3'` y
   `featureType: ''` de versiones anteriores. Quitar ambos de `extras`; dejar `setup: {}`.
2. **Comprobación de origen**: la documentación usa
   `if (!event.origin.endsWith('facebook.com')) return;`. El plan fijaba una lista exacta
   (`https://www.facebook.com`, `https://web.facebook.com`). Sustituir por la comprobación
   documentada: `new URL(event.origin).hostname` que sea `facebook.com` o termine en
   `.facebook.com`, sobre `https:`. Una lista exacta puede dejar fuera un subdominio que Meta
   use y romper el flujo en silencio.
3. **Versión de Graph**: la documentación recomienda `v25.0` en `FB.init`. El plan ponía
   `v21.0` por defecto para `META_GRAPH_VERSION`. Alinear el valor por defecto con
   `META_API_VERSION` de `src/lib/whatsapp/meta-api.ts` y documentar que Meta recomienda v25.0.

## Requisitos operativos (van al guion manual y a `docs/docker.md`)

- El dominio de la aplicación debe estar en **Allowed Domains** y en **Valid OAuth redirect
  URIs** de «Facebook Login for Business → Settings → Client OAuth settings»; si no, el
  diálogo no devuelve datos a la ventana que lo abrió. Solo dominios HTTPS.
- La configuración de Embedded Signup (`META_CONFIG_ID`) se crea en el panel de la app.

## No verificado desde aquí

- La página de onboarding para Tech Providers (paso a paso del intercambio y de
  `subscribed_apps`/`register`) devolvió 404 en la URL conocida. El intercambio queda
  confirmado por la página de implementación y por fuentes secundarias; la primera prueba
  real en sandbox (guion §10 del plan, pasos 2 y 3) sigue siendo la verificación definitiva.
