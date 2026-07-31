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
//   5. COVERAGE SHORTFALL — a walk that ended on consecutive empty strides with part of
//      the declared window never fetched (QA Q1).
//
//      TRUNCATION AND SHORTFALL ARE SEPARATE CODES ON PURPOSE. An earlier revision of
//      this file argued only truncation should alert, on the grounds that a short
//      calendar legitimately walks fewer strides and alerting would false-positive. That
//      reasoning was half right and is superseded: the false-positive worry is real, but
//      the answer is to DISTINGUISH the two rather than to drop one. Truncation means
//      "cut off with data still arriving" — unambiguously bad. Shortfall means "stopped
//      on empty strides with window left" — possibly a calendar that ended, possibly a
//      real gap, and in either case worth a human glance rather than silence. Blurring
//      them into one code would have made the benign case train people to ignore the
//      malignant one.
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
  /** Calendars whose slice stopped on the per-stride page ceiling with the cursor still
   *  advancing — real, quantified under-coverage. */
  truncatedCalendars?: string[];
  /** Strides the declared window required, and the fewest any calendar actually walked.
   *  A shortfall means a walk ended on consecutive empty strides with window left. */
  stridesRequired?: number;
  minStridesWalked?: number;
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

function codeForError(error: unknown): { code: PerfectMindHealthCode; detail: string } {
  if (error instanceof PerfectMindFetchError) {
    const map: Record<PerfectMindFetchError['kind'], PerfectMindHealthCode> = {
      blocked: 'widget_blocked',
      rate_limited: 'widget_rate_limited',
      unavailable: 'widget_unavailable',
      protocol: 'payload_contract',
      request_cap: 'request_cap',
    };
    return { code: map[error.kind], detail: error.message };
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

  if (
    diag.stridesRequired != null &&
    diag.minStridesWalked != null &&
    diag.minStridesWalked < diag.stridesRequired
  ) {
    // QA Q1's other half. Kept DISTINCT from coverage_truncated on purpose: truncation
    // means "we were cut off with data still arriving" (unambiguously bad), whereas a
    // shortfall means "we stopped on consecutive empty strides with window remaining"
    // — which may be a calendar that genuinely ended, or a real gap the walk gave up on.
    // Two codes let the board tell those apart; one code would blur them.
    //
    // Structurally unreachable at the current 28-day window (2 strides — a walk cannot
    // exit early AND leave strides unwalked), so this costs nothing today and is already
    // correct if the window ever grows. That is the point: the guard lands BEFORE the
    // change that would need it, not after.
    return {
      code: 'coverage_shortfall',
      status: 'partial',
      alert: true,
      detail:
        `incomplete coverage for ${diag.tenantKey}: walked ${diag.minStridesWalked} of ` +
        `${diag.stridesRequired} stride(s) — part of the declared window was never fetched`,
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
