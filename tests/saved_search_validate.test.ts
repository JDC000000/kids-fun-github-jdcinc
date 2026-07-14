// tests/saved_search_validate.test.ts — parseSavedSearchCreate unit tests (Task 38).
// Pure validator, no DB. Mirrors tests/profile_validate.test.ts in posture.
import { describe, it, expect } from 'vitest';
import {
  parseSavedSearchCreate,
  MAX_NAME_LEN,
  MAX_PARAMS_BYTES,
  MAX_PARAMS_KEYS,
} from '../lib/user/saved-search-validate';

describe('parseSavedSearchCreate', () => {
  it('accepts a name + params and trims the name', () => {
    const r = parseSavedSearchCreate({ name: '  Toddler swim  ', params: { q: 'swim' } });
    expect(r).toEqual({ ok: true, value: { name: 'Toddler swim', params: { q: 'swim' } } });
  });

  it('treats an absent/empty/whitespace name as null', () => {
    expect(parseSavedSearchCreate({ params: { q: 'x' } })).toMatchObject({ ok: true, value: { name: null } });
    expect(parseSavedSearchCreate({ name: '', params: { q: 'x' } })).toMatchObject({ ok: true, value: { name: null } });
    expect(parseSavedSearchCreate({ name: '   ', params: { q: 'x' } })).toMatchObject({ ok: true, value: { name: null } });
    expect(parseSavedSearchCreate({ name: null, params: { q: 'x' } })).toMatchObject({ ok: true, value: { name: null } });
  });

  it('rejects a non-object body', () => {
    expect(parseSavedSearchCreate(null)).toEqual({ ok: false, error: 'body must be a JSON object' });
    expect(parseSavedSearchCreate('nope')).toMatchObject({ ok: false });
    expect(parseSavedSearchCreate([1, 2])).toMatchObject({ ok: false });
  });

  it('rejects unknown fields (guards typos)', () => {
    const r = parseSavedSearchCreate({ params: { q: 'x' }, nope: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown field/);
  });

  it('rejects a non-string name', () => {
    expect(parseSavedSearchCreate({ name: 42, params: { q: 'x' } })).toMatchObject({ ok: false });
  });

  it('rejects an over-long name', () => {
    const r = parseSavedSearchCreate({ name: 'a'.repeat(MAX_NAME_LEN + 1), params: { q: 'x' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/characters or fewer/);
  });

  it('requires params', () => {
    expect(parseSavedSearchCreate({ name: 'x' })).toEqual({ ok: false, error: 'params is required' });
  });

  it('rejects params that is not a plain object', () => {
    expect(parseSavedSearchCreate({ params: 'q=swim' })).toMatchObject({ ok: false });
    expect(parseSavedSearchCreate({ params: [1] })).toMatchObject({ ok: false });
    expect(parseSavedSearchCreate({ params: null })).toMatchObject({ ok: false });
  });

  it('rejects empty params (nothing to search)', () => {
    const r = parseSavedSearchCreate({ params: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/at least one/);
  });

  it('rejects params with too many keys', () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_PARAMS_KEYS; i++) many[`k${i}`] = i;
    expect(parseSavedSearchCreate({ params: many })).toMatchObject({ ok: false });
  });

  it('rejects params that is too large', () => {
    const big = { blob: 'x'.repeat(MAX_PARAMS_BYTES + 1) };
    const r = parseSavedSearchCreate({ params: big });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/too large/);
  });

  it('preserves a richer params object', () => {
    const params = { q: 'open gym', region: 'van', sort: 'soonest', includeUnknownCost: true, limit: 20 };
    const r = parseSavedSearchCreate({ name: 'Gym', params });
    expect(r).toEqual({ ok: true, value: { name: 'Gym', params } });
  });
});
