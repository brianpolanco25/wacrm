import { describe, expect, it } from 'vitest';

import { autoReplyControls } from './ai-config-state';

// n13.10: el interruptor de respuesta automática se puede apagar aunque el
// asistente esté inactivo. `isActive` no es entrada de la regla: con
// is_active=false y auto_reply_enabled=true el interruptor queda editable.

describe('autoReplyControls', () => {
  it('deja editable el interruptor con el asistente apagado y auto_reply_enabled=true', () => {
    const state = autoReplyControls({
      canEdit: true,
      saving: false,
      autoReplyEnabled: true,
    });
    expect(state.switchDisabled).toBe(false);
    expect(state.maxPerConversationDisabled).toBe(false);
  });

  it('bloquea el interruptor solo por rol o guardado en curso', () => {
    expect(
      autoReplyControls({
        canEdit: false,
        saving: false,
        autoReplyEnabled: true,
      }).switchDisabled
    ).toBe(true);
    expect(
      autoReplyControls({ canEdit: true, saving: true, autoReplyEnabled: true })
        .switchDisabled
    ).toBe(true);
    expect(
      autoReplyControls({
        canEdit: true,
        saving: false,
        autoReplyEnabled: false,
      }).switchDisabled
    ).toBe(false);
  });

  it('el máximo por conversación sigue a la respuesta automática, no al asistente', () => {
    expect(
      autoReplyControls({
        canEdit: true,
        saving: false,
        autoReplyEnabled: false,
      }).maxPerConversationDisabled
    ).toBe(true);
    expect(
      autoReplyControls({
        canEdit: false,
        saving: false,
        autoReplyEnabled: true,
      }).maxPerConversationDisabled
    ).toBe(true);
  });
});
