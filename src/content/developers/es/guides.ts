import type { DocPage } from '../types';

// Guías en español. Cada una es una tarea completa, de principio a fin,
// con el código que hace falta y nada más.

export const guides: DocPage = {
  slug: 'guides',
  title: 'Guías',
  summary: 'Cuatro tareas completas, de la primera llamada al último detalle.',
  blocks: [
    {
      kind: 'lead',
      text: 'La [referencia](/developers/reference) dice qué acepta cada operación. Estas guías dicen en qué orden se llaman para conseguir algo.',
    },
    {
      kind: 'cards',
      items: [
        {
          href: '/developers/guides/templates',
          title: 'Enviar una plantilla de punta a punta',
          text: 'Crearla, esperar la aprobación de Meta, enviarla y seguir la entrega por webhook.',
        },
        {
          href: '/developers/guides/contacts-tags',
          title: 'Sincronizar contactos y etiquetas',
          text: 'Volcar tu base de clientes sin duplicar filas y mantener las etiquetas al día.',
        },
        {
          href: '/developers/guides/exports',
          title: 'Exportar conversaciones',
          text: 'Descarga directa para una conversación y encargos en segundo plano para el resto.',
        },
        {
          href: '/developers/guides/webhooks',
          title: 'Recibir webhooks',
          text: 'Verificar la firma en Node, Python y PHP, y convivir con reintentos y duplicados.',
        },
      ],
    },
  ],
};

