// ============================================================
// Lógica pura de Ajustes → Asistente IA (n13.10): qué controles de la
// respuesta automática quedan bloqueados. Fuera del componente para
// probarla sin DOM.
// ============================================================

export interface AutoReplyControlsContext {
  canEdit: boolean;
  saving: boolean;
  /** Valor guardado / en edición de `auto_reply_enabled`. */
  autoReplyEnabled: boolean;
}

export interface AutoReplyControlsState {
  /** Interruptor «Responder automáticamente a los mensajes entrantes». */
  switchDisabled: boolean;
  /** Campo «máximo de respuestas por conversación». */
  maxPerConversationDisabled: boolean;
}

/**
 * El interruptor de respuesta automática NO depende de «Asistente activo»:
 * con el asistente apagado sigue pintando el valor guardado, así que tiene
 * que poder apagarse (si no, al reactivar el asistente arrancaría
 * respondiendo solo sin que nadie lo eligiera). Solo lo bloquean el rol
 * y un guardado en curso. El máximo por conversación depende únicamente de
 * que la respuesta automática esté encendida.
 */
export function autoReplyControls({
  canEdit,
  saving,
  autoReplyEnabled,
}: AutoReplyControlsContext): AutoReplyControlsState {
  const locked = !canEdit || saving;
  return {
    switchDisabled: locked,
    maxPerConversationDisabled: locked || !autoReplyEnabled,
  };
}
