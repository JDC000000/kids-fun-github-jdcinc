// worker/adapters/library/run-health.ts — the library family's SHARED run-health
// vocabulary, extracted from ./generic-rss.ts so the BiblioCommons feed path can reuse it
// rather than grow a second, subtly-different opinion about the same three questions:
//
//     how many items did the feed give us · how many did we emit · what did we refuse
//
// WHY THIS FILE EXISTS RATHER THAN A SECOND COPY NEXT DOOR. The truncation signal was
// built once, for `generic_rss` (NVDPL), and it works: `droppedByLimit` is a COUNT, the
// buckets reconcile to `itemsInFeed`, and `truncated_by_limit` says how many records were
// lost rather than merely that loss happened. None of that was reachable from the
// `bibliocommons` path, which is the family's only LIVE platform (VPL, RPL) — so the two
// sources that actually run in production were the two throwing the tally away.
// Duplicating ~50 lines of verdict logic into index.ts would have given the family two
// truncation semantics to keep in sync, and the collapse-ratio constant already has three
// copies elsewhere in the repo (activenet/health.ts, perfectmind/health.ts, and formerly
// here) — a fourth was not the right answer.
//
// WHAT IS SHARED AND WHAT IS NOT. Shared: the three universal tallies below, the tally
// LINE format, and the checks that mean the same thing on any feed — an empty feed, a
// zero/collapsed yield, and client-side truncation. Not shared, and deliberately left to
// each platform: its own skip buckets (a kid-relevance miss and a cancelled event are not
// the same fact) and any platform-specific canary, which enters through the `platformCheck`
// hook below at the exact position it previously occupied.
import type { LibrarySystemConfig } from './config';

/**
 * The three tallies EVERY library feed parser can produce, whatever its platform, and the
 * minimum needed to answer "why did an N-item feed yield M records?" without a re-pull.
 *
 * Platform diagnostics EXTEND this and add their own skip buckets. The invariant those
 * buckets exist to uphold — every non-emitted item lands in exactly ONE bucket, so the
 * buckets sum to `itemsInFeed` — is asserted per platform in that platform's tests.
 */
export interface LibraryFeedTally {
  /** Items the feed actually delivered, before any of our own filtering. */
  itemsInFeed: number;
  /** Records actually EMITTED by the parser. */
  emitted: number;
  /**
   * Skipped: would have been emitted, but `liveEventsLimit` was already reached.
   *
   * A COUNT, not a boolean — and that is the fix for a real defect. This started life as
   * `truncatedByLimit: boolean`, which meant a truncated run reported "something was cut"
   * without saying how much, and left the skip buckets NOT summing to `itemsInFeed`: the
   * gap was silent in exactly the case where the number matters most.
   *
   * READ THIS BEFORE INTERPRETING A ZERO. `droppedByLimit` counts only what OUR OWN
   * client-side cap refused out of what the vendor handed us. It is structurally blind to
   * truncation the VENDOR applied before responding — if a feed page-caps at 25 items and
   * `liveEventsLimit` is also 25, every run reports `droppedByLimit: 0` while still being
   * capped. `itemsInFeed` sitting exactly on the limit is the fingerprint of that case, and
   * it is visible in the tally line for precisely that reason.
   */
  droppedByLimit: number;
}

/** One platform-specific skip bucket, rendered into the tally line. */
export interface FeedSkipBucket {
  /** Plural noun phrase as it reads after the count: "3 cancelled", "2 not-kid". */
  label: string;
  count: number;
}

/**
 * The one-line run tally every verdict carries, so a thin run is diagnosable off the health
 * board instead of needing the feed re-pulled. `droppedByLimit` is appended last, always,
 * because it is the one bucket every platform has.
 */
export function formatFeedTally(tally: LibraryFeedTally, skips: FeedSkipBucket[]): string {
  const buckets = [...skips, { label: 'over limit', count: tally.droppedByLimit }]
    .map((b) => `${b.count} ${b.label}`)
    .join(', ');
  return `${tally.emitted} emitted of ${tally.itemsInFeed} feed items (skipped: ${buckets})`;
}

export interface LibraryHealthVerdict {
  code: string;
  alert: boolean;
  detail: string;
}

/**
 * A run emitting less than this share of its trailing baseline has collapsed.
 *
 * 0.5 deliberately MIRRORS the project's existing `YIELD_COLLAPSE_RATIO` (ActiveNet and
 * PerfectMind both use it) so the project has ONE collapse semantic rather than a third
 * opinion. It now has ONE definition for the whole library family rather than one per
 * platform handler; folding the ActiveNet and PerfectMind copies in with it means editing
 * two other adapter families and is still a follow-up, not this file's business.
 */
export const YIELD_COLLAPSE_RATIO = 0.5;

/**
 * Fold a feed run's tally into a verdict for the health board.
 *
 * `baselineRecordsFound` is the source's trailing record count (null on a first run, or when
 * the caller has no DB). `live` says whether the run that produced the tally actually hit the
 * network.
 *
 * ⚠️ THE FIXTURE TRAP, which ActiveNet documented first: a fixture dry-run emits a handful of
 * records. Compared against a live baseline of ~46 that is a 96% "collapse", so every fixture
 * run — i.e. the DEFAULT posture, and every CI run — would fire a false alert. A non-live run
 * is therefore never compared to a baseline at all.
 *
 * `platformCheck` runs at a FIXED position: after the collapse checks, before truncation.
 * That is where `generic_rss`'s free-text `date_shape_drift` canary already sat, and the
 * ordering is load-bearing — a source whose date shape has drifted is broken, not merely
 * truncated, and should say so first.
 */
export function assessLibraryFeedRun(
  system: LibrarySystemConfig,
  tally: LibraryFeedTally,
  tallyLine: string,
  baselineRecordsFound: number | null,
  live: boolean,
  platformCheck?: (tallyLine: string) => LibraryHealthVerdict | null
): LibraryHealthVerdict {
  const { itemsInFeed, emitted, droppedByLimit } = tally;

  if (itemsInFeed === 0) {
    return { code: 'empty_feed', alert: true, detail: `${system.systemKey}: feed returned zero items` };
  }
  if (emitted === 0) {
    return { code: 'yield_collapse', alert: true, detail: `${system.systemKey}: ${tallyLine}` };
  }
  // Baseline collapse — only meaningful for a live run with a known, non-zero baseline.
  if (
    live &&
    baselineRecordsFound != null &&
    baselineRecordsFound > 0 &&
    emitted < baselineRecordsFound * YIELD_COLLAPSE_RATIO
  ) {
    return {
      code: 'yield_collapse',
      alert: true,
      detail:
        `${system.systemKey}: ${emitted} records vs trailing baseline ${baselineRecordsFound} ` +
        `(< ${YIELD_COLLAPSE_RATIO * 100}%) — ${tallyLine}`,
    };
  }

  const platformVerdict = platformCheck?.(tallyLine);
  if (platformVerdict) return platformVerdict;

  if (droppedByLimit > 0) {
    return {
      code: 'truncated_by_limit',
      alert: true,
      // States HOW MANY were lost, not merely that truncation happened — the difference
      // between an actionable alert and one someone has to re-pull the feed to interpret.
      detail: `${system.systemKey}: liveEventsLimit=${system.liveEventsLimit} dropped ${droppedByLimit} record(s) — ${tallyLine}`,
    };
  }
  return { code: 'ok', alert: false, detail: `${system.systemKey}: ${tallyLine}` };
}
