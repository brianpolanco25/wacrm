import type { DocPage } from '../types';

// Prosa en español de las tres primeras páginas. Fuente de verdad del
// contenido: `docs/public-api.md` de esta rama (contrato vigente tras
// a7.1–a7.5) y `progress/impl_integracion-api-3.md` §6.

export const start: DocPage = {
  slug: 'start',
  title: 'Empezar',
  summary:
    'Crea una clave de API, haz tu primera llamada y deja el entorno listo en cinco minutos.',
  blocks: [
    {
      kind: 'lead',
      text: 'La API pública de Cabbity CRM deja que tus propios programas hagan lo que hace el panel: enviar mensajes de WhatsApp, administrar contactos y etiquetas, publicar plantillas, lanzar difusiones, exportar conversaciones y recibir eventos en tu servidor.',
    },
    {
      kind: 'p',
      text: 'Todo cuelga de `/api/v1` sobre tu propia instancia. No hay entorno de pruebas aparte: lo que envías, se envía.',
    },
    { kind: 'h2', id: 'plan', text: 'Qué plan la incluye' },
    {
      kind: 'p',
      text: 'La API y los webhooks salientes están en los planes **Pro** y **Negocio**. En el plan Inicio las rutas de `/api/v1` responden `402` con el código `feature_unavailable` y un `upgradeUrl` en el cuerpo; el resto del CRM funciona igual.',
    },
    { kind: 'h2', id: 'clave', text: '1. Crea una clave' },
    {
      kind: 'p',
      text: 'En el panel: **Ajustes → API**. Solo los roles **admin** y **propietario** ven el botón.',
    },
    {
      kind: 'ol',
      items: [
        'Pulsa **Nueva clave de API** y ponle el nombre de la integración que la va a usar, no el tuyo. Cuando haya seis claves querrás saber cuál apagar.',
        'Marca **solo** los scopes que esa integración necesita. Una clave que únicamente lee contactos no debería poder enviar mensajes; ver [Autenticación y scopes](/developers/authentication).',
        'Elige una **caducidad**: 30, 90 o 365 días, o nunca. Una fecha obliga a rotar, y rotar es lo que convierte una filtración en un susto en vez de en un incidente.',
        'Copia la clave. **Se muestra una sola vez**: el servidor guarda únicamente un hash SHA-256, así que no hay forma de volver a verla. Si la pierdes, revócala y crea otra.',
      ],
    },
    {
      kind: 'note',
      tone: 'warn',
      text: 'Las claves no se pueden crear desde la propia API. Una clave capaz de fabricar claves es una escalada de privilegios silenciosa: el alta vive en el panel y solo ahí.',
    },
    { kind: 'h2', id: 'primera-llamada', text: '2. Tu primera llamada' },
    {
      kind: 'p',
      text: '`GET /api/v1/me` es la ruta de diagnóstico: no exige ningún scope, así que funciona incluso con una clave sin permisos, y te dice a qué cuenta pertenece y qué puede hacer.',
    },
    {
      kind: 'code',
      lang: 'bash',
      label: 'Comprobar la clave',
      code: `curl https://tu-dominio.example.com/api/v1/me \\
  -H "Authorization: Bearer $CABBITY_API_KEY"`,
    },
    {
      kind: 'code',
      lang: 'json',
      label: 'Respuesta',
      code: `{
  "data": {
    "account": { "id": "9f1c…", "name": "Acme S.L." },
    "key": { "id": "3a20…", "scopes": ["messages:send", "contacts:read"] }
  }
}`,
    },
    {
      kind: 'p',
      text: 'Un `401` aquí significa clave ausente, mal escrita, desconocida, revocada o caducada: son el mismo error a propósito, para no confirmarle a nadie que una clave existió.',
    },
    { kind: 'h2', id: 'entorno', text: '3. Deja el entorno listo' },
    {
      kind: 'p',
      text: 'La clave es una credencial: no viaja en el código ni en el repositorio. Con dos variables de entorno basta, y son las que usan los ejemplos de estas guías. El [servidor MCP](/developers/integrations) tiene sus propios nombres, documentados allí.',
    },
    {
      kind: 'code',
      lang: 'bash',
      label: '.env de tu integración',
      code: `CABBITY_BASE_URL=https://tu-dominio.example.com
CABBITY_API_KEY=wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
    },
    {
      kind: 'ul',
      items: [
        'Nunca la pongas en un cliente web ni en una aplicación móvil: la API no usa CORS porque está pensada de servidor a servidor, y cualquier clave que llegue a un navegador es una clave pública.',
        'Registra siempre la cabecera `X-Request-Id` de las respuestas. Es lo único que te pedimos para poder rastrear una llamada concreta.',
        'Guarda la fecha de caducidad junto a la clave, no en la cabeza de quien la creó.',
      ],
    },
    { kind: 'h2', id: 'siguiente', text: 'Y ahora qué' },
    {
      kind: 'cards',
      items: [
        {
          href: '/developers/authentication',
          title: 'Autenticación y scopes',
          text: 'Qué permite cada scope, cómo se rota una clave y qué hacer si se filtra.',
        },
        {
          href: '/developers/conventions',
          title: 'Convenciones',
          text: 'El sobre de respuesta, los códigos de error, los límites de frecuencia, la paginación y la idempotencia.',
        },
        {
          href: '/developers/guides/templates',
          title: 'Enviar una plantilla',
          text: 'De crear la plantilla a seguir el estado de entrega por webhook.',
        },
        {
          href: '/developers/reference',
          title: 'Referencia',
          text: 'Todas las operaciones, generadas desde el contrato OpenAPI.',
        },
      ],
    },
  ],
};

export const authentication: DocPage = {
  slug: 'authentication',
  title: 'Autenticación y scopes',
  summary:
    'Claves portadoras, los doce scopes, mínimo privilegio, caducidad, rotación y qué hacer ante una filtración.',
  blocks: [
    {
      kind: 'lead',
      text: 'Cada petición se autentica con una clave de API enviada como credencial portadora. La clave pertenece a **una** cuenta: no existe acceso entre cuentas, ni siquiera para el propietario de las dos.',
    },
    {
      kind: 'code',
      lang: 'http',
      code: `Authorization: Bearer wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
    },
    {
      kind: 'p',
      text: 'El prefijo `wacrm_live_` es visible en el panel para que reconozcas la clave en un registro sin tener el valor completo. Del resto solo se guarda un hash SHA-256.',
    },
    { kind: 'h2', id: 'scopes', text: 'Los doce scopes' },
    {
      kind: 'p',
      text: 'Un scope es un permiso de la clave, independiente del rol de quien la creó. Una clave sin ningún scope se autentica igual y puede llamar a `GET /api/v1/me`, nada más.',
    },
    {
      kind: 'table',
      head: ['Scope', 'Permite'],
      rows: [
        ['`messages:send`', 'Enviar mensajes de WhatsApp'],
        ['`messages:read`', 'Leer mensajes y su estado de entrega'],
        ['`contacts:read`', 'Listar y leer contactos'],
        ['`contacts:write`', 'Crear y actualizar contactos'],
        ['`conversations:read`', 'Listar y leer conversaciones'],
        ['`conversations:export`', 'Exportar conversaciones y sus mensajes'],
        ['`broadcasts:send`', 'Lanzar difusiones y consultar su avance'],
        ['`webhooks:manage`', 'Registrar y administrar webhooks salientes'],
        ['`tags:read`', 'Listar y leer etiquetas'],
        ['`tags:write`', 'Crear, renombrar, borrar y asignar etiquetas'],
        ['`templates:read`', 'Listar plantillas y su estado en Meta'],
        ['`templates:write`', 'Crear, editar, borrar y sincronizar plantillas'],
      ],
    },
    {
      kind: 'note',
      tone: 'info',
      text: 'No existe `broadcasts:read`: leer el avance de una difusión usa `broadcasts:send`, el mismo scope que lanzarla.',
    },
    { kind: 'h2', id: 'minimo-privilegio', text: 'Mínimo privilegio' },
    {
      kind: 'p',
      text: 'La pregunta correcta al crear una clave no es «qué podría necesitar algún día» sino «qué hace hoy este programa». Tres ejemplos que cubren casi todo:',
    },
    {
      kind: 'ul',
      items: [
        'Un panel interno que muestra conversaciones: `conversations:read` y `messages:read`. Nada más; no puede escribir.',
        'El aviso de pedido enviado de tu tienda: `messages:send` y `templates:read`. Lee qué variables espera la plantilla y la envía.',
        'La copia nocturna a tu almacén de datos: `conversations:export`. Ni siquiera necesita leer contactos.',
      ],
    },
    {
      kind: 'p',
      text: 'Una clave a la que le falta el scope de la ruta recibe `403 forbidden` con el nombre del scope que falta en el mensaje. Es información deliberada: acelera el diagnóstico y no revela nada que el dueño de la clave no pueda ver en el panel.',
    },
    { kind: 'h2', id: 'caducidad', text: 'Caducidad' },
    {
      kind: 'p',
      text: 'Al crear una clave eliges 30, 90 o 365 días, o **nunca** (el valor por omisión, para no poner un reloj a integraciones que ya existían). Una clave caducada deja de autenticar y responde `401`, igual que una revocada.',
    },
    { kind: 'h2', id: 'rotacion', text: 'Rotación sin corte' },
    {
      kind: 'p',
      text: '**Ajustes → API → Rotar** crea una clave nueva con el mismo nombre y los mismos scopes, y le da a la vieja **24 horas de gracia**: durante esa ventana las dos autentican, así que puedes desplegar el valor nuevo sin ventana de caída. La vieja aparece como *Rotando* con su fecha límite.',
    },
    {
      kind: 'ol',
      items: [
        'Rota en el panel y copia la clave nueva.',
        'Despliega el valor nuevo en tu integración.',
        'Comprueba con `GET /api/v1/me` que la clave nueva responde.',
        'Si la rotación fue por una filtración, no esperes las 24 horas: pulsa **Revocar ahora** sobre la vieja.',
      ],
    },
    {
      kind: 'p',
      text: 'La clave nueva hereda la caducidad de la vieja salvo que fijes otra. Dos claves no se pueden rotar: una **caducada** (heredaría una fecha ya pasada; crea una nueva) y una que ya está **rotando** (termina la rotación en curso o revócala ya).',
    },
    { kind: 'h2', id: 'filtracion', text: 'Si una clave se filtra' },
    {
      kind: 'ol',
      items: [
        '**Revócala ya**, sin rotar. La revocación surte efecto en la siguiente petición de esa clave.',
        'Crea una clave nueva con los scopes mínimos y despliega.',
        'Revisa qué pudo hacer quien la tuviera: el scope de la clave filtrada es el alcance exacto del incidente, y por eso importaba no regalar permisos.',
        'Si tenía `webhooks:manage`, comprueba en **Ajustes → Webhooks** que nadie añadió un destino y rota los secretos de firma de los que había.',
      ],
    },
    {
      kind: 'note',
      tone: 'good',
      text: 'Las claves revocadas se quedan en la lista como rastro de auditoría: la fecha de creación, el último uso y quién la creó siguen ahí después de revocarla.',
    },
  ],
};

