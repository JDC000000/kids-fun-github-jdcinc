// tests/account_export_route.test.ts — GET /api/account/export contract, no DB.
//
// Mocks the session resolver and the export helper so the route's branching
// (anonymous / success-as-download / read-failure) is exercised deterministically.
// The export LOGIC + RLS isolation are proven separately in
// tests/account_data_export.test.ts against a real Postgres.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const UID = '11111111-1111-1111-1111-111111111111';

const mockGetRequestUser = vi.fn();
const mockExportUserData = vi.fn();

vi.mock('@/lib/db/session-user', () => ({
  getRequestUser: (...args: unknown[]) => mockGetRequestUser(...args),
}));

vi.mock('@/lib/db/account-data', () => ({
  exportUserData: (...args: unknown[]) => mockExportUserData(...args),
}));

import { GET } from '../app/api/account/export/route';

describe('GET /api/account/export', () => {
  beforeEach(() => {
    mockGetRequestUser.mockReset();
    mockExportUserData.mockReset();
  });

  it('rejects an anonymous request with 401 and never reads data', async () => {
    mockGetRequestUser.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'not signed in' });
    expect(mockExportUserData).not.toHaveBeenCalled();
  });

  it('returns 200 as a downloadable, non-cacheable JSON attachment', async () => {
    mockGetRequestUser.mockResolvedValue({ userId: UID, email: 'p@example.com' });
    const doc = {
      format: 'kids-fun/account-export',
      version: 1,
      exported_at: '2026-07-16T12:34:56.000Z',
      user_id: UID,
      manifest: { included: [], excluded: [] },
      data: { profile: null, saved_searches: [] },
    };
    mockExportUserData.mockResolvedValue(doc);

    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="kids-fun-account-export-2026-07-16.json"'
    );
    expect(res.headers.get('cache-control')).toBe('no-store');

    const body = await res.json();
    expect(body.user_id).toBe(UID);
    expect(mockExportUserData).toHaveBeenCalledWith(UID);
  });

  it('returns 500 with a generic message when the export read throws', async () => {
    mockGetRequestUser.mockResolvedValue({ userId: UID, email: 'p@example.com' });
    mockExportUserData.mockRejectedValue(new Error('USER_DATABASE_URL is not set'));

    const res = await GET();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/could not build/i);
  });
});
