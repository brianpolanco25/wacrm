import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_AUTH_HEADERS,
  isForbiddenHost,
  normalizeBaseUrl,
  pathPlaceholders,
  validateIntegrationInput,
  validateOperationInput,
  validateRelativePath,
} from './catalog-validate';

const INTEGRATION = {
  slug: 'health',
  name: 'Cabbity Health',
  description: 'Gestión médica',
  logo_url: 'https://cdn.example.com/health.png',
  base_url: 'https://health.example.com/api/v1/',
  auth_scheme: 'bearer',
  credential_help: 'Pide un token de usuario técnico',
  test_path: '/me',
};

function fieldOf(r: ReturnType<typeof validateIntegrationInput>) {
  return r.ok ? null : r.field;
}

describe('validateIntegrationInput (R5)', () => {
  it('accepts a full create and normalizes the base url', () => {
    const r = validateIntegrationInput(INTEGRATION, 'create');
    expect(r).toEqual({
      ok: true,
      value: {
        slug: 'health',
        name: 'Cabbity Health',
        description: 'Gestión médica',
        logo_url: 'https://cdn.example.com/health.png',
        base_url: 'https://health.example.com/api/v1',
        auth_scheme: 'bearer',
        credential_help: 'Pide un token de usuario técnico',
        test_path: '/me',
      },
    });
  });

  it.each([['A-upper'], ['1health'], ['h'], ['health_app'], ['x'.repeat(41)]])(
    'rejects slug %s',
    (slug) => {
      expect(
        fieldOf(validateIntegrationInput({ ...INTEGRATION, slug }, 'create'))
      ).toBe('slug');
    }
  );

  it('requires a name of 1–80 characters', () => {
    expect(
      fieldOf(
        validateIntegrationInput({ ...INTEGRATION, name: '  ' }, 'create')
      )
    ).toBe('name');
    expect(
      fieldOf(
        validateIntegrationInput(
          { ...INTEGRATION, name: 'x'.repeat(81) },
          'create'
        )
      )
    ).toBe('name');
  });

  it('caps description and credential_help at 500', () => {
    expect(
      fieldOf(
        validateIntegrationInput(
          { ...INTEGRATION, description: 'x'.repeat(501) },
          'create'
        )
      )
    ).toBe('description');
    expect(
      fieldOf(
        validateIntegrationInput(
          { ...INTEGRATION, credential_help: 'x'.repeat(501) },
          'create'
        )
      )
    ).toBe('credential_help');
  });

  it('logo_url must be null or https', () => {
    expect(
      fieldOf(
        validateIntegrationInput(
          { ...INTEGRATION, logo_url: 'http://x.com/a.png' },
          'create'
        )
      )
    ).toBe('logo_url');
    const r = validateIntegrationInput(
      { ...INTEGRATION, logo_url: null },
      'create'
    );
    expect(r.ok && r.value.logo_url).toBeNull();
  });

  it.each([
    ['http://health.example.com'],
    ['https://10.0.0.1'],
    ['https://192.168.1.4/api'],
    ['https://169.254.169.254'],
    ['https://[::1]/x'],
    ['https://[::ffff:127.0.0.1]/api'],
    ['https://[::ffff:169.254.169.254]'],
    ['https://[::ffff:7f00:1]'],
    ['https://[::127.0.0.1]'],
    ['https://[64:ff9b::a9fe:a9fe]'],
    ['https://localhost'],
    ['https://api.localhost'],
    ['https://svc.internal'],
    ['https://printer.local'],
    ['https://u:p@x.com'],
    ['https://x.com/api?key=1'],
    ['https://x.com/api#frag'],
    ['https://x.com/a//b'],
    ['ftp://x.com'],
    ['not a url'],
  ])('rejects base_url %s', (base_url) => {
    expect(
      fieldOf(validateIntegrationInput({ ...INTEGRATION, base_url }, 'create'))
    ).toBe('base_url');
  });

  it('rejects an unknown auth scheme', () => {
    expect(
      fieldOf(
        validateIntegrationInput(
          { ...INTEGRATION, auth_scheme: 'basic' },
          'create'
        )
      )
    ).toBe('auth_scheme');
  });

  it('header scheme needs a valid, non-reserved header name', () => {
    expect(
      fieldOf(
        validateIntegrationInput(
          { ...INTEGRATION, auth_scheme: 'header' },
          'create'
        )
      )
    ).toBe('auth_header_name');
    expect(
      validateIntegrationInput(
        {
          ...INTEGRATION,
          auth_scheme: 'header',
          auth_header_name: 'X-Api-Key',
        },
        'create'
      ).ok
    ).toBe(true);
    // Authorization is allowed (`Token xxx` schemes).
    expect(
      validateIntegrationInput(
        {
          ...INTEGRATION,
          auth_scheme: 'header',
          auth_header_name: 'Authorization',
        },
        'create'
      ).ok
    ).toBe(true);
    expect(
      fieldOf(
        validateIntegrationInput(
          { ...INTEGRATION, auth_scheme: 'header', auth_header_name: 'X Api' },
          'create'
        )
      )
    ).toBe('auth_header_name');
  });

  it.each([...FORBIDDEN_AUTH_HEADERS, 'Host', 'COOKIE'])(
    'refuses reserved header %s',
    (auth_header_name) => {
      expect(
        fieldOf(
          validateIntegrationInput(
            { ...INTEGRATION, auth_scheme: 'header', auth_header_name },
            'create'
          )
        )
      ).toBe('auth_header_name');
    }
  );

  it('test_path follows R8 and takes no placeholders', () => {
    for (const test_path of [
      'me',
      '/../x',
      '/a?b=1',
      '//evil.com/x',
      '/a/{id}',
    ]) {
      expect(
        fieldOf(
          validateIntegrationInput({ ...INTEGRATION, test_path }, 'create')
        )
      ).toBe('test_path');
    }
  });

  it('a create cannot be born active (R5); an explicit false is fine', () => {
    expect(
      fieldOf(
        validateIntegrationInput({ ...INTEGRATION, is_active: true }, 'create')
      )
    ).toBe('is_active');
    const r = validateIntegrationInput(
      { ...INTEGRATION, is_active: false },
      'create'
    );
    expect(r.ok && 'is_active' in r.value).toBe(false);
    expect(validateIntegrationInput({ is_active: true }, 'update')).toEqual({
      ok: true,
      value: { is_active: true },
    });
  });

  it('refuses unknown fields and missing required ones', () => {
    expect(
      fieldOf(
        validateIntegrationInput({ ...INTEGRATION, is_admin: true }, 'create')
      )
    ).toBe('is_admin');
    const noBase: Record<string, unknown> = { ...INTEGRATION };
    delete noBase.base_url;
    expect(fieldOf(validateIntegrationInput(noBase, 'create'))).toBe(
      'base_url'
    );
  });
});

