import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_OUTPUT_TOKENS } from '../defaults';
import { generateAnthropic, generateAnthropicWithTools } from './anthropic';
import {
  IMAGE_TRANSCRIPT,
  IMG1,
  IMG2,
  TEXT_TRANSCRIPT,
} from './images-test-support';
import { sentBody, stubFetch, toolArgs } from './tools-test-support';

// n15.2 R18, R20, R21: Anthropic Messages con imágenes.

afterEach(() => vi.unstubAllGlobals());

const OK = {
  content: [{ type: 'text', text: 'Hola' }],
  stop_reason: 'end_turn',
};
const args = (messages = IMAGE_TRANSCRIPT) => ({
  apiKey: 'k',
  model: 'claude-sonnet-4-5',
  systemPrompt: 'SYS',
  messages,
  timeoutMs: 1000,
});
const image = (i: typeof IMG1) => ({
  type: 'image',
  source: { type: 'base64', media_type: i.mimeType, data: i.data },
});
// The leading assistant greeting is dropped, as before.
const EXPECTED_MESSAGES = [
  {
    role: 'user',
    content: [
      image(IMG1),
      { type: 'text', text: 'quiero cita\n\n[imagen] mi cédula' },
    ],
  },
  { role: 'assistant', content: 'gracias' },
  { role: 'user', content: [image(IMG2), { type: 'text', text: '[imagen]' }] },
];

describe('Anthropic adapter — images', () => {
  it('generateAnthropic: base64 image blocks before the text, assistant images ignored (R18, R21)', async () => {
    const f = stubFetch(OK);
    await generateAnthropic(args());
    expect(sentBody(f).messages).toEqual(EXPECTED_MESSAGES);
  });

  it('generateAnthropicWithTools carries the same images (R20)', async () => {
    const f = stubFetch(OK);
    await generateAnthropicWithTools(toolArgs({ messages: IMAGE_TRANSCRIPT }));
    expect(sentBody(f).messages).toEqual(EXPECTED_MESSAGES);
  });

  it('a transcript without images sends exactly the body of before (R18)', async () => {
    const f = stubFetch(OK);
    await generateAnthropic(args(TEXT_TRANSCRIPT));
    const init = (f.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(init.body).toBe(
      JSON.stringify({
        model: 'claude-sonnet-4-5',
        system: 'SYS',
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [
          { role: 'user', content: 'hola' },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'cita' },
        ],
      })
    );
  });
});
