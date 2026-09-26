// tests/admin/personal-data.test.ts — the fail-closed default of shouldRedact (QA L4, 2026-09-25).
//
// The contract (lib/admin/personal-data.ts): ONLY an explicit `false` shows personal data; anything
// else — missing, undefined, null, a truthy non-boolean, a string 'false' — redacts. TypeScript
// requires a boolean at every call site today, so this pins the RUNTIME behaviour for the day a caller
// is untyped (JSON, `as never`, a spread of an optional field). QA's mutation P1-MD ("only an
// explicit `true` redacts") left the whole suite green; this file turns it red.
import { describe, expect, it } from 'vitest';
import { shouldRedact, type PersonalDataOptions } from '@/lib/admin/personal-data';

const opts = (v: unknown) => ({ redactPersonalData: v }) as unknown as PersonalDataOptions;

describe('shouldRedact is fail-closed', () => {
  it('shows personal data ONLY for an explicit false', () => {
    expect(shouldRedact({ redactPersonalData: false })).toBe(false);
  });

  it('🔴 redacts for an explicit true', () => {
    expect(shouldRedact({ redactPersonalData: true })).toBe(true);
  });

  it('🔴 redacts when the option is missing or not a boolean false', () => {
    expect(shouldRedact({} as never)).toBe(true);
    for (const v of [undefined, null, 0, '', 'false', 'no', 'true', 1, [], {}]) {
      expect(shouldRedact(opts(v)), JSON.stringify(v) ?? String(v)).toBe(true);
    }
  });
});
