import { describe, it, expect } from 'vitest';
import {
  E2E_TEST_EMAIL_DOMAIN,
  E2E_TEST_USER_MARKER,
  buildTestUserEmail,
  isE2ETestEmail,
  DEFAULT_TEST_USER,
} from '@/lib/testing/test-user';

// Named safety requirement #2, unit side: the dedicated test user is
// unmistakably a test account (reserved domain + persisted marker), enforced in
// code rather than by convention.

describe('E2E test-user identity', () => {
  it('uses the reserved, non-deliverable .test domain', () => {
    expect(E2E_TEST_EMAIL_DOMAIN).toBe('e2e.kids-fun.test');
    expect(buildTestUserEmail('account')).toBe('e2e+account@e2e.kids-fun.test');
    expect(DEFAULT_TEST_USER.email.endsWith('@e2e.kids-fun.test')).toBe(true);
  });

  it('carries a persisted audit marker', () => {
    expect(E2E_TEST_USER_MARKER.is_e2e_test_user).toBe(true);
    expect(E2E_TEST_USER_MARKER.created_by).toBe('kids-fun-e2e-harness');
    expect(E2E_TEST_USER_MARKER.purpose).toBe('automated-testing');
  });

  it('recognises only test-domain emails as test accounts', () => {
    expect(isE2ETestEmail('e2e+default@e2e.kids-fun.test')).toBe(true);
    expect(isE2ETestEmail('parent@gmail.com')).toBe(false);
    expect(isE2ETestEmail('someone@kids-fun.test.evil.com')).toBe(false);
    expect(isE2ETestEmail(null)).toBe(false);
    expect(isE2ETestEmail(undefined)).toBe(false);
  });
});
