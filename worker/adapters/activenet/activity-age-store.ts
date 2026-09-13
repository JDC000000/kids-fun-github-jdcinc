// worker/adapters/activenet/activity-age-store.ts — what earlier runs already learned.
//
// The in-memory cache inside ActivityAgeResolver collapses the ~3x repeat of an activity id
// across its occurrences WITHIN one run. This is the other half: it carries answers ACROSS runs.
//
// WHY THAT IS A PREREQUISITE AND NOT AN OPTIMISATION. The resolver's request budget is the
// tenant's per-run cap (60 / 48 / 4) and records are walked in a stable order, so without
// persistence every run spends its budget on substantially the same head of the list and never
// reaches the tail. Coverage does not converge — it is not slow, it is stuck. With persistence the
// frontier advances each run and the catalogue is covered in days, after which the steady-state
// cost is near zero because these bounds are near-static.
import type { Pool } from 'pg';
import type { ActivityAgeBounds } from './activity-age';

/**
 * Two outcomes are storable and the third deliberately is not:
 *   bounds     the source answered and stated an age
 *   null       the source answered and has NO age    -> stored, so we stop re-asking
 *   (absent)   we never got an answer                -> NOT stored, so it is retried next run
 * Caching a failure as if it were an answer is the same conflation this whole subsystem exists
 * to avoid; here it would also make one bad night permanently suppress an activity.
 */
export interface ActivityAgeStore {
  get(sourceFamily: string, activityId: number): Promise<ActivityAgeBounds | null | undefined>;
  put(sourceFamily: string, activityId: number, value: ActivityAgeBounds | null): Promise<void>;
}

/** How long a cached answer is trusted. Activity age bounds change only when a programme is
 *  redefined, which is seasonal — so this is generous on purpose. A run that needs fresher data
 *  than this has a different problem than caching. */
export const ACTIVITY_AGE_TTL_DAYS = 30;

export function createActivityAgeStore(pool: Pool, ttlDays = ACTIVITY_AGE_TTL_DAYS): ActivityAgeStore {
  return {
    async get(sourceFamily, activityId) {
      const { rows } = await pool.query<{
        has_age: boolean;
        age_min_months: number | null;
        age_max_months: number | null;
        age_notes: string | null;
      }>(
        `SELECT has_age, age_min_months, age_max_months, age_notes
           FROM source_activity_age
          WHERE source_family = $1
            AND source_activity_id = $2
            AND fetched_at > now() - ($3 || ' days')::interval`,
        [sourceFamily, String(activityId), String(ttlDays)]
      );
      const row = rows[0];
      if (!row) return undefined; // never asked, or the answer has expired — ask again
      if (!row.has_age) return null; // the source answered: no age
      return {
        minMonths: Number(row.age_min_months),
        maxMonths: row.age_max_months === null ? null : Number(row.age_max_months),
        notes: row.age_notes ?? undefined,
      };
    },

    async put(sourceFamily, activityId, value) {
      await pool.query(
        `INSERT INTO source_activity_age
           (source_family, source_activity_id, has_age, age_min_months, age_max_months, age_notes, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (source_family, source_activity_id) DO UPDATE
           SET has_age        = EXCLUDED.has_age,
               age_min_months = EXCLUDED.age_min_months,
               age_max_months = EXCLUDED.age_max_months,
               age_notes      = EXCLUDED.age_notes,
               fetched_at     = now()`,
        [
          sourceFamily,
          String(activityId),
          value !== null,
          value?.minMonths ?? null,
          value?.maxMonths ?? null,
          value?.notes ?? null,
        ]
      );
    },
  };
}
