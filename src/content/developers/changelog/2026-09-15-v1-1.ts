import type { ApiRelease } from '../types';

/** Endurecimiento de la capa común y cola duradera de webhooks. */
export const release: ApiRelease = {
  version: 'v1.1',
  date: '2026-09-15',
  summary: {
    es: 'Idempotencia, trazabilidad y entrega de webhooks duradera con reintentos.',
    en: 'Idempotency, traceability and durable webhook delivery with retries.',
  },
  changes: [
    {
      kind: 'added',
      text: {
        es: 'Cabecera `Idempotency-Key` en las escrituras que crean algo, con respuesta guardada 24 h y `Idempotent-Replayed: true` en la repetición.',
        en: '`Idempotency-Key` header on writes that create something, with the response stored for 24 h and `Idempotent-Replayed: true` on the replay.',
      },
    },
    {
      kind: 'added',
      text: {
        es: '`X-Request-Id` en toda respuesta y `request_id` en todo sobre de error.',
        en: '`X-Request-Id` on every response and `request_id` in every error envelope.',
      },
    },
    {
      kind: 'added',
      text: {
        es: 'Caducidad opcional al crear una clave y **rotación** con 24 h de gracia desde el panel.',
        en: 'Optional expiry when creating a key and **rotation** with a 24 h grace period, from the dashboard.',
      },
    },
    {
      kind: 'changed',
      text: {
        es: 'La entrega de webhooks pasa a ser duradera: cola persistente, cinco reintentos (1 min, 5 min, 30 min, 2 h, 12 h) y registro de entregas consultable.',
        en: 'Webhook delivery became durable: persistent queue, five retries (1 min, 5 min, 30 min, 2 h, 12 h) and a queryable delivery log.',
      },
    },
    {
      kind: 'added',
      text: {
        es: 'Eventos nuevos: `conversation.closed`, `conversation.assigned`, `contact.created`, `contact.updated`, `contact.tag_added`, `contact.tag_removed`, `template.status_updated` y `broadcast.completed`.',
        en: 'New events: `conversation.closed`, `conversation.assigned`, `contact.created`, `contact.updated`, `contact.tag_added`, `contact.tag_removed`, `template.status_updated` and `broadcast.completed`.',
      },
    },
    {
      kind: 'added',
      text: {
        es: 'Códigos de error `conflict`, `idempotency_mismatch`, `payload_too_large` y `unsupported_media_type`; tope de 1 MiB por cuerpo.',
        en: 'Error codes `conflict`, `idempotency_mismatch`, `payload_too_large` and `unsupported_media_type`; a 1 MiB body ceiling.',
      },
    },
  ],
};
