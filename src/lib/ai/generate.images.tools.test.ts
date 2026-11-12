import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// n15.2 D5 / R24 (review ronda 2, hallazgo 1): con el bucle de herramientas
// REAL, una herramienta ejecutada en una ronda cuyo proveedor no devolvió
// uso, seguida de un provider_error, no se reintenta sin imágenes: la
// herramienta (p. ej. crear la cita) se ejecuta una sola vez.

const h = vi.hoisted(() => ({
  execute: vi.fn(),
  withTools: vi.fn(),
}));
vi.mock('@/lib/integrations/execute', () => ({
  executeIntegrationOperation: h.execute,
}));
vi.mock('./providers/anthropic', () => ({
  generateAnthropic: vi.fn(),
  generateAnthropicWithTools: h.withTools,
}));

import type { SupabaseClient } from '@supabase/supabase-js';
import { generateReply } from './generate';
import { AiError, type AiConfig, type ChatMessage } from './types';
import type { AiToolset } from './tools/types';

const config: AiConfig = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  apiKey: 'sk',
  keySource: 'account',
  systemPrompt: null,
  isActive: true,
  autoReplyEnabled: true,
  autoReplyMaxPerConversation: 3,
  handoffMode: 'queue',
  handoffAgentId: null,
  handoffMessage: null,
  embeddingsApiKey: null,
  embeddingsProvider: 'openai',
};

const toolset: AiToolset = {
  tools: [
    {
      name: 'health__create_appointment',
      integrationSlug: 'health',
      integrationName: 'Cabbity Health',
      operationKey: 'create_appointment',
      method: 'GET',
      description: 'Crear cita',
      parameters: { type: 'object', properties: {} },
      declaredParams: [
        {
          name: 'doc',
          in: 'query',
          type: 'string',
          required: true,
          description: '',
        },
      ],
    },
  ],
  integrations: [
    {
      slug: 'health',
      name: 'Cabbity Health',
      instructions: null,
      timezone: null,
    },
  ],
};

const messages: ChatMessage[] = [
  {
    role: 'user',
    content: '[imagen] mi cédula',
    image: { messageId: 'm1', mediaUrl: null, mediaType: 'image/jpeg' },
    images: [{ mimeType: 'image/jpeg', data: 'QUJD' }],
  },
];

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  h.execute.mockResolvedValue({
    ok: true,
    status: 200,
    data: { id: 1 },
    latencyMs: 1,
  });
});
afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe('generateReply + runToolLoop — no retry after a tool ran (D5)', () => {
  it('round 1 runs a tool with usage null, round 2 provider_error → execute once, no retry', async () => {
    const err = new AiError('Anthropic API error (500)', {
      code: 'provider_error',
    });
    h.withTools
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [
          {
            id: 'c1',
            name: 'health__create_appointment',
            args: { doc: '00112345678' },
          },
        ],
        usage: null,
        assistant: { calls: ['c1'] },
      })
      .mockRejectedValueOnce(err);

    await expect(
      generateReply({
        config,
        systemPrompt: 'S',
        messages,
        tools: {
          toolset,
          db: {} as unknown as SupabaseClient,
          accountId: 'acct-A',
        },
      })
    ).rejects.toBe(err);

    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.withTools).toHaveBeenCalledTimes(2);
    expect(err.usage).toBeNull();
    expect(err.toolsRan).toBe(true);
  });

  it('provider_error on the first round (no tool ran) → one retry without images', async () => {
    h.withTools
      .mockRejectedValueOnce(
        new AiError('Anthropic API error (400)', { code: 'provider_error' })
      )
      .mockResolvedValueOnce({
        text: 'Escríbeme tu cédula, por favor.',
        toolCalls: [],
        usage: null,
        assistant: {},
      });

    const r = await generateReply({
      config,
      systemPrompt: 'S',
      messages,
      tools: {
        toolset,
        db: {} as unknown as SupabaseClient,
        accountId: 'acct-A',
      },
    });

    expect(r.text).toBe('Escríbeme tu cédula, por favor.');
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.withTools).toHaveBeenCalledTimes(2);
    const retried = h.withTools.mock.calls[1][0] as { messages: ChatMessage[] };
    expect(retried.messages[0]).not.toHaveProperty('images');
    expect(retried.messages[0].content).toBe(
      '[imagen no disponible] mi cédula'
    );
  });
});
