import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_VOICE_FALLBACK_MESSAGE } from './fallback-message';

// Same convention as handoff-message.test.ts: vitest runs from the repo root.
const repoRoot = process.cwd();

describe('DEFAULT_VOICE_FALLBACK_MESSAGE stays in sync with its copies (R44)', () => {
  it('matches the DEFAULT seeded by migration 096', () => {
    const sql = readFileSync(
      join(repoRoot, 'supabase', 'migrations', '096_ai_voice_notes.sql'),
      'utf8'
    );
    const match = sql.match(
      /ADD COLUMN IF NOT EXISTS voice_fallback_message text\s*\n?\s*DEFAULT '((?:[^']|'')*)'/
    );
    // SQL doubles the apostrophe in "can't".
    expect(match?.[1]?.replace(/''/g, "'")).toBe(
      DEFAULT_VOICE_FALLBACK_MESSAGE
    );
  });

  it('matches the English placeholder shown under the textarea', () => {
    const en = JSON.parse(
      readFileSync(join(repoRoot, 'messages', 'en.json'), 'utf8')
    );
    expect(en.Settings.aiConfig.voiceFallbackMessagePlaceholder).toBe(
      `e.g. ${DEFAULT_VOICE_FALLBACK_MESSAGE}`
    );
  });

  it('has the placeholder in es too', () => {
    const es = JSON.parse(
      readFileSync(join(repoRoot, 'messages', 'es.json'), 'utf8')
    );
    expect(es.Settings.aiConfig.voiceFallbackMessagePlaceholder).toBeTruthy();
  });
});
