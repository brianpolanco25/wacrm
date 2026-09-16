// ============================================================
// Comprobador estructural propio: ¿cada `example` respeta su
// `schema`?
//
// Sin validador externo (S-A3). No pretende implementar JSON Schema
// 2020-12 entero: cubre el subconjunto que este contrato usa —`type`
// (incluida la forma `['x','null']`), `required`, `enum`, `const`,
// `properties`, `additionalProperties`, `items`, `oneOf`/`anyOf`/
// `allOf` y `$ref` a `#/components/schemas/…`. Una palabra clave que
// no conoce simplemente NO se comprueba: queda dicho aquí para que
// nadie confunda «pasa el comprobador» con «es OpenAPI válido».
//
// Lo que sí garantiza, que es lo que importa: ningún ejemplo del
// documento miente sobre la forma de su esquema. Un campo `required`
// que falta, un tipo cambiado, un valor fuera del `enum` o una
// propiedad de más donde `additionalProperties: false` — eso lo caza.
// ============================================================

import type { SchemaObject } from './types';

/** Un desajuste, con la ruta JSON donde está. */
export interface SchemaViolation {
  /** Ruta tipo `data.tags[0].color`, vacía en la raíz. */
  path: string;
  message: string;
}

const SCHEMA_REF_PREFIX = '#/components/schemas/';

function typeOfValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return t;
}

/** ¿El valor casa con un nombre de tipo de JSON Schema? */
function matchesType(value: unknown, expected: string): boolean {
  const actual = typeOfValue(value);
  // Un entero es también un `number`; lo contrario no.
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return actual === expected;
}

function join(path: string, segment: string): string {
  if (!path) return segment;
  return segment.startsWith('[') ? `${path}${segment}` : `${path}.${segment}`;
}

export interface ValidateOptions {
  /**
   * Los esquemas de `components.schemas`, para resolver `$ref`. Sin
   * esto, un `$ref` es un error: preferimos gritar antes que dar por
   * bueno un ejemplo que nadie miró.
   */
  schemas?: Record<string, SchemaObject>;
}

/**
 * Comprueba `value` contra `schema`. Devuelve la lista de desajustes
 * (vacía = todo bien). No lanza: el llamador decide qué hacer.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: SchemaObject,
  options: ValidateOptions = {}
): SchemaViolation[] {
  return walk(value, schema, '', options, new Set());
}

function walk(
  value: unknown,
  schema: SchemaObject,
  path: string,
  options: ValidateOptions,
  seenRefs: Set<string>
): SchemaViolation[] {
  // --- $ref ---------------------------------------------------------
  if (schema.$ref) {
    if (!schema.$ref.startsWith(SCHEMA_REF_PREFIX)) {
      return [
        {
          path,
          message: `referencia no resoluble: ${schema.$ref} (solo se admite ${SCHEMA_REF_PREFIX}…)`,
        },
      ];
    }
    const name = schema.$ref.slice(SCHEMA_REF_PREFIX.length);
    const target = options.schemas?.[name];
    if (!target) {
      return [
        { path, message: `$ref a un esquema inexistente: ${schema.$ref}` },
      ];
    }
    // Un esquema recursivo (hoy no hay ninguno) no debe colgar el test.
    const key = `${path}::${name}`;
    if (seenRefs.has(key)) return [];
    const next = new Set(seenRefs);
    next.add(key);
    return walk(value, target, path, options, next);
  }

  const violations: SchemaViolation[] = [];

  // --- allOf: todos deben pasar ---------------------------------------
  if (schema.allOf) {
    for (const sub of schema.allOf) {
      violations.push(...walk(value, sub, path, options, seenRefs));
    }
  }

  // --- oneOf / anyOf: basta con uno ------------------------------------
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (alternatives && alternatives.length > 0) {
    const passes = alternatives.some(
      (sub) => walk(value, sub, path, options, seenRefs).length === 0
    );
    if (!passes) {
      violations.push({
        path,
        message: `el valor no encaja en ninguna de las ${alternatives.length} alternativas de ${schema.oneOf ? 'oneOf' : 'anyOf'}`,
      });
    }
    // Si hay alternativas, las palabras clave de este nivel se aplican
    // igualmente cuando existen (type, enum…): seguimos abajo.
  }

  // --- const ------------------------------------------------------------
  if (schema.const !== undefined && value !== schema.const) {
    violations.push({
      path,
      message: `se esperaba el valor constante ${JSON.stringify(schema.const)} y hay ${JSON.stringify(value)}`,
    });
  }

  // --- type --------------------------------------------------------------
  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expected.some((t) => matchesType(value, t))) {
      violations.push({
        path,
        message: `se esperaba ${expected.join(' | ')} y hay ${typeOfValue(value)} (${JSON.stringify(value)})`,
      });
      // Sin el tipo correcto, seguir mirando propiedades solo produce
      // ruido derivado del mismo error.
      return violations;
    }
  }

  // --- enum ---------------------------------------------------------------
  if (schema.enum && !schema.enum.some((option) => option === value)) {
    violations.push({
      path,
      message: `${JSON.stringify(value)} no está en el enum [${schema.enum
        .map((o) => JSON.stringify(o))
        .join(', ')}]`,
    });
  }

  // --- objeto --------------------------------------------------------------
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;

    for (const key of schema.required ?? []) {
      if (!(key in record)) {
        violations.push({
          path,
          message: `falta la propiedad obligatoria '${key}'`,
        });
      }
    }

    const properties = schema.properties ?? {};
    for (const [key, propValue] of Object.entries(record)) {
      const propSchema = properties[key];
      if (propSchema) {
        violations.push(
          ...walk(propValue, propSchema, join(path, key), options, seenRefs)
        );
        continue;
      }
      if (schema.additionalProperties === false) {
        violations.push({
          path: join(path, key),
          message: `propiedad no declarada y additionalProperties es false`,
        });
      } else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === 'object'
      ) {
        violations.push(
          ...walk(
            propValue,
            schema.additionalProperties,
            join(path, key),
            options,
            seenRefs
          )
        );
      }
    }
  }

  // --- array ----------------------------------------------------------------
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      violations.push({
        path,
        message: `${value.length} elementos, menos que el mínimo ${schema.minItems}`,
      });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      violations.push({
        path,
        message: `${value.length} elementos, más que el máximo ${schema.maxItems}`,
      });
    }
    if (schema.items) {
      value.forEach((item, index) => {
        violations.push(
          ...walk(
            item,
            schema.items as SchemaObject,
            join(path, `[${index}]`),
            options,
            seenRefs
          )
        );
      });
    }
  }

  // --- números y cadenas ------------------------------------------------------
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      violations.push({
        path,
        message: `${value} es menor que el mínimo ${schema.minimum}`,
      });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      violations.push({
        path,
        message: `${value} es mayor que el máximo ${schema.maximum}`,
      });
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      violations.push({
        path,
        message: `cadena de ${value.length} caracteres, menos que el mínimo ${schema.minLength}`,
      });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      violations.push({
        path,
        message: `cadena de ${value.length} caracteres, más que el máximo ${schema.maxLength}`,
      });
    }
  }

  return violations;
}

/** Un ejemplo del documento, ya localizado, listo para comprobar. */
export interface DocumentExample {
  /** Dónde vive: `paths./tags.get.responses.200`, etc. */
  location: string;
  schema: SchemaObject;
  value: unknown;
}

