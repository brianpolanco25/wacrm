import { describe, expect, it } from 'vitest';
import { UUID_RE } from './uuid';

describe('UUID_RE', () => {
  it('acepta los v4 que emite Postgres y rechaza lo que no es RFC 4122', () => {
    expect(UUID_RE.test('5eed0000-0000-4000-8000-000000000001')).toBe(true);
    expect(UUID_RE.test('3F2504E0-4F89-41D3-9A0C-0305E82C3301')).toBe(true);
    expect(UUID_RE.test('00000000-0000-0000-0000-000000000000')).toBe(false);
    expect(UUID_RE.test('5eed0000-0000-4000-c000-000000000001')).toBe(false);
    expect(UUID_RE.test('../etc/passwd')).toBe(false);
  });
});