describe('validateIntegrationInput update (R6)', () => {
  it('takes a partial body', () => {
    expect(validateIntegrationInput({ name: 'Health' }, 'update')).toEqual({
      ok: true,
      value: { name: 'Health' },
    });
  });

  it('refuses to change the slug', () => {
    expect(fieldOf(validateIntegrationInput({ slug: 'other' }, 'update'))).toBe(
      'slug'
    );
  });

  it('refuses an empty edit', () => {
    expect(fieldOf(validateIntegrationInput({}, 'update'))).toBe('body');
  });

  it('combines auth_scheme with the stored header name', () => {
    expect(
      fieldOf(
        validateIntegrationInput({ auth_scheme: 'header' }, 'update', {
          auth_scheme: 'bearer',
          auth_header_name: null,
        })
      )
    ).toBe('auth_header_name');
    expect(
      validateIntegrationInput({ auth_scheme: 'header' }, 'update', {
        auth_scheme: 'bearer',
        auth_header_name: 'X-Key',
      }).ok
    ).toBe(true);
    expect(
      fieldOf(
        validateIntegrationInput({ auth_header_name: null }, 'update', {
          auth_scheme: 'header',
          auth_header_name: 'X-Key',
        })
      )
    ).toBe('auth_header_name');
  });
});

describe('isForbiddenHost', () => {
  it('reads the hex form the URL parser writes for IPv4-mapped literals', () => {
    expect(
      isForbiddenHost(new URL('https://[::ffff:127.0.0.1]').hostname)
    ).toBe(true);
    expect(
      isForbiddenHost(new URL('https://[::ffff:169.254.169.254]').hostname)
    ).toBe(true);
    expect(isForbiddenHost(new URL('https://[::ffff:8.8.8.8]').hostname)).toBe(
      false
    );
    expect(isForbiddenHost('health.example.com')).toBe(false);
  });
});

