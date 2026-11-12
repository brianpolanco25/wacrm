import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_OUTPUT_TOKENS } from '../defaults';
import { generateOpenAi, generateOpenAiWithTools } from './openai';
import {
  IMAGE_TRANSCRIPT,
  IMG1,
  IMG2,
  TEXT_TRANSCRIPT,
} from './images-test-support';
import { sentBody, stubFetch, toolArgs } from './tools-test-support';

// n15.2 R17, R20, R21: OpenAI Chat Completions con imágenes.

afterEach(() => vi.unstubAllGlobals());

const PLAIN_OK = { choices: [{ message: { content: 'Hola' } }] };
const TOOLS_OK = {
  choices: [
    { message: { role: 'assistant', content: 'Hola' }, finish_reason: 'stop' },
  ],
};
const args = (messages = IMAGE_TRANSCRIPT) => ({
  apiKey: 'k',
  model: 'gpt-4o-mini',
  systemPrompt: 'SYS',
  messages,
  timeoutMs: 1000,
});
const EXPECTED_MESSAGES = [
  { role: 'system', content: 'SYS' },
  { role: 'assistant', content: 'Hola' },
  {
    role: 'user',
    content: [
      {
        type: 'image_url',
        image_url: {
          url: `data:image/jpeg;base64,${IMG1.data}`,
          detail: 'high',
        },
      },
      { type: 'text', text: 'quiero cita\n\n[imagen] mi cédula' },
    ],
  },
  { role: 'assistant', content: 'gracias' },
  {
    role: 'user',
    content: [
      {
        type: 'image_url',
        image_url: {
          url: `data:image/png;base64,${IMG2.data}`,
          detail: 'high',
        },
      },
      { type: 'text', text: '[imagen]' },
    ],
  },
];

describe('OpenAI adapter — images', () => {
  it('generateOpenAi: image_url data URIs before the text, assistant images ignored (R17, R21)', async () => {
    const f = stubFetch(PLAIN_OK);
    await generateOpenAi(args());
    expect(sentBody(f).messages).toEqual(EXPECTED_MESSAGES);
  });

  it('generateOpenAiWithTools carries the same images (R20)', async () => {
    const f = stubFetch(TOOLS_OK);
    await generateOpenAiWithTools(toolArgs({ messages: IMAGE_TRANSCRIPT }));
    expect(sentBody(f).messages).toEqual(EXPECTED_MESSAGES);
  });

  it('a transcript without images sends exactly the body of before (R17)', async () => {
    const f = stubFetch(PLAIN_OK);
    await generateOpenAi(args(TEXT_TRANSCRIPT));
    const init = (f.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(init.body).toBe(
      JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'SYS' },
          { role: 'user', content: 'hola' },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'cita' },
        ],
        max_completion_tokens: MAX_OUTPUT_TOKENS,
      })
    );
  });
});
