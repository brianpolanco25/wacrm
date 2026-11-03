import { describe, expect, it } from 'vitest';

import {
  emptyIntegrationForm,
  emptyOperationForm,
  emptyOutputRow,
  emptyParamRow,
  integrationFormToBody,
  integrationToForm,
  operationFormToBody,
  operationToForm,
} from './integration-form';
import type { IntegrationRow, OperationRow } from '@/lib/integrations/types';

// n13.1 (R11): estado del formulario → cuerpo EXACTO del POST/PATCH.

const ROW: IntegrationRow = {
  id: '9a000000-0000-4000-8000-000000000001',
  slug: 'health',
  name: 'Cabbity Health',
  description: 'Citas',
  logo_url: null,
  base_url: 'https://health.example.com/api/v1',
  auth_scheme: 'header',
  auth_header_name: 'X-Api-Key',
  credential_help: null,
  test_path: '/me',
  is_active: true,
  sort_order: 3,
};

describe('integrationFormToBody', () => {
  it('create sends the slug and every field', () => {
    const form = {
      ...emptyIntegrationForm(2),
      slug: ' agenda ',
      name: ' Agenda ',
      baseUrl: 'https://agenda.example.com',
      testPath: '/ping',
    };
    expect(integrationFormToBody(form, 'create')).toEqual({
      ok: true,
      body: {
        slug: 'agenda',
        name: 'Agenda',
        description: null,
        logo_url: null,
        base_url: 'https://agenda.example.com',
        auth_scheme: 'bearer',
        auth_header_name: null,
        credential_help: null,
        test_path: '/ping',
        is_active: false,
        sort_order: 2,
      },
    });
  });

  it('edit never sends the slug (R6) and keeps the header name', () => {
    expect(integrationFormToBody(integrationToForm(ROW), 'edit')).toEqual({
      ok: true,
      body: {
        name: 'Cabbity Health',
        description: 'Citas',
        logo_url: null,
        base_url: 'https://health.example.com/api/v1',
        auth_scheme: 'header',
        auth_header_name: 'X-Api-Key',
        credential_help: null,
        test_path: '/me',
        is_active: true,
        sort_order: 3,
      },
    });
  });

  it('catches the obvious before a round trip', () => {
    const base = integrationToForm(ROW);
    expect(integrationFormToBody({ ...base, slug: '' }, 'create')).toEqual({
      ok: false,
      field: 'slug',
    });
    expect(integrationFormToBody({ ...base, name: ' ' }, 'edit')).toEqual({
      ok: false,
      field: 'name',
    });
    expect(integrationFormToBody({ ...base, headerName: '' }, 'edit')).toEqual({
      ok: false,
      field: 'auth_header_name',
    });
    expect(
      integrationFormToBody({ ...base, sortOrder: '1.5' }, 'edit')
    ).toEqual({
      ok: false,
      field: 'sort_order',
    });
  });
});

const OP: OperationRow = {
  id: '9b000000-0000-4000-8000-000000000002',
  integration_id: ROW.id,
  key: 'create_appointment',
  name: 'Crear cita',
  description: 'Crea una cita',
  method: 'POST',
  path: '/doctors/{doctorId}/appointments',
  params: [
    {
      name: 'doctorId',
      in: 'path',
      type: 'integer',
      required: true,
      description: 'Doctor',
    },
    {
      name: 'shift',
      in: 'body',
      type: 'string',
      required: false,
      description: 'Turno',
      enum: ['am', 'pm'],
    },
  ],
  outputs: [{ name: 'id', path: 'data.id', type: 'integer', description: '' }],
  response_description: null,
  is_active: true,
  sort_order: 2,
};

describe('operationFormToBody', () => {
  it('round-trips a stored operation into the exact body', () => {
    expect(operationFormToBody(operationToForm(OP))).toEqual({
      ok: true,
      body: {
        key: 'create_appointment',
        name: 'Crear cita',
        description: 'Crea una cita',
        method: 'POST',
        path: '/doctors/{doctorId}/appointments',
        params: OP.params,
        outputs: OP.outputs,
        response_description: null,
        is_active: true,
        sort_order: 2,
      },
    });
  });

  it('builds param and output rows: path params forced required, enum only for text', () => {
    const form = {
      ...emptyOperationForm(1),
      key: 'list',
      name: 'Listar',
      description: 'Lista',
      path: '/x/{id}',
      params: [
        {
          ...emptyParamRow(),
          name: 'id',
          in: 'path' as const,
          description: 'Id',
        },
        {
          ...emptyParamRow(),
          name: 'n',
          type: 'integer' as const,
          description: 'N',
          enumText: '1, 2',
        },
        {
          ...emptyParamRow(),
          name: 's',
          description: 'S',
          enumText: ' a , b ,',
        },
      ],
      outputs: [
        {
          ...emptyOutputRow(),
          name: 'items',
          path: 'data',
          type: 'array' as const,
        },
      ],
    };
    const r = operationFormToBody(form);
    expect(r.ok && r.body.params).toEqual([
      {
        name: 'id',
        in: 'path',
        type: 'string',
        required: true,
        description: 'Id',
      },
      {
        name: 'n',
        in: 'query',
        type: 'integer',
        required: false,
        description: 'N',
      },
      {
        name: 's',
        in: 'query',
        type: 'string',
        required: false,
        description: 'S',
        enum: ['a', 'b'],
      },
    ]);
    expect(r.ok && r.body.outputs).toEqual([
      { name: 'items', path: 'data', type: 'array', description: '' },
    ]);
  });

  it('flags incomplete rows', () => {
    const base = operationToForm(OP);
    expect(operationFormToBody({ ...base, params: [emptyParamRow()] })).toEqual(
      {
        ok: false,
        field: 'params',
      }
    );
    expect(
      operationFormToBody({ ...base, outputs: [emptyOutputRow()] })
    ).toEqual({
      ok: false,
      field: 'outputs',
    });
    expect(operationFormToBody({ ...base, description: '' })).toEqual({
      ok: false,
      field: 'description',
    });
  });
});
