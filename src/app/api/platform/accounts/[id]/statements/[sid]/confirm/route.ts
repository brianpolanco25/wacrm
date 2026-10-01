// ============================================================
// POST /api/platform/accounts/[id]/statements/[sid]/confirm — «Confirmar
// pago» (fase 10, s10.4).
//
// Body: `{ paidAt?, reference?, note? }`. No reason: the payment is the
// reason. `paidAt` is a date (`YYYY-MM-DD`) or an ISO instant, not in
// the future; it defaults to now.
//
// → statement `paid`; subscription `active`, `grace_until = NULL`, and
// `current_period_end` one month after the statement's `period_end`
// (paying late does not move the cut-off). Bitácora `payment_confirmed`
// BEFORE the act. 409 when the statement is no longer open.
// ============================================================

import { NextResponse } from 'next/server';

import {
  handleSettle,
  MAX_NOTE,
  MAX_REFERENCE,
  optionalText,
  parsePaidAt,
} from '../../settle';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; sid: string }> }
) {
  return handleSettle(
    request,
    context,
    '/api/platform/accounts/[id]/statements/[sid]/confirm',
    (body) => {
      const paidAt = parsePaidAt(body.paidAt);
      if (paidAt instanceof NextResponse) return paidAt;
      const reference = optionalText(
        body.reference,
        MAX_REFERENCE,
        'reference'
      );
      if (reference instanceof NextResponse) return reference;
      const note = optionalText(body.note, MAX_NOTE, 'note');
      if (note instanceof NextResponse) return note;
      return { kind: 'confirm', paidAt, reference, note };
    }
  );
}
