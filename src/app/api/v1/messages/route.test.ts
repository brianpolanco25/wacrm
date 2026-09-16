import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Fase 7 §1 on the endpoint that matters: `POST /api/v1/messages`.
//
// The criterion is not "the helper works" (that is idempotency.test.ts) but
// "a retry does not send a second WhatsApp message". So the send core is the
// thing counted here: `sendMessageToConversation` is a spy, and every
// assertion is about how many times it ran.
// ---------------------------------------------------------------------------

import { FakeIdempotencyStore } from '@/lib/api/v1/fake-idempotency-store';
import { MAX_BODY_BYTES } from '@/lib/api/v1/body';
import { __resetIdempotencyPurgeCounter } from '@/lib/api/v1/idempotency';

const h = vi.hoisted(() => ({
  accountId: 'acct-a',
  keyId: 'key-1',
  db: null as unknown,
  sends: [] as Record<string, unknown>[],
  messageSeq: 0,
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: async () => ({
    authType: 'api_key' as const,
    supabase: h.db,
    accountId: h.accountId,
    keyId: h.keyId,
    scopes: ['messages:send'],
    createdBy: null,
  }),
}));

vi.mock('@/lib/whatsapp/resolve-conversation', () => ({
  resolveConversationForTarget: async () => ({
    conversationId: 'conv-1',
    contactId: 'contact-1',
    contactCreated: false,
  }),
}));

vi.mock('@/lib/whatsapp/resolve-config', () => ({
  configIdForPhoneNumberId: async () => 'cfg-1',
}));

vi.mock('@/lib/whatsapp/send-message', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/send-message')>()),
  validateSendMessageParams: () => {},
  sendMessageToConversation: async (
    _db: unknown,
    _accountId: string,
    params: Record<string, unknown>
  ) => {
    h.sends.push(params);
    h.messageSeq += 1;
    return {
      messageId: `m-${h.messageSeq}`,
      whatsappMessageId: `wamid.${h.messageSeq}`,
    };
  },
}));

import { POST } from './route';

const IDEMPOTENT_REPLAYED = 'Idempotent-Replayed';

function post(
  body: unknown,
  extraHeaders: Record<string, string> = {},
  rawBody?: string
) {
  return POST(
    new Request('https://crm.test/api/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extraHeaders },
      body: rawBody ?? JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  h.db = new FakeIdempotencyStore() as unknown as SupabaseClient;
  h.sends = [];
  h.messageSeq = 0;
  h.accountId = 'acct-a';
  h.keyId = 'key-1';
  __resetIdempotencyPurgeCounter();
});

describe('POST /api/v1/messages — envelope hardening', () => {
  it('carries X-Request-Id and Cache-Control: no-store on success', async () => {
    const res = await post({ to: '+14155550123', type: 'text', text: 'hi' });
    expect(res.status).toBe(201);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses a body of 1 MiB + 1 with 413 and never reaches the send core', async () => {
    const envelope = '{"to":"+14155550123","type":"text","text":""}';
    const filler = 'a'.repeat(MAX_BODY_BYTES - envelope.length + 1);
    const raw = `{"to":"+14155550123","type":"text","text":"${filler}"}`;
    expect(Buffer.byteLength(raw, 'utf8')).toBe(MAX_BODY_BYTES + 1);

    const res = await post(null, {}, raw);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('payload_too_large');
    expect(h.sends).toHaveLength(0);
  });

  it('refuses text/plain with 415', async () => {
    const res = await post(
      { to: '+14155550123', type: 'text', text: 'hi' },
      { 'content-type': 'text/plain' }
    );
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unsupported_media_type');
    expect(h.sends).toHaveLength(0);
  });

  it('puts request_id in the error envelope so a caller can quote it', async () => {
    const res = await post({ type: 'text', text: 'hi' }); // no `to`
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; request_id: string };
    };
    expect(body.error.code).toBe('bad_request');
    expect(body.error.request_id).toBe(res.headers.get('X-Request-Id'));
  });
});

describe('POST /api/v1/messages — Idempotency-Key', () => {
  const payload = { to: '+14155550123', type: 'text', text: 'hi' };

  it('two identical POSTs send ONE message and the second is flagged as replayed', async () => {
    const first = await post(payload, { 'Idempotency-Key': 'order-4711' });
    const firstBody = (await first.json()) as {
      data: { message_id: string; whatsapp_message_id: string };
    };
    expect(first.status).toBe(201);
    expect(first.headers.get(IDEMPOTENT_REPLAYED)).toBeNull();

    const second = await post(payload, { 'Idempotency-Key': 'order-4711' });
    const secondBody = (await second.json()) as {
      data: { message_id: string; whatsapp_message_id: string };
    };

    expect(h.sends).toHaveLength(1);
    expect(second.status).toBe(201);
    expect(second.headers.get(IDEMPOTENT_REPLAYED)).toBe('true');
    expect(secondBody.data).toEqual(firstBody.data);
    // A replay is still its own request for log correlation.
    expect(second.headers.get('X-Request-Id')).not.toBe(
      first.headers.get('X-Request-Id')
    );
  });

  it('the same key with a different body is 409 idempotency_mismatch', async () => {
    await post(payload, { 'Idempotency-Key': 'order-4711' });
    const res = await post(
      { ...payload, text: 'something else' },
      { 'Idempotency-Key': 'order-4711' }
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('idempotency_mismatch');
    expect(h.sends).toHaveLength(1);
  });

  it('another API key reusing the same Idempotency-Key does NOT see the other response', async () => {
    const first = await post(payload, { 'Idempotency-Key': 'shared' });
    const firstBody = (await first.json()) as { data: { message_id: string } };

    // Same account, different key: a second integration that happens to
    // pick the same id must get its own message, not this one.
    h.keyId = 'key-2';
    const second = await post(payload, { 'Idempotency-Key': 'shared' });
    const secondBody = (await second.json()) as {
      data: { message_id: string };
    };

    expect(second.status).toBe(201);
    expect(second.headers.get(IDEMPOTENT_REPLAYED)).toBeNull();
    expect(secondBody.data.message_id).not.toBe(firstBody.data.message_id);
    expect(h.sends).toHaveLength(2);
  });

  it('without the header a retry sends again — the guarantee is opt-in', async () => {
    await post(payload);
    await post(payload);
    expect(h.sends).toHaveLength(2);
  });

  it('a rejected payload does not burn the key: the corrected retry goes through', async () => {
    const bad = await post(
      { type: 'text', text: 'hi' },
      {
        'Idempotency-Key': 'order-4712',
      }
    );
    expect(bad.status).toBe(400);
    expect(h.sends).toHaveLength(0);

    const good = await post(payload, { 'Idempotency-Key': 'order-4712' });
    expect(good.status).toBe(201);
    expect(h.sends).toHaveLength(1);
  });
});
