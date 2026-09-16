// ============================================================
// Registro: identidad (`GET /me`).
//
// La ÚNICA operación de la API sin scope: basta con una clave válida.
// Por eso es la que se usa para verificar que una clave funciona y
// para descubrir qué puede hacer.
// ============================================================

import { ref } from './schemas';
import type { OperationDef } from './types';

export const ME_OPERATIONS: OperationDef[] = [
  {
    method: 'get',
    path: '/me',
    operationId: 'getMe',
    summary: 'Identidad de la clave',
    description:
      'Devuelve la cuenta a la que está atada la clave y los scopes que lleva. No exige ningún scope: una clave sin permisos autentica y puede llamar aquí. Úsalo para comprobar que una clave funciona.',
    tag: 'me',
    scopes: [],
    envelope: 'data',
    responses: [
      {
        status: 200,
        description: 'La cuenta y la clave.',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['account', 'key'],
          properties: {
            account: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'name'],
              properties: {
                id: { type: 'string', format: 'uuid' },
                name: { type: ['string', 'null'] },
              },
            },
            key: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'scopes'],
              properties: {
                id: { type: 'string', format: 'uuid' },
                scopes: { type: 'array', items: ref('ApiScope') },
              },
            },
          },
        },
        example: {
          account: {
            id: '9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b',
            name: 'Acme Inc',
          },
          key: {
            id: '1a2b3c4d-5e6f-4071-8283-94a5b6c7d8e9',
            scopes: ['messages:send', 'contacts:read'],
          },
        },
      },
    ],
    errors: [],
  },
];
