import type { DocPage, DocSectionLabels } from '../types';

export const sections: DocSectionLabels = {
  start: 'Primeros pasos',
  guides: 'Guías',
  reference: 'Referencia',
};

export const reference: DocPage = {
  slug: 'reference',
  title: 'Referencia',
  summary:
    'Todas las operaciones de /api/v1, generadas desde el documento OpenAPI 3.1 del propio servidor.',
  blocks: [
    {
      kind: 'lead',
      text: 'Esta página no se escribe a mano: se genera en el servidor desde el documento **OpenAPI 3.1** que publica tu instancia. Si una ruta cambia y el contrato cambia con ella, esta página cambia sola.',
    },
    {
      kind: 'p',
      text: 'El documento se sirve tal cual en `GET /api/v1/openapi.json`, público y sin autenticación. Con él puedes importar la API en Postman o Insomnia y generar clientes; lo cuenta [Integraciones](/developers/integrations).',
    },
    {
      kind: 'ul',
      items: [
        'El **scope** de cada operación es el que exige la ruta. Sin él, `403`.',
        'Las operaciones marcadas con `Idempotency-Key` aceptan esa cabecera; ver [Convenciones](/developers/conventions).',
        'Los cuerpos y las respuestas se describen con el esquema del contrato: los campos que no aparecen, no existen.',
        'Toda ruta relativa cuelga de la URL de tu propia instancia.',
      ],
    },
  ],
};

