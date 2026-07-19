// tests/admin/gate.test.ts — G-T34-1 composite admin gate (app/admin/_lib/gate.ts).
//
// DB-FREE unit coverage of the OR-composition and its fail-safe behaviour. The two
// DB-touching dependencies (getRequestUser, requireAdmin) and the audit side effect
// (recordAdminAccess) are stubbed so this runs everywhere, including CI without a DB.
// The real requireAdmin/audit SQL round-trip is proven separately against a live DB
// in tests/admin/gate-db.test.ts and tests/admin/audit-db.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_DASHBOARD_TOKEN_ENV } from '@/lib/admin/access';
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
import { resolveAdminAccess } from '@/app/admin/_lib/gate';

const ADMIN: AdminUser = { userId: 'admin-uuid', role: 'admin' };
const TOKEN = 'sekret-value';

function req(overrides: Partial<Parameters<typeof resolveAdminAccess>[0]> = {}) {
  return { surface: 'admin_dashboard', headerToken: null, queryToken: null, ...overrides };
}

describe('resolveAdminAccess — composite admin gate (G-T34-1)', () => {
  let savedToken: string | undefined;
  beforeEach(() => {
    savedToken = process.env[ADMIN_DASHBOARD_TOKEN_ENV];
    mocks.getRequestUser.mockReset();
    mocks.requireAdmin.mockReset();
    mocks.recordAdminAccess.mockReset();
    mocks.recordAdminAccess.mockResolvedValue(true); // audit write succeeds by default
  });
  afterEach(() => {
    if (savedToken === undefined) delete process.env[ADMIN_DASHBOARD_TOKEN_ENV];
    else process.env[ADMIN_DASHBOARD_TOKEN_ENV] = savedToken;
  });

  // ── Combo 1: no session + no token → blocked (fail-closed) ──────────────────
  it('denies when there is neither a session nor a token', async () => {
    process.env[ADMIN_DASHBOARD_TOKEN_ENV] = TOKEN;
    mocks.getRequestUser.mockResolvedValue(null);
    expect(await resolveAdminAccess(req())).toEqual({ ok: false });
    expect(mocks.recordAdminAccess).not.toHaveBeenCalled();
  });

  // ── Combo 2: valid token + no session → still works (regression guard) ──────
  it('grants via the interim token when there is no session (token unchanged)', async () => {
    process.env[ADMIN_DASHBOARD_TOKEN_ENV] = TOKEN;
    mocks.getRequestUser.mockResolvedValue(null);
    expect(await resolveAdminAccess(req({ headerToken: TOKEN }))).toEqual({ ok: true, via: 'token' });
    // token path carries no admin identity → it is NEVER audited
    expect(mocks.recordAdminAccess).not.toHaveBeenCalled();
  });

  it('accepts the token via the ?token= query param too (not just the header)', async () => {
    process.env[ADMIN_DASHBOARD_TOKEN_ENV] = TOKEN;
    mocks.getRequestUser.mockResolvedValue(null);
    expect(await resolveAdminAccess(req({ queryToken: TOKEN }))).toEqual({ ok: true, via: 'token' });
  });

  // ── Combo 3: real admin session + no token → granted via the NEW path ───────
  it('grants via session for a real admin and records an audit access event', async () => {
    delete process.env[ADMIN_DASHBOARD_TOKEN_ENV]; // token not even configured
    mocks.getRequestUser.mockResolvedValue({ userId: ADMIN.userId, email: 'a@b.c' });
    mocks.requireAdmin.mockResolvedValue(ADMIN);
    const grant = await resolveAdminAccess(req({ surface: 'admin_data_health' }));
    expect(grant).toEqual({ ok: true, via: 'session', admin: ADMIN });
    expect(mocks.recordAdminAccess).toHaveBeenCalledTimes(1);
    expect(mocks.recordAdminAccess).toHaveBeenCalledWith(ADMIN.userId, 'admin_data_health');
  });

  it('session grant survives an audit-write failure (audit is best-effort, never blocks)', async () => {
    mocks.getRequestUser.mockResolvedValue({ userId: ADMIN.userId, email: null });
    mocks.requireAdmin.mockResolvedValue(ADMIN);
    mocks.recordAdminAccess.mockResolvedValue(false); // write failed, swallowed by recordAdminAccess
    const grant = await resolveAdminAccess(req());
    expect(grant).toEqual({ ok: true, via: 'session', admin: ADMIN });
  });

  it('prefers the session path over the token even when a valid token is also present', async () => {
    process.env[ADMIN_DASHBOARD_TOKEN_ENV] = TOKEN;
    mocks.getRequestUser.mockResolvedValue({ userId: ADMIN.userId, email: null });
    mocks.requireAdmin.mockResolvedValue(ADMIN);
    const grant = await resolveAdminAccess(req({ headerToken: TOKEN }));
    expect(grant).toEqual({ ok: true, via: 'session', admin: ADMIN });
    expect(mocks.recordAdminAccess).toHaveBeenCalledWith(ADMIN.userId, 'admin_dashboard');
  });

  // ── Combo 4: real NON-admin session + no token → blocked ────────────────────
  it('denies a signed-in NON-admin when no token is presented', async () => {
    process.env[ADMIN_DASHBOARD_TOKEN_ENV] = TOKEN;
    mocks.getRequestUser.mockResolvedValue({ userId: 'plain-user', email: null });
    mocks.requireAdmin.mockRejectedValue(new NotAdminError());
    expect(await resolveAdminAccess(req())).toEqual({ ok: false });
    expect(mocks.recordAdminAccess).not.toHaveBeenCalled();
  });

  it('lets a signed-in NON-admin still use a valid token (coexistence), un-audited', async () => {
    process.env[ADMIN_DASHBOARD_TOKEN_ENV] = TOKEN;
    mocks.getRequestUser.mockResolvedValue({ userId: 'plain-user', email: null });
    mocks.requireAdmin.mockRejectedValue(new NotAdminError());
    expect(await resolveAdminAccess(req({ headerToken: TOKEN }))).toEqual({ ok: true, via: 'token' });
    expect(mocks.recordAdminAccess).not.toHaveBeenCalled();
  });

  // ── No-lockout invariant: a DB error on the NEW path must NOT deny a token ──
  it('falls back to the token if the session/role check throws a non-NotAdminError (DB down)', async () => {
    process.env[ADMIN_DASHBOARD_TOKEN_ENV] = TOKEN;
    mocks.getRequestUser.mockResolvedValue({ userId: 'admin-uuid', email: null });
    mocks.requireAdmin.mockRejectedValue(new Error('connection refused')); // e.g. Postgres unreachable
    // With a valid token, access is preserved despite the new path erroring.
    expect(await resolveAdminAccess(req({ headerToken: TOKEN }))).toEqual({ ok: true, via: 'token' });
    // Without a token, a broken new path denies (fail-closed) rather than throwing.
    expect(await resolveAdminAccess(req())).toEqual({ ok: false });
    expect(mocks.recordAdminAccess).not.toHaveBeenCalled();
  });
});
