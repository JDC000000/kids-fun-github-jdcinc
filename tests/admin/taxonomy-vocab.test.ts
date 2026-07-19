// tests/admin/taxonomy-vocab.test.ts — G-T34-4 pure vocab/validator tests (no DB).
import { describe, expect, it } from 'vitest';
import {
  parseRegionInput,
  parseCategoryInput,
  parseAliasInput,
  parseCheckbox,
  decodeAliasTarget,
  encodeAliasTarget,
  isUuid,
  REGION_LEVELS,
} from '@/app/admin/taxonomy/_lib/vocab';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('parseRegionInput (G-T34-4)', () => {
  it('accepts a valid region with a parent', () => {
    const r = parseRegionInput({ name: 'Burnaby', level: 'municipality', parentId: UUID });
    expect(r).toEqual({ ok: true, value: { name: 'Burnaby', level: 'municipality', parentId: UUID } });
  });

  it('treats a blank parent as top-level (null)', () => {
    const r = parseRegionInput({ name: 'Metro Vancouver', level: 'metro', parentId: '' });
    expect(r.ok && r.value.parentId).toBeNull();
  });

  it('rejects an empty name, a bad level, and a non-uuid parent', () => {
    const r = parseRegionInput({ name: '  ', level: 'planet', parentId: 'not-a-uuid' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.name).toBeDefined();
      expect(r.errors.level).toBeDefined();
      expect(r.errors.parentId).toBeDefined();
    }
  });

  it('offers exactly the three DB-legal levels', () => {
    expect([...REGION_LEVELS]).toEqual(['metro', 'municipality', 'sub_area']);
  });
});

describe('parseCategoryInput (G-T34-4)', () => {
  it('accepts a valid slug key + label + checkbox', () => {
    const r = parseCategoryInput({ key: 'open_gym', label: 'Open Gym', isPrimaryEligible: 'true' });
    expect(r).toEqual({ ok: true, value: { key: 'open_gym', label: 'Open Gym', isPrimaryEligible: true } });
  });

  it('defaults an absent checkbox to false', () => {
    const r = parseCategoryInput({ key: 'k', label: 'L' });
    expect(r.ok && r.value.isPrimaryEligible).toBe(false);
  });

  it('rejects a non-slug key (spaces/uppercase)', () => {
    const r = parseCategoryInput({ key: 'Open Gym', label: 'Open Gym' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.key).toMatch(/lowercase/);
  });

  it('rejects an empty label', () => {
    const r = parseCategoryInput({ key: 'valid_key', label: '   ' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.label).toBeDefined();
  });
});

describe('parseCheckbox', () => {
  it('reads on/true/1/yes as true and everything else as false', () => {
    for (const v of ['on', 'true', '1', 'yes', 'TRUE']) expect(parseCheckbox(v)).toBe(true);
    for (const v of ['', 'off', 'false', '0', undefined]) expect(parseCheckbox(v)).toBe(false);
  });
});

describe('alias target encode/decode', () => {
  it('round-trips a category target', () => {
    const enc = encodeAliasTarget({ kind: 'category', id: UUID });
    expect(enc).toBe(`category:${UUID}`);
    expect(decodeAliasTarget(enc)).toEqual({ kind: 'category', id: UUID });
  });
  it('round-trips a tag target', () => {
    expect(decodeAliasTarget(`tag:${UUID}`)).toEqual({ kind: 'tag', id: UUID });
  });
  it('rejects a bad kind, missing colon, or non-uuid id', () => {
    expect(decodeAliasTarget('venue:' + UUID)).toBeNull();
    expect(decodeAliasTarget(UUID)).toBeNull();
    expect(decodeAliasTarget('category:nope')).toBeNull();
    expect(decodeAliasTarget(undefined)).toBeNull();
  });
});

describe('parseAliasInput (G-T34-4)', () => {
  it('accepts an alias phrase mapped to a category', () => {
    const r = parseAliasInput({ aliasText: 'family drop-in', target: `category:${UUID}` });
    expect(r).toEqual({ ok: true, value: { aliasText: 'family drop-in', target: { kind: 'category', id: UUID } } });
  });
  it('rejects an empty phrase and a missing target', () => {
    const r = parseAliasInput({ aliasText: '', target: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.aliasText).toBeDefined();
      expect(r.errors.target).toBeDefined();
    }
  });
});

describe('isUuid', () => {
  it('accepts a v4 uuid and rejects junk', () => {
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid('nope')).toBe(false);
    expect(isUuid(null)).toBe(false);
  });
});
