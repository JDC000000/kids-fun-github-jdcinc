// tests/saved_searches_route.test.ts — /api/saved-searches contract, no database.
//
// Mocks the session resolver and the DB helpers so each route's branching
// (anonymous / bad JSON / invalid field / success / DB failure / not-found) is
// exercised deterministically. Real parseSavedSearchCreate runs, so validation is
// covered end-to-end through POST. The DB ownership LOGIC is proven separately in
// tests/saved_search_crud.test.ts against a real Postgres.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const UID = '11111111-1111-1111-1111-111111111111';
const SEARCH_ID = '22222222-2222-2222-2222-222222222222';

const mockGetRequestUser = vi.fn();
const mockList = vi.fn();
const mockCreate = vi.fn();
const mockDelete = vi.fn();

vi.mock('@/lib/db/session-user', () => ({
  getRequestUser: (...args: unknown[]) => mockGetRequestUser(...args),
}));

vi.mock('@/lib/db/saved-search', () => ({
  listSavedSearches: (...args: unknown[]) => mockList(...args),
  createSavedSearch: (...args: unknown[]) => mockCreate(...args),
  deleteSavedSearch: (...args: unknown[]) => mockDelete(...args),
}));

import { GET, POST } from '../app/api/saved-searches/route';
import { DELETE } from '../app/api/saved-searches/[id]/route';

function postReq(body: string): Request {
  return new Request('http://localhost/api/saved-searches', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

function delReq(): Request {
  return new Request('http://localhost/api/saved-searches/x', { method: 'DELETE' });
}

beforeEach(() => {
  mockGetRequestUser.mockReset();
  mockList.mockReset();
  mockCreate.mockReset();
  mockDelete.mockReset();
});

describe('GET /api/saved-searches', () => {
  it('401s an anonymous request and never reads', async () => {
    mockGetRequestUser.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('returns the current user’s saved searches', async () => {
    mockGetRequestUser.mockResolvedValue({ userId: UID, email: 'p@example.com' });
    const list = [{ id: SEARCH_ID, name: 'Gym', params: { q: 'gym' }, created_at: 't', last_run_at: null }];
    mockList.mockResolvedValue(list);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, savedSearches: list });
    expect(mockList).toHaveBeenCalledWith(UID);
  });

  it('500s (generic) when the read throws', async () => {
    mockGetRequestUser.mockResolvedValue({ userId: UID, email: null });
    mockList.mockRejectedValue(new Error('USER_DATABASE_URL is not set'));
    const res = await GET();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'could not load saved searches' });
  });
});

describe('POST /api/saved-searches', () => {
  it('401s an anonymous request and never writes', async () => {
    mockGetRequestUser.mockResolvedValue(null);
    const res = await POST(postReq(JSON.stringify({ params: { q: 'x' } })));
    expect(res.status).toBe(401);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('400s on invalid JSON', async () => {
    mockGetRequestUser.mockResolvedValue({ userId: UID, email: null });
    const res = await POST(postReq('{not json'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid json/i);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('400s on an unknown field and never writes', async () => {
    mockGetRequestUser.mockResolvedValue({ userId: UID, email: null });
    const res = await POST(postReq(JSON.stringify({ params: { q: 'x' }, oops: 1 })));
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('400s on empty params and never writes', async () => {
    mockGetRequestUser.mockResolvedValue({ userId: UID, email: null });
    const res = await POST(postReq(JSON.stringify({ params: {} })));
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('creates a validated saved search and returns 201', async () => {
    mockGetRequestUser.mockResolvedValue({ userId: UID, email: 'p@example.com' });
    const created = { id: SEARCH_ID, name: 'Gym', params: { q: 'gym' }, created_at: 't', last_run_at: null };
    mockCreate.mockResolvedValue(created);
    const res = await POST(postReq(JSON.stringify({ name: '  Gym  ', params: { q: 'gym' } })));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, savedSearch: created });
    // name trimmed by the validator before the DB layer saw it.
    expect(mockCreate).toHaveBeenCalledWith(UID, { name: 'Gym', params: { q: 'gym' } });
  });

  it('500s (generic) when the write throws', async () => {
    mockGetRequestUser.mockResolvedValue({ userId: UID, email: null });
    mockCreate.mockRejectedValue(new Error('boom'));
    const res = await POST(postReq(JSON.stringify({ params: { q: 'x' } })));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'could not save search' });
  });
});

describe('DELETE /api/saved-searches/:id', () => {
  it('401s an anonymous request and never deletes', async () => {
    mockGetRequestUser.mockResolvedValue(null);
    const res = await DELETE(delReq(), { params: { id: SEARCH_ID } });
    expect(res.status).toBe(401);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('400s on a non-UUID id and never deletes', async () => {
    mockGetRequestUser.mockResolvedValue({ userId: UID, email: null });
    const res = await DELETE(delReq(), { params: { id: 'not-a-uuid' } });
    expect(res.status).toBe(400);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('404s when nothing was deleted (missing or another user’s row)', async () => {
    mockGetRequestUser.mockResolvedValue({ userId: UID, email: null });
    mockDelete.mockResolvedValue(false);
    const res = await DELETE(delReq(), { params: { id: SEARCH_ID } });
    expect(res.status).toBe(404);
    expect(mockDelete).toHaveBeenCalledWith(UID, SEARCH_ID);
  });

  it('200s when a row was deleted', async () => {
    mockGetRequestUser.mockResolvedValue({ userId: UID, email: null });
    mockDelete.mockResolvedValue(true);
    const res = await DELETE(delReq(), { params: { id: SEARCH_ID } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: SEARCH_ID });
  });

  it('500s (generic) when delete throws', async () => {
    mockGetRequestUser.mockResolvedValue({ userId: UID, email: null });
    mockDelete.mockRejectedValue(new Error('boom'));
    const res = await DELETE(delReq(), { params: { id: SEARCH_ID } });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'could not delete saved search' });
  });
});
