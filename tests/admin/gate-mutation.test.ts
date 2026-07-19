// tests/admin/gate-mutation.test.ts — G-T34-3/7 mutation gate (resolveSessionAdmin).
// DB-free: stubs the two identity deps so the session-only posture is asserted
// everywhere. Unlike the read gate, the token path is NOT a fallback here — a write
// must resolve a real admin (whose id satisfies the audit FK) or return null.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotAdminError, type AdminUser } from '@/lib/db/admin-guard';

const mocks = vi.hoisted(() => ({ getRequestUser: vi.fn(), requireAdmin: vi.fn() }));
vi.mock('@/lib/db/session-user', () => ({ getRequestUser: mocks.getRequestUser }));
vi.mock('@/lib/db/admin-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/admin-guard')>();
  return { ...actual, requireAdmin: mocks.requireAdmin };
});

import { resolveSessionAdmin } from '@/app/admin/_lib/gate';

const ADMIN: AdminUser = { userId: 'admin-uuid', role: 'admin' };

describe('resolveSessionAdmin — mutation gate', () => {
  beforeEach(() => {
    mocks.getRequestUser.mockReset();
    mocks.requireAdmin.mockReset();
  });

  it('returns the AdminUser for a signed-in active admin', async () => {
    mocks.getRequestUser.mockResolvedValue({ userId: 'admin-uuid', email: 'a@b.c' });
    mocks.requireAdmin.mockResolvedValue(ADMIN);
    expect(await resolveSessionAdmin()).toEqual(ADMIN);
  });

  it('returns null when there is no session', async () => {
    mocks.getRequestUser.mockResolvedValue(null);
    expect(await resolveSessionAdmin()).toBeNull();
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
  });

  it('returns null for a signed-in non-admin', async () => {
    mocks.getRequestUser.mockResolvedValue({ userId: 'u', email: null });
    mocks.requireAdmin.mockRejectedValue(new NotAdminError());
    expect(await resolveSessionAdmin()).toBeNull();
  });

  it('returns null (never throws) on an infra error', async () => {
    mocks.getRequestUser.mockResolvedValue({ userId: 'u', email: null });
    mocks.requireAdmin.mockRejectedValue(new Error('db down'));
    expect(await resolveSessionAdmin()).toBeNull();
  });
});
