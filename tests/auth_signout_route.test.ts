// tests/auth_signout_route.test.ts — /auth/signout contract (CSRF hardening, F-3).
//
// Proves the sign-out route is POST-only (a GET can no longer trigger the
// state-changing sign-out — the logout-CSRF vector), that a POST actually
// revokes the Supabase session, redirects with 303 (See Other) so the browser
// GETs the landing page, honours ?next=, and — like /api/me — never throws even
// when session revocation fails. The Supabase SSR client + next/headers cookies
// are mocked so this stays a pure contract test with no database / network.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSignOut = vi.fn();

vi.mock('next/headers', () => ({
  cookies: () => ({
    get: () => undefined,
    set: () => {},
  }),
}));

vi.mock('@/lib/db/auth', () => ({
  createSupabaseServerClient: () => ({ auth: { signOut: mockSignOut } }),
}));

// Imported after the mocks are registered (vi.mock is hoisted, so this is safe).
import * as signoutRoute from '../app/auth/signout/route';

const { POST } = signoutRoute;

describe('/auth/signout', () => {
  beforeEach(() => {
    mockSignOut.mockReset();
    mockSignOut.mockResolvedValue({ error: null });
  });

  it('is POST-only — no GET handler, so a GET cannot trigger sign-out (logout CSRF)', () => {
    // Next returns 405 for unexported methods; the absence of a GET export is
    // exactly what makes `<img src=".../auth/signout">` inert.
    expect((signoutRoute as Record<string, unknown>).GET).toBeUndefined();
    expect(typeof POST).toBe('function');
  });

  it('POST revokes the session and 303-redirects to the app root by default', async () => {
    const res = await POST(new Request('https://kids-fun.example/auth/signout', { method: 'POST' }));
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    // 303 See Other → browser re-requests the destination with GET (not a re-POST).
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://kids-fun.example/');
  });

  it('POST honours a same-origin ?next= destination', async () => {
    const res = await POST(
      new Request('https://kids-fun.example/auth/signout?next=/account', { method: 'POST' }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://kids-fun.example/account');
  });

  it('never throws — a failed revocation still redirects (never-500 posture)', async () => {
    mockSignOut.mockRejectedValue(new Error('SUPABASE_URL / SUPABASE_ANON_KEY are not set'));
    const res = await POST(new Request('https://kids-fun.example/auth/signout', { method: 'POST' }));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://kids-fun.example/');
  });
});
