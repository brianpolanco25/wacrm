import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_OUTPUT_TOKENS } from '../defaults';
import { generateGemini, generateGeminiWithTools } from './gemini';
import {
  IMAGE_TRANSCRIPT,
  IMG1,
  IMG2,
  TEXT_TRANSCRIPT,
} from './images-test-support';
import { sentBody, stubFetch, toolArgs } from './tools-test-support';

// n15.2 R16, R20, R21: Gemini generateContent con imágenes.

afterEach(() => vi.unstubAllGlobals());

const OK = {
  candidates: [
    {
      content: { role: 'model', parts: [{ text: 'Hola' }] },
      finishReason: 'STOP',
    },
  ],
};
const args = (messages = IMAGE_TRANSCRIPT) => ({
  apiKey: 'k',
  model: 'gemini-2.5-flash',
  systemPrompt: 'SYS',
  messages,
  timeoutMs: 1000,
});
const inline = (i: typeof IMG1) => ({
  inlineData: { mimeType: i.mimeType, data: i.data },
});
// The leading model greeting is dropped, as before.
const EXPECTED_CONTENTS = [
  {
    role: 'user',
    parts: [inline(IMG1), { text: 'quiero cita\n\n[imagen] mi cédula' }],
  },
  { role: 'model', parts: [{ text: 'gracias' }] },
  { role: 'user', parts: [inline(IMG2), { text: '[imagen]' }] },
];

describe('Gemini adapter — images', () => {
  it('generateGemini: inlineData parts before the text, model images ignored (R16, R21)', async () => {
    const f = stubFetch(OK);
    await generateGemini(args());
    expect(sentBody(f).contents).toEqual(EXPECTED_CONTENTS);
  });

  it('generateGeminiWithTools carries the same images (R20)', async () => {
    const f = stubFetch(OK);
    await generateGeminiWithTools(toolArgs({ messages: IMAGE_TRANSCRIPT }));
    expect(sentBody(f).contents).toEqual(EXPECTED_CONTENTS);
  });

  it('a transcript without images sends exactly the body of before (R16)', async () => {
    const f = stubFetch(OK);
    await generateGemini(args(TEXT_TRANSCRIPT));
    const init = (f.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(init.body).toBe(
      JSON.stringify({
        systemInstruction: { parts: [{ text: 'SYS' }] },
        contents: [
          { role: 'user', parts: [{ text: 'hola' }] },
          { role: 'model', parts: [{ text: 'ok' }] },
          { role: 'user', parts: [{ text: 'cita' }] },
        ],
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
      })
    );
  });
});
