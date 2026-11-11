import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  validateIntegrationInput,
  validateOperationInput,
} from '../catalog-validate';
import { buildIntegrationRequest, callerParams } from '../request';
import { CABBITY_HEALTH_CATALOG } from './cabbity-health';
import { INTEGRATION_CATALOGS } from './index';

// n13.5 (R1–R4, R16): la definición de Cabbity Health es válida para el
// panel y fiel al OpenAPI versionado en docs/integrations/.

type Schema = {
  $ref?: string;
  type?: string | string[];
  enum?: string[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
};
type OpenApiParam = {
  name: string;
  in: string;
  required?: boolean;
  schema?: Schema;
};
type OpenApiOperation = {
  parameters?: OpenApiParam[];
  requestBody?: { content: Record<string, { schema: Schema }> };
};

const OPENAPI = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../../docs/integrations/cabbity-health-openapi.json',
        import.meta.url
      )
    ),
    'utf8'
  )
) as {
  servers: { url: string }[];
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, Schema> };
};

const { integration, operations } = CABBITY_HEALTH_CATALOG;
const byKey = new Map(operations.map((op) => [op.key, op]));
const op = (key: string) => {
  const found = byKey.get(key);
  if (!found) throw new Error(`no operation ${key}`);
  return found;
};

function resolve(schema: Schema | undefined): Schema | undefined {
  if (!schema?.$ref) return schema;
  const name = schema.$ref.replace('#/components/schemas/', '');
  return OPENAPI.components.schemas[name];
}

function openApiOperation(method: string, path: string) {
  const item = OPENAPI.paths[path];
  const operation = item?.[method.toLowerCase()] as
    OpenApiOperation | undefined;
  if (!operation) return null;
  const parameters = [
    ...((item.parameters as OpenApiParam[] | undefined) ?? []),
    ...(operation.parameters ?? []),
  ];
  const body = resolve(
    operation.requestBody?.content['application/json']?.schema
  );
  return { parameters, body };
}

/** Propiedad (con puntos) del cuerpo y si es obligatoria por toda la cadena. */
function bodyProperty(
  body: Schema | undefined,
  name: string
): { schema: Schema; required: boolean } | null {
  let node = body;
  let required = true;
  let schema: Schema | undefined;
  for (const part of name.split('.')) {
    node = resolve(node);
    schema = node?.properties?.[part];
    if (!schema) return null;
    required = required && (node?.required ?? []).includes(part);
    node = schema;
  }
  return schema ? { schema: resolve(schema)!, required } : null;
}

function scalarType(schema: Schema): string | undefined {
  const t = Array.isArray(schema.type)
    ? schema.type.filter((x) => x !== 'null')
    : [schema.type];
  return t.length === 1 ? t[0] : undefined;
}

/** Desviaciones deliberadas de `required` (design §1, D1). */
const REQUIRED_DEVIATIONS = new Set(['list_appointments.patient_id']);

const EXPECTED = [
  ['get_center', 'GET', '/me'],
  ['list_locations', 'GET', '/locations'],
  ['list_practitioners', 'GET', '/practitioners'],
  ['get_practitioner', 'GET', '/practitioners/{id}'],
  ['list_specialties', 'GET', '/specialties'],
  ['find_availability', 'GET', '/availability'],
  ['lookup_patient', 'POST', '/patients/lookup'],
  ['list_patients', 'GET', '/patients'],
  ['create_patient', 'POST', '/patients'],
  ['get_patient', 'GET', '/patients/{id}'],
  ['list_appointments', 'GET', '/appointments'],
  ['create_appointment', 'POST', '/appointments'],
  ['get_appointment', 'GET', '/appointments/{id}'],
  ['reschedule_appointment', 'POST', '/appointments/{id}/reschedule'],
  ['confirm_appointment', 'POST', '/appointments/{id}/confirm'],
  ['cancel_appointment', 'POST', '/appointments/{id}/cancel'],
];

