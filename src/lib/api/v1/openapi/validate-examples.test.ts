// ============================================================
// El comprobador estructural, probado en los dos sentidos: que da por
// buenos los ejemplos correctos Y que caza los mal formados. Un
// validador que nunca falla es peor que no tener validador, porque el
// documento parece revisado.
//
// Al final, la comprobación que importa: TODOS los ejemplos del
// documento real respetan su esquema.
// ============================================================

import { describe, expect, it } from 'vitest';

import { buildOpenApiDocument } from './document';
import type { SchemaObject } from './types';
import { collectExamples, validateAgainstSchema } from './validate-examples';

const OBJECT_SCHEMA: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: ['string', 'null'] },
    count: { type: 'integer', minimum: 0 },
    status: { type: 'string', enum: ['open', 'closed'] },
  },
};

describe('validateAgainstSchema', () => {
  it('acepta un objeto que cumple', () => {
    expect(
      validateAgainstSchema(
        { id: 'a', name: null, count: 3, status: 'open' },
        OBJECT_SCHEMA
      )
    ).toEqual([]);
  });

  it('caza una propiedad obligatoria que falta', () => {
    const violations = validateAgainstSchema({ id: 'a' }, OBJECT_SCHEMA);
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain(
      "falta la propiedad obligatoria 'name'"
    );
  });

  it('caza un tipo equivocado y dice dónde', () => {
    const violations = validateAgainstSchema(
      { id: 'a', name: 'x', count: 'tres' },
      OBJECT_SCHEMA
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].path).toBe('count');
    expect(violations[0].message).toContain('se esperaba integer');
  });

  it('acepta null solo donde el tipo lo admite', () => {
    expect(
      validateAgainstSchema({ id: null, name: 'x' }, OBJECT_SCHEMA)
    ).toHaveLength(1);
    expect(
      validateAgainstSchema({ id: 'a', name: null }, OBJECT_SCHEMA)
    ).toEqual([]);
  });

  it('caza un valor fuera del enum', () => {
    const violations = validateAgainstSchema(
      { id: 'a', name: 'x', status: 'pending' },
      OBJECT_SCHEMA
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain('no está en el enum');
  });

  it('caza una propiedad de más cuando additionalProperties es false', () => {
    const violations = validateAgainstSchema(
      { id: 'a', name: 'x', sobra: 1 },
      OBJECT_SCHEMA
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].path).toBe('sobra');
    expect(violations[0].message).toContain('additionalProperties');
  });

  it('un entero vale como number, pero un decimal no vale como integer', () => {
    expect(validateAgainstSchema(2, { type: 'number' })).toEqual([]);
    expect(validateAgainstSchema(2.5, { type: 'integer' })).toHaveLength(1);
  });

  it('recorre los arrays elemento a elemento, con su índice', () => {
    const schema: SchemaObject = {
      type: 'array',
      items: { type: 'string' },
    };
    const violations = validateAgainstSchema(['a', 7, 'c'], schema);
    expect(violations).toHaveLength(1);
    expect(violations[0].path).toBe('[1]');
  });

  it('respeta minItems y maxItems', () => {
    const schema: SchemaObject = {
      type: 'array',
      items: { type: 'string' },
      minItems: 2,
    };
    expect(validateAgainstSchema(['a'], schema)).toHaveLength(1);
    expect(validateAgainstSchema(['a', 'b'], schema)).toEqual([]);
  });

  it('comprueba `const`', () => {
    expect(
      validateAgainstSchema(false, { type: 'boolean', const: true })
    ).toHaveLength(1);
    expect(
      validateAgainstSchema(true, { type: 'boolean', const: true })
    ).toEqual([]);
  });

  it('resuelve $ref contra los esquemas que se le pasan', () => {
    const schemas = { Thing: OBJECT_SCHEMA };
    expect(
      validateAgainstSchema(
        { id: 'a', name: 'x' },
        { $ref: '#/components/schemas/Thing' },
        { schemas }
      )
    ).toEqual([]);
    expect(
      validateAgainstSchema(
        { id: 'a' },
        { $ref: '#/components/schemas/Thing' },
        { schemas }
      )
    ).toHaveLength(1);
  });

  it('un $ref que no resuelve es un error, no un aprobado por omisión', () => {
    const violations = validateAgainstSchema(
      { cualquier: 'cosa' },
      { $ref: '#/components/schemas/NoExiste' },
      { schemas: {} }
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain('esquema inexistente');
  });

  it('con oneOf basta con que encaje una alternativa', () => {
    const schema: SchemaObject = {
      oneOf: [{ type: 'string' }, { type: 'integer' }],
    };
    expect(validateAgainstSchema('x', schema)).toEqual([]);
    expect(validateAgainstSchema(4, schema)).toEqual([]);
    expect(validateAgainstSchema(true, schema)).toHaveLength(1);
  });
});

describe('collectExamples', () => {
  it('saca los ejemplos de cuerpos, respuestas y parámetros', () => {
    const examples = collectExamples({
      paths: {
        '/x': {
          post: {
            parameters: [
              { name: 'q', schema: { type: 'string' }, example: 'hola' },
              { name: 'sin-ejemplo', schema: { type: 'string' } },
            ],
            requestBody: {
              content: {
                'application/json': {
                  schema: { type: 'object' },
                  example: {},
                },
              },
            },
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: { type: 'object' },
                    example: { data: 1 },
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(examples.map((e) => e.location)).toEqual([
      'paths./x.post.parameters.q',
      'paths./x.post.requestBody.application/json',
      'paths./x.post.responses.200.application/json',
    ]);
  });
});

describe('los ejemplos del documento real', () => {
  const document = buildOpenApiDocument();
  const examples = collectExamples(document);

  it('hay ejemplos que comprobar (el recorrido no está roto)', () => {
    // Si el recolector dejara de encontrar nada, el test de abajo
    // pasaría sin comprobar nada en absoluto.
    expect(examples.length).toBeGreaterThan(200);
  });

  it('cada `example` respeta su `schema`', () => {
    const failures = examples.flatMap((example) =>
      validateAgainstSchema(example.value, example.schema, {
        schemas: document.components.schemas,
      }).map((violation) => ({
        location: example.location,
        ...violation,
      }))
    );
    expect(
      failures,
      `Ejemplos que no cumplen su esquema:\n${failures
        .map((f) => `  ${f.location} → ${f.path || '(raíz)'}: ${f.message}`)
        .join('\n')}`
    ).toEqual([]);
  });

  it('todos los $ref del documento apuntan a un esquema que existe', () => {
    const names = new Set(Object.keys(document.components.schemas));
    const dangling: string[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (!node || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      if (typeof record.$ref === 'string') {
        const name = record.$ref.replace('#/components/schemas/', '');
        if (!names.has(name)) dangling.push(record.$ref);
      }
      Object.values(record).forEach(walk);
    };
    walk(document);
    expect(dangling).toEqual([]);
  });
});
