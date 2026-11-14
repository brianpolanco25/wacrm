import { describe, expect, it } from 'vitest';

import type { MessageTemplate } from '@/types';
import {
  assertButtonParamsMatchTemplate,
  normalizeTemplateMessageParams,
  TemplateParamsError,
} from './template-params';
import { buildSendComponents } from './template-send-builder';

const template = {
  body_text: 'Hola {{1}}, cita {{2}}',
  buttons: [
    { type: 'QUICK_REPLY', text: 'Confirmo' },
    { type: 'QUICK_REPLY', text: 'Cancelar consulta' },
    { type: 'PHONE_NUMBER', text: 'Llamar', phone_number: '+18095550000' },
  ],
} as unknown as MessageTemplate;

describe('normalizeTemplateMessageParams', () => {
  it('acepta camelCase y snake_case y pasa los índices a número', () => {
    expect(
      normalizeTemplateMessageParams({
        body: ['Ada', 'mañana'],
        header_text: 'Clínica',
        button_params: { '0': 'chr1:x:confirm', '1': 'chr1:x:cancel' },
      })
    ).toEqual({
      body: ['Ada', 'mañana'],
      headerText: 'Clínica',
      buttonParams: { 0: 'chr1:x:confirm', 1: 'chr1:x:cancel' },
    });
  });

  it('undefined/null no son error', () => {
    expect(normalizeTemplateMessageParams(undefined)).toBeUndefined();
    expect(normalizeTemplateMessageParams(null)).toBeUndefined();
  });

  it.each([
    ['un string', 'x'],
    ['body que no es array de strings', { body: [1] }],
    ['headerText numérico', { headerText: 5 }],
    ['buttonParams como array', { buttonParams: ['a'] }],
    ['índice no numérico', { buttonParams: { a: 'x' } }],
    ['payload vacío', { buttonParams: { 0: ' ' } }],
  ])('rechaza %s', (_n, raw) => {
    expect(() => normalizeTemplateMessageParams(raw)).toThrow(
      TemplateParamsError
    );
  });
});

describe('assertButtonParamsMatchTemplate', () => {
  it('acepta QUICK_REPLY', () => {
    expect(() =>
      assertButtonParamsMatchTemplate({ buttonParams: { 0: 'p' } }, template)
    ).not.toThrow();
  });

  it('rechaza un botón PHONE_NUMBER y un índice inexistente', () => {
    expect(() =>
      assertButtonParamsMatchTemplate({ buttonParams: { 2: 'p' } }, template)
    ).toThrow(/PHONE_NUMBER/);
    expect(() =>
      assertButtonParamsMatchTemplate({ buttonParams: { 7: 'p' } }, template)
    ).toThrow(/no button/);
  });

  it('el payload llega en el componente quick_reply del envío', () => {
    const params = normalizeTemplateMessageParams({
      body: ['Ada', 'mañana'],
      buttonParams: { 0: 'chr1:x:confirm', 1: 'chr1:x:cancel' },
    });
    const components = buildSendComponents(template, params);
    expect(components.filter((c) => c.type === 'button')).toEqual([
      {
        type: 'button',
        sub_type: 'quick_reply',
        index: '0',
        parameters: [{ type: 'payload', payload: 'chr1:x:confirm' }],
      },
      {
        type: 'button',
        sub_type: 'quick_reply',
        index: '1',
        parameters: [{ type: 'payload', payload: 'chr1:x:cancel' }],
      },
    ]);
  });
});
