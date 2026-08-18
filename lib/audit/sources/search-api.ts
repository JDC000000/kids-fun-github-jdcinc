// lib/audit/sources/search-api.ts — read the WHOLE live catalogue through the public search
// API, with no database connection and no credential.
//
// WHY THE API AND NOT THE DATABASE
// Every other lib/llm use case detects its worklist with SQL. This one deliberately does not,
// for two reasons that both point the same way:
//   1. The auditor is a READ-ONLY cross-check. Giving a weekly cron job a database role only so
//      it can SELECT what /api/search already returns adds a credential, a network path and a
//      blast radius for zero extra signal.
//   2. Auditing the API is auditing what a PARENT ACTUALLY SEES. A DB query would check the
//      rows; this checks the rendered claim — `suitabilityTags` is computed in
//      lib/search/postgres-repository.ts on the way out, so "Rainy-day friendly" only exists on
//      this side of the boundary. Pattern 1 is a bug in the projection, and the projection is
//      what this reads.
// The cost is coverage of `description_snippet` — see the note on that field below.
//
// ── PAGINATION: THE API HAS NO OFFSET ─────────────────────────────────────────────────────
// GET /api/search clamps `limit` to 100 and exposes no cursor, so "give me all 4,874" is not a
// request that can be made. What it does expose is `total` — the pre-limit match count — and a
// set of orthogonal filters. So the sweep is an ADAPTIVE PARTITION: ask a cell for its total;
// if it fits in one page, take it; if not, split the cell along the next filter dimension and
// recurse. A cell is only ever split when it has to be, so the request count tracks the shape
// of the data rather than the size of the dimension product.
//
// Dimension order is chosen by splitting power, not by convenience:
//   1. region       — 5 disjoint municipalities, the cheapest first cut.
//   2. date bisect  — the only high-cardinality axis, and it HALVES, so it is the workhorse.
//   3. time of day  — 3 buckets, overlapping but covering.
//   4. age band     — 5 bands; covering because the filter's "empty → don't hide" rule means a
//                     band-less listing matches every one of them.
//
// ── THE TWO HONEST CAVEATS, BOTH MEASURED RATHER THAN ASSUMED ─────────────────────────────
// • Applying a date range excludes listings with no start date (open-hours venues). Those rows
//   are reachable only in cells that never needed a date split. The sweep therefore reports
//   `coverage`: unique ids collected against the unfiltered `total`. It is a measurement, not a
//   claim — read it before reading any finding count.
// • If a cell cannot be split further and still exceeds 100, the extra rows are dropped. That
//   is recorded in `truncatedCells` and printed. A silent cap would make a partial sweep read
//   as a complete one, which is the failure mode that makes an auditor untrustworthy.
import type { AuditListing } from '../types';
import { suitabilityTagsForMode, type TagMode } from '../tags';

/** The five seeded municipality ids the `region` chip param accepts. */
export const REGION_IDS = [
  '10000000-0000-0000-0000-000000000010', // Vancouver
  '10000000-0000-0000-0000-000000000011', // North Vancouver
  '10000000-0000-0000-0000-000000000012', // West Vancouver
  '10000000-0000-0000-0000-000000000013', // Burnaby
  '10000000-0000-0000-0000-000000000014', // Richmond
];

const TIME_KEYS = ['morning', 'afternoon', 'evening'];
const AGE_KEYS = ['under2', '2-4', '5-9', '10-14', '15+'];

/** A generous outer window for date bisection; narrowed by the first split. */
const DATE_FLOOR = '2020-01-01';
const DATE_CEIL = '2030-12-31';

const PAGE_LIMIT = 100;

/**
 * Alternate result orderings used to harvest a cell that cannot be partitioned further. Each
 * one surfaces a different top-100 of the same cell.
 */
const ALT_SORTS = ['soonest', 'newest', 'lowest_cost'];

/** Raw shape of one `listing` in the /api/search response. Only what the auditor reads. */
interface ApiListing {
  id: string;
  seriesId: string | null;
  activityName: string;
  primaryCategoryKey: string;
  categoryTags: string[];
  suitabilityTags: string[];
  venueName: string | null;
  organisation: string | null;
  descriptionSnippet: string | null;
  openHoursLabel: string | null;
  ageBandMatches: string[];
  ageMinMonths: number | null;
  ageMaxMonths: number | null;
  ageNotes: string | null;
  sourceUrl: string | null;
}

interface ApiResponse {
  total: number;
  results: Array<{ listing: ApiListing }>;
}

type Filters = Record<string, string>;

export interface SweepOptions {
  baseUrl: string;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Which suitability derivation the returned listings carry. See lib/audit/tags.ts. */
  mode: TagMode;
  /** Hard ceiling on HTTP requests — a runaway backstop, not a tuning knob. */
  maxRequests?: number;
  /** Politeness delay between requests, ms. This hits production. */
  delayMs?: number;
  onProgress?: (message: string) => void;
}

