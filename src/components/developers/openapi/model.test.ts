import { describe, expect, it } from 'vitest';

import { OPENAPI_FIXTURE } from './fixture';
import {
  buildReference,
  flattenSchema,
  operationAnchor,
  resolveRef,
  scopesOf,
  typeLabel,
} from './model';
import { HTTP_METHODS, type OpenApiDocument } from './types';

// El renderizador de la referencia se prueba contra un documento
// OpenAPI 3.1 cualquiera, no contra el nuestro: el fixture describe las
// 37 operaciones que `progress/impl_integracion-api-3.md` §6 inventaría,
// y los casos sintéticos de abajo cubren lo que el documento real podría
// traer y el fixture no (scopes solo en `security`, esquemas recursivos).

/** Recorre el documento por su cuenta, sin pasar por `buildReference`. */
function walkOperations(doc: OpenApiDocument): string[] {
  const found: string[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of HTTP_METHODS) {
      if (item[method]) found.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return found.sort();
}

describe('buildReference — cobertura', () => {
  const model = buildReference(OPENAPI_FIXTURE);

  it('renderiza todas las operaciones del documento, sin perder ninguna', () => {
    const rendered = model.operations
      .map((op) => `${op.method.toUpperCase()} ${op.path}`)
      .sort();
    expect(rendered).toEqual(walkOperations(OPENAPI_FIXTURE));
  });

  it('las reparte en secciones sin duplicar ni descolgar ninguna', () => {
    const inSections = model.sections
      .flatMap((section) => section.operations)
      .map((op) => op.id)
      .sort();
    expect(inSections).toEqual(model.operations.map((op) => op.id).sort());
  });

  it('cubre las 37 operaciones del inventario de la fase', () => {
    expect(model.operations).toHaveLength(37);
  });

  it('da a cada operación un ancla única', () => {
    const anchors = model.operations.map((op) => op.id);
    expect(new Set(anchors).size).toBe(anchors.length);
    expect(operationAnchor('post', '/api/v1/messages')).toBe(
      'post-api-v1-messages'
    );
  });

  it('respeta el orden de `tags` del documento', () => {
    const declared = (OPENAPI_FIXTURE.tags ?? []).map((tag) => tag.name);
    expect(model.sections.map((section) => section.name)).toEqual(declared);
  });

  it('trae los eventos de webhook como sección aparte', () => {
    expect(model.webhooks.map((hook) => hook.event)).toEqual(
      Object.keys(OPENAPI_FIXTURE.webhooks ?? {})
    );
    const received = model.webhooks.find(
      (hook) => hook.event === 'message.received'
    );
    expect(received?.fields.map((field) => field.name)).toContain('data');
    expect(received?.example).toContain('"message.received"');
  });

  it('lee el servidor y la versión del documento', () => {
    expect(model.server).toBe('https://tu-dominio.example.com');
    expect(model.version).toBe('1.2.0');
  });
});

describe('buildReference — una operación por dentro', () => {
  const model = buildReference(OPENAPI_FIXTURE);
  const send = model.operations.find((op) => op.id === 'post-api-v1-messages')!;
  const listContacts = model.operations.find(
    (op) => op.id === 'get-api-v1-contacts'
  )!;
  const readContact = model.operations.find(
    (op) => op.id === 'get-api-v1-contacts-id'
  )!;

  it('expone el scope que exige la ruta', () => {
    expect(send.scopes).toEqual(['messages:send']);
  });

  it('marca las escrituras que aceptan Idempotency-Key', () => {
    expect(send.idempotent).toBe(true);
    expect(listContacts.idempotent).toBe(false);
  });

  it('hereda los parámetros de ruta declarados en el path item', () => {
    const id = readContact.parameters.find((param) => param.name === 'id');
    expect(id).toMatchObject({ in: 'path', required: true });
  });

  it('aplana el cuerpo de la petición en campos, incluidos los anidados', () => {
    const names = send.requestBody?.fields.map((field) => field.name) ?? [];
    expect(names).toContain('to');
    expect(names).toContain('template');
    expect(names).toContain('template.name');
  });

  it('resuelve los `$ref` de las respuestas hasta los campos del recurso', () => {
    const ok = readContact.responses.find((res) => res.status === '200');
    const names = ok?.fields.map((field) => field.name) ?? [];
    expect(names).toContain('data.phone');
    // `tags` es un array de un `$ref`: se describe por su elemento.
    expect(names).toContain('data.tags[].name');
  });

  it('añade a toda operación los errores comunes', () => {
    for (const status of ['401', '403', '429']) {
      expect(send.responses.map((res) => res.status)).toContain(status);
    }
  });

  it('genera un curl con la cabecera de autorización y el ejemplo', () => {
    expect(send.curl).toContain('curl -X POST');
    expect(send.curl).toContain(
      'https://tu-dominio.example.com/api/v1/messages'
    );
    expect(send.curl).toContain('Authorization: Bearer $CABBITY_API_KEY');
    expect(send.curl).toContain('Idempotency-Key');
    expect(send.curl).toContain('"name": "aviso_pedido"');
  });

  it('no inventa -X GET ni cuerpo en una lectura', () => {
    expect(listContacts.curl).not.toContain('-X GET');
    expect(listContacts.curl).not.toContain('Content-Type');
    expect(listContacts.curl).not.toContain('Idempotency-Key');
  });
});

describe('scopesOf', () => {
  const base: OpenApiDocument = {
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    paths: {},
  };

  it('prefiere `x-scopes` cuando está', () => {
    expect(
      scopesOf(base, {
        'x-scopes': ['tags:read'],
        security: [{ bearerAuth: ['otro'] }],
        responses: {},
      })
    ).toEqual(['tags:read']);
  });

  it('los lee de `security` cuando no hay extensión', () => {
    expect(
      scopesOf(base, {
        security: [{ bearerAuth: ['contacts:read', 'contacts:write'] }],
        responses: {},
      })
    ).toEqual(['contacts:read', 'contacts:write']);
  });

  it('cae al `security` del documento si la operación no declara el suyo', () => {
    const doc = { ...base, security: [{ bearerAuth: ['global'] }] };
    expect(scopesOf(doc, { responses: {} })).toEqual(['global']);
  });

  it('una operación sin scopes no hereda nada que no esté declarado', () => {
    expect(scopesOf(base, { responses: {} })).toEqual([]);
  });
});

describe('typeLabel — formas de OpenAPI 3.1', () => {
  const doc: OpenApiDocument = {
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    paths: {},
    components: {
      schemas: {
        Tag: { type: 'object', properties: { name: { type: 'string' } } },
      },
    },
  };

  it('une el tipo-lista de 3.1 en vez de perder el null', () => {
    expect(typeLabel(doc, { type: ['string', 'null'] })).toBe('string | null');
  });

  it('nombra el elemento de un array', () => {
    expect(
      typeLabel(doc, {
        type: 'array',
        items: { $ref: '#/components/schemas/Tag' },
      })
    ).toBe('array<Tag>');
  });

  it('enseña el formato cuando lo hay', () => {
    expect(typeLabel(doc, { type: 'string', format: 'date-time' })).toBe(
      'string (date-time)'
    );
  });

  it('enumera los valores de un enum', () => {
    expect(typeLabel(doc, { type: 'string', enum: ['json', 'csv'] })).toBe(
      'enum: json | csv'
    );
  });

  it('usa el nombre del esquema referenciado', () => {
    expect(typeLabel(doc, { $ref: '#/components/schemas/Tag' })).toBe('Tag');
  });
});

describe('resolveRef y esquemas recursivos', () => {
  const doc: OpenApiDocument = {
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    paths: {},
    components: {
      schemas: {
        Node: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            child: { $ref: '#/components/schemas/Node' },
          },
        },
      },
    },
  };

  it('devuelve undefined ante un `$ref` remoto o roto, en vez de lanzar', () => {
    expect(
      resolveRef(doc, { $ref: 'https://otro.example/x.json#/A' })
    ).toBeUndefined();
    expect(
      resolveRef(doc, { $ref: '#/components/schemas/NoExiste' })
    ).toBeUndefined();
  });

  it('no se cuelga con un esquema que se contiene a sí mismo', () => {
    const rows = flattenSchema(doc, { $ref: '#/components/schemas/Node' });
    expect(rows.map((row) => row.name)).toEqual(['name', 'child']);
  });

  it('aplana `allOf` en un solo objeto', () => {
    const rows = flattenSchema(doc, {
      allOf: [
        {
          type: 'object',
          properties: { a: { type: 'string' } },
          required: ['a'],
        },
        { type: 'object', properties: { b: { type: 'integer' } } },
      ],
    });
    expect(rows).toEqual([
      { name: 'a', type: 'string', required: true, description: undefined },
      { name: 'b', type: 'integer', required: false, description: undefined },
    ]);
  });
});
