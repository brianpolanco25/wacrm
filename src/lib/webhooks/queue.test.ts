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
import {
  MAX_ATTEMPTS,
  MAX_CONSECUTIVE_FAILURES,
  RETRY_BACKOFF_MS,
  attemptDelivery,
  backoffMsForAttempt,
  claimAndAttempt,
  claimDelivery,
  enqueueWebhookDeliveries,
  purgeOldDeliveries,
  selectFairBatch,
  sweepDueDeliveries,
  type DeliveryRow,
} from './queue';

const A = 'acct-a';
const B = 'acct-b';

/** Endpoints de dos cuentas; B va primero para que una consulta sin
 *  `account_id` case con la fila equivocada. */
function seedEndpoints(): Row[] {
  return [
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
      id: 'wh-a',
      account_id: A,
      url: 'https://a.example.com/hook',
      secret: 'enc:secret-a',
      events: ['message.received'],
      is_active: true,
      failure_count: 0,
    },
    {
      id: 'wh-a-off',
      account_id: A,
      url: 'https://off.example.com/hook',
      secret: 'enc:secret-off',
      events: ['message.received'],
      is_active: false,
      failure_count: 0,
    },
    {
      id: 'wh-a-other-event',
      account_id: A,
      url: 'https://other.example.com/hook',
      secret: 'enc:secret-other',
      events: ['conversation.created'],
      is_active: true,
      failure_count: 0,
    },
  ];
}

function makeDb(extra: Record<string, Row[]> = {}) {
  return new FakeDatabase(
    {
      webhook_endpoints: seedEndpoints(),
      webhook_deliveries: [],
      ...extra,
    },
    {
      // Réplica de `record_webhook_failure` (migración 028).
      record_webhook_failure: (args) => {
        const db = fake;
        const row = db
          .rows('webhook_endpoints')
          .find((r) => r.id === args.endpoint_id);
        if (!row) return { data: null, error: null };
        const next = ((row.failure_count as number) ?? 0) + 1;
        row.failure_count = next;
        if (next >= (args.max_failures as number)) row.is_active = false;
        return { data: null, error: null };
      },
    }
  );
}

let fake: FakeDatabase;
let admin: SupabaseClient;

function deliveries(): Row[] {
  return fake.rows('webhook_deliveries');
}

