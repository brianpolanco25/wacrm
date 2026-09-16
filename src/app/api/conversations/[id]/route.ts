// ============================================================
// PATCH /api/conversations/{id} — cerrar/reabrir y asignar desde el panel.
//
// La bandeja escribía estos dos campos directamente contra Supabase
// desde el navegador. Funcionaba (la RLS de la 017 exige `agent`+ para
// actualizar `conversations`), pero dejaba fuera al servidor, y la fase
// 7 §4 necesita que cerrar o reasignar un chat DESDE EL PANEL dispare
// su webhook igual que si lo hiciera la API. Por eso pasa por aquí.
//
// Se conserva el mismo modelo de permisos: sesión de cookie, cliente
// con RLS y `requireRole('agent')`. No se gana ni se pierde acceso;
// solo hay un servidor en medio que puede emitir el evento.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  assignConversation,
  setConversationStatus,
} from '@/lib/conversations/status-events';
import type { ConversationStatus } from '@/types';

const STATUSES: ConversationStatus[] = ['open', 'pending', 'closed'];

function isStatus(value: unknown): value is ConversationStatus {
  return (
    typeof value === 'string' && (STATUSES as readonly string[]).includes(value)
  );
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await params;

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Request body must be a JSON object' },
        { status: 400 }
      );
    }

    const scope = {
      db: ctx.supabase,
      accountId: ctx.accountId,
      conversationId: id,
    };
    let touched = false;

    if ('status' in body) {
      if (!isStatus(body.status)) {
        return NextResponse.json(
          { error: "'status' must be one of open, pending, closed" },
          { status: 400 }
        );
      }
      if (!(await setConversationStatus(scope, body.status))) {
        return NextResponse.json(
          { error: 'Conversation not found' },
          { status: 404 }
        );
      }
      touched = true;
    }

    if ('assigned_agent_id' in body) {
      const agentId = body.assigned_agent_id;
      if (agentId !== null && typeof agentId !== 'string') {
        return NextResponse.json(
          { error: "'assigned_agent_id' must be a string or null" },
          { status: 400 }
        );
      }
      if (!(await assignConversation(scope, agentId))) {
        return NextResponse.json(
          { error: 'Conversation not found' },
          { status: 404 }
        );
      }
      touched = true;
    }

    if (!touched) {
      return NextResponse.json(
        { error: 'No updatable fields provided' },
        { status: 400 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