export const webhooks: DocPage = {
  slug: 'webhooks',
  title: 'Webhooks',
  summary:
    'Catálogo de eventos, el data de cada uno, la firma, la semántica de entrega y el panel.',
  blocks: [
    {
      kind: 'lead',
      text: 'En vez de preguntar cada minuto si ha pasado algo, registras una URL y te lo contamos. Esta página es el catálogo; para montar el receptor, ve a la [guía de webhooks](/developers/guides/webhooks).',
    },
    { kind: 'h2', id: 'eventos', text: 'Eventos' },
    {
      kind: 'table',
      head: ['Evento', 'Se dispara cuando'],
      rows: [
        ['`message.received`', 'Llega un mensaje entrante de un contacto'],
        [
          '`message.status_updated`',
          'Un mensaje que enviaste cambia de estado de entrega',
        ],
        [
          '`conversation.created`',
          'Se abre una conversación nueva con un contacto',
        ],
        [
          '`conversation.closed`',
          'Se cierra una conversación (panel o automatización)',
        ],
        ['`conversation.assigned`', 'Una conversación cambia de manos'],
        [
          '`contact.created`',
          'Se crea un contacto (API, panel o WhatsApp entrante)',
        ],
        ['`contact.updated`', 'Cambian los campos de un contacto'],
        ['`contact.tag_added`', 'Se pega una etiqueta a un contacto'],
        ['`contact.tag_removed`', 'Se despega una etiqueta de un contacto'],
        [
          '`template.status_updated`',
          'Meta movió el estado de revisión de una plantilla',
        ],
        ['`broadcast.completed`', 'Una difusión terminó de repartirse'],
      ],
    },
    {
      kind: 'note',
      tone: 'info',
      text: 'Los eventos nacen en la **capa de dominio**, no solo en `/api/v1`: una etiqueta que pone un agente en el panel, una conversación que cierra una automatización y un contacto que crea un mensaje entrante llegan a tu servidor igual que un cambio hecho por la API.',
    },
    { kind: 'h2', id: 'sobre', text: 'El sobre de la entrega' },
    {
      kind: 'code',
      lang: 'json',
      code: `{
  "id": "8f3c…",
  "event": "message.received",
  "occurred_at": "2026-07-01T12:00:00.000Z",
  "account_id": "…",
  "data": { }
}`,
    },
    {
      kind: 'p',
      text: 'El `id` es único por entrega y **estable entre reintentos**: es la clave por la que descartar duplicados. Cabeceras: `X-Wacrm-Event`, `X-Wacrm-Webhook-Id`, `X-Wacrm-Delivery-Id`, `X-Wacrm-Attempt` (1 en el primer intento) y `X-Wacrm-Signature`.',
    },
    { kind: 'h2', id: 'data', text: 'El `data` de cada evento' },
    {
      kind: 'code',
      lang: 'jsonc',
      code: `// message.received
{ "conversation_id": "…", "contact_id": "…", "whatsapp_message_id": "wamid.…",
  "content_type": "text", "text": "Hola 👋" }

// message.status_updated
{ "whatsapp_message_id": "wamid.…", "conversation_id": "…", "status": "delivered" }

// conversation.created / conversation.closed
{ "conversation_id": "…", "contact_id": "…" }

// conversation.assigned        (assigned_agent_id null = sin asignar)
{ "conversation_id": "…", "contact_id": "…", "assigned_agent_id": "…" }

// contact.created
{ "contact_id": "…", "phone": "14155550123", "wa_user_id": null, "name": "Ada" }

// contact.updated
{ "contact_id": "…", "phone": "…", "wa_user_id": null, "name": "Ada",
  "fields": ["name"] }

// contact.tag_added / contact.tag_removed
{ "contact_id": "…", "tag_id": "…" }

// template.status_updated
{ "template_id": "…", "name": "aviso_pedido", "language": "es_ES",
  "status": "APPROVED", "previous_status": "PENDING" }

// broadcast.completed
{ "broadcast_id": "…", "status": "sent", "total": 1000, "sent": 987, "failed": 13 }`,
    },
    { kind: 'h2', id: 'firma', text: 'Firma' },
    {
      kind: 'p',
      text: '`X-Wacrm-Signature: t=<segundos unix>,v1=<hex>`, donde `v1` es `HMAC-SHA256(secreto, "<t>.<cuerpo crudo>")`. Recalcúlala sobre el cuerpo crudo, compárala en tiempo constante y rechaza una `t` de hace más de unos minutos. Hay receptores completos en Node, Python y PHP en la [guía](/developers/guides/webhooks).',
    },
    { kind: 'h2', id: 'entrega', text: 'Semántica de entrega' },
    {
      kind: 'ul',
      items: [
        '**Al menos una vez y duradera**: el evento se guarda antes del primer intento.',
        'Escalera de reintentos: 1 min, 5 min, 30 min, 2 h y 12 h. Después queda `dead` y se puede reintentar a mano.',
        'Cada intento tiene un tiempo de espera corto y **no se siguen redirecciones**.',
        'Cualquier respuesta que no sea 2xx cuenta como fallo.',
        'A los 15 fallos seguidos el destino se desactiva solo; `PATCH` con `is_active: true` lo revive y pone el contador a cero.',
        'El historial de entregas se guarda **30 días**.',
        '`message.status_updated` cubre los mensajes que el CRM guarda (bandeja y envíos por API), no los envíos que solo existen dentro de una difusión.',
      ],
    },
    { kind: 'h2', id: 'ssrf', text: 'Destinos permitidos' },
    {
      kind: 'p',
      text: 'La `url` tiene que ser `https://` y resolver a una dirección pública. `localhost`, los rangos privados (RFC1918), el enlace local —incluido el `169.254.169.254` de los metadatos de la nube— y destinos internos parecidos se rechazan **en el momento de la entrega**, no solo al registrar el destino.',
    },
    { kind: 'h2', id: 'panel', text: 'Desde el panel' },
    {
      kind: 'p',
      text: '**Ajustes → Webhooks** hace lo mismo sin escribir código: crear un destino (el secreto se enseña una vez), editar la URL y los eventos, activar y desactivar, ver las últimas entregas con su código y su error, y reintentar. El panel nunca muestra el secreto de un destino ya creado.',
    },
  ],
};