/**
 * Recorre un documento OpenAPI y saca todos los pares
 * (esquema, ejemplo) que haya: cuerpos de petición, respuestas,
 * parámetros y las entradas de `webhooks`.
 */
export function collectExamples(document: unknown): DocumentExample[] {
  const found: DocumentExample[] = [];
  const doc = document as {
    paths?: Record<string, Record<string, unknown>>;
    webhooks?: Record<string, Record<string, unknown>>;
  };

  const visitOperation = (location: string, operation: unknown) => {
    const op = operation as {
      parameters?: { name: string; schema: SchemaObject; example?: unknown }[];
      requestBody?: {
        content?: Record<string, { schema: SchemaObject; example?: unknown }>;
      };
      responses?: Record<
        string,
        {
          content?: Record<string, { schema: SchemaObject; example?: unknown }>;
        }
      >;
    };

    for (const parameter of op.parameters ?? []) {
      if (parameter.example === undefined) continue;
      found.push({
        location: `${location}.parameters.${parameter.name}`,
        schema: parameter.schema,
        value: parameter.example,
      });
    }

    for (const [mediaType, media] of Object.entries(
      op.requestBody?.content ?? {}
    )) {
      if (media.example === undefined) continue;
      found.push({
        location: `${location}.requestBody.${mediaType}`,
        schema: media.schema,
        value: media.example,
      });
    }

    for (const [status, response] of Object.entries(op.responses ?? {})) {
      for (const [mediaType, media] of Object.entries(response.content ?? {})) {
        if (media.example === undefined) continue;
        found.push({
          location: `${location}.responses.${status}.${mediaType}`,
          schema: media.schema,
          value: media.example,
        });
      }
    }
  };

  const visitPathItems = (
    prefix: string,
    items: Record<string, Record<string, unknown>> | undefined
  ) => {
    for (const [key, item] of Object.entries(items ?? {})) {
      for (const [method, operation] of Object.entries(item)) {
        visitOperation(`${prefix}.${key}.${method}`, operation);
      }
    }
  };

  visitPathItems('paths', doc.paths);
  visitPathItems('webhooks', doc.webhooks);
  return found;
}
