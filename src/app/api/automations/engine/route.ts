import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  runAutomationsForTrigger,
  type AutomationContext,
} from '@/lib/automations/engine'
import type { AutomationTriggerType } from '@/types'

/**
 * Manual trigger for testing or for external integrations that want
 * to fire automations. Auth is required — we resolve the caller's
 * account_id and dispatch over the account's automations.
 */
export async function POST(request: Request) {
  // Firing automations sends outbound WhatsApp — a write action. Require
  // at least `agent`; a viewer must not be able to trigger sends.
  let accountId: string
  try {
    const ctx = await requireRole('agent')
    accountId = ctx.accountId
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body?.trigger_type) {
    return NextResponse.json({ error: 'trigger_type required' }, { status: 400 })
  }

  // `inbound_message_id` is not caller input: it keys the per-message
  // reservation that decides who answers a customer message (migration
  // 051), and the engine takes that reservation through the service-role
  // client. A forged id would let this account reserve ANOTHER account's
  // inbound and silence that account's AI reply for it. The only
  // legitimate source is the webhook that just stored the message.
  const context: AutomationContext = {
    ...((body.context ?? {}) as AutomationContext),
  }
  delete context.inbound_message_id

  await runAutomationsForTrigger({
    accountId,
    triggerType: body.trigger_type as AutomationTriggerType,
    contactId: body.contact_id ?? null,
    context,
  })

  return NextResponse.json({ ok: true })
}