describe('normalizeBaseUrl', () => {
  it('drops the trailing slash and keeps the prefix', () => {
    expect(normalizeBaseUrl('https://x.com/')).toBe('https://x.com');
    expect(normalizeBaseUrl('https://x.com:8443/api/v1')).toBe(
      'https://x.com:8443/api/v1'
    );
  });
});

describe('validateRelativePath (R8)', () => {
  it.each([['/'], ['/a/{id}'], ['/doctors/{doctorId}/slots'], ['/a-b_c.d~e']])(
    'accepts %s',
    (p) => expect(validateRelativePath(p)).toBe(true)
  );
  it.each([
    ['a/b'],
    ['/../x'],
    ['/a/..'],
    ['/a/./b'],
    ['//evil.com/x'],
    ['/a?b=1'],
    ['/a#b'],
    ['/a\\b'],
    ['/a b'],
    ['/a/%2e%2e/b'],
    ['https://evil.com/x'],
    ['/a/{'],
    ['/a/{Id}'],
    ['/a/{id'],
    [42],
  ])('rejects %s', (p) => expect(validateRelativePath(p)).toBe(false));

  it('pathPlaceholders lists them once, in order', () => {
    expect(pathPlaceholders('/a/{id}/b/{slot}/{id}')).toEqual(['id', 'slot']);
  });
});

const CREATE_APPOINTMENT = {
  key: 'create_appointment',
  name: 'Crear cita',
  description: 'Crea una cita para un paciente con un doctor a una hora.',
  method: 'POST',
  path: '/appointments',
  params: [
    {
      name: 'doctor_id',
      in: 'body',
      type: 'integer',
      required: true,
      description: 'Id del doctor',
    },
    {
      name: 'starts_at',
      in: 'body',
      type: 'string',
      required: true,
      description: 'Inicio ISO 8601',
    },
  ],
  outputs: [
    {
      name: 'appointmentId',
      path: 'data.id',
      type: 'integer',
      description: 'Id de la cita',
    },
  ],
  response_description: 'La cita creada',
};

function opField(r: ReturnType<typeof validateOperationInput>) {
  return r.ok ? null : r.field;
}

