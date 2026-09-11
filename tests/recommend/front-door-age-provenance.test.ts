// T1.4 — the front-door gate is re-armed by the adapter fix, and must not be "fixed" itself.
//
// ═══ WHAT THIS FILE IS FOR ═══
// `isShowableOnFrontDoor` was investigated as the suspected cause of adult content reaching a
// toddler's picks, and cleared: it is a correct gate that was being lied to. Its comment used to
// promise that "a genuinely resolved all-ages listing holds 0" — a guarantee it cannot provide,
// because a genuine all-ages row and one manufactured from a vendor booking flag were
// `(0, null, 'all-ages')` in BOTH cases, byte-identical on every field the predicate can see.
//
// T1.1 moved the decision to the only layer that still had the provenance — the adapter. These
// tests pin both directions of that contract from the ADAPTER through to the GATE, because each
// half alone would pass while the product was broken:
//
//   · the manufactured claim must now arrive as `ageMinMonths: null` and be DROPPED;
//   · the source's own claim must still arrive as `0` and be SHOWN.
//
// The second test is the important one, and it is deliberately adversarial. The obvious "fix"
// for this gate — widening it to `ageMaxMonths == null`, or to `min === 0 && max === null` —
// describes exactly what a GENUINE all-ages listing looks like. It would drop real children's
// content from both surfaces to fix a defect that lives upstream and would still be in the data
// afterwards. If a future reader tries it, this file fails.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { resolveAgeText } from '../../worker/adapters/perfectmind/parse';
import { parseAgeText } from '../../worker/core/age';
import { isShowableOnFrontDoor, type FrontDoorSignalInput } from '../../lib/recommend/three-things';
import type { BookMe4Class } from '../../worker/adapters/perfectmind/client';

/**
 * The real chain, not a hand-built row: adapter verdict → age normaliser → the shape the gate
 * actually receives. Hand-writing `ageMinMonths` here would let the two halves drift and would
 * prove nothing about whether T1.1 reaches the gate.
 */
function throughTheAdapter(EventName: string, over: Partial<BookMe4Class> = {}): FrontDoorSignalInput {
  const verdict = resolveAgeText({ EventName, NoAgeRestriction: true, ...over } as BookMe4Class);
  const age = verdict.ageText ? parseAgeText(verdict.ageText) : null;
  return {
    statusState: 'confirmed',
    activityName: EventName,
    ageMinMonths: age?.ageMinMonths ?? null,
    ageMaxMonths: age?.ageMaxMonths ?? null,
    ageNotes: age?.notes ?? null,
  };
}

describe('a manufactured all-ages claim is dropped (T1.1 re-arms the gate)', () => {
  // The Finding-4 population, verbatim: adult programmes that carried the vendor flag, had no
  // age anywhere in their own copy, and were delivered as confirmed matches for a toddler.
  const FINDING_4 = [
    'Tai Chi Chuan - Beginners',
    'Pickleball - 3.0+',
    'Roundhouse Community Dancers',
    'Lengths',
    'Lane Swim Delbrook',
    'Recreational Line Dancing',
  ];

  for (const title of FINDING_4) {
    it(`${title}: no age claim survives the adapter, and the gate drops it`, () => {
      const listing = throughTheAdapter(title);
      // The T1.4 acceptance criterion, stated exactly: null, not 0.
      expect(listing.ageMinMonths, 'the manufactured claim must not reach the read model').toBeNull();
      expect(isShowableOnFrontDoor(listing), 'excluded from the homepage AND the SMS picks').toBe(false);
    });
  }

  it('drops it on the AGE gate specifically, not incidentally on the adult-title gate', () => {
    // "Lengths" and "Lane Swim" carry no adult vocabulary at all — isAdultOrSeniorOnly does not
    // fire on them. If this assertion ever fails, these rows are being caught by a different
    // gate and this file would be silently testing nothing about T1.1.
    const listing = throughTheAdapter('Lengths');
    expect(listing.ageMinMonths).toBeNull();
    expect(isShowableOnFrontDoor({ ...listing, ageMinMonths: 0, ageMaxMonths: null })).toBe(true);
  });
});

describe('a genuine, source-published all-ages claim is STILL SHOWN', () => {
  // Two real measured NVRC records. The venue published "All Ages" as its own title copy, so the
  // claim is the source's and survives T1.1's suppression by the carve-out in resolveAgeText.
  const GENUINE = [
    '$2 Queer All Ages Skate Karen Magnussen Monday 2:30-3:45pm',
    '$2 Queer All Ages Swim Karen Magnussen Saturday 6:30-8:00pm',
  ];

  for (const title of GENUINE) {
    it(`${title}: keeps its claim and stays on both surfaces`, () => {
      const listing = throughTheAdapter(title);
      expect(listing.ageMinMonths, 'the source said all ages; that is its claim to make').toBe(0);
      expect(listing.ageMaxMonths).toBeNull();
      expect(isShowableOnFrontDoor(listing), 'MUST stay on the homepage and in the SMS picks').toBe(true);
    });
  }

  it('THE GUARD: the shape a genuine all-ages row has is exactly what a widened gate would drop', () => {
    // Spelled out because the harmful patch is the intuitive one. A reader who "tightens" this
    // gate to also reject `ageMaxMonths == null`, or the `0 + null` pair, is describing this row.
    const genuine = throughTheAdapter(GENUINE[0]);
    expect(genuine.ageMinMonths === 0 && genuine.ageMaxMonths === null).toBe(true);
    expect(isShowableOnFrontDoor(genuine)).toBe(true);
  });
});

describe('both surfaces still route through this one gate', () => {
  // The predicate is shared, so the tests above cover the homepage and the SMS picks at once —
  // but only while both surfaces actually call it. That is a source-level fact, and it is the
  // one way this file could silently stop covering a surface.
  it.each([
    ['homepage', 'lib/recommend/three-things.ts'],
    ['weekly SMS picks', 'lib/sms/weekly-picks.ts'],
  ])('%s filters on isShowableOnFrontDoor', (_surface, file) => {
    expect(fs.readFileSync(file, 'utf8')).toContain('.filter((item) => isShowableOnFrontDoor(item.listing))');
  });
});
