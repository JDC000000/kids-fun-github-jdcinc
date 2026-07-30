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

export type ActiveNetHealthCode =
  | 'ok'
  | 'portal_blocked'
  | 'portal_rate_limited'
  | 'portal_unavailable'
  | 'payload_contract'
  | 'request_cap'
  | 'yield_collapse'
  | 'shape_drift'
  | 'fetch_failed';

export interface ActiveNetRunDiagnostics {
  tenantKey: string;
  occurrencesParsed: number;
  requestsUsed: number;
  /** Trailing baseline of occurrences from recent successful runs; null when unknown. */
  baselineOccurrences: number | null;
  unrecognisedKeys: string[];
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
    startedAt,
  });
  return id;
}