export const guidesTemplates: DocPage = {
  slug: 'guides/templates',
  title: 'Enviar una plantilla de punta a punta',
  summary:
    'Crear la plantilla, esperar la aprobación de Meta, enviarla y seguir su entrega por webhook.',
  blocks: [
    {
      kind: 'lead',
      text: 'Fuera de las 24 horas siguientes al último mensaje del cliente, WhatsApp solo deja enviar **plantillas aprobadas**. Esta guía recorre el camino entero: crearla, esperar a Meta, enviarla y enterarse de si llegó.',
    },
    {
      kind: 'note',
      tone: 'info',
      text: 'Necesitas una clave con `templates:write`, `templates:read`, `messages:send` y, para el último paso, `webhooks:manage`.',
    },
    { kind: 'h2', id: 'crear', text: '1. Crear la plantilla' },
    {
      kind: 'p',
      text: 'La plantilla se crea en el CRM y se envía a revisión de Meta en la misma llamada. Las variables del cuerpo son posicionales y **contiguas desde `{{1}}`**, y tienes que dar un valor de ejemplo por cada una: Meta rechaza la plantilla si falta alguno, y preferimos decírtelo antes del viaje de ida y vuelta.',
    },
    {
      kind: 'code',
      lang: 'bash',
      label: 'POST /api/v1/templates',
      code: `curl -X POST "$CABBITY_BASE_URL/api/v1/templates" \\
  -H "Authorization: Bearer $CABBITY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: plantilla-pedido-v1" \\
  -d '{
        "name": "aviso_pedido",
        "language": "es_ES",
        "category": "Utility",
        "body_text": "Hola {{1}}, tu pedido {{2}} ya va en camino.",
        "sample_values": { "body": ["Ada", "A-123"] },
        "footer_text": "Responde BAJA para no recibir más avisos"
      }'`,
    },
    {
      kind: 'ul',
      items: [
        'El `name` sigue la regla de Meta: minúsculas, dígitos y guiones bajos.',
        'La categoría `Authentication` se rechaza con `400`: esas plantillas necesitan el flujo de códigos de un solo uso de Meta. Créalas en WhatsApp Manager y tráelas con `POST /api/v1/templates/sync`.',
        'Un par `(name, language)` que ya existe en tu cuenta da `409` **antes** de llamar a Meta.',
        'Con varios números conectados, elige la cuenta de WhatsApp Business con `from` (el `phone_number_id` de Meta) o con `whatsapp_config_id`.',
        'La `Idempotency-Key` importa aquí más que en otras rutas: Meta limita la creación de plantillas a 100 por hora y cuenta.',
      ],
    },
    {
      kind: 'p',
      text: 'La respuesta es `201` con la plantilla en estado `PENDING`. Si Meta rechaza el envío recibes `502 meta_error` con su mensaje público, y **no se guarda nada** en local.',
    },
    { kind: 'h2', id: 'aprobacion', text: '2. Esperar la aprobación' },
    {
      kind: 'p',
      text: 'La revisión de Meta tarda de minutos a horas. Hay dos formas de enterarte, y solo una es buena:',
    },
    {
      kind: 'ul',
      items: [
        '**Suscríbete a `template.status_updated`** ([guía de webhooks](/developers/guides/webhooks)). Es un evento por cambio de estado, sin consultar nada.',
        'Si de verdad no puedes recibir webhooks, llama a `POST /api/v1/templates/sync` —que es quien pregunta a Meta— y luego lee `GET /api/v1/templates`. El cubo de `sync` es de **6 por minuto y cuenta**, así que no lo pongas en un bucle cerrado.',
      ],
    },
    {
      kind: 'table',
      head: ['Estado', 'Qué significa'],
      rows: [
        ['`DRAFT`', 'Creada en local, todavía sin llegar a Meta'],
        ['`PENDING`', 'En revisión'],
        ['`APPROVED`', 'Se puede enviar'],
        [
          '`REJECTED`',
          '`rejection_reason` dice por qué; se edita y se reenvía',
        ],
        ['`PAUSED`', 'Recuperable: edita y vuelve a enviar a revisión'],
        ['`DISABLED`', 'Terminal, no vuelve'],
      ],
    },
    { kind: 'h2', id: 'variables', text: '3. Saber qué variables pide' },
    {
      kind: 'p',
      text: 'No adivines el número de parámetros: `GET /api/v1/templates` lo dice. Cada plantilla trae `variables`, la lista ordenada de los `{{1}}…{{n}}` que espera el cuerpo.',
    },
    {
      kind: 'code',
      lang: 'bash',
      label: 'GET /api/v1/templates',
      code: `curl -G "$CABBITY_BASE_URL/api/v1/templates" \\
  -H "Authorization: Bearer $CABBITY_API_KEY" \\
  --data-urlencode "search=aviso_pedido" \\
  --data-urlencode "status=APPROVED"`,
    },
    {
      kind: 'code',
      lang: 'json',
      label: 'Fragmento de la respuesta',
      code: `"variables": [
  { "index": 1, "placeholder": "{{1}}", "example": "Ada" },
  { "index": 2, "placeholder": "{{2}}", "example": "A-123" }
]`,
    },
    {
      kind: 'p',
      text: '`example` es el valor con el que se aprobó la plantilla: sirve para una vista previa y **nunca** se envía como valor por omisión.',
    },
    { kind: 'h2', id: 'enviar', text: '4. Enviarla' },
    {
      kind: 'p',
      text: 'La identidad de una plantilla al enviarla es el par `name` + `language`, no su `id`. Los `params` van en el orden de `variables`.',
    },
    {
      kind: 'code',
      lang: 'bash',
      label: 'POST /api/v1/messages',
      code: `curl -X POST "$CABBITY_BASE_URL/api/v1/messages" \\
  -H "Authorization: Bearer $CABBITY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: pedido-A-123-aviso" \\
  -d '{
        "to": "+34600111222",
        "type": "template",
        "template": {
          "name": "aviso_pedido",
          "language": "es_ES",
          "params": ["Ada", "A-123"]
        }
      }'`,
    },
    {
      kind: 'p',
      text: 'La respuesta `201` trae `message_id`, `whatsapp_message_id`, `conversation_id`, `contact_id` y `contact_created`. El contacto y la conversación se buscan o se crean solos a partir del número en E.164: no hace falta darlos de alta antes.',
    },
    {
      kind: 'note',
      tone: 'warn',
      text: 'Solo se puede enviar una plantilla `APPROVED`. Una `PENDING` o `REJECTED` vuelve de Meta como `502 meta_error` en el envío, no en un `400` nuestro: la decisión es de Meta y llega tarde a propósito, cuando ya lo intentamos.',
    },
    {
      kind: 'p',
      text: 'Para escribir a alguien de quien no tienes el número —un cliente que te escribió con su nombre de usuario de WhatsApp— manda `to_user_id` con su BSUID (`CC.<alfanuméricos>`) en vez de `to`. `GET /api/v1/contacts` lo devuelve en `wa_user_id`.',
    },
    { kind: 'h2', id: 'seguimiento', text: '5. Seguir la entrega' },
    {
      kind: 'p',
      text: 'El `201` significa «Meta lo aceptó», no «el cliente lo leyó». El estado real llega después, y llega por webhook.',
    },
    {
      kind: 'code',
      lang: 'bash',
      label: 'Suscribirse a los dos eventos que importan',
      code: `curl -X POST "$CABBITY_BASE_URL/api/v1/webhooks" \\
  -H "Authorization: Bearer $CABBITY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
        "url": "https://tu-servidor.example.com/hooks/cabbity",
        "events": ["message.status_updated", "template.status_updated"]
      }'`,
    },
    {
      kind: 'p',
      text: 'Guarda el `secret` que viene en esa respuesta: se enseña **una sola vez** y es con lo que se verifica la firma. El evento `message.status_updated` trae `whatsapp_message_id` —el mismo que te devolvió el envío— y el `status` nuevo.',
    },
    {
      kind: 'note',
      tone: 'info',
      text: 'Los estados de entrega llegan repetidos y desordenados porque así los manda el proveedor. Quédate con el último por `occurred_at` y descarta por el `id` del sobre; lo cuenta la [guía de webhooks](/developers/guides/webhooks).',
    },
    { kind: 'h2', id: 'editar', text: 'Editar una plantilla más tarde' },
    {
      kind: 'p',
      text: '`PATCH /api/v1/templates/{id}` edita y vuelve a enviar a revisión. Meta **sustituye** los componentes en vez de parchearlos, así que lo que omitas se hereda de la plantilla guardada: manda `"footer_text": null` para quitar de verdad el pie. `name` y `language` son inmutables —para Meta cada par es una plantilla distinta— y solo se pueden editar las `APPROVED`, `REJECTED` y `PAUSED`, hasta 10 veces por plantilla cada 30 días.',
    },
  ],
};

