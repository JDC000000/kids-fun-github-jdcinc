// worker/adapters/activenet/health.ts — G-T7R-6: source_check_run health + honest yield
// reporting for the ActiveCommunities adapter.
//
// These endpoints are undocumented, unversioned and unofficial. The failure mode that
// actually matters is not a crash — it is a SILENT one: the vendor changes a key, the
// parser yields nothing, and a municipality quietly empties while every run still says
// "success". So three signals write a check-run failure onto the T15 health board:
//
//   1. FETCH/PARSE FAILURE — including HTTP 403 (blocked) and 429 (rate-limited), which
//      arrive as the typed circuit-breaker errors from client.ts.
//   2. YIELD COLLAPSE — this run's occurrence count against the trailing baseline of
//      recent successful runs.
//   3. SHAPE DRIFT — an unrecognised top-level payload key from client.ts's canary.
//
// REUSE, NOT A FORK. The check-run rows are written with worker/core/checkrun.ts, and
// the board that reads them is T15's (worker/health/sla.ts + lib/admin/data-health.ts).
// Nothing here re-implements either.
//
// Relationship to worker/health/sla.ts `parseYieldRate`: that is a BINARY, cross-source
// measure ("what fraction of successful runs produced any records at all") over a rolling
// window. This is a VOLUME measure for one run against its own history. They answer
// different questions and are deliberately kept separate.
import type { Pool } from 'pg';
import { startCheckRun, finishCheckRun, loadRecordsFoundBaseline } from '../../core/checkrun';
import { ActiveNetFetchError } from './client';

/** A run yielding less than this share of its trailing baseline has collapsed. */
export const YIELD_COLLAPSE_RATIO = 0.5;

/**
 * F-8 — phone-rejection spike. Of the centres that publish a phone at all, this share
 * being REFUSED by normaliseVenuePhone() is a vendor-format event, not editorial drift.
 *
 * WHY 20% AND NOT THE 50% NEXT DOOR. YIELD_COLLAPSE_RATIO compares a run to its own
 * trailing baseline, so it can afford a wide band. There is no baseline for phone
 * acceptance — no DB column, no history — so this is an ABSOLUTE floor, and it gets to be
 * strict because the measured acceptance rate on every roster we have is 100% (36/36
 * Vancouver, 7/7 Burnaby). One or two centres appending `(front desk)` is 3–6% of
 * Vancouver, comfortably under; a fifth of a roster changing shape at once is not
 * something 36 independent facility administrators do in the same week.
 */
export const PHONE_REJECTION_ALERT_RATIO = 0.2;
/**
 * …but never on a single value. One centre publishing `(604) 718-8222, press 2` is a real
 * rejection and belongs in the run warnings; it is not a contract change, and firing on it
 * would train an operator to ignore this code — the one failure mode an alarm cannot
 * survive. Also what keeps Burnaby's 7-centre roster from alerting at 1/7 = 14%… which
 * is under the ratio anyway; the floor is what stops a future 4-centre tenant at 1/4.
 */
export const PHONE_REJECTION_MIN_REJECTED = 2;

export type ActiveNetHealthCode =
  | 'ok'
  | 'portal_blocked'
  | 'portal_rate_limited'
  | 'portal_unavailable'
  | 'payload_contract'
  | 'request_cap'
  | 'yield_collapse'
  | 'shape_drift'
  | 'phone_rejection_spike'
  | 'fetch_failed';

export interface ActiveNetRunDiagnostics {
  tenantKey: string;
  occurrencesParsed: number;
  requestsUsed: number;
  /** Trailing baseline of occurrences from recent successful runs; null when unknown. */
  baselineOccurrences: number | null;
  unrecognisedKeys: string[];
  /** Centres whose centerdetails entry carried a non-empty phone (the denominator). */
  phonesOffered?: number;
  /** Of those, how many normaliseVenuePhone() refused (see venues.ts). */
  phonesRejected?: number;
  /** The facilities behind that count, by name — carried so the alert detail can NAME
   *  them rather than quote a percentage nobody can act on. */
  venuesWithRejectedPhone?: string[];
  warnings: string[];
  /** The error that aborted the run, if any. */
  error?: unknown;
}