describe('validateOperationInput (R7, R9)', () => {
  it('round-trips the Health "crear cita" example', () => {
    const r = validateOperationInput(CREATE_APPOINTMENT, 'create');
    expect(r).toEqual({ ok: true, value: CREATE_APPOINTMENT });
  });

  it('defaults params and outputs to [] on create', () => {
    const r = validateOperationInput(
      {
        key: 'list_doctors',
        name: 'Doctores',
        description: 'Lista',
        method: 'GET',
        path: '/doctors',
      },
      'create'
    );
    expect(r.ok && r.value.params).toEqual([]);
    expect(r.ok && r.value.outputs).toEqual([]);
  });

  it.each([['Bad'], ['a'], ['create-appointment'], ['1x']])(
    'rejects key %s',
    (key) => {
      expect(
        opField(
          validateOperationInput({ ...CREATE_APPOINTMENT, key }, 'create')
        )
      ).toBe('key');
    }
  );

  it('requires a description of 1–1000 characters', () => {
    expect(
      opField(
        validateOperationInput(
          { ...CREATE_APPOINTMENT, description: '' },
          'create'
        )
      )
    ).toBe('description');
    expect(
      opField(
        validateOperationInput(
          { ...CREATE_APPOINTMENT, description: 'x'.repeat(1001) },
          'create'
        )
      )
    ).toBe('description');
  });

  it('rejects an unknown method', () => {
    expect(
      opField(
        validateOperationInput(
          { ...CREATE_APPOINTMENT, method: 'HEAD' },
          'create'
        )
      )
    ).toBe('method');
  });

  it('caps response_description at 1000', () => {
    expect(
      opField(
        validateOperationInput(
          { ...CREATE_APPOINTMENT, response_description: 'x'.repeat(1001) },
          'create'
        )
      )
    ).toBe('response_description');
  });

  const pathOp = (path: string, params: unknown[]) => ({
    ...CREATE_APPOINTMENT,
    method: 'GET',
    path,
    params,
  });
  const idParam = {
    name: 'id',
    in: 'path',
    type: 'integer',
    required: true,
    description: 'Id',
  };

  it('placeholders must match the path params (R8)', () => {
    expect(
      validateOperationInput(pathOp('/a/{id}', [idParam]), 'create').ok
    ).toBe(true);
    expect(
      opField(validateOperationInput(pathOp('/a/{id}', []), 'create'))
    ).toBe('path');
    expect(
      opField(validateOperationInput(pathOp('/a', [idParam]), 'create'))
    ).toBe('path');
    expect(opField(validateOperationInput(pathOp('/../x', []), 'create'))).toBe(
      'path'
    );
    expect(
      opField(validateOperationInput(pathOp('/a?b=1', []), 'create'))
    ).toBe('path');
    expect(
      opField(validateOperationInput(pathOp('//evil.com/x', []), 'create'))
    ).toBe('path');
  });

  it('a path param must be required', () => {
    expect(
      opField(
        validateOperationInput(
          pathOp('/a/{id}', [{ ...idParam, required: false }]),
          'create'
        )
      )
    ).toBe('params');
  });

  it('GET and DELETE take no body params', () => {
    for (const method of ['GET', 'DELETE']) {
      expect(
        opField(
          validateOperationInput({ ...CREATE_APPOINTMENT, method }, 'create')
        )
      ).toBe('params');
    }
  });

  const withParam = (p: Record<string, unknown>) => ({
    ...CREATE_APPOINTMENT,
    params: [
      {
        name: 'x',
        in: 'query',
        type: 'string',
        required: false,
        description: 'X',
        ...p,
      },
    ],
  });

  it.each([
    [{ name: 'Bad' }],
    [{ name: '_x' }],
    [{ in: 'header' }],
    [{ type: 'date' }],
    [{ required: 'yes' }],
    [{ description: '' }],
    [{ description: 'x'.repeat(501) }],
    [{ enum: ['a'], type: 'integer' }],
    [{ enum: [] }],
    [{ enum: Array.from({ length: 51 }, (_, i) => `v${i}`) }],
    [{ enum: ['a', 'a'] }],
    [{ extra: 1 }],
  ])('rejects param %o', (p) => {
    expect(opField(validateOperationInput(withParam(p), 'create'))).toBe(
      'params'
    );
  });

  it('accepts a string enum', () => {
    const r = validateOperationInput(
      withParam({ enum: ['am', 'pm'] }),
      'create'
    );
    expect(r.ok && r.value.params?.find((p) => p.name === 'x')?.enum).toEqual([
      'am',
      'pm',
    ]);
  });

  it('rejects repeated param names and more than 30 params', () => {
    const p = {
      name: 'x',
      in: 'query',
      type: 'string',
      required: false,
      description: 'X',
    };
    expect(
      opField(
        validateOperationInput(
          { ...CREATE_APPOINTMENT, params: [p, p] },
          'create'
        )
      )
    ).toBe('params');
    const many = Array.from({ length: 31 }, (_, i) => ({
      ...p,
      name: `p${i}`,
    }));
    expect(
      opField(
        validateOperationInput(
          { ...CREATE_APPOINTMENT, params: many },
          'create'
        )
      )
    ).toBe('params');
  });

  it.each([
    [{ path: 'data..id' }],
    [{ path: '.data' }],
    [{ path: 'data id' }],
    [{ type: 'date' }],
    [{ name: 'Bad' }],
  ])('rejects output %o', (o) => {
    const outputs = [
      {
        name: 'out',
        path: 'data.items.0.id',
        type: 'array',
        description: '',
        ...o,
      },
    ];
    expect(
      opField(
        validateOperationInput({ ...CREATE_APPOINTMENT, outputs }, 'create')
      )
    ).toBe('outputs');
  });

  it('accepts object and array outputs', () => {
    const outputs = [
      { name: 'items', path: 'data.items', type: 'array', description: '' },
      { name: 'first', path: 'data.items.0', type: 'object', description: '' },
    ];
    expect(
      validateOperationInput({ ...CREATE_APPOINTMENT, outputs }, 'create').ok
    ).toBe(true);
  });
});

