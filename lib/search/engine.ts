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
import { RegionHierarchy } from '../geo/region';
import { resolveOrigin, OriginResolutionError } from '../geo/origin';
import type { Geocoder, OriginRequest, ResolvedOrigin } from '../geo/origin';
import { WeightedTrigramMatcher } from './match';
import { StaticRankConfig } from './rank-config';
import { FixtureAliasResolver } from './expand';
import { parseQuery } from './parse';
import { passesAllFilters, type ResultMode } from './filters/predicate';
// Filtering lives in predicate.ts (shared with the facet counter); this is the CARD LABEL —
// a result that came back because the caller opted in has to say why it is there.
import { isRegistrationShaped } from './filters/registration';
import { computeFacetCounts, type FacetCounts } from './facets';
import { rankCandidates } from './rank';
import { applySort } from './sort';
import { collapseSameDaySeries, slotSpanEnd, type CollapsedListing, type OccurrenceSlot } from './collapse';
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
  /**
   * Opt into registration-required courses/camps/lessons. Off by default — the default result set
   * answers "what can we do today" and excludes registered programmes entirely; a parent turns
   * this on to see them, and every listing it adds is labelled as registration content.
   */
  includeRegistration?: boolean;
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
  /**
   * Also return per-filter-value result counts for the filter UI (lib/search/facets.ts).
   * Opt-in: it costs a handful of extra in-memory filter passes over the candidate set this
   * search already built (no query, no second matcher run), but every caller that doesn't
   * render filters shouldn't pay for it or carry the payload.
   */
  facets?: boolean;
}

export interface SearchResultItem {
  listing: ListingRecord;
  score: number;
  distanceKm: number | null;
  components: ScoredListing['components'];
  matchedAliases: string[];
  /**
   * Every same-series-same-day occurrence this one result now stands for, ascending by start
   * (see lib/search/collapse.ts). Always at least the listing itself, so consumers can read
   * `slots.length` uniformly rather than special-casing the uncollapsed card.
   */
  slots: OccurrenceSlot[];
  /** End of the LAST slot — the closing edge of a collapsed card's "3:15 PM–7:30 PM" span. */
  slotSpanEndUtc: string | null;
  /**
   * True when this listing reads as a registration-required course. Only ever present in results
   * when the caller opted in, and it exists so the card can SAY SO rather than blending a course
   * in silently among drop-in results.
   */
  registrationRequired: boolean;
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
  /**
   * Per-filter-value counts for the filter UI; present only when `facets` was requested.
   * Computed against the SAME context that produced `results` (post-broadening), so
   * `facets.total === total` always holds and the rail can never contradict the list.
   */
  facets?: FacetCounts;
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
      includeRegistration: req.includeRegistration,
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
    let run = primaryOf(ctx0);
    const applied: BroadenRung[] = [];
    let emptyState: ConstraintExplanation | null = null;

    // BROADENING and EXPLAINING are two different policies and they used to share one
    // condition. Broadening ADDS results the caller did not ask for, so a caller must be
    // able to decline it — `minResults: 0` is exactly that opt-out, and lib/email/digest.ts
    // uses it because a weekly email must contain only genuine matches. The explanation
    // adds NO results; it only names the constraint that emptied the set. Fusing them meant
    // that declining the padding also silently declined the explanation (`0 < 0` is false),
    // so the digest went quiet about a search it could not fill without ever computing why
    // — while /search, which always broadens, explained itself. Explain whenever the primary
    // run came back genuinely EMPTY; broaden only when the caller asked for a minimum.
    const tooFew = run.scored.length < minResults;
    if (tooFew || run.scored.length === 0) {
      emptyState = explainEmptyState(ctx0, (v) => primaryOf(v).scored.length);
    }
    if (tooFew) {
      for (const rung of buildBroadeningLadder(ctx0)) {
        applied.push(rung);
        working = rung.context;
        run = primaryOf(rung.context);
        if (run.scored.length >= minResults) break;
      }
    }
    const scored = run.scored;

    // Expected/seasonal section — populated once the ladder reached it, or when still short.
    const expected =
      working.includeExpected || scored.length < minResults
        ? this.runExpected({ ...working, includeExpected: true }, origin, regionChips, now)
        : [];

