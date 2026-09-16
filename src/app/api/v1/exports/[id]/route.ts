// ============================================================
// GET /api/v1/exports/{id} — estado de un encargo y, cuando está
// `done`, el enlace de descarga (scope: conversations:export).
//
// `download_url` se ACUÑA en cada llamada y vive 15 minutos. No está
// guardada en ningún sitio: la fila solo tiene la ruta del objeto
// dentro de un bucket privado que únicamente el rol de servicio lee.
// Una URL firmada es una credencial al portador; persistirla sería
// dejarla con la vida del registro y no con la de la firma, en una
// tabla que cualquier miembro de la cuenta puede consultar.
//
// Un id de otra cuenta (o inventado) → 404, nunca 403 (CP3).
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  EXPORT_JOB_PUBLIC_COLUMNS,
  serializeExportJob,
  signExportDownload,
} from '@/lib/exports/jobs';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'conversations:export');
    const { id } = await params;

    const { data, error } = await ctx.supabase
      .from('export_jobs')
      // `file_path` se pide aparte de las columnas públicas: hace falta
      // para firmar, y NO se devuelve.
      .select(`${EXPORT_JOB_PUBLIC_COLUMNS}, file_path`)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (error) {
      console.error('[api/v1/exports] read error:', error);
      return fail('internal', 'Failed to read the export', 500);
    }
    if (!data) return fail('not_found', 'Export not found', 404);

    const row = data as Record<string, unknown>;
    const job = serializeExportJob(row);

    const filePath = typeof row.file_path === 'string' ? row.file_path : null;
    if (job.status !== 'done' || !filePath) {
      return ok({ ...job, download_url: null, download_expires_at: null });
    }

    const signed = await signExportDownload(ctx.supabase, filePath);
    if (!signed) {
      return fail('internal', 'Failed to sign the download link', 500);
    }

    return ok({
      ...job,
      download_url: signed.url,
      download_expires_at: signed.expiresAt,
    });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