export const guidesContactsTags: DocPage = {
  slug: 'guides/contacts-tags',
  title: 'Sincronizar contactos y etiquetas',
  summary:
    'Volcar tu base de clientes sin duplicar filas y mantener las etiquetas al día desde tu sistema.',
  blocks: [
    {
      kind: 'lead',
      text: 'Los contactos y las etiquetas son el vocabulario común entre tu sistema y el CRM. Las dos rutas de escritura están pensadas para que un proceso que se repite —una sincronización nocturna, un reintento— no ensucie los datos.',
    },
    { kind: 'h2', id: 'alta', text: 'Alta de contactos sin duplicados' },
    {
      kind: 'p',
      text: '`POST /api/v1/contacts` es **buscar-o-crear por teléfono**: si el número ya existe en tu cuenta devuelve `200` con el contacto que había; si es nuevo, `201`. Puedes reproducir tu base entera sin comprobar antes qué hay.',
    },
    {
      kind: 'code',
      lang: 'bash',
      code: `curl -X POST "$CABBITY_BASE_URL/api/v1/contacts" \\
  -H "Authorization: Bearer $CABBITY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
        "phone": "+34600111222",
        "name": "Ada Lovelace",
        "email": "ada@example.com",
        "company": "Acme",
        "tags": ["vip", "beta"]
      }'`,
    },
    {
      kind: 'ul',
      items: [
        'El `phone` va en **E.164** (`+` y prefijo de país). Es lo que identifica al contacto.',
        'El campo `tags` de esta ruta y de `PATCH /contacts/{id}` toma **nombres** y **reemplaza** el conjunto entero. Las etiquetas que no existan se crean.',
        'Un contacto que solo ha escrito con un nombre de usuario de WhatsApp tiene `phone: null`; su identidad es `wa_user_id` (el BSUID) y su nombre público, `wa_username`.',
      ],
    },
    {
      kind: 'note',
      tone: 'warn',
      text: 'Reemplazar es peligroso si no eres el dueño de todas las etiquetas del contacto: un agente puso `urgente` a mano y tu sincronización, que no sabe de esa etiqueta, la borra. Para añadir sin pisar, usa la ruta por id de abajo.',
    },
    { kind: 'h2', id: 'etiquetas', text: 'Etiquetas como recurso propio' },
    {
      kind: 'p',
      text: '`POST /api/v1/tags` también es buscar-o-crear, esta vez **por nombre y sin distinguir mayúsculas**: `VIP` y `vip` son la misma etiqueta. Un nombre que ya existe devuelve `200` con la etiqueta de siempre y **no** le cambia el color.',
    },
    {
      kind: 'code',
      lang: 'bash',
      code: `curl -X POST "$CABBITY_BASE_URL/api/v1/tags" \\
  -H "Authorization: Bearer $CABBITY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: etiqueta-vip" \\
  -d '{ "name": "vip", "color": "#3b82f6" }'`,
    },
    {
      kind: 'p',
      text: 'La unicidad la impone la base de datos, no el código: dos llamadas simultáneas con el mismo nombre producen **una** etiqueta y el perdedor de la carrera recibe la fila del ganador con `200`, no un duplicado ni un `500`. Renombrar una etiqueta sobre un nombre que ya se usa es `409 conflict` (cambiarle solo las mayúsculas a la suya propia, no).',
    },
    { kind: 'h2', id: 'asignar', text: 'Asignar y quitar por id' },
    {
      kind: 'p',
      text: 'La puerta aditiva es `POST /api/v1/contacts/{id}/tags` con `{ "tag_ids": [...] }` (50 como máximo por llamada): añade sin tocar lo que el contacto ya tenía. Una etiqueta que ya llevaba es una operación vacía, no un segundo evento.',
    },
    {
      kind: 'code',
      lang: 'bash',
      code: `# añadir dos etiquetas por id
curl -X POST "$CABBITY_BASE_URL/api/v1/contacts/$CONTACT_ID/tags" \\
  -H "Authorization: Bearer $CABBITY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "tag_ids": ["6f0c…", "a91b…"] }'

# quitar una
curl -X DELETE "$CABBITY_BASE_URL/api/v1/contacts/$CONTACT_ID/tags/6f0c…" \\
  -H "Authorization: Bearer $CABBITY_API_KEY"`,
    },
    {
      kind: 'note',
      tone: 'good',
      text: '**Todo o nada.** Cada id se resuelve contra tu cuenta antes de la primera escritura, así que una lista con un id desconocido o ajeno no asigna ninguna y no dispara ningún evento: el `404` y el estado de tus datos dicen lo mismo.',
    },
    {
      kind: 'p',
      text: 'Quitar una etiqueta que el contacto no llevaba es `200` con el contacto igual y **sin** webhook `contact.tag_removed`: ese evento solo sale cuando algo se fue de verdad.',
    },
    {
      kind: 'h2',
      id: 'efectos',
      text: 'Etiquetar dispara lo mismo que el panel',
    },
    {
      kind: 'p',
      text: 'Una etiqueta puesta por la API dispara el mismo disparador de automatización `tag_added` y el mismo webhook `contact.tag_added` que si un agente la hubiera puesto a mano. No hay una puerta de atrás con menos efectos: si tu automatización de bienvenida arranca con una etiqueta, arranca también desde tu programa.',
    },
    { kind: 'h2', id: 'leer', text: 'Leer lo que hay' },
    {
      kind: 'ul',
      items: [
        '`GET /api/v1/contacts` acepta `?search=` (nombre o teléfono) y `?tag=<tagId>`, y pagina con cursor como todas las listas.',
        '`GET /api/v1/tags` acepta `?search=` sobre el nombre.',
        '`DELETE /api/v1/tags/{id}` borra la etiqueta **y la despega de todos los contactos** que la llevaban. No hay vuelta atrás.',
      ],
    },
    {
      kind: 'p',
      text: 'Para un volcado grande, recorre las páginas hasta que `meta.next_cursor` sea `null` y respeta el `429`: el cupo general son 120 peticiones por minuto y clave, y `Retry-After` te dice cuánto esperar exactamente.',
    },
  ],
};

