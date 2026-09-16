// ============================================================
// El documento cumple lo que §6 pide de él.
//
// No se comprueba "que se genera" (eso lo dice el test de cobertura)
// sino que cada pieza del contrato está y dice la verdad: seguridad,
// scopes por operación, sobres, todos los códigos de error,
// paginación, idempotencia, cubos de rate limit, la excepción del
// export y la sección de webhooks.
// ============================================================

import { describe, expect, it } from 'vitest';

import { API_SCOPES } from '@/lib/api-keys/scopes';
import { RATE_LIMITS } from '@/lib/rate-limit';
import { WEBHOOK_EVENTS } from '@/lib/webhooks/events';

import {
  ALL_OPERATIONS,
  API_BASE_PATH,
  SECURITY_SCHEME_NAME,
  buildOpenApiDocument,
} from './document';
import { API_ERROR_CODES } from './schemas';
import type { OperationObject, SchemaObject } from './types';

const document = buildOpenApiDocument();

function operation(method: string, path: string): OperationObject {
  const item = document.paths[path];
  expect(item, `no hay ninguna operación en ${path}`).toBeDefined();
  const op = (item as Record<string, OperationObject>)[method];
  expect(
    op,
    `${method.toUpperCase()} ${path} no está documentada`
  ).toBeDefined();
  return op;
}

describe('documento OpenAPI: forma general', () => {
  it('declara 3.1.0 y un servidor', () => {
    expect(document.openapi).toBe('3.1.0');
    expect(document.servers[0].url).toBe(API_BASE_PATH);
  });

  it('acepta un servidor absoluto cuando se le pasa', () => {
    const doc = buildOpenApiDocument({
      serverUrl: 'https://crm.example.com/api/v1',
    });
    expect(doc.servers[0].url).toBe('https://crm.example.com/api/v1');
  });

  it('define UN esquema de seguridad, http/bearer, y lo exige por defecto', () => {
    const scheme = document.components.securitySchemes[SECURITY_SCHEME_NAME];
    expect(scheme.type).toBe('http');
    expect(scheme.scheme).toBe('bearer');
    expect(document.security).toEqual([{ [SECURITY_SCHEME_NAME]: [] }]);
  });

  it('publica el vocabulario de scopes con su descripción', () => {
    expect(Object.keys(document['x-scope-descriptions']).sort()).toEqual(
      [...API_SCOPES].sort()
    );
  });
});

describe('documento OpenAPI: scopes por operación', () => {
  it('cada operación lleva en x-scopes lo que exige su ruta', () => {
    for (const op of ALL_OPERATIONS) {
      const built = operation(op.method, `${API_BASE_PATH}${op.path}`);
      expect(built['x-scopes'], op.operationId).toEqual(op.scopes);
    }
  });

  it('GET /me es la única operación sin scope', () => {
    const sinScope = ALL_OPERATIONS.filter((op) => op.scopes.length === 0);
    expect(sinScope.map((op) => `${op.method} ${op.path}`)).toEqual([
      'get /me',
    ]);
    expect(operation('get', `${API_BASE_PATH}/me`)['x-scopes']).toEqual([]);
  });

  it('todo scope declarado es uno de los 12 que existen', () => {
    for (const op of ALL_OPERATIONS) {
      for (const scope of op.scopes) {
        expect(API_SCOPES, `${op.operationId}`).toContain(scope);
      }
    }
  });

  it('el scope de /broadcasts es broadcasts:send también en el GET', () => {
    expect(
      operation('get', `${API_BASE_PATH}/broadcasts/{id}`)['x-scopes']
    ).toEqual(['broadcasts:send']);
  });

  it('las operaciones con scope documentan el 403 forbidden', () => {
    const withScope = operation('get', `${API_BASE_PATH}/contacts`);
    expect(withScope.responses['403'].description).toContain('forbidden');
    // `GET /me` no puede dar 403 por scope: no exige ninguno.
    const me = operation('get', `${API_BASE_PATH}/me`);
    expect(me.responses['403']).toBeUndefined();
  });
});

