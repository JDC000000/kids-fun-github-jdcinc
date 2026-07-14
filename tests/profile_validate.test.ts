// tests/profile_validate.test.ts — pure validation for the profile PATCH body.
import { describe, it, expect } from 'vitest';
import {
  parseProfilePatch,
  normalizePostal,
  MAX_CHILD_AGES,
  AGE_MAX_MONTHS,
} from '../lib/user/profile-validate';

describe('normalizePostal', () => {
  it('normalizes case and spacing to canonical A1A 1A1', () => {
    expect(normalizePostal('v6b1a1')).toBe('V6B 1A1');
    expect(normalizePostal('  V6B 1A1 ')).toBe('V6B 1A1');
    expect(normalizePostal('v6b  1a1')).toBe('V6B 1A1');
  });

  it('returns null for empty or malformed input', () => {
    expect(normalizePostal('')).toBeNull();
    expect(normalizePostal('   ')).toBeNull();
    expect(normalizePostal('12345')).toBeNull(); // US ZIP shape
    expect(normalizePostal('V6B 1A')).toBeNull(); // too short
    expect(normalizePostal('not a postal')).toBeNull();
  });
});

describe('parseProfilePatch', () => {
  it('rejects a non-object body', () => {
    expect(parseProfilePatch(null).ok).toBe(false);
    expect(parseProfilePatch('x').ok).toBe(false);
    expect(parseProfilePatch(42).ok).toBe(false);
    expect(parseProfilePatch([]).ok).toBe(false);
  });

  it('rejects an empty patch (no editable field)', () => {
    const r = parseProfilePatch({});
    expect(r.ok).toBe(false);
  });

  it('rejects unknown fields (guards against typos)', () => {
    const r = parseProfilePatch({ homePostal: 'V6B 1A1' }); // wrong key
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown/i);
  });

  it('accepts and normalizes a valid home_postal', () => {
    const r = parseProfilePatch({ home_postal: 'v6b1a1' });
    expect(r).toEqual({ ok: true, value: { home_postal: 'V6B 1A1' } });
  });

  it('treats null / empty-string home_postal as a clear', () => {
    expect(parseProfilePatch({ home_postal: null })).toEqual({ ok: true, value: { home_postal: null } });
    expect(parseProfilePatch({ home_postal: '   ' })).toEqual({ ok: true, value: { home_postal: null } });
  });

  it('rejects an invalid home_postal', () => {
    const r = parseProfilePatch({ home_postal: '90210' });
    expect(r.ok).toBe(false);
  });

  it('rejects a non-string, non-null home_postal', () => {
    expect(parseProfilePatch({ home_postal: 123 }).ok).toBe(false);
  });

  it('accepts a valid saved_child_ages array (months)', () => {
    const r = parseProfilePatch({ saved_child_ages: [0, 18, 216] });
    expect(r).toEqual({ ok: true, value: { saved_child_ages: [0, 18, 216] } });
  });

  it('accepts an empty saved_child_ages array (clear)', () => {
    const r = parseProfilePatch({ saved_child_ages: [] });
    expect(r).toEqual({ ok: true, value: { saved_child_ages: [] } });
  });

  it('rejects non-integer, negative, or out-of-range ages', () => {
    expect(parseProfilePatch({ saved_child_ages: [12.5] }).ok).toBe(false);
    expect(parseProfilePatch({ saved_child_ages: [-1] }).ok).toBe(false);
    expect(parseProfilePatch({ saved_child_ages: [AGE_MAX_MONTHS + 1] }).ok).toBe(false);
    expect(parseProfilePatch({ saved_child_ages: ['3'] }).ok).toBe(false);
    expect(parseProfilePatch({ saved_child_ages: 3 }).ok).toBe(false); // not an array
  });

  it('rejects too many children', () => {
    const many = Array.from({ length: MAX_CHILD_AGES + 1 }, () => 12);
    expect(parseProfilePatch({ saved_child_ages: many }).ok).toBe(false);
  });

  it('accepts a boolean email_opt_in and rejects non-booleans', () => {
    expect(parseProfilePatch({ email_opt_in: true })).toEqual({ ok: true, value: { email_opt_in: true } });
    expect(parseProfilePatch({ email_opt_in: 'yes' }).ok).toBe(false);
    expect(parseProfilePatch({ email_opt_in: 1 }).ok).toBe(false);
  });

  it('accepts a combined multi-field patch', () => {
    const r = parseProfilePatch({ home_postal: 'V6B 1A1', saved_child_ages: [24], email_opt_in: false });
    expect(r).toEqual({
      ok: true,
      value: { home_postal: 'V6B 1A1', saved_child_ages: [24], email_opt_in: false },
    });
  });

  it('only includes supplied keys (PATCH semantics)', () => {
    const r = parseProfilePatch({ email_opt_in: true });
    if (r.ok) {
      expect('home_postal' in r.value).toBe(false);
      expect('saved_child_ages' in r.value).toBe(false);
    }
  });
});