    // Facet counts (opt-in). Computed from the FINAL run's candidate set and the working
    // context — the very inputs that produced `results` — so a count can never describe a
    // different search than the one on screen (notably after the broadening ladder fires).
    // Reusing the already-matched candidates is what keeps this cheap: no query, no re-match.
    const facets = req.facets
      ? computeFacetCounts(
          run.candidates.map((c) => c.listing),
          { ctx: working, origin, regionChipIds: regionChips, regions: this.regions, now },
        )
      : undefined;

    const applyLimit = <T,>(arr: T[]): T[] => (req.limit != null ? arr.slice(0, req.limit) : arr);
    return {
      context: working,
      origin,
      originError,
      results: applyLimit(scored).map(toItem),
      expected: applyLimit(expected).map(toItem),
      total: scored.length,
      broadening: { applied, emptyState },
      ...(facets ? { facets } : {}),
      meta: { fixtureBacked: this.fixtureBacked, sort: working.sort },
    };
  }

  /**
   * parse-expanded context → matched, filtered, ranked, sorted, collapsed PRIMARY listings.
   *
   * Collapsing is the LAST step, after ranking and sorting, so a card lands wherever its
   * best-ranked slot ranked. It is inside this method rather than applied once at the end because
   * everything downstream — the result limit, `total`, and the broadening ladder's "are there
   * enough results?" test — should count CARDS a parent sees, not repeated slots of one activity.
   *
   * Also returns the matched candidate set, so facet counting can reuse it instead of paying for
   * a second matcher pass over every listing. (Facets do their own collapsing arithmetic — they
   * need per-facet-value card counts, not this one collapsed list.)
   */
  private runPrimary(
    ctx: SearchContext,
    origin: ResolvedOrigin | null,
    chips: string[],
    now: Date,
  ): { scored: CollapsedListing[]; candidates: MatchCandidate[] } {
    const candidates = this.match(ctx);
    const filtered = candidates.filter((c) => this.passesFilters(c.listing, ctx, origin, chips, 'primary'));
    const scored = rankCandidates(filtered, this.rankContext(ctx, origin, now));
    return { scored: collapseSameDaySeries(applySort(scored, ctx.sort)), candidates };
  }

  /** Expected/seasonal/evergreen suggestions: relaxed status class, loose filters. */
  private runExpected(ctx: SearchContext, origin: ResolvedOrigin | null, chips: string[], now: Date): CollapsedListing[] {
    const candidates = this.match(ctx).filter((c) => this.passesFilters(c.listing, ctx, origin, chips, 'expected'));
    return collapseSameDaySeries(rankCandidates(candidates, this.rankContext(ctx, origin, now)));
  }

  /** Alias-expand + text-match the context into a candidate set (no filtering yet). */
  private match(ctx: SearchContext): MatchCandidate[] {
    const expanded = this.aliases.expand(ctx.terms);
    const candidates = this.matcher.match(expanded, this.repo.all());
    // stash matched aliases for explainability without widening the candidate type
    return candidates.map((c) => Object.assign(c, { _matchedAliases: expanded.matchedAliases }));
  }

  private passesFilters(
    listing: ListingRecord,
    ctx: SearchContext,
    origin: ResolvedOrigin | null,
    chips: string[],
    mode: ResultMode,
  ): boolean {
    // Single source of truth, shared with the facet counter — see filters/predicate.ts.
    return passesAllFilters(listing, { ctx, origin, regionChipIds: chips, mode }, { regions: this.regions });
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

function toItem(group: CollapsedListing): SearchResultItem {
  const s = group.representative;
  const matchedAliases = (s.candidate as MatchCandidate & { _matchedAliases?: string[] })._matchedAliases ?? [];
  return {
    listing: s.candidate.listing,
    score: s.score,
    distanceKm: s.distanceKm,
    components: s.components,
    matchedAliases,
    slots: group.slots,
    slotSpanEndUtc: slotSpanEnd(group.slots),
    registrationRequired: isRegistrationShaped(s.candidate.listing),
  };
}