export interface SweepResult {
  listings: AuditListing[];
  /** `total` from the unfiltered probe — the catalogue size the sweep is measured against. */
  catalogueTotal: number;
  requests: number;
  /** Cells that hit the page limit with no dimension left to split. */
  truncatedCells: Array<{ filters: Filters; total: number }>;
  /** unique ids collected / catalogueTotal, as a fraction. */
  coverage: number;
}

/**
 * Strip the deterministic parser's `unresolved: ` tag to recover the raw source wording — the
 * same recovery lib/llm/age-fallback.ts does, for the same reason: what follows the prefix is
 * the source's own text, and it is the richest evidence the API exposes.
 */
export function rawAgeWording(ageNotes: string | null): string {
  const t = (ageNotes ?? '').trim();
  if (!t) return '';
  return t.toLowerCase().startsWith('unresolved:') ? t.slice('unresolved:'.length).trim() : t;
}

export function toAuditListing(row: ApiListing, mode: TagMode): AuditListing {
  return {
    id: row.id,
    seriesId: row.seriesId,
    organisation: row.organisation ?? '',
    sourceUrl: row.sourceUrl,
    source: {
      title: row.activityName ?? '',
      // EMPTY ACROSS THE WHOLE LIVE CATALOGUE TODAY. Not an API limitation: nothing in worker/
      // writes activity_occurrence.description_snippet, so the column is null and the
      // repository maps null → ''. Measured at 0/311 non-empty across four sampled partitions.
      // The rules read it anyway, so the auditor gets stronger for free once ingestion starts
      // persisting body text; until then title + audience tags carry the evidence.
      description: row.descriptionSnippet ?? '',
      ageWording: rawAgeWording(row.ageNotes),
      venueName: row.venueName ?? '',
      openHoursLabel: row.openHoursLabel ?? '',
    },
    derived: {
      suitabilityTags:
        mode === 'as_served'
          ? row.suitabilityTags
          : suitabilityTagsForMode(row.categoryTags, row.primaryCategoryKey, mode),
      categoryTags: row.categoryTags,
      primaryCategoryKey: row.primaryCategoryKey,
      ageBandMatches: row.ageBandMatches,
      ageMinMonths: row.ageMinMonths,
      ageMaxMonths: row.ageMaxMonths,
    },
  };
}

function buildUrl(baseUrl: string, filters: Filters, limit: number): string {
  const url = new URL('/api/search', baseUrl);
  // includeRegistration=1 is REQUIRED for an audit: the default result set excludes
  // registration-required courses and camps entirely (4,156 of 4,874 rows), and a mislabelled
  // camp is exactly as harmful as a mislabelled drop-in.
  url.searchParams.set('includeRegistration', '1');
  // minResults=0 OPTS OUT OF THE BROADENING LADDER, and it is not optional for an audit.
  // lib/search/engine.ts defaults `minResults` to 3 and, when a query returns fewer than that,
  // starts DROPPING the caller's own filters and re-running until it can fill the page. For a
  // visitor that is a feature; for a partitioned sweep it is silent data corruption — a cell
  // that genuinely holds two listings comes back with a few hundred belonging to its parent,
  // the `total` says the cell is over the page limit, and the pager splits a cell that was
  // never full. Measured before this was set: single past days reporting 262 rows, and 30
  // "unsplittable" cells that did not exist. `minResults=0` is the engine's own documented
  // opt-out (engine.ts:248) — the same one lib/email/digest.ts uses.
  url.searchParams.set('minResults', '0');
  url.searchParams.set('limit', String(limit));
  for (const [k, v] of Object.entries(filters)) url.searchParams.set(k, v);
  return url.toString();
}

/**
 * The last day of the LOWER half of [from, to], or null when the window is a single day.
 *
 * Rounds DOWN in whole days, so a two-day window [A, A+1] yields A — giving children [A, A]
 * and [A+1, A+1]. An earlier version rejected that midpoint for "equalling an endpoint" and so
 * refused to split any two-day window; against the live catalogue that left 198 cells over the
 * page limit and cost roughly a third of the sweep. A midpoint can never equal `to` (the
 * half-window is strictly shorter than the window), so only the `to <= from` case is unsplittable.
 */
function midpoint(fromIso: string, toIso: string): string | null {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  const days = Math.round((to - from) / 86_400_000);
  const mid = from + Math.floor(days / 2) * 86_400_000;
  return new Date(mid).toISOString().slice(0, 10);
}

function nextDay(iso: string): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/**
 * The ordered split dimensions. Each returns the child filter sets, or [] when it cannot split
 * the given cell (already applied, or a one-day date window).
 */
