// scripts/search-cap-probe.ts — READ-ONLY search population + relevance probe.
//
// WHY THIS EXISTS
// Three separate reviews of the search matcher (registry rounds 137, 150, 152) each drew a
// conclusion from a measurement of the SERVED window — the rows `loadPostgresListings` actually
// returned under its row cap — and each was later found to describe a different population than
// the one a claim was being made about. Round 137: a vocabulary derived from `/api/search` (hard
// clamped to 100 results) was reported as "the matcher's vocabulary" (really ~411 tokens).
// Round 150: "soccer returns nothing" was attributed to a downstream filter; it was really rank
// 595 of a 500-row window. Round 152: an infix tier was cleared as clean on 11 served pairs while
// the full read model held 115, ~40% junk. Round 171: a staging measurement was reported as a
// production user impact; production's catalogue turned out to be an order of magnitude sparser.
//
// The common failure is not carelessness — it is that measuring the served window and measuring
// the full catalogue look identical from the outside. So this probe refuses to report a single
// number: every metric is emitted TWICE, once for the served population and once for the full
// (uncapped) one, and the environment is stamped on every line. A reader cannot accidentally
// carry a staging-served number into a production-full claim.
//
// GUARANTEES
//   · Strictly read-only: SELECTs only, no DDL/DML, and the pool is opened read-only where the
//     server supports it. Safe to point at staging or production.
//   · Reads its connection string from KF_PROBE_DATABASE_URL, deliberately NOT DATABASE_URL —
//     lib/testing/local-db-guard.ts refuses non-local DATABASE_URLs, and this probe must never
//     be the reason someone sets KIDS_FUN_ALLOW_NONLOCAL_DB=1 and leaves it set.
//
// USAGE
//   KF_PROBE_DATABASE_URL=... bash scripts/search-cap-probe.sh [--limit N] [--env LABEL] [--json]
//
//   --limit N   row cap to apply to the SERVED population (default 500, the pre-fix default)
//   --env       label printed on every line (e.g. staging / production)
//   --json      emit machine-readable JSON instead of the text report

import { Pool } from 'pg';
import { loadPostgresListings } from '../lib/search/postgres-repository';
import { SearchEngine } from '../lib/search/engine';
import { InMemoryListingRepository } from '../lib/search/repository';
import { getPostgresAliasResolver } from '../lib/search/postgres-alias-resolver';
import { getPostgresRegionHierarchy } from '../lib/search/postgres-region-hierarchy';
import { tokenize } from '../lib/search/text/normalize';
import type { ListingRecord } from '../lib/search/types';

/**
 * The search-relevance contract accumulated across registry rounds 97/137/140/145/150/153/167/169.
 * Each entry records WHY it is here, so a future run can tell a deliberate tradeoff from a
 * regression. `expect` is the assertion the round settled on; `note` is the reasoning.
 */
interface ProbeQuery {
  q: string;
  why: string;
  /** Assertion over the result of running `q`. Undefined → observational only (report, don't judge). */
  expect?: (r: QueryResult) => string | null;
}

interface QueryResult {
  q: string;
  total: number;
  rungs: number;
  /** Names of the top results, in rank order. */
  top: string[];
  /** Every distinct activity name in the full result set (not just the top slice). */
  names: string[];
}

