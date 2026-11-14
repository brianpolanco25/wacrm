// ============================================================
// Efecto de pausar / reanudar la IA de una conversación.
//
// Lo comparten el panel (`POST /api/ai/autoreply/{conversationId}`, el
// banner «Take over» / «Resume AI») y la API pública
// (`PATCH /api/v1/conversations/{id}` con `ai_autoreply_disabled`), para
// que las dos hagan exactamente lo mismo.
//
//   paused: true  → la IA calla en este hilo (una persona lo toma). Con
//                   `assignTo`, además se asigna a esa persona.
//   paused: false → se devuelve el hilo al bot: sin pausa, sin asignado
//                   (la IA se retira mientras haya una persona asignada,
//                   así que dejarlo dejaría «Resume AI» sin efecto), con
//                   presupuesto de respuestas nuevo y sin nota de traspaso.
//                   Es una acción manual y con límite de ritmo, no sirve
//                   para saltarse el tope por conversación a escala.
// ============================================================

export function autoreplyToggleUpdate(
  paused: boolean,
  opts: { assignTo?: string | null } = {}
): Record<string, unknown> {
  const update: Record<string, unknown> = { ai_autoreply_disabled: paused };
  if (paused) {
    if (opts.assignTo) update.assigned_agent_id = opts.assignTo;
  } else {
    update.assigned_agent_id = null;
    update.ai_reply_count = 0;
    update.ai_handoff_summary = null;
  }
  return update;
}
