// ============================================================
// Piezas que comparten los archivos de recurso del registro.
//
// Nada de esto va al documento por sí solo: son constructores de
// parámetros y de errores para que las 37 operaciones se escriban
// igual y un error declarado en dos sitios no diverja en el texto.
// ============================================================

import type { ErrorResponseDef, ParameterObject } from './types';

/** Parámetro de ruta (siempre obligatorio, siempre string). */
export function pathParam(
  name: string,
  description: string,
  format = 'uuid'
): ParameterObject {
  return {
    name,
    in: 'path',
    description,
    required: true,
    schema: { type: 'string', format },
  };
}

/** Parámetro de consulta de texto libre. */
export function queryParam(
  name: string,
  description: string,
  extra: Partial<ParameterObject> = {}
): ParameterObject {
  return {
    name,
    in: 'query',
    description,
    required: false,
    schema: { type: 'string' },
    ...extra,
  };
}

// ------------------------------------------------------------------
// Errores frecuentes, con la redacción del contrato
// ------------------------------------------------------------------

export const ERR_NOT_FOUND: ErrorResponseDef = {
  status: 404,
  code: 'not_found',
  description:
    'No existe en ESTA cuenta. Un recurso de otra cuenta responde 404, nunca 403.',
};

export const ERR_BAD_REQUEST: ErrorResponseDef = {
  status: 400,
  code: 'bad_request',
  description: 'Entrada mal formada. El mensaje nombra el campo.',
};

export const ERR_CONFLICT: ErrorResponseDef = {
  status: 409,
  code: 'conflict',
  description: 'El recurso está ocupado o en un estado incompatible.',
};

export const ERR_META: ErrorResponseDef = {
  status: 502,
  code: 'meta_error',
  description:
    'La petición llegó a Meta y Meta la rechazó. El mensaje es el suyo, público.',
};

/** Filtro de conversación reutilizado por listas y exportaciones. */
export const CONVERSATION_STATUS_VALUES = [
  'open',
  'pending',
  'closed',
] as const;
