import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_HANDOFF_MESSAGE,
  handoffMessagePayload,
} from './handoff-message';

// Same convention as src/i18n/messages.test.ts: vitest runs from the
// repo root.
const repoRoot = process.cwd();

describe('DEFAULT_HANDOFF_MESSAGE stays in sync with its copies', () => {
  it('matches the DEFAULT seeded by migration 043', () => {
    const sql = readFileSync(
      join(repoRoot, 'supabase', 'migrations', '043_ai_handoff_mode.sql'),
      'utf8'
    );
    // The literal in the ALTER TABLE, not the prose in the header.
    const match = sql.match(
      /ADD COLUMN IF NOT EXISTS handoff_message text\s*\n?\s*DEFAULT '([^']*)'/
    );
    expect(match?.[1]).toBe(DEFAULT_HANDOFF_MESSAGE);
  });

  it('matches the English placeholder shown under the textarea', () => {
    const en = JSON.parse(
      readFileSync(join(repoRoot, 'messages', 'en.json'), 'utf8')
    );
    expect(en.Settings.aiConfig.handoffMessagePlaceholder).toBe(
      `e.g. ${DEFAULT_HANDOFF_MESSAGE}`
    );
  });

  it('is English, not Spanish — the product only ships en/ko catalogues', () => {
    const ko = JSON.parse(
      readFileSync(join(repoRoot, 'messages', 'ko.json'), 'utf8')
    );
    // Same key present in both catalogues (CP6); the seed itself is `en`.
    expect(ko.Settings.aiConfig.handoffMessagePlaceholder).toBeTruthy();
    expect(DEFAULT_HANDOFF_MESSAGE).not.toMatch(/Gracias por escribirnos/);
  });
});

describe('handoffMessagePayload', () => {
  it('omits the field when the admin never touched it (the seeded default survives)', () => {
    expect(
      handoffMessagePayload({ edited: false, value: DEFAULT_HANDOFF_MESSAGE })
    ).toBeUndefined();
  });

  it('omits the field even when the untouched value is empty', () => {
    expect(handoffMessagePayload({ edited: false, value: '' })).toBeUndefined();
  });

  it('sends an empty string when the admin cleared the field on purpose', () => {
    expect(handoffMessagePayload({ edited: true, value: '   ' })).toBe('');
  });

  it('trims a message the admin typed', () => {
    expect(
      handoffMessagePayload({ edited: true, value: '  Un momento.  ' })
    ).toBe('Un momento.');
  });

  it('is dropped by JSON.stringify when undefined, so the route sees no key', () => {
    const body = {
      provider: 'openai',
      handoff_message: handoffMessagePayload({ edited: false, value: 'x' }),
    };
    expect('handoff_message' in JSON.parse(JSON.stringify(body))).toBe(false);
  });
});
