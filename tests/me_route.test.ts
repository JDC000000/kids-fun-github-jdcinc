// tests/me_route.test.ts — GET /api/me contract, no database.
//
// Mocks the Supabase SSR session read and the user-profile helpers so the
// route's branching (anonymous / signed-in-with-profile / signed-in-self-heal /
// never-500) is exercised deterministically. The DB-backed provisioning LOGIC
// itself is proven separately in tests/user_profile_provisioning.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const UID = '11111111-1111-1111-1111-111111111111';

const mockGetUser = vi.fn();
const mockGetUserProfile = vi.fn();
const mockEnsureUserProfile = vi.fn();

vi.mock('next/headers', () => ({
  cookies: () => ({
    get: () => undefined,
    set: () => {},
  }),
}));

vi.mock('@/lib/db/auth', () => ({
  createSupabaseServerClient: () => ({ auth: { getUser: mockGetUser } }),
}));

vi.mock('@/lib/db/user-profile', () => ({
  getUserProfile: (...args: unknown[]) => mockGetUserProfile(...args),
  ensureUserProfile: (...args: unknown[]) => mockEnsureUserProfile(...args),
}));

// Imported after the mocks are registered (vi.mock is hoisted, so this is safe).
import { GET } from '../app/api/me/route';

describe('GET /api/me', () => {
  beforeEach(() => {
    mockGetUser.mockReset();
    mockGetUserProfile.mockReset();
    mockEnsureUserProfile.mockReset();
  });

  it('returns a clean not-signed-in response for an anonymous request', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false, user: null, profile: null });
    expect(mockGetUserProfile).not.toHaveBeenCalled();
  });

  it('never 500s — an auth-read failure reads as not-signed-in', async () => {
    mockGetUser.mockRejectedValue(new Error('SUPABASE_URL / SUPABASE_ANON_KEY are not set'));
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false, user: null, profile: null });
  });

  it('reports an existing profile without writing when one is already present', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: UID, email: 'parent@example.com' } } });
    mockGetUserProfile.mockResolvedValue({ id: UID, home_postal: null, saved_child_ages: [], email_opt_in: false });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authenticated).toBe(true);
    expect(body.user).toEqual({ id: UID, email: 'parent@example.com' });
    expect(body.profile).toEqual({ exists: true, id: UID });
    expect(mockEnsureUserProfile).not.toHaveBeenCalled();
  });

  it('self-heals a missing profile via ensureUserProfile (upsert-on-first-request)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: UID, email: 'parent@example.com' } } });
    mockGetUserProfile.mockResolvedValue(null);
    mockEnsureUserProfile.mockResolvedValue({
      profile: { id: UID, home_postal: null, saved_child_ages: [], email_opt_in: false },
      created: true,
    });

    const res = await GET();
    const body = await res.json();
    expect(body.profile).toEqual({ exists: true, id: UID });
    expect(mockEnsureUserProfile).toHaveBeenCalledWith(UID, 'parent@example.com');
  });

  it('stays authenticated with profile unknown when the DB is unreachable', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: UID, email: null } } });
    mockGetUserProfile.mockRejectedValue(new Error('USER_DATABASE_URL is not set'));

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authenticated).toBe(true);
    expect(body.user).toEqual({ id: UID, email: null });
    expect(body.profile).toEqual({ exists: false, id: null });
  });
});
