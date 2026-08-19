// app/search/_lib/profile-default.ts — WHEN a stored child profile is allowed to supply the age
// filter, as one pure function (design §5b, the precedence rules; §10 P2).
//
// This is the whole of the policy. The component that acts on it (../_components/ProfileAgeDefault)
// owns only the mechanics — read storage, build an href, navigate — so the rules that decide
// whether a parent's children silently narrow their results are unit-testable without a DOM, a
// router or a browser, and are stated in ONE place rather than spread through an effect.
//
// PLACEMENT. /search-scoped, like anon-memory.ts and for the same reason: the default applies to
// /search and to nothing else (design §8a lists four surfaces; the home "on now" strip, /preview's
// separate client filter and /api/search's own behaviour are each their own decision and none of
// them is this unit's). The profile STORE is shared (lib/profile/), because it is read by more
// than one surface; this policy is not.
//
// ─── THE RULES, AND WHY EACH ONE IS NOT NEGOTIABLE ───────────────────────────────────────
//
// 1. AN EXPLICIT `age=` IN THE URL ALWAYS WINS. Not "usually", not "unless the profile is newer".
//    The reason is shareability, which is the property /search is built on (params.ts:1-2): if a
//    stored profile could override a link's `age=`, the sender and the receiver would see
//    different results from the same URL, and the receiver would see THEIR child's filter applied
//    to SOMEONE ELSE's link with nothing on the page saying so. That is the shared-device failure
//    ResumeSearch.tsx:11-12 refuses, with a dishonesty break on top.
//
// 2. AN EXPLICIT `age=any` ALSO WINS, and this is the rule that is easy to get wrong. "Any age"
//    and "I have not mentioned age" used to be the same URL; params.ts's ANY_AGE_PARAM note is
//    ~45 lines about why they no longer are, and it names THIS function as the reader that makes
//    the distinction load-bearing. If `anyAge` were read as "no signal, apply the profile
//    anyway", the "Any age" chip — the one control whose entire job is to remove the age filter —
//    would re-apply it, and the parent would tap it, watch nothing change, and conclude the site
//    is broken. Every existing test would still pass. Rule 2 is that defect, closed.
//
// 3. NO PROFILE, OR NO RESOLVABLE BAND, MEANS NO CHANGE. A profile whose children all fail
//    `ageMonthsToBand` (only reachable from a hand-edited blob — the store's own validation
//    rejects a non-integer or negative age on both read and write) derives an EMPTY band list.
//    Materialising that would produce `?age=`, a bare param that parses back to no filter but is
//    a URL nobody asked for and a navigation nobody can see the point of. No bands, no redirect.
//
// ─── WHAT THIS FUNCTION DELIBERATELY DOES NOT DECIDE ─────────────────────────────────────
// "Clear filters" (`CLEARED_FILTERS`) resets `anyAge` to FALSE, i.e. to "nothing has been said
// about age" — its own comment in params.ts says so and says why: clearing a search must not be
// repurposed as a way of ALSO expressing an age opt-out, because that is what the "Any age" chip
// is for and it stays one tap away. Reading that through the rules above, a cleared search
// returns to the DEFAULT VIEW, and for a parent with a profile the default view is their
// children's ages — the profile re-applies. That falls out of rules 1-3 rather than being a
// fourth rule, and it is the behaviour `tests/child_profile_default.test.ts` pins.
//
// It is worth naming the asymmetry it creates, because it is the one thing here a parent could
// find surprising: the "✕" on the Ages token writes `age=any` and therefore sticks, while "Clear
// all" writes a bare URL and therefore does not. "Clear all" is weaker than one of its parts, for
// the age group only. That is the deliberate consequence of a profile being a standing statement
// about WHO a parent is shopping for rather than a filter they applied to THIS search — the
// header bar states it in words on every page and can clear it in one tap, and the on-page note
// (ProfileAgeDefault) says where the filter came from. If that trade is ever re-decided, this
// comment and CLEARED_FILTERS' are the two places that have to move together.

import type { ChildProfile } from '@/lib/profile/child-profile';
import { childrenToAgeBands } from '@/lib/profile/child-age-bands';
import type { AgeBandKey } from '@/lib/search/types';
import type { SearchState } from './params';

/** The age half of the URL state — all this decision reads, so all it asks for. */
export type AgeUrlState = Pick<SearchState, 'ages' | 'anyAge'>;

/**
 * The bands a stored profile should supply for this URL, or `null` for "change nothing".
 *
 * `null` and `[]` are NOT the same answer and the caller must not conflate them: `null` means
 * do not navigate at all. This function never returns an empty array, so there is no empty case
 * to get wrong at the call site.
 */
export function profileDefaultBands(state: AgeUrlState, profile: ChildProfile | null): AgeBandKey[] | null {
  // Rule 1 — an explicit band selection is the parent's own statement about this search.
  if (state.ages.length > 0) return null;
  // Rule 2 — `age=any` is an explicit statement too, and it is the one that says "not my profile".
  if (state.anyAge) return null;
  // Rule 3 — nothing stored, or nothing storable, is not a reason to filter.
  if (!profile) return null;
  const bands = childrenToAgeBands(profile.children);
  return bands.length > 0 ? bands : null;
}

/**
 * Do these two band lists express the same selection? Both come from `AGE_ORDER`-canonical
 * sources (`parseOrderedCsv` for the URL, `childrenToAgeBands` for the profile), so an
 * element-wise compare is exact and no sorting is needed.
 *
 * Used for one thing only: deciding whether the on-page "this came from your profile" note is
 * still TRUE after the parent has changed chips. A note that keeps claiming provenance for a
 * selection the parent has since edited is a small lie, and this page does not tell those.
 */
export function sameBands(a: readonly AgeBandKey[], b: readonly AgeBandKey[]): boolean {
  return a.length === b.length && a.every((band, i) => band === b[i]);
}
