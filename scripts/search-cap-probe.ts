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
//     server supports it — on a single connection, so the guard covers every statement issued.
//     Safe to point at staging or production.
//   · TLS is whatever the connection string asks for, never silently weakened. The one bypass is
//     opt-in, genuinely takes effect (see `buildPoolConfig`), and prints the ssl options actually
//     handed to the pool so the warning cannot claim more than it did.
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
//
//   KF_PROBE_ENV                    default for --env
//   KF_PROBE_ALLOW_SELF_SIGNED_TLS  set to 1 ONLY for a self-signed staging cert; disables
//                                   certificate verification for this run and prints the ssl
//                                   options the pool was actually given

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolConfig } from 'pg';
// The parser node-postgres itself applies to `connectionString`. Not a new dependency: pg depends
// on it, and pg's own ConnectionParameters is built from exactly this function's output.
import { parse } from 'pg-connection-string';
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

/** Abort with a usage error rather than probing on with a misread argument. */
function usageError(message: string): never {
  console.error(`${message}\n\nUsage: KF_PROBE_DATABASE_URL=... bash scripts/search-cap-probe.sh [--limit N] [--env LABEL] [--json]`);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const out: Args = { limit: 500, env: process.env.KF_PROBE_ENV ?? 'unlabelled', json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') {
      // Validated, not coerced. `--limit` as the final token gave `Number(undefined)` = NaN, which
      // `normalizeLimit` then dropped — so NO limit was sent and the "served" population came back
      // byte-identical to "full" while the report still claimed two populations. That is precisely
      // the served-vs-full confusion this probe exists to detect, produced by the probe itself.
      const raw = argv[++i];
      const value = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isInteger(value) || value < 1) {
        usageError(`--limit requires a positive integer (got ${raw === undefined ? '<missing>' : JSON.stringify(raw)}).`);
      }
      out.limit = value;
    } else if (argv[i] === '--env') {
      const raw = argv[++i];
      if (raw === undefined) usageError('--env requires a label.');
      out.env = raw;
    } else if (argv[i] === '--json') {
      out.json = true;
    } else {
      usageError(`Unknown argument ${JSON.stringify(argv[i])}.`);
    }
  }
  return out;
}

/** True when the operator has opted out of certificate verification for this run. */
function selfSignedTlsAllowed(): boolean {
  return process.env.KF_PROBE_ALLOW_SELF_SIGNED_TLS === '1';
}

/**
 * The pool config, built from the PARSED connection string rather than handing pg the raw string.
 *
 * WHY, AND IT IS NOT A STYLE CHOICE
 * `new Pool({ connectionString, ssl })` does not mean "this string, with this TLS". pg does
 * `config = Object.assign({}, config, parse(config.connectionString))`
 * (pg/lib/connection-parameters.js), so the parsed string OVERWRITES a sibling `ssl` key. Any URL
 * carrying `sslmode=` therefore discarded whatever this file decided — including the escape hatch:
 * `KF_PROBE_ALLOW_SELF_SIGNED_TLS=1` against an `?sslmode=require` URL had NO effect while the run
 * still printed a warning announcing that verification was disabled. A tool that misreports its own
 * security posture is worse than one with no bypass at all. Parsing first and spreading puts this
 * file's `ssl` last, where it actually wins.
 *
 * Default: exactly what the connection string asks for. No `sslmode` → no TLS, which is what a
 * local probe needs; `sslmode=require`/`verify-*` → pg's own handling (8.22.0 treats `require` as
 * an alias for `verify-full`). There is deliberately no sslmode→`rejectUnauthorized` mapping here:
 * the previous one was premised on a claim about pg that is not true of the installed version, and
 * silently re-interpreting a documented libpq mode is not this script's job.
 *
 * `max: 1` is load-bearing, not a throughput choice. `SET default_transaction_read_only` without
 * LOCAL is per-CONNECTION, and a second pooled connection would never receive the SET while still
 * serving the heavy catalogue loads — i.e. the guard would cover the connection that did nothing
 * and miss the ones that did the work. One connection means the SET provably covers every
 * statement the probe issues. This is a diagnostic script; the serialisation costs nothing.
 */
