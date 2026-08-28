// lib/sms/sparse-areas.ts — "we're just getting started in your area", decided honestly.
//
// DRAFT (SMS pivot). Pure: postal code + a set of thin municipalities in, a notice or null out.
// No engine, no database, no clock — so the copy decision is unit-testable and the measurement
// that feeds it stays where it already lives.
//
// ── THE PRD SAYS "STATIC LOOKUP". THE CODEBASE ALREADY ARGUES AGAINST ONE. ───────────────
// PRD §2.1 asks for a "static lookup" of the two known low-density launch municipalities. But
// lib/search/coverage.ts already answers this exact question for /search, and its header
// explicitly rejects the static version, in terms that apply here word for word:
//
//     "It is deliberately NOT a per-region allowlist of West Van and Burnaby. Naming the two
//      municipalities that happen to be thin today would go stale silently in both directions:
//      a region that gains coverage would keep apologising for itself, and a region that loses
//      its only source would go back to lying."
//
// That is a stronger argument here than there, because this notice is shown at the moment of
// SIGNUP. A hardcoded list that has gone stale in the first direction talks a parent out of a
// product that would have worked for them; stale in the second, it takes their consent without
// the warning that was the whole reason the notice exists.
//
// SO THE SPARSE SET IS AN ARGUMENT, NOT A CONSTANT. The caller measures — `SearchResponse
// .regionCoverage` is the engine's own live count over the whole catalogue, no query constraint
// applied — and passes the result in. Same pattern `parseRegionNotifyBody` uses for the region
// allowlist, and for the same reason: one vocabulary, measured in one place.
//
// The static list survives only as `SPARSE_FALLBACK_REGION_IDS`, for the one case where the
// measurement is genuinely unavailable. See its own comment for why a fallback is the right
// answer there and a default is not.

import { regionIdForPostal, REGION_LABEL, type CoveredRegionId } from '@/lib/geo/postal-fsa';
import type { RegionCoverage } from '@/lib/search/coverage';
import { SPARSE_AREA_NOTICE } from './consent-copy';

/**
 * The two municipalities known to be thin at the time of writing — used ONLY when the live
 * measurement could not be taken (`getServerSearchEngine()` returned null: no database, or a
 * failed load).
 *
 * WHY FALL BACK TO A WARNING RATHER THAN TO SILENCE. The two options when the measurement is
 * missing are "warn nobody" and "warn the areas we last knew were thin". The first is silently
 * wrong for a West Vancouver parent in exactly the way that costs a signup and then a churn; the
 * second is at worst an over-warning that mildly undersells a municipality. Those costs are not
 * symmetric, so the fallback errs toward saying something.
 *
 * It is a FALLBACK and not a default: nothing reads this while the catalogue is reachable.
 */
export const SPARSE_FALLBACK_REGION_IDS: readonly CoveredRegionId[] = ['wvan', 'bby'];

export interface SparseAreaNotice {
  regionId: CoveredRegionId;
  /** "West Vancouver" — the municipality by name, for copy that names it. */
  regionName: string;
  /** The sentence to render. PRD §2.1 wording; see lib/sms/consent-copy.ts. */
  copy: string;
}

/**
 * Should this postal code see the "just getting started in your area" notice?
 *
 * Returns null for the ordinary case — a well-covered area, or a postal code that resolves to no
 * covered municipality at all. The second of those is NOT this function's problem to report: an
 * out-of-area postal is a rejection handled by `parseSmsSignupBody`, and answering it with a
 * "fewer picks some weeks" warning would understate it enormously.
 */
export function sparseAreaNoticeFor(
  postal: string | null | undefined,
  sparseRegionIds: readonly string[]
): SparseAreaNotice | null {
  const regionId = regionIdForPostal(postal);
  if (!regionId) return null;
  if (!sparseRegionIds.includes(regionId)) return null;
  return { regionId, regionName: REGION_LABEL[regionId], copy: SPARSE_AREA_NOTICE };
}

/**
 * Which covered municipalities the LIVE catalogue currently reports as thin, or null when the
 * measurement was not available.
 *
 * The input is `SearchResponse.regionCoverage` — the engine's own count of distinct activities in
 * each selected region's subtree with NO query constraint applied, and its own `sparse` verdict
 * against `SPARSE_REGION_MAX_ACTIVITIES`. This function re-derives neither: it filters and maps.
 * A threshold restated here would be a second opinion about the same question, free to disagree
 * with the notice /search shows for the same municipality on the same day.
 *
 * NULL vs [] is the load-bearing distinction, and it is the same one lib/search/server-engine.ts
 * makes by returning null rather than an empty engine. `[]` means "we measured, nothing is thin".
 * `null` means "we could not measure" — and the caller must answer those differently, because
 * treating an unavailable measurement as "nothing is thin" silently withdraws the warning from
 * the exact municipalities it exists for.
 */
export function sparseRegionIdsFrom(
  coverage: RegionCoverage[] | null | undefined
): CoveredRegionId[] | null {
  if (coverage == null) return null;
  return coverage.filter((c) => c.sparse).map((c) => c.chipId as CoveredRegionId);
}
