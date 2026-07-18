import { describe, it, expect } from 'vitest';
import {
  assertTestOnlySupabaseTarget,
  UnsafeSupabaseTargetError,
} from '@/lib/testing/supabase-guard';

// Named safety requirement #1, made independently verifiable in the STANDARD test
// suite: the E2E service-role session harness can categorically never target a
// non-test (e.g. production) Supabase. This is the default-deny gate every
// privileged code path must pass through first.

describe('assertTestOnlySupabaseTarget (E2E session-injection safety gate)', () => {
  const loopbacks = [
    'http://127.0.0.1:54321',
    'http://localhost:54321',
    'http://0.0.0.0:54321',
    'https://127.0.0.1',
  ];

  for (const url of loopbacks) {
    it(`allows loopback target ${url}`, () => {
      const r = assertTestOnlySupabaseTarget({ supabaseUrl: url, appEnv: 'test' });
      expect(r.reason).toBe('loopback');
    });
  }

  it('REFUSES a production-looking project by default (default-deny)', () => {
    expect(() =>
      assertTestOnlySupabaseTarget({ supabaseUrl: 'https://abcdproject.supabase.co', appEnv: 'test' }),
    ).toThrow(UnsafeSupabaseTargetError);
  });

  it('REFUSES even a loopback target when NEXT_PUBLIC_APP_ENV=production', () => {
    expect(() =>
      assertTestOnlySupabaseTarget({ supabaseUrl: 'http://127.0.0.1:54321', appEnv: 'production' }),
    ).toThrow(/production/i);
  });

  it('REFUSES a remote host that is NOT in the allowlist', () => {
    expect(() =>
      assertTestOnlySupabaseTarget({
        supabaseUrl: 'https://staging-real.supabase.co',
        appEnv: 'staging',
        allowedHostsEnv: 'some-other-test.supabase.co',
      }),
    ).toThrow(UnsafeSupabaseTargetError);
  });

  it('allows a remote host ONLY when explicitly allowlisted', () => {
    const r = assertTestOnlySupabaseTarget({
      supabaseUrl: 'https://dedicated-test.supabase.co',
      appEnv: 'test',
      allowedHostsEnv: 'dedicated-test.supabase.co, other.supabase.co',
    });
    expect(r.reason).toBe('allowlisted');
    expect(r.host).toBe('dedicated-test.supabase.co');
  });

  it('does NOT let a production host sneak in alongside an allowlisted one', () => {
    // Allowlist names a test project; a different (prod) host must still be refused.
    expect(() =>
      assertTestOnlySupabaseTarget({
        supabaseUrl: 'https://prod-xyz.supabase.co',
        appEnv: 'test',
        allowedHostsEnv: 'dedicated-test.supabase.co',
      }),
    ).toThrow(UnsafeSupabaseTargetError);
  });

  it('throws when SUPABASE_URL is missing', () => {
    expect(() => assertTestOnlySupabaseTarget({ supabaseUrl: undefined, appEnv: 'test' })).toThrow(
      /SUPABASE_URL is not set/i,
    );
  });

  it('throws when SUPABASE_URL is not a valid URL', () => {
    expect(() =>
      assertTestOnlySupabaseTarget({ supabaseUrl: 'not-a-url', appEnv: 'test' }),
    ).toThrow(UnsafeSupabaseTargetError);
  });
});
