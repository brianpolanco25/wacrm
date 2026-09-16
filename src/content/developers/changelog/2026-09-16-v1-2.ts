import type { ApiRelease } from '../types';

/** Etiquetas, plantillas, exportaciones y el contrato publicado. */
export const release: ApiRelease = {
  version: 'v1.2',
  date: '2026-09-16',
  summary: {
    es: 'Etiquetas, plantillas y exportaciones como recursos propios, contrato OpenAPI y esta documentación.',
    en: 'Tags, templates and exports as first-class resources, an OpenAPI contract and these docs.',
  },
  changes: [
    {
      kind: 'added',
      text: {
        es: 'Etiquetas: `GET|POST /api/v1/tags`, `GET|PATCH|DELETE /api/v1/tags/{id}` y asignación por id con `POST /api/v1/contacts/{id}/tags` y `DELETE /api/v1/contacts/{id}/tags/{tagId}`. Scopes `tags:read` y `tags:write`.',
        en: 'Tags: `GET|POST /api/v1/tags`, `GET|PATCH|DELETE /api/v1/tags/{id}` and assignment by id with `POST /api/v1/contacts/{id}/tags` and `DELETE /api/v1/contacts/{id}/tags/{tagId}`. Scopes `tags:read` and `tags:write`.',
      },
    },
    {
      kind: 'added',
      text: {
        es: 'Plantillas: alta, edición, borrado y `POST /api/v1/templates/sync` contra Meta, con la lista de variables que espera cada cuerpo. Scopes `templates:read` y `templates:write`.',
        en: 'Templates: create, edit, delete and `POST /api/v1/templates/sync` against Meta, with the list of variables each body expects. Scopes `templates:read` and `templates:write`.',
      },
    },
    {
      kind: 'added',
      text: {
        es: 'Exportación de conversaciones: descarga directa en `GET /api/v1/conversations/{id}/export` y encargos en `POST /api/v1/exports`. Scope `conversations:export`.',
        en: 'Conversation exports: direct download at `GET /api/v1/conversations/{id}/export` and jobs at `POST /api/v1/exports`. Scope `conversations:export`.',
      },
    },
    {
      kind: 'added',
      text: {
        es: 'Documento OpenAPI 3.1 público en `GET /api/v1/openapi.json` y esta sección de documentación en `/developers`.',
        en: 'A public OpenAPI 3.1 document at `GET /api/v1/openapi.json` and this documentation section at `/developers`.',
      },
    },
    {
      kind: 'changed',
      text: {
        es: 'Cubos propios por cuenta para las operaciones caras: exportaciones 10/hora, sincronización de plantillas 6/min y acciones de webhook 20/min.',
        en: 'Dedicated per-account buckets for the expensive operations: exports 10/hour, template sync 6/min and webhook actions 20/min.',
      },
    },
    {
      kind: 'fixed',
      text: {
        es: 'Quitar de un contacto una etiqueta que no llevaba ya no emite `contact.tag_removed`: ese evento solo sale cuando algo se fue de verdad.',
        en: 'Detaching a tag a contact did not carry no longer emits `contact.tag_removed`: the event only fires when something really went away.',
      },
    },
  ],
};