export const integrations: DocPage = {
  slug: 'integrations',
  title: 'Integraciones',
  summary:
    'El servidor MCP para asistentes y cómo generar un SDK desde el documento OpenAPI.',
  blocks: [
    {
      kind: 'lead',
      text: 'Dos formas de no escribir un cliente a mano: un servidor MCP listo para asistentes y el documento OpenAPI para generar el SDK de tu lenguaje.',
    },
    { kind: 'h2', id: 'mcp', text: 'Servidor MCP' },
    {
      kind: 'p',
      text: 'El paquete `wacrm-mcp` es un servidor del [Model Context Protocol](https://modelcontextprotocol.io) que envuelve esta misma API, así que clientes como Claude Desktop, Claude Code o Cursor pueden manejar el CRM en lenguaje natural: «¿cuántas conversaciones siguen abiertas?», «busca el contacto de +34 600 111 222 y enséñame los últimos mensajes».',
    },
    {
      kind: 'p',
      text: 'No reimplementa nada: la autenticación, los scopes y los límites los sigue imponiendo tu instancia.',
    },
    {
      kind: 'code',
      lang: 'jsonc',
      label: 'Configuración del cliente MCP',
      code: `{
  "mcpServers": {
    "wacrm": {
      "command": "npx",
      "args": ["-y", "wacrm-mcp"],
      "env": {
        "WACRM_BASE_URL": "https://tu-dominio.example.com",
        "WACRM_API_KEY": "wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}`,
    },
    {
      kind: 'table',
      head: ['Variable', 'Obligatoria', 'Para qué'],
      rows: [
        ['`WACRM_BASE_URL`', 'sí', 'La URL de tu instancia'],
        ['`WACRM_API_KEY`', 'sí', 'Una clave creada en el panel'],
        [
          '`WACRM_ENABLE_WRITES`',
          'no',
          '`true` para exponer escrituras de contactos y envío de mensajes',
        ],
        [
          '`WACRM_ENABLE_BROADCASTS`',
          'no',
          '`true` para exponer difusiones (exige `WACRM_ENABLE_WRITES`)',
        ],
      ],
    },
    {
      kind: 'note',
      tone: 'good',
      text: 'La configuración de arriba es **solo lectura**, que es la opción segura: sin los dos interruptores, las herramientas de escritura ni siquiera se registran y el modelo no puede verlas. Aun con ellos puestos, los scopes de la clave siguen mandando: para un asistente de solo lectura, emite una clave de solo lectura.',
    },
    {
      kind: 'p',
      text: 'La difusión masiva es la única herramienta que además exige `confirm: true` y va marcada como destructiva, para que el cliente pregunte antes.',
    },
    { kind: 'h2', id: 'sdk', text: 'Generar un SDK desde el OpenAPI' },
    {
      kind: 'p',
      text: 'Tu instancia publica el contrato completo en `GET /api/v1/openapi.json` —público, sin autenticación—. Es un documento **OpenAPI 3.1** estándar: cualquier generador lo entiende.',
    },
    {
      kind: 'code',
      lang: 'bash',
      label: 'Tipos de TypeScript',
      code: `npx openapi-typescript https://tu-dominio.example.com/api/v1/openapi.json \\
  -o src/tipos/cabbity.d.ts`,
    },
    {
      kind: 'code',
      lang: 'bash',
      label: 'Cliente en Python, Java, Go…',
      code: `npx @openapitools/openapi-generator-cli generate \\
  -i https://tu-dominio.example.com/api/v1/openapi.json \\
  -g python \\
  -o ./cliente-cabbity`,
    },
    {
      kind: 'ul',
      items: [
        'Regenera el cliente cuando actualices la instancia: el documento se construye desde el código, así que refleja lo que tu versión sirve de verdad.',
        'El esquema de seguridad es `bearer`: el generador dejará un lugar donde poner la clave.',
        'Los eventos de webhook viajan en la sección `webhooks` del documento, así que también puedes generar los tipos del receptor.',
        'Para probar a mano, importa esa misma URL en Postman o Insomnia.',
      ],
    },
    { kind: 'h2', id: 'sin-sdk', text: 'Sin generador' },
    {
      kind: 'p',
      text: 'La API es HTTP con JSON y una credencial portadora: `curl`, `fetch` o la biblioteca de tu lenguaje bastan. Todas las listas paginan igual y todos los errores traen el mismo sobre, así que un cliente de cien líneas cubre la API entera. Lo que sí conviene envolver una vez es el reintento ante `429` leyendo `Retry-After`, y la `Idempotency-Key` de las escrituras.',
    },
  ],
};

export const changelog: DocPage = {
  slug: 'changelog',
  title: 'Changelog de la API',
  summary:
    'Qué cambió en /api/v1 y cuándo, de lo más reciente a lo más antiguo.',
  blocks: [
    {
      kind: 'lead',
      text: 'Cambios del contrato público `/api/v1`, de lo más reciente a lo más antiguo. Los cambios internos que no se ven desde fuera no salen aquí.',
    },
    {
      kind: 'ul',
      items: [
        '**Añadir no rompe.** Campos nuevos en una respuesta, endpoints nuevos y valores nuevos en una enumeración pueden aparecer en cualquier versión: ignora lo que no conozcas.',
        '**Quitar sí rompe**, y por eso no lo hacemos dentro de `v1`. Si algo tuviera que desaparecer, se anunciaría aquí como obsoleto antes.',
        'Ramifica siempre por `error.code`, nunca por `error.message`, que se reescribe sin avisar.',
      ],
    },
  ],
};
