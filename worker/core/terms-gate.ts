// worker/core/terms-gate.ts — G-T5-6: terms/robots production-enablement gate
// (TSD §5.3, §10). L3 — no adapter may bypass this. Blocks any source whose
// terms_status isn't allowed/summarise-only from running in production.
// Staging is permitted for review regardless of terms_status (§5.3: "staging
// allowed for review"). Every decision should be persisted by the caller
// (e.g. onto source_check_run.errors or a dedicated log) for audit.

export type Environment = 'staging' | 'production';

export interface SourceTermsInfo {
  id: string;
  termsStatus: string; // 'pending' | 'allowed' | 'summarise_only' | 'disallowed' | 'blocked'
}

export interface GateDecision {
  allowed: boolean;
  reason: string;
}

const PRODUCTION_ALLOWED_STATUSES = new Set(['allowed', 'summarise_only']);

export function evaluateTermsGate(source: SourceTermsInfo, env: Environment): GateDecision {
  if (env === 'staging') {
    return { allowed: true, reason: `staging review — terms_status=${source.termsStatus}` };
  }
  if (PRODUCTION_ALLOWED_STATUSES.has(source.termsStatus)) {
    return { allowed: true, reason: `production enabled — terms_status=${source.termsStatus}` };
  }
  return {
    allowed: false,
    reason: `production blocked — terms_status=${source.termsStatus} is not in {allowed, summarise_only}`,
  };
}