export const guidesExports: DocPage = {
  slug: 'guides/exports',
  title: 'Exportar conversaciones',
  summary:
    'Descarga directa de una conversación y encargos en segundo plano para volúmenes grandes.',
  blocks: [
    {
      kind: 'lead',
      text: 'Hay dos caminos, y la diferencia no es el formato sino el tamaño: una conversación concreta se descarga en la misma llamada; todo lo demás se encarga y se recoge cuando está.',
    },
    {
      kind: 'note',
      tone: 'info',
      text: 'Los dos caminos piden el scope `conversations:export` y comparten un cubo de **10 peticiones por hora y cuenta**. Es la operación más cara de la API.',
    },
    { kind: 'h2', id: 'directa', text: 'Una conversación, ahora' },
    {
      kind: 'code',
      lang: 'bash',
      code: `curl -L "$CABBITY_BASE_URL/api/v1/conversations/$CONVERSATION_ID/export?format=csv" \\
  -H "Authorization: Bearer $CABBITY_API_KEY" \\
  -o conversacion.csv`,
    },
    {
      kind: 'p',
      text: 'El `format` es `json` (por omisión) o `csv`. Esta es **la única ruta de la API cuyo cuerpo no es el sobre `{data}`**: el cuerpo es el archivo, con su `Content-Disposition`. Los errores sí vuelven en el sobre, así que un fallo se analiza como en el resto.',
    },
    {
      kind: 'p',
      text: 'Cada mensaje trae un conjunto fijo de campos: `conversation_id`, `id`, `direction`, `sender_type`, `content_type`, `text`, `media_url`, `template_name`, `status`, `whatsapp_message_id` y `created_at`. El JSON anida los mensajes bajo su conversación; el CSV es una fila por mensaje.',
    },
    {
      kind: 'note',
      tone: 'warn',
      text: 'Por encima de **10 000 mensajes** la respuesta es `409 conflict` y te manda al encargo. No es un capricho: sostener esa descarga en una sola petición se rompe justo cuando más datos hay.',
    },
    {
      kind: 'h2',
      id: 'encargo',
      text: 'Muchas conversaciones, en segundo plano',
    },
    {
      kind: 'code',
      lang: 'bash',
      label: 'POST /api/v1/exports',
      code: `curl -X POST "$CABBITY_BASE_URL/api/v1/exports" \\
  -H "Authorization: Bearer $CABBITY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: export-2026-01" \\
  -d '{
        "kind": "conversations",
        "format": "csv",
        "filters": { "status": "closed", "from": "2026-01-01T00:00:00Z" }
      }'`,
    },
    {
      kind: 'p',
      text: 'La respuesta es `202` con el encargo en `queued`. El archivo se construye justo después de responder y, si ese proceso se muere, el barrido programado lo retoma. Con `Idempotency-Key`, un reintento devuelve **el mismo encargo** en lugar de encolar otro.',
    },
    {
      kind: 'ul',
      items: [
        '`filters` acepta `status`, `contact_id`, `from` y `to` (ISO-8601, sobre el `created_at` de la conversación). Las claves desconocidas se ignoran.',
        'Nada de lo que pongas en `filters` puede ampliar la exportación más allá de tu cuenta.',
        'Un solo encargo con filtros recorre todas las conversaciones en una pasada: si necesitas más volumen no necesitas más llamadas.',
      ],
    },
    {
      kind: 'note',
      tone: 'warn',
      text: 'El encargo también tiene techo: **250 000 mensajes**. Al superarlo el encargo termina en `failed` con un `error` que te lo dice —«This export exceeds 250,000 messages»— y ningún archivo a medias: preferimos no darte nada a darte un export incompleto que parezca completo. La salida es partirlo por fechas con los filtros `from` y `to` (por trimestres, por meses) y lanzar un encargo por tramo.',
    },
    { kind: 'h2', id: 'recoger', text: 'Recoger el archivo' },
    {
      kind: 'code',
      lang: 'bash',
      code: `curl "$CABBITY_BASE_URL/api/v1/exports/$JOB_ID" \\
  -H "Authorization: Bearer $CABBITY_API_KEY"`,
    },
    {
      kind: 'code',
      lang: 'json',
      code: `{
  "data": {
    "id": "…",
    "status": "done",
    "row_count": 18432,
    "download_url": "https://…",
    "download_expires_at": "2026-09-16T12:15:00.000Z"
  }
}`,
    },
    {
      kind: 'p',
      text: 'El estado va `queued` → `running` → `done` | `failed`; en `failed`, `error` lo explica en lenguaje llano. La `download_url` **se acuña en cada llamada y vale 15 minutos**, y no se guarda en ningún sitio: guardamos la ruta del objeto, no el enlace. Pide otra cuando la necesites y no la caches, porque quien la tenga puede descargar el archivo hasta que caduque.',
    },
    {
      kind: 'note',
      tone: 'warn',
      text: '**Los archivos y las filas se borran a los 7 días** de crearse. Recoge lo tuyo dentro de esa ventana.',
    },
    { kind: 'h2', id: 'archivo', text: 'Dos cosas sobre el archivo' },
    {
      kind: 'p',
      text: '**Los adjuntos son referencias, no enlaces.** Los medios viven en depósitos privados, así que `media_url` se exporta como `storage://<depósito>/<ruta>`: un puntero estable, nunca una URL pública ni una firmada. Una URL firmada es una credencial, y escribir miles de ellas en un archivo que dura siete días y se reenvía por correo es exactamente lo que no vamos a hacer. Lo que nunca fue nuestro (la CDN de Meta, una URL externa) se exporta tal cual.',
    },
    {
      kind: 'p',
      text: '**Las celdas del CSV están protegidas contra la inyección de fórmulas.** Una celda cuyo texto empieza por `=`, `+`, `-` o `@` lleva una comilla simple delante para que la hoja de cálculo la lea como texto en vez de ejecutarla. Si analizas el CSV con código, quítala cuando esté.',
    },
  ],
};

