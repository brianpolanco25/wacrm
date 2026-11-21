import { afterEach, describe, expect, it, vi } from 'vitest';

import { GEMINI_MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS } from '../defaults';
import {
  generateGemini,
  generateGeminiWithTools,
  trimDanglingFragment,
} from './gemini';
import { sentBody, stubFetch, toolArgs } from './tools-test-support';

// n13.12: respuestas cortadas por MAX_TOKENS (el razonamiento cuenta
// contra maxOutputTokens).

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const reply = (text: string, finishReason: string) => ({
  candidates: [
    {
      content: {
        role: 'model',
        parts: [{ text: 'pensando…', thought: true }, { text }],
      },
      finishReason,
    },
  ],
  usageMetadata: { thoughtsTokenCount: 900 },
});

describe('trimDanglingFragment', () => {
  it.each([
    ['Hola.\n\nTenemos sesiones.\n\n¿', 'Hola.\n\nTenemos sesiones.'],
    ['Primero. Luego vien', 'Primero.'],
    ['¡Hola! ¿Cómo est', '¡Hola!'],
    [
      'Gracias por escribir, día a día 🙏\n\nPor ej',
      'Gracias por escribir, día a día 🙏',
    ],
    ['Dijo «vale.» y se fu', 'Dijo «vale.»'],
    ['Versión 3.5 de', ''],
    ['sin final', ''],
    ['', ''],
  ])('%j -> %j', (input, out) => {
    expect(trimDanglingFragment(input)).toBe(out);
  });
});

describe.each([
  [
    'generateGemini',
    () => generateGemini(toolArgs()) /* tool fields ignored */,
  ],
  ['generateGeminiWithTools', () => generateGeminiWithTools(toolArgs())],
])('%s', (_name, call) => {
  it('sends the Gemini budget, not the shared one', async () => {
    const f = stubFetch(reply('Hola.', 'STOP'));
    await call();
    expect(GEMINI_MAX_OUTPUT_TOKENS).toBeGreaterThan(MAX_OUTPUT_TOKENS);
    expect(sentBody(f).generationConfig).toEqual({
      maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
    });
  });

  it('keeps a STOP reply whole, without thought parts, and does not warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch(reply('Hola. Te esper', 'STOP'));
    expect((await call()).text).toBe('Hola. Te esper');
    expect(warn).not.toHaveBeenCalled();
  });

  it('cuts a MAX_TOKENS reply back to the last whole sentence and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch(reply('Tenemos sesiones.\n\n¿', 'MAX_TOKENS'));
    expect((await call()).text).toBe('Tenemos sesiones.');
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      model: 'model-1',
      finishReason: 'MAX_TOKENS',
      thoughtsTokenCount: 900,
    });
  });

  it('keeps a MAX_TOKENS reply that already ends on a sentence', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch(reply('Todo listo.', 'MAX_TOKENS'));
    expect((await call()).text).toBe('Todo listo.');
  });

  it('maps a MAX_TOKENS fragment with no whole sentence to empty_response', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch(reply('Hola, te cuen', 'MAX_TOKENS'));
    await expect(call()).rejects.toMatchObject({ code: 'empty_response' });
  });
});
