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

/** Spellings that mean "yes, pause deletions". Compared lowercase + trimmed. */
const TRUTHY = new Set(['true', 't', 'yes', 'y', 'on', '1']);

/** Spellings that mean "no, delete for real". Compared lowercase + trimmed. */
const FALSEY = new Set(['false', 'f', 'no', 'n', 'off', '0']);

/** How the effective dry-run mode was arrived at — the thing worth logging. */
export type DryRunResolutionReason =
  /** The env var is unset or empty → documented default: deletions RUN. */
  | 'unset'
  /** A recognised truthy spelling → deletions PAUSED. */
  | 'explicit_pause'
  /** A recognised falsey spelling → deletions RUN. */
  | 'explicit_run'
  /** A non-empty value we do not recognise → deletions PAUSED (fail safe). */
  | 'unrecognised';

export interface DryRunResolution {
  /** The EFFECTIVE mode. true = count only, delete nothing. */
  dryRun: boolean;
  reason: DryRunResolutionReason;
  /** The configured value, trimmed; null when unset/empty. Safe to log — this is an
   *  operational flag, never a secret. */
  raw: string | null;
}

/**
 * Resolve the CORRECTION_RETENTION_DRY_RUN operator kill-switch into an EFFECTIVE mode.
 *
 * F1 — WHY THIS IS NOT `=== 'true'` ANY MORE. It was, and that was a live
 * data-destruction hazard: `CORRECTION_RETENTION_DRY_RUN="TRUE"` and `="1"` both failed
 * the exact-literal test, resolved to dryRun=false, and permanently deleted real
 * correction_report rows while the operator believed deletions were paused. QA reproduced
 * both against a real database. A kill-switch that silently ignores the two most obvious
 * spellings of "on" is worse than no kill-switch, because it manufactures false confidence
 * in front of an IRREVERSIBLE action.
 *
 * THE UNSET DEFAULT IS DELIBERATELY UNCHANGED. Unset → dryRun=false → deletions really
 * happen. The route (app/api/corrections/retention/run/route.ts:13-18), this module's
 * header, .env.example and the privacy page's automatic-deletion promise all agree on
 * that, and the compliance claim depends on deletions actually occurring by default.
 * Making "unset" mean "paused" would quietly turn the retention guarantee off everywhere
 * it has not been explicitly configured, which is the larger harm.
 *
 * AN UNRECOGNISED NON-EMPTY VALUE PAUSES, LOUDLY. The two states are not symmetric:
 * wrongly pausing costs a delayed purge that the next run fixes, wrongly deleting is
 * unrecoverable. An operator who set the variable at all was reaching for the switch —
 * "PAUSE"/"enabled"/"yes please" are far likelier to mean "stop deleting" than "destroy".
 * So an unparseable value resolves to dryRun=true and warns; the warning is what gets it
 * corrected, and nothing is lost while it is wrong.
 */
export function resolveCorrectionRetentionDryRun(): DryRunResolution {
  const raw = env(CORRECTION_RETENTION_DRY_RUN_ENV) ?? null;
  if (raw === null) return { dryRun: false, reason: 'unset', raw: null };

  const normalised = raw.toLowerCase();
  if (TRUTHY.has(normalised)) return { dryRun: true, reason: 'explicit_pause', raw };
  if (FALSEY.has(normalised)) return { dryRun: false, reason: 'explicit_run', raw };

  // Loud, from BOTH runtimes: this is a misconfiguration in front of a permanent delete.
  // eslint-disable-next-line no-console
  console.warn(
    `[corrections-retention] ${CORRECTION_RETENTION_DRY_RUN_ENV}="${raw}" is not a ` +
      `recognised boolean; FAILING SAFE to dryRun=true (counting only, deleting nothing). ` +
      `Set it to one of ${[...TRUTHY].join('/')} to pause, ` +
      `${[...FALSEY].join('/')} to delete, or unset it to restore the default (delete).`
  );
  return { dryRun: true, reason: 'unrecognised', raw };
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
