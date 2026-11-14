// ============================================================
// `template.params` de POST /api/v1/messages — forma pública y validación.
// Pura, sin I/O.
//
// `params` acepta dos formas:
//   - array de strings            → variables posicionales del cuerpo.
//   - objeto                      → { body?: string[], headerText?: string,
//                                     buttonParams?: { "<índice>": string } }
//     (también `header_text`, `button_params`, `header_media_url` y
//      `header_media_id`). Para un botón QUICK_REPLY, `buttonParams[i]`
//      es el `payload` que Meta devolverá al tocarlo (evento
//      `message.interactive_reply`).
//
// La forma se valida antes de crear contacto o conversación; que cada
// índice de `buttonParams` apunte a un botón compatible se valida
// cuando la fila de la plantilla ya está resuelta.
// ============================================================

import type { MessageTemplate } from '@/types';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';

export class TemplateParamsError extends Error {}

const BUTTON_TYPES_WITH_PARAM = ['QUICK_REPLY', 'URL', 'COPY_CODE'] as const;

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (obj[k] !== undefined) return obj[k];
  return undefined;
}

/**
 * Normaliza la forma objeto a `SendTimeParams` (camelCase). Lanza
 * `TemplateParamsError` ante una forma inválida. `undefined`/`null` →
 * `undefined`.
 */
export function normalizeTemplateMessageParams(
  raw: unknown
): SendTimeParams | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TemplateParamsError(
      'template.params must be an array of strings or an object'
    );
  }
  const obj = raw as Record<string, unknown>;
  const out: SendTimeParams = {};

  const body = pick(obj, 'body');
  if (body !== undefined) {
    if (!Array.isArray(body) || body.some((v) => typeof v !== 'string')) {
      throw new TemplateParamsError(
        'template.params.body must be an array of strings'
      );
    }
    out.body = body as string[];
  }

  const headerText = pick(obj, 'headerText', 'header_text');
  if (headerText !== undefined) {
    if (typeof headerText !== 'string') {
      throw new TemplateParamsError(
        'template.params.headerText must be a string'
      );
    }
    out.headerText = headerText;
  }

  for (const [camel, snake] of [
    ['headerMediaUrl', 'header_media_url'],
    ['headerMediaId', 'header_media_id'],
  ] as const) {
    const v = pick(obj, camel, snake);
    if (v !== undefined) {
      if (typeof v !== 'string') {
        throw new TemplateParamsError(
          `template.params.${camel} must be a string`
        );
      }
      out[camel] = v;
    }
  }

  const buttonParams = pick(obj, 'buttonParams', 'button_params');
  if (buttonParams !== undefined) {
    if (
      !buttonParams ||
      typeof buttonParams !== 'object' ||
      Array.isArray(buttonParams)
    ) {
      throw new TemplateParamsError(
        'template.params.buttonParams must be an object keyed by button index'
      );
    }
    const map: Record<number, string> = {};
    for (const [key, value] of Object.entries(buttonParams)) {
      if (!/^\d+$/.test(key)) {
        throw new TemplateParamsError(
          `template.params.buttonParams key "${key}" must be a button index (0, 1, …)`
        );
      }
      if (typeof value !== 'string' || !value.trim()) {
        throw new TemplateParamsError(
          `template.params.buttonParams[${key}] must be a non-empty string`
        );
      }
      map[Number(key)] = value;
    }
    out.buttonParams = map;
  }

  return out;
}

/**
 * Cada índice de `buttonParams` debe existir en la plantilla y ser un
 * botón QUICK_REPLY, URL o COPY_CODE (PHONE_NUMBER no admite parámetro).
 */
export function assertButtonParamsMatchTemplate(
  params: SendTimeParams | undefined,
  template: Pick<MessageTemplate, 'buttons'> | null
): void {
  if (!params?.buttonParams || !template) return;
  const buttons = template.buttons ?? [];
  for (const key of Object.keys(params.buttonParams)) {
    const index = Number(key);
    const button = buttons[index];
    if (!button) {
      throw new TemplateParamsError(
        `template.params.buttonParams[${index}]: the template has no button at that index`
      );
    }
    if (!(BUTTON_TYPES_WITH_PARAM as readonly string[]).includes(button.type)) {
      throw new TemplateParamsError(
        `template.params.buttonParams[${index}]: a ${button.type} button does not accept a parameter (only QUICK_REPLY, URL and COPY_CODE)`
      );
    }
  }
}
