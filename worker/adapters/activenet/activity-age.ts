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
import { fetchActivityDetail, type ActiveNetActivityDetail, type ClientOptions } from './client';
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
 * Fetches an activity's structured age at most ONCE per run, per activity.
 *
 * The cache is the whole reason this is a class. `event_item_id` is the ACTIVITY id and repeats
 * across every date the activity runs (measured: Vancouver, 3,072 distinct ids across 10,146
 * occurrences), so an uncached lookup would pay ~3x for the same answer. Misses are cached too —
 * a null is as worth remembering as a hit, and re-asking a source that had nothing to say is how
 * a polite crawl turns impolite.
 */
export class ActivityAgeResolver {
  private readonly cache = new Map<number, ActivityAgeBounds | null>();
  private fetches = 0;
  private failures = 0;

  constructor(
    private readonly tenant: ActiveNetTenantConfig,
    private readonly clientOpts: ClientOptions
  ) {}

  get stats(): { lookups: number; cached: number; failures: number } {
    return { lookups: this.fetches, cached: this.cache.size, failures: this.failures };
  }

  async resolve(activityId: number | undefined): Promise<ActivityAgeBounds | null> {
    if (!Number.isFinite(activityId)) return null;
    const id = activityId as number;
    const hit = this.cache.get(id);
    if (hit !== undefined) return hit;

    let bounds: ActivityAgeBounds | null = null;
    try {
      this.fetches += 1;
      const { detail } = await fetchActivityDetail(this.tenant, id, this.clientOpts);
      bounds = activityAgeToBounds(detail);
    } catch (err) {
      // A verification lookup must never fail the run. Not knowing the age is a survivable
      // outcome — the caller falls back to making NO claim, which is the safe direction —
      // whereas throwing here would lose an entire municipality's drop-in listings over one
      // activity record. The budget/circuit-breaker errors that SHOULD stop a run are raised by
      // the shared client on the next call anyway.
      this.failures += 1;
      bounds = null;
    }
    this.cache.set(id, bounds);
    return bounds;
  }
}
