import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateGeminiWithTools, toGeminiSchema } from './gemini';
import { sentBody, stubFetch, toolArgs } from './tools-test-support';

// n13.3 R12, R13: Gemini generateContent con functionDeclarations.

afterEach(() => vi.unstubAllGlobals());

describe('toGeminiSchema', () => {
  it('upper-cases types, enum only on STRING with format enum, nested', () => {
    expect(
      toGeminiSchema({
        type: 'object',
        properties: {
          s: { type: 'string', enum: ['a'], description: 'd' },
          n: { type: 'integer' },
          o: {
            type: 'object',
            properties: { b: { type: 'boolean' } },
            required: ['b'],
          },
        },
        required: ['s'],
      })
    ).toEqual({
      type: 'OBJECT',
      properties: {
        s: { type: 'STRING', description: 'd', format: 'enum', enum: ['a'] },
        n: { type: 'INTEGER' },
        o: {
          type: 'OBJECT',
          properties: { b: { type: 'BOOLEAN' } },
          required: ['b'],
        },
      },
      required: ['s'],
    });
  });
});

describe('generateGeminiWithTools', () => {
  it('sends functionDeclarations (no parameters without props) and AUTO', async () => {
    const f = stubFetch({
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'Hola' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 4,
        candidatesTokenCount: 1,
        totalTokenCount: 5,
      },
    });
    const r = await generateGeminiWithTools(toolArgs());
    const body = sentBody(f);
    const decls = (
      body.tools as { functionDeclarations: Record<string, unknown>[] }[]
    )[0].functionDeclarations;
    expect(decls[0]).toMatchObject({
      name: 'health__search_patient',
      parameters: { type: 'OBJECT' },
    });
    expect(decls[1]).toEqual({
      name: 'health__list_doctors',
      description: 'Health: Listar doctores.',
    });
    expect(body.toolConfig).toEqual({
      functionCallingConfig: { mode: 'AUTO' },
    });
    expect(r.text).toBe('Hola');
    expect(r.usage).toEqual({
      promptTokens: 4,
      completionTokens: 1,
      totalTokens: 5,
    });
  });

  it('parses functionCall parts, with id or a positional one', async () => {
    const content = {
      role: 'model',
      parts: [
        {
          functionCall: {
            id: 'fc-1',
            name: 'health__search_patient',
            args: { document: '1' },
          },
          thoughtSignature: 'TS1',
        },
        { functionCall: { name: 'health__list_doctors' } },
      ],
    };
    stubFetch({ candidates: [{ content, finishReason: 'STOP' }] });
    const r = await generateGeminiWithTools(toolArgs());
    expect(r.toolCalls).toEqual([
      { id: 'fc-1', name: 'health__search_patient', args: { document: '1' } },
      { id: 'gemini:1', name: 'health__list_doctors', args: {} },
    ]);
    expect(r.assistant).toEqual(content);
  });

  it('forces role model on the replayed content when missing', async () => {
    stubFetch({
      candidates: [
        {
          content: { parts: [{ functionCall: { name: 'x' } }] },
          finishReason: 'STOP',
        },
      ],
    });
    const r = await generateGeminiWithTools(toolArgs());
    expect(r.assistant).toEqual({
      role: 'model',
      parts: [{ functionCall: { name: 'x' } }],
    });
  });

  it('replays the model content with thoughtSignature and one user content of functionResponses', async () => {
    const assistant = {
      role: 'model',
      parts: [
        {
          functionCall: { id: 'fc-1', name: 'a', args: {} },
          thoughtSignature: 'TS1',
        },
        { functionCall: { name: 'b', args: {} } },
      ],
    };
    const f = stubFetch({
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'ok' }] },
          finishReason: 'STOP',
        },
      ],
    });
    await generateGeminiWithTools(
      toolArgs({
        toolChoice: 'none',
        steps: [
          {
            assistant,
            results: [
              {
                callId: 'fc-1',
                name: 'a',
                isError: false,
                payload: { ok: true },
              },
              {
                callId: 'gemini:1',
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
    expect(body.toolConfig).toEqual({
      functionCallingConfig: { mode: 'NONE' },
    });
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'hola' }] },
      assistant,
      {
        role: 'user',
        parts: [
          {
            functionResponse: { name: 'a', id: 'fc-1', response: { ok: true } },
          },
          { functionResponse: { name: 'b', response: { ok: false } } },
        ],
      },
    ]);
  });

  it.each(['MAX_TOKENS', 'SAFETY', 'MALFORMED_FUNCTION_CALL'])(
    'finishReason %s runs no tools',
    async (reason) => {
      stubFetch({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'part' }, { functionCall: { name: 'x' } }],
            },
            finishReason: reason,
          },
        ],
      });
      const r = await generateGeminiWithTools(toolArgs());
      expect(r.toolCalls).toEqual([]);
    }
  );

  it('no text and no calls → empty_response (thought parts are not text)', async () => {
    stubFetch({
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'hmm', thought: true }] },
          finishReason: 'STOP',
        },
      ],
    });
    await expect(generateGeminiWithTools(toolArgs())).rejects.toMatchObject({
      code: 'empty_response',
    });
  });
});