describe('validateOperationInput update', () => {
  const existing = {
    method: 'POST' as const,
    path: '/appointments',
    params: CREATE_APPOINTMENT.params as never,
  };

  it('a PATCH that only switches to GET with stored body params is a 400', () => {
    expect(
      opField(validateOperationInput({ method: 'GET' }, 'update', existing))
    ).toBe('params');
  });

  it('a PATCH that adds a placeholder without its param is a 400', () => {
    expect(
      opField(
        validateOperationInput(
          { path: '/appointments/{id}' },
          'update',
          existing
        )
      )
    ).toBe('path');
  });

  it('a PATCH of the name alone passes', () => {
    expect(
      validateOperationInput({ name: 'Nueva cita' }, 'update', existing)
    ).toEqual({
      ok: true,
      value: { name: 'Nueva cita' },
    });
  });
});

// ---- n13.5 (R9, R13): cabeceras autogeneradas y cuerpos anidados ----

const IK = {
  name: 'Idempotency-Key',
  in: 'header',
  type: 'string',
  required: true,
  auto: 'uuid',
  description: 'Clave de idempotencia; la genera el CRM.',
};

function withParams(params: unknown[]) {
  return validateOperationInput({ ...CREATE_APPOINTMENT, params }, 'create');
}

function paramsError(params: unknown[]): string | null {
  const r = withParams(params);
  return r.ok ? null : `${r.field}: ${r.error}`;
}

describe('validateOperationInput: header params (n13.5, R9)', () => {
  it('accepts an auto uuid header and keeps `auto` in the output', () => {
    const r = withParams([...CREATE_APPOINTMENT.params, IK]);
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.params?.at(-1)).toEqual(IK);
    // The n13.1 params keep their shape: no `auto` key added.
    expect(r.ok && 'auto' in r.value.params![0]).toBe(false);
  });

  it.each([
    ['without auto', { ...IK, auto: undefined }],
    ['with an unknown auto', { ...IK, auto: 'random' }],
    ['typed integer', { ...IK, type: 'integer' }],
    ['optional', { ...IK, required: false }],
    ['with an enum', { ...IK, enum: ['a'] }],
    ['named Authorization', { ...IK, name: 'Authorization' }],
    ['named content-type', { ...IK, name: 'content-type' }],
    ['named Cookie', { ...IK, name: 'Cookie' }],
    ['with a bad name', { ...IK, name: 'X Key' }],
  ])('rejects a header %s', (_label, param) => {
    expect(paramsError([param])).toMatch(/^params: /);
  });

  it('rejects two headers with the same name in another case', () => {
    expect(paramsError([IK, { ...IK, name: 'idempotency-key' }])).toMatch(
      /repeated/
    );
  });

  it.each(['query', 'body', 'path'])('rejects auto with in: %s', (loc) => {
    expect(
      paramsError([
        {
          name: 'id',
          in: loc,
          type: 'string',
          required: true,
          description: 'x',
          auto: 'uuid',
        },
      ])
    ).toMatch(/auto is only allowed/);
  });

  it('a header is fine in a GET', () => {
    const r = validateOperationInput(
      {
        key: 'list_x',
        name: 'X',
        description: 'x',
        method: 'GET',
        path: '/x',
        params: [IK],
      },
      'create'
    );
    expect(r.ok).toBe(true);
  });
});

describe('validateOperationInput: dotted body names (n13.5, R13)', () => {
  const leaf = (name: string, loc = 'body') => ({
    name,
    in: loc,
    type: 'boolean',
    required: true,
    description: 'x',
  });

  it('accepts consent.accepted in body and up to 3 parts', () => {
    expect(withParams([leaf('consent.accepted'), leaf('a.b.c')]).ok).toBe(true);
  });

  it.each(['query', 'path'])('rejects a dotted name in %s', (loc) => {
    expect(paramsError([leaf('consent.accepted', loc)])).toMatch(
      /name must match/
    );
  });

  it.each(['a.b.c.d', 'consent.', '.x', 'consent.Accepted', 'a..b'])(
    'rejects %s',
    (name) => {
      expect(paramsError([leaf(name)])).toMatch(/dot-separated/);
    }
  );

  it('rejects a name that is both a leaf and a prefix', () => {
    expect(paramsError([leaf('consent'), leaf('consent.accepted')])).toMatch(
      /both a value and an object/
    );
    expect(paramsError([leaf('a.b.c'), leaf('a.b')])).toMatch(
      /both a value and an object/
    );
  });

  it('siblings under one parent are fine', () => {
    expect(
      withParams([leaf('consent.accepted'), leaf('consent.reference')]).ok
    ).toBe(true);
  });
});
