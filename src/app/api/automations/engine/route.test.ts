import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so the module factories below can close over the recorded calls.
const h = vi.hoisted(() => ({
  /** Every dispatch the route handed to the engine. */
  dispatches: [] as Record<string, unknown>[],
  requireRole: vi.fn(async () => ({ accountId: 'acct-1', userId: 'user-1' })),
}));

vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: async (input: Record<string, unknown>) => {
    h.dispatches.push(input);
  },
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: () => new Response('forbidden', { status: 403 }),
}));

import { POST } from './route';

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/automations/engine', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  h.dispatches = [];
});

describe('POST /api/automations/engine', () => {
  it('dispatches with the caller account and its own context', async () => {
    const res = await post({
      trigger_type: 'new_message_received',
      contact_id: 'c1',
      context: { message_text: 'hola' },
    });

    expect(res.status).toBe(200);
    expect(h.dispatches).toEqual([
      {
        accountId: 'acct-1',
        triggerType: 'new_message_received',
        contactId: 'c1',
        context: { message_text: 'hola' },
      },
    ]);
  });

  /**
   * Cross-tenant leak guard for the per-message reply reservation
   * (fase 1 §4). The reservation is written with the service-role client
   * and keyed on the message alone, so a caller who could choose the
   * message id would be able to take the reservation for ANOTHER
   * account's inbound and silence that account's AI reply for it. The
   * only legitimate source of the id is the webhook that just stored the
   * message.
   */
  it('drops a caller-supplied inbound_message_id (it would reserve another account´s message)', async () => {
    await post({
      trigger_type: 'new_message_received',
      contact_id: 'c1',
      context: {
        message_text: 'hola',
        inbound_message_id: 'victim-msg-of-account-b',
      },
    });

    const context = h.dispatches[0].context as Record<string, unknown>;
    expect(context).not.toHaveProperty('inbound_message_id');
    expect(context).toEqual({ message_text: 'hola' });
  });

  it('rejects a body without a trigger type', async () => {
    const res = await post({ context: {} });
    expect(res.status).toBe(400);
    expect(h.dispatches).toEqual([]);
  });
});