describe('documento OpenAPI: sobres', () => {
  const dataEnvelope = (schema: SchemaObject) => {
    expect(schema.required).toEqual(['data']);
    expect(schema.properties?.data).toBeDefined();
  };

  it('una lectura simple envuelve en { data }', () => {
    const op = operation('get', `${API_BASE_PATH}/contacts/{id}`);
    dataEnvelope(op.responses['200'].content!['application/json'].schema);
  });

  it('una lista envuelve en { data, meta.next_cursor }', () => {
    const op = operation('get', `${API_BASE_PATH}/contacts`);
    const schema = op.responses['200'].content!['application/json'].schema;
    expect(schema.required).toEqual(['data', 'meta']);
    expect(schema.properties?.data.type).toBe('array');
    expect(schema.properties?.meta.$ref).toBe(
      '#/components/schemas/PaginationMeta'
    );
  });

  it('el export directo NO envuelve: el cuerpo es el archivo', () => {
    const op = operation('get', `${API_BASE_PATH}/conversations/{id}/export`);
    const json = op.responses['200'].content!['application/json'].schema;
    // Sin `data`: la raíz es el documento exportado.
    expect(json.properties?.data).toBeUndefined();
    expect(json.required).toContain('conversations');
    // Y ofrece el CSV como segundo tipo de medio.
    expect(op.responses['200'].content!['text/csv'].schema.type).toBe('string');
  });

  it('pero sus ERRORES sí van en el sobre, como el resto', () => {
    const op = operation('get', `${API_BASE_PATH}/conversations/{id}/export`);
    expect(op.responses['404'].content!['application/json'].schema.$ref).toBe(
      '#/components/schemas/Error'
    );
  });
});

describe('documento OpenAPI: errores', () => {
  it('el esquema ApiErrorCode enumera TODOS los códigos de respond.ts', () => {
    const enumerated = document.components.schemas.ApiErrorCode.enum ?? [];
    for (const code of API_ERROR_CODES) {
      expect(enumerated, `falta ${code}`).toContain(code);
    }
  });

  it('el sobre de error exige code, message y request_id', () => {
    const error = document.components.schemas.Error;
    expect(error.properties?.error.required).toEqual([
      'code',
      'message',
      'request_id',
    ]);
  });

  it('toda operación documenta 401, 402, 429 y 500', () => {
    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, op] of Object.entries(item)) {
        for (const status of ['401', '402', '429', '500']) {
          expect(
            op.responses[status],
            `${method.toUpperCase()} ${path} sin ${status}`
          ).toBeDefined();
        }
      }
    }
  });

  it('toda escritura documenta 400, 403 read-only, 413 y 415', () => {
    const escrituras = ALL_OPERATIONS.filter(
      (op) => op.method !== 'get' && op.requestBody
    );
    expect(escrituras.length).toBeGreaterThan(0);
    for (const op of escrituras) {
      const built = operation(op.method, `${API_BASE_PATH}${op.path}`);
      for (const status of ['400', '403', '413', '415']) {
        expect(
          built.responses[status],
          `${op.operationId} sin ${status}`
        ).toBeDefined();
      }
      expect(built.responses['403'].description).toContain('account_read_only');
    }
  });

  it('una escritura SIN cuerpo no promete 415 (no lee cuerpo alguno)', () => {
    const test = operation('post', `${API_BASE_PATH}/webhooks/{id}/test`);
    expect(test.responses['415']).toBeUndefined();
    // Pero sigue siendo escritura: la cuenta en solo lectura la corta.
    expect(test.responses['403'].description).toContain('account_read_only');
  });

  it('el 429 trae Retry-After y las tres X-RateLimit-*', () => {
    const op = operation('get', `${API_BASE_PATH}/contacts`);
    expect(Object.keys(op.responses['429'].headers ?? {})).toEqual(
      expect.arrayContaining([
        'Retry-After',
        'X-RateLimit-Limit',
        'X-RateLimit-Remaining',
        'X-RateLimit-Reset',
      ])
    );
  });

  it('el 402 usa el sobre de facturación, con upgradeUrl', () => {
    const op = operation('get', `${API_BASE_PATH}/contacts`);
    expect(op.responses['402'].content!['application/json'].schema.$ref).toBe(
      '#/components/schemas/BillingError'
    );
    expect(
      document.components.schemas.BillingError.properties?.error.required
    ).toContain('upgradeUrl');
  });

  it('los códigos de dominio del envío están documentados', () => {
    const send = operation('post', `${API_BASE_PATH}/messages`);
    expect(send.responses['502'].description).toContain('meta_error');
    expect(send.responses['400'].description).toContain(
      'whatsapp_not_configured'
    );
    expect(send.responses['500'].description).toContain('template_malformed');
  });
});

