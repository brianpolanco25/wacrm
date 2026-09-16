// ============================================================
// GET /api/webhooks/cron — drena la cola de entregas de webhook.
//
// Mismo patrón que `/api/automations/cron`: secreto compartido en
// `x-cron-secret` comparado en tiempo constante, pensado para un
// programador externo (Vercel Cron, un pinger, un `curl` en un
// systemd timer). Sin `WEBHOOK_CRON_SECRET` la ruta responde 503 en
// vez de quedarse abierta.
//
// Cada barrido:
//   1. reparte el lote entre cuentas (cupo por cuenta, fase 5 §3) para
//      que una cuenta con mil pendientes no deje a la de al lado sin
//      su única entrega;
//   2. reclama cada fila con un candado optimista sobre `attempt`, así
//      que dos barridos solapados no entregan lo mismo dos veces;
//   3. purga la bitácora de más de 30 días (S-A6);
//   4. retoma los encargos de exportación que se quedaron a medias y
//      purga los caducados (fase 7 §5). Van con CUPO APARTE: construir
//      un export cuesta órdenes de magnitud más que un POST a un
//      receptor, y compartir lote significaría que una cuenta
//      exportando su historial retrasa las notificaciones de todas las
//      demás.
//
// La frecuencia recomendada es un minuto: es el primer peldaño de la
// escalera de reintentos.
// ============================================================

import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { purgeOldDeliveries, sweepDueDeliveries } from '@/lib/webhooks/queue';
import { purgeExpiredExports, sweepExportJobs } from '@/lib/exports/jobs';

function secretMatches(supplied: string, expected: string): boolean {
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  if (suppliedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(suppliedBuf, expectedBuf);
}

export async function GET(request: Request) {
  const expected = process.env.WEBHOOK_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }

  const supplied = request.headers.get('x-cron-secret') ?? '';
  if (!secretMatches(supplied, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = supabaseAdmin();

  // El barrido no lanza: devuelve lo que consiguió hacer.
  const swept = await sweepDueDeliveries(admin);

  // La purga va después del barrido para no borrar bajo los pies de un
  // intento en curso, y su fallo no invalida el barrido.
  const purged = await purgeOldDeliveries(admin);

  // Fase 7 §5. Ninguno de los dos lanza; el bloque `exports` es
  // aditivo para que un cliente del cron que solo miraba las entregas
  // siga leyendo lo mismo que antes.
  const exportSweep = await sweepExportJobs(admin);
  const exportsPurged = await purgeExpiredExports(admin);

  return NextResponse.json({
    ...swept,
    purged,
    exports: { ...exportSweep, purged: exportsPurged },
  });
}
