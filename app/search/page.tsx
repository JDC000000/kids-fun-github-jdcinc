import Link from 'next/link';
import { headers } from 'next/headers';
import { ActivityCard } from '../preview/_components/ActivityCard';
import { partitionSections } from '../preview/_data/filter';
import { mapSearchResponseToActivities, type SearchResponseDto } from '../preview/_data/search-api';
import type { Activity } from '../preview/_data/types';
import { recordSearchPerformed } from '@/lib/analytics/record';
import { getRequestUser, type RequestUser } from '@/lib/db/session-user';
import { getUserProfile } from '@/lib/db/user-profile';
import { listSavedSearches } from '@/lib/db/saved-search';
import { areaLabelForPostal } from '@/lib/geo/postal-fsa';
import { SearchBar } from './_components/SearchBar';
import { FilterRail, type SavedLocationInfo } from './_components/FilterRail';
import { MobileFilterSheet } from './_components/MobileFilterSheet';
import { activeFilterCount, otherFilterChips, whenChipLabel, whereChipLabel } from './_lib/filter-summary';
import { SearchResultsView } from './_components/SearchResultsView';
import { SaveSearchButton } from './_components/SaveSearchButton';
import { ResumeSearch } from './_components/ResumeSearch';
import { buildMarkers, geoIndex } from './_lib/markers';
import { groupActivitiesByDay, formatRangeLabel, type DayGroup } from './_lib/day-groups';
import { localIsoDate } from '@/lib/search/time/vancouver';
import {
  AGE_OPTIONS,
  CLEARED_FILTERS,
  COST_MAX_OPTIONS,
  REGION_CHIPS,
  SORT_OPTIONS,
  TIME_OF_DAY_OPTIONS,
  WHEN_OPTIONS,
  analyticsFilterTokens,
  apiQuery,
  hasActiveFilters,
  hasDateRange,
  hasNearMeCoords,
  hrefFor,
  parseSearchState,
  savedSearchKey,
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
    applied: Array<{ rung: number; key: string; label: string }>;
    emptyState: { blockingConstraint: string | null; message: string } | null;
  };
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
    const res = await fetch(`${baseUrl()}/api/search?${apiQuery(state, savedOrigin)}`, {
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
    return 'Live staging database — approved public sources only.';
  }
  if (body.meta.fallbackReason) {
    return `Fixture fallback — ${body.meta.fallbackReason}.`;
  }
  return 'Fixture-backed search preview.';
}

