// tests/account_delete_route.test.ts — POST /api/account/delete contract, no DB.
//
// Mocks the session resolver, the delete helper, the auth-identity remover, and
// the session revoker so the route's branching is exercised deterministically:
// anonymous / missing-or-wrong confirmation / success / honest auth-identity
// accounting / admin-FK 409 / generic 500. The delete LOGIC + RLS isolation are
// proven separately in tests/account_deletion.test.ts against a real Postgres.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const UID = '11111111-1111-1111-1111-111111111111';

const mockGetRequestUser = vi.fn();
const mockDeleteUserData = vi.fn();
const mockDeleteAuthIdentity = vi.fn();
const mockRevokeCurrentSession = vi.fn();

vi.mock('@/lib/db/session-user', () => ({
  getRequestUser: (...args: unknown[]) => mockGetRequestUser(...args),
}));
vi.mock('@/lib/db/account-data', () => ({
  deleteUserData: (...args: unknown[]) => mockDeleteUserData(...args),
}));
vi.mock('@/lib/db/auth-admin', () => ({
  deleteAuthIdentity: (...args: unknown[]) => mockDeleteAuthIdentity(...args),
}));
vi.mock('@/lib/db/session-revoke', () => ({
  revokeCurrentSession: (...args: unknown[]) => mockRevokeCurrentSession(...args),
}));

import { POST, DELETE_CONFIRM_PHRASE } from '../app/api/account/delete/route';

function req(body?: string): Request {
  return new Request('http://localhost/api/account/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

describe('POST /api/account/delete', () => {
  beforeEach(() => {
    mockGetRequestUser.mockReset();
    mockDeleteUserData.mockReset();
    mockDeleteAuthIdentity.mockReset().mockResolvedValue({ attempted: false, ok: false });
    mockRevokeCurrentSession.mockReset().mockResolvedValue(undefined);
  });

  it('rejects an anonymous request with 401 and never deletes', async () => {
    mockGetRequestUser.mockResolvedValue(null);
    const res = await POST(req(JSON.stringify({ confirmText: DELETE_CONFIRM_PHRASE })));
    expect(res.status).toBe(401);
    expect(mockDeleteUserData).not.toHaveBeenCalled();
  });

  it('rejects a missing / wrong / unparseable confirmation with 400 and never deletes', async () => {
    mockGetRequestUser.mockResolvedValue({ userId: UID, email: 'p@example.com' });

    expect((await POST(req(JSON.stringify({})))).status).toBe(400);
    expect((await POST(req(JSON.stringify({ confirmText: 'delete' })))).status).toBe(400); // wrong case
    expect((await POST(req(JSON.stringify({ confirmText: 'DELETE ME' })))).status).toBe(400);
    expect((await POST(req('{not json'))).status).toBe(400);

    expect(mockDeleteUserData).not.toHaveBeenCalled();
    expect(mockRevokeCurrentSession).not.toHaveBeenCalled();
  });

  it('on a confirmed request: deletes data, removes the identity, revokes the session', async () => {
    mockGetRequestUser.mockResolvedValue({ userId: UID, email: 'p@example.com' });
    mockDeleteUserData.mockResolvedValue({ saved_searches_deleted: 2, profile_deleted: 1 });
    mockDeleteAuthIdentity.mockResolvedValue({ attempted: true, ok: true });

    const res = await POST(req(JSON.stringify({ confirmText: DELETE_CONFIRM_PHRASE })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      deleted: { saved_searches_deleted: 2, profile_deleted: 1 },
      authIdentityRemoved: true,
      authIdentityAttempted: true,
    });
    expect(mockDeleteUserData).toHaveBeenCalledWith(UID);
    expect(mockRevokeCurrentSession).toHaveBeenCalledTimes(1);
  });

  it('honestly reports authIdentityRemoved=false when the service role is unconfigured', async () => {
    mockGetRequestUser.mockResolvedValue({ userId: UID, email: 'p@example.com' });
    mockDeleteUserData.mockResolvedValue({ saved_searches_deleted: 0, profile_deleted: 1 });
    mockDeleteAuthIdentity.mockResolvedValue({ attempted: false, ok: false, reason: 'service-role key not configured' });

    const res = await POST(req(JSON.stringify({ confirmText: DELETE_CONFIRM_PHRASE })));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.authIdentityRemoved).toBe(false);
    expect(body.authIdentityAttempted).toBe(false);
    // Data was still removed and the session still revoked.
    expect(mockRevokeCurrentSession).toHaveBeenCalledTimes(1);
  });

  it('returns 409 (not a bare 500) when the delete hits a foreign-key violation', async () => {
    mockGetRequestUser.mockResolvedValue({ userId: UID, email: 'p@example.com' });
    const fkErr = Object.assign(new Error('violates foreign key constraint'), { code: '23503' });
    mockDeleteUserData.mockRejectedValue(fkErr);

    const res = await POST(req(JSON.stringify({ confirmText: DELETE_CONFIRM_PHRASE })));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/administrative access/i);
    // Nothing was signed out / removed downstream when the delete itself failed.
    expect(mockRevokeCurrentSession).not.toHaveBeenCalled();
    expect(mockDeleteAuthIdentity).not.toHaveBeenCalled();
  });

  it('returns 500 with a generic message on an unexpected delete failure', async () => {
    mockGetRequestUser.mockResolvedValue({ userId: UID, email: 'p@example.com' });
    mockDeleteUserData.mockRejectedValue(new Error('boom'));

    const res = await POST(req(JSON.stringify({ confirmText: DELETE_CONFIRM_PHRASE })));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/could not delete/i);
  });
});
