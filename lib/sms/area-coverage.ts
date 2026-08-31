// lib/sms/area-coverage.ts — which of three worlds a postal code lands in.
//
// PURE, like sparse-areas.ts and for the same stated reason: no engine, no database, no clock, so
// the decision is unit-testable and the live measurement stays where it already lives. The caller
// passes in the sparse set (measured, never hardcoded — see lib/sms/sparse-measure.ts).
//
// ═══ WHY A THIRD FUNCTION RATHER THAN EXTENDING sparseAreaNoticeFor ═══
// That function deliberately returns null for BOTH "well covered" and "out of area", and says so:
// an out-of-area postal is a rejection, and answering it with a "fewer picks some weeks" warning
// "would understate it enormously". It collapses the two cases this one has to tell apart, so
// extending it would mean breaking the distinction it was written to protect.
import { fsaOf, regionIdForPostal, type CoveredRegionId } from '@/lib/geo/postal-fsa';

export type AreaCoverage =
  /** A covered municipality with real depth. Ordinary signup, no waitlist offered. */
  | { kind: 'covered'; regionId: CoveredRegionId }
  /** Covered but thin. Signup still works; the waitlist is an ALTERNATIVE, never a replacement. */
  | { kind: 'sparse'; regionId: CoveredRegionId }
  /** No covered municipality. There is no ordinary path, so the waitlist is all there is. */
  | { kind: 'out_of_area'; fsa: string }
  /** Not a usable postal code yet — still typing, or malformed. Offer nothing. */
  | { kind: 'unknown' };

/**
 * Classify a postal code for the purpose of deciding what to OFFER someone.
 *
 * ⚠ `unknown` is a distinct answer and not a synonym for out-of-area. A parent halfway through
 * typing "V3" has not told us they are outside our coverage, and showing them a waitlist pitch
 * mid-keystroke would be both wrong and alarming. Only a postal code that PARSES and resolves to
 * nothing is out of area.
 *
 * The FSA is returned uppercase and 3 characters, which is the only form the waitlist stores —
 * see migration 0038 for why it is deliberately not the full postal code.
 */
export function classifyPostalCoverage(
  rawPostal: string,
  sparseRegionIds: readonly string[]
): AreaCoverage {
  // `fsaOf` rather than the full-postal validator, and that is deliberate: the FSA alone decides
  // coverage, so the last three characters cannot change this answer. Classifying at three
  // characters is what lets the page tell somebody they are out of area WHILE THEY TYPE, which is
  // Jon's stated requirement — "tell them ASAP when they try and sign up" — rather than after a
  // submit-and-reject round trip.
  const fsa = fsaOf(rawPostal);
  if (!fsa) return { kind: 'unknown' };

  const regionId = regionIdForPostal(fsa);
  if (!regionId) return { kind: 'out_of_area', fsa };

  return sparseRegionIds.includes(regionId)
    ? { kind: 'sparse', regionId }
    : { kind: 'covered', regionId };
}

/** Is the waitlist worth offering for this classification? */
export function offersWaitlist(coverage: AreaCoverage): boolean {
  return coverage.kind === 'sparse' || coverage.kind === 'out_of_area';
}