/** Human-readable list of the active filters, for the "in words" results summary (Screen 2). */
function filterSummary(state: SearchState, savedLocation: SavedLocationInfo | null): string[] {
  const parts: string[] = [];
  if (state.when !== 'any') parts.push(WHEN_OPTIONS.find((w) => w.key === state.when)?.label ?? '');
  if (hasDateRange(state) && state.dateFrom && state.dateTo) {
    parts.push(formatRangeLabel(state.dateFrom, state.dateTo));
  }
  if (state.timeOfDay !== 'any') parts.push(TIME_OF_DAY_OPTIONS.find((t) => t.key === state.timeOfDay)?.label ?? '');
  if (state.ages.length) {
    const labels = state.ages.map((band) => AGE_OPTIONS.find((a) => a.key === band)?.label ?? band);
    parts.push(`Ages ${labels.join(' & ')}`);
  }
  if (state.regions.length) {
    parts.push(state.regions.map((id) => REGION_CHIPS.find((r) => r.id === id)?.label ?? id).join(' + '));
  }
  if (state.bookableNow) parts.push('Bookable now');
  if (state.dropIn) parts.push('Drop-in');
  if (state.rainyDay) parts.push('Rainy-day');
  if (state.free) parts.push('Free');
  if (state.costMaxCad != null) {
    parts.push(COST_MAX_OPTIONS.find((c) => c.maxCad === state.costMaxCad)?.label ?? `Under $${state.costMaxCad}`);
  }
  if (hasNearMeCoords(state)) parts.push(`within ${state.radiusKm} km of you`);
  else if (state.useSavedLocation && savedLocation) {
    parts.push(`within ${state.radiusKm} km of ${savedLocation.areaLabel}`);
  }
  return parts.filter(Boolean);
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

/**
 * Canonical keys of the signed-in parent's existing saved searches, so the
 * "Save this search" button can show "already saved" and never write a duplicate
 * (the API has no server dedupe). Best-effort: anonymous users and any DB hiccup
 * degrade to an empty set — the button simply offers to save. Never blocks or
 * breaks the render. Reads only the owner's own rows (RLS-scoped, Task 38).
 */
async function loadSavedSearchKeys(user: RequestUser | null): Promise<Set<string>> {
  if (!user) return new Set();
  try {
    const rows = await listSavedSearches(user.userId);
    return new Set(rows.map((r) => savedSearchKey(r.params)));
  } catch {
    return new Set();
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
 *  listings — built from the RAW API items so day grouping matches the real occurrence dates. */
function buildDayIndex(body: SearchApiResponse | undefined): Map<string, string | null> {
  const map = new Map<string, string | null>();
  if (!body) return map;
  for (const item of [...body.results, ...body.expected]) {
    const start = item.listing.startDatetimeUtc;
    map.set(item.listing.id, start ? localIsoDate(new Date(start)) : null);
  }
  return map;
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
  // The search and the saved-search-keys load are independent — run them together.
  const [result, savedKeys] = await Promise.all([
    runSearch(state, savedOrigin),
    loadSavedSearchKeys(user),
  ]);
  // A radius only truly applies when there's a real origin: browser coords, or a saved
  // location we actually resolved (a bare ?home=1 with no signed-in profile behind it doesn't).
  const realOrigin = hasNearMeCoords(state) || (state.useSavedLocation && savedOrigin != null);

  const activities = result.body ? mapSearchResponseToActivities(result.body) : [];
  const { confirmed, expected } = partitionSections(activities);
  const total = confirmed.length + expected.length;

  // Map view (Task 37): coordinates come off the raw /api/search items (the parent-facing
  // Activity DTO drops geo) and are re-attached by id, so the marker set is exactly the
  // rendered result set. A PUBLIC Mapbox token (pk.*) is safe in the browser by design —
  // prefer the dedicated NEXT_PUBLIC_MAP_KEY, and fall back to the verified-public geocoding
  // key so the map works wherever Task 36's key is already configured. A secret (sk.*) token
  // must never be placed in either of these vars.
  const geo = geoIndex(result.body ? [...result.body.results, ...result.body.expected] : []);
  const markers = buildMarkers(confirmed, expected, geo);
  const mapToken = (process.env.NEXT_PUBLIC_MAP_KEY ?? process.env.GEOCODING_API_KEY ?? '').trim();
  const sortSentence = SORT_OPTIONS.find((o) => o.key === state.sort)?.sentence ?? '';
  const emptyExplain = result.body?.broadening?.emptyState?.message ?? null;
  const activeFilters = filterSummary(state, savedLocation);
  const filtersActive = hasActiveFilters(state);
  // Custom date range (T26 / FR-04): when a range is active the confirmed results are grouped
  // by day (one dated subsection per day, open-hours attractions last). The day-by-id lookup is
  // built from the raw API items so grouping reflects each occurrence's true local date.
  const rangeActive = hasDateRange(state);
  const confirmedGroups = rangeActive ? groupActivitiesByDay(confirmed, buildDayIndex(result.body)) : [];

  // "Save this search" (Round 10 / Task B): the current filter state is serialized
  // to the same generic `params` envelope Task 38's backend already accepts; a
  // bare browse serializes to nothing and is not savable.
  const saveParams = serializeStateToParams(state);
  // Gate on actual SAVABILITY, not the analytics "is this a search?" test. A
  // near-me-only search (browser coords, no query/filters) IS a search, but its
  // coordinates are deliberately NOT persisted (privacy), so it serializes to an
  // empty params map the API would reject (400). Offer the control iff a save
  // would actually succeed — button visible ⟺ POST succeeds. (QA F1.)
  const showSave = Object.keys(saveParams).length > 0;
  // `savedKey` both dedupes against existing rows and keys the client component so
  // it remounts fresh per search.
  const savedKey = savedSearchKey(saveParams);
  const suggestedName = state.q.trim() || activeFilters.join(' · ');
  const signInHref = `/auth/signin?next=${encodeURIComponent(hrefFor(state))}`;

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
        includeUnknownCost: state.includeUnknownCost,
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
      <header className="kf-hero">
        <p className="kf-hero__wordmark">KIDS FUN</p>
        <h1 className="kf-hero__title">See what&apos;s on for your kids.</h1>
        <p className="kf-hero__sub">
          Search by activity, and check the source and last-checked date on every result before you go.
        </p>
      </header>

      <SearchBar state={state} />

      {/* Filters (Blueprint §04 / Screen 5). ONE rail, relocated by viewport: the inline
          column it has always been at >=768px, and a sticky summary bar + bottom sheet at
          <=767px, where the permanently-expanded stack put ~1.7 viewport-heights of chrome
          above the first result. MobileFilterSheet is a client island that WRAPS the
          server-rendered rail rather than replacing it, so every chip stays a real URL
          <Link> and the deep-link/back-button/quick-start architecture is unchanged. */}
      <MobileFilterSheet
        whenLabel={whenChipLabel(state)}
        whereLabel={whereChipLabel(state, savedLocation)}
        activeCount={activeFilterCount(state)}
        otherChips={otherFilterChips(state)}
        clearHref={hrefFor(state, CLEARED_FILTERS)}
        resultCount={total}
      >
        <FilterRail state={state} savedLocation={savedLocation} />
      </MobileFilterSheet>

      {/* Anon memory (T26): on an active search this quietly refreshes the on-device "last
          search"; on a bare landing it offers an explicit, dismissible resume of it. Rendered
          unconditionally so the memory write still happens while searching; it renders no UI
          unless a bare-landing resume is being offered. Coordinates are never persisted. */}
      <ResumeSearch
        currentParams={saveParams}
        currentLabel={suggestedName}
        hasActiveState={state.q.trim().length > 0 || filtersActive}
      />

      {showSave && (
        <SaveSearchButton
          key={savedKey}
          params={saveParams}
          defaultName={suggestedName}
          isSignedIn={user != null}
          signInHref={signInHref}
          accountHref="/account"
          initialSaved={savedKeys.has(savedKey)}
        />
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
            <p className="kf-browse__empty-eyebrow">No matches yet</p>
            <h2 className="kf-empty__title">
              {state.q ? <>Nothing matches “{state.q}” right now.</> : <>Nothing to show right now.</>}
            </h2>
            <p className="kf-empty__body">
              Schedules around Metro Vancouver usually post 2–4 weeks ahead. Try a broader word (like “swim” or
              “gym”), or clear your search to browse everything on.
            </p>
            {emptyExplain && <p className="kf-browse__empty-explain">{emptyExplain}</p>}
            {filtersActive && (
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
            <div className="kf-browse__summary">
              <p className="kf-browse__count">
                {confirmed.length} confirmed
                {expected.length > 0 ? ` · ${expected.length} expected` : ''}
              </p>
              <p className="kf-browse__query">
                {state.q ? (
                  <>
                    for <b>“{state.q}”</b> across Metro Vancouver
                  </>
                ) : (
                  <>on now across Metro Vancouver</>
                )}
              </p>
              <p className="kf-browse__sortline">Sorted by {sortSentence}.</p>
              {activeFilters.length > 0 && (
                <p className="kf-browse__filterline">
                  Filtered by {activeFilters.join(' · ')}.{' '}
                  <Link className="kf-browse__clear" href={hrefFor(state, CLEARED_FILTERS)}>
                    Clear filters
                  </Link>
                </p>
              )}
            </div>

            {result.body && <p className="kf-section__note">Source: {sourceNote(result.body)}</p>}

            <SearchResultsView markers={markers} token={mapToken} totalResults={total}>
              {rangeActive ? (
                <DayGroupedResults groups={confirmedGroups} total={confirmed.length} />
              ) : (
                <Section title="Confirmed from approved sources" items={confirmed} />
              )}
              <Section
                title="Expected / not yet posted"
                note="Kept separate from confirmed — we never blur the two. Each card carries its own status and recheck date."
                items={expected}
              />
            </SearchResultsView>
          </>
        )}
      </div>
    </>
  );
}