describe('documento OpenAPI: cabeceras universales', () => {
  it('toda respuesta declara X-Request-Id y Cache-Control', () => {
    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, op] of Object.entries(item)) {
        for (const [status, response] of Object.entries(op.responses)) {
          const where = `${method.toUpperCase()} ${path} ${status}`;
          expect(response.headers?.['X-Request-Id'], where).toBeDefined();
          expect(response.headers?.['Cache-Control'], where).toBeDefined();
        }
      }
    }
  });
});

describe('documento OpenAPI: paginación', () => {
  it('cada lista declara limit y cursor', () => {
    const listas = ALL_OPERATIONS.filter((op) => op.paginated);
    expect(listas.length).toBeGreaterThan(5);
    for (const op of listas) {
      const built = operation(op.method, `${API_BASE_PATH}${op.path}`);
      const names = (built.parameters ?? []).map((p) => p.name);
      expect(names, op.operationId).toContain('limit');
      expect(names, op.operationId).toContain('cursor');
    }
  });

  it('el limit se documenta con el tope real de pagination.ts', () => {
    const op = operation('get', `${API_BASE_PATH}/contacts`);
    const limit = (op.parameters ?? []).find((p) => p.name === 'limit');
    expect(limit?.schema.maximum).toBe(100);
    expect(limit?.schema.default).toBe(50);
  });
});

describe('documento OpenAPI: idempotencia', () => {
  const idempotentes = ALL_OPERATIONS.filter((op) => op.idempotent);

  it('las seis creaciones idempotentes son las que envuelve withIdempotency', () => {
    expect(
      idempotentes.map((op) => `${op.method.toUpperCase()} ${op.path}`).sort()
    ).toEqual([
      'POST /broadcasts',
      'POST /contacts/{id}/tags',
      'POST /exports',
      'POST /messages',
      'POST /tags',
      'POST /templates',
    ]);
  });

  it('cada una acepta Idempotency-Key y puede responder Idempotent-Replayed', () => {
    for (const op of idempotentes) {
      const built = operation(op.method, `${API_BASE_PATH}${op.path}`);
      expect(built['x-idempotent'], op.operationId).toBe(true);
      expect(
        (built.parameters ?? []).some(
          (p) => p.name === 'Idempotency-Key' && p.in === 'header'
        ),
        op.operationId
      ).toBe(true);
      const success = Object.entries(built.responses).find(([status]) =>
        status.startsWith('2')
      )!;
      expect(
        success[1].headers?.['Idempotent-Replayed'],
        op.operationId
      ).toBeDefined();
      expect(built.responses['409'].description).toContain(
        'idempotency_mismatch'
      );
    }
  });

  it('PATCH /templates/{id} NO se anuncia como idempotente', () => {
    // La ruta no pasa por `withIdempotency` (ver el comentario de
    // src/app/api/v1/templates/[id]/route.ts): anunciar la cabecera
    // sería prometer una reproducción que no existe.
    const op = operation('patch', `${API_BASE_PATH}/templates/{id}`);
    expect(op['x-idempotent']).toBeUndefined();
    expect(
      (op.parameters ?? []).some((p) => p.name === 'Idempotency-Key')
    ).toBe(false);
  });
});

