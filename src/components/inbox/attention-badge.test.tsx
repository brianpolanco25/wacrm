import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AttentionBadge } from './attention-badge';
import { PRESENCE_DOT_CLASS } from '@/components/presence/presence-dot';

/**
 * Fase 1 §3: "Los tres estados se distinguen a simple vista, sin abrir
 * el chat." No jsdom / testing-library in this repo (and no new deps),
 * so the badge is rendered to static markup — enough to pin that each
 * state paints a different mark, not just a different colour.
 */
function render(node: React.ReactElement) {
  return renderToStaticMarkup(node);
}

describe('AttentionBadge', () => {
  const ai = render(<AttentionBadge state="ai" label="AI replying" />);
  const assigned = render(
    <AttentionBadge state="assigned" label="Ana Ruiz" presence="online" />
  );
  const unattended = render(
    <AttentionBadge state="unattended" label="Unattended" />
  );

  it('renders a different mark for each of the three states', () => {
    expect(new Set([ai, assigned, unattended]).size).toBe(3);
    expect(ai).toContain('data-attention="ai"');
    expect(assigned).toContain('data-attention="assigned"');
    expect(unattended).toContain('data-attention="unattended"');
  });

  it('shows the label of each state', () => {
    expect(ai).toContain('AI replying');
    expect(assigned).toContain('Ana Ruiz');
    expect(unattended).toContain('Unattended');
  });

  it('does not lean on colour alone — each state carries its own icon', () => {
    // lucide stamps the icon name into the class list.
    expect(ai).toContain('lucide-sparkles');
    expect(unattended).toContain('lucide-circle-alert');
    expect(assigned).not.toContain('lucide-sparkles');
    expect(assigned).not.toContain('lucide-circle-alert');
  });

  it("carries the assignee's presence dot", () => {
    expect(assigned).toContain(PRESENCE_DOT_CLASS.online);
    expect(
      render(
        <AttentionBadge state="assigned" label="Ana Ruiz" presence="offline" />
      )
    ).toContain(PRESENCE_DOT_CLASS.offline);
  });

  it('defaults an assignee with no presence row to offline', () => {
    expect(
      render(<AttentionBadge state="assigned" label="Ana Ruiz" />)
    ).toContain(PRESENCE_DOT_CLASS.offline);
  });

  it('keeps the AI and unattended states visually apart', () => {
    // Amber vs accent: the handed-off thread nobody picked up must not
    // read like the one the bot is on.
    expect(unattended).toContain('text-amber-600');
    expect(ai).toContain('text-primary');
  });
});
