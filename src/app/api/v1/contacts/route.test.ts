import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fase 7 §1, 2.ª ronda — the body guards are a rule for EVERY /api/v1 write,
// not just for the two that got `withIdempotency`.
//
// `docs/public-api.md` promises "writes must send Content-Type:
// application/json (415 otherwise) … bodies are capped at 1 MiB (413)". This
// file holds that promise to the writes that are not wrapped in the
// idempotency helper: `POST /api/v1/contacts` and `PATCH /api/v1/contacts/{id}`
// read their body through `readJsonBody` like everyone else.
//
// The assertions that matter are the negative ones: the contact layer is
// never reached. A 413 that still buffered the payload, or a 415 answered
// after a write, would pass a status-code-only test.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  requireApiKey: vi.fn(),
  findOrCreateContact: vi.fn(async () => ({ id: 'contact-1', created: true })),
  getContactById: vi.fn(async () => ({ id: 'contact-1', phone: '+34600' })),
  setContactTags: vi.fn(async () => {}),
  resolveAuditUserId: vi.fn(async () => 'user-1'),
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: (...args: unknown[]) =>
    (h.requireApiKey as unknown as (...a: unknown[]) => unknown)(...args),
}));

vi.mock('@/lib/api/v1/contacts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/v1/contacts')>()),
  findOrCreateContact: h.findOrCreateContact,
  getContactById: h.getContactById,
  setContactTags: h.setContactTags,
  resolveAuditUserId: h.resolveAuditUserId,
}));

import { MAX_BODY_BYTES } from '@/lib/api/v1/body';
import { POST } from './route';
import { PATCH } from './[id]/route';

/** A client that fails the test if the route touches the database. */
function forbiddenClient() {
  return {
    from() {
      throw new Error('the route reached the database before the body guards');
    },
  };
}

function post(body: string, contentType: string | null) {
  const headers: Record<string, string> = {
    authorization: 'Bearer wacrm_live_x',
  };
  if (contentType) headers['content-type'] = contentType;
  return new Request('https://crm.test/api/v1/contacts', {
    method: 'POST',
    headers,
    body,
  });
}

beforeEach(() => {
  h.requireApiKey.mockReset();
  h.requireApiKey.mockResolvedValue({
    authType: 'api_key',
    supabase: forbiddenClient(),
    accountId: 'acct-1',
    keyId: 'key-1',
    scopes: ['contacts:read', 'contacts:write'],
    createdBy: 'user-1',
  });
  h.findOrCreateContact.mockClear();
  h.setContactTags.mockClear();
  h.getContactById.mockClear();
});

describe('POST /api/v1/contacts — shared body guards', () => {
  it('refuses a body of 1 MiB + 1 with 413 and never creates a contact', async () => {
    // A real oversized payload, not a forged Content-Length: the ceiling
    // has to hold while the bytes are being read.
    const filler = 'x'.repeat(MAX_BODY_BYTES);
    const body = JSON.stringify({ phone: '+34600', name: filler });
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(MAX_BODY_BYTES);

    const res = await POST(post(body, 'application/json'));
    expect(res.status).toBe(413);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('payload_too_large');
    expect(h.findOrCreateContact).not.toHaveBeenCalled();
  });

  it('refuses text/plain with 415, and a missing Content-Type too', async () => {
    const plain = await POST(post('{"phone":"+34600"}', 'text/plain'));
    expect(plain.status).toBe(415);
    const json = (await plain.json()) as { error: { code: string } };
    expect(json.error.code).toBe('unsupported_media_type');

    const bare = await POST(post('{"phone":"+34600"}', null));
    expect(bare.status).toBe(415);
    expect(h.findOrCreateContact).not.toHaveBeenCalled();
  });

  it('still answers 400 on a body that is not a JSON object', async () => {
    const res = await POST(post('[]', 'application/json'));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('bad_request');
    expect(h.findOrCreateContact).not.toHaveBeenCalled();
  });

  it('a well-formed write still goes through', async () => {
    const res = await POST(
      post(JSON.stringify({ phone: '+34600' }), 'application/json')
    );
    expect(res.status).toBe(201);
    expect(h.findOrCreateContact).toHaveBeenCalledTimes(1);
  });
});

describe('PATCH /api/v1/contacts/{id} — same guards', () => {
  const params = { params: Promise.resolve({ id: 'contact-1' }) };

  it('refuses text/plain with 415 before reading the contact', async () => {
    const res = await PATCH(
      new Request('https://crm.test/api/v1/contacts/contact-1', {
        method: 'PATCH',
        headers: {
          authorization: 'Bearer wacrm_live_x',
          'content-type': 'text/plain',
        },
        body: '{"name":"Ana"}',
      }),
      params
    );
    expect(res.status).toBe(415);
    expect(h.getContactById).not.toHaveBeenCalled();
  });

  it('refuses an oversized body with 413 before reading the contact', async () => {
    const body = JSON.stringify({ name: 'x'.repeat(MAX_BODY_BYTES) });
    const res = await PATCH(
      new Request('https://crm.test/api/v1/contacts/contact-1', {
        method: 'PATCH',
        headers: {
          authorization: 'Bearer wacrm_live_x',
          'content-type': 'application/json',
        },
        body,
      }),
      params
    );
    expect(res.status).toBe(413);
    expect(h.getContactById).not.toHaveBeenCalled();
  });
});
