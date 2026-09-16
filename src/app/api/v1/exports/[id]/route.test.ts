import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { FakeDatabase, type Row } from '@/lib/security/fake-supabase';

const h = vi.hoisted(() => ({ requireApiKey: vi.fn() }));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: (...args: unknown[]) =>
    (h.requireApiKey as unknown as (...a: unknown[]) => unknown)(...args),
}));

import { DOWNLOAD_URL_TTL_SECONDS } from '@/lib/exports/jobs';
import { GET } from './route';

const A = 'acct-a';
const B = 'acct-b';
const NOW = new Date('2026-09-16T12:00:00.000Z');

function job(over: Partial<Row> & { id: string }): Row {
  return {
    account_id: A,
    api_key_id: 'key-a',
    kind: 'conversations',
    params: { status: 'closed' },
    format: 'json',
    status: 'done',
    row_count: 42,
    file_path: `${A}/${over.id}.json`,
    error: null,
    created_at: '2026-09-16T11:00:00.000Z',
    started_at: '2026-09-16T11:00:01.000Z',
    finished_at: '2026-09-16T11:00:05.000Z',
    expires_at: '2026-09-23T11:00:00.000Z',
    ...over,
  };
}

let db: FakeDatabase;

function req(id: string) {
  return new Request(`https://crm.example.com/api/v1/exports/${id}`, {
    headers: { authorization: 'Bearer wacrm_live_x' },
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db = new FakeDatabase({
    export_jobs: [
      job({ id: 'job-b', account_id: B, file_path: `${B}/job-b.json` }),
      job({ id: 'job-a' }),
      job({
        id: 'job-queued',
        status: 'queued',
        file_path: null,
        row_count: null,
        started_at: null,
        finished_at: null,
      }),
      job({
        id: 'job-failed',
        status: 'failed',
        file_path: null,
        row_count: null,
        error: 'This export exceeds 250,000 messages.',
      }),
    ],
  });
  h.requireApiKey.mockReset();
  h.requireApiKey.mockResolvedValue({
    authType: 'api_key',
    supabase: db.admin as unknown as SupabaseClient,
    accountId: A,
    keyId: 'key-a',
    scopes: ['conversations:export'],
    createdBy: 'user-a',
  });
});

describe('GET /api/v1/exports/{id}', () => {
  it('exige el scope conversations:export', async () => {
    await GET(req('job-a'), params('job-a'));
    expect(h.requireApiKey.mock.calls[0][1]).toBe('conversations:export');
  });

  it('done: URL firmada de 15 minutos, acuñada ahora y no guardada', async () => {
    const res = await GET(req('job-a'), params('job-a'));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data.download_url).toContain('/sign/exports/acct-a/job-a.json');
    expect(body.data.download_expires_at).toBe(
      new Date(NOW.getTime() + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString()
    );
    // 15 minutos, ni uno más.
    expect(Date.parse(body.data.download_expires_at) - NOW.getTime()).toBe(
      15 * 60 * 1000
    );

    // La URL no vive en la fila: solo la ruta del objeto.
    const row = db.rows('export_jobs').find((r) => r.id === 'job-a');
    expect(JSON.stringify(row)).not.toContain('token=');
    expect(JSON.stringify(row)).not.toContain('signedUrl');
    expect(row?.file_path).toBe('acct-a/job-a.json');
  });

  it('cada llamada acuña una firma nueva y no reutiliza la anterior', async () => {
    const first = await (await GET(req('job-a'), params('job-a'))).json();
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    const second = await (await GET(req('job-a'), params('job-a'))).json();
    expect(second.data.download_expires_at).not.toBe(
      first.data.download_expires_at
    );
    expect(Date.parse(second.data.download_expires_at)).toBeGreaterThan(
      Date.parse(first.data.download_expires_at)
    );
  });

  it('la ruta dentro del bucket nunca sale en la respuesta', async () => {
    const body = await (await GET(req('job-a'), params('job-a'))).json();
    expect(body.data).not.toHaveProperty('file_path');
    expect(body.data).not.toHaveProperty('account_id');
    expect(body.data.row_count).toBe(42);
    expect(body.data.filters).toEqual({ status: 'closed' });
  });

  it('queued: estado sin enlace', async () => {
    const body = await (
      await GET(req('job-queued'), params('job-queued'))
    ).json();
    expect(body.data.status).toBe('queued');
    expect(body.data.download_url).toBeNull();
    expect(body.data.download_expires_at).toBeNull();
  });

  it('failed: el motivo publicable y ningún enlace', async () => {
    const body = await (
      await GET(req('job-failed'), params('job-failed'))
    ).json();
    expect(body.data.status).toBe('failed');
    expect(body.data.error).toContain('250,000 messages');
    expect(body.data.download_url).toBeNull();
  });

  it('un encargo de otra cuenta es 404, y no se firma nada suyo', async () => {
    const res = await GET(req('job-b'), params('job-b'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('not_found');
    expect(JSON.stringify(body)).not.toContain('acct-b');
  });

  it('un id inexistente también es 404', async () => {
    const res = await GET(req('job-x'), params('job-x'));
    expect(res.status).toBe(404);
  });

  it('un fallo al firmar no devuelve un enlace roto: 500', async () => {
    h.requireApiKey.mockResolvedValue({
      authType: 'api_key',
      supabase: {
        from: (t: string) => db.admin.from(t),
        storage: {
          from: () => ({
            createSignedUrl: async () => ({
              data: null,
              error: { message: 'nope' },
            }),
          }),
        },
      } as unknown as SupabaseClient,
      accountId: A,
      keyId: 'key-a',
      scopes: ['conversations:export'],
      createdBy: 'user-a',
    });
    const res = await GET(req('job-a'), params('job-a'));
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('internal');
  });
});