beforeEach(() => {
  fake = makeDb();
  admin = fake.admin as unknown as SupabaseClient;
  vi.mocked(isDeliverableUrl).mockResolvedValue(true);
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('backoffMsForAttempt — escalera de S-A6', () => {
  it('da 1 min, 5 min, 30 min, 2 h y 12 h en ese orden', () => {
    expect(backoffMsForAttempt(1)).toBe(60_000);
    expect(backoffMsForAttempt(2)).toBe(5 * 60_000);
    expect(backoffMsForAttempt(3)).toBe(30 * 60_000);
    expect(backoffMsForAttempt(4)).toBe(2 * 60 * 60_000);
    expect(backoffMsForAttempt(5)).toBe(12 * 60 * 60_000);
  });

  it('se agota tras los cinco reintentos (intento inicial + 5)', () => {
    expect(MAX_ATTEMPTS).toBe(RETRY_BACKOFF_MS.length + 1);
    expect(backoffMsForAttempt(MAX_ATTEMPTS)).toBeNull();
  });
});

describe('enqueueWebhookDeliveries', () => {
  it('encola solo los endpoints activos y suscritos de ESA cuenta', async () => {
    const rows = await enqueueWebhookDeliveries(admin, A, 'message.received', {
      x: 1,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint_id).toBe('wh-a');
    expect(rows[0].account_id).toBe(A);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].attempt).toBe(0);
    // Fuga: el endpoint de la cuenta B no recibe nada.
    expect(deliveries().some((d) => d.endpoint_id === 'wh-b')).toBe(false);
  });

  it('no encola nada cuando nadie escucha el evento', async () => {
    const rows = await enqueueWebhookDeliveries(
      admin,
      A,
      'broadcast.completed',
      {}
    );
    expect(rows).toHaveLength(0);
    expect(deliveries()).toHaveLength(0);
  });

  it('guarda el sobre firmable con id de deduplicación', async () => {
    const [row] = await enqueueWebhookDeliveries(admin, A, 'message.received', {
      hello: 'world',
    });
    expect(row.payload.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.payload.event).toBe('message.received');
    expect(row.payload.account_id).toBe(A);
    expect(row.payload.data).toEqual({ hello: 'world' });
  });
});

describe('attemptDelivery', () => {
  async function enqueueOne(): Promise<DeliveryRow> {
    const [row] = await enqueueWebhookDeliveries(admin, A, 'message.received', {
      x: 1,
    });
    const claimed = await claimDelivery(admin, row);
    if (!claimed) throw new Error('claim failed');
    return claimed;
  }

  it('un 500 deja la entrega failed con next_attempt_at a +1 min', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500 })
    );
    const row = await enqueueOne();
    const before = Date.now();

    const status = await attemptDelivery(admin, row);

    expect(status).toBe('failed');
    const stored = deliveries()[0];
    expect(stored.status).toBe('failed');
    expect(stored.last_status_code).toBe(500);
    const delay = new Date(stored.next_attempt_at as string).getTime() - before;
    expect(delay).toBeGreaterThanOrEqual(59_000);
    expect(delay).toBeLessThanOrEqual(61_000);
    // El fallo cuenta contra la autodesactivación del endpoint (028).
    const endpoint = fake
      .rows('webhook_endpoints')
      .find((r) => r.id === 'wh-a');
    expect(endpoint?.failure_count).toBe(1);
  });

  it('firma el cuerpo exacto y no sigue redirecciones', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const row = await enqueueOne();

    await attemptDelivery(admin, row);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://a.example.com/hook');
    expect(opts.redirect).toBe('manual');
    expect(opts.headers['X-Wacrm-Signature']).toMatch(
      /^t=\d+,v1=[0-9a-f]{64}$/
    );
    expect(opts.headers['X-Wacrm-Delivery-Id']).toBe(row.id);
    expect(opts.headers['X-Wacrm-Attempt']).toBe('1');
    expect(JSON.parse(opts.body)).toEqual(row.payload);
  });

  it('un 200 deja delivered y reinicia la racha de fallos del endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200 })
    );
    fake.rows('webhook_endpoints').find((r) => r.id === 'wh-a')!.failure_count =
      4;
    const row = await enqueueOne();

    expect(await attemptDelivery(admin, row)).toBe('delivered');
    const stored = deliveries()[0];
    expect(stored.status).toBe('delivered');
    expect(stored.delivered_at).toBeTruthy();
    expect(stored.last_status_code).toBe(200);
    expect(
      fake.rows('webhook_endpoints').find((r) => r.id === 'wh-a')?.failure_count
    ).toBe(0);
  });

  it('comprueba SSRF en CADA intento: una URL que pasa a resolver a 10.x no se llama', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const row = await enqueueOne();
    // El alta pasó la guarda; entre el alta y la entrega el DNS cambió.
    vi.mocked(isDeliverableUrl).mockResolvedValue(false);

    expect(await attemptDelivery(admin, row)).toBe('failed');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deliveries()[0].last_error).toMatch(/public address/);
  });

  it('mata la entrega si el endpoint ya no existe (sin gastar reintentos)', async () => {
    const row = await enqueueOne();
    fake.tables.webhook_endpoints = fake
      .rows('webhook_endpoints')
      .filter((r) => r.id !== 'wh-a');

    expect(await attemptDelivery(admin, row)).toBe('dead');
    expect(deliveries()[0].status).toBe('dead');
  });
});

describe('ciclo completo con el barrido del cron', () => {
  it('reintenta lo vencido y, agotada la escalera, lo marca dead', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503 })
    );
    const [row] = await enqueueWebhookDeliveries(
      admin,
      A,
      'message.received',
      {}
    );
    await claimAndAttempt(admin, row);

    // Cada barrido: vencemos la espera a mano (el reloj lo pone la fila).
    for (let i = 2; i <= MAX_ATTEMPTS; i++) {
      deliveries()[0].next_attempt_at = new Date(
        Date.now() - 1000
      ).toISOString();
      const result = await sweepDueDeliveries(admin);
      expect(result.attempted).toBe(1);
      expect(deliveries()[0].attempt).toBe(i);
    }

    expect(deliveries()[0].status).toBe('dead');
    // Una entrega muerta ya no la recoge ningún barrido.
    deliveries()[0].next_attempt_at = new Date(Date.now() - 1000).toISOString();
    expect((await sweepDueDeliveries(admin)).attempted).toBe(0);
  });

  it('un 200 en el tercer intento la deja delivered', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const [row] = await enqueueWebhookDeliveries(
      admin,
      A,
      'message.received',
      {}
    );
    await claimAndAttempt(admin, row);
    expect(deliveries()[0].status).toBe('failed');

    deliveries()[0].next_attempt_at = new Date(Date.now() - 1000).toISOString();
    await sweepDueDeliveries(admin);
    expect(deliveries()[0].status).toBe('failed');

    deliveries()[0].next_attempt_at = new Date(Date.now() - 1000).toISOString();
    await sweepDueDeliveries(admin);

    expect(deliveries()[0].status).toBe('delivered');
    expect(deliveries()[0].attempt).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('el reclamo es exclusivo: dos barridos solapados no entregan dos veces', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200 })
    );
    const [row] = await enqueueWebhookDeliveries(
      admin,
      A,
      'message.received',
      {}
    );

    // Los dos barridos leyeron la MISMA foto de la fila (attempt 0);
    // solo uno puede ganar el UPDATE condicionado.
    const seen = { id: row.id, attempt: row.attempt };
    const first = await claimDelivery(admin, seen);
    const second = await claimDelivery(admin, seen);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });
});

