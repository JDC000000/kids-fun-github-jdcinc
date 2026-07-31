// worker/adapters/perfectmind/health.ts — G-T8-6: source_check_run health + honest yield
// reporting for the PerfectMind BookMe4 adapter.
//
// These endpoints are undocumented, unversioned and unofficial. The failure mode that
// actually matters is not a crash — it is a SILENT one: the vendor bumps the widget
// bundle, the parser yields nothing, and a municipality quietly empties while every run
// still says "success". So four signals write a check-run failure onto the T15 health
// board:
//
//   1. FETCH/PARSE FAILURE — including HTTP 403 (blocked) and 429 (rate-limited), which
//      arrive as the typed circuit-breaker errors from client.ts.
//   2. YIELD COLLAPSE — this run's occurrence count against the trailing baseline of
//      recent successful runs.
//   3. SHAPE DRIFT — an unrecognised payload key from client.ts's canary.
//   4. COVERAGE TRUNCATION — a calendar whose stride stopped on the page ceiling with the
//      vendor's cursor still advancing, i.e. the run fetched less than the window asked
//      for. Added for QA C2, which observed that the run report carried coverage numbers
//      that NOTHING alerted on — "under-coverage is visible" was only half true.
//
//   5. COVERAGE SHORTFALL — a calendar that PRODUCED DATA and then stopped short of the
//      declared window (QA Q1, predicate corrected). The "produced data" half is
//      load-bearing: without it the check mislabels fetch failures and fires forever on
//      calendars that are legitimately empty. See the predicate note in assessRunHealth.
//
//      TRUNCATION AND SHORTFALL ARE SEPARATE CODES ON PURPOSE, and that split survived
//      independent review after being challenged twice. Truncation means "cut off with
//      data still arriving" — unambiguous. Shortfall means "was producing, then went
//      quiet with window left" — worth a look. Blurring them into one code would let the
//      softer signal train people to ignore the harder one. What DID have to change was
//      the shortfall predicate, not the split; see assessRunHealth.
//   6. ASSET-BUILD-STAMP DRIFT — the BookMe4 static-asset stamp (`?07231003`) moving.
//      This one is specific to this vendor: the whole schedule surface is rendered by a
//      versioned JS bundle, so the stamp changing is the earliest available warning that
//      the JSON contract underneath it may have moved too.
//
// REUSE, NOT A FORK. The check-run rows are written with worker/core/checkrun.ts, and the
// board that reads them is T15's (worker/health/sla.ts + lib/admin/data-health.ts).
// Nothing here re-implements either. The classification shape deliberately mirrors
// worker/adapters/activenet/health.ts so the two brittle-source adapters read the same
// way on the health board.
import type { Pool } from 'pg';
import { startCheckRun, finishCheckRun, loadRecordsFoundBaseline } from '../../core/checkrun';
import { PerfectMindFetchError } from './client';

/** A run yielding less than this share of its trailing baseline has collapsed. */
export const YIELD_COLLAPSE_RATIO = 0.5;

export type PerfectMindHealthCode =
  | 'ok'
  | 'widget_blocked'
  | 'widget_rate_limited'
  | 'widget_unavailable'
  | 'payload_contract'
  | 'request_cap'
  | 'yield_collapse'
  | 'shape_drift'
  | 'asset_build_drift'
  | 'coverage_truncated'
  | 'coverage_shortfall'
  | 'fetch_failed';

export interface PerfectMindRunDiagnostics {
  tenantKey: string;
  occurrencesParsed: number;
  requestsUsed: number;
  /** Trailing baseline of occurrences from recent successful runs; null when unknown. */
  baselineOccurrences: number | null;
  unrecognisedKeys: string[];
  /** Calendars whose OWN fetch failed while the run continued. A run-aborting error
   *  arrives via `error`; these do not, and before QA F1 nothing read them at all. */
  failedCalendars?: Array<{ name: string; kind: PerfectMindFetchError['kind'] | 'unknown'; detail: string }>;
  /** Calendars whose slice stopped on the per-stride page ceiling with the cursor still
   *  advancing — real, quantified under-coverage. */
  truncatedCalendars?: string[];
  /** Calendars that PRODUCED DATA and then stopped short of the declared window. See the
   *  predicate note in assessRunHealth — "produced data AND THEN stopped" is doing real
   *  work here; a bare stride comparison mislabels failures and empty calendars. */
  shortfallCalendars?: string[];
  /** Set when the live BookMe4 asset build stamp differs from the pinned one. */
  observedAssetBuildStamp?: string | null;
  expectedAssetBuildStamp?: string;
  warnings: string[];
  /** The error that aborted the run, if any. */
  error?: unknown;
}

