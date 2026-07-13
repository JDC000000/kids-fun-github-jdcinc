// worker/core/terms-gate.ts — G-T5-6: terms/robots production-enablement gate
// (TSD §5.3, §10). L3 — no adapter may bypass this. Blocks any source whose
// terms_status isn't allowed/summarise-only from running in production.
// Staging is permitted for review-safe fixture runs, but explicit disallow/block
// decisions and robots disallow still stop ingestion. Every decision should be persisted by the caller
// (e.g. onto source_check_run.errors or a dedicated log) for audit.

export type Environment = 'staging' | 'production';

export interface SourceTermsInfo {
  id: string;
  termsStatus: string; // 'pending' | 'allowed' | 'summarise_only' | 'disallowed' | 'blocked'
  robotsStatus?: string; // 'pending' | 'allowed' | 'disallowed' | 'unknown'
}

export interface GateDecision {
  allowed: boolean;
  reason: string;
}

const APPROVED_TERMS_STATUSES = new Set(['allowed', 'summarise_only']);
const STAGING_BLOCKED_STATUSES = new Set(['disallowed', 'blocked']);

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
 * terms_status allowed/summarise_only AND robots_status allowed.
 */
export function evaluateLiveFetchGate(source: SourceTermsInfo, env: Environment): GateDecision {
  if (!APPROVED_TERMS_STATUSES.has(source.termsStatus)) {
    return {
      allowed: false,
      reason: `${env} live fetch blocked — terms_status=${source.termsStatus} is not in {allowed, summarise_only}`,
    };
  }
  if (source.robotsStatus !== 'allowed') {
    return {
      allowed: false,
      reason: `${env} live fetch blocked — robots_status=${source.robotsStatus ?? 'unknown'} is not allowed`,
    };
  }
  return { allowed: true, reason: `${env} live fetch enabled — terms and robots approved` };
}
