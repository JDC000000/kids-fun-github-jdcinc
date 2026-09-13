import Link from 'next/link';
import { headers } from 'next/headers';
import { ActivityCard } from '../preview/_components/ActivityCard';
import { partitionSections } from '../preview/_data/filter';
import { mapSearchResponseToActivities, type SearchItemDto, type SearchResponseDto } from '../preview/_data/search-api';
import type { Activity } from '../preview/_data/types';
import { recordSearchPerformed } from '@/lib/analytics/record';
import { getRequestUser, type RequestUser } from '@/lib/db/session-user';
import { getUserProfile } from '@/lib/db/user-profile';
import { areaLabelForPostal } from '@/lib/geo/postal-fsa';
import { SearchBar } from './_components/SearchBar';
import { FilterRail, type SavedLocationInfo } from './_components/FilterRail';
import { MobileFilterSheet } from './_components/MobileFilterSheet';
import {
  activeFilterCount,
  appliedFilterTokens,
  otherFilterChips,
  whenChipLabel,
  whereChipLabel,
} from './_lib/filter-summary';
import { planRailGroups } from './_lib/rail-groups';
import { QuerySummary } from './_components/QuerySummary';
import { SearchResultsView } from './_components/SearchResultsView';
import { ResumeSearch } from './_components/ResumeSearch';
import { ProfileAgeDefault } from './_components/ProfileAgeDefault';
import { ChildProfilePrompt } from '../_components/ChildProfilePrompt';
import { buildMarkers, geoIndex } from './_lib/markers';
import { distanceAvailability, distanceNote } from './_lib/distance-note';
import { groupActivitiesByDay, buildDayIndex, formatRangeLabel, type DayGroup } from './_lib/day-groups';
import { describeBroadening, joinPhrases, type AppliedRungDto } from './_lib/broadening-notice';
import { describeBroadeningAlternatives } from './_lib/broadening-alternatives';
import { describeDayRemainder } from './_lib/day-remainder-notice';
import { SparseCoverageNotice } from './_components/SparseCoverageNotice';
import type { BroadenAlternative } from '@/lib/search/broaden';
import type { RegionCoverage } from '@/lib/search/coverage';
import type { RequestedDayWindow } from '@/lib/search/day-window';
import {
  AGE_OPTIONS,
  CLEARED_FILTERS,
  SORT_OPTIONS,
  analyticsFilterTokens,
  apiQuery,
  hasActiveFilters,
  hasClearableFilters,
  hasDateRange,
  hasNearMeCoords,
  hrefFor,
  parseSearchState,
  serializeStateToParams,
  type SavedOrigin,
  type SearchState,
} from './_lib/params';

// Parent-facing search RESULTS page (M3 Screen 2, Visual Blueprint v0.2). The first
// real surface a parent can type a query into and scan DB-backed results — distinct
// from /preview, which is an explicit fixture/demo shell (see app/preview/README.md).
//
// This is a server component: it reads the query from the URL, calls the existing
// /api/search route as a black box (backend selection + fixture fallback all live
// there), and renders the results server-side, so a shared /search?q=… link resolves
// to real cards with no loading flash and works without client JavaScript. Each card
// reuses the existing ActivityCard and links to the built, QA-verified /preview/[id]
// detail page.

export const dynamic = 'force-dynamic';

/** The /api/search JSON, plus the broadening block the route returns but the preview DTO doesn't type. */
type SearchApiResponse = SearchResponseDto & {
  broadening?: {
    // Each rung carries the cumulative context it applied (plus, for drop_chip, WHICH chip).
    // That is what the "we widened your search" notice reports — see _lib/broadening-notice.ts.
    applied: AppliedRungDto[];
    emptyState: { blockingConstraint: string | null; message: string } | null;
    // Real, pre-counted candidate rungs (applied AND not-yet-applied) — the "This weekend
    // (12 results)" chips. See _lib/broadening-alternatives.ts.
    alternatives?: BroadenAlternative[];
  };
  // Where the local clock sits inside the single day the search asked for. Optional for the
  // same reason `broadening` above is: this type DESCRIBES a JSON payload fetched over HTTP,
  // it does not verify one, so nothing here may be assumed present. The derivation reads an
  // absent window as "nothing to say" rather than guessing. See _lib/day-remainder-notice.ts.
  dateWindow?: RequestedDayWindow | null;
  // The parsed intent the engine actually ran. Only ONE field of it is read here, and only
  // because a zero-result page has to say WHICH kind of zero it is: `unparsedQuery` marks a
  // query whose text the parser could read nothing of (lib/search/parse.ts), which is not the
  // same event as a search that ran and matched nothing. Optional/deeply-optional for the same
  // reason as everything above — this type describes a fetched payload, it does not verify one.
  context?: { unparsedQuery?: boolean };
  // How much of the catalogue we actually hold for each area chip this search selected
  // (lib/search/coverage.ts). Optional/deeply-optional for the same reason as everything above —
  // this type describes a fetched payload, it does not verify one — and the derivation reads an
  // absent array as "no area was selected", which renders nothing.
  regionCoverage?: RegionCoverage[];
};