export interface PerfectMindHealthVerdict {
  code: PerfectMindHealthCode;
  status: 'success' | 'partial' | 'failed';
  /** True when this must land on the health board as an error. */
  alert: boolean;
  detail: string;
  occurrences: number;
}

/** THE one kind -> code map. Shared by run-aborting errors and per-calendar failures so
 *  the same fault reads the same way wherever it surfaced — QA F1 found `payload_contract`
 *  existed here but was unreachable for per-calendar failures, which is precisely the sort
 *  of gap a second copy of this map would have created rather than closed. */
const CODE_FOR_KIND: Record<PerfectMindFetchError['kind'], PerfectMindHealthCode> = {
  blocked: 'widget_blocked',
  rate_limited: 'widget_rate_limited',
  unavailable: 'widget_unavailable',
  protocol: 'payload_contract',
  request_cap: 'request_cap',
};

export function codeForFailureKind(kind: PerfectMindFetchError['kind'] | 'unknown'): PerfectMindHealthCode {
  return kind === 'unknown' ? 'fetch_failed' : CODE_FOR_KIND[kind];
}

function codeForError(error: unknown): { code: PerfectMindHealthCode; detail: string } {
  if (error instanceof PerfectMindFetchError) {
    return { code: CODE_FOR_KIND[error.kind], detail: error.message };
  }
  return { code: 'fetch_failed', detail: error instanceof Error ? error.message : String(error) };
}

/**
 * Classify one run. Precedence: a hard error beats everything; then yield collapse (data
 * is silently gone); then shape drift and asset-build drift (data is fine but the
 * contract may have moved, so a human should look before the next run); then success.
 */
