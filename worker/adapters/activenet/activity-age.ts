// worker/adapters/activenet/activity-age.ts — the source's OWN age, instead of our reading of
// its marketing copy.
//
// WHY THIS MODULE EXISTS. 227 live Vancouver occurrences were published as
// age_min_months=0 / age_max_months=NULL / 'all-ages' — "suitable for a newborn" — on
// adults-only and seniors-only programming. Every one of them had an exact, machine-readable
// age on the source's own activity record the whole time:
//
//   Karate - Ku Yu Kai Go-Ju Ryu (Adults)  age_min_year 19  prose: "teaches classes for all ages and levels"
//   Wu's Tai Chi                           age_min_year 50  prose: "for people of all ages and health conditions"
//   Bootcamp Circuits                      age_min_year 19  prose: "This all ages, circuit-based class"
//   Ukulele - Jam Circle (All ages)        age 55-99        the TITLE says "All ages"
//   Music with Marnie All Ages/Siblings    age under 5y11m  the TITLE says "All Ages"
//
// The last two matter most: they are why a title carve-out is not sufficient either. The venue
// uses "All ages" to mean "any skill level, come along" while stating a real bound in its age
// field. No rule over titles or prose separates those cases. This one field does.
//
// Measured 2026-09-12 on a 400-activity random sample spread across the catalogue: 400/400
// carry a usable structured age.
import {
  fetchActivityDetail,
  PortalBlockedError,
  PortalRateLimitedError,
  RequestCapExceededError,
  type ActiveNetActivityDetail,
  type ClientOptions,
} from './client';
import type { ActiveNetTenantConfig } from './config';

const MONTHS_PER_YEAR = 12;

/**
 * The vendor's sentinel for "no real upper bound". Ranges are published as
 * "Age at least 55 yrs but less than 99y 11m" — 99 is not a claim about centenarians, it is how
 * this platform spells open-ended when a minimum is set. Carrying it literally would make an
 * adult programme look bounded and is a distinction without a difference against our top band
 * (15+, open-ended); treating it as open is the honest read.
 */
const OPEN_ENDED_MAX_YEARS = 99;

export interface ActivityAgeBounds {
  minMonths: number;
  maxMonths: number | null;
  /** Set to 'all-ages' only when the SOURCE's own field says so, never inferred. */
  notes?: string;
}

/**
 * Convert the vendor's split year/month/week fields into this system's month convention
 * (min INCLUSIVE, max EXCLUSIVE, null = open) — see worker/core/age.ts's header.
 *
 * WEEKS ARE DELIBERATELY DROPPED. The vendor publishes upper bounds like "less than 10y 11m 4w",
 * and its `less than` is already exclusive, so y*12+m lands within a month of the true edge on
 * the CONSERVATIVE side — it admits slightly fewer children than the venue allows, never more.
 * Rounding weeks up would reverse that, and over-admitting is the direction that hurts.
 */
export function activityAgeToBounds(detail: ActiveNetActivityDetail | null): ActivityAgeBounds | null {
  if (!detail || !detail.age_description) return null;

  const minMonths = (detail.age_min_year ?? 0) * MONTHS_PER_YEAR + (detail.age_min_month ?? 0);
  const maxYear = detail.age_max_year ?? 0;
  const maxMonth = detail.age_max_month ?? 0;

  // All-zero max is how the platform spells "no upper bound" ("19 yrs +", and also "All ages,"
  // where BOTH ends are zero and the honest answer is the open range).
  const unbounded = (maxYear === 0 && maxMonth === 0) || maxYear >= OPEN_ENDED_MAX_YEARS;
  const maxMonths = unbounded ? null : maxYear * MONTHS_PER_YEAR + maxMonth;

  // A max at or below the min is not a range this system can express; refuse rather than invent.
  if (maxMonths !== null && maxMonths <= minMonths) return null;

  const notes = minMonths === 0 && maxMonths === null ? 'all-ages' : undefined;
  return { minMonths, maxMonths, notes };
}

/**
 * Errors that mean STOP TALKING TO THIS PORTAL, as opposed to "no answer about this activity".
 *
 * The distinction is the difference between a report that is honest about what it did not ask
 * and one that quietly claims a clean pass: a budget exhaustion or a 403/429 does not become
 * more true by being retried on the next id, so it must interrupt the caller rather than be
 * folded into that id's result.
 */
export function isFatalPortalError(err: unknown): boolean {
  return (
    err instanceof RequestCapExceededError ||
    err instanceof PortalBlockedError ||
    err instanceof PortalRateLimitedError
  );
}

/**
 * Fetches an activity's structured age at most ONCE per run, per activity.
 *
 * ── THE THREE OUTCOMES ARE THREE DIFFERENT FACTS AND MUST NOT COLLAPSE ───────────────────
 *   bounds     the source answered and stated an age
 *   null       the source answered and has NO age for this activity
 *   undefined  we never got an answer — the lookup failed, or was never made
 *
 * An earlier cut of this returned `null` for every failure, which made "the source says there
 * is no age" indistinguishable from "we never asked". Downstream that is not cosmetic: the
 * backfill planner maps `null` to LEAVE_SOURCE_SILENT and `undefined` to AMBIGUOUS, so a run
 * that got rate-limited half way through would have reported every remaining row as
 * confidently source-silent and claimed a clean complete pass. It also made the fatal errors
 * unreachable by the callers written to handle them. Caught in review; the lesson is the same
 * one as the vacuous test block in tests/adapters/activenet-activity-age.test.ts — a branch
 * written for an input the real code can no longer produce is not a safety net.
 *
 * The cache is the whole reason this is a class. `event_item_id` is the ACTIVITY id and repeats
 * across every date the activity runs (measured: Vancouver, 3,072 distinct ids across 10,146
 * occurrences), so an uncached lookup would pay ~3x for the same answer. Misses are cached too —
 * a null is as worth remembering as a hit, and re-asking a source that had nothing to say is how
 * a polite crawl turns impolite. Membership is tested with `.has()`, NOT `get() !== undefined`,
 * because `undefined` is now one of the three real values.
 */
export class ActivityAgeResolver {
  private readonly cache = new Map<number, ActivityAgeBounds | null | undefined>();
  private fetches = 0;
  private failures = 0;

  constructor(
    private readonly tenant: ActiveNetTenantConfig,
    private readonly clientOpts: ClientOptions
  ) {}

  get stats(): { lookups: number; cached: number; failures: number } {
    return { lookups: this.fetches, cached: this.cache.size, failures: this.failures };
  }

  /** Throws on a fatal portal error (see isFatalPortalError) so the caller can stop; every
   *  other failure is reported as `undefined` — "no answer", never "no age". */
  async resolve(activityId: number | undefined): Promise<ActivityAgeBounds | null | undefined> {
    if (!Number.isFinite(activityId)) return undefined;
    const id = activityId as number;
    if (this.cache.has(id)) return this.cache.get(id);

    let result: ActivityAgeBounds | null | undefined;
    try {
      this.fetches += 1;
      const { detail } = await fetchActivityDetail(this.tenant, id, this.clientOpts);
      // No detail at all is not the source saying "no age" — it is the source not answering
      // about this activity, which is the ambiguous outcome.
      result = detail ? activityAgeToBounds(detail) : undefined;
    } catch (err) {
      if (isFatalPortalError(err)) throw err;
      // A single unreadable activity record is survivable and must not fail an ingest run.
      // It is still an ABSENCE OF AN ANSWER, so it is undefined rather than null.
      this.failures += 1;
      result = undefined;
    }
    this.cache.set(id, result);
    return result;
  }

}
