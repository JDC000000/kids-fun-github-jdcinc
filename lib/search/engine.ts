// lib/search/engine.ts — Search orchestration (TSD §5A worked example).
//
// Composes the full pipeline: parse → alias-expand → match → filters (region, radius,
// age, time, date, cost, status) → rank → sort, with the empty-state broadening ladder
// and constraint explanation. Data flows through interfaces (repository, alias resolver,
// region hierarchy, rank config, geocoder), so swapping fixtures for live Postgres is a
// dependency change, not an engine rewrite.

import type { AgeBandKey, ListingRecord, SearchContext, SortKey } from './types';
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
import { parseQuery, relativeDate } from './parse';
// Type-only: the typed filter-chip param names (WhenKey/TimeOfDayKey) are the UI's own
// vocabulary (app/search/_lib/params.ts), reused here rather than duplicated so the engine's
// SearchRequest and the rail's SearchState can never drift on what a valid `when`/`time`
// value is. Erased at compile time — no runtime dependency on the app layer.
import type { WhenKey, TimeOfDayKey } from '@/app/search/_lib/params';
import { passesAllFilters, type ResultMode } from './filters/predicate';
// The POSITIVE age predicate, used to SECTION the primary list — never to filter it. Its
// permissive sibling `matchesAge` (which admits unknown-age listings under every filter) still
// owns inclusion, in predicate.ts, and is unchanged. See filters/age.ts for why there are two.
import { hasConfirmedAgeMatch } from './filters/age';
// Filtering lives in predicate.ts (shared with the facet counter); this is the CARD LABEL —
// a result that came back because the caller opted in has to say why it is there.
import { isRegistrationShaped } from './filters/registration';
import { computeFacetCounts, type FacetCounts } from './facets';
import { rankCandidates } from './rank';
import { applySort, prioritizeConfirmedFreeWhenFreeActive } from './sort';
import { collapseSeries, slotLocalDays, slotSpanEnd, type CollapsedListing, type OccurrenceSlot } from './collapse';
import { capVenueRepetition } from './venue-diversity';
import { describeRequestedDay, type RequestedDayWindow } from './day-window';
import {
  buildBroadeningLadder,
  explainEmptyState,
  explainUnparsedQuery,
  type BroadenAlternative,
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
  /**
   * Stage 2a — typed filter-chip params (roadmap initiative 2, first half). Structured, like
   * `dateRange` above: each field, when present, OVERRIDES whatever `parseQuery()` resolved
   * from `q` for that same dimension (see the override block in `search()`, applied right
   * before the `dateRange` override this pattern is copied from). Absent/undefined leaves the
   * text-parsed value alone, so a genuine free-typed query is unaffected. The OLD text
   * composition (`intentPhrases()` / `parseQuery()`'s chip regexes) still runs unchanged — it
   * is just redundant for chip-driven filtering once the caller sends the typed value too.
   */
  /** Selected age bands (chip multi-select). */
  ageBands?: AgeBandKey[];
  /** Date quick-pick. 'any' (or absent) applies no override — mirrors WHEN_OPTIONS. */
  when?: WhenKey;
  /** Day-part quick-pick. 'any' (or absent) applies no override. */
  timeOfDay?: TimeOfDayKey;
  /** Bookable-Now quick filter. */
  bookableNow?: boolean;
  /** Rainy-day / indoor quick filter. */
  rainyDay?: boolean;
  /** Drop-in quick filter. */
  dropIn?: boolean;
  /** Free-only quick filter (→ `ctx.costFree`). */
  free?: boolean;
  /** Travel radius in km; only meaningful when `origin` is also set. */
  radiusKm?: number;
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
   * Every same-series occurrence this one result now stands for, ascending by start
   * (see lib/search/collapse.ts). Always at least the listing itself, so consumers can read
   * `slots.length` uniformly rather than special-casing the uncollapsed card.
   */
  slots: OccurrenceSlot[];
  /**
   * Every distinct America/Vancouver local day those slots fall on, ascending — what a card that
   * stands for a recurring programme prints instead of one date ("8 slots · Tue, Wed, Thu, Fri").
   * Empty for an open-hours listing, which falls on no day at all.
   */
  slotDays: string[];
  /**
   * End of the LAST slot — the closing edge of a collapsed card's "3:15 PM–7:30 PM" span.
   *
   * NULL WHENEVER THE CARD SPANS MORE THAN ONE LOCAL DAY, and that is the point: the first start
   * and the last end of a Tuesday-to-Friday programme are not a time range anyone can attend, so
   * the response carries no span for a consumer to print. `slotDays` is what such a card has to
   * say about when it runs.
   */
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
  /**
   * The primary result list. Under an ACTIVE age filter this holds only the cards whose own
   * derived age bands genuinely intersect the selection — see `ageUnconfirmed` below for the rest.
   */
  results: SearchResultItem[];
  /** Separate "expected / seasonal / evergreen" section (§5A.5). */
  expected: SearchResultItem[];
  /**
   * Primary-section cards that passed the age filter only because their source never stated an
   * age (Jon's ruling 2026-08-18, option b).
   *
   * `matchesAge` admits a listing with no derived bands under EVERY age selection, deliberately —
   * an honestly-unknown age is not grounds for hiding a listing, and that rule is not changing.
   * What was wrong is what happened next: those listings were mixed into `results` and ranked
   * beside genuine matches, so a page headed "results for ages 2–4" contained listings nobody had
   * ever established were for 2–4-year-olds, and a parent could only find out by reading each
   * card's "Age not stated by source" line. The remedy is separation, not exclusion — this array
   * is the same listings, still reachable, under a heading that says what they are.
   *
   * ALWAYS EMPTY when no age filter is active: with nothing selected there is no claim to
   * qualify, so every card belongs in `results`.
   *
   * Modelled on `expected` above, which solved the same shape of problem for a different
   * dimension (§5A.5) — a second section rather than a flag on a card, because a flag is
   * something a parent has to notice and a section is something they cannot miss. It is NOT the
   * same section and must never be merged with it: `expected` is about whether the activity is
   * happening, this is about who it is for.
   */
  ageUnconfirmed: SearchResultItem[];
  /**
   * Every primary-section card this search reached, BEFORE `limit` — i.e.
   * `results.length + ageUnconfirmed.length`.
   *
   * It counts REACHABILITY, and the age split does not change reachability: an age-unconfirmed
   * listing is still on the page, under its own heading. Shrinking this to the confirmed count
   * would tell the broadening ladder the page is thinner than it is and provoke a widening the
   * parent never needed (silent constraint substitution — the defect `broadening.applied` exists
   * to disclose), and it would contradict `facets.total`, which counts the same "survives this
   * selection" population from the same candidate set. The two sections carry their own counts;
   * the total stays whole.
   */
  total: number;
  broadening: {
    applied: BroadenRung[];
    emptyState: ConstraintExplanation | null;
    /**
     * Every rung of the ladder (§5A.5), each carrying the REAL primary-result count its
     * cumulative context would yield — the "This weekend (12 results)" chips. Present only
     * when the primary run was too thin to fill `minResults` (same gate `applied` uses), so
     * an ordinary well-filled page never pays for it. See lib/search/broaden.ts's
     * `BroadenAlternative` for why every count here is provably real rather than estimated.
     */
    alternatives: BroadenAlternative[];
  };
  /**
   * Per-filter-value counts for the filter UI; present only when `facets` was requested.
   * Computed against the SAME context that produced `results` (post-broadening), so
   * `facets.total === total` always holds and the rail can never contradict the list.
   */
  facets?: FacetCounts;
  /**
   * Where the local clock sits inside the single day the parent asked for — null when the
   * request was not about one particular day (see lib/search/day-window.ts).
   *
   * WHAT IT IS FOR. The read model prunes ended occurrences against `now()`, so a `when=today`
   * result set is "what is LEFT of today", not "what is on today". Late in the evening that
   * collapses to open-hours attractions and still-running programmes, and without this a
   * consumer has no way to tell that state apart from a genuinely empty day. The engine cannot
   * count what was pruned — the rows were gone before it saw them — so this reports the CLOCK,
   * which it knows exactly, and leaves the two interpretations to be distinguished rather than
   * guessed. Consumers must not read it as a count of anything.
   *
   * Derived from the UNBROADENED intent (`ctx0.date`), not from `working`: it has to describe
   * the day the parent asked about, which is also the day the filter chip still displays, even
   * after the ladder has widened the window underneath it.
   */
  dateWindow: RequestedDayWindow | null;
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

    // Stage 2a — structured filter-chip overrides. Each field, when the caller supplies it,
    // wins over whatever parseQuery() resolved from `q` for that dimension — the exact
    // "structured param wins" pattern the dateRange override below already proved. Order
    // matters for `when` vs `dateRange`: this block runs BEFORE the dateRange block, so a
    // range (if also sent) always overwrites whatever `when` set here — mirroring
    // app/search/_lib/params.ts's `when = dateFrom/dateTo set ? 'any' : whenPick` precedence
    // server-side, so a caller sending both can never get an undefined winner.
    if (req.ageBands !== undefined) ctx0.ageBands = req.ageBands;
    if (req.when !== undefined && req.when !== 'any') {
      ctx0.date = relativeDate(req.when, now);
    }
    if (req.timeOfDay !== undefined && req.timeOfDay !== 'any') {
      ctx0.timeOfDay = req.timeOfDay;
    }
    if (req.bookableNow !== undefined) ctx0.bookableNow = req.bookableNow;
    if (req.rainyDay !== undefined) ctx0.rainyDay = req.rainyDay;
    if (req.dropIn !== undefined) ctx0.dropIn = req.dropIn;
    if (req.free !== undefined) ctx0.costFree = req.free;
    if (req.radiusKm != null && Number.isFinite(req.radiusKm) && req.radiusKm > 0) {
      ctx0.radiusKm = req.radiusKm;
    }

    // Structured custom date range (T26 / FR-04): an explicit start+end from the UI is
    // the source of truth for date intent and overrides anything the text parser resolved
    // (e.g. a stray "today" phrase). Ordered defensively so isoDate<=endIsoDate always
    // holds; an invalid/partial range is ignored (no date constraint). Runs AFTER the block
    // above so it always wins over `when` — see the comment there.
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

    // AN UNPARSED QUERY IS NOT A BROWSE — the honest zero-state, before anything runs.
    //
    // `ctx0.unparsedQuery` means the parent typed text and the parser could read none of it
    // (lib/search/parse.ts). Below this line that fact is unrecoverable: the pipeline sees
    // only `terms: []`, which is also what a bare browse looks like, so the matcher enters
    // `browseMode`, every listing becomes a candidate, and the parent gets a limit's worth of
    // unrelated activities presented as the results of their search — with `broadening.applied`
    // empty, because nothing WAS widened, so not even the "we changed your search" notice
    // fires. A query in any non-Latin script reached exactly that, every time.
    //
    // The ladder cannot rescue it either, which is why the exit is here and not after the
    // primary run: every rung relaxes a FILTER, and no filter is what emptied this search. The
    // first rung that admits enough rows would simply serve the same unrelated dump under a
    // "we widened your search" label — a worse outcome than the silent one, because it names a
    // cause that is not the cause.
    //
    // Structured chips do not change the answer. If a parent typed something we cannot read
    // AND ticked "today", "everything on today" is still not what they asked for; the chips
    // stay in `context` (the rail keeps rendering them) but they are not grounds to answer a
    // different question. The origin is resolved above so `origin`/`originError` remain true
    // on this response — the page's distance note reads them regardless of result count.
    if (ctx0.unparsedQuery) {
      return this.unparsedQueryResponse(ctx0, origin, originError, regionChips, now, req.facets === true);
    }

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
    const tooFew = primaryCount(run) < minResults;
    if (tooFew || primaryCount(run) === 0) {
      // `baseline` is how many results the parent can see before any relaxation. It is
      // `run.scored.length` and not 0 because this branch ALSO fires for a THIN set, not only
      // an empty one, and "relaxing it shows N more" has to be an addition to what is already
      // on screen — reporting the relaxed TOTAL there overstated the remedy by exactly the
      // number of results the parent already had.
      // The probe takes the region chips as well as the context, so the ONE narrowing filter
      // that does not live on SearchContext can still be relaxed and measured — see
      // broaden.ts's `activeConstraints` for what its absence used to make the page claim.
      const explained = explainEmptyState(
        ctx0,
        (v, chips) => primaryCount(this.runPrimary(v, origin, chips, now)),
        {
          baseline: primaryCount(run),
          hasOrigin: origin != null,
          regionChipIds: regionChips,
        },
      );

      // PUBLISH ONLY WHAT A PARENT CAN ACT ON. This block fires whenever the primary run is
      // short of `minResults`, which for a caller with a large minimum (the browse page asks
      // for 60) is the ORDINARY state of a perfectly good page — 14 results and nothing wrong.
      // Consumers render this as "here is what is holding your search back", so emitting it
      // when nothing is holding the search back turns a remedy into a complaint about a page
      // that is working. Two cases are worth saying out loud, and no others:
      //   • a genuinely EMPTY result set — always explain it, even if no single relaxation
      //     helps ("nothing matches, and widening one filter will not change that" is the
      //     honest answer to a blank page); and
      //   • a thin set where some constraint would GENUINELY unlock more (`addsResults > 0`,
      //     which is what leaves `blockingConstraint` non-null).
      // Deciding it here rather than in each consumer means the digest, /account and /search
      // cannot drift about when a search counts as needing an explanation.
      emptyState = primaryCount(run) === 0 || explained.blockingConstraint != null ? explained : null;
    }
    // Alternative chips ("This weekend (12 results)"): a REAL count per rung of the ladder,
    // not just the label. Computed in the SAME loop that already walks the ladder to fill
    // `minResults`, so every count — applied or not — comes from the identical `primaryOf`
    // call the engine itself trusts for real results, never a second, cheaper-and-possibly-
    // wrong estimate. Gated on `tooFew` exactly like the ladder walk below it: a caller whose
    // page is already full (the ordinary case) pays nothing for this.
    const alternatives: BroadenAlternative[] = [];
    if (tooFew) {
      let filled = false;
      for (const rung of buildBroadeningLadder(ctx0, { hasOrigin: origin != null })) {
        const rungRun = primaryOf(rung.context);
        const isApplied = !filled;
        if (isApplied) {
          applied.push(rung);
          working = rung.context;
          run = rungRun;
          if (primaryCount(rungRun) >= minResults) filled = true;
        }
        alternatives.push({
          rung: rung.rung,
          key: rung.key,
          label: rung.label,
          constraint: rung.constraint,
          // The chip promises what the page will HOLD, which is both primary sections — the same
          // number `total` reports for the rung the engine applies. A count that silently dropped
          // the age-unconfirmed cards would under-promise every widening a parent can click.
          count: primaryCount(rungRun),
          applied: isApplied,
          context: rung.context,
        });
      }
    }
    const scored = run.scored;
    const ageUnconfirmed = run.ageUnconfirmed;

    // Expected/seasonal section — populated once the ladder reached it, or when still short.
    // Gated on the WHOLE primary page (both sections), not just the confirmed one: the expected
    // section exists to rescue a thin page, and a page carrying six age-unconfirmed cards is not
    // thin — padding it further would bury them rather than answer for them.
    const expected =
      working.includeExpected || primaryCount(run) < minResults
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
      ageUnconfirmed: applyLimit(ageUnconfirmed).map(toItem),
      total: primaryCount(run),
      broadening: { applied, emptyState, alternatives },
      ...(facets ? { facets } : {}),
      dateWindow: describeRequestedDay(ctx0.date, now),
      meta: { fixtureBacked: this.fixtureBacked, sort: working.sort },
    };
  }

  /**
   * The zero-state for a query the parser could read nothing of (see the exit in `search()`).
   *
   * Every section is empty and `total` is 0 — the two together are what make the page say "we
   * found you nothing" instead of quietly showing a browse. `broadening.applied` is empty and
   * stays empty because nothing was widened, and `alternatives` is empty because there is no
   * widening to offer: every rung acts on a filter, and no filter caused this.
   *
   * Facets, when the caller asked for them, are computed over an EMPTY listing set rather than
   * omitted or hand-built. That keeps the two invariants facets carry — `facets.total === total`
   * and "every chip the rail can render has a count behind it" — true here by construction, so
   * the rail folds its groups away rather than rendering stale numbers from a search that never
   * ran.
   */
  private unparsedQueryResponse(
    ctx: SearchContext,
    origin: ResolvedOrigin | null,
    originError: string | null,
    regionChipIds: string[],
    now: Date,
    wantsFacets: boolean,
  ): SearchResponse {
    return {
      context: ctx,
      origin,
      originError,
      results: [],
      expected: [],
      ageUnconfirmed: [],
      total: 0,
      broadening: { applied: [], emptyState: explainUnparsedQuery(ctx.raw), alternatives: [] },
      ...(wantsFacets
        ? { facets: computeFacetCounts([], { ctx, origin, regionChipIds, regions: this.regions, now }) }
        : {}),
      dateWindow: describeRequestedDay(ctx.date, now),
      meta: { fixtureBacked: this.fixtureBacked, sort: ctx.sort },
    };
  }

  /**
   * parse-expanded context → matched, filtered, ranked, sorted, collapsed, venue-capped PRIMARY
   * listings.
   *
   * Collapsing is the LAST step, after ranking and sorting, so a card lands wherever its
   * best-ranked slot ranked. It is inside this method rather than applied once at the end because
   * everything downstream — the result limit, `total`, and the broadening ladder's "are there
   * enough results?" test — should count CARDS a parent sees, not repeated slots of one activity.
   *
   * The venue cap runs after the age split and on each section separately, because each section is
   * a list a parent scans on its own. It moves cards, never removes them (lib/search/venue-diversity.ts),
   * so every count this method feeds is identical with and without it — which is also why running
   * it inside the ladder's probe loop costs nothing but a reorder.
   *
   * Also returns the matched candidate set, so facet counting can reuse it instead of paying for
   * a second matcher pass over every listing. (Facets do their own collapsing arithmetic — they
   * need per-facet-value card counts, not this one collapsed list.)
   *
   * The two returned card lists PARTITION the primary page — every card is in exactly one of
   * them, and `scored.length + ageUnconfirmed.length` is the count the whole pipeline (ladder,
   * `total`, alternative chips) reasons about. See `primaryCount`.
   */
  private runPrimary(
    ctx: SearchContext,
    origin: ResolvedOrigin | null,
    chips: string[],
    now: Date,
  ): PrimaryRun {
    const candidates = this.match(ctx);
    const filtered = candidates.filter((c) => this.passesFilters(c.listing, ctx, origin, chips, 'primary'));
    const scored = rankCandidates(filtered, this.rankContext(ctx, origin, now));
    const sorted = applySort(scored, ctx.sort);
    // Option C step 2b (Jon's ruling 2026-08-17): an ORDERING change only, gated on the Free
    // quick filter being active. Confirmed-free listings move ahead of unpriced ones so a
    // parent's first impression of a Free search is confirmed-free items — nothing is dropped,
    // reclassified or excluded; see prioritizeConfirmedFreeWhenFreeActive's own header for why
    // this is a stable partition and not a second cost predicate.
    const prioritized = ctx.costFree ? prioritizeConfirmedFreeWhenFreeActive(sorted) : sorted;
    const split = splitAgeUnconfirmed(collapseSeries(prioritized), filtered, ctx.ageBands);
    return {
      scored: capVenueRepetition(split.scored),
      ageUnconfirmed: capVenueRepetition(split.ageUnconfirmed),
      candidates,
    };
  }

  /** Expected/seasonal/evergreen suggestions: relaxed status class, loose filters. */
  private runExpected(ctx: SearchContext, origin: ResolvedOrigin | null, chips: string[], now: Date): CollapsedListing[] {
    const candidates = this.match(ctx).filter((c) => this.passesFilters(c.listing, ctx, origin, chips, 'expected'));
    // Capped like the primary sections: this is a list of cards a parent reads, and one venue
    // owning it would be the same defect wherever it appears.
    return capVenueRepetition(collapseSeries(rankCandidates(candidates, this.rankContext(ctx, origin, now))));
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

/** One primary run: the confirmed-age cards, the age-unconfirmed cards, and the candidate set. */
interface PrimaryRun {
  scored: CollapsedListing[];
  ageUnconfirmed: CollapsedListing[];
  candidates: MatchCandidate[];
}

/**
 * Every primary card a run reached, across BOTH sections — the number `total`, the broadening
 * ladder's fill test and every alternative chip's count are all measured in.
 *
 * One function rather than `a.length + b.length` at five call sites, because the whole hazard of
 * splitting a result list in two is that some of the arithmetic downstream keeps counting only
 * half of it: a ladder that thinks the page is empty will widen a search that was already full.
 */
function primaryCount(run: PrimaryRun): number {
  return run.scored.length + run.ageUnconfirmed.length;
}

/**
 * Partition already-collapsed primary cards into confirmed-age and age-unconfirmed (Jon's ruling
 * 2026-08-18, option b). Order within each part is preserved exactly, so the split re-sections the
 * page without re-ranking it.
 *
 * WHY THE SPLIT IS BY SLOT, NOT BY THE CARD'S REPRESENTATIVE. A card stands for every same-series
 * occurrence behind it (lib/search/collapse.ts), and age is a per-OCCURRENCE fact in the
 * read model, so one card's slots can legitimately disagree about it. A card earns the confirmed
 * section when ANY occurrence it stands for genuinely intersects the selection — the card is one
 * row a parent taps to reach the whole group, and one real match is enough to make that row a
 * true answer. Classifying by the representative alone would file such a card by whichever slot
 * happened to rank best, which is not a fact about the group.
 *
 * WHY IT RUNS AFTER COLLAPSING rather than partitioning the ranked list first: collapsing two
 * separate lists would emit the same series as TWO cards whenever its occurrences disagreed,
 * double-counting it against `facets.total` — which counts distinct collapse keys over the whole
 * candidate set and would still see one.
 */
function splitAgeUnconfirmed(
  cards: CollapsedListing[],
  filtered: MatchCandidate[],
  userBands: AgeBandKey[],
): { scored: CollapsedListing[]; ageUnconfirmed: CollapsedListing[] } {
  // No age filter → nothing to qualify, so the whole page is the ordinary result list.
  if (userBands.length === 0) return { scored: cards, ageUnconfirmed: [] };

  const confirmedSlots = new Set<string>();
  for (const c of filtered) {
    if (hasConfirmedAgeMatch(c.listing, userBands)) confirmedSlots.add(c.listing.id);
  }

  const scored: CollapsedListing[] = [];
  const ageUnconfirmed: CollapsedListing[] = [];
  for (const card of cards) {
    if (card.slots.some((slot) => confirmedSlots.has(slot.id))) scored.push(card);
    else ageUnconfirmed.push(card);
  }
  return { scored, ageUnconfirmed };
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
  const days = slotLocalDays(group.slots);
  return {
    listing: s.candidate.listing,
    score: s.score,
    distanceKm: s.distanceKm,
    components: s.components,
    matchedAliases,
    slots: group.slots,
    slotDays: days,
    // A span is only a fact about a card that occupies ONE day; see SearchResultItem#slotSpanEndUtc.
    slotSpanEndUtc: days.length > 1 ? null : slotSpanEnd(group.slots),
    registrationRequired: isRegistrationShaped(s.candidate.listing),
  };
}