describe('CABBITY_HEALTH_CATALOG integration (R1)', () => {
  it('has the Health slug, origin, scheme and test path', () => {
    expect(integration).toMatchObject({
      slug: 'cabbity-health',
      base_url: 'https://api.health.cabbity.com/api/integrations/v1',
      auth_scheme: 'bearer',
      auth_header_name: null,
      test_path: '/me',
    });
    expect(integration.credential_help.trim()).not.toBe('');
    expect(integration.base_url).toBe(OPENAPI.servers[0].url);
  });

  it('passes validateIntegrationInput unchanged', () => {
    expect(validateIntegrationInput(integration, 'create')).toEqual({
      ok: true,
      value: integration,
    });
  });

  it('is registered under its slug', () => {
    expect(INTEGRATION_CATALOGS['cabbity-health']).toBe(CABBITY_HEALTH_CATALOG);
  });
});

describe('CABBITY_HEALTH_CATALOG operations (R2)', () => {
  it('declares exactly the 16 operations of design §3', () => {
    expect(operations.map((o) => [o.key, o.method, o.path])).toEqual(EXPECTED);
  });

  it.each(operations.map((o) => [o.key, o]))(
    '%s passes validateOperationInput unchanged',
    (_key, operation) => {
      expect(validateOperationInput(operation, 'create')).toEqual({
        ok: true,
        value: operation,
      });
    }
  );

  it.each([
    ['PATCH', '/patients/{id}'],
    ['DELETE', '/patients/{id}'],
    ['DELETE', '/appointments/{id}'],
  ])('leaves out %s %s', (method, path) => {
    expect(operations.some((o) => o.method === method && o.path === path)).toBe(
      false
    );
    // …which do exist in the OpenAPI: they are left out on purpose.
    expect(openApiOperation(method, path)).not.toBeNull();
  });

  it('D1: list_patients and get_patient are born off, the rest on', () => {
    for (const o of operations) {
      expect([o.key, o.is_active]).toEqual([
        o.key,
        !['list_patients', 'get_patient'].includes(o.key),
      ]);
    }
  });

  it('keys and sort orders are unique', () => {
    expect(new Set(operations.map((o) => o.key)).size).toBe(16);
    expect(new Set(operations.map((o) => o.sort_order)).size).toBe(16);
  });
});