export function buildPoolConfig(connectionString: string): PoolConfig {
  // pg-connection-string types `port` as `string | null`; pg normalises precisely this object, so
  // the cast describes a shape pg already accepts rather than papering over a mismatch.
  const parsed = parse(connectionString) as unknown as PoolConfig;
  const config: PoolConfig = { ...parsed, max: 1 };
  if (!selfSignedTlsAllowed()) return config;

  // Turn verification off WITHOUT discarding the rest of the TLS material the string supplied —
  // sslrootcert/sslcert/sslkey all parse into this same object.
  const parsedSsl = typeof config.ssl === 'object' && config.ssl !== null ? config.ssl : {};
  return { ...config, ssl: { ...parsedSsl, rejectUnauthorized: false } };
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

  const poolConfig = buildPoolConfig(connectionString);
  if (selfSignedTlsAllowed()) {
    // Printed FROM the config the pool is built with, not from the intent behind it. The warning
    // can no longer outrun the code: if the bypass ever stopped applying, this line would say so.
    console.error(
      '[probe] WARNING: KF_PROBE_ALLOW_SELF_SIGNED_TLS=1 — TLS certificate verification is DISABLED for this run. ' +
        `Effective ssl options: ${JSON.stringify(poolConfig.ssl)}`,
    );
  }
  const pool = new Pool(poolConfig);
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

// Probe only when this file IS the entrypoint (search-cap-probe.sh bundles it and runs the
// bundle). Importing it — tests/search/search-cap-probe-tls.test.ts drives `buildPoolConfig`
// directly — must not open a connection.
//
// Compare REAL paths, never the path strings as handed to us. `import.meta.url` is resolved
// through symlinks by the loader; `process.argv[1]` is the path exactly as typed, and the wrapper
// derives it from bash's `pwd`, which is LOGICAL, not physical. So any checkout reached through a
// symlink used to miss this guard and the probe did nothing at all while exiting 0 — the worst
// failure mode a diagnostic has, and the same class of defect (a probe misreporting its own
// behaviour) that this guard was added to fix in the first place. Hence the `else` as well:
// declining to run is now audible on stderr instead of looking like a clean, empty success.
// The argument is a THUNK so that deriving the path is inside the guard too, not just resolving
// it. `fileURLToPath` throws on any non-`file:` URL, and `import.meta.url` is only a `file:` URL
// when the module was loaded from disk — under a `data:`/`http:` loader, a bundler that inlines
// it, or a worker built from source, it is not. Evaluating it outside this try would throw at
// MODULE LOAD and take down every importer, which is strictly worse than the silent decline this
// guard exists to replace. Latent in this repo today; cheap to make impossible.
function toRealPath(derive: () => string): string | null {
  try {
    return realpathSync(derive());
  } catch {
    return null; // deleted, unreadable, or not a path at all — treat as "not us"
  }
}

const invoked = process.argv[1];
const modulePath = toRealPath(() => fileURLToPath(import.meta.url));
const invokedPath = invoked ? toRealPath(() => invoked) : null;

if (modulePath !== null && modulePath === invokedPath) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  console.error(
    `search-cap-probe: loaded, but not as the process entrypoint — main() did NOT run ` +
      // Fall back to the RAW url, never to fileURLToPath again — the whole reason modulePath can
      // be null is that converting it threw, so re-running it here would throw in the diagnostic.
      `(module=${modulePath ?? import.meta.url}, argv[1]=${invokedPath ?? invoked ?? '<none>'}). ` +
      `Expected when something imports buildPoolConfig; if you meant to probe, run: bash scripts/search-cap-probe.sh`,
  );
}
