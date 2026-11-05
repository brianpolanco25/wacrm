// ============================================================
// Cuerpo de error de una API remota (n13.5, D5, R19).
//
// Puro. Reconoce la forma `{ error: { code, message, field, request_id } }`
// (la de Cabbity Health) y devuelve solo lo acotado y saneado: `code`
// con un alfabeto cerrado, `message` sin caracteres de control y cortado,
// `field` y `requestId` cortos. `details` se descarta siempre (objeto
// arbitrario). Es texto de un tercero: quien lo enseñe a una IA lo trata
// como dato, nunca como instrucción.
// ============================================================

import type { RemoteError } from './types';

const CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MESSAGE_MAX = 300;
const SHORT_MAX = 100;
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function short(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.replace(CONTROL_RE, '').trim();
  return t && t.length <= SHORT_MAX ? t : null;
}

/** `null` si el texto no es JSON o no tiene la forma esperada. */
export function parseRemoteError(text: string): RemoteError | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.error)) return null;
  const err = parsed.error;
  if (typeof err.code !== 'string' || !CODE_RE.test(err.code)) return null;

  let message: string | null = null;
  if (typeof err.message === 'string') {
    const m = err.message.replace(CONTROL_RE, '').trim().slice(0, MESSAGE_MAX);
    message = m.trim() || null;
  }
  return {
    code: err.code,
    message,
    field: short(err.field),
    requestId: short(err.request_id),
  };
}