const DIMENSIONS: Array<{ name: string; repeatable?: boolean; expand(f: Filters): Filters[] }> = [
  {
    name: 'region',
    expand: (f) => (f.region ? [] : REGION_IDS.map((id) => ({ ...f, region: id }))),
  },
  {
    name: 'date',
    // REPEATABLE, and this is load-bearing. Every other dimension is a fixed value set that is
    // spent once it appears in the filters; a date window can be halved again and again until
    // it is one day wide. An earlier version advanced past this dimension after the first
    // split, which capped the sweep at a single bisection and silently truncated 3,000 rows —
    // the failure the `truncatedCells` counter exists to make visible.
    repeatable: true,
    expand: (f) => {
      const from = f.from ?? DATE_FLOOR;
      const to = f.to ?? DATE_CEIL;
      const mid = midpoint(from, to);
      if (!mid) return [];
      return [
        { ...f, from, to: mid },
        { ...f, from: nextDay(mid), to },
      ];
    },
  },
  { name: 'time', expand: (f) => (f.time ? [] : TIME_KEYS.map((t) => ({ ...f, time: t }))) },
  { name: 'age', expand: (f) => (f.age ? [] : AGE_KEYS.map((a) => ({ ...f, age: a }))) },
];

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * Sweep the whole catalogue. Sequential and polite by default — this points at production, and
 * a fast auditor that degrades the site it audits is a bad trade.
 */
export async function sweepCatalogue(opts: SweepOptions): Promise<SweepResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxRequests = opts.maxRequests ?? 1500;
  const delayMs = opts.delayMs ?? 0;
  const progress = opts.onProgress ?? (() => undefined);

  const byId = new Map<string, AuditListing>();
  const truncatedCells: SweepResult['truncatedCells'] = [];
  let requests = 0;

  async function query(filters: Filters): Promise<ApiResponse> {
    if (requests >= maxRequests) {
      throw new Error(`sweepCatalogue: request cap ${maxRequests} reached — refusing to continue`);
    }
    requests += 1;
    if (requests > 1) await sleep(delayMs);
    const res = await fetchImpl(buildUrl(opts.baseUrl, filters, PAGE_LIMIT));
    if (!res.ok) throw new Error(`search API ${res.status} for ${JSON.stringify(filters)}`);
    return (await res.json()) as ApiResponse;
  }

  function absorb(body: ApiResponse): void {
    for (const r of body.results) {
      const listing = toAuditListing(r.listing, opts.mode);
      // Cells overlap (time buckets, age bands), so the same listing arrives more than once.
      // Keyed by id, first write wins — the mapping is deterministic, so later writes are equal.
      if (!byId.has(listing.id)) byId.set(listing.id, listing);
    }
  }

  /** Split an over-full cell along the first dimension that can still divide it. */
  async function split(filters: Filters, dimIndex: number, total: number): Promise<void> {
    for (let i = dimIndex; i < DIMENSIONS.length; i++) {
      const dim = DIMENSIONS[i];
      const children = dim.expand(filters);
      if (children.length === 0) continue;
      // A repeatable dimension keeps its own index so it can be applied again to the child;
      // it terminates on its own (a one-day window returns no children).
      const nextIndex = dim.repeatable ? i : i + 1;
      for (const child of children) await collect(child, nextIndex);
      return;
    }
    // No partition dimension left and the cell is still over a page. Last resort: re-ask the
    // same cell under each alternate sort. This is NOT a partition — it cannot be proved to
    // return everything — but the orderings are genuinely different (soonest by start time,
    // newest by ingest time, lowest_cost by price), so their union recovers most of a cell that
    // is only modestly over the limit. The cell is recorded either way; `coverage` in the
    // result is the number that actually tells the truth about what the sweep saw.
    for (const sort of ALT_SORTS) {
      const body = await query({ ...filters, sort });
      absorb(body);
    }
    truncatedCells.push({ filters, total });
    progress(`UNSPLITTABLE cell ${JSON.stringify(filters)} — ${total} rows; harvested via ${ALT_SORTS.length} alternate sorts`);
  }

  async function collect(filters: Filters, dimIndex: number): Promise<void> {
    const body = await query(filters);
    absorb(body);
    if (body.total <= PAGE_LIMIT) return;
    await split(filters, dimIndex, body.total);
  }

  const root = await query({});
  absorb(root);
  const catalogueTotal = root.total;
  progress(`catalogue total = ${catalogueTotal}`);

  if (catalogueTotal > PAGE_LIMIT) await split({}, 0, catalogueTotal);

  const listings = [...byId.values()];
  progress(`collected ${listings.length}/${catalogueTotal} unique listings in ${requests} requests`);

  return {
    listings,
    catalogueTotal,
    requests,
    truncatedCells,
    coverage: catalogueTotal > 0 ? listings.length / catalogueTotal : 1,
  };
}
