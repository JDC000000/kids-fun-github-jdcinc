// lib/audit/tags.ts — re-derive suitability tags under the POST-FIX rule, so one run can
// report the delta.
//
// WHY THIS FILE EXISTS AT ALL
// A specialist on `fix/kf-safety-tagging` is fixing the root cause of pattern 1:
// `suitabilityTags()` in lib/search/postgres-repository.ts adds `indoor` for the CATCH-ALL
// `class_program` category, so every listing the classifier could not place renders
// "Indoor / Rainy-day friendly". Against today's catalogue that is 3,177 of 4,874 rows, and an
// auditor run against as-served data would report a number dominated by that one bug.
//
// Rather than wait for the fix to ship to measure anything, the auditor can re-derive the tag
// set the fixed code WOULD produce and run the identical rule set over both. Two numbers out
// of one pass:
//   • as_served — what a visitor sees on production right now.
//   • post_fix  — what they would see with the catch-all arm removed.
// The difference is an independent measurement of that fix, computed from production data by
// code that does not import the branch being fixed. If post_fix does not collapse pattern 1 to
// the genuinely-mislabelled rows, the fix is incomplete and this says so before it ships.
//
// This is a MODEL of the fix, not the fix. It is deliberately not exported to anything the app
// renders, and it does not modify lib/search/postgres-repository.ts — that file is owned by the
// in-flight branch and touching it here would create exactly the conflict the coordination was
// meant to avoid.

/**
 * The categories that genuinely imply indoors. This is the current rule MINUS the
 * `class_program` catch-all arm — i.e. the shape the fix is expected to take. If the shipped
 * fix chooses a different remedy (e.g. dropping the derivation entirely, or gating on venue),
 * update this constant and re-run; the delta stays meaningful because the rules never change.
 */
const POST_FIX_INDOOR_CATEGORIES = new Set(['storytime', 'indoor_play']);

/** The current, un-fixed rule, restated so tests can pin the as-served baseline. */
const CURRENT_INDOOR_CATEGORIES = new Set(['storytime', 'indoor_play', 'class_program']);

export type TagMode = 'as_served' | 'post_fix';

/**
 * Recover the raw tag keys the repository started from. `categoryTags` is built as
 * `unique([categoryKey, ...tagKeys])`, so removing the category key gives the tag keys back —
 * which is what both the current and post-fix `suitabilityTags()` take as their base set.
 */
export function tagKeysFrom(categoryTags: string[], primaryCategoryKey: string): string[] {
  return categoryTags.filter((t) => t !== primaryCategoryKey);
}

/**
 * Suitability tags under the given mode. `as_served` reproduces today's production behaviour
 * (used as a self-check that the reconstruction from `categoryTags` is faithful); `post_fix`
 * models the fix.
 */
export function suitabilityTagsForMode(
  categoryTags: string[],
  primaryCategoryKey: string,
  mode: TagMode
): string[] {
  const set = mode === 'post_fix' ? POST_FIX_INDOOR_CATEGORIES : CURRENT_INDOOR_CATEGORIES;
  const out = new Set(tagKeysFrom(categoryTags, primaryCategoryKey));
  if (set.has(primaryCategoryKey)) out.add('indoor');
  return [...out];
}