export const guidesWebhooks: DocPage = {
  slug: 'guides/webhooks',
  title: 'Recibir webhooks',
  summary:
    'Verificar la firma en Node, Python y PHP, y convivir con reintentos y entregas duplicadas.',
  blocks: [
    {
      kind: 'lead',
      text: 'Un webhook es una petición `POST` que **nosotros** hacemos a **tu** servidor. Como cualquiera puede llamar a esa URL, lo primero que hace tu receptor no es leer el cuerpo: es comprobar la firma.',
    },
    { kind: 'h2', id: 'registrar', text: '1. Registrar el destino' },
    {
      kind: 'code',
      lang: 'bash',
      code: `curl -X POST "$CABBITY_BASE_URL/api/v1/webhooks" \\
  -H "Authorization: Bearer $CABBITY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
        "url": "https://tu-servidor.example.com/hooks/cabbity",
        "events": ["message.received", "conversation.closed"]
      }'`,
    },
    {
      kind: 'p',
      text: 'La respuesta `201` incluye `secret` **una sola vez**: guárdalo donde guardas las credenciales. Del nuestro solo queda una copia cifrada, así que no hay forma de volver a enseñártelo; si lo pierdes, `POST /api/v1/webhooks/{id}/rotate-secret` acuña otro (y lo devuelve una vez).',
    },
    {
      kind: 'p',
      text: 'La URL tiene que ser `https://` y resolver a una dirección pública: `localhost`, los rangos privados y el `169.254.169.254` de los metadatos de la nube se rechazan **en el momento de entregar**, no solo al registrar.',
    },
    { kind: 'h2', id: 'firma', text: '2. El esquema de firma' },
    {
      kind: 'p',
      text: 'Cada entrega lleva la cabecera `X-Wacrm-Signature` con esta forma:',
    },
    {
      kind: 'code',
      lang: 'http',
      code: `X-Wacrm-Signature: t=1789012345,v1=8f3c9a…`,
    },
    {
      kind: 'ul',
      items: [
        '`t` es la hora de la firma en segundos Unix.',
        '`v1` es `HMAC-SHA256(secreto, "<t>.<cuerpo crudo>")` en hexadecimal.',
        'Se calcula sobre el **cuerpo crudo**, byte a byte, no sobre un JSON reserializado: reordenar claves o cambiar espacios rompe la firma.',
        'Compárala en **tiempo constante** y rechaza una `t` de hace más de unos minutos (protección contra repetición). Cinco minutos es la tolerancia que usamos nosotros.',
      ],
    },
    { kind: 'h3', id: 'node', text: 'Node' },
    {
      kind: 'code',
      lang: 'javascript',
      label: 'Express — ojo con el cuerpo crudo',
      code: `import crypto from 'node:crypto';
import express from 'express';

const app = express();
const SECRET = process.env.CABBITY_WEBHOOK_SECRET;
const TOLERANCIA = 300; // segundos

function verificar(cabecera, cuerpoCrudo) {
  const partes = Object.fromEntries(
    String(cabecera || '')
      .split(',')
      .map((kv) => {
        const i = kv.indexOf('=');
        return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
      })
  );
  const t = Number(partes.t);
  const v1 = (partes.v1 || '').toLowerCase();
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > TOLERANCIA) return false;

  const esperado = crypto
    .createHmac('sha256', SECRET)
    .update(\`\${t}.\${cuerpoCrudo}\`)
    .digest('hex');
  // timingSafeEqual lanza si las longitudes no coinciden.
  if (esperado.length !== v1.length) return false;
  return crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(v1));
}

// express.raw(), NO express.json(): hace falta el cuerpo tal cual llegó.
app.post(
  '/hooks/cabbity',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const crudo = req.body.toString('utf8');
    if (!verificar(req.get('X-Wacrm-Signature'), crudo)) {
      return res.status(401).end();
    }
    const evento = JSON.parse(crudo);
    res.status(200).end();   // responde primero
    encolar(evento);         // trabaja después
  }
);`,
    },
    { kind: 'h3', id: 'python', text: 'Python' },
    {
      kind: 'code',
      lang: 'python',
      label: 'Flask',
      code: `import hashlib
import hmac
import os
import time

from flask import Flask, abort, request

app = Flask(__name__)
SECRETO = os.environ["CABBITY_WEBHOOK_SECRET"].encode()
TOLERANCIA = 300  # segundos


def verificar(cabecera: str, crudo: bytes) -> bool:
    partes = {}
    for kv in (cabecera or "").split(","):
        if "=" in kv:
            k, v = kv.split("=", 1)
            partes[k.strip()] = v.strip()
    try:
        t = int(partes["t"])
        v1 = partes["v1"].lower()
    except (KeyError, ValueError):
        return False
    if abs(time.time() - t) > TOLERANCIA:
        return False
    esperado = hmac.new(
        SECRETO, f"{t}.".encode() + crudo, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(esperado, v1)


@app.post("/hooks/cabbity")
def hooks():
    crudo = request.get_data()  # bytes, sin tocar
    if not verificar(request.headers.get("X-Wacrm-Signature", ""), crudo):
        abort(401)
    evento = request.get_json(force=True)
    encolar(evento)   # el trabajo, fuera de la petición
    return "", 200`,
    },
    { kind: 'h3', id: 'php', text: 'PHP' },
    {
      kind: 'code',
      lang: 'php',
      label: 'PHP plano',
      code: `<?php
declare(strict_types=1);

function cabbity_verificar(
    string $cabecera,
    string $crudo,
    string $secreto,
    int $tolerancia = 300
): bool {
    $partes = [];
    foreach (explode(',', $cabecera) as $kv) {
        $par = explode('=', $kv, 2);
        if (count($par) === 2) {
            $partes[trim($par[0])] = trim($par[1]);
        }
    }
    if (!isset($partes['t'], $partes['v1'])) {
        return false;
    }
    $t = (int) $partes['t'];
    if (abs(time() - $t) > $tolerancia) {
        return false;
    }
    $esperado = hash_hmac('sha256', $t . '.' . $crudo, $secreto);
    return hash_equals($esperado, strtolower($partes['v1']));
}

$crudo = file_get_contents('php://input');   // el cuerpo tal cual
$cabecera = $_SERVER['HTTP_X_WACRM_SIGNATURE'] ?? '';

if (!cabbity_verificar($cabecera, $crudo, getenv('CABBITY_WEBHOOK_SECRET'))) {
    http_response_code(401);
    exit;
}

http_response_code(200);   // responde ya
fastcgi_finish_request();  // y trabaja después
encolar(json_decode($crudo, true));`,
    },
    { kind: 'h2', id: 'reintentos', text: '3. Reintentos y duplicados' },
    {
      kind: 'p',
      text: 'La entrega es **al menos una vez y duradera**: cada evento se guarda en una cola antes del primer intento, así que un receptor caído, lento o a mitad de despliegue no pierde nada. Un intento fallido se reintenta cinco veces más —al minuto, a los 5 minutos, a la media hora, a las 2 horas y a las 12— y luego queda `dead` en el registro, desde donde puedes reintentarlo a mano.',
    },
    {
      kind: 'table',
      head: ['Situación', 'Qué hace tu receptor'],
      rows: [
        [
          'Llega el mismo `id` dos veces',
          'Descártalo. El `id` del sobre es estable entre reintentos: un receptor que aceptó y luego se quedó sin tiempo verá el mismo',
        ],
        [
          'Llega un evento viejo después de uno nuevo',
          'No supongas orden. `occurred_at` manda',
        ],
        [
          'Tu proceso tarda',
          'Responde 2xx primero y trabaja después. Cualquier cosa que no sea 2xx —incluido un 3xx— cuenta como fallo y programa un reintento',
        ],
        [
          'Acumulas 15 fallos seguidos',
          'El destino se desactiva solo (`is_active: false`). Se reactiva con `PATCH`, que además pone el contador a cero',
        ],
      ],
    },
    {
      kind: 'p',
      text: 'La forma barata de descartar duplicados es una tabla con el `id` del sobre como clave primaria y una inserción que ignore el conflicto: si ya estaba, ese evento ya se procesó.',
    },
    {
      kind: 'code',
      lang: 'sql',
      code: `CREATE TABLE eventos_vistos (
  id         uuid PRIMARY KEY,
  recibido_en timestamptz NOT NULL DEFAULT now()
);

-- devuelve 0 filas si ya estaba: no vuelvas a procesarlo
INSERT INTO eventos_vistos (id) VALUES ($1) ON CONFLICT DO NOTHING;`,
    },
    { kind: 'h2', id: 'depurar', text: '4. Depurar' },
    {
      kind: 'ul',
      items: [
        '`POST /api/v1/webhooks/{id}/test` entrega un `ping` firmado de verdad. `ping` no es un evento suscribible: solo viaja cuando lo pides.',
        '`GET /api/v1/webhooks/{id}/deliveries` es el registro de entregas, con el código de respuesta y el error de cada una (`?status=pending|delivered|failed|dead`). Nunca incluye el `payload`.',
        '`POST /api/v1/webhooks/{id}/deliveries/{deliveryId}/retry` reintenta una ya, desde el primer peldaño de la escalera.',
        'En el panel, **Ajustes → Webhooks** enseña lo mismo con botones.',
      ],
    },
    {
      kind: 'note',
      tone: 'warn',
      text: 'Si tu instancia es autoalojada, los reintentos necesitan un programador que llame a `GET /api/webhooks/cron` cada minuto (ver `docs/docker.md`). Sin él solo se ejecuta el primer intento de cada entrega.',
    },
    {
      kind: 'p',
      text: 'La lista completa de eventos y del `data` de cada uno está en [Webhooks](/developers/webhooks).',
    },
  ],
};
