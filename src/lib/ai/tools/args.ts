// ============================================================
// Argumentos del modelo → mapa plano del ejecutor (n13.3, R16).
//
// El esquema anida los parámetros con punto (`consent.accepted` →
// `{consent:{accepted}}`); el ejecutor de integraciones espera el nombre
// declarado tal cual. Solo propiedades propias, como mucho 4 niveles;
// lo que no sea un objeto plano es una hoja (el ejecutor rechaza después
// lo que no esté declarado o no tenga el tipo).
// ============================================================

const MAX_DEPTH = 4;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function walk(
  source: Record<string, unknown>,
  prefix: string,
  depth: number,
  out: Record<string, unknown>
): void {
  for (const key of Object.keys(source)) {
    const value = source[key];
    const name = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value) && depth < MAX_DEPTH) {
      walk(value, name, depth + 1, out);
    } else {
      // defineProperty: un `__proto__` del modelo es un nombre, no un setter.
      Object.defineProperty(out, name, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
}

/** `{a:{b:1}}` → `{'a.b': 1}`; un argumento que no es objeto → `{}`. */
export function flattenToolArgs(args: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isPlainObject(args)) return out;
  walk(args, '', 1, out);
  return out;
}
