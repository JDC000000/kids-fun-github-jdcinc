// scripts/safety-audit.ts — the catalogue safety auditor, runnable on demand and by cron.
//
// READ-ONLY. It issues GETs to the public search API and writes files under --out. It opens no
// database connection, needs no DATABASE_URL, and cannot modify a listing.
//
// It imports the REAL lib/audit + lib/llm modules rather than reimplementing them, so the thing
// measured here is the thing that ships — same reasoning as scripts/search-cap-probe.ts, and the
// same build path (esbuild from vitest's dependency tree; there is no ts-node/tsx in this repo).
//
//   bash scripts/safety-audit.sh                          # dry run, delta mode, prints summary
//   bash scripts/safety-audit.sh --out .audit --json      # write report.json + report.md
//   bash scripts/safety-audit.sh --mode as_served         # only what production serves today
//   bash scripts/safety-audit.sh --live                   # ALSO adjudicate with Haiku (gated)
//
// --live still cannot spend money unless BOTH ANTHROPIC_API_KEY is provisioned and
// LLM_BATCH_ENABLED=true; without them lib/llm/safety-audit.ts resolves the unprovisioned client
// and falls back to prefilter-only. That is the gate, not this flag.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sweepCatalogue } from '@/lib/audit/sources/search-api';
import { prefilter } from '@/lib/audit/prefilter';
import { adjudicateCandidates, toFindings } from '@/lib/llm/safety-audit';
import {
  buildDelta,
  buildReport,
  renderDeltaMarkdown,
  renderMarkdown,
  summariseCandidates,
  type RunMeta,
} from '@/lib/audit/report';
import type { TagMode } from '@/lib/audit/tags';
import type { Candidate } from '@/lib/audit/types';

const DEFAULT_BASE_URL = 'https://kids-fun-psi.vercel.app';

interface Args {
  baseUrl: string;
  mode: 'as_served' | 'post_fix' | 'delta';
  out: string | null;
  json: boolean;
  live: boolean;
  delayMs: number;
  maxCandidates: number | undefined;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const rawMode = get('--mode') ?? 'delta';
  if (rawMode !== 'as_served' && rawMode !== 'post_fix' && rawMode !== 'delta') {
    throw new Error(`--mode must be as_served | post_fix | delta (got "${rawMode}")`);
  }
  const rawMax = get('--max-candidates');
  return {
    baseUrl: get('--base-url') ?? DEFAULT_BASE_URL,
    mode: rawMode,
    out: get('--out') ?? null,
    json: argv.includes('--json'),
    live: argv.includes('--live'),
    delayMs: Number(get('--delay') ?? 120),
    maxCandidates: rawMax ? Number(rawMax) : undefined,
  };
}

const log = (msg: string) => process.stderr.write(`${msg}\n`);

async function runOne(args: Args, mode: TagMode) {
  log(`\n── sweeping catalogue (mode=${mode}) ──`);
  const sweep = await sweepCatalogue({
    baseUrl: args.baseUrl,
    mode,
    delayMs: args.delayMs,
    onProgress: log,
  });

  const pre = prefilter(sweep.listings);
  log(
    `prefilter: ${pre.candidates.length} candidates from ${pre.considered} rows — ` +
      Object.entries(pre.countsByRule)
        .map(([r, n]) => `${r}=${n} (weak-only ${pre.weakOnlyByRule[r]})`)
        .join(', ')
  );

  const adjudication = await adjudicateCandidates(pre.candidates, {
    dryRun: !args.live,
    maxCandidates: args.maxCandidates,
  });
  log(
    adjudication.dryRun
      ? 'adjudication: DRY RUN — no model call, no tokens, $0'
      : `adjudication: ${adjudication.submitted} submitted, ${adjudication.verdicts.size} verdicts, ${adjudication.unresolved} unresolved`
  );

  const findings = toFindings(pre.candidates, adjudication.verdicts, args.baseUrl);

  const meta: RunMeta = {
    // Stamped by the caller's clock at the boundary, so the pure report builder stays testable.
    generatedAt: new Date().toISOString(),
    baseUrl: args.baseUrl,
    mode,
    catalogueTotal: sweep.catalogueTotal,
    swept: sweep.listings.length,
    coverage: sweep.coverage,
    requests: sweep.requests,
    truncatedCells: sweep.truncatedCells.length,
    considered: pre.considered,
    candidates: pre.candidates.length,
    countsByRule: pre.countsByRule,
    weakOnlyByRule: pre.weakOnlyByRule,
    adjudication: {
      dryRun: adjudication.dryRun,
      submitted: adjudication.submitted,
      cappedOut: adjudication.cappedOut,
      unresolved: adjudication.unresolved,
      timedOut: adjudication.timedOut,
    },
  };

  return {
    report: buildReport(meta, findings, summariseCandidates(pre.candidates)),
    candidates: pre.candidates,
    countsByRule: pre.countsByRule,
  };
}

function candidateKeys(candidates: Candidate[]) {
  return candidates.map((c) => ({ ruleId: c.ruleId, listingId: c.listing.id }));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const written: string[] = [];
  if (args.out) mkdirSync(args.out, { recursive: true });

  const emit = (name: string, body: string) => {
    if (!args.out) return;
    const path = join(args.out, name);
    writeFileSync(path, body);
    written.push(path);
  };

  if (args.mode === 'delta') {
    // Two sweeps, not one filtered twice: the as-served run must read production's OWN
    // suitabilityTags, so re-deriving from a single sweep would compare our model of the
    // current rule against our model of the fixed one, and prove nothing about production.
    const served = await runOne(args, 'as_served');
    const fixed = await runOne(args, 'post_fix');
    const delta = buildDelta(
      { candidates: candidateKeys(served.candidates), findings: served.report.findings.length, countsByRule: served.countsByRule },
      { candidates: candidateKeys(fixed.candidates), findings: fixed.report.findings.length, countsByRule: fixed.countsByRule }
    );
    const md = `${renderMarkdown(served.report)}\n\n---\n\n${renderMarkdown(fixed.report)}\n\n---\n\n${renderDeltaMarkdown(delta)}`;
    emit('report.md', md);
    emit('report.json', JSON.stringify({ asServed: served.report, postFix: fixed.report, delta }, null, 2));
    process.stdout.write(args.json ? JSON.stringify({ asServed: served.report, postFix: fixed.report, delta }, null, 2) : md);
  } else {
    const run = await runOne(args, args.mode);
    const md = renderMarkdown(run.report);
    emit('report.md', md);
    emit('report.json', JSON.stringify(run.report, null, 2));
    process.stdout.write(args.json ? JSON.stringify(run.report, null, 2) : md);
  }

  process.stdout.write('\n');
  for (const p of written) log(`wrote ${p}`);
}

main().catch((err) => {
  log(`safety-audit FAILED: ${(err as Error).message}`);
  process.exitCode = 1;
});
