import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

import { AiError } from '../types';
import { generateAnthropicWithTools } from './anthropic';
import { sentBody, stubFetch, toolArgs } from './tools-test-support';

// n13.3 R10, R13: Anthropic Messages API con herramientas (fetch crudo).

afterEach(() => vi.unstubAllGlobals());

const THINKING = { type: 'thinking', thinking: '', signature: 'sig-abc' };

describe('generateAnthropicWithTools', () => {
  it('sends tools with input_schema and tool_choice', async () => {
    const f = stubFetch({
      content: [{ type: 'text', text: 'Hola' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    const r = await generateAnthropicWithTools(toolArgs());
    const body = sentBody(f);
    expect(body.tools).toEqual([
      {
        name: 'health__search_patient',
        description: 'Health: Buscar paciente.',
        input_schema: toolArgs().tools[0].parameters,
      },
      {
        name: 'health__list_doctors',
        description: 'Health: Listar doctores.',
        input_schema: { type: 'object', properties: {} },
      },
    ]);
    expect(body.tool_choice).toEqual({ type: 'auto' });
    expect(body.system).toBe('SYS');
    expect(r).toEqual({
      text: 'Hola',
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      assistant: [{ type: 'text', text: 'Hola' }],
    });
  });

  it('parses tool_use blocks and keeps the whole assistant content', async () => {
    const content = [
      THINKING,
      { type: 'text', text: 'Let me check.' },
      {
        type: 'tool_use',
        id: 'tu_1',
        name: 'health__search_patient',
        input: { document: '1' },
      },
      { type: 'tool_use', id: 'tu_2', name: 'health__list_doctors', input: {} },
    ];
    stubFetch({ content, stop_reason: 'tool_use' });
    const r = await generateAnthropicWithTools(toolArgs());
    expect(r.toolCalls).toEqual([
      { id: 'tu_1', name: 'health__search_patient', args: { document: '1' } },
      { id: 'tu_2', name: 'health__list_doctors', args: {} },
    ]);
    expect(r.assistant).toEqual(content);
  });

  it('replays the assistant turn untouched and all results in ONE user message', async () => {
    const assistant = [
      THINKING,
      { type: 'tool_use', id: 'tu_1', name: 'a', input: {} },
      { type: 'tool_use', id: 'tu_2', name: 'b', input: {} },
    ];
    const f = stubFetch({ content: [{ type: 'text', text: 'Listo' }] });
    await generateAnthropicWithTools(
      toolArgs({
        toolChoice: 'none',
        steps: [
          {
            assistant,
            results: [
              {
                callId: 'tu_1',
                name: 'a',
                isError: false,
                payload: { ok: true, status: 200, data: 1 },
              },
              {
                callId: 'tu_2',
                name: 'b',
                isError: true,
                payload: { ok: false, outcome: 'timeout' },
              },
            ],
          },
        ],
      })
    );
    const body = sentBody(f);
    expect(body.tool_choice).toEqual({ type: 'none' });
    expect(body.messages).toEqual([
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: assistant },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: '{"ok":true,"status":200,"data":1}',
          },
          {
            type: 'tool_result',
            tool_use_id: 'tu_2',
            content: '{"ok":false,"outcome":"timeout"}',
            is_error: true,
          },
        ],
      },
    ]);
  });

  it.each(['max_tokens', 'refusal'])(
    'stop_reason %s runs no tools',
    async (stop) => {
      stubFetch({
        content: [
          { type: 'text', text: 'partial' },
          { type: 'tool_use', id: 'tu_1', name: 'x', input: {} },
        ],
        stop_reason: stop,
      });
      const r = await generateAnthropicWithTools(toolArgs());
      expect(r.toolCalls).toEqual([]);
      expect(r.text).toBe('partial');
    }
  );

  it('no text and no calls → empty_response', async () => {
    stubFetch({ content: [THINKING], stop_reason: 'end_turn' });
    await expect(generateAnthropicWithTools(toolArgs())).rejects.toMatchObject({
      code: 'empty_response',
    });
  });

  it('a provider error throws AiError as today', async () => {
    stubFetch({ error: { message: 'bad' } }, 401);
    await expect(generateAnthropicWithTools(toolArgs())).rejects.toBeInstanceOf(
      AiError
    );
  });
});
