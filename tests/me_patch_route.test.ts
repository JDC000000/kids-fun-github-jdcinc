// tests/me_patch_route.test.ts — PATCH /api/me contract, no database.
//
// Mocks the session resolver and the DB update helper so the route's branching
// (anonymous / bad JSON / invalid field / success / write-failure) is exercised
// deterministically. Real parseProfilePatch runs, so validation is covered
// end-to-end through the route. The DB write LOGIC itself is proven separately
// in tests/user_profile_update.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const UID = '11111111-1111-1111-1111-111111111111';

const mockGetRequestUser = vi.fn();
const mockUpdateUserProfile = vi.fn();

vi.mock('@/lib/db/session-user', () => ({
  getRequestUser: (...args: unknown[]) => mockGetRequestUser(...args),
}));

vi.mock('@/lib/db/user-profile', () => ({
  updateUserProfile: (...args: unknown[]) => mockUpdateUserProfile(...args),
  // GET-side helpers are imported by the route module; stub them so the import resolves.
  getUserProfile: vi.fn(),
  ensureUserProfile: vi.fn(),
}));

import { PATCH } from '../app/api/me/route';

function patchReq(body: string): Request {
  return new Request('http://localhost/api/me', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

describe('PATCH /api/me', () => {
  beforeEach(() => {
    mockGetRequestUser.mockReset();
    mockUpdateUserProfile.mockReset();
  });

  it('rejects an anonymous request with 401 and never writes', async () => {
    mockGetRequestUser.mockResolvedValue(null);
    const res = await PATCH(patchReq(JSON.stringify({ email_opt_in: true })));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'not signed in' });
    expect(mockUpdateUserProfile).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid JSON', async () => {
    mockGetRequestUser.mockResolvedValue({ userId: UID, email: 'p@example.com' });
    const res = await PATCH(patchReq('{not json'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid json/i);
    expect(mockUpdateUserProfile).not.toHaveBeenCalled();
  });

  it('returns 400 on an unknown field and never writes', async () => {
    mockGetRequestUser.mockResolvedValue({ userId: UID, email: 'p@example.com' });
    const res = await PATCH(patchReq(JSON.stringify({ nope: 1 })));
    expect(res.status).toBe(400);
    expect(mockUpdateUserProfile).not.toHaveBeenCalled();
  });

  it('returns 400 on an invalid postal code', async () => {
    mockGetRequestUser.mockResolvedValue({ userId: UID, email: 'p@example.com' });
    const res = await PATCH(patchReq(JSON.stringify({ home_postal: '90210' })));
    expect(res.status).toBe(400);
    expect(mockUpdateUserProfile).not.toHaveBeenCalled();
  });

  it('writes a validated, normalized patch and returns 200 with the profile', async () => {
    mockGetRequestUser.mockResolvedValue({ userId: UID, email: 'p@example.com' });
    const updated = { id: UID, home_postal: 'V6B 1A1', saved_child_ages: [24], email_opt_in: true };
    mockUpdateUserProfile.mockResolvedValue(updated);

    const res = await PATCH(
      patchReq(JSON.stringify({ home_postal: 'v6b1a1', saved_child_ages: [24], email_opt_in: true }))
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, profile: updated });
    // Postal was normalized before it reached the DB layer.
    expect(mockUpdateUserProfile).toHaveBeenCalledWith(UID, {
      home_postal: 'V6B 1A1',
      saved_child_ages: [24],
      email_opt_in: true,
    });
  });

  it('returns 500 with a generic message when the write throws', async () => {
    mockGetRequestUser.mockResolvedValue({ userId: UID, email: 'p@example.com' });
    mockUpdateUserProfile.mockRejectedValue(new Error('USER_DATABASE_URL is not set'));

    const res = await PATCH(patchReq(JSON.stringify({ email_opt_in: false })));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'could not update profile' });
  });
});
