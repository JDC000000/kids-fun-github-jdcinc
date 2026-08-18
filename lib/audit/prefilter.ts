// lib/audit/prefilter.ts — the cheap deterministic pass over EVERY row.
//
// COST DISCIPLINE, WHICH IS THE WHOLE ARCHITECTURE
// The catalogue is 4,874 live listings and growing. Sending all of them to a model weekly is
// both wasteful and slow, and — more importantly — it is unnecessary: the two patterns are
// contradictions between two fields we already hold, and a contradiction is exactly what a
// regex is good at spotting. So every row goes through this (pure, in-process, no I/O, no
// tokens), and ONLY what survives is ever shown to a model.
//
// The prefilter is intentionally permissive: it is allowed to raise "park" in a title, because
// the stage after it exists to throw that away. What it must never do is silently drop a row —
// so it reports `considered` alongside the candidates, and the CLI prints both.
import { AUDIT_RULES, RULE_CUSTOM_ID_PREFIX } from './registry';
import type { AuditListing, AuditRule, Candidate } from './types';

export interface PrefilterResult {
  /** Every row examined. Printed next to the candidate count so coverage is never implied. */
  considered: number;
  candidates: Candidate[];
  /** candidates grouped by ruleId, for the per-pattern numbers the report leads with. */
  countsByRule: Record<string, number>;
  /** Of those, how many rested on weak evidence only (i.e. need adjudication to mean anything). */
  weakOnlyByRule: Record<string, number>;
}

function customIdFor(rule: AuditRule, listing: AuditListing): string {
  const prefix = RULE_CUSTOM_ID_PREFIX[rule.id] ?? 'rx';
  // Anthropic requires ^[a-zA-Z0-9_-]{1,64}$. A UUID is 36 chars of that alphabet; the prefix
  // adds 3. Any id that is not already legal is escaped rather than truncated, because two
  // truncated ids could collide and results are keyed by custom_id.
  const safe = listing.id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60);
  return `${prefix}-${safe}`;
}

/** Run every rule over every listing. Pure; safe to call on the whole catalogue. */
export function prefilter(listings: AuditListing[], rules: AuditRule[] = AUDIT_RULES): PrefilterResult {
  const candidates: Candidate[] = [];
  const countsByRule: Record<string, number> = {};
  const weakOnlyByRule: Record<string, number> = {};
  for (const rule of rules) {
    countsByRule[rule.id] = 0;
    weakOnlyByRule[rule.id] = 0;
  }

  for (const listing of listings) {
    for (const rule of rules) {
      const signal = rule.detect(listing);
      if (!signal) continue;
      const weakOnly = signal.evidence.every((e) => e.strength === 'weak');
      candidates.push({
        ruleId: rule.id,
        severity: rule.severity,
        listing,
        signal,
        weakOnly,
        customId: customIdFor(rule, listing),
      });
      countsByRule[rule.id] += 1;
      if (weakOnly) weakOnlyByRule[rule.id] += 1;
    }
  }

  return { considered: listings.length, candidates, countsByRule, weakOnlyByRule };
}