export function assessRunHealth(diag: PerfectMindRunDiagnostics): PerfectMindHealthVerdict {
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

  if (diag.failedCalendars?.length) {
    // QA F1 — THE GAP THIS CLOSES, and it was one my own previous fix opened.
    //
    // Correcting the coverage predicate to `occurrenceCount > 0 && ...` rightly stopped
    // failed calendars being reported as a COVERAGE problem. But nothing else picked them
    // up: `diag.error` only covers run-ABORTING errors, and a per-calendar failure leaves
    // the run alive. So a calendar whose payload violated the contract produced
    // `code: 'ok', alert: false, "0 occurrences in N requests"` — completely silent.
    // Measured: a broken calendar alongside a healthy one reported ok/false while the
    // warning sat in the run report that nothing reads.
    //
    // That is strictly worse than the mislabelled-but-VISIBLE alert it replaced, and it
    // contradicts the entire point of the H6/T7/T8 arc: make failure visible. A single
    // persistently-broken calendar on a 9-calendar tenant is a 5-25% yield dip that
    // yield_collapse only catches once severe enough AND a baseline exists.
    //
    // Placed ABOVE shape_drift deliberately: a failed calendar is a CONFIRMED, localised
    // fault carrying a precise label; drift is a heuristic canary. When the vendor moves
    // the contract both fire, and "this calendar returned non-JSON" is the more
    // actionable of the two.
    const kinds = [...new Set(diag.failedCalendars.map((f) => f.kind))];
    // One distinct kind → name it exactly. Mixed kinds → don't pick a winner and mislabel
    // the others; fall back to the generic code and let the detail carry the specifics.
    const code = kinds.length === 1 ? codeForFailureKind(kinds[0]) : 'fetch_failed';
    return {
      code,
      status: diag.occurrencesParsed > 0 ? 'partial' : 'failed',
      alert: true,
      detail:
        `${diag.failedCalendars.length} calendar(s) failed for ${diag.tenantKey}: ` +
        diag.failedCalendars.map((f) => `${f.name} (${f.kind}: ${f.detail})`).join('; '),
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

  if (diag.truncatedCalendars?.length) {
    return {
      code: 'coverage_truncated',
      status: 'partial',
      alert: true,
      detail:
        `incomplete coverage for ${diag.tenantKey}: ${diag.truncatedCalendars.length} calendar(s) ` +
        `stopped on the page ceiling with data still available — ${diag.truncatedCalendars.join(', ')}`,
      occurrences: diag.occurrencesParsed,
    };
  }

  if (diag.shortfallCalendars?.length) {
    // THE PREDICATE IS THE WHOLE DESIGN HERE, and it took three attempts. Both wrong
    // versions are recorded because each was wrong in an instructive way.
    //
    //   v1 — `minStridesWalked < stridesRequired`. Wrong in BOTH directions:
    //        • It fired TODAY on a per-calendar FETCH FAILURE. A calendar whose fetch
    //          throws is recorded with `stridesWalked: 0`, which satisfies the comparison,
    //          so a payload-contract failure was reported as a COVERAGE problem — while
    //          codeForError already held the correct `payload_contract` label, unreachable.
    //          The comment that stood here claimed the check was "structurally unreachable
    //          at the current window". That was simply false, and measurably so.
    //        • At a widened window it would fire forever on NVRC's North Shore
    //          Neighbourhood House — a calendar this project's OWN config documents as
    //          "expected to yield nothing" (empty BookingLink). Measured: 1,061
    //          occurrences ingesting correctly elsewhere while NSNH alerted every run.
    //
    //   v2 — drop the alert entirely. The author's own re-derived position on finding v1's
    //        noise. Also wrong: it discards a real signal to escape a bad predicate, when
    //        the predicate was the only thing at fault.
    //
    //   v3 — this. `occurrenceCount > 0 AND stridesWalked < stridesRequired`:
    //        "produced data, AND THEN stopped short." Zero-yield and failed calendars leave
    //        the population entirely — free to be labelled by the code that actually
    //        describes them — and what remains is precisely the suspicious shape: a
    //        calendar demonstrably producing, then a mid-window gap the walk gave up on.
    //        The alert now means what its name says.
    //
    // Still DISTINCT from coverage_truncated. Truncation is "cut off with data still
    // arriving" (unambiguous); a shortfall is "was producing, then went quiet across two
    // consecutive strides with window left" — worth a look, not necessarily broken.
    return {
      code: 'coverage_shortfall',
      status: 'partial',
      alert: true,
      detail:
        `incomplete coverage for ${diag.tenantKey}: ${diag.shortfallCalendars.length} calendar(s) ` +
        `produced data and then stopped short of the declared window — ` +
        diag.shortfallCalendars.join(', '),
      occurrences: diag.occurrencesParsed,
    };
  }

  if (
    diag.observedAssetBuildStamp != null &&
    diag.expectedAssetBuildStamp != null &&
    diag.observedAssetBuildStamp !== diag.expectedAssetBuildStamp
  ) {
    return {
      code: 'asset_build_drift',
      status: 'partial',
      alert: true,
      detail:
        `BookMe4 asset build stamp moved for ${diag.tenantKey}: expected ` +
        `${diag.expectedAssetBuildStamp}, observed ${diag.observedAssetBuildStamp} — re-verify the payload contract`,
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
 *  the PerfectMind health story reads in one place — deliberately NOT a second query. */
export const loadYieldBaseline = loadRecordsFoundBaseline;

/**
 * Write the verdict as a `source_check_run` row so it lands on the T15 health board.
 * Used for failures detected OUTSIDE `ingestSource` (a fetch that never reached the
 * ingest loop, or a yield-collapse assessment made after it). Returns the check-run id.
 */
export async function recordPerfectMindCheckRun(
  pool: Pool,
  sourceId: string,
  verdict: PerfectMindHealthVerdict,
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
    startedAt,
  });
  return id;
}
