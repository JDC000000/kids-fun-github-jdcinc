// lib/search/engine.ts — Search orchestration (TSD §5A worked example).
//
// Composes the full pipeline: parse → alias-expand → match → filters (region, radius,
// age, time, date, cost, status) → rank → sort, with the empty-state broadening ladder
// and constraint explanation. Data flows through interfaces (repository, alias resolver,
// region hierarchy, rank config, geocoder), so swapping fixtures for live Postgres is a
// dependency change, not an engine rewrite.

import type { ListingRecord, SearchContext, SortKey } from './types';
import type { ListingRepository } from './repository';
import type { AliasResolver } from './expand';
import type { CandidateMatcher, MatchCandidate } from './match';
import type { RankConfigProvider } from './rank-config';
import type { RankContext, ScoredListing } from './rank';
import { RegionHierarchy, matchesRegion } from '../geo/region';
import { withinRadius } from '../geo/radius';
import { resolveOrigin, OriginResolutionError } from '../geo/origin';
import type { Geocoder, OriginRequest, ResolvedOrigin } from '../geo/origin';
import { WeightedTrigramMatcher } from './match';
import { StaticRankConfig } from './rank-config';
import { FixtureAliasResolver } from './expand';
import { parseQuery } from './parse';
import { matchesAge } from './filters/age';
import { matchesTimeOfDay, matchesDate } from './filters/time';
import { matchesCost } from './filters/cost';
import { matchesStatus, isPrimaryResult, isExpectedSection, isHidden } from './filters/status';
import { rankCandidates } from './rank';
import { applySort } from './sort';
import {
  buildBroadeningLadder,
  explainEmptyState,
  type BroadenRung,
  type ConstraintExplanation,
} from './broaden';

export interface SearchEngineDeps {
  repository: ListingRepository;
  aliasResolver?: AliasResolver;
  regionHierarchy: RegionHierarchy;
  rankConfig?: RankConfigProvider;
  matcher?: CandidateMatcher;
  geocoder?: Geocoder;
  fixtureBacked?: boolean;
}

export interface SearchRequest {
  q: string;
  now?: Date;
  /** Origin resolution request (near_me / saved_home / area_chip). Null → no geo/radius filter. */
  origin?: OriginRequest | null;
  signedIn?: boolean;
  regionChipIds?: string[];
  sort?: SortKey;
  includeUnknownCost?: boolean;
  /**
   * Explicit custom date RANGE from the UI (T26 / FR-04), YYYY-MM-DD America/Vancouver
   * local dates. A structured param (like region / lat-lng), NOT text composed into `q`:
   * the query parser can't reliably read an ISO date because normalize() strips its
   * hyphens, so a range is passed structurally and OVERRIDES any text-parsed single date.
   */
  dateRange?: { from: string; to: string } | null;
  /** Broaden when the primary result count is below this (default 3). */
  minResults?: number;
  limit?: number;
}

export interface SearchResultItem {
  listing: ListingRecord;
  score: number;
  distanceKm: number | null;
  components: ScoredListing['components'];
  matchedAliases: string[];
}

export interface SearchResponse {
  context: SearchContext;
  origin: ResolvedOrigin | null;
  originError: string | null;
  results: SearchResultItem[];
  /** Separate "expected / seasonal / evergreen" section (§5A.5). */
  expected: SearchResultItem[];
  total: number;
  broadening: { applied: BroadenRung[]; emptyState: ConstraintExplanation | null };
  meta: { fixtureBacked: boolean; sort: SortKey; backend?: 'fixture' | 'database'; fallbackReason?: string };
}

export class SearchEngine {
  private readonly repo: ListingRepository;
  private readonly aliases: AliasResolver;
  private readonly regions: RegionHierarchy;
  private readonly rankConfig: RankConfigProvider;
  private readonly matcher: CandidateMatcher;
  private readonly geocoder?: Geocoder;
  private readonly fixtureBacked: boolean;

  constructor(deps: SearchEngineDeps) {
    this.repo = deps.repository;
    this.aliases = deps.aliasResolver ?? new FixtureAliasResolver();
    this.regions = deps.regionHierarchy;
    this.rankConfig = deps.rankConfig ?? new StaticRankConfig();
    this.matcher = deps.matcher ?? new WeightedTrigramMatcher();
    this.geocoder = deps.geocoder;
    this.fixtureBacked = deps.fixtureBacked ?? true;
  }

