import { describe, expect, it, vi } from 'vitest';

import type { HttpMethod, OperationParam } from '@/lib/integrations/types';

import { flattenToolArgs, MAX_ARG_DEPTH } from './args';

import {
  buildAiTools,
  buildParameterSchema,
  buildToolDescription,
  TOOL_NAME_RE,
  toolNameFor,
  type ToolSourceRow,
} from './schema';

// n13.3 R4–R9: del catálogo a herramientas del modelo.

function p(
  name: string,
  over: Omit<Partial<OperationParam>, 'in'> & { in?: string } = {}
): OperationParam {
  return {
    name,
    in: 'query',
    type: 'string',
    required: false,
    description: `desc ${name}`,
    ...over,
  } as OperationParam;
}

function row(
  key: string,
  over: {
    slug?: string;
    name?: string;
    integrationSort?: number;
    sort?: number;
    method?: HttpMethod;
    params?: OperationParam[];
    responseDescription?: string | null;
  } = {}
): ToolSourceRow {
  return {
    integration: {
      slug: over.slug ?? 'health',
      name: over.name ?? 'Cabbity Health',
      sortOrder: over.integrationSort ?? 1,
    },
    operation: {
      key,
      name: `Op ${key}`,
      description: `Does ${key}`,
      method: over.method ?? 'GET',
      params: over.params ?? [],
      responseDescription: over.responseDescription ?? null,
      sortOrder: over.sort ?? 1,
    },
  };
}

describe('buildAiTools — order, cap and draft (R4, R5)', () => {
  it('orders by integration sort/name then operation sort/key and caps at 20', () => {
    const rows: ToolSourceRow[] = [];
    for (let i = 0; i < 15; i += 1) {
      rows.push(
        row(`b_op_${String(i).padStart(2, '0')}`, {
          slug: 'zeta',
          name: 'Zeta',
          integrationSort: 2,
          sort: i,
        })
      );
    }
    for (let i = 0; i < 10; i += 1) {
      rows.push(row(`a_op_${String(i).padStart(2, '0')}`, { sort: 10 - i }));
    }
    rows.push(row('same_sort_b', { sort: 0 }), row('same_sort_a', { sort: 0 }));
    const tools = buildAiTools(rows, { mode: 'auto_reply' });
    expect(tools).toHaveLength(20);
    expect(tools.slice(0, 3).map((t) => t.operationKey)).toEqual([
      'same_sort_a',
      'same_sort_b',
      'a_op_09',
    ]);
    // 12 from health, then the first 8 of zeta in its sort order.
    expect(tools.slice(12).map((t) => t.operationKey)).toEqual(
      Array.from({ length: 8 }, (_, i) => `b_op_${String(i).padStart(2, '0')}`)
    );
  });

  it('draft keeps only GET operations', () => {
    const tools = buildAiTools(
      [
        row('search', { method: 'GET' }),
        row('create', { method: 'POST' }),
        row('cancel', { method: 'DELETE' }),
      ],
      { mode: 'draft' }
    );
    expect(tools.map((t) => t.operationKey)).toEqual(['search']);
    expect(
      buildAiTools([row('create', { method: 'POST' })], { mode: 'playground' })
    ).toHaveLength(1);
  });
});

describe('tool names (R6)', () => {
  it('uses <slug>__<key> with dashes turned into underscores', () => {
    const tools = buildAiTools(
      [row('search_patient', { slug: 'cabbity-health' })],
      { mode: 'auto_reply' }
    );
    expect(tools[0].name).toBe('cabbity_health__search_patient');
    expect(toolNameFor('health', 'search_patient', 1, new Set())).toBe(
      'health__search_patient'
    );
  });

  it('falls back to op<n>_<key> on a collision or a name over 64', () => {
    // `a-b` and `a_b` both map to `a_b__x`.
    const tools = buildAiTools(
      [
        row('x', { slug: 'a-b', name: 'A', integrationSort: 1 }),
        row('x', { slug: 'a_b', name: 'B', integrationSort: 2 }),
        row('k'.repeat(60), { slug: 'long-slug', integrationSort: 3 }),
      ],
      { mode: 'auto_reply' }
    );
    expect(tools.map((t) => t.name)).toEqual([
      'a_b__x',
      'op2_x',
      `op3_${'k'.repeat(60)}`,
    ]);
    expect(tools[2].name.length).toBeLessThanOrEqual(64);
    expect(toolNameFor('s', 'k'.repeat(64), 12, new Set())).toHaveLength(64);
    for (const t of tools) expect(t.name).toMatch(TOOL_NAME_RE);
  });

  it('every generated name matches the provider regex', () => {
    expect(TOOL_NAME_RE.source).toBe('^[a-zA-Z][a-zA-Z0-9_]{0,63}$');
    expect(toolNameFor('9lives', 'k', 4, new Set())).toBe('op4_k');
  });
});

