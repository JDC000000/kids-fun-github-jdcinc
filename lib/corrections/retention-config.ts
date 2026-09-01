// lib/corrections/retention-config.ts — environment configuration for the
// correction_report retention job. Mirrors lib/analytics/config.ts's operational
// surface (a cron secret + a dry-run kill-switch), with ONE deliberate difference
// noted below on the retention window.
//
// Nothing here returns a secret to a caller that would print it —
// correctionRetentionCronSecret() is only ever compared, in constant time, against a
// presented header inside the retention run route.
//
// Env vars (added to .env.example):
//   CORRECTION_RETENTION_CRON_SECRET — shared secret guarding POST
//                                      /api/corrections/retention/run.
//   CORRECTION_RETENTION_DRY_RUN     — forces the retention job to COUNT ONLY (delete
//                                      nothing), regardless of caller. An operator
//                                      kill-switch for observe-first; UNSET = the job
//                                      actually deletes. See the parser below for the
//                                      exact spellings and the fail-safe rule.
//
// WINDOW is intentionally NOT env-overridable (unlike ANALYTICS_RETENTION_DAYS).
// analytics_event stamps retained_until in the app writer from that env, so the env
// IS the source of truth there. correction_report rows are stamped by the column
// DEFAULT (migration 0020) — the write helper (report.ts) never sets the column — so
// the DB default is the single source of truth. Exposing a window env here would let
// the audit line silently disagree with the real DB window, so we keep it a documented
// constant that must equal the migration's `interval '6 months'` default.

/**
 * The correction_report retention window in whole days, for the job's audit/response
 * line ONLY. 183 ≈ the migration 0020 DB DEFAULT of `now() + interval '6 months'`
 * (6 calendar months averages ~182.6 days). The DB DEFAULT — not this constant — is
 * what actually determines how long a row is kept; keep the two in sync if either
 * changes (a window change is a new ALTER-DEFAULT migration, not an env tweak).
 */
export const CORRECTION_RETENTION_DAYS = 183;

import {
  resolveDryRunSwitch,
  type DryRunResolution,
  type DryRunResolutionReason,
} from '../retention/dry-run-switch';

export type { DryRunResolution, DryRunResolutionReason };

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

/** The window (in days) echoed in the retention job's result/audit line. Constant —
 *  the authoritative window is the correction_report.retained_until DB DEFAULT. */
export function correctionRetentionDays(): number {
  return CORRECTION_RETENTION_DAYS;
}

/** The retention-job shared secret, or null if unconfigured (route then fails closed). */
export function correctionRetentionCronSecret(): string | null {
  return env('CORRECTION_RETENTION_CRON_SECRET') ?? null;
}

/** The env var carrying the operator kill-switch. Exported so callers can name it in
 *  their own log lines without re-spelling a string literal. */
export const CORRECTION_RETENTION_DRY_RUN_ENV = 'CORRECTION_RETENTION_DRY_RUN';

/**
 * F1 — WHY THIS IS NOT `=== 'true'` ANY MORE. It was, and that was a live data-destruction
 * hazard: `CORRECTION_RETENTION_DRY_RUN="TRUE"` and `="1"` both failed the exact-literal test,
 * resolved to dryRun=false, and permanently deleted real correction_report rows while the
 * operator believed deletions were paused. QA reproduced both against a real database.
 *
 * THE PARSING NOW LIVES IN lib/retention/dry-run-switch.ts, shared with the sms_retention job.
 * It was extracted rather than copied for the reason F1 exists at all: one rule implemented
 * twice is one rule that gets fixed once. (lib/analytics/config.ts:69 is the standing proof —
 * it still reads `=== 'true'` and still carries this exact hazard.) Behaviour here is
 * UNCHANGED; tests/corrections/retention-dry-run-switch.test.ts is the evidence.
 *
 * THE UNSET DEFAULT IS DELIBERATELY UNCHANGED. Unset → dryRun=false → deletions really happen.
 * The route, this module's header, .env.example and the privacy page's automatic-deletion
 * promise all agree, and the compliance claim depends on deletions actually occurring by
 * default. Making "unset" mean "paused" would quietly turn the retention guarantee off
 * everywhere it has not been explicitly configured, which is the larger harm.
 */
export function resolveCorrectionRetentionDryRun(): DryRunResolution {
  return resolveDryRunSwitch(CORRECTION_RETENTION_DRY_RUN_ENV, 'run', 'corrections-retention');
}


/**
 * Whether the retention job is forced to dry-run (count only, delete nothing).
 * Default FALSE — the job's whole purpose is to actually enforce retention, so it
 * deletes by default; this is an operator kill-switch to observe first.
 *
 * The single shared answer for BOTH runtimes: the Vercel route
 * (app/api/corrections/retention/run/route.ts:66) and the worker's queue job
 * (worker/core/corrections-retention.ts:65) call this same function. A kill-switch that
 * stopped deletions on one runtime and not the other would be worse than no kill-switch,
 * so the parse lives here and is never re-implemented at a call site.
 */
export function correctionRetentionDryRunForced(): boolean {
  return resolveCorrectionRetentionDryRun().dryRun;
}
