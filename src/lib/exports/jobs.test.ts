import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { ApiError } from '@/lib/api/v1/respond';
import { FakeDatabase, type Row } from '@/lib/security/fake-supabase';
import {
  DOWNLOAD_URL_TTL_SECONDS,
  EXPORTS_BUCKET,
  EXPORT_RETENTION_DAYS,
  claimExportJob,
  createExportJob,
  exportObjectPath,
  filtersFromParams,
  isExportKind,
  parseExportFilters,
  processExportJob,
  purgeExpiredExports,
  runExportJob,
  serializeExportJob,
  signExportDownload,
  sweepExportJobs,
} from './jobs';

const A = 'acct-a';
const B = 'acct-b';
const NOW = new Date('2026-09-16T12:00:00.000Z');

function conversationRows(): Row[] {
  return [
    {
      id: 'conv-b',
      account_id: B,
      contact_id: 'contact-b',
      status: 'open',
      unread_count: 0,
      created_at: '2025-12-31T00:00:00.000Z',
      updated_at: '2025-12-31T00:00:00.000Z',
    },
    {
      id: 'conv-a',
      account_id: A,
      contact_id: 'contact-a',
      status: 'open',
      unread_count: 0,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
  ];
}

function messageRows(): Row[] {
  return [
    {
      id: 'msg-b',
      conversation_id: 'conv-b',
      sender_type: 'customer',
      content_type: 'text',
      content_text: 'secreto de B',
      status: 'delivered',
      created_at: '2025-12-31T00:00:00.000Z',
    },
    {
      id: 'msg-a',
      conversation_id: 'conv-a',
      sender_type: 'customer',
      content_type: 'text',
      content_text: 'hola desde A',
      status: 'delivered',
      created_at: '2026-01-01T00:00:00.000Z',
    },
  ];
}

function seed(jobs: Row[] = []): FakeDatabase {
  return new FakeDatabase({
    conversations: conversationRows(),
    contacts: [
      { id: 'contact-b', account_id: B, phone: '+34600000002', name: 'B' },
      { id: 'contact-a', account_id: A, phone: '+34600000001', name: 'A' },
    ],
    messages: messageRows(),
    export_jobs: jobs,
  });
}

/** Cliente de rol de servicio con el `remove` del bucket observable. */
function client(db: FakeDatabase): {
  supabase: SupabaseClient;
  removed: string[][];
} {
  const removed: string[][] = [];
  const supabase = {
    from: (table: string) => db.admin.from(table),
    storage: {
      from: (bucket: string) => {
        const real = db.admin.storage.from(bucket);
        return {
          ...real,
          remove: async (paths: string[]) => {
            removed.push(paths);
            return real.remove();
          },
        };
      },
    },
  } as unknown as SupabaseClient;
  return { supabase, removed };
}

function job(over: Partial<Row> & { id: string }): Row {
  return {
    account_id: A,
    api_key_id: 'key-a',
    kind: 'conversations',
    params: {},
    format: 'json',
    status: 'queued',
    row_count: null,
    file_path: null,
    error: null,
    created_at: '2026-09-16T11:00:00.000Z',
    started_at: null,
    finished_at: null,
    expires_at: '2026-09-23T11:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

describe('parseExportFilters', () => {
  it('sin filtros es un objeto vacío', () => {
    expect(parseExportFilters(undefined)).toEqual({});
    expect(parseExportFilters(null)).toEqual({});
  });

  it('acepta los cuatro de la spec y normaliza las fechas a ISO', () => {
    expect(
      parseExportFilters({
        status: ' closed ',
        contact_id: 'contact-a',
        from: '2026-01-01',
        to: '2026-02-01T10:00:00Z',
      })
    ).toEqual({
      status: 'closed',
      contact_id: 'contact-a',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T10:00:00.000Z',
    });
  });

  it('ignora lo que no conoce — incluido account_id', () => {
    const out = parseExportFilters({
      account_id: B,
      status: 'open',
      nope: 1,
    });
    expect(out).toEqual({ status: 'open' });
    expect(out).not.toHaveProperty('account_id');
  });

  it('un tipo equivocado es bad_request y nombra el campo', () => {
    for (const [bad, field] of [
      [{ status: 7 }, 'filters.status'],
      [{ contact_id: '' }, 'filters.contact_id'],
      [{ from: 'ayer' }, 'filters.from'],
      [{ to: 12 }, 'filters.to'],
    ] as const) {
      try {
        parseExportFilters(bad);
        throw new Error('debería haber lanzado');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(400);
        expect((err as ApiError).message).toContain(field);
      }
    }
  });

  it('`filters` que no es un objeto también es bad_request', () => {
    expect(() => parseExportFilters([])).toThrow(ApiError);
    expect(() => parseExportFilters('todo')).toThrow(ApiError);
  });

  it('`kind` solo admite conversations', () => {
    expect(isExportKind('conversations')).toBe(true);
    expect(isExportKind('contacts')).toBe(false);
  });

  it('filtersFromParams reconstruye la consulta y descarta lo que no sea texto', () => {
    expect(
      filtersFromParams({ status: 'closed', contact_id: 1, from: null })
    ).toEqual({
      status: 'closed',
      contactId: undefined,
      from: undefined,
      to: undefined,
    });
  });
});

describe('serializeExportJob', () => {
  it('no publica file_path ni account_id', () => {
    const out = serializeExportJob(
      job({ id: 'job-1', file_path: 'acct-a/job-1.json', status: 'done' })
    );
    expect(out).not.toHaveProperty('file_path');
    expect(out).not.toHaveProperty('account_id');
    expect(out).not.toHaveProperty('api_key_id');
    expect(out.status).toBe('done');
    expect(out.filters).toEqual({});
  });
});

describe('alta y reclamo', () => {
  it('createExportJob escribe account_id y deja el encargo en queued', async () => {
    const db = seed();
    const created = await createExportJob(client(db).supabase, {
      accountId: A,
      apiKeyId: 'key-a',
      kind: 'conversations',
      format: 'csv',
      filters: { status: 'closed' },
    });
    expect(created).not.toBeNull();
    const row = db.rows('export_jobs')[0];
    expect(row.account_id).toBe(A);
    expect(row.status).toBe('queued');
    expect(row.params).toEqual({ status: 'closed' });
  });

  it('dos reclamos del mismo encargo: solo uno gana', async () => {
    const db = seed([job({ id: 'job-1' })]);
    const { supabase } = client(db);
    const first = await claimExportJob(supabase, {
      id: 'job-1',
      account_id: A,
      status: 'queued',
      started_at: null,
    });
    const second = await claimExportJob(supabase, {
      id: 'job-1',
      account_id: A,
      status: 'queued',
      started_at: null,
    });
    expect(first?.id).toBe('job-1');
    expect(second).toBeNull();
    expect(db.rows('export_jobs')[0].started_at).toBe(NOW.toISOString());
  });

  it('reclamar nombrando otra cuenta no toca la fila (fuga)', async () => {
    const db = seed([job({ id: 'job-a' })]);
    const claimed = await claimExportJob(client(db).supabase, {
      id: 'job-a',
      account_id: B,
      status: 'queued',
      started_at: null,
    });
    expect(claimed).toBeNull();
    expect(db.rows('export_jobs')[0].status).toBe('queued');
  });
});

describe('construcción', () => {
  it('sube el archivo al bucket privado y cierra el encargo en done', async () => {
    const db = seed([job({ id: 'job-1', format: 'csv' })]);
    const { supabase } = client(db);
    const status = await processExportJob(supabase, {
      id: 'job-1',
      account_id: A,
      status: 'queued',
      started_at: null,
    });

    expect(status).toBe('done');
    expect(db.storageObjects).toEqual([
      { bucket: EXPORTS_BUCKET, path: 'acct-a/job-1.csv' },
    ]);
    const row = db.rows('export_jobs')[0];
    expect(row.status).toBe('done');
    expect(row.file_path).toBe('acct-a/job-1.csv');
    expect(row.row_count).toBe(1);
    expect(row.finished_at).toBe(NOW.toISOString());
    // La fila guarda una RUTA, nunca una URL (ni firmada ni pública).
    expect(String(row.file_path)).not.toContain('http');
  });

  it('el archivo solo contiene lo de su cuenta', async () => {
    const db = seed([job({ id: 'job-1' })]);
    const uploaded: string[] = [];
    const supabase = {
      from: (t: string) => db.admin.from(t),
      storage: {
        from: () => ({
          upload: async (_path: string, body: string) => {
            uploaded.push(body);
            return { data: { path: _path }, error: null };
          },
        }),
      },
    } as unknown as SupabaseClient;

    await processExportJob(supabase, {
      id: 'job-1',
      account_id: A,
      status: 'queued',
      started_at: null,
    });
    expect(uploaded[0]).toContain('hola desde A');
    expect(uploaded[0]).not.toContain('secreto de B');
    expect(uploaded[0]).not.toContain('conv-b');
  });

  it('un fallo de Storage deja failed con un motivo publicable, sin detalle interno', async () => {
    const db = seed([job({ id: 'job-1' })]);
    const supabase = {
      from: (t: string) => db.admin.from(t),
      storage: {
        from: () => ({
          upload: async () => ({
            data: null,
            error: { message: 'relation "storage.objects" denied at /var/run' },
          }),
        }),
      },
    } as unknown as SupabaseClient;

    const status = await processExportJob(supabase, {
      id: 'job-1',
      account_id: A,
      status: 'queued',
      started_at: null,
    });
    expect(status).toBe('failed');
    const row = db.rows('export_jobs')[0];
    expect(row.status).toBe('failed');
    expect(row.error).toBe('Could not store the export file');
    expect(String(row.error)).not.toContain('/var/run');
  });

  it('un kind desconocido falla en vez de exportar cualquier cosa', async () => {
    const db = seed([job({ id: 'job-1', kind: 'contacts' })]);
    const status = await runExportJob(client(db).supabase, {
      id: 'job-1',
      account_id: A,
      kind: 'contacts',
      format: 'json',
      status: 'running',
      params: {},
    });
    expect(status).toBe('failed');
    expect(db.rows('export_jobs')[0].error).toContain('contacts');
    expect(db.storageObjects).toHaveLength(0);
  });

  it('la ruta del objeto empieza por la cuenta', () => {
    expect(
      exportObjectPath({ id: 'job-1', account_id: A, format: 'csv' })
    ).toBe('acct-a/job-1.csv');
  });
});

describe('descarga firmada', () => {
  it('acuña una URL de 15 minutos y no escribe nada en la fila', async () => {
    const db = seed([
      job({ id: 'job-1', status: 'done', file_path: 'acct-a/job-1.json' }),
    ]);
    const before = db.log.length;
    const signed = await signExportDownload(
      client(db).supabase,
      'acct-a/job-1.json'
    );
    expect(signed?.url).toContain(`/sign/${EXPORTS_BUCKET}/acct-a/job-1.json`);
    expect(signed?.expiresAt).toBe(
      new Date(NOW.getTime() + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString()
    );
    expect(DOWNLOAD_URL_TTL_SECONDS).toBe(900);
    // Firmar no es una escritura: la URL no se persiste en ningún sitio.
    expect(db.log.slice(before)).toHaveLength(0);
    expect(JSON.stringify(db.rows('export_jobs'))).not.toContain('token=');
  });
});

describe('barrido del cron (cupo aparte)', () => {
  it('retoma lo que quedó en queued y lo que murió en running', async () => {
    const stale = new Date(NOW.getTime() - 30 * 60_000).toISOString();
    const db = seed([
      job({ id: 'job-queued' }),
      job({ id: 'job-stale', status: 'running', started_at: stale }),
    ]);
    // Cupo por cuenta al alza a propósito: aquí se mira QUÉ se retoma,
    // no cuánto (el reparto por cuenta tiene su propio test).
    const out = await sweepExportJobs(client(db).supabase, {
      perAccountLimit: 2,
    });
    expect(out.scanned).toBe(2);
    expect(out.processed).toBe(2);
    expect(out.done).toBe(2);
    expect(db.rows('export_jobs').every((r) => r.status === 'done')).toBe(true);
  });

  it('no le quita el trabajo a un running reciente', async () => {
    const fresh = new Date(NOW.getTime() - 30_000).toISOString();
    const db = seed([
      job({ id: 'job-running', status: 'running', started_at: fresh }),
    ]);
    const out = await sweepExportJobs(client(db).supabase);
    expect(out.scanned).toBe(0);
    expect(out.processed).toBe(0);
    expect(db.rows('export_jobs')[0].status).toBe('running');
  });

  it('un encargo por cuenta y barrido: la cuenta con dos no ahoga a la de al lado', async () => {
    const db = seed([
      job({ id: 'job-a1' }),
      job({ id: 'job-a2', created_at: '2026-09-16T11:30:00.000Z' }),
      job({ id: 'job-b1', account_id: B }),
    ]);
    const out = await sweepExportJobs(client(db).supabase);
    expect(out.processed).toBe(2);
    const done = db
      .rows('export_jobs')
      .filter((r) => r.status === 'done')
      .map((r) => r.id);
    expect(done).toEqual(['job-a1', 'job-b1']);
  });

  it('respeta el tope del lote', async () => {
    const db = seed([
      job({ id: 'job-1' }),
      job({ id: 'job-2', account_id: B }),
      job({ id: 'job-3', account_id: 'acct-c' }),
    ]);
    const out = await sweepExportJobs(client(db).supabase, { batchLimit: 1 });
    expect(out.processed).toBe(1);
  });

  it('un fallo de lectura no lanza: el cron sigue vivo', async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          in: () => ({
            order: () => ({
              limit: async () => ({ data: null, error: { message: 'boom' } }),
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;
    await expect(sweepExportJobs(supabase)).resolves.toEqual({
      scanned: 0,
      processed: 0,
      done: 0,
      failed: 0,
      skipped: 0,
    });
  });
});

describe('purga a los 7 días (S-A6)', () => {
  it('borra primero el archivo y después la fila, y solo lo caducado', async () => {
    const db = seed([
      job({
        id: 'job-old',
        status: 'done',
        file_path: 'acct-a/job-old.json',
        expires_at: '2026-09-09T00:00:00.000Z',
      }),
      job({
        id: 'job-live',
        status: 'done',
        file_path: 'acct-a/job-live.json',
        expires_at: '2026-09-30T00:00:00.000Z',
      }),
    ]);
    const { supabase, removed } = client(db);
    await expect(purgeExpiredExports(supabase)).resolves.toBe(1);
    expect(removed).toEqual([['acct-a/job-old.json']]);
    expect(db.rows('export_jobs').map((r) => r.id)).toEqual(['job-live']);
  });

  it('si el borrado del archivo falla, la fila sobrevive para el siguiente barrido', async () => {
    const db = seed([
      job({
        id: 'job-old',
        status: 'done',
        file_path: 'acct-a/job-old.json',
        expires_at: '2026-09-09T00:00:00.000Z',
      }),
    ]);
    const supabase = {
      from: (t: string) => db.admin.from(t),
      storage: {
        from: () => ({
          remove: async () => ({ data: null, error: { message: 'nope' } }),
        }),
      },
    } as unknown as SupabaseClient;
    await expect(purgeExpiredExports(supabase)).resolves.toBe(0);
    expect(db.rows('export_jobs')).toHaveLength(1);
  });

  it('la retención es la de la spec', () => {
    expect(EXPORT_RETENTION_DAYS).toBe(7);
  });
});