describe('CABBITY_HEALTH_CATALOG matches the OpenAPI (R3)', () => {
  it.each(operations.map((o) => [o.key, o]))('%s', (key, operation) => {
    const spec = openApiOperation(operation.method, operation.path);
    expect(spec, `${operation.method} ${operation.path}`).not.toBeNull();
    const { parameters, body } = spec!;

    for (const p of operation.params) {
      const label = `${key}.${p.name}`;
      let schema: Schema | undefined;
      let required: boolean;
      if (p.in === 'body') {
        const prop = bodyProperty(body, p.name);
        expect(prop, label).not.toBeNull();
        schema = prop!.schema;
        required = prop!.required;
      } else {
        const declared = parameters.find(
          (x) =>
            x.in === p.in &&
            (p.in === 'header'
              ? x.name.toLowerCase() === p.name.toLowerCase()
              : x.name === p.name)
        );
        expect(declared, label).toBeDefined();
        schema = declared!.schema;
        required = p.in === 'path' || declared!.required === true;
      }

      if (p.in === 'header') {
        // Una cabecera siempre la genera el CRM: obligatoria para nosotros
        // aunque Health la acepte opcional en algunas escrituras.
        expect(p.auto, label).toBe('uuid');
        continue;
      }
      if (REQUIRED_DEVIATIONS.has(label)) {
        expect([label, p.required]).toEqual([label, true]);
      } else {
        expect([label, p.required]).toEqual([label, required]);
      }

      const type = scalarType(schema!);
      if (type === 'array') {
        // D4: un array de query se manda como escalar (un valor).
        expect([label, p.type]).toEqual([label, 'string']);
      } else {
        expect([label, p.type]).toEqual([label, type]);
      }

      if (p.enum) {
        const allowed = schema!.enum ?? schema!.items?.enum;
        expect(allowed, label).toBeDefined();
        for (const v of p.enum) expect(allowed, label).toContain(v);
      }
    }

    // Toda operación cuyo OpenAPI declara Idempotency-Key la lleva, auto.
    const declaresKey = parameters.some(
      (x) => x.in === 'header' && x.name === 'Idempotency-Key'
    );
    const ik = operation.params.find((x) => x.name === 'Idempotency-Key');
    expect([key, Boolean(ik)]).toEqual([key, declaresKey]);
    if (ik) expect(ik).toMatchObject({ in: 'header', auto: 'uuid' });

    // Los path/query obligatorios del OpenAPI están todos.
    for (const x of parameters) {
      if ((x.in === 'path' || x.in === 'query') && x.required) {
        expect(
          operation.params.some((p) => p.in === x.in && p.name === x.name),
          `${key}: ${x.in} ${x.name}`
        ).toBe(true);
      }
    }
  });

  it('every OpenAPI path is either in the catalog or left out on purpose', () => {
    const left = new Set([
      'PATCH /patients/{id}',
      'DELETE /patients/{id}',
      'DELETE /appointments/{id}',
    ]);
    const inCatalog = new Set(operations.map((o) => `${o.method} ${o.path}`));
    for (const [path, item] of Object.entries(OPENAPI.paths)) {
      for (const method of Object.keys(item)) {
        if (method === 'parameters') continue;
        const id = `${method.toUpperCase()} ${path}`;
        expect([id, inCatalog.has(id) || left.has(id)]).toEqual([id, true]);
      }
    }
  });
});

describe('CABBITY_HEALTH_CATALOG texts for the AI (R4)', () => {
  it.each(operations.map((o) => [o.key, o]))(
    '%s has a description and a response description ≤ 1000',
    (_key, o) => {
      expect(o.description.trim().length).toBeGreaterThan(20);
      expect(o.description.length).toBeLessThanOrEqual(1000);
      expect(o.response_description.trim().length).toBeGreaterThan(10);
      expect(o.response_description.length).toBeLessThanOrEqual(1000);
      for (const p of o.params) {
        expect(p.description.length).toBeLessThanOrEqual(500);
      }
    }
  );

  // n13.8 (A2): el consentimiento se da por hecho al dar los datos por
  // WhatsApp; la IA no lo pregunta, pero sigue enviando el objeto consent.
  it('create_patient wants lookup_patient first and no question about consent', () => {
    const d = op('create_patient').description;
    expect(d).toMatch(/lookup_patient/);
    expect(d).toMatch(/No pidas autorización ni consentimiento/);
    expect(d).toMatch(/consent\.accepted = true/);
    const accepted = op('create_patient').params.find(
      (p) => p.name === 'consent.accepted'
    )!;
    expect(accepted.required).toBe(true);
    expect(accepted.description).toMatch(/^true siempre/);
  });

  it('no text asks for express consent', () => {
    for (const o of operations) {
      const texts = [
        o.description,
        o.response_description,
        ...o.params.map((p) => p.description),
      ];
      for (const t of texts) {
        expect(t).not.toMatch(/consentimiento expreso/i);
        expect(t).not.toMatch(/sin ese sí/i);
        expect(t).not.toMatch(/expresamente que se registren/i);
      }
    }
  });

  it('every document_number is normalized and says the system cleans it', () => {
    const withDoc = operations.filter((o) =>
      o.params.some((p) => p.name === 'document_number')
    );
    expect(withDoc.map((o) => o.key).sort()).toEqual([
      'create_patient',
      'list_patients',
      'lookup_patient',
    ]);
    for (const o of withDoc) {
      const p = o.params.find((x) => x.name === 'document_number')!;
      expect([o.key, p.normalize]).toEqual([o.key, 'compact']);
      expect(p.description).toMatch(/con o sin guiones o espacios/);
      expect(p.description).toMatch(/no le pidas que lo repita sin guiones/);
    }
    expect(op('lookup_patient').description).not.toMatch(
      /pídele.*sin guiones|pide.*sin guiones/
    );
  });

  it('create_appointment wants a find_availability starts_at with offset', () => {
    const d = op('create_appointment').description;
    expect(d).toMatch(/find_availability/);
    expect(d).toMatch(/offset/);
    expect(d).toMatch(/3 citas futuras/);
  });

  it('find_availability caps the range at 13 days', () => {
    expect(op('find_availability').description).toMatch(/13 días/);
  });

  it.each(['list_patients', 'list_appointments'])(
    '%s explains next_cursor → cursor',
    (key) => {
      expect(op(key).response_description).toMatch(/next_cursor/);
      expect(op(key).params.some((p) => p.name === 'cursor')).toBe(true);
    }
  );

  it('lookup_patient sends no Idempotency-Key (read-only POST)', () => {
    expect(callerParams(op('lookup_patient').params)).toEqual(
      op('lookup_patient').params
    );
  });
});

