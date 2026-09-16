import type { ApiRelease } from '../types';

/** Primera versión pública de `/api/v1`. */
export const release: ApiRelease = {
  version: 'v1.0',
  date: '2026-07-01',
  summary: {
    es: 'Primera versión pública: mensajes, contactos, conversaciones, difusiones y webhooks.',
    en: 'First public release: messages, contacts, conversations, broadcasts and webhooks.',
  },
  changes: [
    {
      kind: 'added',
      text: {
        es: 'Claves de API con scopes, creadas desde **Ajustes → API**, y `GET /api/v1/me` para comprobarlas.',
        en: 'Scoped API keys, created from **Settings → API**, and `GET /api/v1/me` to check them.',
      },
    },
    {
      kind: 'added',
      text: {
        es: '`POST /api/v1/messages` (texto, plantilla y multimedia), contactos, conversaciones, mensajes de una conversación y difusiones.',
        en: "`POST /api/v1/messages` (text, template and media), contacts, conversations, a conversation's messages and broadcasts.",
      },
    },
    {
      kind: 'added',
      text: {
        es: 'Webhooks salientes firmados con `X-Wacrm-Signature`, con un intento por evento.',
        en: 'Outbound webhooks signed with `X-Wacrm-Signature`, one attempt per event.',
      },
    },
    {
      kind: 'added',
      text: {
        es: 'Sobre `{data}` / `{error}`, paginación por cursor y límite de 120 peticiones por minuto y clave.',
        en: 'The `{data}` / `{error}` envelope, cursor pagination and a 120 requests per minute, per key limit.',
      },
    },
  ],
};
