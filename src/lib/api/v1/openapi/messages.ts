// ============================================================
// Registro: mensajes.
//
// Enviar (`POST /messages`) y leer el hilo de una conversación. El
// envío es la escritura más sensible de la API: manda un WhatsApp de
// verdad a una persona de verdad, así que se documentan también los
// códigos de dominio (`whatsapp_not_configured`, `meta_error`,
// `template_malformed`) que no están en `ApiErrorCode`.
// ============================================================

import { ERR_BAD_REQUEST, ERR_META, ERR_NOT_FOUND, pathParam } from './common';
import { EXAMPLE_CONVERSATION, EXAMPLE_MESSAGE, ref } from './schemas';
import type { OperationDef } from './types';

export const MESSAGES_OPERATIONS: OperationDef[] = [
  {
    method: 'post',
    path: '/messages',
    operationId: 'sendMessage',
    summary: 'Enviar un mensaje de WhatsApp',
    description:
      'Envía a un número en E.164 (`to`) o a un BSUID (`to_user_id`, para quien solo escribió con nombre de usuario de WhatsApp): el contacto y la conversación se buscan-o-crean y luego se envía. Hace falta exactamente uno de los dos; si mandas ambos **gana `to`**. Con varios números conectados, `from` elige el `phone_number_id` de salida; sin él sale por el número de la conversación y, si es nueva, por el predeterminado de la cuenta. Un `from` que no es tuyo es `400` y no envía ni crea nada.',
    tag: 'messages',
    scopes: ['messages:send'],
    idempotent: true,
    requestBody: {
      required: true,
      description: 'Destinatario, tipo y contenido.',
      schema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Destinatario en E.164.' },
          to_user_id: {
            type: 'string',
            description:
              'BSUID `CC.<alfanuméricos>`, de `contacts.wa_user_id`.',
          },
          type: {
            type: 'string',
            enum: ['text', 'template', 'image', 'video', 'document', 'audio'],
            default: 'text',
          },
          text: {
            type: 'string',
            description: 'Cuerpo del mensaje de texto, o pie del adjunto.',
          },
          media_url: {
            type: 'string',
            description: 'URL pública del adjunto (tipos de medio).',
          },
          filename: { type: 'string', description: 'Nombre para `document`.' },
          template: {
            type: 'object',
            description: 'Obligatorio con `type: "template"`.',
            required: ['name', 'language'],
            properties: {
              name: { type: 'string' },
              language: { type: 'string', description: 'Por ejemplo `en_US`.' },
              params: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Variables posicionales del cuerpo, en el orden de `variables` de la plantilla.',
              },
            },
          },
          reply_to_message_id: {
            type: 'string',
            format: 'uuid',
            description: 'Mensaje de la MISMA conversación al que responder.',
          },
          from: {
            type: 'string',
            description: '`phone_number_id` de Meta de uno de tus números.',
          },
        },
      },
      example: {
        to: '+14155550123',
        type: 'template',
        template: {
          name: 'order_update',
          language: 'en_US',
          params: ['Ada', 'A-123'],
        },
      },
    },
    envelope: 'data',
    responses: [
      {
        status: 201,
        description: 'Aceptado y enviado a Meta.',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: [
            'message_id',
            'whatsapp_message_id',
            'conversation_id',
            'contact_id',
            'contact_created',
          ],
          properties: {
            message_id: { type: 'string', format: 'uuid' },
            whatsapp_message_id: { type: ['string', 'null'] },
            conversation_id: { type: 'string', format: 'uuid' },
            contact_id: { type: 'string', format: 'uuid' },
            contact_created: { type: 'boolean' },
          },
        },
        example: {
          message_id: EXAMPLE_MESSAGE.id,
          whatsapp_message_id: EXAMPLE_MESSAGE.whatsapp_message_id,
          conversation_id: EXAMPLE_CONVERSATION.id,
          contact_id: EXAMPLE_CONVERSATION.contact_id,
          contact_created: false,
        },
      },
    ],
    errors: [
      ERR_BAD_REQUEST,
      {
        status: 400,
        code: 'whatsapp_not_configured',
        description: 'La cuenta no tiene ningún número de WhatsApp conectado.',
      },
      {
        status: 402,
        code: 'quota_exceeded',
        description:
          'La cuenta gastó su cupo mensual de mensajes salientes. El sobre dice cuál es la métrica, el tope y lo consumido.',
      },
      ERR_META,
      {
        status: 500,
        code: 'template_malformed',
        description:
          'La plantilla guardada no se puede convertir en un envío válido.',
      },
    ],
  },
  {
    method: 'get',
    path: '/conversations/{id}/messages',
    operationId: 'listConversationMessages',
    summary: 'Listar los mensajes de una conversación',
    description:
      'Los mensajes de una conversación, del más nuevo al más viejo. Se comprueba primero que la conversación sea de tu cuenta (`404` si no).',
    tag: 'messages',
    scopes: ['messages:read'],
    paginated: true,
    parameters: [pathParam('id', 'Id de la conversación.')],
    envelope: 'list',
    responses: [
      {
        status: 200,
        description: 'Una página de mensajes.',
        schema: ref('Message'),
        example: [EXAMPLE_MESSAGE],
      },
    ],
    errors: [ERR_NOT_FOUND],
  },
];
