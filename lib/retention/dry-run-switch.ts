// lib/retention/dry-run-switch.ts — ONE parser for every retention kill-switch.
//
// ═══ WHY THIS EXISTS AS A SHARED MODULE (F1, and its still-unfixed twin) ═══
// A retention kill-switch stands in front of an IRREVERSIBLE action, and it was already got
// wrong once, live: CORRECTION_RETENTION_DRY_RUN was compared with `=== 'true'`, so "TRUE" and
// "1" both failed the match, resolved to "delete for real", and permanently destroyed rows while
// the operator believed deletions were paused. QA reproduced both against a real database.
//
// That fix was applied to lib/corrections/retention-config.ts and NOT to
// lib/analytics/config.ts:69, which still reads `env('ANALYTICS_RETENTION_DRY_RUN') === 'true'`
// and is therefore still carrying the identical hazard in front of its own permanent delete.
// Two implementations of one rule is how that happened; a third would be how it happens again.
//
// So the rule lives here once and the callers keep only their own env-var name and their own
// documented UNSET default, which genuinely differ per job and are the only things that should.
//
// NO IMPORTS, DELIBERATELY. This module is in the Fly worker's compiled closure
// (worker/core/sms-retention.ts -> lib/sms/retention-config.ts -> here), which is built by plain
// tsc and run under bare node. A '@/...' specifier is emitted verbatim and cannot resolve there —
// see worker/tsconfig.json and tests/scheduler/worker-image-closure.test.ts. Nothing to import
// keeps that trivially true.

/** Spellings that mean "yes, pause deletions". Compared lowercase + trimmed. */
export const DRY_RUN_TRUTHY = new Set(['true', 't', 'yes', 'y', 'on', '1']);

/** Spellings that mean "no, delete for real". Compared lowercase + trimmed. */
export const DRY_RUN_FALSEY = new Set(['false', 'f', 'no', 'n', 'off', '0']);

/** How the effective dry-run mode was arrived at — the thing worth logging. */
export type DryRunResolutionReason =
  /** The env var is unset or empty → that job's documented default. */
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
  /** The configured value, trimmed; null when unset/empty. Safe to log — an operational
   *  flag, never a secret. */
  raw: string | null;
}

function readEnv(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : null;
}

/**
 * Resolve a retention kill-switch into an EFFECTIVE mode.
 *
 * `unsetMeans` is the ONLY per-job knob, and it is required rather than defaulted so that
 * adding a new retention job forces an explicit decision about what "not configured" means in
 * front of that job's permanent action. A default here would let the most consequential choice
 * be made by omission.
 *
 * AN UNRECOGNISED NON-EMPTY VALUE ALWAYS PAUSES, LOUDLY, whatever `unsetMeans` says. The two
 * error states are not symmetric: wrongly pausing costs a delayed purge the next run fixes,
 * wrongly deleting is unrecoverable. An operator who set the variable at all was reaching for
 * the switch — "PAUSE" / "enabled" / "yes please" far likelier mean "stop" than "destroy".
 */
export function resolveDryRunSwitch(
  envVar: string,
  unsetMeans: 'run' | 'pause',
  logPrefix: string
): DryRunResolution {
  const raw = readEnv(envVar);
  if (raw === null) {
    return { dryRun: unsetMeans === 'pause', reason: 'unset', raw: null };
  }

  const normalised = raw.toLowerCase();
  if (DRY_RUN_TRUTHY.has(normalised)) return { dryRun: true, reason: 'explicit_pause', raw };
  if (DRY_RUN_FALSEY.has(normalised)) return { dryRun: false, reason: 'explicit_run', raw };

  // Loud, from BOTH runtimes: a misconfiguration in front of a permanent delete.
  // eslint-disable-next-line no-console
  console.warn(
    `[${logPrefix}] ${envVar}="${raw}" is not a recognised boolean; FAILING SAFE to ` +
      `dryRun=true (counting only, deleting nothing). Set it to one of ` +
      `${[...DRY_RUN_TRUTHY].join('/')} to pause, ${[...DRY_RUN_FALSEY].join('/')} to delete, ` +
      `or unset it to restore the default (${unsetMeans}).`
  );
  return { dryRun: true, reason: 'unrecognised', raw };
}
