// ============================================================
// Registro: etiquetas.
//
// Siete operaciones: el CRUD de `/tags` y las dos puertas de
// asignación por id que cuelgan de `/contacts/{id}`. Todas las de
// escritura piden `tags:write`, también las que viven bajo contactos.
// ============================================================

import {
  ERR_BAD_REQUEST,
  ERR_CONFLICT,
  ERR_NOT_FOUND,
  pathParam,
  queryParam,
} from './common';
import { EXAMPLE_CONTACT, EXAMPLE_TAG, ref } from './schemas';
import type { OperationDef } from './types';

const TAG_ID = pathParam('id', 'Id de la etiqueta.');
const CONTACT_ID = pathParam('id', 'Id del contacto.');

export const TAGS_OPERATIONS: OperationDef[] = [
  {
    method: 'get',
    path: '/tags',
    operationId: 'listTags',
    summary: 'Listar etiquetas',
    description: 'Las etiquetas de la cuenta, de la más nueva a la más vieja.',
    tag: 'tags',
    scopes: ['tags:read'],
    paginated: true,
    parameters: [
      queryParam(
        'search',
        'Coincidencia por nombre, sin distinguir mayúsculas.'
      ),
    ],
    envelope: 'list',
    responses: [
      {
        status: 200,
        description: 'Una página de etiquetas.',
        schema: ref('Tag'),
        example: [EXAMPLE_TAG],
      },
    ],
    errors: [],
  },
  {
    method: 'post',
    path: '/tags',
    operationId: 'createTag',
    summary: 'Crear una etiqueta',
    description:
      '**Busca-o-crea por nombre, sin distinguir mayúsculas**: un nombre que la cuenta ya usa devuelve `200` con la etiqueta existente y no le toca el color; uno nuevo devuelve `201`. La regla la impone la base, así que dos llamadas simultáneas con el mismo nombre producen una sola etiqueta.',
    tag: 'tags',
    scopes: ['tags:write'],
    idempotent: true,
    requestBody: {
      required: true,
      description: '`name` obligatorio; `color` opcional.',
      schema: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 64 },
          color: {
            type: 'string',
            description: 'Hex `#rgb` o `#rrggbb`. Por defecto `#3b82f6`.',
          },
        },
      },
      example: { name: 'vip', color: '#3b82f6' },
    },
    envelope: 'data',
    responses: [
      {
        status: 200,
        description: 'La cuenta ya tenía una etiqueta con ese nombre.',
        schema: ref('Tag'),
        example: EXAMPLE_TAG,
      },
      {
        status: 201,
        description: 'Etiqueta creada.',
        schema: ref('Tag'),
        example: EXAMPLE_TAG,
      },
    ],
    errors: [ERR_BAD_REQUEST],
  },
  {
    method: 'get',
    path: '/tags/{id}',
    operationId: 'getTag',
    summary: 'Leer una etiqueta',
    description: 'Una etiqueta por su id.',
    tag: 'tags',
    scopes: ['tags:read'],
    parameters: [TAG_ID],
    envelope: 'data',
    responses: [
      {
        status: 200,
        description: 'La etiqueta.',
        schema: ref('Tag'),
        example: EXAMPLE_TAG,
      },
    ],
    errors: [ERR_NOT_FOUND],
  },
  {
    method: 'patch',
    path: '/tags/{id}',
    operationId: 'updateTag',
    summary: 'Renombrar o recolorear una etiqueta',
    description:
      'Acepta `name`, `color` o ambos. Renombrar a un nombre que la cuenta ya usa es `409`; cambiarle solo las mayúsculas al nombre propio está permitido.',
    tag: 'tags',
    scopes: ['tags:write'],
    parameters: [TAG_ID],
    requestBody: {
      required: true,
      description: 'Al menos uno de los dos campos.',
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 64 },
          color: { type: 'string' },
        },
      },
      example: { name: 'VIP' },
    },
    envelope: 'data',
    responses: [
      {
        status: 200,
        description: 'La etiqueta ya actualizada.',
        schema: ref('Tag'),
        example: { ...EXAMPLE_TAG, name: 'VIP' },
      },
    ],
    errors: [
      ERR_BAD_REQUEST,
      ERR_NOT_FOUND,
      {
        ...ERR_CONFLICT,
        description: 'La cuenta ya usa ese nombre en otra etiqueta.',
      },
    ],
  },
  {
    method: 'delete',
    path: '/tags/{id}',
    operationId: 'deleteTag',
    summary: 'Borrar una etiqueta',
    description:
      'Borra la etiqueta **y la desprende de todos los contactos que la llevaban**.',
    tag: 'tags',
    scopes: ['tags:write'],
    parameters: [TAG_ID],
    envelope: 'data',
    responses: [
      {
        status: 200,
        description: 'Borrada.',
        schema: ref('DeletedResource'),
        example: { id: EXAMPLE_TAG.id, deleted: true },
      },
    ],
    errors: [ERR_NOT_FOUND],
  },
  {
    method: 'post',
    path: '/contacts/{id}/tags',
    operationId: 'addContactTags',
    summary: 'Añadir etiquetas a un contacto',
    description:
      'La puerta **aditiva**, por id: añade sin tocar las que el contacto ya lleva (a diferencia de `PATCH /contacts/{id}`, que reemplaza y va por nombre). Todo o nada: cada id se resuelve contra la cuenta antes de la primera escritura, así que una lista con un id desconocido o ajeno no adjunta ninguna y no dispara ningún evento. Una etiqueta que el contacto ya tenía es un no-op, no un segundo `contact.tag_added`.',
    tag: 'tags',
    scopes: ['tags:write'],
    idempotent: true,
    parameters: [CONTACT_ID],
    requestBody: {
      required: true,
      description: 'Ids de etiqueta, 1–50 por llamada.',
      schema: {
        type: 'object',
        required: ['tag_ids'],
        properties: {
          tag_ids: {
            type: 'array',
            minItems: 1,
            maxItems: 50,
            items: { type: 'string', format: 'uuid' },
          },
        },
      },
      example: { tag_ids: [EXAMPLE_TAG.id] },
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
    errors: [
      ERR_BAD_REQUEST,
      {
        ...ERR_NOT_FOUND,
        description:
          'El contacto o alguna de las etiquetas no existe en esta cuenta. No se adjuntó ninguna.',
      },
    ],
  },
  {
    method: 'delete',
    path: '/contacts/{id}/tags/{tagId}',
    operationId: 'removeContactTag',
    summary: 'Quitar una etiqueta de un contacto',
    description:
      'Idempotente: quitar una etiqueta que el contacto no lleva es un `200` con el contacto intacto, y **no** emite `contact.tag_removed` — ese evento solo viaja cuando algo se fue de verdad.',
    tag: 'tags',
    scopes: ['tags:write'],
    parameters: [CONTACT_ID, pathParam('tagId', 'Id de la etiqueta a quitar.')],
    envelope: 'data',
    responses: [
      {
        status: 200,
        description: 'El contacto ya actualizado.',
        schema: ref('Contact'),
        example: { ...EXAMPLE_CONTACT, tags: [] },
      },
    ],
    errors: [ERR_NOT_FOUND],
  },
];
