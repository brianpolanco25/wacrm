// ============================================================
// Registro: miembros de la cuenta.
// ============================================================

import type { OperationDef } from './types';

export const MEMBERS_OPERATIONS: OperationDef[] = [
  {
    method: 'get',
    path: '/members',
    operationId: 'listMembers',
    summary: 'Listar los miembros de la cuenta',
    description:
      'Las personas que usan la cuenta de la clave, de la más nueva a la más vieja. `id` es el id del usuario, el mismo que `assigned_agent_id` de una conversación. Solo nombre, correo y rol: nunca teléfonos ni tokens.',
    tag: 'members',
    scopes: ['members:read'],
    paginated: true,
    envelope: 'list',
    responses: [
      {
        status: 200,
        description: 'Una página de miembros.',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'full_name', 'email', 'role'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            full_name: { type: 'string' },
            email: { type: 'string' },
            role: {
              type: 'string',
              enum: ['owner', 'admin', 'agent', 'viewer'],
            },
          },
        },
        example: [
          {
            id: '4b1d2c3e-5f60-4718-9a2b-3c4d5e6f7081',
            full_name: 'Ada Lovelace',
            email: 'ada@acme.test',
            role: 'agent',
          },
        ],
      },
    ],
    errors: [],
  },
];
