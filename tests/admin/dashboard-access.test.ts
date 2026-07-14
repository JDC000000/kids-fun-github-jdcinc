// tests/admin/dashboard-access.test.ts — TEMPORARY admin dashboard token gate.
// Pure + DB-free: proves fail-closed behaviour, header/query precedence, and that a
// correct token is accepted. Real role-based auth will replace this gate (M5).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ADMIN_DASHBOARD_TOKEN_ENV,
  checkAdminDashboardAccess,
  resolvePresentedToken,
} from '../../lib/admin/access';

describe('admin dashboard access gate', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[ADMIN_DASHBOARD_TOKEN_ENV];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[ADMIN_DASHBOARD_TOKEN_ENV];
    else process.env[ADMIN_DASHBOARD_TOKEN_ENV] = saved;
  });

  it('fails closed when the secret env var is not configured', () => {
    delete process.env[ADMIN_DASHBOARD_TOKEN_ENV];
    expect(checkAdminDashboardAccess('anything')).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('fails closed when the secret is empty', () => {
    process.env[ADMIN_DASHBOARD_TOKEN_ENV] = '';
    expect(checkAdminDashboardAccess('anything')).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('denies when no token is presented', () => {
    process.env[ADMIN_DASHBOARD_TOKEN_ENV] = 'sekret-value';
    expect(checkAdminDashboardAccess(null)).toEqual({ ok: false, reason: 'missing_token' });
    expect(checkAdminDashboardAccess('')).toEqual({ ok: false, reason: 'missing_token' });
  });

  it('denies a wrong token', () => {
    process.env[ADMIN_DASHBOARD_TOKEN_ENV] = 'sekret-value';
    expect(checkAdminDashboardAccess('nope')).toEqual({ ok: false, reason: 'bad_token' });
    // Different length must also be rejected (and not throw in the compare).
    expect(checkAdminDashboardAccess('sekret-value-longer')).toEqual({ ok: false, reason: 'bad_token' });
  });

  it('accepts the exact token', () => {
    process.env[ADMIN_DASHBOARD_TOKEN_ENV] = 'sekret-value';
    expect(checkAdminDashboardAccess('sekret-value')).toEqual({ ok: true });
  });

  it('prefers the header, falls back to the query param, ignores array query values', () => {
    expect(resolvePresentedToken('h-token', 'q-token')).toBe('h-token');
    expect(resolvePresentedToken(null, 'q-token')).toBe('q-token');
    expect(resolvePresentedToken(undefined, undefined)).toBeNull();
    expect(resolvePresentedToken('', '')).toBeNull();
    expect(resolvePresentedToken(null, ['a', 'b'])).toBeNull(); // repeated ?token= → reject
  });
});
