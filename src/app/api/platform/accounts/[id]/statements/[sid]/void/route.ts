// ============================================================
// POST /api/platform/accounts/[id]/statements/[sid]/void — «Anular»
// (fase 10, s10.4).
//
// Body: `{ reason }`, at least MIN_REASON_LENGTH characters (the same
// minimum as the rest of the bitácora).
//
// → statement `void`, and the subscription settles exactly as on a
// confirmed payment: `active`, `grace_until = NULL`, the period extended
// one month from the statement's `period_end`. Bitácora
// `statement_void` BEFORE the act. 409 when the statement is no longer
// open.
// ============================================================

import { MIN_REASON_LENGTH } from '@/lib/platform/audit';

import { badRequest, handleSettle } from '../../settle';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; sid: string }> }
) {
  return handleSettle(
    request,
    context,
    '/api/platform/accounts/[id]/statements/[sid]/void',
    (body) => {
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (reason.length < MIN_REASON_LENGTH) {
        return badRequest(
          `reason is required and must be at least ${MIN_REASON_LENGTH} characters`
        );
      }
      return { kind: 'void', reason };
    }
  );
}