describe('selectFairBatch — cupo por cuenta', () => {
  it('una cuenta con 1 000 pendientes no bloquea a otra con 1', () => {
    const rows = [
      ...Array.from({ length: 1000 }, (_, i) => ({
        id: `a-${i}`,
        account_id: A,
      })),
      { id: 'b-0', account_id: B },
    ];

    const batch = selectFairBatch(rows, { perAccount: 10, total: 100 });

    expect(batch.filter((r) => r.account_id === A)).toHaveLength(10);
    expect(batch.filter((r) => r.account_id === B)).toHaveLength(1);
    // La única de B entra en la primera vuelta, no al final.
    expect(batch[1].id).toBe('b-0');
  });

  it('respeta el tope total del lote', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      id: `x-${i}`,
      account_id: `acct-${i % 5}`,
    }));
    expect(selectFairBatch(rows, { perAccount: 10, total: 7 })).toHaveLength(7);
  });
});

describe('sweepDueDeliveries', () => {
  it('reparte el barrido entre cuentas', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200 })
    );
    const past = new Date(Date.now() - 60_000).toISOString();
    for (let i = 0; i < 30; i++) {
      deliveries().push({
        id: `d-a-${i}`,
        account_id: A,
        endpoint_id: 'wh-a',
        event: 'message.received',
        payload: {
          id: `p-a-${i}`,
          event: 'message.received',
          occurred_at: past,
          account_id: A,
          data: {},
        },
        attempt: 0,
        status: 'pending',
        next_attempt_at: past,
        created_at: past,
      });
    }
    deliveries().push({
      id: 'd-b-0',
      account_id: B,
      endpoint_id: 'wh-b',
      event: 'message.received',
      payload: {
        id: 'p-b-0',
        event: 'message.received',
        occurred_at: past,
        account_id: B,
        data: {},
      },
      attempt: 0,
      status: 'pending',
      next_attempt_at: past,
      created_at: past,
    });

    const result = await sweepDueDeliveries(admin, {
      perAccountLimit: 5,
      batchLimit: 100,
    });

    expect(result.attempted).toBe(6);
    expect(deliveries().find((d) => d.id === 'd-b-0')?.status).toBe(
      'delivered'
    );
    expect(
      deliveries().filter((d) => d.account_id === A && d.status === 'delivered')
    ).toHaveLength(5);
  });

  it('no toca lo que aún no ha vencido', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const future = new Date(Date.now() + 600_000).toISOString();
    deliveries().push({
      id: 'd-future',
      account_id: A,
      endpoint_id: 'wh-a',
      event: 'message.received',
      payload: {
        id: 'p',
        event: 'message.received',
        occurred_at: future,
        account_id: A,
        data: {},
      },
      attempt: 1,
      status: 'failed',
      next_attempt_at: future,
      created_at: new Date().toISOString(),
    });

    expect((await sweepDueDeliveries(admin)).attempted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('purgeOldDeliveries', () => {
  it('borra la bitácora de más de 30 días y respeta la reciente', async () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    deliveries().push(
      {
        id: 'old',
        account_id: A,
        endpoint_id: 'wh-a',
        event: 'x',
        payload: {},
        attempt: 1,
        status: 'delivered',
        next_attempt_at: old,
        created_at: old,
      },
      {
        id: 'recent',
        account_id: A,
        endpoint_id: 'wh-a',
        event: 'x',
        payload: {},
        attempt: 1,
        status: 'delivered',
        next_attempt_at: recent,
        created_at: recent,
      }
    );

    expect(await purgeOldDeliveries(admin)).toBe(1);
    expect(deliveries().map((d) => d.id)).toEqual(['recent']);
  });
});

describe('autodesactivación del endpoint (028) sobre la cola', () => {
  it('sigue disparándose a los 15 fallos consecutivos', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500 })
    );

    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      const [row] = await enqueueWebhookDeliveries(
        admin,
        A,
        'message.received',
        {}
      );
      if (!row) break;
      await claimAndAttempt(admin, row);
    }

    const endpoint = fake
      .rows('webhook_endpoints')
      .find((r) => r.id === 'wh-a');
    expect(endpoint?.failure_count).toBe(MAX_CONSECUTIVE_FAILURES);
    expect(endpoint?.is_active).toBe(false);
  });
});
