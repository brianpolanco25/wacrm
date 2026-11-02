// ============================================================
// GET /api/whatsapp/coexistence/cron — drena los lotes de coexistencia
// (historial y libreta del teléfono, migración 089, #1651) que el
// webhook no terminó dentro de su `after()`.
//
// Mismo patrón que `/api/automations/cron`: secreto compartido en
// `x-cron-secret` contra `AUTOMATION_CRON_SECRET`, comparado en tiempo
// constante; sin la variable responde 503 en vez de quedarse abierta.
// Cada llamada reclama los lotes `pending` (o `processing` con el
// candado vencido) más antiguos y los procesa con un plazo de 45 s.
// Se programa a mano en Dokploy, cada 5 minutos.
// ============================================================

import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  DRAIN_BUDGET_MS,
  DRAIN_SWEEP_LIMIT,
  drainCoexistenceBatches,
} from '@/lib/whatsapp/coexistence-batches';

export const maxDuration = 60;

function secretMatches(supplied: string, expected: string): boolean {
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  if (suppliedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(suppliedBuf, expectedBuf);
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
  const supplied = request.headers.get('x-cron-secret') ?? '';
  if (!secretMatches(supplied, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await drainCoexistenceBatches(supabaseAdmin(), {
    deadline: startedAt + DRAIN_BUDGET_MS,
    limit: DRAIN_SWEEP_LIMIT,
  });
  console.log('[coexistence-cron] drained:', JSON.stringify(result));
  return NextResponse.json(result, { status: 200 });
}