export interface ActiveNetHealthVerdict {
  code: ActiveNetHealthCode;
  status: 'success' | 'partial' | 'failed';
  /** True when this must land on the health board as an error. */
  alert: boolean;
  detail: string;
  occurrences: number;
}

function codeForError(error: unknown): { code: ActiveNetHealthCode; detail: string } {
  if (error instanceof ActiveNetFetchError) {
    const map: Record<ActiveNetFetchError['kind'], ActiveNetHealthCode> = {
      blocked: 'portal_blocked',
      rate_limited: 'portal_rate_limited',
      unavailable: 'portal_unavailable',
      protocol: 'payload_contract',
      request_cap: 'request_cap',
    };
    return { code: map[error.kind], detail: error.message };
  }
  return { code: 'fetch_failed', detail: error instanceof Error ? error.message : String(error) };
}

/**
 * Classify one run. Precedence: a hard error beats everything; then yield collapse
 * (data is silently gone); then shape drift (data is fine but the contract moved, so a
 * human should look before the next run); then success.
 */
export function assessRunHealth(diag: ActiveNetRunDiagnostics): ActiveNetHealthVerdict {
  if (diag.error !== undefined) {
    const { code, detail } = codeForError(diag.error);
    return {
      code,
      status: diag.occurrencesParsed > 0 ? 'partial' : 'failed',
      alert: true,
      detail,
      occurrences: diag.occurrencesParsed,
    };
  }

  const baseline = diag.baselineOccurrences;
  if (baseline != null && baseline > 0 && diag.occurrencesParsed < baseline * YIELD_COLLAPSE_RATIO) {
    return {
      code: 'yield_collapse',
      status: 'failed',
      alert: true,
      detail:
        `yield collapse for ${diag.tenantKey}: ${diag.occurrencesParsed} occurrences vs trailing ` +
        `baseline ${baseline} (< ${YIELD_COLLAPSE_RATIO * 100}%)`,
      occurrences: diag.occurrencesParsed,
    };
  }

  if (diag.unrecognisedKeys.length > 0) {
    return {
      code: 'shape_drift',
      status: 'partial',
      alert: true,
      detail: `unrecognised payload keys for ${diag.tenantKey}: ${diag.unrecognisedKeys.join(', ')}`,
      occurrences: diag.occurrencesParsed,
    };
  }

  // F-8 — the vendor still returns a phone for every centre, and we can no longer dial any
  // of them. Occurrences are fine, the payload shape is fine, nothing above fires. This is
  // the "cheerfully green" failure this module exists for, one field down.
  //
  // WHAT THE HARM ACTUALLY IS, corrected after QA (register F-8, prediction 3). It is NOT
  // "numbers vanish from listings" — that was wrong and is worth stating plainly because
  // the wrong version drove this design. resolveVenue() enriches with
  // `phone = COALESCE($8, phone)` (worker/core/venue.ts), so a rejected value sends NULL
  // and the STORED number survives untouched. Nothing disappears. The real failure is
  // FREEZING: the column silently stops tracking the vendor and keeps serving a
  // last-known-good number as a live `tel:` link, indefinitely, with no staleness marker.
  // A parent taps a number the facility may have changed months ago. That is quieter than
  // vanishing and worse to detect, which makes this check MORE justified, not less.
  //
  // BELOW shape_drift, deliberately. Both fire when the vendor reshapes the payload, and
  // "unrecognised keys" is then the larger, more actionable statement — phones are one
  // field, drift may be everything. Above `ok` and nothing else, because on its own this
  // is a narrow, confirmed, precisely-quantified loss. KNOWN COST (register F-13): the
  // drift canary's key list is a static const, so one benign new vendor key pins
  // `shape_drift` on forever and makes this check unreachable until someone updates it.
  //
  // STATUS `partial` IS STILL INERT, AND THAT IS NOW DELIBERATE, NOT A GAP. `assessRun()`
  // returns only `{code, alert, detail}` (AdapterRunDiagnostics), so this `status` never
  // reaches ingestSource, which derives the run's own status from whether occurrences
  // upserted. F-11 (2026-08-02) decided NOT to plumb it through: a run status cannot carry
  // this signal, because ingestSource already produces 'partial' from unrelated per-record
  // errors, so an adapter-supplied 'partial' would be indistinguishable from ordinary noise.
  // What DOES leave this function and reach a human is `alert`, now persisted as
  // source_check_run.health_alert_code (migration 0026) and read by the admin attention panel
  // and both SLA success-ratio paths. Full reasoning: worker/core/adapter.ts's note on
  // AdapterRunDiagnostics. `status` is kept here only because it documents this verdict's
  // intended severity; do not chase it from this file.
  const offered = diag.phonesOffered ?? 0;
  const rejected = diag.phonesRejected ?? 0;
  if (
    rejected >= PHONE_REJECTION_MIN_REJECTED &&
    offered > 0 &&
    rejected / offered >= PHONE_REJECTION_ALERT_RATIO
  ) {
    const named = diag.venuesWithRejectedPhone ?? [];
    const shown = named.slice(0, 5);
    const suffix = named.length > shown.length ? `, +${named.length - shown.length} more` : '';
    return {
      code: 'phone_rejection_spike',
      status: 'partial',
      alert: true,
      detail:
        `phone coverage dropped for ${diag.tenantKey}: ${rejected} of ${offered} published phone ` +
        `number(s) were unusable (>= ${PHONE_REJECTION_ALERT_RATIO * 100}%) — re-check the ` +
        `centerdetails phone format${shown.length ? `; affected: ${shown.join(', ')}${suffix}` : ''}`,
      occurrences: diag.occurrencesParsed,
    };
  }

  return {
    code: 'ok',
    status: 'success',
    alert: false,
    detail: `${diag.occurrencesParsed} occurrences in ${diag.requestsUsed} requests`,
    occurrences: diag.occurrencesParsed,
  };
}

