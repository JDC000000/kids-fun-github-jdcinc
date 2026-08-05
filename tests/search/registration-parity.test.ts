// tests/search/registration-parity.test.ts — QA round 139, checklist item 7.
//
// THE PROPERTY UNDER TEST: for every row that carries NO persisted registration fact — which
// is ~99% of the corpus and 100% of the five untouched source families (activenet,
// citycalendar, eventbrite, venue, seasonal, plus library's generic_rss path) — this branch
// must classify EXACTLY as main@95cf47d did. Option A is additive; it may not move a single
// row that has no fact behind it.
//
// This compares against a REAL ORACLE, not a re-implementation: ./__oracles__/
// registration-main-95cf47d.ts is a frozen verbatim `git show` of the baseline classifier.
// Diffing my logic against a second copy of my own logic would prove nothing.
import { describe, expect, it } from 'vitest';
import { hasDropInSignal, isRegistrationShaped } from '../../lib/search/filters/registration';
import { hasDropInSignalMain, isRegistrationShapedMain } from './__oracles__/registration-main-95cf47d';
import CORPUS from './__oracles__/title-corpus.json';

/** Tag shapes that occur on real rows and that the classifier actually reads. */
const TAG_VARIANTS: Array<{ suitabilityTags?: string[]; categoryTags?: string[] }> = [
  {},
  { suitabilityTags: ['drop_in'] },
  { categoryTags: ['drop_in'] },
  { suitabilityTags: ['indoor'] },
  { suitabilityTags: ['rainy_day'], categoryTags: ['class_program'] },
  { suitabilityTags: [], categoryTags: [] },
];

/** Every way a row can carry NO fact. All must behave like main. */
const NO_FACT: Array<null | undefined> = [null, undefined];

describe('registration parity vs main@95cf47d — rows with no persisted fact', () => {
  it('classifies identically across the whole corpus', () => {
    const mismatches: string[] = [];
    let comparisons = 0;

    for (const activityName of CORPUS as string[]) {
      for (const tags of TAG_VARIANTS) {
        const baseline = isRegistrationShapedMain({ activityName, ...tags });
        const baselineDropIn = hasDropInSignalMain({ activityName, ...tags });
        for (const registrationRequired of NO_FACT) {
          comparisons += 2;
          const mine = isRegistrationShaped({ activityName, ...tags, registrationRequired });
          const mineDropIn = hasDropInSignal({ activityName, ...tags, registrationRequired });
          if (mine !== baseline) {
            mismatches.push(`isRegistrationShaped("${activityName}", ${JSON.stringify(tags)}, ${registrationRequired}): main=${baseline} branch=${mine}`);
          }
          if (mineDropIn !== baselineDropIn) {
            mismatches.push(`hasDropInSignal("${activityName}", ${JSON.stringify(tags)}, ${registrationRequired}): main=${baselineDropIn} branch=${mineDropIn}`);
          }
        }
      }
    }

    // Reported so the number is visible in CI rather than asserted blind — a corpus that
    // silently shrank to zero would otherwise "pass".
    // eslint-disable-next-line no-console
    console.log(`[parity] ${comparisons} comparisons over ${(CORPUS as string[]).length} titles x ${TAG_VARIANTS.length} tag shapes x ${NO_FACT.length} no-fact spellings`);
    expect(comparisons).toBeGreaterThan(2_000);
    expect(mismatches).toEqual([]);
  });

  it('and DIVERGES from main exactly where a fact exists — the parity must not be vacuous', () => {
    // If the branch agreed with main everywhere, Option A would be doing nothing at all.
    // These are the only two inputs that may differ, and they must.
    const storytime = { activityName: 'Baby Storytime' };
    expect(isRegistrationShapedMain(storytime)).toBe(false);
    expect(isRegistrationShaped({ ...storytime, registrationRequired: true })).toBe(true);

    const camp = { activityName: 'Frozen Ballet Dance Camp 3-5yrs' };
    expect(isRegistrationShapedMain(camp)).toBe(true);
    expect(isRegistrationShaped({ ...camp, registrationRequired: false })).toBe(false);
  });
});