export const conventions: DocPage = {
  slug: 'conventions',
  title: 'Convenciones',
  summary:
    'Sobre de respuesta, códigos de error, request_id, límites de frecuencia, paginación e idempotencia.',
  blocks: [
    {
      kind: 'lead',
      text: 'Todas las rutas de `/api/v1` responden igual, fallan igual y se paginan igual. Si programas contra estas seis reglas, un endpoint nuevo no te obliga a cambiar el cliente.',
    },
    { kind: 'h2', id: 'sobre', text: 'El sobre' },
    {
      kind: 'code',
      lang: 'jsonc',
      code: `// éxito
{ "data": { /* … */ } }

// éxito de una lista
{ "data": [ /* … */ ], "meta": { "next_cursor": "eyJ…" } }

// fallo
{
  "error": {
    "code": "forbidden",
    "message": "This API key is missing the 'messages:send' scope",
    "request_id": "0d8f…"
  }
}`,
    },
    {
      kind: 'p',
      text: 'Ramifica siempre por `error.code`, que es estable; `error.message` está escrito para una persona y puede reescribirse sin aviso. La única ruta que no devuelve el sobre es `GET /api/v1/conversations/{id}/export`, donde el cuerpo **es el archivo** —sus errores sí vuelven en el sobre—.',
    },
    { kind: 'h2', id: 'errores', text: 'Códigos de error' },
    {
      kind: 'table',
      head: ['Estado', 'Código', 'Significado'],
      rows: [
        [
          '400',
          '`bad_request`',
          'Entrada mal formada; el mensaje nombra el campo',
        ],
        [
          '401',
          '`unauthorized`',
          'Clave ausente, mal formada, desconocida, revocada o caducada',
        ],
        [
          '402',
          '`feature_unavailable`',
          'El plan no incluye la API o los webhooks',
        ],
        [
          '402',
          '`quota_exceeded`',
          'Gastada la asignación mensual de una métrica',
        ],
        [
          '402',
          '`plan_limit_reached`',
          'Un tope de existencias del plan está lleno',
        ],
        [
          '403',
          '`forbidden`',
          'Clave válida a la que le falta el scope de la ruta',
        ],
        [
          '403',
          '`account_read_only`',
          'Suscripción suspendida o vencida: solo lecturas',
        ],
        ['404', '`not_found`', 'No existe, o es de otra cuenta'],
        [
          '409',
          '`conflict`',
          'El recurso está ocupado o en un estado incompatible',
        ],
        [
          '409',
          '`idempotency_mismatch`',
          'Esa `Idempotency-Key` se usó con otro cuerpo',
        ],
        ['413', '`payload_too_large`', 'Cuerpo por encima de 1 MiB'],
        [
          '415',
          '`unsupported_media_type`',
          'Escritura sin `Content-Type: application/json`',
        ],
        ['429', '`rate_limited`', 'Agotado el cupo de peticiones'],
        ['502', '`meta_error`', 'La petición llegó a Meta y Meta la rechazó'],
        ['500', '`internal`', 'Error del servidor'],
      ],
    },
    {
      kind: 'note',
      tone: 'info',
      text: 'Un recurso de otra cuenta responde `404`, nunca `403`. Es deliberado: un `403` confirmaría que ese identificador existe en algún sitio.',
    },
    {
      kind: 'p',
      text: 'Los tres errores de `402` traen además `upgradeUrl` y, cuando aplica, `metric`, `limit` y `used`, para que tu programa sepa qué tope tocó sin leer la frase.',
    },
    { kind: 'h2', id: 'cabeceras', text: 'Cabeceras de toda respuesta' },
    {
      kind: 'ul',
      items: [
        '`X-Request-Id` — un UUID que acuña el servidor para esa llamada. Se repite como `request_id` dentro del cuerpo de error. Regístralo; el valor que mandes tú con ese nombre se ignora.',
        '`Cache-Control: no-store` — son datos de una cuenta detrás de una credencial: no se guardan en ninguna caché.',
      ],
    },
    { kind: 'h2', id: 'peticiones', text: 'Cuerpos de petición' },
    {
      kind: 'ul',
      items: [
        'Las escrituras mandan `Content-Type: application/json` (`415` si no) y un **objeto** JSON (`400` si no).',
        'El cuerpo tiene un tope de **1 MiB** (`413`).',
        'Los campos desconocidos se ignoran; los de tipo equivocado dan `400` nombrando el campo.',
      ],
    },
    { kind: 'h2', id: 'limites', text: 'Límites de frecuencia' },
    {
      kind: 'p',
      text: 'El cupo general es de **120 peticiones por minuto y clave**. Un `429` trae `Retry-After` en segundos y el trío `X-RateLimit-Limit`, `X-RateLimit-Remaining` y `X-RateLimit-Reset`.',
    },
    {
      kind: 'table',
      head: ['Cubo', 'Cupo', 'Ámbito', 'Operaciones'],
      rows: [
        ['general', '120/min', 'por clave', 'todas'],
        [
          '`exports`',
          '10/hora',
          'por cuenta',
          '`GET /conversations/{id}/export` y `POST /exports`',
        ],
        ['`templatesSync`', '6/min', 'por cuenta', '`POST /templates/sync`'],
        [
          '`webhookAction`',
          '20/min',
          'por cuenta',
          '`test`, `retry` y `rotate-secret` de webhooks',
        ],
      ],
    },
    {
      kind: 'p',
      text: 'Los tres cubos propios van **por cuenta** y se suman al general: dos claves de la misma empresa comparten esos tres y no el de 120/min. Una petición que ni llega a hacer el trabajo —un `404` por un identificador ajeno— no gasta del cubo de exportaciones.',
    },
    {
      kind: 'note',
      tone: 'warn',
      text: 'El limitador vive en memoria y **por proceso**. Un despliegue de una sola instancia, que es el caso normal, se comporta como dice esta página; repartido en varias, el cupo deja de ser global.',
    },
    { kind: 'h2', id: 'paginacion', text: 'Paginación' },
    {
      kind: 'p',
      text: 'Todas las listas paginan igual: pides el tamaño con `?limit=` (50 por omisión, 100 como máximo) y la página siguiente con el cursor opaco que venía en `meta.next_cursor`.',
    },
    {
      kind: 'code',
      lang: 'http',
      code: `GET /api/v1/contacts?limit=50
→ { "data": [ … ], "meta": { "next_cursor": "eyJ…" } }

GET /api/v1/contacts?limit=50&cursor=eyJ…
→ { "data": [ … ], "meta": { "next_cursor": null } }   // última página`,
    },
    {
      kind: 'p',
      text: 'Los cursores son de tipo *keyset*: aguantan inserciones concurrentes sin saltarse ni repetir filas. Devuélvelos tal cual, sin interpretarlos. `next_cursor: null` es la última página.',
    },
    { kind: 'h2', id: 'idempotencia', text: 'Idempotencia' },
    {
      kind: 'p',
      text: 'Todo `POST` que crea algo acepta la cabecera `Idempotency-Key`: un texto tuyo de 1 a 255 caracteres. Úsalo con un valor derivado de aquello sobre lo que actúas (el id del pedido, el del trabajo), no uno aleatorio por intento — la gracia está en que el **reintento** mande la misma clave.',
    },
    {
      kind: 'code',
      lang: 'bash',
      code: `curl -X POST https://tu-dominio.example.com/api/v1/messages \\
  -H "Authorization: Bearer $CABBITY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: pedido-4711-aviso" \\
  -d '{"to":"+34600111222","type":"text","text":"Ya sale"}'`,
    },
    {
      kind: 'table',
      head: ['Lo que mandas', 'Lo que recibes'],
      rows: [
        [
          'Misma clave, mismo cuerpo',
          'La respuesta guardada, con `Idempotent-Replayed: true`. Nada se ejecuta dos veces',
        ],
        ['Misma clave, cuerpo distinto', '`409 idempotency_mismatch`'],
        [
          'Misma clave, la primera llamada sigue en curso',
          '`409 conflict` — reinténtalo en un momento',
        ],
        [
          'Misma clave, más de 24 h después',
          'Se trata como una petición nueva',
        ],
        ['Sin clave', 'Sin protección: un reintento vuelve a enviar'],
      ],
    },
    {
      kind: 'ul',
      items: [
        'Las claves son del **par clave de API + endpoint**: dos integraciones de la misma cuenta nunca se ven la respuesta la una a la otra, y la misma clave contra otra ruta —o contra la misma con otra *query string*— es un `idempotency_mismatch`.',
        'Solo se guardan las respuestas correctas (2xx). Un `400`, un `429` o un `500` liberan la clave: arreglas el cuerpo y reintentas con la misma.',
        'Si el servidor se cae con tu primera llamada a medias, la clave no se queda atascada: una reserva sin respuesta pasados **dos minutos** se da por abandonada. Un `409 conflict` quiere decir «prueba en un momento», nunca «espera 24 horas».',
      ],
    },
    {
      kind: 'p',
      text: 'Hoy la aceptan `POST /messages`, `POST /broadcasts`, `POST /tags`, `POST /contacts/{id}/tags`, `POST /templates`, `PATCH /templates/{id}` y `POST /exports`. La [referencia](/developers/reference) lo marca operación por operación.',
    },
  ],
};
