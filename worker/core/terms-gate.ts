// worker/core/terms-gate.ts — G-T5-6: terms/robots production-enablement gate
// (TSD §5.3, §10). L3 — no adapter may bypass this. Blocks any source whose
// terms_status isn't allowed/summarise-only from running in production.
// Staging is permitted for review-safe fixture runs, but explicit disallow/block
// decisions and robots disallow still stop ingestion. Every decision should be persisted by the caller
// (e.g. onto source_check_run.errors or a dedicated log) for audit.
//
// This module is also the SINGLE authoring point for the robots clearance rule, in both
// TypeScript and SQL (F-5 / migration 0022) — see the block comment above
// hasRobotsUnverifiableOverride for why that matters and what it prevents.

export type Environment = 'staging' | 'production';

export interface SourceTermsInfo {
  id: string;
  termsStatus: string; // 'pending' | 'allowed' | 'summarise_only' | 'disallowed' | 'blocked'
  robotsStatus?: string; // 'pending' | 'allowed' | 'disallowed' | 'unknown'
  /**
   * Decision-record reference authorising live fetch despite an UNREADABLE robots.txt
   * (F-5 / D-12 — see docs/source-register.md §7 and 0022_source_robots_override.sql).
   * NULL/absent for every ordinary source. OPTIONAL on purpose: a caller that has not
   * learned about the override omits it and gets exactly today's behaviour, i.e. the
   * un-taught path is the fail-closed one.
   */
  robotsOverrideDecision?: string | null;
}

export interface GateDecision {
  allowed: boolean;
  reason: string;
}

const APPROVED_TERMS_STATUSES = new Set(['allowed', 'summarise_only']);
const STAGING_BLOCKED_STATUSES = new Set(['disallowed', 'blocked']);

// ─────────────────────────────────────────────────────────────────────────────
// The robots clearance rule — stated ONCE, in two languages.
//
// It has to exist in two languages because the two enforcement points are genuinely
// different machines: worker/core/source-runner.ts (and the seasonal watcher) decide
// per-row in TypeScript, while worker/scheduler/tiered.ts decides set-wise in SQL so an
// un-cleared source is never even enqueued. What must NOT be duplicated is the AUTHORING
// of the rule. QA found exactly that trap on this change: fixing only the TS gate would
// have let NVDPL pass "is this allowed?" while the scheduler silently never enqueued it —
// a source that is enabled and never runs, with nothing anywhere reporting a problem.
// So both come from here, and tests/scheduler/robots-override-db.test.ts asserts the two
// agree row-for-row against a real database rather than trusting that they do.
// ─────────────────────────────────────────────────────────────────────────────

/** The one robots_status that means "a human read robots.txt and it permits us". */
const ROBOTS_VERIFIED_ALLOWED = 'allowed';
/** The robots_status an override may be attached to: "we looked and could not determine". */
const ROBOTS_UNREADABLE = 'unknown';

/**
 * True only when this source carries a real, non-blank decision-record reference AND its
 * robots_status is the one that reference is allowed to speak for.
 *
 * Both halves are load-bearing:
 *   • the status alone is not enough — a source nobody has ever checked is also 'unknown',
 *     and must keep failing closed;
 *   • the reference alone is not enough — it authorises an *unreadable* robots.txt, and
 *     says nothing about a robots.txt that was read and refused.
 * A whitespace-only reference is treated as absent: '' is non-NULL, and a gate keyed on
 * `!= null` would otherwise hand full clearance to an empty string.
 */
export function hasRobotsUnverifiableOverride(source: SourceTermsInfo): boolean {
  return (
    source.robotsStatus === ROBOTS_UNREADABLE &&
    typeof source.robotsOverrideDecision === 'string' &&
    source.robotsOverrideDecision.trim() !== ''
  );
}

/** Canonical "may this source's robots posture permit a live fetch?" — TS side. */
export function isRobotsClearedForLiveFetch(source: SourceTermsInfo): boolean {
  return source.robotsStatus === ROBOTS_VERIFIED_ALLOWED || hasRobotsUnverifiableOverride(source);
}

