import { describe, expect, it } from 'vitest';
import {
  classifyPrimaryCategory,
  primaryCategoryKeyForRecord,
  detectCategorySignals,
  classifySecondaryCategories,
  classifySuitabilityTags,
} from '../../worker/core/taxonomy';

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

  // The certainty/source of the primary decision is now the category sub-signal of
  // the BR-13 parse_quality factor (worker/core/confidence.ts) — it replaces the old
  // confidenceLabelForCategory, which conflated category specificity with confidence.
  it('reports how certain the primary decision was, and where it came from', () => {
    const generic = classifyPrimaryCategory({ title: 'Interesting Library Event' });
    expect(generic.key).toBe('class_program');
    expect(generic.certainty).toBe('generic');
    expect(generic.source).toBe('fallback');

    const titleRule = classifyPrimaryCategory({ title: 'Robotics Workshop' });
    expect(titleRule.key).toBe('class_program');
    expect(titleRule.certainty).toBe('specific');
    expect(titleRule.source).toBe('title_rule');

    const hinted = classifyPrimaryCategory({ title: 'Anything', categoryHint: 'public_swim' });
    expect(hinted.source).toBe('hint');
    expect(hinted.certainty).toBe('specific');
  });
});

// ── G-T13-3: secondary categories + suitability tags ──────────────────────────
describe('secondary category + suitability tag classification (G-T13-3)', () => {
  it('detects EVERY genuine category signal, not just the primary winner', () => {
    // Overlapping signals: primarily a swim, but ALSO an open-gym session.
    const record = { title: 'Family Swim & Open Gym Drop-in', categoryHint: 'public_swim' };
    expect(primaryCategoryKeyForRecord(record)).toBe('public_swim');
    expect(detectCategorySignals(record)).toEqual(expect.arrayContaining(['public_swim', 'open_gym']));
    // secondaries = signals minus the primary
    expect(classifySecondaryCategories(record)).toEqual(['open_gym']);
  });

  it('surfaces secondary-only categories that can never be a primary', () => {
    // miniature_train + tobogganing are is_primary_eligible=false in the seed.
    const record = { title: 'Stanley Park Miniature Train & Toboggan Hill Day' };
    expect(primaryCategoryKeyForRecord(record)).toBe('outdoor_park');
    expect(classifySecondaryCategories(record)).toEqual(
      expect.arrayContaining(['miniature_train', 'tobogganing'])
    );
    // and the primary is never repeated as a secondary
    expect(classifySecondaryCategories(record)).not.toContain('outdoor_park');
  });

  it('classifies suitability tags from title words + structured cost', () => {
    expect(
      classifySuitabilityTags({ title: 'Family Swim & Open Gym Drop-in', categoryHint: 'public_swim', costStatus: 'free' })
    ).toEqual(expect.arrayContaining(['drop_in', 'free']));

    // category-implied indoor (mirrors the read-side heuristic)
    expect(classifySuitabilityTags({ title: 'Baby Storytime', costStatus: 'unknown' })).toEqual(
      expect.arrayContaining(['indoor', 'stroller_friendly'])
    );

    // outdoor from title
    expect(classifySuitabilityTags({ title: 'Nature Trail Walk in the Park', costStatus: 'unknown' })).toContain(
      'outdoor'
    );
  });

  it('returns no secondaries/suitability for a trivial single-signal record', () => {
    const record = { title: 'Robotics Workshop', costStatus: 'known' as const };
    expect(classifySecondaryCategories(record)).toEqual([]);
    expect(classifySuitabilityTags(record)).toEqual([]);
  });

  // Regression: category words are leading-\b anchored, so an unrelated word that
  // merely CONTAINS a category word ("Sparks" ⊃ park, "Liverpool" ⊃ pool) must not
  // spuriously write a secondary category or suitability tag row.
  it('does not match category words embedded inside unrelated words', () => {
    const sparks = { title: 'Sparks Craft Club for Kids', categoryHint: 'class_program', costStatus: 'unknown' as const };
    expect(detectCategorySignals(sparks)).not.toContain('outdoor_park');
    expect(classifySecondaryCategories(sparks)).not.toContain('outdoor_park');
    expect(classifySuitabilityTags(sparks)).not.toContain('outdoor');

    const liverpool = { title: 'Liverpool Book Storytime', categoryHint: 'storytime', costStatus: 'unknown' as const };
    expect(detectCategorySignals(liverpool)).not.toContain('public_swim');
    expect(classifySecondaryCategories(liverpool)).not.toContain('public_swim');

    // but a genuine word-start match still fires (parks/parking, swimming)
    expect(detectCategorySignals({ title: 'Riverside Parks Playgroup' })).toContain('outdoor_park');
    expect(detectCategorySignals({ title: 'Swimming Lessons' })).toContain('public_swim');
  });
});
