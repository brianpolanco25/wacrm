import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// p16.6 F1 (audit-lean 2): no DOM renderer in this repo, so the remount
// is pinned on the source. The composer's unmount cleanup stops the
// recorder and deletes the staged upload.
describe('MessageThread composer', () => {
  it('keys <MessageComposer> by conversation id', () => {
    const src = readFileSync(
      path.join(__dirname, 'message-thread.tsx'),
      'utf8'
    );
    expect(src).toMatch(/<MessageComposer\s+key=\{conversation\.id\}/);
  });
});
