// lib/audit/report.ts — the two outputs: a machine-readable report and a human summary.
//
// Both are produced from the same object, so the summary can never say something the JSON
// doesn't contain. The JSON is the artefact a future run diffs against; the markdown is what a
// person reads on a Monday.
//
// EVERY NUMBER IS REPORTED NEXT TO ITS DENOMINATOR. `considered`, `coverage`, `cappedOut` and
// `truncatedCells` all appear in the summary header, above the findings — because "12 findings"
// means nothing without "out of 4,874 rows, 98% of the catalogue swept". An auditor that prints
// only the numerator is how a partial sweep gets mistaken for a clean bill of health.
import type { Candidate, Finding, Severity } from './types';
import type { TagMode } from './tags';

export interface RunMeta {
  /** ISO timestamp, passed in — this module has no clock, so its output is testable. */
  generatedAt: string;
  baseUrl: string;
  mode: TagMode;
  catalogueTotal: number;
  swept: number;
  coverage: number;
  requests: number;
  truncatedCells: number;
  considered: number;
  candidates: number;
  countsByRule: Record<string, number>;
  weakOnlyByRule: Record<string, number>;
  adjudication: {
    dryRun: boolean;
    submitted: number;
    cappedOut: number;
    unresolved: number;
    timedOut: boolean;
  };
}

/**
 * One prefilter candidate, compacted. EVERY candidate is emitted, including the weak ones the
 * promotion rule drops — because "what did the cheap stage flag, and what happened to it" is
 * the only way to audit the auditor. Without this the weak tier is invisible and its
 * false-positive rate is unmeasurable, which is how a noisy rule survives unnoticed.
 */
export interface CandidateSummary {
  ruleId: string;
  listingId: string;
  seriesId: string | null;
  activityName: string;
  organisation: string;
  weakOnly: boolean;
  evidence: Finding['evidence'];
  derivedClaim: string;
  ageWording: string;
}

export function summariseCandidates(candidates: Candidate[]): CandidateSummary[] {
  return candidates.map((c) => ({
    ruleId: c.ruleId,
    listingId: c.listing.id,
    seriesId: c.listing.seriesId,
    activityName: c.listing.source.title,
    organisation: c.listing.organisation,
    weakOnly: c.weakOnly,
    evidence: c.signal.evidence,
    derivedClaim: c.signal.derivedClaim,
    ageWording: c.listing.source.ageWording,
  }));
}

export interface AuditReport {
  version: 1;
  meta: RunMeta;
  findings: Finding[];
  candidates: CandidateSummary[];
  findingsByRule: Record<string, number>;
  findingsBySeverity: Record<string, number>;
}

