import { describe, it, expect } from 'vitest';
import { getOrCreateAnonId, resolveSessionContext } from '../lib/db/session';

// G-T6-2 — anonymous session context (TSD §3A.1 NR-03/04).
describe('anonymous session context (G-T6-2)', () => {
  it('mints a new UUID when no cookie is present', () => {
    const id = getOrCreateAnonId(undefined);
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('mints a new UUID for a malformed cookie value', () => {
    const id = getOrCreateAnonId('not-a-uuid');
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('reuses an existing well-formed UUID', () => {
    const existing = '11111111-1111-1111-1111-111111111111';
    expect(getOrCreateAnonId(existing)).toBe(existing);
  });

  it('an anonymous request (no session, no cookie) still resolves — search/browse never requires auth', () => {
    const ctx = resolveSessionContext(undefined, null);
    expect(ctx.isAuthenticated).toBe(false);
    expect(ctx.userId).toBeNull();
    expect(ctx.anonId).toBeTruthy();
  });

  it('an authenticated request carries the userId through', () => {
    const ctx = resolveSessionContext('11111111-1111-1111-1111-111111111111', 'user-123');
    expect(ctx.isAuthenticated).toBe(true);
    expect(ctx.userId).toBe('user-123');
    expect(ctx.anonId).toBe('11111111-1111-1111-1111-111111111111');
  });
});