/**
 * SQL twin of isRobotsClearedForLiveFetch(), for set-based enforcement in the scheduler.
 *
 * `alias` is the `source` table's alias in the caller's query. It is interpolated into SQL,
 * so it is a code-supplied identifier only — never a value from a request, a row or a
 * config file. Kept a parameter rather than hard-coding `s.` so the coupling is visible in
 * the signature instead of living in a comment nobody reads.
 */
export function robotsClearedForLiveFetchSql(alias = 's'): string {
  return `(
         ${alias}.robots_status = '${ROBOTS_VERIFIED_ALLOWED}'
      OR (${alias}.robots_status = '${ROBOTS_UNREADABLE}'
          AND btrim(coalesce(${alias}.robots_override_decision, '')) <> '')
       )`;
}

/**
 * The `source` columns any live-fetch gate decision must SELECT. A gate handed a row that
 * omits robots_override_decision silently fails closed on an authorised source — the
 * "enabled at one gate, never runs" shape again, just moved into the query. Every SELECT
 * that feeds evaluateLiveFetchGate uses this list.
 */
export const SOURCE_GATE_COLUMNS = 'terms_status, robots_status, robots_override_decision';

/**
 * Single source of truth for "this source is terms-approved for production use" —
 * the same set the production terms gate and the DB write-time invariant use
 * (supabase/migrations/0021_confirmed_requires_terms_approval.sql). A source that is
 * NOT approved may still be run in STAGING review, but its occurrences must never
 * surface as user-visible 'confirmed' (Round 27 approval-bypass incident).
 */
export function isTermsApprovedForProduction(termsStatus: string | null | undefined): boolean {
  return termsStatus != null && APPROVED_TERMS_STATUSES.has(termsStatus);
}

export function evaluateTermsGate(source: SourceTermsInfo, env: Environment): GateDecision {
  if (source.robotsStatus === 'disallowed') {
    return { allowed: false, reason: 'blocked — robots_status=disallowed' };
  }

  if (env === 'staging') {
    if (STAGING_BLOCKED_STATUSES.has(source.termsStatus)) {
      return { allowed: false, reason: `staging blocked — terms_status=${source.termsStatus}` };
    }
    return { allowed: true, reason: `staging review — terms_status=${source.termsStatus}` };
  }
  if (APPROVED_TERMS_STATUSES.has(source.termsStatus)) {
    return { allowed: true, reason: `production enabled — terms_status=${source.termsStatus}` };
  }
  return {
    allowed: false,
    reason: `production blocked — terms_status=${source.termsStatus} is not in {allowed, summarise_only}`,
  };
}

/**
 * Stronger gate for live HTTP/render fetching. Staging review may run fixture-only
 * pending sources, but live network access requires an explicit D-6 approval:
 * terms_status allowed/summarise_only AND robots cleared (robots_status='allowed', or the
 * F-5 unreadable-robots.txt override — isRobotsClearedForLiveFetch above).
 *
 * The terms check stays FIRST and is not overridable: the robots override answers exactly
 * one question ("may we fetch a site whose robots.txt we cannot read?") and discharges
 * nothing else. NVDPL's own decision record, D-12, says the same thing in prose.
 */
export function evaluateLiveFetchGate(source: SourceTermsInfo, env: Environment): GateDecision {
  if (!APPROVED_TERMS_STATUSES.has(source.termsStatus)) {
    return {
      allowed: false,
      reason: `${env} live fetch blocked — terms_status=${source.termsStatus} is not in {allowed, summarise_only}`,
    };
  }
  if (!isRobotsClearedForLiveFetch(source)) {
    return {
      allowed: false,
      reason: `${env} live fetch blocked — robots_status=${source.robotsStatus ?? 'unknown'} is not allowed and carries no robots_override_decision`,
    };
  }
  if (hasRobotsUnverifiableOverride(source)) {
    // Named in the reason string so it lands in source_check_run.errors / the run log:
    // an override should be visible in the audit trail every time it is exercised, not
    // only in the row that granted it.
    return {
      allowed: true,
      reason: `${env} live fetch enabled — terms approved; robots.txt UNREADABLE, overridden by decision ${source.robotsOverrideDecision}`,
    };
  }
  return { allowed: true, reason: `${env} live fetch enabled — terms and robots approved` };
}
