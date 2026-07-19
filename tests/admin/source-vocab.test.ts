// tests/admin/source-vocab.test.ts — G-T34-3 pure validation for the source console.
import { describe, expect, it } from 'vitest';
import {
  parseSourceInput,
  cadenceFromSeconds,
  CADENCE_SECONDS,
  CADENCE_OPTIONS,
} from '@/app/admin/sources/_lib/vocab';

const valid: Record<string, string> = {
  family: 'manual',
  name: 'Manual Curation',
  platform: '',
  authorityTier: 'manual',
  termsStatus: 'allowed',
  robotsStatus: 'allowed',
  ingestionMethod: 'manual',
  seasonState: 'unknown',
  healthState: 'healthy',
  baselineCadence: '1 day',
  nearDateCadence: '',
};

describe('parseSourceInput', () => {
  it('accepts a fully valid record and trims/normalises', () => {
    const r = parseSourceInput({ ...valid, family: '  activenet ', platform: '  bibliocommons ' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.family).toBe('activenet');
      expect(r.value.platform).toBe('bibliocommons');
      expect(r.value.nearDateCadence).toBeNull();
    }
  });

  it('requires family and name', () => {
    const r = parseSourceInput({ ...valid, family: '   ', name: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.family).toBeTruthy();
      expect(r.errors.name).toBeTruthy();
    }
  });

  it('rejects values outside the allowed sets', () => {
    const r = parseSourceInput({ ...valid, authorityTier: 'root', termsStatus: 'yes', baselineCadence: '5 minutes' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.authorityTier).toBeTruthy();
      expect(r.errors.termsStatus).toBeTruthy();
      expect(r.errors.baselineCadence).toBeTruthy();
    }
  });

  it('accepts a valid near-date cadence but rejects an invalid one', () => {
    expect(parseSourceInput({ ...valid, nearDateCadence: '2 hours' }).ok).toBe(true);
    expect(parseSourceInput({ ...valid, nearDateCadence: 'someday' }).ok).toBe(false);
  });
});

describe('cadenceFromSeconds', () => {
  it('maps every tier back to its label round-trip', () => {
    for (const opt of CADENCE_OPTIONS) {
      expect(cadenceFromSeconds(CADENCE_SECONDS[opt])).toBe(opt);
    }
  });
  it('returns null for an unknown interval length or null', () => {
    expect(cadenceFromSeconds(12_345)).toBeNull();
    expect(cadenceFromSeconds(null)).toBeNull();
  });
});
