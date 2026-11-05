import { afterEach, describe, expect, it, vi } from 'vitest';

import { INVALID_ARGS } from '../tools/types';
import { generateOpenAiWithTools } from './openai';
import { sentBody, stubFetch, toolArgs } from './tools-test-support';

// n13.3 R11, R13: OpenAI Chat Completions con herramientas.

afterEach(() => vi.unstubAllGlobals());

describe('generateOpenAiWithTools', () => {
  it('sends function tools and tool_choice, no parallel_tool_calls', async () => {
    const f = stubFetch({
      choices: [
        {
          message: { role: 'assistant', content: 'Hola' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    });
    const r = await generateOpenAiWithTools(toolArgs());
    const body = sentBody(f);
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'health__search_patient',
          description: 'Health: Buscar paciente.',
          parameters: toolArgs().tools[0].parameters,
        },
      },
      {
        type: 'function',
        function: {
          name: 'health__list_doctors',
          description: 'Health: Listar doctores.',
          parameters: { type: 'object', properties: {} },
        },
      },
    ]);
    expect(body.tool_choice).toBe('auto');
    expect(body).not.toHaveProperty('parallel_tool_calls');
    expect(r.text).toBe('Hola');
    expect(r.usage).toEqual({
      promptTokens: 5,
      completionTokens: 1,
      totalTokens: 6,
    });
  });

  it('parses tool_calls (content may be null) and invalid JSON arguments', async () => {
    const message = {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: {
            name: 'health__search_patient',
            arguments: '{"document":"1"}',
          },
        },
        {
          id: 'c2',
          type: 'function',
          function: { name: 'health__list_doctors', arguments: '{not json' },
        },
      ],
    };
    stubFetch({ choices: [{ message, finish_reason: 'tool_calls' }] });
    const r = await generateOpenAiWithTools(toolArgs());
    expect(r.toolCalls).toEqual([
      { id: 'c1', name: 'health__search_patient', args: { document: '1' } },
      { id: 'c2', name: 'health__list_doctors', args: INVALID_ARGS },
    ]);
    expect(r.text).toBe('');
    expect(r.assistant).toEqual(message);
  });

  it('replays the assistant message as is and one role:tool message per call', async () => {
    const assistant = {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'a', arguments: '{}' },
        },
        {
          id: 'c2',
          type: 'function',
          function: { name: 'b', arguments: '{}' },
        },
      ],
    };
    const f = stubFetch({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    });
    await generateOpenAiWithTools(
      toolArgs({
        toolChoice: 'none',
        steps: [
          {
            assistant,
            results: [
              {
                callId: 'c1',
                name: 'a',
                isError: false,
                payload: { ok: true },
              },
              {
                callId: 'c2',
                name: 'b',
                isError: true,
                payload: { ok: false },
              },
            ],
          },
        ],
      })
    );
    const body = sentBody(f);
    expect(body.tool_choice).toBe('none');
    expect(body.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hola' },
      assistant,
      { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
      { role: 'tool', tool_call_id: 'c2', content: '{"ok":false}' },
    ]);
  });

  it.each(['length', 'content_filter'])(
    'finish_reason %s runs no tools',
    async (reason) => {
      stubFetch({
        choices: [
          {
            message: {
              content: 'part',
              tool_calls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: { name: 'a', arguments: '{}' },
                },
              ],
            },
            finish_reason: reason,
          },
        ],
      });
      const r = await generateOpenAiWithTools(toolArgs());
      expect(r.toolCalls).toEqual([]);
    }
  );

  it('no text and no calls → empty_response', async () => {
    stubFetch({
      choices: [{ message: { content: '' }, finish_reason: 'stop' }],
    });
    await expect(generateOpenAiWithTools(toolArgs())).rejects.toMatchObject({
      code: 'empty_response',
    });
  });
});