/** Trailing occurrence baseline. Canonical implementation lives in
 *  worker/core/checkrun.ts (which owns the source_check_run table); re-exported here so
 *  the ActiveNet health story reads in one place — deliberately NOT a second query. */
export const loadYieldBaseline = loadRecordsFoundBaseline;

/**
 * Write the verdict as a `source_check_run` row so it lands on the T15 health board.
 * Used for failures detected OUTSIDE `ingestSource` (a fetch that never reached the
 * ingest loop, or a yield-collapse assessment made after it). Returns the check-run id.
 */
export async function recordActiveNetCheckRun(
  pool: Pool,
  sourceId: string,
  verdict: ActiveNetHealthVerdict,
  extraWarnings: string[] = []
): Promise<string> {
  const { id, startedAt } = await startCheckRun(pool, sourceId);
  const errors =
    verdict.alert || extraWarnings.length > 0
      ? { code: verdict.code, detail: verdict.detail, warnings: extraWarnings }
      : undefined;
  await finishCheckRun(pool, id, {
    status: verdict.status,
    recordsFound: verdict.occurrences,
    errors,
    // F-11: this path writes a check run WITHOUT going through ingestSource, so it has to
    // persist the verdict itself. Miss this and an alert recorded here is invisible on the
    // attention panel for every code whose status is 'partial' rather than 'failed' —
    // i.e. exactly the codes F-11 was about.
    healthAlert: verdict.alert ? { code: verdict.code, detail: verdict.detail } : null,
    startedAt,
  });
  return id;
}
