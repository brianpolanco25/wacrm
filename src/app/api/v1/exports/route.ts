// ============================================================
// GET  /api/v1/exports — lista de encargos de exportación
// POST /api/v1/exports — encarga uno        (scope: conversations:export)
//
// El camino asíncrono de la fase 7 §5: lo que no cabe en una respuesta
// HTTP (todas las conversaciones cerradas del último año) se acepta con
// un 202, se construye aparte y se entrega como archivo firmado desde
// `GET /api/v1/exports/{id}`.
//
// El primer intento corre en `after()`, es decir, después de que el 202
// haya salido: el cliente no espera a que se construya nada. Si ese
// proceso muere, el barrido del cron lo retoma (ver
// `src/lib/exports/jobs.ts`), así que un encargo aceptado no se pierde
// aunque nadie vuelva a llamar.
//
// `withIdempotency`: reintentar un POST con la misma `Idempotency-Key`
// devuelve el MISMO job en vez de encolar un segundo export idéntico
// —que es trabajo caro duplicado y un archivo de más en el bucket.
// ============================================================

import { after } from 'next/server';

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { withIdempotency } from '@/lib/api/v1/idempotency';
import {
  buildPage,
  keysetFilter,
  parseListParams,
} from '@/lib/api/v1/pagination';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { isExportFormat } from '@/lib/exports/conversations';
import {
  EXPORT_JOB_PUBLIC_COLUMNS,
  createExportJob,
  isExportKind,
  parseExportFilters,
  processExportJob,
  serializeExportJob,
} from '@/lib/exports/jobs';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'conversations:export');
    const { limit, cursor } = parseListParams(request);

    let query = ctx.supabase
      .from('export_jobs')
      .select(EXPORT_JOB_PUBLIC_COLUMNS)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/exports] list error:', error);
      return fail('internal', 'Failed to list exports', 500);
    }

    const { items, nextCursor } = buildPage(
      (data ?? []) as unknown as Array<{ created_at: string; id: string }>,
      limit
    );
    return okList(
      items.map((row) => serializeExportJob(row as Record<string, unknown>)),
      nextCursor
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'conversations:export');

    return await withIdempotency(ctx, request, async (body) => {
      const kind = body.kind ?? 'conversations';
      if (!isExportKind(kind)) {
        return fail('bad_request', "'kind' must be 'conversations'", 400);
      }

      const format = body.format ?? 'json';
      if (!isExportFormat(format)) {
        return fail('bad_request', "'format' must be 'json' or 'csv'", 400);
      }

      // Lanza `bad_request` nombrando el campo; lo mapea el catch.
      const filters = parseExportFilters(body.filters);

      // Cubo propio por CUENTA (S-A7). Después de validar, para que un
      // cuerpo mal formado no gaste una de las diez del cliente.
      const limit = checkRateLimit(
        `exports:${ctx.accountId}`,
        RATE_LIMITS.exports
      );
      if (!limit.success) {
        return fail(
          'rate_limited',
          'Too many exports for this account; try again later',
          429,
          {
            'Retry-After': String(
              Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000))
            ),
          }
        );
      }

      const created = await createExportJob(ctx.supabase, {
        accountId: ctx.accountId,
        apiKeyId: ctx.keyId,
        kind,
        format,
        filters,
      });
      if (!created) {
        return fail('internal', 'Failed to create the export', 500);
      }

      const job = serializeExportJob(created);

      // Tras el 202. Nada de lo que pase aquí puede tumbar la petición:
      // `processExportJob` no lanza y deja el job en `failed` con un
      // motivo publicable si algo sale mal.
      after(async () => {
        try {
          await processExportJob(ctx.supabase, {
            id: job.id,
            account_id: ctx.accountId,
            status: 'queued',
            started_at: null,
          });
        } catch (err) {
          // Una excepción aquí sería invisible: el barrido lo retomará
          // cuando el job pase a huérfano.
          console.error('[api/v1/exports] processing threw:', err);
        }
      });

      return ok(job, 202);
    });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
