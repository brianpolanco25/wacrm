/**
 * Test support de los adaptadores con herramientas (n13.3). Solo lo
 * importan archivos `*.tools.test.ts`.
 */
import { vi } from 'vitest';

import type { ProviderToolArgs, ToolSpec } from './shared';

export const SPEC_SEARCH: ToolSpec = {
  name: 'health__search_patient',
  description: 'Health: Buscar paciente.',
  parameters: {
    type: 'object',
    properties: {
      document: { type: 'string', description: 'Cédula' },
      status: { type: 'string', enum: ['a', 'b'] },
    },
    required: ['document'],
  },
};

export const SPEC_EMPTY: ToolSpec = {
  name: 'health__list_doctors',
  description: 'Health: Listar doctores.',
  parameters: { type: 'object', properties: {} },
};

export function toolArgs(
  over: Partial<ProviderToolArgs> = {}
): ProviderToolArgs {
  return {
    apiKey: 'key-1',
    model: 'model-1',
    systemPrompt: 'SYS',
    messages: [{ role: 'user', content: 'hola' }],
    timeoutMs: 1000,
    tools: [SPEC_SEARCH, SPEC_EMPTY],
    steps: [],
    toolChoice: 'auto',
    ...over,
  };
}

export function stubFetch(json: unknown, status = 200) {
  const fetchSpy = vi.fn(
    async () =>
      ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => json,
      }) as unknown as Response
  );
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

export function sentBody(fetchSpy: ReturnType<typeof stubFetch>) {
  const init = (fetchSpy.mock.calls[0] as unknown[])[1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}