  search(req: SearchRequest): SearchResponse {
    const now = req.now ?? new Date();
    const minResults = req.minResults ?? 3;
    const ctx0 = parseQuery(req.q, {
      now,
      sort: req.sort,
      includeUnknownCost: req.includeUnknownCost,
    });

    // Structured custom date range (T26 / FR-04): an explicit start+end from the UI is
    // the source of truth for date intent and overrides anything the text parser resolved
    // (e.g. a stray "today" phrase). Ordered defensively so isoDate<=endIsoDate always
    // holds; an invalid/partial range is ignored (no date constraint).
    const range = normalizeDateRange(req.dateRange);
    if (range) {
      ctx0.date = { kind: 'range', isoDate: range.from, endIsoDate: range.to, weekday: null };
    }

    // Resolve origin (geo filter/ranking only applies when we have one).
    let origin: ResolvedOrigin | null = null;
    let originError: string | null = null;
    if (req.origin) {
      try {
        origin = resolveOrigin(req.origin, {
          hierarchy: this.regions,
          geocoder: this.geocoder ?? nullGeocoder,
          signedIn: req.signedIn ?? false,
        });
      } catch (err) {
        originError = err instanceof OriginResolutionError ? `${err.code}: ${err.message}` : String(err);
      }
    }

    const regionChips = req.regionChipIds ?? [];
    const primaryOf = (ctx: SearchContext) => this.runPrimary(ctx, origin, regionChips, now);

    // Primary run.
    let working = ctx0;
    let scored = primaryOf(ctx0);
    const applied: BroadenRung[] = [];
    let emptyState: ConstraintExplanation | null = null;

    // Broaden if too few results (deterministic ladder).
    if (scored.length < minResults) {
      emptyState = explainEmptyState(ctx0, (v) => primaryOf(v).length);
      for (const rung of buildBroadeningLadder(ctx0)) {
        applied.push(rung);
        working = rung.context;
        scored = primaryOf(rung.context);
        if (scored.length >= minResults) break;
      }
    }

    // Expected/seasonal section — populated once the ladder reached it, or when still short.
    const expected =
      working.includeExpected || scored.length < minResults
        ? this.runExpected({ ...working, includeExpected: true }, origin, regionChips, now)
        : [];

    const applyLimit = <T,>(arr: T[]): T[] => (req.limit != null ? arr.slice(0, req.limit) : arr);
    return {
      context: working,
      origin,
      originError,
      results: applyLimit(scored).map(toItem),
      expected: applyLimit(expected).map(toItem),
      total: scored.length,
      broadening: { applied, emptyState },
      meta: { fixtureBacked: this.fixtureBacked, sort: working.sort },
    };
  }

  /** parse-expanded context → matched, filtered, ranked, sorted PRIMARY listings. */
  private runPrimary(ctx: SearchContext, origin: ResolvedOrigin | null, chips: string[], now: Date): ScoredListing[] {
    const candidates = this.matchAndFilter(ctx, origin, chips, 'primary');
    const scored = rankCandidates(candidates, this.rankContext(ctx, origin, now));
    return applySort(scored, ctx.sort);
  }

  /** Expected/seasonal/evergreen suggestions: relaxed status class, loose filters. */
  private runExpected(ctx: SearchContext, origin: ResolvedOrigin | null, chips: string[], now: Date): ScoredListing[] {
    const candidates = this.matchAndFilter(ctx, origin, chips, 'expected');
    return rankCandidates(candidates, this.rankContext(ctx, origin, now));
  }

  private matchAndFilter(
    ctx: SearchContext,
    origin: ResolvedOrigin | null,
    chips: string[],
    mode: 'primary' | 'expected',
  ): MatchCandidate[] {
    const expanded = this.aliases.expand(ctx.terms);
    const listings = this.repo.all();
    const candidates = this.matcher.match(expanded, listings);
    const matchedAliases = expanded.matchedAliases;

    return candidates
      .filter((c) => this.passesFilters(c.listing, ctx, origin, chips, mode))
      // stash matched aliases for explainability without widening the candidate type
      .map((c) => Object.assign(c, { _matchedAliases: matchedAliases }));
  }

  private passesFilters(
    listing: ListingRecord,
    ctx: SearchContext,
    origin: ResolvedOrigin | null,
    chips: string[],
    mode: 'primary' | 'expected',
  ): boolean {
    if (isHidden(listing)) return false;
    if (mode === 'primary' && !isPrimaryResult(listing)) return false;
    if (mode === 'expected' && !isExpectedSection(listing)) return false;

    // Region chips (additive, hierarchical). Independent of radius.
    if (!matchesRegion([listing.municipalityId, listing.displayArea, listing.neighbourhood], this.regions, chips)) {
      return false;
    }
    // Radius (only when we have an origin).
    if (origin && !withinRadius(origin.geo, listing.geo, ctx.radiusKm)) return false;
    // Age (orthogonal).
    if (!matchesAge(listing, ctx.ageBands)) return false;

    if (mode === 'primary') {
      // Strict temporal + cost + status chips for the primary list.
      if (!matchesDate(listing, ctx.date)) return false;
      if (!matchesTimeOfDay(listing, ctx.timeOfDay)) return false;
      if (!matchesCost(listing, { free: ctx.costFree, includeUnknown: ctx.includeUnknownCost, maxCad: ctx.costMaxCad })) return false;
      if (!matchesStatus(listing, { bookableNow: ctx.bookableNow, rainyDay: ctx.rainyDay, dropIn: ctx.dropIn })) return false;
    }
    return true;
  }

  private rankContext(ctx: SearchContext, origin: ResolvedOrigin | null, now: Date): RankContext {
    return {
      origin: origin?.geo ?? null,
      radiusKm: ctx.radiusKm,
      ageBands: ctx.ageBands,
      date: ctx.date,
      rainyDay: ctx.rainyDay,
      now,
      weights: this.rankConfig.getWeights(),
    };
  }
}

const nullGeocoder: Geocoder = { geocodePostal: () => null };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate + canonicalise a custom date range (T26 / FR-04). Both ends must be well-formed
 * YYYY-MM-DD; a reversed range is swapped so the result always satisfies from<=to. Anything
 * malformed or partial returns null → the engine applies no range constraint.
 */
function normalizeDateRange(range?: { from: string; to: string } | null): { from: string; to: string } | null {
  if (!range) return null;
  const { from, to } = range;
  if (!ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to)) return null;
  return from <= to ? { from, to } : { from: to, to: from };
}

function toItem(s: ScoredListing): SearchResultItem {
  const matchedAliases = (s.candidate as MatchCandidate & { _matchedAliases?: string[] })._matchedAliases ?? [];
  return {
    listing: s.candidate.listing,
    score: s.score,
    distanceKm: s.distanceKm,
    components: s.components,
    matchedAliases,
  };
}