describe('buildParameterSchema (R7, R8)', () => {
  it('maps types, required, string enum and drops non-caller locations', () => {
    const schema = buildParameterSchema([
      p('doctorId', { in: 'path', type: 'integer', required: true }),
      p('status', { enum: ['a', 'b'] }),
      p('size', { type: 'integer', enum: ['10', '20'] }),
      p('ratio', { in: 'body', type: 'number' }),
      p('flag', { in: 'body', type: 'boolean' }),
      p('Idempotency-Key', { in: 'header', required: true }),
    ]);
    expect(schema).toEqual({
      type: 'object',
      properties: {
        doctorId: { type: 'integer', description: 'desc doctorId' },
        status: {
          type: 'string',
          description: 'desc status',
          enum: ['a', 'b'],
        },
        size: {
          type: 'integer',
          description: 'desc size Allowed values: 10, 20.',
        },
        ratio: { type: 'number', description: 'desc ratio' },
        flag: { type: 'boolean', description: 'desc flag' },
      },
      required: ['doctorId'],
    });
  });

  it('no params → an empty object schema without required', () => {
    expect(buildParameterSchema([])).toEqual({
      type: 'object',
      properties: {},
    });
  });

  it('dotted names become nested objects with required propagated', () => {
    const schema = buildParameterSchema([
      p('consent.accepted', { in: 'body', type: 'boolean', required: true }),
      p('consent.version', { in: 'body' }),
      p('patient.contact.email', { in: 'body' }),
    ]);
    expect(schema).toEqual({
      type: 'object',
      properties: {
        consent: {
          type: 'object',
          properties: {
            accepted: { type: 'boolean', description: 'desc consent.accepted' },
            version: { type: 'string', description: 'desc consent.version' },
          },
          required: ['accepted'],
        },
        patient: {
          type: 'object',
          properties: {
            contact: {
              type: 'object',
              properties: {
                email: {
                  type: 'string',
                  description: 'desc patient.contact.email',
                },
              },
            },
          },
        },
      },
      required: ['consent'],
    });
  });

  it('a clash between a and a.b (either order) or a repeated name drops the operation', () => {
    expect(buildParameterSchema([p('a'), p('a.b')])).toBeNull();
    expect(buildParameterSchema([p('a.b'), p('a')])).toBeNull();
    expect(buildParameterSchema([p('a'), p('a')])).toBeNull();
    const tools = buildAiTools(
      [row('bad', { params: [p('a'), p('a.b')] }), row('good')],
      { mode: 'auto_reply' }
    );
    expect(tools.map((t) => t.operationKey)).toEqual(['good']);
  });

  it('never offers a parameter deeper than flattenToolArgs accepts (4)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const four = p('a.b.c.d', { in: 'body' });
    const five = p('a.b.c.d.e', { in: 'body' });
    const schema = buildParameterSchema([four, five])!;
    expect(
      JSON.stringify(schema.properties!.a.properties!.b.properties!.c)
    ).not.toContain('"e"');
    expect(
      schema.properties!.a.properties!.b.properties!.c.properties!.d
    ).toEqual({
      type: 'string',
      description: 'desc a.b.c.d',
    });
    // A required one that cannot be sent takes the operation out.
    expect(
      buildParameterSchema([p('x.y.z.w.v', { in: 'body', required: true })])
    ).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      '[ai tools] a parameter is nested too deeply for the AI'
    );
    // What is offered round-trips through flattenToolArgs.
    expect(flattenToolArgs({ a: { b: { c: { d: 'v' } } } })).toEqual({
      'a.b.c.d': 'v',
    });
    expect(MAX_ARG_DEPTH).toBe(4);
    warn.mockRestore();
  });

  it('a param named constructor or __proto__ is just a property', () => {
    const schema = buildParameterSchema([
      p('constructor', { required: true }),
      p('toString.x'),
    ])!;
    expect(Object.keys(schema.properties!)).toEqual([
      'constructor',
      'toString',
    ]);
    expect(schema.properties!.constructor).toEqual({
      type: 'string',
      description: 'desc constructor',
    });
    expect(schema.required).toEqual(['constructor']);
    expect(JSON.parse(JSON.stringify(schema)).properties.toString.type).toBe(
      'object'
    );
  });

  it('declaredParams keeps only path/query/body', () => {
    const [tool] = buildAiTools(
      [row('x', { params: [p('q'), p('IK', { in: 'header' })] })],
      { mode: 'auto_reply' }
    );
    expect(tool.declaredParams.map((d) => d.name)).toEqual(['q']);
  });
});

