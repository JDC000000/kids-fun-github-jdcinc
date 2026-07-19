// tests/admin/corrections-vocab.test.ts — G-T34-7 pure validation for resolve.
import { describe, expect, it } from 'vitest';
import { parseResolveInput, MAX_RESOLUTION_NOTE } from '@/app/admin/corrections/_lib/vocab';

describe('parseResolveInput', () => {
  it('accepts a valid resolution and normalises an empty note to null', () => {
    const r = parseResolveInput({ statusState: 'confirmed', confidenceLabel: 'high', resolutionNote: '   ' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.statusState).toBe('confirmed');
      expect(r.value.confidenceLabel).toBe('high');
      expect(r.value.resolutionNote).toBeNull();
    }
  });

  it('keeps a real note', () => {
    const r = parseResolveInput({ statusState: 'cancelled', confidenceLabel: 'low', resolutionNote: 'Venue confirmed cancelled.' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.resolutionNote).toBe('Venue confirmed cancelled.');
  });

  it('requires a health state', () => {
    const r = parseResolveInput({ statusState: '', confidenceLabel: 'high' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.statusState).toBeTruthy();
  });

  it('rejects an invalid confidence label', () => {
    const r = parseResolveInput({ statusState: 'confirmed', confidenceLabel: 'super-high' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.confidenceLabel).toBeTruthy();
  });

  it('rejects an over-long note', () => {
    const r = parseResolveInput({ statusState: 'confirmed', confidenceLabel: 'high', resolutionNote: 'x'.repeat(MAX_RESOLUTION_NOTE + 1) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.resolutionNote).toBeTruthy();
  });
});
