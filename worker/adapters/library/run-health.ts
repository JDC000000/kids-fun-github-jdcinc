// worker/adapters/library/run-health.ts — the library family's SHARED run-health
// vocabulary, extracted from ./generic-rss.ts so the BiblioCommons feed path can reuse it
// rather than grow a second, subtly-different opinion about the same three questions:
//
//     how many items did the feed give us · how many did we emit · what did we refuse
//
// WHY THIS FILE EXISTS RATHER THAN A SECOND COPY NEXT DOOR. The truncation MEASUREMENT was
// built once, for `generic_rss` (NVDPL): `droppedByLimit` is a COUNT and the buckets
// reconcile to `itemsInFeed`, so "why did an N-item feed yield M records?" is answerable
// without a re-pull. (It also carried a `truncated_by_limit` ALERT on that count. That alert
// is deleted — see the note in `assessLibraryFeedRun`. The measurement stayed; the verdict
// went.) None of it was reachable from the
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
   * `formatFeedTally` now spells that out in words rather than leaving it to be inferred.
   *
   * A COUNT, NEVER AN ALERT. This number does NOT drive a health verdict and must not be
   * made to — see the deletion note in `assessLibraryFeedRun` for why an alert on it fires
   * on healthy runs and stays silent on short ones. What it IS good for: the tally line, and
   * the error message of the Stage 1 CI lint that compares the cap against a MEASURED vendor
   * page size.
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
 * What the tally's relationship to OUR OWN cap means, in words, appended to the tally line.
 *
 * WHY THIS EXISTS. The bare tally states three numbers and leaves the reader to notice that
 * two of them coincide. The VPL shape — `25 emitted of 25 feed items (… 0 over limit)` — has
 * misled every previous reader of these constants, because `0 over limit` reads as "nothing
 * was lost" when it actually means "our cap never had to refuse anything". Those are very
 * different claims and only one of them is true. So the line says which.
 *
 * ⚠️ WHAT THIS DELIBERATELY DOES NOT CLAIM. It says nothing about the VENDOR's page size,
 * because this codebase has never measured one — `source_check_run.items_in_feed` (migration
 * 0031) is the column that starts measuring it, and until there are weeks of it on record any
 * statement of the form "the vendor page-caps at N" is a prediction wearing a measurement's
 * clothes. `liveEventsLimit` is OUR constant and is the only ceiling this function can speak
 * about honestly. Naming the vendor's ceiling is Stage 1's job, after the data exists.
 *
 * ⚠️ AND IT IS NOT THE VISIBILITY MECHANISM FOR A NON-ALERTING RUN. worker/core/ingest.ts
 * reads `verdict.detail` ONLY inside `if (verdict?.alert)` — there is no else branch and no
 * logging path — so an `ok` verdict's tally line is computed and discarded in memory. This
 * clause therefore only ever reaches a durable surface (`health_alert_detail`, `errors`) on
 * verdicts that ALREADY alert. The thing that makes a quiet, permanently-capped source
 * visible is the recorded `items_in_feed` COLUMN, not this string.
 */
function capRelationNote(tally: LibraryFeedTally, liveEventsLimit: number): string {
  if (tally.droppedByLimit > 0) {
    // itemsInFeed > liveEventsLimit. Our own misconfiguration, and fixable by us alone:
    // these records were already fetched and paid for, then thrown away client-side.
    return (
      ` — OUR CAP IS BELOW SUPPLY: liveEventsLimit=${liveEventsLimit} against ` +
      `${tally.itemsInFeed} items delivered, so ${tally.droppedByLimit} already-fetched ` +
      `record(s) were discarded`
    );
  }
  if (tally.itemsInFeed > 0 && tally.itemsInFeed === liveEventsLimit) {
    return (
      ` — AT OUR CAP: the feed delivered exactly liveEventsLimit=${liveEventsLimit}, so ` +
      `"0 over limit" means OUR cap refused nothing — NOT that the feed was complete`
    );
  }
  return '';
}

/**
 * The one-line run tally every verdict carries, so a thin run is diagnosable off the health
 * board instead of needing the feed re-pulled. `droppedByLimit` is appended last, always,
 * because it is the one bucket every platform has.
 *
 * `liveEventsLimit` is the cap the PARSE ACTUALLY APPLIED, not `system.liveEventsLimit` —
 * the two differ whenever a system omits the config value and the platform default stands in,
 * and a tally line quoting a cap the run did not use would be worse than quoting none.
 */
export function formatFeedTally(
  tally: LibraryFeedTally,
  skips: FeedSkipBucket[],
  liveEventsLimit: number
): string {
  const buckets = [...skips, { label: 'over limit', count: tally.droppedByLimit }]
    .map((b) => `${b.count} ${b.label}`)
    .join(', ');
  return (
    `${tally.emitted} emitted of ${tally.itemsInFeed} feed items (skipped: ${buckets})` +
    capRelationNote(tally, liveEventsLimit)
  );
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
  const { itemsInFeed, emitted } = tally;

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

  // ─────────────────────────────────────────────────────────────────────────────────────
  // DELETED HERE: the `droppedByLimit > 0` ⇒ `truncated_by_limit` ALERTING ARM.
  //
  // DO NOT REINSTATE IT. A test pins its absence
  // (tests/adapters/library-bibliocommons-truncation.test.ts, "the truncation ALERT is gone").
  // The count, the tally line and the bucket-reconciliation invariant all SURVIVE — only the
  // alert went. `droppedByLimit` is still counted by both parsers, still rendered as the
  // "N over limit" bucket, and still reconciles to `itemsInFeed`.
  //
  // WHY THE ALERT WAS WRONG, not merely noisy. `droppedByLimit > 0` is a VENDOR-SUPPLY-VOLUME
  // indicator wearing a health signal's clothes, and it is INVERTED:
  //   • RPL's cap (20) sits below the BiblioCommons page size, so a HEALTHY full run drops
  //     records on every run — alert every run, forever;
  //   • a genuinely SHORT run (the vendor published less than our cap) drops nothing — silent
  //     in exactly the case a human should look.
  // And a permanent alert is far worse than a noisy one here. Via `CLEAN_SUCCESS_RUN_SQL`
  // (worker/health/sla.ts:66, mirrored byte-identically at lib/admin/dashboard.ts:147, pinned
  // by tests/health/sla-consistency.test.ts) a non-NULL `health_alert_code` drops the run out
  // of clean-success AND stops `last_success_at` advancing — so the source would read as
  // PERMANENTLY DOWN on both the SLA board and the admin dashboard, with no successful run
  // ever recorded, while behaving perfectly.
  //
  // WHERE THE FACT WENT INSTEAD. `liveEventsLimit < vendorPageSize` is a STANDING config fact —
  // pure arithmetic over two constants — so it belongs in a CI lint, not in a per-run verdict
  // recomputed from scratch every run. That lint (Condition A) is Stage 1's, and it is blocked
  // on `vendorPageSize`, which is deliberately NOT declared yet: the number has never been
  // measured for either tenant. `source_check_run.items_in_feed` (migration 0031) starts
  // measuring it. Declaring the cap now by inheriting an unmeasured 25 is precisely the move
  // that produced this defect.
  // ─────────────────────────────────────────────────────────────────────────────────────
  return { code: 'ok', alert: false, detail: `${system.systemKey}: ${tallyLine}` };
}