describe('list_appointments has no status filter (R16, §M1)', () => {
  // Health exige `status[]=` (lista estilo PHP): `status=confirmed` da 422.
  // El modelo no tiene arrays, así que el filtro se quita (deuda).
  it('does not declare status; the URL carries only what was sent', () => {
    expect(
      op('list_appointments').params.some((p) => p.name === 'status')
    ).toBe(false);
    const r = buildIntegrationRequest(integration, op('list_appointments'), {
      patient_id: 42,
      from: '2026-11-09',
    });
    expect('url' in r && r.url).toBe(
      'https://api.health.cabbity.com/api/integrations/v1/appointments?patient_id=42&from=2026-11-09'
    );
  });

  it('tells the AI to filter by status on the result', () => {
    expect(op('list_appointments').description).toMatch(/filtra tú/);
  });
});

describe('a malformed document is a 422 the AI should ask again for (§M1)', () => {
  it.each(['lookup_patient', 'create_patient'])('%s', (key) => {
    const text = `${op(key).description} ${op(key).response_description}`;
    expect(text).toMatch(/validation_failed/);
    expect(text).toMatch(/document_number/);
  });
});

describe('CABBITY_HEALTH_CATALOG ai_policy (n13.7, R24)', () => {
  const byKey = new Map(
    CABBITY_HEALTH_CATALOG.operations.map((op) => [op.key, op])
  );

  it('the six schedule operations ground schedule claims', () => {
    const grounded = CABBITY_HEALTH_CATALOG.operations
      .filter((op) => op.ai_policy?.grounds?.includes('schedule'))
      .map((op) => op.key)
      .sort();
    expect(grounded).toEqual(
      [
        'confirm_appointment',
        'create_appointment',
        'find_availability',
        'get_appointment',
        'list_appointments',
        'reschedule_appointment',
      ].sort()
    );
  });

  it('cancel_appointment requires the appointment and then find_availability', () => {
    expect(byKey.get('cancel_appointment')!.ai_policy).toEqual({
      requires_prior: [
        ['list_appointments', 'get_appointment'],
        ['find_availability'],
      ],
    });
    expect(byKey.get('cancel_appointment')!.description).toMatch(
      /el sistema bloquea la cancelación si no\.$/
    );
  });

  it('every policy passes validateOperationInput', () => {
    for (const op of CABBITY_HEALTH_CATALOG.operations) {
      if (!op.ai_policy) continue;
      const r = validateOperationInput(
        {
          key: op.key,
          name: op.name,
          description: op.description,
          method: op.method,
          path: op.path,
          params: op.params,
          ai_policy: op.ai_policy,
        },
        'create'
      );
      expect(r.ok, op.key).toBe(true);
    }
  });
});