describe('documento OpenAPI: cubos de rate limit', () => {
  it('todas llevan publicApi por clave, con el límite real', () => {
    const op = operation('get', `${API_BASE_PATH}/contacts`);
    expect(op['x-rate-limits']).toEqual([
      {
        bucket: 'publicApi',
        limit: RATE_LIMITS.publicApi.limit,
        window_seconds: 60,
        per: 'key',
      },
    ]);
  });

  it('las tres operaciones caras suman su cubo POR CUENTA', () => {
    const casos: [string, string, string, number][] = [
      [
        'get',
        '/conversations/{id}/export',
        'exports',
        RATE_LIMITS.exports.limit,
      ],
      ['post', '/exports', 'exports', RATE_LIMITS.exports.limit],
      [
        'post',
        '/templates/sync',
        'templatesSync',
        RATE_LIMITS.templatesSync.limit,
      ],
      [
        'post',
        '/webhooks/{id}/test',
        'webhookAction',
        RATE_LIMITS.webhookAction.limit,
      ],
    ];
    for (const [method, path, bucket, limit] of casos) {
      const op = operation(method, `${API_BASE_PATH}${path}`);
      const extra = op['x-rate-limits'].find((r) => r.bucket === bucket);
      expect(extra, `${method} ${path}`).toBeDefined();
      expect(extra!.per).toBe('account');
      expect(extra!.limit).toBe(limit);
    }
  });

  it('el cubo de exportaciones se documenta con su ventana de una hora', () => {
    const op = operation('post', `${API_BASE_PATH}/exports`);
    const extra = op['x-rate-limits'].find((r) => r.bucket === 'exports');
    expect(extra!.window_seconds).toBe(3600);
  });
});

describe('documento OpenAPI: sección webhooks', () => {
  it('hay una entrada por evento de WEBHOOK_EVENTS, y ninguna de más', () => {
    expect(Object.keys(document.webhooks).sort()).toEqual(
      [...WEBHOOK_EVENTS].sort()
    );
  });

  it('cada entrada es un POST con el sobre de entrega', () => {
    for (const event of WEBHOOK_EVENTS) {
      const op = document.webhooks[event].post!;
      const schema = op.requestBody!.content['application/json'].schema;
      expect(schema.required, event).toEqual([
        'id',
        'event',
        'occurred_at',
        'account_id',
        'data',
      ]);
      // `event` es constante por entrada: el receptor sabe qué esperar.
      expect(schema.properties?.event.const, event).toBe(event);
      expect(schema.properties?.data.properties, event).toBeDefined();
    }
  });

  it('cada entrada declara las cinco cabeceras X-Wacrm-*', () => {
    for (const event of WEBHOOK_EVENTS) {
      const names = (document.webhooks[event].post!.parameters ?? []).map(
        (p) => p.name
      );
      expect(names, event).toEqual([
        'X-Wacrm-Event',
        'X-Wacrm-Webhook-Id',
        'X-Wacrm-Delivery-Id',
        'X-Wacrm-Attempt',
        'X-Wacrm-Signature',
      ]);
    }
  });

  it('la entrega no se autentica con la clave de API, sino con la firma', () => {
    for (const event of WEBHOOK_EVENTS) {
      expect(document.webhooks[event].post!.security, event).toEqual([]);
    }
  });

  it('el `data` de cada evento cuadra con lo que emite el dominio', () => {
    // Muestra de contraste con src/lib/webhooks/events.ts
    // (WEBHOOK_EVENT_DATA_FIELDS), que es lo que el panel enseña.
    expect(
      document.webhooks['contact.tag_added'].post!.requestBody!.content[
        'application/json'
      ].schema.properties?.data.required
    ).toEqual(['contact_id', 'tag_id']);
    expect(
      document.webhooks['broadcast.completed'].post!.requestBody!.content[
        'application/json'
      ].schema.properties?.data.required
    ).toEqual(['broadcast_id', 'status', 'total', 'sent', 'failed']);
  });
});

describe('documento OpenAPI: secretos', () => {
  it('el secreto de firma solo aparece al crear y al rotar', () => {
    const conSecreto = Object.entries(document.paths).flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([, op]) =>
          Object.values(op.responses).some((r) =>
            Object.values(r.content ?? {}).some(
              (media) =>
                JSON.stringify(media.schema).includes('WithSecret') ||
                JSON.stringify(media.example ?? {}).includes('whsec_')
            )
          )
        )
        .map(([method]) => `${method.toUpperCase()} ${path}`)
    );
    expect(conSecreto.sort()).toEqual([
      `POST ${API_BASE_PATH}/webhooks`,
      `POST ${API_BASE_PATH}/webhooks/{id}/rotate-secret`,
    ]);
  });

  it('listar y leer receptores usa el esquema SIN secreto', () => {
    for (const path of [
      `${API_BASE_PATH}/webhooks`,
      `${API_BASE_PATH}/webhooks/{id}`,
    ]) {
      const op = operation('get', path);
      expect(JSON.stringify(op.responses['200'])).not.toContain('secret');
    }
  });
});
