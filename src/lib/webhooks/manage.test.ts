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

import {
  listDeliveries,
  retryDelivery,
  rotateWebhookSecret,
  sendTestDelivery,
  serializeDelivery,
} from './manage';

const A = 'acct-a';
const B = 'acct-b';

let fake: FakeDatabase;
let db: SupabaseClient;

function deliveries(): Row[] {
  return fake.rows('webhook_deliveries');
}

function delivery(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    account_id: A,
    endpoint_id: 'wh-a',
    event: 'message.received',
    payload: {
      id: `evt-${id}`,
      event: 'message.received',
      occurred_at: '2026-09-01T00:00:00.000Z',
      account_id: A,
      data: { text: 'hola' },
    },
    attempt: 1,
    status: 'failed',
    next_attempt_at: '2026-09-01T00:01:00.000Z',
    last_status_code: 500,
    last_error: 'endpoint responded 500',
    created_at: '2026-09-01T00:00:00.000Z',
    delivered_at: null,
    ...over,
  };
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
          created_at: '2026-09-01T00:00:00.000Z',
        },
        {
          id: 'wh-a',
          account_id: A,
          url: 'https://a.example.com/hook',
          secret: 'enc:secret-a',
          events: ['message.received'],
          is_active: true,
          failure_count: 0,
          created_at: '2026-09-01T00:00:00.000Z',
        },
      ],
      webhook_deliveries: [
        delivery('d-b', { account_id: B, endpoint_id: 'wh-b' }),
        delivery('d-1'),
        delivery('d-2', {
          status: 'delivered',
          created_at: '2026-09-02T00:00:00.000Z',
          delivered_at: '2026-09-02T00:00:01.000Z',
          last_status_code: 200,
          last_error: null,
        }),
      ],
    },
    {
      record_webhook_failure: (args) => {
        const row = fake
          .rows('webhook_endpoints')
          .find((r) => r.id === args.endpoint_id);
        if (row) row.failure_count = ((row.failure_count as number) ?? 0) + 1;
        return { data: null, error: null };
      },
    }
  );
  db = fake.admin as unknown as SupabaseClient;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
});

afterEach(() => vi.unstubAllGlobals());

describe('serializeDelivery', () => {
  it('no deja salir el payload (lleva datos del cliente final)', () => {
    const out = serializeDelivery(delivery('d-1') as Record<string, unknown>);
    expect(out).not.toHaveProperty('payload');
    expect(out).not.toHaveProperty('account_id');
    expect(out.last_status_code).toBe(500);
  });
});

describe('listDeliveries', () => {
  it('lista las del endpoint, más recientes primero', async () => {
    const page = await listDeliveries(db, A, 'wh-a', {
      limit: 10,
      cursor: null,
    });
    expect(page?.items.map((d) => d.id)).toEqual(['d-2', 'd-1']);
    expect(page?.nextCursor).toBeNull();
  });

  it('filtra por estado', async () => {
    const page = await listDeliveries(db, A, 'wh-a', {
      limit: 10,
      cursor: null,
      status: 'failed',
    });
    expect(page?.items.map((d) => d.id)).toEqual(['d-1']);
  });

  it('pagina y devuelve cursor', async () => {
    const page = await listDeliveries(db, A, 'wh-a', {
      limit: 1,
      cursor: null,
    });
    expect(page?.items).toHaveLength(1);
    expect(page?.nextCursor).toBeTruthy();
  });

  it('un endpoint de otra cuenta no existe (404, no 403)', async () => {
    expect(
      await listDeliveries(db, A, 'wh-b', { limit: 10, cursor: null })
    ).toBeNull();
  });
});

describe('retryDelivery', () => {
  it('reencola desde el primer peldaño y entrega en el acto', async () => {
    const out = await retryDelivery(db, A, 'wh-a', 'd-1');

    expect(out.kind).toBe('attempted');
    if (out.kind !== 'attempted') return;
    expect(out.status).toBe('delivered');
    const row = deliveries().find((d) => d.id === 'd-1');
    expect(row?.status).toBe('delivered');
    expect(row?.attempt).toBe(1); // reiniciada a 0 y reclamada → 1
  });

  it('no reintenta una que ya está en cola', async () => {
    deliveries().find((d) => d.id === 'd-1')!.status = 'pending';
    const out = await retryDelivery(db, A, 'wh-a', 'd-1');
    expect(out.kind).toBe('already_queued');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('una entrega de otra cuenta no existe', async () => {
    expect((await retryDelivery(db, A, 'wh-b', 'd-b')).kind).toBe('not_found');
    expect((await retryDelivery(db, A, 'wh-a', 'd-b')).kind).toBe('not_found');
    expect(deliveries().find((d) => d.id === 'd-b')?.status).toBe('failed');
  });
});

describe('sendTestDelivery', () => {
  it('encola y entrega un ping firmado, y lo deja en la bitácora', async () => {
    const out = await sendTestDelivery(db, A, 'wh-a');

    expect(out?.status).toBe('delivered');
    expect(out?.delivery.event).toBe('ping');
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls[0][0]).toBe('https://a.example.com/hook');
    const opts = fetchMock.mock.calls[0][1] as unknown as {
      headers: Record<string, string>;
    };
    expect(opts.headers['X-Wacrm-Event']).toBe('ping');
    expect(opts.headers['X-Wacrm-Signature']).toMatch(
      /^t=\d+,v1=[0-9a-f]{64}$/
    );
    expect(deliveries().some((d) => d.event === 'ping')).toBe(true);
  });

  it('endpoint ajeno → null y ninguna llamada saliente', async () => {
    expect(await sendTestDelivery(db, A, 'wh-b')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('rotateWebhookSecret', () => {
  it('cambia el secreto guardado y devuelve el nuevo una vez', async () => {
    const before = fake.rows('webhook_endpoints').find((r) => r.id === 'wh-a')
      ?.secret as string;

    const out = await rotateWebhookSecret(db, A, 'wh-a');

    expect(out?.secret).toMatch(/^whsec_/);
    const after = fake.rows('webhook_endpoints').find((r) => r.id === 'wh-a')
      ?.secret as string;
    expect(after).not.toBe(before);
    // Se guarda cifrado, nunca en claro.
    expect(after).toBe(`enc:${out?.secret}`);
    // Y la representación pública del endpoint no lo lleva.
    expect(out?.endpoint).not.toHaveProperty('secret');
  });

  it('no rota el de otra cuenta', async () => {
    const before = fake.rows('webhook_endpoints').find((r) => r.id === 'wh-b')
      ?.secret as string;
    expect(await rotateWebhookSecret(db, A, 'wh-b')).toBeNull();
    expect(
      fake.rows('webhook_endpoints').find((r) => r.id === 'wh-b')?.secret
    ).toBe(before);
  });
});
