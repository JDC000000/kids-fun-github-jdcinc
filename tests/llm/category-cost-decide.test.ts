// tests/llm/category-cost-decide.test.ts — the PURE category+cost decision (no DB).
// Each field applies independently, only when NEEDED and only at/above its confidence bar;
// cost applies just the concrete 'free'/'known' outcomes. Includes the adversarial
// low-confidence-routes-to-no-op case.
import { describe, expect, it } from 'vitest';
import { decideCategoryCost, type CategoryCostCandidate } from '../../lib/llm/category-cost-fallback';
import type { CategoryCostVerdict } from '../../lib/llm/prompts';

const cand = (over: Partial<CategoryCostCandidate> = {}): CategoryCostCandidate => ({
  occurrenceId: 'occ-1',
  activityName: 'Something',
  description: null,
  needsCategory: true,
  needsCost: true,
  currentCategoryId: null,
  customId: 'catcost-occ-1',
  ...over,
});

const v = (over: Partial<CategoryCostVerdict> = {}): CategoryCostVerdict => ({
  primaryCategory: 'storytime',
  categoryConfidence: 0.9,
  costStatus: 'free',
  costMinCad: 0,
  costMaxCad: 0,
  costConfidence: 0.9,
  reason: 'r',
  ...over,
});

describe('decideCategoryCost — apply each field only when needed and confident', () => {
  it('APPLIES a confident category and a confident free cost', () => {
    const d = decideCategoryCost(cand(), v());
    expect(d.applyCategory).toBe(true);
    expect(d.categoryKey).toBe('storytime');
    expect(d.applyCost).toBe(true);
    expect(d).toMatchObject({ costStatus: 'free', costMinCad: 0, costMaxCad: 0 });
  });

  it('APPLIES a known cost with a valid min/max range', () => {
    const d = decideCategoryCost(cand(), v({ costStatus: 'known', costMinCad: 8, costMaxCad: 20 }));
    expect(d.applyCost).toBe(true);
    expect(d).toMatchObject({ costStatus: 'known', costMinCad: 8, costMaxCad: 20 });
  });

  it('does NOT apply a field the record did not need', () => {
    const catOnly = decideCategoryCost(cand({ needsCost: false }), v({ costStatus: 'known', costMinCad: 8 }));
    expect(catOnly.applyCategory).toBe(true);
    expect(catOnly.applyCost).toBe(false);

    const costOnly = decideCategoryCost(cand({ needsCategory: false }), v());
    expect(costOnly.applyCategory).toBe(false);
    expect(costOnly.applyCost).toBe(true);
  });

  it('ADVERSARIAL: a below-bar confidence routes each field to a no-op (never a guess)', () => {
    const d = decideCategoryCost(cand(), v({ categoryConfidence: 0.79, costConfidence: 0.79, costStatus: 'known', costMinCad: 10 }));
    expect(d.applyCategory).toBe(false);
    expect(d.applyCost).toBe(false);
  });

  it('NO-OPs the category when the model returned null (generic class/program)', () => {
    expect(decideCategoryCost(cand(), v({ primaryCategory: null })).applyCategory).toBe(false);
  });

  it("NO-OPs cost for a 'check_source' hint or a null status (conservative first version)", () => {
    expect(decideCategoryCost(cand(), v({ costStatus: 'check_source' })).applyCost).toBe(false);
    expect(decideCategoryCost(cand(), v({ costStatus: null })).applyCost).toBe(false);
  });

  it("NO-OPs a 'known' cost that lacks a sound minimum, or whose max is below its min", () => {
    expect(decideCategoryCost(cand(), v({ costStatus: 'known', costMinCad: null })).applyCost).toBe(false);
    expect(decideCategoryCost(cand(), v({ costStatus: 'known', costMinCad: 20, costMaxCad: 10 })).applyCost).toBe(false);
  });

  it('NO-OPs everything when there is no usable verdict (errored / unparseable)', () => {
    const d = decideCategoryCost(cand(), null);
    expect(d.applyCategory).toBe(false);
    expect(d.applyCost).toBe(false);
    expect(d.categoryConfidence).toBeNull();
    expect(d.costConfidence).toBeNull();
  });
});