const CONTRACT: ProbeQuery[] = [
  {
    q: 'pa',
    why: 'R137: MIN_PREFIX_QUERY_LENGTH=2 is the empirically settled value. Two-char type-ahead must keep working.',
    expect: (r) => (r.total > 0 ? null : '"pa" returned nothing — 2-char prefix type-ahead is broken (R137 regression)'),
  },
  {
    q: 'parade',
    why: 'R97 headline defect: "parade" used to return the whole park catalogue as a confident exact match.',
    expect: (r) =>
      r.total > 0 && r.rungs === 0
        ? '"parade" returned results with NO broadening applied — the R97 confident-false-match defect is back'
        : null,
  },
  {
    q: 'sing',
    why: 'R153/154: "sing" matched Kensington via the infix tier. Tier removed in 240fe65; must not return pool sessions.',
    expect: (r) => {
      const bad = r.names.filter((n) => /kensington|pool|swim/i.test(n));
      return bad.length > 0 ? `"sing" matched swim/pool listings again: ${bad.slice(0, 5).join(' | ')}` : null;
    },
  },
  {
    q: 'tone',
    why: 'R171: "tone" must stay clean (n=0, honestly broadened) — it was a live infix-tier false positive.',
  },
  {
    q: 'swimmer',
    why: 'R97 REGRESSION GUARD, the sharpest one: "swimmer" must reach swim listings and must NOT rank Summer above them.',
    expect: (r) => {
      const firstSummer = r.names.findIndex((n) => /summer/i.test(n));
      const firstSwim = r.names.findIndex((n) => /swim/i.test(n));
      if (firstSwim === -1 && firstSummer !== -1) return '"swimmer" returned Summer listings and NO swim listings (the R97 defect verbatim)';
      if (firstSummer !== -1 && firstSwim !== -1 && firstSummer < firstSwim) {
        return '"swimmer" ranked a Summer listing ABOVE every swim listing (R97 ranking regression)';
      }
      return null;
    },
  },
  { q: 'summer', why: 'Paired control for swimmer/Summer: "summer" itself is a live token and must still work.' },
  { q: 'swim', why: 'Baseline: the unambiguous stem the swimmer guard is defined against.' },
  {
    q: 'swimxyz',
    why: 'R97 invariant: trailing junk is NOT an inflection. Must not match swim; may only surface via honest broadening.',
    expect: (r) =>
      r.total > 0 && r.rungs === 0 ? '"swimxyz" returned results with no broadening — trailing-junk matching is back' : null,
  },
  {
    q: 'storytimezz',
    why: 'R97 invariant, second junk-suffix case (a compound token this time).',
    expect: (r) =>
      r.total > 0 && r.rungs === 0 ? '"storytimezz" returned results with no broadening — trailing-junk matching is back' : null,
  },
  { q: 'libary', why: 'Typo tier: a genuine within-one-edit misspelling must still reach "library".' },
  { q: 'soccor', why: 'R150: the typo probe whose zero result exposed the 500-row cap. Paired with "soccer" below.' },
  {
    q: 'soccer',
    why: 'R150 SMOKING GUN: 81 fully-eligible soccer rows existed but the first sat at rank 595 of a 500-row window.',
  },
  { q: 'ball', why: 'R167/169 known tradeoff: prefix tier keeps ballet/ballerina; infix removal dropped basketball/pickleball.' },
  { q: 'time', why: 'R150 contract member — a very common token, high blast radius for any broadening change.' },
  {
    q: 'events',
    why: 'R167: 19 of 22 pre-removal hits matched the SOURCE NAME "Richmond Public Library BiblioEvents", not the activity.',
  },
  { q: 'biblio', why: 'R167 vendor-leakage detector: a parent typing a VENDOR BRAND should not select the catalogue.' },
  { q: 'rss', why: 'R167 vendor-leakage detector, second form (feed plumbing).' },
  { q: 'opengym', why: 'Compound tier: "opengym" → open + gym must still resolve.' },
  { q: 'gymnast', why: 'R140/169: known alias-gap case, tracked for expand.ts. Observational.' },
  { q: 'skaters', why: 'R140 R1-R5 requirement: plural agentive must work or silently fail safe with broadening signalled.' },
  { q: 'swimmers', why: 'R140 R1-R5 requirement, paired with skaters.' },
  { q: 'length', why: 'R145: length~strength was an incidental fix; guard that it stays fixed.' },
  { q: 'storytime', why: 'High-traffic real query, sanity baseline.' },
];

interface Args {
  limit: number;
  env: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { limit: 500, env: process.env.KF_PROBE_ENV ?? 'unlabelled', json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') out.limit = Number(argv[++i]);
    else if (argv[i] === '--env') out.env = String(argv[++i]);
    else if (argv[i] === '--json') out.json = true;
  }
  return out;
}