function baseUrl(): string {
  const h = headers();
  const host = h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
  return `${proto}://${host}`;
}

interface FetchResult {
  ok: boolean;
  body?: SearchApiResponse;
  error?: string;
}

async function runSearch(state: SearchState, savedOrigin: SavedOrigin | null): Promise<FetchResult> {
  try {
    // `facets: true` asks the same request for per-filter-value counts. They cost a few
    // in-memory passes over the candidate set this search already built (no second query —
    // see lib/search/facets.ts), and they are what lets the desktop rail show live counts
    // AND fold away the groups that cannot narrow this query.
    const res = await fetch(`${baseUrl()}/api/search?${apiQuery(state, savedOrigin, { facets: true })}`, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return { ok: false, error: `Search API returned ${res.status}` };
    return { ok: true, body: (await res.json()) as SearchApiResponse };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function sourceNote(body: SearchApiResponse): string {
  if (body.meta.backend === 'database' && !body.meta.fixtureBacked) {
    return 'Live database — approved public sources only.';
  }
  if (body.meta.fallbackReason) {
    return `Fixture fallback — ${body.meta.fallbackReason}.`;
  }
  return 'Fixture-backed search preview.';
}

/**
 * Resolve the signed-in user's saved-location origin, server-side (Task 29). Anonymous
 * users get nothing here — their near-me behaviour (browser geolocation) is unchanged.
 * A signed-in user with a saved home postal that resolves to a covered Metro-Vancouver
 * area gets both: a `savedOrigin` (postal forwarded to /api/search) and a `savedLocation`
 * (the area label for the chip). NEVER load-bearing: any auth/DB failure, an un-saved or
 * out-of-coverage postal, all degrade to nulls (no chip, no origin) — never an error.
 */
async function resolveSavedOrigin(user: RequestUser | null): Promise<{
  savedOrigin: SavedOrigin | null;
  savedLocation: SavedLocationInfo | null;
}> {
  try {
    if (!user) return { savedOrigin: null, savedLocation: null };
    const profile = await getUserProfile(user.userId);
    const postal = profile?.home_postal ?? null;
    const areaLabel = areaLabelForPostal(postal);
    if (!postal || !areaLabel) return { savedOrigin: null, savedLocation: null };
    return { savedOrigin: { postal }, savedLocation: { areaLabel } };
  } catch {
    return { savedOrigin: null, savedLocation: null };
  }
}

function Section({ title, note, items }: { title: string; note?: string; items: Activity[] }) {
  if (items.length === 0) return null;
  return (
    <section>
      <div className="kf-section__head">
        <h2 className="kf-section__title">{title}</h2>
        <span className="kf-section__count">{items.length}</span>
        <span className="kf-section__rule" aria-hidden="true" />
      </div>
      {note && <p className="kf-section__note">{note}</p>}
      {items.map((a) => (
        <ActivityCard key={a.id} activity={a} />
      ))}
    </section>
  );
}

/**
 * The age-not-confirmed section (Jon's ruling 2026-08-18, option b).
 *
 * WHAT IT IS. Under an active age filter the engine admits listings whose source never stated an
 * age — deliberately, because an honestly-unknown age is not grounds for hiding a listing
 * (lib/search/filters/age.ts) — but it no longer mixes them into the confirmed list. They arrive
 * as their own array (`ageUnconfirmed`) and render here.
 *
 * WHY IT IS NOT JUST ANOTHER <Section>. The brief for this section is that a parent should not
 * have to READ it to notice it means something different, so it does not reuse the plain
 * section head that "Confirmed from approved sources" uses. It is a bounded panel with its own
 * rule, its own heading colour and an explicit caveat above the cards. The wording matches
 * `AGE_NOT_STATED` ("Age not stated by source") — the same words each card inside it already
 * prints on its own age line — so the section heading and the cards under it say one thing, not
 * two versions of it. It never claims the listings are unsuitable; only that nobody told us.
 */
function AgeUnconfirmedSection({ items, bandLabel }: { items: Activity[]; bandLabel: string | null }) {
  if (items.length === 0) return null;
  return (
    <section className="kf-ageunconf">
      <div className="kf-section__head">
        <h2 className="kf-section__title kf-ageunconf__title">Age not stated by source</h2>
        <span className="kf-section__count">{items.length}</span>
        <span className="kf-section__rule" aria-hidden="true" />
      </div>
      <p className="kf-section__note kf-ageunconf__note">
        These are kept separate because their source never published an age range — so we cannot
        confirm they suit {bandLabel ?? 'the ages you picked'}. They are not hidden, and they may
        well be a good fit; check the source before you go.
      </p>
      {items.map((a) => (
        <ActivityCard key={a.id} activity={a} />
      ))}
    </section>
  );
}

/**
 * Confirmed results grouped by day for a custom date range (T26 / FR-04). Keeps the same
 * "Confirmed from approved sources" h2 as the flat view (the confirmed/expected honesty
 * framing must never be lost — UXR-06), then nests one h3 subsection per day the parent's
 * range spans, in ascending date order, plus a trailing "Available any day" group for
 * open-hours attractions (which belong to no single day). h1 → h2 → h3 keeps heading order
 * clean; the Expected h2 that still renders below stays a sibling of this section's h2.
 */
function DayGroupedResults({ groups, total }: { groups: DayGroup[]; total: number }) {
  if (groups.length === 0) return null;
  return (
    <section>
      <div className="kf-section__head">
        <h2 className="kf-section__title">Confirmed from approved sources</h2>
        <span className="kf-section__count">{total}</span>
        <span className="kf-section__rule" aria-hidden="true" />
      </div>
      {groups.map((g) => (
        <div className="kf-daygroup" key={g.isoDate ?? '__open__'}>
          <h3 className="kf-daygroup__title">
            {g.label}
            <span className="kf-daygroup__count">{g.items.length}</span>
          </h3>
          {g.items.map((a) => (
            <ActivityCard key={a.id} activity={a} />
          ))}
        </div>
      ))}
    </section>
  );
}

/** listing id → America/Vancouver local day (YYYY-MM-DD), or null for open-hours / undated
 *  listings — built from the RAW API items so day grouping matches the real occurrence dates.
 *  The rule itself lives beside the grouping it feeds (./_lib/day-groups#buildDayIndex). */
function dayIndexFor(body: SearchApiResponse | undefined): Map<string, string | null> {
  return body ? buildDayIndex(allSections(body)) : new Map();
}

/**
 * Every raw item the response surfaced, across ALL THREE sections.
 *
 * One helper rather than three inline spreads, because "the sections" is now a list that has
 * grown once and a per-call-site spread is how a section quietly stops being plotted on the map
 * or stops getting a day bucket. `ageUnconfirmed` is optional on the DTO (older/hand-built
 * payloads omit it), so it is defaulted here in the one place that knows about it.
 */
function allSections(body: SearchApiResponse): SearchItemDto[] {
  return [...body.results, ...(body.ageUnconfirmed ?? []), ...body.expected];
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const state = parseSearchState(searchParams);
  // Resolve the session once and reuse it for the saved-location origin AND the
  // "Save this search" control (avoids a second session read).
  const user = await getRequestUser();
  // Signed-in saved-location origin (Task 29); null for anonymous users (unchanged behaviour).
  const { savedOrigin, savedLocation } = await resolveSavedOrigin(user);
  const result = await runSearch(state, savedOrigin);
  // A radius only truly applies when there's a real origin: browser coords, or a saved
  // location we actually resolved (a bare ?home=1 with no signed-in profile behind it doesn't).
  const realOrigin = hasNearMeCoords(state) || (state.useSavedLocation && savedOrigin != null);

  const activities = result.body ? mapSearchResponseToActivities(result.body) : [];
  // The age-not-stated section (lib/search/engine.ts `ageUnconfirmed`). Peeled off by ID BEFORE
  // the status partition, not after: `partitionSections` sorts by STATUS, and these listings are
  // being separated for an unrelated reason (nobody stated who they are for). Running them
  // through it would scatter them back into the two status sections — the exact blending this
  // separation exists to end. Whatever their status, they render under their own heading.
  const ageUnconfirmedIds = new Set((result.body?.ageUnconfirmed ?? []).map((i) => i.listing.id));
  const ageUnconfirmed = activities.filter((a) => ageUnconfirmedIds.has(a.id));
  const { confirmed, expected } = partitionSections(activities.filter((a) => !ageUnconfirmedIds.has(a.id)));
  // Every card the page renders. Age-unconfirmed listings are counted because they are ON the
  // page — the honesty is delivered by their own heading and their own count, not by leaving
  // them out of the total (which would make the page under-report what it is showing). Mirrors
  // SearchResponse.total, which counts both primary sections for the same reason.
  const total = confirmed.length + expected.length + ageUnconfirmed.length;
  // "ages 2–4", "ages 2–4 & 5–9" — the selection the unconfirmed section says it cannot vouch
  // for, in the rail's own words rather than a second phrasing of the same bands.
  const ageBandLabel =
    state.ages.length > 0
      ? `ages ${state.ages.map((band) => AGE_OPTIONS.find((a) => a.key === band)?.label ?? band).join(' & ')}`
      : null;

  // Map view (Task 37): coordinates come off the raw /api/search items (the parent-facing
  // Activity DTO drops geo) and are re-attached by id, so the marker set is exactly the
  // rendered result set. A PUBLIC Mapbox token (pk.*) is safe in the browser by design —
  // prefer the dedicated NEXT_PUBLIC_MAP_KEY, and fall back to the verified-public geocoding
  // key so the map works wherever Task 36's key is already configured. A secret (sk.*) token
  // must never be placed in either of these vars.
  const geo = geoIndex(result.body ? allSections(result.body) : []);
  const markers = buildMarkers(confirmed, expected, geo, ageUnconfirmed);
  const mapToken = (process.env.NEXT_PUBLIC_MAP_KEY ?? process.env.GEOCODING_API_KEY ?? '').trim();
  const sortLabel = SORT_OPTIONS.find((o) => o.key === state.sort)?.label ?? '';
  // Read from the RESPONSE's resolved origin, not from `realOrigin` above. The two disagree in
  // exactly the case that matters: `realOrigin` says "this request asked for an origin", while
  // the response says whether the engine could actually resolve one. A saved postal that fails
  // to geocode is origin-asking-for and origin-less, and the parent deserves the second answer.
  const distanceExplanation = distanceNote(distanceAvailability(result.body));
  const emptyExplain = result.body?.broadening?.emptyState?.message ?? null;
  // The engine could not read the typed query at all, so it deliberately returned nothing
  // rather than a browse (lib/search/engine.ts). The page must not then report "nothing
  // matches your search" — no search was performed on those words. The reason and the advice
  // are already in `emptyExplain` above; this only stops the generic copy from asserting a
  // cause ("schedules post 2–4 weeks ahead") that has nothing to do with what happened.
  const queryUnparsed = result.body?.context?.unparsedQuery === true;
  // The broadening ladder may have relaxed dates, times, ages or a chip to fill the page
  // (lib/search/broaden.ts). When it did, the results on screen answer a slightly different
  // question from the one that was asked, and the page has to say so — silently substituting
  // constraints is the defect this notice closes.
  const broadening = describeBroadening(result.body?.broadening?.applied);
  // Clickable "pre-counted alternative" chips — the SPECIFIC widenings the ladder considered,
  // each with a real result count, so a parent can pick one directly instead of accepting (or
  // not) whatever the ladder already did. See _lib/broadening-alternatives.ts for why only
  // some rungs are offered as chips.
  const alternativeChips = describeBroadeningAlternatives(result.body?.broadening?.alternatives, state);
  // WHY A THIN "TODAY" IS THIN. The catalogue only ever holds activities that have not ended
  // (lib/search/postgres-repository.ts prunes against `now()`), so a Today list is what is LEFT
  // of today. Late in the evening that collapses to open-hours attractions and still-running
  // programmes, and the page used to render that silently — indistinguishable from a city with
  // nothing on. Three testers read it as a broken product. This states which of the two it is
  // when the clock can tell, and says so plainly when it cannot. See _lib/day-remainder-notice.ts.
  const dayRemainder = describeDayRemainder(result.body?.dateWindow, { resultCount: total });
  const tomorrowHref = hrefFor(state, { when: 'tomorrow', dateFrom: null, dateTo: null });
  // The applied query in plain language. One derivation shared with the mobile sticky bar,
  // so the phone and the desktop can never disagree about what is filtering.
  const appliedTokens = appliedFilterTokens(state, savedLocation);
  const activeFilters = appliedTokens.map((t) => t.label);
  // Narrowing filters only — this gates the analytics "is this a search?" test and the empty-state
  // prompt, both of which are about constraints the parent applied, not about wideners.
  const filtersActive = hasActiveFilters(state);
  // Anything clearable, including the registration widener — gates the "Clear filters" affordances.
  const clearableFilters = hasClearableFilters(state);
  // Live per-filter-value counts, when the search returned them. `null` is a supported state,
  // not an error: the counts simply do not render (see _lib/rail-groups.ts).
  const facets = result.body?.facets ?? null;
  // GATED — QA round 96, finding F1. Flip this back to `true` once F1 is fixed and
  // re-verified against the same focus-return standard.
  //
  // The adaptive plan moves a group ACROSS the disclosure fold when the split changes, and a
  // chip activation is a navigation, so the newly-rendered tree can put the element that had
  // focus on the other side of that boundary. React then remounts it and focus falls to
  // <body>: recoverable, but it loses the parent's place and resets a screen reader's virtual
  // cursor. QA measured it on 7 of 24 up-front chips (29%) on a bare /search, and isolated it
  // by matched-pair testing as SHAPE-driven — it is the split changing, not the counts.
  //
  // WHY THE GATE IS COARSER THAN "MOBILE ONLY": there is exactly ONE FilterRail instance,
  // rendered once on the server and relocated by CSS. That single-instance reuse is what keeps
  // the URL/deep-link contract in one place, and it is deliberate — but it also means the
  // server cannot hand the phone a different plan from the desktop, because it does not know
  // the viewport. So gating the sheet gates the rail too. The alternative (a second, desktop-only
  // render) is exactly the duplication this architecture exists to avoid, and would be a worse
  // thing to ship at speed than a static rail.
  //
  // WHAT THIS COSTS, measured rather than assumed: the rail shows all nine groups instead of
  // 5-6. Because the rail is a SIDEBAR, its height does not push the results down — the
  // above-the-fold win (461px of chrome, three complete cards at 1440) is unaffected. What is
  // lost is scannability of the rail itself, not the headline geometry.
  //
  // rail-groups.ts and its unit tests stay exactly as they are: the selection logic is pure and
  // still correct, and it is the RELOCATION of groups between renders that F1 is about.
  const ADAPTIVE_RAIL_ENABLED = false;
  const railPlan = ADAPTIVE_RAIL_ENABLED ? planRailGroups(state, facets) : null;
  // Custom date range (T26 / FR-04): when a range is active the confirmed results are grouped
  // by day (one dated subsection per day, open-hours attractions last). The day-by-id lookup is
  // built from the raw API items so grouping reflects each occurrence's true local date.
  const rangeActive = hasDateRange(state);
  const confirmedGroups = rangeActive ? groupActivitiesByDay(confirmed, dayIndexFor(result.body)) : [];

  // The serialized filter state. This used to feed BOTH "Save this search" and the
  // on-device ResumeSearch memory; the save control was removed with Google sign-in
  // (2026-09-12), so ResumeSearch — which persists nothing server-side and needs no
  // account — is now its only consumer.
  const saveParams = serializeStateToParams(state);
  const suggestedName = state.q.trim() || activeFilters.join(' · ');

  // Analytics (M5 / T31): best-effort "search performed" capture. Fires only when a
  // real query or an active filter is present (a bare /search browse is not a search)
  // and only when the search actually executed. Awaited like recordListingView so the
  // row lands deterministically, but it can never block or break the render.
  // Non-PII: query text + stable filter tokens + result counts; near-me coordinates
  // are never persisted (see recordSearchPerformed / analyticsFilterTokens).
  if (result.ok && (state.q.trim().length > 0 || filtersActive)) {
    await recordSearchPerformed(
      {
        q: state.q,
        sort: state.sort,
        regions: state.regions,
        filters: analyticsFilterTokens(state),
        radiusKm: realOrigin ? state.radiusKm : null,
      },
      {
        total,
        confirmed: confirmed.length,
        expected: expected.length,
        backend: result.body?.meta.backend,
        broadened: (result.body?.broadening?.applied?.length ?? 0) > 0,
      }
    );
  }

  return (
    <>
      {/* The /search hero band is GONE (audit Quick Win #7). It was a 193px duplicate of the
          home page's hero, restating the value proposition to a parent who has already
          arrived and typed a query, and it was the single largest block of chrome between
          the top of the page and the first result. Its <h1> moved to QuerySummary, where the
          heading states the parent's own query instead of the product's pitch.
          The wordmark it also carried is now a real home link in the global nav. */}

      {/* Desktop: a two-column shell — persistent filter rail beside the results. Below the
          rail breakpoint BOTH wrappers are `display: contents`, so the DOM order a phone
          renders (search bar → sticky filter bar → results) is byte-for-byte what it was
          before this grid existed. Above it, CSS grid places the rail beside the results
          from that SAME order — no duplicated markup, nothing reordered in the DOM. */}
      <div className="kf-srch">
        <SearchBar state={state} />
        {/* Filters (Blueprint §04 / Screen 5). ONE rail, relocated by viewport: a persistent
            left rail at >=1043px, the inline column it has always been at 768-1042px, and a
            sticky summary bar + bottom sheet at <=767px. MobileFilterSheet is a client island
            that WRAPS the server-rendered rail rather than replacing it, so every chip stays a
            real URL <Link> and the deep-link/back-button/quick-start architecture is unchanged.

            `facets` + `plan` are the desktop rail's two additions: live counts on every chip,
            and a 5-6 group front set with the rest folded into a native <details>. A
            persistent rail showing all nine groups would be the same crowding problem
            rotated ninety degrees — worse, because it never scrolls away. Both props are
            optional and the sheet's own behaviour is unchanged by them. */}
        <MobileFilterSheet
          whenLabel={whenChipLabel(state)}
          whereLabel={whereChipLabel(state, savedLocation)}
          activeCount={activeFilterCount(state)}
          otherChips={otherFilterChips(state)}
          clearHref={hrefFor(state, CLEARED_FILTERS)}
          resultCount={total}
        >
          <FilterRail state={state} savedLocation={savedLocation} plan={railPlan} />
        </MobileFilterSheet>

        <div className="kf-srch__main">
          {/* Anon memory (T26): on an active search this quietly refreshes the on-device "last
              search"; on a bare landing it offers an explicit, dismissible resume of it. Rendered
              unconditionally so the memory write still happens while searching; it renders no UI
              unless a bare-landing resume is being offered. Coordinates are never persisted. */}
          <ResumeSearch
            currentParams={saveParams}
            currentLabel={suggestedName}
            hasActiveState={state.q.trim().length > 0 || filtersActive}
          />

          {/* The query, in words — and the page's <h1>. Rendered OUTSIDE the results branch
              on purpose: an empty or failed search still needs a heading and still needs to
              state what was asked for, which is exactly when a parent most needs to see that
              they have four filters applied rather than concluding "there is nothing on". */}
          <QuerySummary
            state={state}
            tokens={appliedTokens}
            confirmed={confirmed.length}
            expected={expected.length}
            ageUnconfirmed={ageUnconfirmed.length}
            sortLabel={sortLabel}
            clearHref={hrefFor(state, CLEARED_FILTERS)}
            countsKnown={result.ok}
          />


          {/* The capture panel that FEEDS the island below — "Make this yours" — is mounted at
              the FOOT of this column, not here. It cannot sit above the results: see the note at
              its render site for the measurement that decided it. */}
          {/* The on-device child profile's age default (design §5c option 2a). A client island:
              it reads localStorage after mount and, ONLY when the URL says nothing about age,
              replaces it with the same `age=` URL a chip tap would produce — so every consumer
              below (facets, ladder, analytics, the applied-filter token above) is fed by the path
              it already had. Mounted directly under QuerySummary because the note it renders
              explains the "Ages …" token in that summary, and a provenance line that appears
              before the thing it explains is a riddle. Renders nothing when no profile applies. */}
          <ProfileAgeDefault state={state} />

          {/* "We hold almost nothing for this area" is a different fact from every other notice
              on this page, and it outranks them: the day-remainder note explains the shape of ONE
              DAY, the broadening note explains what happened to ONE QUERY, and both are answers
              about a search that could have gone differently. This one says the area itself is
              the limit, so it renders FIRST — a parent who reads "widen your dates" before they
              read this one has already been sent somewhere that cannot help. Rendered outside the
              results branch, like the notices below it, because a thin area presented as a
              complete result set is the same defect as an unexplained empty one. `role="status"`
              matches them too. */}
          <SparseCoverageNotice coverage={result.body?.regionCoverage} />

          {/* "Today has finished" is a different fact from "there is nothing on today", and the
              page used to render them identically — a near-empty list, no explanation, at 10pm.
              First among the QUERY-level notices because it explains the SHAPE of everything
              below it: the catalogue drops activities as they end, so a late Today is a list of
              what is left, not a list of what was on. (The coverage notice above it is not a
              query-level notice at all — see its own comment for why it precedes this.) The offer
              of tomorrow is explicit, and stays an offer — the broadening ladder's silent slide
              into adjacent days is the behaviour this replaces. `role="status"` matches the
              notices below it. */}
          {dayRemainder && (
            <p className="kf-dayremainder" role="status">
              <b className="kf-dayremainder__lede">{dayRemainder.lede}</b> {dayRemainder.body}
              {dayRemainder.offerTomorrow && (
                <>
                  {' '}
                  <Link className="kf-dayremainder__next" href={tomorrowHref}>
                    See what’s on tomorrow
                  </Link>
                  .
                </>
              )}
            </p>
          )}

          {/* Rendered OUTSIDE the results branch, like QuerySummary and for the same reason:
              a search that was widened and STILL came back empty is exactly when a parent most
              needs to know their constraints moved. `role="status"` so the substitution is
              announced after the navigation rather than found by accident. The filters
              themselves are NOT rewritten — the URL still holds what the parent asked for, so
              the QuerySummary tokens above stay true and this line explains the difference. */}
          {broadening && (
            <p className="kf-broadened" role="status">
              <b className="kf-broadened__lede">Not enough exact matches.</b> We widened your search to include{' '}
              {joinPhrases(broadening.changes)}. Your filters are unchanged — clear or adjust them above to search again.
            </p>
          )}

          {/* WHICH constraint is narrowing the search — also outside the results branch, and
              for a sharper version of the same reason. This used to render ONLY inside the
              `total === 0` arm, but `total` counts the expected/seasonal section too, so a
              query whose CONFIRMED results were emptied by a filter went entirely unexplained
              the moment the expected section had anything in it: /search?free=1&region=nvan
              returned a full explanation in the API payload and rendered a page of expected
              cards with no reason given. The engine already gates this — `emptyState` is
              non-null only when the primary run came back empty or thin — so rendering it
              whenever it exists is the correct condition, and the message states the real
              count ("No exact matches" / "Only 2 exact matches") rather than assuming zero. */}
          {emptyExplain && (
            <p className="kf-browse__empty-explain" role="status">
              {emptyExplain}
            </p>
          )}

          {/* Pre-counted alternative chips: the SPECIFIC widenings the ladder considered,
              each a real /search link carrying its own proven result count, so a parent can
              pick one directly rather than only reading the sentence above. Rendered beside
              (not instead of) the broadening/empty-state prose — this is the actionable
              layer on top of the explanation, not a replacement for it. */}
          {alternativeChips.length > 0 && (
            <ul className="kf-broaden-chips" aria-label="Other searches to try">
              {alternativeChips.map((chip) => (
                <li key={chip.key}>
                  <Link className="kf-broaden-chips__chip" href={chip.href}>
                    {chip.text}
                  </Link>
                </li>
              ))}
            </ul>
          )}

          <div className="kf-results">
        {!result.ok ? (
          <div className="kf-empty" role="alert">
            <div className="kf-empty__glyph" aria-hidden="true">
              ⚠
            </div>
            <h2 className="kf-empty__title">We couldn&apos;t load results just now.</h2>
            <p className="kf-empty__body">{result.error}</p>
            <p className="kf-empty__body" style={{ margin: '6px 0 0' }}>
              Try again in a moment — nothing is saved to fake a result.
            </p>
          </div>
        ) : total === 0 ? (
          <div className="kf-empty">
            <div className="kf-empty__glyph" aria-hidden="true">
              ◍
            </div>
            <p className="kf-browse__empty-eyebrow">{queryUnparsed ? 'We couldn’t search for that' : 'No matches yet'}</p>
            <h2 className="kf-empty__title">
              {queryUnparsed ? (
                // NOT "nothing matches" — we never got as far as matching. See `queryUnparsed`.
                <>We couldn’t understand “{state.q}”.</>
              ) : state.q ? (
                <>Nothing matches “{state.q}” right now.</>
              ) : (
                <>Nothing to show right now.</>
              )}
            </h2>
            {/* "Schedules post 2–4 weeks ahead" names a CAUSE, and it is the wrong cause for a
                day that has simply run out — an empty Today at 10pm is not an unpublished
                schedule. When the day-remainder notice above has already given the real reason,
                this paragraph would contradict it, so it stands down rather than competing. The
                "try a broader word" advice goes with it: broadening cannot lengthen a day.
                It stands down for an UNREADABLE query too, for the same reason and a stronger
                one: unpublished schedules are not why that page is empty, and "try a broader
                word" is the wrong instruction when the problem is that no word was read at
                all. The advice that fits is already in the explanation line above. */}
            {!dayRemainder && !queryUnparsed && (
              <p className="kf-empty__body">
                Schedules around Metro Vancouver usually post 2–4 weeks ahead. Try a broader word (like “swim” or
                “gym”), or clear your search to browse everything on.
              </p>
            )}
            {/* The constraint explanation is NOT repeated here — it now renders above the
                results branch, so it survives a page that the expected section filled. */}
            {clearableFilters && (
              <p className="kf-empty__body" style={{ margin: '10px 0 0' }}>
                <Link className="kf-browse__clear" href={hrefFor(state, CLEARED_FILTERS)}>
                  Clear all filters
                </Link>{' '}
                to widen your search.
              </p>
            )}
          </div>
        ) : (
          <>
            {/* The count / query / sort / applied-filter lines that used to live here are now
                one QuerySummary line above the results (see the component's own note). Only
                the provenance line stays: it is about the DATA, not the query. */}
            {result.body && <p className="kf-section__note">Source: {sourceNote(result.body)}</p>}

            {/* Why these cards say "Distance unavailable", and what to do about it — stated ONCE,
                here, rather than sixty times down the list. The cards state the fact; this states
                the reason, because the reason is a property of the REQUEST (no origin was
                resolved), not of any individual listing. See _lib/distance-note.ts for why those
                are provably the same thing on this surface. `role="status"` matches the counts
                line: a parent using a screen reader hears it after a filter navigation. */}
            {distanceExplanation && (
              <p className="kf-section__note" role="status">
                {distanceExplanation}
              </p>
            )}

            <SearchResultsView markers={markers} token={mapToken} totalResults={total}>
              {rangeActive ? (
                <DayGroupedResults groups={confirmedGroups} total={confirmed.length} />
              ) : (
                <Section title="Confirmed from approved sources" items={confirmed} />
              )}
              {/* Between confirmed and expected, which is where it belongs in both directions:
                  these ARE primary results (so they sit above the not-yet-posted section), but
                  they have not earned the confirmed heading under an active age filter. */}
              <AgeUnconfirmedSection items={ageUnconfirmed} bandLabel={ageBandLabel} />
              <Section
                title="Expected / not yet posted"
                note="Kept separate from confirmed — we never blur the two. Each card carries its own status and recheck date."
                items={expected}
              />
            </SearchResultsView>
          </>
        )}
          </div>

          {/* ═══ "MAKE THIS YOURS" — RELOCATED HERE FROM THE HOME PAGE (TSD v1.2 T2.5 / F-2) ═══
              The ask-once child-profile panel. It rendered on app/page.tsx and NOWHERE ELSE, and
              the SMS front-door rebuild removes it from there (Delta 4, AC-06).

              THIS IS NOT A CONVENIENCE MOVE — WITHOUT IT, DELTA 4 SILENTLY BREAKS /search.
              `ChildProfilePrompt` is the product's ONLY profile-CAPTURE surface. `ChildProfileBar`
              (app/layout.tsx) only DISPLAYS an existing profile, and `ProfileAgeDefault` above
              only CONSUMES one. Delete the capture and the chain collapses: no new visitor can
              ever create a profile, the bar renders nothing for all of them, ProfileAgeDefault
              never fires, and /search quietly loses age personalisation for every new visitor —
              a change to "the search product's own behavior", which the Modification Spec §4
              explicitly places OUT OF SCOPE. Approved by the Operator as decision D-2, option (a).

              ═══ 🔴 WHY IT IS BELOW THE RESULTS AND NOT ABOVE THEM — MEASURED ═══
              The obvious mount is directly above `<ProfileAgeDefault />`, next to the thing that
              consumes it. That placement was built, measured and rejected: the panel is 317px
              tall and it moved the first result card from 557px to 874px on a 390x664 phone —
              316px BELOW the fold, against a chrome budget of 560px with 3px of headroom.
              tests/e2e/public/search-above-the-fold.public.spec.ts turned red on all six phone
              descriptors, and it is right to: "the first result is on the first screen" is a
              shipped guarantee of the search product with its own spec, and a capture panel for
              a DIFFERENT product may not spend it. No compact variant closes a 317px gap against
              3px of room, so the choice was placement, not sizing.

              Below the results is therefore where it can exist without taking anything: a parent
              who has scrolled the generic list is also the parent for whom "activities that fit
              your kids" is worth answering.

              ⚠ FLAGGED FOR A PRODUCT RULING, NOT SETTLED HERE. This trades DISCOVERABILITY for
              the above-fold guarantee, and the TSD anticipated neither the conflict nor the
              trade. If capture rate matters more than the fold on /search, the alternatives are
              (a) a slim one-line bar variant above the results, which is a design change and has
              not been through a gate, or (b) accepting the fold regression deliberately, which
              needs the search spec's thresholds re-agreed. Both are somebody's decision, not
              this scope's.

              The component itself is unchanged — it still renders nothing once a profile exists,
              once dismissed for the session, or when storage is unavailable. */}
          <ChildProfilePrompt />
        </div>
      </div>
    </>
  );
}
