// ============================================================
// Registro: contactos.
//
// Cuatro operaciones. Las de etiquetas por id viven en `tags.ts`
// aunque cuelguen de `/contacts/{id}` — el scope que las gobierna es
// `tags:write` y el recurso que mueven es la etiqueta.
// ============================================================

import {
  ERR_BAD_REQUEST,
  ERR_NOT_FOUND,
  pathParam,
  queryParam,
} from './common';
import { EXAMPLE_CONTACT, ref } from './schemas';
import type { OperationDef } from './types';

const CONTACT_ID = pathParam('id', 'Id del contacto.');

export const CONTACTS_OPERATIONS: OperationDef[] = [
  {
    method: 'get',
    path: '/contacts',
    operationId: 'listContacts',
    summary: 'Listar contactos',
    description:
      'Lista los contactos de la cuenta, del más nuevo al más viejo. `phone` es null para quien solo ha escrito con nombre de usuario de WhatsApp; ahí `wa_user_id` lleva el BSUID con el que se le puede escribir.',
    tag: 'contacts',
    scopes: ['contacts:read'],
    paginated: true,
    parameters: [
      queryParam('search', 'Busca en el nombre o en el teléfono.'),
      queryParam('tag', 'Id de etiqueta por la que filtrar.', {
        schema: { type: 'string', format: 'uuid' },
      }),
    ],
    envelope: 'list',
    responses: [
      {
        status: 200,
        description: 'Una página de contactos.',
        schema: ref('Contact'),
        example: [EXAMPLE_CONTACT],
      },
    ],
    errors: [],
  },
  {
    method: 'post',
    path: '/contacts',
    operationId: 'createContact',
    summary: 'Crear un contacto',
    description:
      'Crea un contacto por teléfono. **Busca-o-crea**: si ya existe uno con ese número se devuelve con `200`; uno nuevo devuelve `201`. Las etiquetas van por NOMBRE y se crean si no existen.',
    tag: 'contacts',
    scopes: ['contacts:write'],
    requestBody: {
      required: true,
      description: 'Los campos del contacto. `phone` es obligatorio.',
      schema: {
        type: 'object',
        required: ['phone'],
        properties: {
          phone: { type: 'string', description: 'Número en E.164.' },
          name: { type: 'string' },
          email: { type: 'string' },
          company: { type: 'string' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Nombres de etiqueta; se crean si no existen.',
          },
        },
      },
      example: {
        phone: '+14155550123',
        name: 'Jane Doe',
        company: 'Acme',
        tags: ['vip'],
      },
    },
    envelope: 'data',
    responses: [
      {
        status: 200,
        description: 'Ya existía un contacto con ese teléfono.',
        schema: ref('Contact'),
        example: EXAMPLE_CONTACT,
      },
      {
        status: 201,
        description: 'Contacto creado.',
        schema: ref('Contact'),
        example: EXAMPLE_CONTACT,
      },
    ],
    errors: [ERR_BAD_REQUEST],
  },
  {
    method: 'get',
    path: '/contacts/{id}',
    operationId: 'getContact',
    summary: 'Leer un contacto',
    description: 'Un contacto por su id, con sus etiquetas.',
    tag: 'contacts',
    scopes: ['contacts:read'],
    parameters: [CONTACT_ID],
    envelope: 'data',
    responses: [
      {
        status: 200,
        description: 'El contacto.',
        schema: ref('Contact'),
        example: EXAMPLE_CONTACT,
      },
    ],
    errors: [ERR_NOT_FOUND],
  },
  {
    method: 'patch',
    path: '/contacts/{id}',
    operationId: 'updateContact',
    summary: 'Actualizar un contacto',
    description:
      'Cambia solo los campos que envías. `tags` toma NOMBRES y **reemplaza** el conjunto entero: para añadir sin tocar el resto usa `POST /contacts/{id}/tags`, que va por id.',
    tag: 'contacts',
    scopes: ['contacts:write'],
    parameters: [CONTACT_ID],
    requestBody: {
      required: true,
      description: 'Los campos a cambiar.',
      schema: {
        type: 'object',
        properties: {
          name: { type: ['string', 'null'] },
          email: { type: ['string', 'null'] },
          company: { type: ['string', 'null'] },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Nombres; reemplaza TODAS las etiquetas.',
          },
        },
      },
      example: { company: 'Acme Corp', tags: ['vip', 'mayorista'] },
    },
    envelope: 'data',
    responses: [
      {
        status: 200,
        description: 'El contacto ya actualizado.',
        schema: ref('Contact'),
        example: EXAMPLE_CONTACT,
      },
    ],
    errors: [ERR_BAD_REQUEST, ERR_NOT_FOUND],
  },
];