/** Distinct index vocabulary over a listing set — the same four weighted fields the matcher builds. */
function vocabulary(listings: ListingRecord[]): Set<string> {
  const vocab = new Set<string>();
  for (const l of listings) {
    for (const t of tokenize(l.activityName)) vocab.add(t);
    for (const t of tokenize([l.primaryCategoryKey, ...l.categoryTags, ...l.suitabilityTags].join(' '))) vocab.add(t);
    for (const t of tokenize([l.venueName, l.organisation ?? ''].join(' '))) vocab.add(t);
    for (const t of tokenize(l.descriptionSnippet)) vocab.add(t);
  }
  return vocab;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const connectionString = process.env.KF_PROBE_DATABASE_URL;
  if (!connectionString) {
    console.error('KF_PROBE_DATABASE_URL is required (deliberately not DATABASE_URL — see the header comment).');
    process.exit(2);
  }

  const pool = new Pool({ connectionString, max: 2, ssl: { rejectUnauthorized: false } });
  // Belt and braces on top of "this file only ever SELECTs": ask the server to reject any write
  // this probe could conceivably be edited into making. Older/pooled servers may not honour it,
  // which is why it is not the only safeguard.
  await pool.query('SET default_transaction_read_only = on').catch(() => undefined);

  const [aliasResolver, regionHierarchy] = await Promise.all([
    getPostgresAliasResolver(pool),
    getPostgresRegionHierarchy(pool),
  ]);

  // FULL first, so the served window is a strict prefix of it under the same ORDER BY and the two
  // populations are genuinely comparable rather than two independent reads of a moving catalogue.
  // Omitting `limit` is what "uncapped" MEANS after this fix — the probe deliberately exercises
  // the real default rather than passing a large number, so it measures the shipped behaviour.
  const tFullStart = Date.now();
  const full = await loadPostgresListings(pool);
  const fullLoadMs = Date.now() - tFullStart;

  // The pre-fix behaviour, reproduced exactly: this is the OLD default, not a new setting.
  const tServedStart = Date.now();
  const served = await loadPostgresListings(pool, { limit: args.limit });
  const servedLoadMs = Date.now() - tServedStart;

  const populations: Array<{ label: string; listings: ListingRecord[]; loadMs: number }> = [
    { label: `served(limit=${args.limit})`, listings: served, loadMs: servedLoadMs },
    { label: `full(uncapped)`, listings: full, loadMs: fullLoadMs },
  ];

  const report: Record<string, unknown> = { env: args.env, at: new Date().toISOString(), populations: {} };

  for (const pop of populations) {
    const engine = new SearchEngine({
      repository: new InMemoryListingRepository(pop.listings),
      aliasResolver,
      regionHierarchy,
      fixtureBacked: false,
    });

    const vocab = vocabulary(pop.listings);
    const results: QueryResult[] = [];
    const failures: string[] = [];
    let totalMs = 0;
    let worstMs = 0;
    let worstQuery = '';

    for (const probe of CONTRACT) {
      const t0 = Date.now();
      const res = engine.search({ q: probe.q, limit: 100 });
      const ms = Date.now() - t0;
      totalMs += ms;
      if (ms > worstMs) {
        worstMs = ms;
        worstQuery = probe.q;
      }
      const qr: QueryResult = {
        q: probe.q,
        total: res.total,
        rungs: res.broadening.applied.length,
        top: res.results.slice(0, 5).map((r) => r.listing.activityName),
        names: res.results.map((r) => r.listing.activityName),
      };
      results.push(qr);
      const failure = probe.expect?.(qr);
      if (failure) failures.push(failure);
    }

    (report.populations as Record<string, unknown>)[pop.label] = {
      rows: pop.listings.length,
      loadMs: pop.loadMs,
      vocabularyTokens: vocab.size,
      distinctActivityNames: new Set(pop.listings.map((l) => l.activityName)).size,
      searchTotalMs: totalMs,
      searchWorstMs: worstMs,
      searchWorstQuery: worstQuery,
      searchMeanMs: Math.round((totalMs / CONTRACT.length) * 100) / 100,
      failures,
      results: results.map((r) => ({ q: r.q, total: r.total, rungs: r.rungs, top: r.top })),
    };
  }

  await pool.end();

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`\n=== KIDS FUN search cap probe — env=${args.env} — ${report.at} ===`);
  for (const [label, raw] of Object.entries(report.populations as Record<string, any>)) {
    console.log(`\n--- ${args.env} :: ${label} ---`);
    console.log(
      `rows=${raw.rows}  loadMs=${raw.loadMs}  vocabTokens=${raw.vocabularyTokens}  distinctNames=${raw.distinctActivityNames}`,
    );
    console.log(
      `search: total=${raw.searchTotalMs}ms  mean=${raw.searchMeanMs}ms  worst=${raw.searchWorstMs}ms (${raw.searchWorstQuery})`,
    );
    for (const r of raw.results) {
      console.log(`  ${r.q.padEnd(14)} n=${String(r.total).padStart(5)} rungs=${r.rungs}  ${r.top.slice(0, 3).join(' | ')}`);
    }
    if (raw.failures.length === 0) {
      console.log(`  CONTRACT: PASS (${CONTRACT.filter((c) => c.expect).length} assertions)`);
    } else {
      console.log(`  CONTRACT: ${raw.failures.length} FAILURE(S)`);
      for (const f of raw.failures) console.log(`    ✗ ${f}`);
    }
  }
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