export function buildReport(meta: RunMeta, findings: Finding[], candidates: CandidateSummary[] = []): AuditReport {
  const findingsByRule: Record<string, number> = {};
  const findingsBySeverity: Record<string, number> = {};
  for (const f of findings) {
    findingsByRule[f.ruleId] = (findingsByRule[f.ruleId] ?? 0) + 1;
    const key = `sev${f.severity}`;
    findingsBySeverity[key] = (findingsBySeverity[key] ?? 0) + 1;
  }
  return { version: 1, meta, findings, candidates, findingsByRule, findingsBySeverity };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function severityLabel(s: Severity): string {
  return s === 3 ? 'SEV-3 child-safety' : s === 2 ? 'SEV-2' : 'SEV-1';
}

export function renderMarkdown(report: AuditReport): string {
  const m = report.meta;
  const lines: string[] = [];

  lines.push(`# KIDS FUN — catalogue safety audit`);
  lines.push('');
  lines.push(`Generated ${m.generatedAt} against ${m.baseUrl} (tag mode: **${m.mode}**).`);
  lines.push('');
  lines.push('## Coverage — read this before the findings');
  lines.push('');
  lines.push(`| | |`);
  lines.push(`|---|---|`);
  lines.push(`| Catalogue size (API \`total\`) | ${m.catalogueTotal} |`);
  lines.push(`| Listings swept | ${m.swept} (${pct(m.coverage)}) |`);
  lines.push(`| API requests | ${m.requests} |`);
  lines.push(`| Cells truncated at the 100-row page limit | ${m.truncatedCells} |`);
  lines.push(`| Rows run through the prefilter | ${m.considered} |`);
  lines.push(`| Prefilter candidates | ${m.candidates} |`);
  lines.push(
    `| Adjudication | ${m.adjudication.dryRun ? 'DRY RUN (prefilter only, no model call, $0)' : `${m.adjudication.submitted} submitted, ${m.adjudication.unresolved} unresolved`} |`
  );
  if (m.adjudication.cappedOut > 0) {
    lines.push(`| Candidates dropped by the per-run cap | ${m.adjudication.cappedOut} |`);
  }
  if (m.adjudication.timedOut) {
    lines.push(`| Batch timed out | yes — results are partial |`);
  }
  lines.push('');

  lines.push('## Prefilter candidates by pattern');
  lines.push('');
  lines.push(`| Pattern | Candidates | of which weak-evidence only |`);
  lines.push(`|---|---:|---:|`);
  for (const [ruleId, count] of Object.entries(m.countsByRule)) {
    lines.push(`| \`${ruleId}\` | ${count} | ${m.weakOnlyByRule[ruleId] ?? 0} |`);
  }
  lines.push('');

  lines.push('## Reported findings');
  lines.push('');
  if (report.findings.length === 0) {
    lines.push('_No findings survived promotion._');
    lines.push('');
  } else {
    lines.push(`| Pattern | Findings |`);
    lines.push(`|---|---:|`);
    for (const [ruleId, count] of Object.entries(report.findingsByRule)) {
      lines.push(`| \`${ruleId}\` | ${count} |`);
    }
    lines.push('');
    for (const f of report.findings) {
      const repeat = f.occurrences > 1 ? ` (×${f.occurrences} occurrences)` : '';
      lines.push(`### ${severityLabel(f.severity)} — ${f.activityName}${repeat}`);
      lines.push('');
      lines.push(`- **Rule:** \`${f.ruleId}\` — ${f.title}`);
      lines.push(`- **Listing:** \`${f.listingId}\` (${f.organisation})`);
      lines.push(`- **Preview:** ${f.previewUrl}`);
      if (f.sourceUrl) lines.push(`- **Source:** ${f.sourceUrl}`);
      lines.push(
        `- **Source said:** ${f.evidence.map((e) => `"${e.quote}" (${e.field}, ${e.strength})`).join('; ')}`
      );
      lines.push(`- **We derived:** ${f.derivedClaim}`);
      lines.push(
        f.verdict
          ? `- **Adjudicated:** contradiction=${f.verdict.contradiction}, confidence=${f.verdict.confidence.toFixed(2)} — ${f.verdict.reason}`
          : `- **Adjudicated:** not reviewed by a model; promoted on strong deterministic evidence alone`
      );
      lines.push('');
    }
  }

  return lines.join('\n');
}

export interface DeltaReport {
  asServed: { candidates: number; countsByRule: Record<string, number>; findings: number };
  postFix: { candidates: number; countsByRule: Record<string, number>; findings: number };
  /** postFix − asServed, per rule. Negative = the fix removed candidates. */
  candidateDeltaByRule: Record<string, number>;
  /** Listing ids that stop being candidates under the fixed derivation. */
  resolvedByFix: string[];
  /** Listing ids that are candidates ONLY under the fixed derivation (a regression, if any). */
  introducedByFix: string[];
}

/**
 * Compare an as-served run against a post-fix run of the SAME rule set over the SAME rows.
 *
 * This is what makes the auditor double as independent verification of `fix/kf-safety-tagging`.
 * `resolvedByFix` should be dominated by pattern-1 rows whose only sin was the `class_program`
 * catch-all; `introducedByFix` should be EMPTY — a non-empty list means the fix changes the
 * derivation for rows that were previously fine, which is a regression worth knowing about
 * before it ships rather than after.
 */
export function buildDelta(
  asServed: { candidates: Array<{ ruleId: string; listingId: string }>; findings: number; countsByRule: Record<string, number> },
  postFix: { candidates: Array<{ ruleId: string; listingId: string }>; findings: number; countsByRule: Record<string, number> }
): DeltaReport {
  const key = (c: { ruleId: string; listingId: string }) => `${c.ruleId}::${c.listingId}`;
  const before = new Set(asServed.candidates.map(key));
  const after = new Set(postFix.candidates.map(key));

  const candidateDeltaByRule: Record<string, number> = {};
  for (const ruleId of new Set([...Object.keys(asServed.countsByRule), ...Object.keys(postFix.countsByRule)])) {
    candidateDeltaByRule[ruleId] = (postFix.countsByRule[ruleId] ?? 0) - (asServed.countsByRule[ruleId] ?? 0);
  }

  return {
    asServed: { candidates: asServed.candidates.length, countsByRule: asServed.countsByRule, findings: asServed.findings },
    postFix: { candidates: postFix.candidates.length, countsByRule: postFix.countsByRule, findings: postFix.findings },
    candidateDeltaByRule,
    resolvedByFix: [...before].filter((k) => !after.has(k)),
    introducedByFix: [...after].filter((k) => !before.has(k)),
  };
}

export function renderDeltaMarkdown(delta: DeltaReport): string {
  const lines: string[] = [];
  lines.push('## Delta — current behaviour vs `fix/kf-safety-tagging`');
  lines.push('');
  lines.push('| Pattern | as served | post-fix | delta |');
  lines.push('|---|---:|---:|---:|');
  for (const [ruleId, d] of Object.entries(delta.candidateDeltaByRule)) {
    const before = delta.asServed.countsByRule[ruleId] ?? 0;
    const after = delta.postFix.countsByRule[ruleId] ?? 0;
    lines.push(`| \`${ruleId}\` | ${before} | ${after} | ${d > 0 ? `+${d}` : d} |`);
  }
  lines.push('');
  lines.push(`- Candidates resolved by the fix: **${delta.resolvedByFix.length}**`);
  lines.push(
    `- Candidates INTRODUCED by the fix: **${delta.introducedByFix.length}**${delta.introducedByFix.length === 0 ? ' (expected: 0)' : ' ← regression, investigate'}`
  );
  lines.push('');
  return lines.join('\n');
}
