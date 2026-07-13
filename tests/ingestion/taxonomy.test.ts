import { describe, expect, it } from 'vitest';
import { primaryCategoryKeyForRecord } from '../../worker/core/taxonomy';

describe('ingest taxonomy scaffolding', () => {
  it('honours explicit primary category hints from structured adapters', () => {
    expect(primaryCategoryKeyForRecord({ title: 'Anything', categoryHint: 'storytime' })).toBe('storytime');
    expect(primaryCategoryKeyForRecord({ title: 'Anything', categoryHint: 'indoor_play' })).toBe('indoor_play');
  });

  it('falls back to deterministic title rules for clear launch categories', () => {
    expect(primaryCategoryKeyForRecord({ title: 'Family Storytime' })).toBe('storytime');
    expect(primaryCategoryKeyForRecord({ title: 'DUPLO Free Play' })).toBe('indoor_play');
    expect(primaryCategoryKeyForRecord({ title: 'Family Public Swim' })).toBe('public_swim');
    expect(primaryCategoryKeyForRecord({ title: 'Preschool Open Gym' })).toBe('open_gym');
  });
});
