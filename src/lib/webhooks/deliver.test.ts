import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { FakeDatabase, type Row } from '@/lib/security/fake-supabase';

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (s: string) => String(s).replace(/^enc:/, ''),
  encrypt: (s: string) => `enc:${s}`,
}));

vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: vi.fn(async () => true),
}));

import { isDeliverableUrl } from '@/lib/webhooks/ssrf';
import { dispatchWebhookEvent } from './deliver';

const A = 'acct-a';
const B = 'acct-b';

let fake: FakeDatabase;
let db: SupabaseClient;

function deliveries(): Row[] {
  return fake.rows('webhook_deliveries');
}

beforeEach(() => {
  fake = new FakeDatabase(
    {
      webhook_endpoints: [
        {
          id: 'wh-b',
          account_id: B,
          url: 'https://b.example.com/hook',
          secret: 'enc:secret-b',
          events: ['message.received'],
          is_active: true,
          failure_count: 0,
        },
        {
          id: 'wh-a1',
          account_id: A,
          url: 'https://a1.example.com/hook',
          secret: 'enc:secret-a1',
          events: ['message.received', 'conversation.created'],
          is_active: true,
          failure_count: 0,
        },
        {
          id: 'wh-a2',
          account_id: A,
          url: 'https://a2.example.com/hook',
          secret: 'enc:secret-a2',
          events: ['message.received'],
          is_active: true,
          failure_count: 0,
        },
      ],
      webhook_deliveries: [],
    },
    {
      record_webhook_failure: (args) => {
        const row = fake
          .rows('webhook_endpoints')
          .find((r) => r.id === args.endpoint_id);
        if (row) {
          const next = ((row.failure_count as number) ?? 0) + 1;
          row.failure_count = next;
          if (next >= (args.max_failures as number)) row.is_active = false;
        }
        return { data: null, error: null };
      },
    }
  );
  db = fake.admin as unknown as SupabaseClient;
  vi.mocked(isDeliverableUrl).mockResolvedValue(true);
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => vi.unstubAllGlobals());

describe('dispatchWebhookEvent', () => {
  it('persiste una entrega por endpoint suscrito y hace el primer intento', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    await dispatchWebhookEvent(db, A, 'message.received', { x: 1 });

    expect(deliveries()).toHaveLength(2);
    expect(deliveries().map((d) => d.status)).toEqual([
      'delivered',
      'delivered',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((c) => c[0]).sort();
    expect(urls).toEqual([
      'https://a1.example.com/hook',
      'https://a2.example.com/hook',
    ]);
  });

  it('no entrega a endpoints de otra cuenta (fuga)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    await dispatchWebhookEvent(db, A, 'message.received', {});

    expect(deliveries().every((d) => d.account_id === A)).toBe(true);
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes('b.example.com'))
    ).toBe(false);
  });

  it('un receptor caído deja la entrega en la cola, no la pierde', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    );

    await dispatchWebhookEvent(db, A, 'conversation.created', { c: 1 });

    expect(deliveries()).toHaveLength(1);
    const row = deliveries()[0];
    expect(row.status).toBe('failed');
    expect(row.attempt).toBe(1);
    expect(row.last_error).toBe('ECONNREFUSED');
    expect(new Date(row.next_attempt_at as string).getTime()).toBeGreaterThan(
      Date.now() + 50_000
    );
  });

  it('nunca lanza aunque la base falle (CP11: lo entrante no se bloquea)', async () => {
    const broken = {
      from: () => {
        throw new Error('db down');
      },
    } as unknown as SupabaseClient;

    await expect(
      dispatchWebhookEvent(broken, A, 'message.received', {})
    ).resolves.toBeUndefined();
  });
});
