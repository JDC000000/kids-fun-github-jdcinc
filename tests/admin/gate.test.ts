// tests/admin/gate.test.ts — the admin gate (app/admin/_lib/gate.ts).
//
// DB-FREE unit coverage. The two DB-touching dependencies (getRequestUser, requireAdmin) and the
// audit side effect (recordAdminAccess) are stubbed so this runs everywhere, including CI without
// a DB. The real requireAdmin/audit SQL round-trip is proven separately against a live DB in
// tests/admin/gate-db.test.ts and tests/admin/audit-db.test.ts.
//
// 2026-09-24: the interim ADMIN_DASHBOARD_TOKEN fallback (`x-admin-token` / `?token=`) was removed.
// The cases that used to prove the token worked now prove it does nothing — even when configured.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotAdminError, type AdminUser } from '@/lib/db/admin-guard';

// vi.hoisted: the mock factories below are hoisted above imports, so the stubs they
// reference must be hoisted too (a plain top-level const would be "used before init").
const mocks = vi.hoisted(() => ({
  getRequestUser: vi.fn(),
  requireAdmin: vi.fn(),
  recordAdminAccess: vi.fn(),
}));

vi.mock('@/lib/db/session-user', () => ({ getRequestUser: mocks.getRequestUser }));
vi.mock('@/lib/db/admin-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/admin-guard')>();
  return { ...actual, requireAdmin: mocks.requireAdmin };
});
vi.mock('@/lib/admin/audit', () => ({ recordAdminAccess: mocks.recordAdminAccess }));

// Import AFTER the mocks are declared (vi.mock is hoisted, so this binds the stubs).
import { resolveAdminAccess, resolveSessionAdmin } from '@/app/admin/_lib/gate';

const ADMIN: AdminUser = { userId: 'admin-uuid', role: 'admin' };
const LEGACY_ENV = 'ADMIN_DASHBOARD_TOKEN';

describe('resolveAdminAccess — the admin gate', () => {
  let savedToken: string | undefined;
  beforeEach(() => {
    savedToken = process.env[LEGACY_ENV];
    // The dangerous state: the legacy secret is configured. Nothing below may depend on it.
    process.env[LEGACY_ENV] = 'legacy-secret-that-opens-nothing';
    mocks.getRequestUser.mockReset();
    mocks.requireAdmin.mockReset();
    mocks.recordAdminAccess.mockReset();
    mocks.recordAdminAccess.mockResolvedValue(true); // audit write succeeds by default
  });
  afterEach(() => {
    if (savedToken === undefined) delete process.env[LEGACY_ENV];
    else process.env[LEGACY_ENV] = savedToken;
    vi.restoreAllMocks();
  });

  it('🔴 denies when there is no session, even with ADMIN_DASHBOARD_TOKEN configured', async () => {
    mocks.getRequestUser.mockResolvedValue(null);
    expect(await resolveAdminAccess({ surface: 'admin_dashboard' })).toEqual({ ok: false });
    expect(mocks.recordAdminAccess).not.toHaveBeenCalled();
  });

  it('🔴 the gate contract has no field that could carry a request credential', async () => {
    mocks.getRequestUser.mockResolvedValue(null);
    // A compile-time guard as much as a runtime one: tsc fails this file if AdminGateRequest ever
    // grows a token field again (the @ts-expect-error would become unused).
    // @ts-expect-error — queryToken is not part of the gate contract any more
    const grant = await resolveAdminAccess({ surface: 'admin_dashboard', queryToken: process.env[LEGACY_ENV] });
    expect(grant).toEqual({ ok: false });
  });

  it('grants via session for a real admin and records an audit access event', async () => {
    mocks.getRequestUser.mockResolvedValue({ userId: ADMIN.userId, email: 'a@b.c' });
    mocks.requireAdmin.mockResolvedValue(ADMIN);
    const grant = await resolveAdminAccess({ surface: 'admin_data_health' });
    expect(grant).toEqual({ ok: true, via: 'session', admin: ADMIN });
    expect(mocks.recordAdminAccess).toHaveBeenCalledTimes(1);
    expect(mocks.recordAdminAccess).toHaveBeenCalledWith(ADMIN.userId, 'admin_data_health');
  });

  it('session grant survives an audit-write failure (audit is best-effort, never blocks)', async () => {
    mocks.getRequestUser.mockResolvedValue({ userId: ADMIN.userId, email: null });
    mocks.requireAdmin.mockResolvedValue(ADMIN);
    mocks.recordAdminAccess.mockResolvedValue(false);
    expect(await resolveAdminAccess({ surface: 'admin_dashboard' })).toEqual({ ok: true, via: 'session', admin: ADMIN });
  });

  it('denies a signed-in NON-admin, un-audited', async () => {
    mocks.getRequestUser.mockResolvedValue({ userId: 'plain-user', email: null });
    mocks.requireAdmin.mockRejectedValue(new NotAdminError());
    expect(await resolveAdminAccess({ surface: 'admin_dashboard' })).toEqual({ ok: false });
    expect(mocks.recordAdminAccess).not.toHaveBeenCalled();
  });

  it('fails CLOSED when the role check errors (DB down): denies, never throws, logs the message only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.getRequestUser.mockResolvedValue({ userId: ADMIN.userId, email: null });
    mocks.requireAdmin.mockRejectedValue(new Error('connection refused'));
    expect(await resolveAdminAccess({ surface: 'admin_dashboard' })).toEqual({ ok: false });
    expect(mocks.recordAdminAccess).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('denying');
  });
});

describe('resolveSessionAdmin — the write-path resolver', () => {
  beforeEach(() => {
    mocks.getRequestUser.mockReset();
    mocks.requireAdmin.mockReset();
  });

  it('returns the admin for an active admin session', async () => {
    mocks.getRequestUser.mockResolvedValue({ userId: ADMIN.userId, email: null });
    mocks.requireAdmin.mockResolvedValue(ADMIN);
    expect(await resolveSessionAdmin()).toEqual(ADMIN);
  });

  it('returns null for anonymous, non-admin and errored checks', async () => {
    mocks.getRequestUser.mockResolvedValue(null);
    expect(await resolveSessionAdmin()).toBeNull();
    mocks.getRequestUser.mockResolvedValue({ userId: 'plain-user', email: null });
    mocks.requireAdmin.mockRejectedValue(new NotAdminError());
    expect(await resolveSessionAdmin()).toBeNull();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.requireAdmin.mockRejectedValue(new Error('db down'));
    expect(await resolveSessionAdmin()).toBeNull();
    vi.restoreAllMocks();
  });
});