// n13.8 (A3): `normalize` lo aplica el ejecutor; el modelo no lo ve.
describe('buildParameterSchema with normalize (n13.8)', () => {
  it('does not expose normalize to the model', () => {
    const schema = buildParameterSchema([
      p('document_number', {
        in: 'body',
        required: true,
        normalize: 'compact',
      }),
    ]);
    expect(schema).toEqual({
      type: 'object',
      properties: {
        document_number: {
          type: 'string',
          description: 'desc document_number',
        },
      },
      required: ['document_number'],
    });
    expect(JSON.stringify(schema)).not.toMatch(/normalize|compact/);
  });
});

describe('buildToolDescription (R9)', () => {
  it('names integration and operation, adds Returns and marks writes', () => {
    expect(
      buildToolDescription({
        integrationName: 'Health',
        name: 'Buscar paciente',
        description: 'Busca por cédula.',
        responseDescription: 'Lista de pacientes',
        method: 'GET',
      })
    ).toBe(
      'Health: Buscar paciente. Busca por cédula. Returns: Lista de pacientes'
    );
    const write = buildToolDescription({
      integrationName: 'Health',
      name: 'Crear cita',
      description: 'Crea',
      responseDescription: null,
      method: 'POST',
    });
    expect(write.startsWith('Write operation.')).toBe(true);
    expect(write).not.toContain('Returns');
  });

  it('never passes 1024 characters', () => {
    const text = buildToolDescription({
      integrationName: 'H',
      name: 'N',
      description: 'd'.repeat(3000),
      responseDescription: 'r'.repeat(3000),
      method: 'PATCH',
    });
    expect(text.length).toBeLessThanOrEqual(1024);
  });
});

// n13.7 R26: la política no llega al modelo salvo la frase de requires_prior.
describe('buildAiTools — n13.7 ai_policy', () => {
  const withPolicy = (
    key: string,
    aiPolicy: unknown,
    method: HttpMethod = 'GET'
  ) => {
    const r = row(key, { slug: 'cabbity-health', method });
    r.operation.aiPolicy = aiPolicy;
    return r;
  };

  it('keeps the policy on the tool, never in the JSON schema, and appends the requires_prior sentence', () => {
    const tools = buildAiTools(
      [
        withPolicy('find_availability', { grounds: ['schedule'] }),
        withPolicy('list_appointments', { grounds: ['schedule'] }),
        withPolicy(
          'cancel_appointment',
          {
            requires_prior: [
              ['list_appointments', 'get_appointment'],
              ['find_availability'],
            ],
          },
          'POST'
        ),
      ],
      { mode: 'auto_reply' }
    );
    const cancel = tools.find((t) => t.operationKey === 'cancel_appointment')!;
    expect(cancel.policy).toEqual({
      requires_prior: [
        ['list_appointments', 'get_appointment'],
        ['find_availability'],
      ],
    });
    expect(cancel.description).toMatch(
      / Requires a previous call \(in an earlier message\) to: cabbity_health__list_appointments or get_appointment, then cabbity_health__find_availability\.$/
    );
    expect(cancel.description.length).toBeLessThanOrEqual(1024);
    const schemas = JSON.stringify(tools.map((t) => t.parameters));
    expect(schemas).not.toContain('ai_policy');
    expect(schemas).not.toContain('requires_prior');
    const find = tools.find((t) => t.operationKey === 'find_availability')!;
    expect(find.description).not.toContain('Requires a previous call');
  });

  it('a long description is cut before the sentence, which always survives within 1024', () => {
    const r = withPolicy('cancel_appointment', {
      requires_prior: [['find_availability']],
    });
    r.operation.description = 'x'.repeat(2000);
    const [t] = buildAiTools([r], { mode: 'auto_reply' });
    expect(t.description.length).toBeLessThanOrEqual(1024);
    expect(t.description).toMatch(/to: find_availability\.$/);
  });

  it('no or invalid policy → no policy field (tools unchanged)', () => {
    const [a, b] = buildAiTools(
      [row('a_op'), withPolicy('b_op', { grounds: ['nope'] })],
      { mode: 'auto_reply' }
    );
    expect('policy' in a).toBe(false);
    expect('policy' in b).toBe(false);
  });
});
